// Android companion app API. Pairing trades a 6-digit code for a long-lived bearer token.
const { HttpError } = require('../http');
const { randomToken, sha256, rateLimiter } = require('../auth');

const FUTURE_SLACK_MS = 5 * 60000;
const MAX_AGE_MS = 7 * 86400000;

module.exports = (app) => {
  const { router, db, now, monitor } = app;
  const pairLimit = rateLimiter({ max: 10, windowMs: 15 * 60000 });

  function deviceFrom(req) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    const d = m && db.prepare('SELECT * FROM devices WHERE token_hash = ? AND revoked_at IS NULL').get(sha256(m[1]));
    if (!d) throw new HttpError(401, 'This phone is not paired with Haru.');
    return d;
  }

  router.add('POST', '/api/device/pair', ({ req, body }) => {
    const ip = req.headers['fly-client-ip'] || req.socket.remoteAddress;
    if (!pairLimit(ip, now())) throw new HttpError(429, 'Too many attempts. Wait 15 minutes.');
    const code = String(body.code || '').replace(/\D/g, '');
    const p = db.prepare('SELECT * FROM pairing_codes WHERE code = ? AND expires_at > ?').get(code, now());
    if (!p) throw new HttpError(400, 'That code is wrong or expired. Ask for a new one.');
    const token = randomToken();
    db.prepare('DELETE FROM pairing_codes WHERE code = ?').run(code);
    db.prepare('INSERT INTO devices (senior_id, token_hash, model, app_version, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)')
      .run(p.senior_id, sha256(token), String(body.model || '').slice(0, 80), String(body.appVersion || '').slice(0, 20), now(), now());
    const s = db.prepare('SELECT name FROM seniors WHERE id = ?').get(p.senior_id);
    monitor.logEvent(p.senior_id, 'ok', `Phone paired${body.model ? ` (${String(body.model).slice(0, 80)})` : ''}.`);
    return { token, seniorName: s.name };
  });

  // Sent every ~15 min by the app, and immediately when the senior taps "I'm OK".
  router.add('POST', '/api/device/heartbeat', ({ req, body }) => {
    const d = deviceFrom(req);
    const t = now();
    const battery = Number.isInteger(body.battery) && body.battery >= 0 && body.battery <= 100 ? body.battery : d.battery;
    const usageAccess = typeof body.usageAccess === 'boolean' ? Number(body.usageAccess) : d.usage_access;
    db.prepare('UPDATE devices SET last_seen = ?, battery = ?, usage_access = ?, app_version = COALESCE(?, app_version) WHERE id = ?')
      .run(t, battery, usageAccess, body.appVersion ? String(body.appVersion).slice(0, 20) : null, d.id);
    if (d.usage_access !== 0 && usageAccess === 0) {
      monitor.logEvent(d.senior_id, 'warn', 'Usage Access was turned off on the phone, so Haru cannot see activity. Turn it back on in the Haru app.');
    } else if (d.usage_access === 0 && usageAccess === 1) {
      monitor.logEvent(d.senior_id, 'ok', 'Usage Access is on again.');
    }
    const at = Number(body.activityAt);
    if (Number.isFinite(at) && at <= t + FUTURE_SLACK_MS && at >= t - MAX_AGE_MS) monitor.recordActivity(d.senior_id, Math.min(at, t));
    if (body.manual === true) monitor.recordActivity(d.senior_id, t, { manual: true });
    const s = db.prepare('SELECT name, last_active FROM seniors WHERE id = ?').get(d.senior_id);
    return { ok: true, seniorName: s.name, lastActive: s.last_active };
  });
};
