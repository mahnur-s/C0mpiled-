// Android companion app API. Pairing trades a 6-digit code for a long-lived bearer token.
// Two kinds of device: the senior's own phone ('phone') and a spare phone/tablet left in a room ('room').
const { HttpError } = require('../http');
const { randomToken, sha256, rateLimiter } = require('../auth');
const { recordUsage, recordHealth } = require('../health');
const { recordLocation } = require('../location');
const { recordSlots, recordEvents } = require('../sensors');
const meds = require('../meds');

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
    const kind = body.kind === 'room' ? 'room' : 'phone';
    db.prepare('INSERT INTO devices (senior_id, token_hash, model, app_version, kind, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(p.senior_id, sha256(token), String(body.model || '').slice(0, 80), String(body.appVersion || '').slice(0, 20), kind, now(), now());
    const s = db.prepare('SELECT name FROM seniors WHERE id = ?').get(p.senior_id);
    monitor.logEvent(p.senior_id, 'ok', `${kind === 'room' ? 'Room sensor' : 'Phone'} paired${body.model ? ` (${String(body.model).slice(0, 80)})` : ''}.`);
    return { token, seniorName: s.name, kind };
  });

  // Sent every ~15 min by the app, and immediately when the senior taps "I'm OK" or a medicine button.
  router.add('POST', '/api/device/heartbeat', async ({ req, body }) => {
    const d = deviceFrom(req);
    const t = now();
    if (d.kind === 'room') return roomHeartbeat(d, body, t);
    const battery = Number.isInteger(body.battery) && body.battery >= 0 && body.battery <= 100 ? body.battery : d.battery;
    const usageAccess = typeof body.usageAccess === 'boolean' ? Number(body.usageAccess) : d.usage_access;
    db.prepare('UPDATE devices SET last_seen = ?, battery = ?, usage_access = ?, app_version = COALESCE(?, app_version) WHERE id = ?')
      .run(t, battery, usageAccess, body.appVersion ? String(body.appVersion).slice(0, 20) : null, d.id);
    if (d.usage_access !== 0 && usageAccess === 0) {
      monitor.logEvent(d.senior_id, 'warn', 'Usage Access was turned off on the phone, so Haru cannot see activity. Turn it back on in the Haru app.');
    } else if (d.usage_access === 0 && usageAccess === 1) {
      monitor.logEvent(d.senior_id, 'ok', 'Usage Access is on again.');
    }
    if (typeof body.healthAccess === 'boolean') db.prepare('UPDATE devices SET health_access = ? WHERE id = ?').run(Number(body.healthAccess), d.id);
    const at = Number(body.activityAt);
    if (Number.isFinite(at) && at <= t + FUTURE_SLACK_MS && at >= t - MAX_AGE_MS) monitor.recordActivity(d.senior_id, Math.min(at, t));
    if (body.manual === true) monitor.recordActivity(d.senior_id, t, { manual: true });
    recordUsage(db, d.senior_id, [...(Array.isArray(body.usage) ? body.usage : []), ...(Number.isFinite(at) ? [at] : []), ...(body.manual === true ? [t] : [])], t);
    recordHealth(db, d.senior_id, body.health, t);

    if (typeof body.locationAccess === 'boolean' && Number(body.locationAccess) !== d.location_access) {
      db.prepare('UPDATE devices SET location_access = ? WHERE id = ?').run(Number(body.locationAccess), d.id);
      if (d.location_access === 1 && !body.locationAccess) monitor.logEvent(d.senior_id, 'warn', 'Location sharing was turned off on the phone.');
    }
    recordLocation(db, d.senior_id, body.location, t);

    const senior = db.prepare('SELECT * FROM seniors WHERE id = ?').get(d.senior_id);
    for (const x of Array.isArray(body.doses) ? body.doses.slice(0, 50) : []) {
      try {
        const m = meds.recordDose(db, senior, { medicationId: x.medicationId, dueAt: x.dueAt, status: x.status, source: 'phone', at: Number.isFinite(x.at) ? Math.min(x.at, t) : t });
        monitor.logEvent(senior.id, 'ok', `${senior.name} ${x.status === 'taken' ? 'took' : 'skipped'} ${m.name} (${new Date(Number(x.dueAt)).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: senior.timezone })} dose).`);
        monitor.recordActivity(senior.id, Math.min(Number.isFinite(x.at) ? x.at : t, t));
      } catch (_) { /* stale or unknown dose: the app drops it either way */ }
    }
    const s = db.prepare('SELECT name, last_active FROM seniors WHERE id = ?').get(d.senior_id);
    return { ok: true, seniorName: s.name, lastActive: s.last_active, meds: meds.dueForPhone(db, senior, t) };
  });

  // Room sensor: only numbers, never images or audio. Movement counts as a sign of life.
  async function roomHeartbeat(d, body, t) {
    const battery = Number.isInteger(body.battery) && body.battery >= 0 && body.battery <= 100 ? body.battery : d.battery;
    db.prepare('UPDATE devices SET last_seen = ?, battery = ?, app_version = COALESCE(?, app_version) WHERE id = ?')
      .run(t, battery, body.appVersion ? String(body.appVersion).slice(0, 20) : null, d.id);
    const s = body.signals && typeof body.signals === 'object' ? body.signals : {};
    const lastMotion = recordSlots(db, d.senior_id, s.slots, t);
    const motionAt = Number(s.lastMotionAt);
    const seen = Math.max(lastMotion || 0, Number.isFinite(motionAt) && motionAt <= t + FUTURE_SLACK_MS && motionAt >= t - MAX_AGE_MS ? Math.min(motionAt, t) : 0);
    if (seen) monitor.recordActivity(d.senior_id, seen);
    for (const e of recordEvents(db, d.senior_id, s.events, t)) await monitor.sensorEvent(d.senior_id, e);
    const senior = db.prepare('SELECT name FROM seniors WHERE id = ?').get(d.senior_id);
    return { ok: true, seniorName: senior.name };
  }
};
