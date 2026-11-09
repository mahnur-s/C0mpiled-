// Family dashboard API: status, feed, calls, "call now", pause, acknowledge/resolve alerts.
const { HttpError } = require('../http');
const { requireUser, requireSenior } = require('../guards');

module.exports = (app) => {
  const { router, db, now, monitor } = app;

  const seniorFields = (s) => ({
    id: s.id, name: s.name, phone: s.phone, timezone: s.timezone, address: s.address,
    inactivityMinutes: s.inactivity_minutes, quietStart: s.quiet_start, quietEnd: s.quiet_end,
    lastActive: s.last_active, lastCheckin: s.last_checkin, pausedUntil: s.paused_until, phase: s.phase,
    consentAt: s.consent_at,
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
      'SELECT id, model, app_version, battery, usage_access, last_seen, created_at FROM devices WHERE senior_id = ? AND revoked_at IS NULL ORDER BY last_seen DESC LIMIT 1',
    ).get(s.id);
    const status = monitor.statusOf(s);
    if (status.incident && status.incident.acked_by) {
      const u = db.prepare('SELECT name FROM users WHERE id = ?').get(status.incident.acked_by);
      status.incident = { ...status.incident, acked_by_name: u ? u.name : null };
    }
    return {
      senior: seniorFields(s),
      status,
      device: { note: monitor.deviceNote(s), ...(device || {}) },
      family: monitor.familyOf(s.id).map((f) => ({ name: f.name, relationship: f.relationship, telegramLinked: !!f.telegram_chat_id })),
      events: db.prepare('SELECT at, kind, text FROM events WHERE senior_id = ? ORDER BY at DESC, id DESC LIMIT 50').all(s.id),
      calls: db.prepare(
        `SELECT id, attempt, reason, started_at, ended_at, ended_reason, outcome, summary, transcript FROM calls
         WHERE senior_id = ? ORDER BY started_at DESC LIMIT 20`,
      ).all(s.id),
    };
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
