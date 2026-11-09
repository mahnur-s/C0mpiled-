// Demo-only controls (DEMO_MODE=1, admins only): skip time ahead and answer simulated calls.
const { HttpError } = require('../http');
const { requireAdmin, requireSenior } = require('../guards');

module.exports = (app) => {
  const { router, db, now, monitor } = app;

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
