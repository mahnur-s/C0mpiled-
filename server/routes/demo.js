// Demo-only controls (DEMO_MODE=1, admins only): skip time ahead and answer simulated calls.
const { HttpError, setCookie } = require('../http');
const { requireAdmin, requireSenior } = require('../guards');
const { COOKIE, createSession } = require('../auth');
const { tx } = require('../db');
const { ensureDemoUser, seedDemo } = require('../demo-seed');
const meds = require('../meds');
const { recordLocation } = require('../location');
const { recordEvents } = require('../sensors');

module.exports = (app) => {
  const { router, db, now, monitor, config } = app;

  // "Try the demo" on the login page: no password, opens on a sample person with two weeks of history.
  router.add('POST', '/api/demo/start', ({ res }) => {
    const user = tx(db, () => {
      const u = ensureDemoUser(db, now());
      if (!db.prepare('SELECT 1 FROM seniors').get()) seedDemo(db, now());
      return u;
    });
    const { token, maxAgeSec } = createSession(db, user.id, now());
    setCookie(res, COOKIE, token, { maxAgeSec, secure: config.secureCookies });
    return { seniorId: db.prepare('SELECT id FROM seniors ORDER BY id LIMIT 1').get().id };
  });

  router.add('POST', '/api/demo/reset', (ctx) => {
    requireAdmin(ctx);
    const id = tx(db, () => {
      db.prepare('DELETE FROM seniors').run();
      return seedDemo(db, now());
    });
    return { seniorId: id };
  });

  // Moving every timestamp back is equivalent to the clock moving forward, without faking the clock.
  router.add('POST', '/api/demo/seniors/:id/fast-forward', async (ctx) => {
    requireAdmin(ctx);
    const s = requireSenior(app, ctx, ctx.params.id);
    const ms = Math.min(Math.max(Number(ctx.body.hours) || 0, 0), 48) * 3600000;
    db.prepare(
      `UPDATE seniors SET last_active = last_active - ?, watch_from = watch_from - ?, retry_at = retry_at - ?,
       paused_until = paused_until - ? WHERE id = ?`,
    ).run(ms, ms, ms, ms, s.id);
    db.prepare('UPDATE calls SET started_at = started_at - ? WHERE senior_id = ? AND ended_at IS NULL').run(ms, s.id);
    db.prepare('UPDATE incidents SET last_alert_at = last_alert_at - ? WHERE senior_id = ? AND resolved_at IS NULL').run(ms, s.id);
    db.prepare('UPDATE devices SET last_seen = last_seen - ? WHERE senior_id = ?').run(ms, s.id);
    monitor.logEvent(s.id, 'ok', `Demo: skipped ahead ${ms / 3600000} hours.`);
    await monitor.tick();
  });

  router.add('POST', '/api/demo/seniors/:id/activity', (ctx) => {
    requireAdmin(ctx);
    const s = requireSenior(app, ctx, ctx.params.id);
    monitor.recordActivity(s.id, now(), { manual: !!ctx.body.manual });
  });

  // She presses "I took it" on the medicine reminder: every dose that is due or late now.
  router.add('POST', '/api/demo/seniors/:id/take-meds', (ctx) => {
    requireAdmin(ctx);
    const s = requireSenior(app, ctx, ctx.params.id);
    const due = meds.dueForPhone(db, s, now());
    if (!due.length) throw new HttpError(409, 'No medicine is due right now. Try "Skip ahead" first.');
    for (const d of due) {
      meds.recordDose(db, s, { medicationId: d.medicationId, dueAt: d.dueAt, status: 'taken', source: 'phone', at: now() });
      monitor.logEvent(s.id, 'ok', `${s.name} took ${d.name} (pressed "I took it" on the phone).`);
    }
    monitor.recordActivity(s.id, now());
  });

  // She walks to the shops: the phone reports a position ~800 m from home.
  router.add('POST', '/api/demo/seniors/:id/location', (ctx) => {
    requireAdmin(ctx);
    const s = requireSenior(app, ctx, ctx.params.id);
    if (s.home_lat == null) throw new HttpError(409, 'Set a home location first.');
    const away = ctx.body.away !== false;
    recordLocation(db, s.id, { lat: s.home_lat + (away ? 0.0068 : 0.00005), lng: s.home_lng + (away ? 0.0021 : 0), accuracy: 18, at: now() }, now());
    monitor.recordActivity(s.id, now());
  });

  // The living-room sensor hears something.
  router.add('POST', '/api/demo/seniors/:id/sensor', async (ctx) => {
    requireAdmin(ctx);
    const s = requireSenior(app, ctx, ctx.params.id);
    const kind = ['possible_fall', 'loud_impact', 'smoke_alarm'].includes(ctx.body.kind) ? ctx.body.kind : 'possible_fall';
    for (const e of recordEvents(db, s.id, [{ at: now(), kind, confidence: 0.82 }], now())) await monitor.sensorEvent(s.id, e);
  });

  router.add('POST', '/api/demo/seniors/:id/answer', async (ctx) => {
    requireAdmin(ctx);
    const s = requireSenior(app, ctx, ctx.params.id);
    const call = db.prepare('SELECT id FROM calls WHERE senior_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1').get(s.id);
    if (!call) throw new HttpError(409, 'Haru is not calling right now.');
    const userText = String(ctx.body.userText || '').slice(0, 2000);
    const transcript = userText ? `AI: Hi ${s.name}, this is Haru. Are you okay?\nUser: ${userText}` : '';
    await monitor.finishCall(call.id, { endedReason: userText ? 'customer-ended-call' : 'customer-did-not-answer', transcript, userText });
  });
};
