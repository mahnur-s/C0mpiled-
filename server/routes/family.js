// Caregiver dashboard API: status, feed, calls, "call now", pause, acknowledge/resolve alerts,
// medication schedules, location and home, room sensor status.
const { HttpError } = require('../http');
const { requireUser, requireSenior, requireAdmin } = require('../guards');
const { insights } = require('../insights');
const meds = require('../meds');
const { locationStatus, geocode } = require('../location');
const { EVENT_KINDS } = require('../sensors');

module.exports = (app) => {
  const { router, db, now, monitor } = app;

  const seniorFields = (s) => ({
    id: s.id, name: s.name, phone: s.phone, timezone: s.timezone, address: s.address,
    inactivityMinutes: s.inactivity_minutes, quietStart: s.quiet_start, quietEnd: s.quiet_end,
    lastActive: s.last_active, lastCheckin: s.last_checkin, pausedUntil: s.paused_until, phase: s.phase,
    consentAt: s.consent_at, homeSet: s.home_lat != null, homeRadiusM: s.home_radius_m, medGraceMinutes: s.med_grace_minutes,
    // When Haru will call if the phone stays unused (quiet hours may push the call later).
    nextCheckAt: Math.max(s.last_active || 0, s.watch_from) + s.inactivity_minutes * 60000,
  });

  router.add('GET', '/api/seniors', (ctx) => {
    const u = requireUser(ctx);
    const rows = u.role === 'admin'
      ? db.prepare('SELECT * FROM seniors ORDER BY name').all()
      : db.prepare('SELECT s.* FROM seniors s JOIN family_links l ON l.senior_id = s.id WHERE l.user_id = ? ORDER BY s.name').all(u.id);
    return { seniors: rows.map((s) => ({ ...seniorFields(s), status: monitor.statusOf(s) })) };
  });

  router.add('GET', '/api/seniors/:id', (ctx) => {
    const s = requireSenior(app, ctx, ctx.params.id);
    const device = db.prepare(
      "SELECT id, model, app_version, battery, usage_access, health_access, location_access, last_seen, created_at FROM devices WHERE senior_id = ? AND revoked_at IS NULL AND kind = 'phone' ORDER BY last_seen DESC LIMIT 1",
    ).get(s.id);
    const rooms = db.prepare("SELECT id, model, battery, last_seen FROM devices WHERE senior_id = ? AND revoked_at IS NULL AND kind = 'room' ORDER BY id").all(s.id);
    const t = now();
    const status = monitor.statusOf(s);
    if (status.incident && status.incident.acked_by) {
      const u = db.prepare('SELECT name FROM users WHERE id = ?').get(status.incident.acked_by);
      status.incident = { ...status.incident, acked_by_name: u ? u.name : null };
    }
    return {
      senior: seniorFields(s),
      status,
      device: { note: monitor.deviceNote(s), ...(device || {}) },
      location: locationStatus(db, s, t),
      rooms,
      sensorEvents: db.prepare('SELECT at, kind, confidence FROM sensor_events WHERE senior_id = ? AND at > ? ORDER BY at DESC, id DESC LIMIT 20')
        .all(s.id, t - 7 * 86400000).map((e) => ({ ...e, label: EVENT_KINDS[e.kind] ? EVENT_KINDS[e.kind].label : e.kind })),
      meds: meds.medsSummary(db, s, t),
      family: monitor.familyOf(s.id).map((f) => ({ name: f.name, relationship: f.relationship, telegramLinked: !!f.telegram_chat_id })),
      events: db.prepare('SELECT at, kind, text FROM events WHERE senior_id = ? ORDER BY at DESC, id DESC LIMIT 50').all(s.id),
      calls: db.prepare(
        `SELECT id, attempt, reason, started_at, ended_at, ended_reason, outcome, summary, transcript FROM calls
         WHERE senior_id = ? ORDER BY started_at DESC LIMIT 20`,
      ).all(s.id),
    };
  });

  router.add('GET', '/api/seniors/:id/insights', (ctx) => {
    const s = requireSenior(app, ctx, ctx.params.id);
    return insights(db, s, now(), Math.min(Math.max(Number(ctx.query.days) || 14, 7), 30));
  });

  // ---------- medication (any caregiver linked to this person can manage it) ----------
  function medInput(b) {
    const name = String(b.name || '').trim();
    const times = meds.parseTimes(b.times);
    if (!name || name.length > 80) throw new HttpError(400, 'Enter the medicine name.');
    if (!times) throw new HttpError(400, 'Add at least one time of day, like 08:00 (up to 8).');
    return { name, dose: String(b.dose || '').trim().slice(0, 60), times: times.join(','), instructions: String(b.instructions || '').trim().slice(0, 200) };
  }
  const ownMed = (s, id) => {
    const m = db.prepare('SELECT * FROM medications WHERE id = ? AND senior_id = ? AND active = 1').get(Number(id), s.id);
    if (!m) throw new HttpError(404, 'Not found.');
    return m;
  };

  router.add('GET', '/api/seniors/:id/meds', (ctx) => meds.medsSummary(db, requireSenior(app, ctx, ctx.params.id), now()));

  router.add('POST', '/api/seniors/:id/meds', (ctx) => {
    const s = requireSenior(app, ctx, ctx.params.id);
    const v = medInput(ctx.body);
    if (db.prepare('SELECT COUNT(*) AS n FROM medications WHERE senior_id = ? AND active = 1').get(s.id).n >= 30) {
      throw new HttpError(400, 'That is a lot of medicines. Remove old ones first.');
    }
    const id = db.prepare('INSERT INTO medications (senior_id, name, dose, times, instructions, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(s.id, v.name, v.dose, v.times, v.instructions, now()).lastInsertRowid;
    monitor.logEvent(s.id, 'ok', `${ctx.user.name} added ${v.name}${v.dose ? ` ${v.dose}` : ''} at ${v.times.replace(/,/g, ', ')}.`);
    return { id };
  });

  // Changing the times starts a new schedule, so past doses keep their history.
  router.add('PUT', '/api/seniors/:id/meds/:medId', (ctx) => {
    const s = requireSenior(app, ctx, ctx.params.id);
    const m = ownMed(s, ctx.params.medId);
    const v = medInput(ctx.body);
    if (v.times === m.times) {
      db.prepare('UPDATE medications SET name = ?, dose = ?, instructions = ? WHERE id = ?').run(v.name, v.dose, v.instructions, m.id);
      return { id: m.id };
    }
    const t = now();
    db.prepare('UPDATE medications SET active = 0, stopped_at = ? WHERE id = ?').run(t, m.id);
    const id = db.prepare('INSERT INTO medications (senior_id, name, dose, times, instructions, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(s.id, v.name, v.dose, v.times, v.instructions, t).lastInsertRowid;
    monitor.logEvent(s.id, 'ok', `${ctx.user.name} changed ${v.name} to ${v.times.replace(/,/g, ', ')}.`);
    return { id };
  });

  router.add('DELETE', '/api/seniors/:id/meds/:medId', (ctx) => {
    const s = requireSenior(app, ctx, ctx.params.id);
    const m = ownMed(s, ctx.params.medId);
    db.prepare('UPDATE medications SET active = 0, stopped_at = ? WHERE id = ?').run(now(), m.id);
    monitor.logEvent(s.id, 'ok', `${ctx.user.name} removed ${m.name} from the medicine list.`);
  });

  // A caregiver confirms a dose ("Mum says she took it").
  router.add('POST', '/api/seniors/:id/doses', (ctx) => {
    const s = requireSenior(app, ctx, ctx.params.id);
    let m;
    try {
      m = meds.recordDose(db, s, { ...ctx.body, source: 'family', userId: ctx.user.id, at: now() });
    } catch (e) {
      throw new HttpError(400, e.message);
    }
    monitor.logEvent(s.id, 'ok', `${ctx.user.name} marked ${m.name} as ${ctx.body.status}.`);
  });

  // ---------- home location (admin) ----------
  router.add('POST', '/api/seniors/:id/home', async (ctx) => {
    requireAdmin(ctx);
    const s = requireSenior(app, ctx, ctx.params.id);
    const radius = Number.isInteger(ctx.body.radius) ? Math.max(50, Math.min(2000, ctx.body.radius)) : s.home_radius_m;
    let point = null;
    if (ctx.body.source === 'phone') {
      const loc = locationStatus(db, s, now());
      if (!loc || now() - loc.at > 3600000) throw new HttpError(400, `The phone hasn't shared a location in the last hour. Make sure ${s.name}'s phone has location on.`);
      point = { lat: loc.lat, lng: loc.lng };
    } else if (ctx.body.source === 'address') {
      point = await geocode(s.address, app.fetchImpl);
      if (!point) throw new HttpError(400, "Couldn't find that address on the map. Check the address, or set home from the phone while it's at home.");
    } else if (ctx.body.source === 'clear') {
      db.prepare('UPDATE seniors SET home_lat = NULL, home_lng = NULL WHERE id = ?').run(s.id);
      return { ok: true };
    } else if (ctx.body.source !== 'radius') {
      throw new HttpError(400, 'Unknown source.');
    }
    if (point) db.prepare('UPDATE seniors SET home_lat = ?, home_lng = ?, home_radius_m = ? WHERE id = ?').run(point.lat, point.lng, radius, s.id);
    else db.prepare('UPDATE seniors SET home_radius_m = ? WHERE id = ?').run(radius, s.id);
    return { ok: true, home: point };
  });

  router.add('POST', '/api/seniors/:id/call', async (ctx) => {
    const s = requireSenior(app, ctx, ctx.params.id);
    const r = await monitor.callNow(s.id, ctx.user);
    if (r.error) throw new HttpError(409, r.error);
  });

  // Pause for travel or a hospital stay. until = epoch ms, or null to resume now.
  router.add('POST', '/api/seniors/:id/pause', (ctx) => {
    const s = requireSenior(app, ctx, ctx.params.id);
    const until = ctx.body.until == null ? null : Number(ctx.body.until);
    const t = now();
    if (until !== null && (!Number.isFinite(until) || until <= t || until > t + 60 * 86400000)) {
      throw new HttpError(400, 'Pick a time in the next 60 days.');
    }
    if (until === null) {
      db.prepare('UPDATE seniors SET paused_until = NULL, watch_from = ? WHERE id = ?').run(t, s.id);
      monitor.logEvent(s.id, 'ok', `${ctx.user.name} resumed monitoring.`);
    } else {
      db.prepare("UPDATE seniors SET paused_until = ?, phase = CASE WHEN phase = 'calling' THEN phase ELSE 'watching' END, retry_at = NULL WHERE id = ?")
        .run(until, s.id);
      monitor.logEvent(s.id, 'warn', `${ctx.user.name} paused monitoring until ${new Date(until).toLocaleString('en-US', { timeZone: s.timezone, dateStyle: 'medium', timeStyle: 'short' })}.`);
    }
  });

  function incidentFor(ctx) {
    const inc = db.prepare('SELECT * FROM incidents WHERE id = ?').get(Number(ctx.params.id));
    if (!inc) throw new HttpError(404, 'Not found.');
    requireSenior(app, ctx, inc.senior_id);
    return inc;
  }

  router.add('POST', '/api/incidents/:id/ack', async (ctx) => {
    const inc = incidentFor(ctx);
    await monitor.acknowledge(inc.id, ctx.user);
  });

  router.add('POST', '/api/incidents/:id/resolve', (ctx) => {
    const inc = incidentFor(ctx);
    monitor.resolve(inc.id, ctx.user);
  });
};
