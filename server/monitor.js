// The safety loop. Each senior is in one phase:
//   watching -> (idle past threshold) -> calling -> answered: classify -> watching (+ incident if concern/emergency)
//                    | quiet hours: quiet          -> no answer: retry -> calling (attempt 2) -> no answer: emergency incident
// Incidents alert linked family on Telegram; unacknowledged emergencies are re-sent until someone taps "I'm on it".
const { tx } = require('./db');
const { esc } = require('./providers/telegram');
const { inQuietHours, fmtTime, fmtDateTime, fmtDuration } = require('./time');

const MIN = 60000;
const DEVICE_SILENT_MS = 2 * 60 * MIN; // the app syncs every 15 min, so 2h of silence means something is wrong
const ACTIVE_VAPI_STATUSES = ['scheduled', 'queued', 'ringing', 'in-progress', 'forwarding'];

function createMonitor({ db, config, now, vapi, telegram, classify }) {
  const T = config.timing;
  let running = false;
  let lastTickAt = 0;
  let lastPurgeAt = 0;

  const q = (sql) => db.prepare(sql);
  const getSenior = (id) => q('SELECT * FROM seniors WHERE id = ?').get(id);
  const setPhase = (id, phase, extra = {}) => {
    const cols = Object.keys(extra);
    q(`UPDATE seniors SET phase = ?${cols.map((c) => `, ${c} = ?`).join('')} WHERE id = ?`)
      .run(phase, ...cols.map((c) => extra[c]), id);
  };

  function logEvent(seniorId, kind, text) {
    q('INSERT INTO events (senior_id, at, kind, text) VALUES (?, ?, ?, ?)').run(seniorId, now(), kind, text);
  }

  const familyOf = (seniorId) => q(
    `SELECT u.id, u.name, u.telegram_chat_id, l.relationship FROM family_links l JOIN users u ON u.id = l.user_id
     WHERE l.senior_id = ? ORDER BY u.id`,
  ).all(seniorId);

  const openIncidentOf = (seniorId) =>
    q('SELECT * FROM incidents WHERE senior_id = ? AND resolved_at IS NULL ORDER BY id DESC LIMIT 1').get(seniorId);

  function latestDevice(seniorId) {
    return q('SELECT * FROM devices WHERE senior_id = ? AND revoked_at IS NULL ORDER BY last_seen DESC LIMIT 1').get(seniorId);
  }

  // One line about the phone itself, so families can tell "not answering" from "phone is dead".
  function deviceNote(s, t = now()) {
    const d = latestDevice(s.id);
    if (!d) return 'No phone is paired with Haru yet.';
    if (!d.last_seen) return 'The paired phone has never reported in.';
    const battery = d.battery == null ? '' : ` (battery ${d.battery}%)`;
    if (t - d.last_seen > DEVICE_SILENT_MS) {
      return `Haru hasn't heard from the phone since ${fmtDateTime(d.last_seen, s.timezone)}${battery}. It may be off or out of battery.`;
    }
    if (d.usage_access === 0) return 'Haru cannot see phone activity: Usage Access is turned off on the phone.';
    return `The phone is online${battery}.`;
  }

  const lastActiveLine = (s) => (s.last_active
    ? `Last phone activity: ${fmtDateTime(s.last_active, s.timezone)}`
    : 'No phone activity recorded yet.');

  function contactLines(s) {
    const lines = [`Call ${esc(s.name)}: ${esc(s.phone)}`];
    if (s.address) lines.push(`Home: <a href="https://maps.google.com/?q=${encodeURIComponent(s.address)}">${esc(s.address)}</a>`);
    return lines;
  }

  const htmlToText = (h) => h.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

  function incidentButtons(incident) {
    const b = [{ text: "✅ I'm on it", callback_data: `ack:${incident.id}` }];
    if (config.secureCookies) b.push({ text: 'Open dashboard', url: `${config.publicUrl}/app.html?senior=${incident.senior_id}` });
    return b;
  }

  // Send to every linked family member with Telegram; emergencies also go to admins as a backstop.
  async function sendAlert(s, incident, html) {
    const recipients = familyOf(s.id).filter((u) => u.telegram_chat_id);
    if (incident.level === 'emergency') {
      q("SELECT telegram_chat_id FROM users WHERE role = 'admin' AND telegram_chat_id IS NOT NULL").all()
        .forEach((a) => recipients.push(a));
    }
    const chats = [...new Set(recipients.map((u) => u.telegram_chat_id))];
    let delivered = 0;
    if (telegram.configured) {
      for (const chat of chats) if (await telegram.send(chat, html, incidentButtons(incident))) delivered++;
    }
    q('UPDATE incidents SET delivered_count = ? WHERE id = ?').run(delivered, incident.id);
    if (!telegram.configured) logEvent(s.id, 'bad', 'Alert NOT sent: Telegram is not configured on the server.');
    else if (!chats.length) logEvent(s.id, 'bad', 'Alert NOT sent: no family member has connected Telegram yet.');
    else if (!delivered) logEvent(s.id, 'bad', 'Alert NOT delivered: Telegram rejected every message.');
    else logEvent(s.id, 'ok', `Alert delivered on Telegram to ${delivered} ${delivered === 1 ? 'person' : 'people'}.`);
    return delivered;
  }

  async function openIncident(s, level, summary, html) {
    const t = now();
    const incident = tx(db, () => {
      const prev = openIncidentOf(s.id);
      if (prev) q('UPDATE incidents SET resolved_at = ? WHERE id = ?').run(t, prev.id); // superseded by newer news
      const { lastInsertRowid } = q(
        `INSERT INTO incidents (senior_id, level, summary, alert_text, opened_at, last_alert_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(s.id, level, summary, htmlToText(html), t, t);
      return q('SELECT * FROM incidents WHERE id = ?').get(lastInsertRowid);
    });
    await sendAlert(s, incident, html);
    return incident;
  }

  function alertHtml(s, kind, { summary, where, calls }) {
    const t = now();
    const head = {
      emergency: `🚨 <b>URGENT: ${esc(s.name)} may need help</b>`,
      no_answer: `🚨 <b>URGENT: ${esc(s.name)} is not answering</b>`,
      concern: `⚠️ <b>Check on ${esc(s.name)}</b>`,
    }[kind];
    const body = kind === 'no_answer'
      ? `No phone activity for ${fmtDuration(t - Math.max(s.last_active || 0, s.watch_from))} and no answer to ${calls} check-in calls.`
      : `${esc(summary)}${where ? ` (${esc(where)})` : ''}`;
    const lines = [head, body, '', esc(lastActiveLine(s)), esc(deviceNote(s, t)), ...contactLines(s)];
    if (kind !== 'concern') lines.push(`If you can't reach ${esc(s.name)}, call 911.`);
    return lines.join('\n');
  }

  // ---------- calls ----------
  async function placeCall(s, { attempt, reason, requestedBy = null }) {
    const t = now();
    const callId = tx(db, () => {
      setPhase(s.id, 'calling', { retry_at: null });
      return q('INSERT INTO calls (senior_id, attempt, reason, requested_by, started_at) VALUES (?, ?, ?, ?, ?)')
        .run(s.id, attempt, reason, requestedBy && requestedBy.id, t).lastInsertRowid;
    });
    if (reason === 'manual') logEvent(s.id, 'ok', `${requestedBy.name} asked Haru to call ${s.name}.`);
    else {
      const idle = fmtDuration(t - Math.max(s.last_active || 0, s.watch_from));
      logEvent(s.id, 'warn', attempt === 1
        ? `No phone activity for ${idle}. Haru is calling ${s.name} to check in.`
        : `Haru is calling ${s.name} again (attempt ${attempt}).`);
    }
    const family = familyOf(s.id);
    try {
      if (!vapi.configured) throw new Error('phone calls are not configured on the server');
      const { id } = await vapi.startCall({
        phone: s.phone,
        variables: { name: s.name, family: family.length ? family[0].name : 'your family' },
      });
      q('UPDATE calls SET vapi_call_id = ? WHERE id = ?').run(id, callId);
    } catch (e) {
      console.error(`Call to senior ${s.id} failed to start:`, e.message);
      await finishCall(callId, { failed: true, endedReason: `start-failed: ${e.message}`.slice(0, 300) });
    }
    return callId;
  }

  // Called once per call, from the Vapi webhook, the timeout poll, a failed start, or the demo simulator.
  async function finishCall(callId, { endedReason = null, transcript = '', userText = '', failed = false }) {
    const t = now();
    const claimed = q('UPDATE calls SET ended_at = ?, ended_reason = ?, transcript = ? WHERE id = ? AND ended_at IS NULL')
      .run(t, endedReason, transcript || null, callId).changes;
    if (!claimed) return null; // already handled
    const call = q('SELECT * FROM calls WHERE id = ?').get(callId);
    const result = failed
      ? { status: 'no_answer', reason: 'The call could not be completed.' }
      : await classify({ transcript, userText });
    const summary = result.summary_for_family || result.reason;
    q('UPDATE calls SET outcome = ?, summary = ? WHERE id = ?').run(result.status, summary, callId);
    const s = getSenior(call.senior_id);
    if (!s) return result;

    if (result.status === 'no_answer') {
      const why = failed ? ' (the call could not be completed)' : '';
      if (call.reason === 'manual') {
        setPhase(s.id, 'watching');
        logEvent(s.id, 'warn', `${s.name} didn't answer the requested call${why}.`);
      } else if (call.attempt < 2) {
        const retryAt = t + T.retryAfterMin * MIN;
        setPhase(s.id, 'retry', { retry_at: retryAt });
        logEvent(s.id, 'warn', `${s.name} didn't answer${why}. Haru will try again at ${fmtTime(retryAt, s.timezone)}.`);
      } else {
        setPhase(s.id, 'watching', { watch_from: t });
        logEvent(s.id, 'bad', `${s.name} didn't answer ${call.attempt} check-in calls${why}. Alerting family.`);
        await openIncident(s, 'emergency', `${s.name} is not answering check-in calls.`,
          alertHtml(s, 'no_answer', { calls: call.attempt }));
      }
      return result;
    }

    setPhase(s.id, 'watching', { watch_from: t, last_checkin: t });
    const where = result.location_in_home || null;
    if (result.status === 'ok') {
      logEvent(s.id, 'ok', `Check-in call: ${summary}`);
    } else if (result.status === 'concern') {
      logEvent(s.id, 'warn', `Check-in call: ${summary} Alerting family.`);
      await openIncident(s, 'concern', summary, alertHtml(s, 'concern', { summary }));
    } else {
      logEvent(s.id, 'bad', `Check-in call: ${summary}${where ? ` (${where})` : ''} Alerting family.`);
      await openIncident(s, 'emergency', summary, alertHtml(s, 'emergency', { summary, where }));
    }
    return result;
  }

  async function onVapiReport(vapiCallId, info) {
    const call = q('SELECT id FROM calls WHERE vapi_call_id = ?').get(vapiCallId);
    if (!call) return null;
    return finishCall(call.id, info);
  }

  async function callNow(seniorId, user) {
    const s = getSenior(seniorId);
    if (s.phase === 'calling' || s.phase === 'retry') return { error: 'Haru is already trying to reach them.' };
    await placeCall(s, { attempt: 1, reason: 'manual', requestedBy: user });
    return { ok: true };
  }

  // ---------- activity ----------
  function recordActivity(seniorId, at, { manual = false } = {}) {
    const s = getSenior(seniorId);
    if (!s) return;
    if (at > (s.last_active || 0)) q('UPDATE seniors SET last_active = ? WHERE id = ?').run(at, s.id);
    if (s.phase === 'quiet') {
      setPhase(s.id, 'watching');
      logEvent(s.id, 'ok', 'Phone activity again. No call needed.');
    }
    if (manual) {
      if (s.phase === 'retry') {
        setPhase(s.id, 'watching', { retry_at: null, watch_from: now() });
        logEvent(s.id, 'ok', `${s.name} pressed "I'm OK" on the phone. Retry call cancelled.`);
      } else {
        logEvent(s.id, 'ok', `${s.name} pressed "I'm OK" on the phone.`);
      }
    }
  }

  // ---------- incidents ----------
  async function acknowledge(incidentId, user) {
    const inc = q('SELECT * FROM incidents WHERE id = ?').get(incidentId);
    if (!inc || inc.acked_at || inc.resolved_at) return false;
    q('UPDATE incidents SET acked_by = ?, acked_at = ? WHERE id = ?').run(user.id, now(), incidentId);
    logEvent(inc.senior_id, 'ok', `${user.name} is handling the alert.`);
    if (telegram.configured) {
      for (const u of familyOf(inc.senior_id)) {
        if (u.telegram_chat_id && u.id !== user.id) await telegram.send(u.telegram_chat_id, `✅ ${esc(user.name)} is handling it.`);
      }
    }
    return true;
  }

  function resolve(incidentId, user) {
    const inc = q('SELECT * FROM incidents WHERE id = ?').get(incidentId);
    if (!inc || inc.resolved_at) return false;
    q('UPDATE incidents SET resolved_by = ?, resolved_at = ?, acked_by = COALESCE(acked_by, ?), acked_at = COALESCE(acked_at, ?) WHERE id = ?')
      .run(user.id, now(), user.id, now(), incidentId);
    logEvent(inc.senior_id, 'ok', `${user.name} marked the alert resolved.`);
    return true;
  }

  async function escalate(s, t) {
    const inc = openIncidentOf(s.id);
    if (!inc || inc.level !== 'emergency' || inc.acked_at) return;
    if (t - inc.last_alert_at < T.escalateAfterMin * MIN || inc.alert_count >= T.maxAlerts) return;
    const n = inc.alert_count + 1;
    q('UPDATE incidents SET last_alert_at = ?, alert_count = ? WHERE id = ?').run(t, n, inc.id);
    logEvent(s.id, 'bad', `Nobody has acknowledged the alert yet. Reminder sent (${n} of ${T.maxAlerts}).`);
    await sendAlert(s, inc, `🔁 <b>Reminder ${n} of ${T.maxAlerts}: nobody has said they are handling this yet.</b>\n\n${esc(inc.alert_text)}`);
  }

  // ---------- the loop ----------
  function noteDeviceSilence(s, t) {
    const d = latestDevice(s.id);
    if (!d || !d.last_seen || t - d.last_seen < DEVICE_SILENT_MS) return;
    if (d.silence_noted_at && d.silence_noted_at >= d.last_seen) return;
    q('UPDATE devices SET silence_noted_at = ? WHERE id = ?').run(t, d.id);
    logEvent(s.id, 'warn', deviceNote(s, t));
  }

  async function tickSenior(s) {
    const t = now();
    await escalate(s, t);
    noteDeviceSilence(s, t);
    if (s.paused_until) {
      if (s.paused_until > t) return;
      q('UPDATE seniors SET paused_until = NULL, watch_from = ? WHERE id = ?').run(t, s.id);
      logEvent(s.id, 'ok', 'Monitoring resumed.');
      return;
    }
    if (s.phase === 'watching' || s.phase === 'quiet') {
      const idle = t - Math.max(s.last_active || 0, s.watch_from);
      if (idle < s.inactivity_minutes * MIN) return;
      if (inQuietHours(t, s.timezone, s.quiet_start, s.quiet_end)) {
        if (s.phase !== 'quiet') {
          setPhase(s.id, 'quiet');
          logEvent(s.id, 'warn', `No phone activity for ${fmtDuration(idle)}. It's quiet hours, so Haru will call after ${s.quiet_end}.`);
        }
        return;
      }
      await placeCall(s, { attempt: 1, reason: 'inactivity' });
    } else if (s.phase === 'calling') {
      const call = q('SELECT * FROM calls WHERE senior_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1').get(s.id);
      if (!call) return setPhase(s.id, 'watching');
      const age = t - call.started_at;
      if (age < T.callTimeoutMin * MIN) return;
      // The webhook is late or lost: ask Vapi directly before giving up on the call.
      if (call.vapi_call_id && !vapi.simulated) {
        try {
          const info = await vapi.getCall(call.vapi_call_id);
          if (info.status === 'ended') return void (await finishCall(call.id, info));
          if (ACTIVE_VAPI_STATUSES.includes(info.status) && age < 3 * T.callTimeoutMin * MIN) return;
        } catch (e) {
          console.warn(`Polling Vapi call ${call.vapi_call_id} failed:`, e.message);
        }
      }
      await finishCall(call.id, { failed: true, endedReason: 'timeout: no result from the voice provider' });
    } else if (s.phase === 'retry') {
      if (t >= s.retry_at) await placeCall(s, { attempt: 2, reason: 'inactivity' });
    }
  }

  function purge(t) {
    q('UPDATE calls SET transcript = NULL WHERE transcript IS NOT NULL AND ended_at < ?').run(t - 90 * 86400000);
    q('DELETE FROM events WHERE at < ?').run(t - 365 * 86400000);
    q('DELETE FROM sessions WHERE expires_at < ?').run(t);
    q('DELETE FROM pairing_codes WHERE expires_at < ?').run(t);
    q('DELETE FROM invites WHERE expires_at < ? AND used_at IS NULL').run(t - 30 * 86400000);
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      const t = now();
      lastTickAt = t;
      for (const { id } of q('SELECT id FROM seniors').all()) {
        try {
          await tickSenior(getSenior(id));
        } catch (e) {
          console.error(`Monitor failed for senior ${id}:`, e);
        }
      }
      if (t - lastPurgeAt > 60 * MIN) {
        purge(t);
        lastPurgeAt = t;
      }
    } finally {
      running = false;
    }
  }

  let timer = null;
  const start = () => {
    timer = setInterval(tick, T.tickSeconds * 1000);
    tick();
  };
  const stop = () => clearInterval(timer);

  // What the family sees at the top of the dashboard.
  function statusOf(s, t = now()) {
    const inc = openIncidentOf(s.id);
    if (s.paused_until && s.paused_until > t) {
      return { level: 'paused', title: 'Monitoring paused', text: `Paused until ${fmtDateTime(s.paused_until, s.timezone)}.`, incident: inc || null };
    }
    if (inc && inc.level === 'emergency') return { level: 'bad', title: 'Emergency', text: inc.summary, incident: inc };
    if (s.phase === 'calling') return { level: 'warn', title: 'Calling now', text: `Haru is calling ${s.name} to check in.`, incident: inc || null };
    if (s.phase === 'retry') {
      return { level: 'warn', title: 'No answer yet', text: `Haru will call again at ${fmtTime(s.retry_at, s.timezone)}.`, incident: inc || null };
    }
    if (s.phase === 'quiet') {
      return { level: 'warn', title: 'Unusually quiet', text: `No activity for a while. Haru will call after quiet hours end (${s.quiet_end}).`, incident: inc || null };
    }
    if (inc) return { level: 'warn', title: 'Needs attention', text: inc.summary, incident: inc };
    return { level: 'ok', title: 'All good', text: 'Active as usual.', incident: null };
  }

  return {
    tick, start, stop, logEvent, recordActivity, placeCall, finishCall, onVapiReport, callNow,
    acknowledge, resolve, statusOf, deviceNote, familyOf, lastTickAt: () => lastTickAt,
  };
}

module.exports = { createMonitor };
