// Admin API: manage seniors, invite family, pair and revoke phones.
const crypto = require('crypto');
const { HttpError } = require('../http');
const { requireAdmin } = require('../guards');
const { randomToken, sha256 } = require('../auth');
const { isValidTimezone, HHMM } = require('../time');

const E164 = /^\+[1-9]\d{7,14}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVITE_DAYS = 7;
const PAIRING_MINUTES = 60;

function seniorInput(b) {
  const out = {
    name: String(b.name || '').trim(),
    phone: String(b.phone || '').replace(/[\s()-]/g, ''),
    timezone: String(b.timezone || '').trim(),
    address: String(b.address || '').trim(),
    inactivity_minutes: Number(b.inactivityMinutes),
    quiet_start: String(b.quietStart || '22:00'),
    quiet_end: String(b.quietEnd || '07:00'),
  };
  if (!out.name || out.name.length > 80) throw new HttpError(400, 'Enter a name (up to 80 characters).');
  if (!E164.test(out.phone)) throw new HttpError(400, 'Phone must be in international format, e.g. +14155551234.');
  if (!isValidTimezone(out.timezone)) throw new HttpError(400, 'Unknown timezone. Use a name like America/New_York.');
  if (out.address.length > 200) throw new HttpError(400, 'Address is too long.');
  if (!Number.isInteger(out.inactivity_minutes) || out.inactivity_minutes < 60 || out.inactivity_minutes > 2880) {
    throw new HttpError(400, 'Inactivity threshold must be between 60 minutes and 48 hours.');
  }
  if (!HHMM.test(out.quiet_start) || !HHMM.test(out.quiet_end)) throw new HttpError(400, 'Quiet hours must look like 22:00.');
  return out;
}

module.exports = (app) => {
  const { router, db, now, config, monitor } = app;
  const getSenior = (id) => {
    const s = db.prepare('SELECT * FROM seniors WHERE id = ?').get(Number(id));
    if (!s) throw new HttpError(404, 'Not found.');
    return s;
  };

  router.add('POST', '/api/admin/seniors', (ctx) => {
    const admin = requireAdmin(ctx);
    const v = seniorInput(ctx.body);
    if (ctx.body.consent !== true) throw new HttpError(400, 'Confirm that the senior has agreed to be monitored and called.');
    const t = now();
    const id = db.prepare(
      `INSERT INTO seniors (name, phone, timezone, address, inactivity_minutes, quiet_start, quiet_end, consent_at, watch_from, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(v.name, v.phone, v.timezone, v.address, v.inactivity_minutes, v.quiet_start, v.quiet_end, t, t, t).lastInsertRowid;
    monitor.logEvent(id, 'ok', `${admin.name} set up Haru for ${v.name}.`);
    return { id };
  });

  router.add('PUT', '/api/admin/seniors/:id', (ctx) => {
    requireAdmin(ctx);
    const s = getSenior(ctx.params.id);
    const v = seniorInput(ctx.body);
    db.prepare(
      `UPDATE seniors SET name = ?, phone = ?, timezone = ?, address = ?, inactivity_minutes = ?, quiet_start = ?, quiet_end = ? WHERE id = ?`,
    ).run(v.name, v.phone, v.timezone, v.address, v.inactivity_minutes, v.quiet_start, v.quiet_end, s.id);
  });

  router.add('DELETE', '/api/admin/seniors/:id', (ctx) => {
    requireAdmin(ctx);
    db.prepare('DELETE FROM seniors WHERE id = ?').run(getSenior(ctx.params.id).id);
  });

  router.add('GET', '/api/admin/seniors/:id', (ctx) => {
    requireAdmin(ctx);
    const s = getSenior(ctx.params.id);
    return {
      family: db.prepare(
        `SELECT u.id, u.name, u.email, l.relationship, u.telegram_chat_id IS NOT NULL AS telegramLinked
         FROM family_links l JOIN users u ON u.id = l.user_id WHERE l.senior_id = ? ORDER BY u.name`,
      ).all(s.id),
      invites: db.prepare('SELECT email, name, relationship, expires_at FROM invites WHERE senior_id = ? AND used_at IS NULL AND expires_at > ?')
        .all(s.id, now()),
      devices: db.prepare(
        'SELECT id, model, app_version, battery, usage_access, last_seen, created_at FROM devices WHERE senior_id = ? AND revoked_at IS NULL ORDER BY created_at DESC',
      ).all(s.id),
    };
  });

  router.add('POST', '/api/admin/seniors/:id/invites', (ctx) => {
    requireAdmin(ctx);
    const s = getSenior(ctx.params.id);
    const email = String(ctx.body.email || '').trim().toLowerCase();
    const name = String(ctx.body.name || '').trim();
    const relationship = String(ctx.body.relationship || '').trim().slice(0, 40);
    if (!EMAIL.test(email)) throw new HttpError(400, 'Enter a valid email.');
    if (!name || name.length > 80) throw new HttpError(400, 'Enter their name.');
    const token = randomToken();
    db.prepare('INSERT INTO invites (token_hash, email, name, relationship, senior_id, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sha256(token), email, name, relationship, s.id, now() + INVITE_DAYS * 86400000);
    return { url: `${config.publicUrl}/invite.html#${token}`, expiresInDays: INVITE_DAYS };
  });

  router.add('DELETE', '/api/admin/seniors/:id/family/:userId', (ctx) => {
    requireAdmin(ctx);
    const s = getSenior(ctx.params.id);
    db.prepare('DELETE FROM family_links WHERE senior_id = ? AND user_id = ?').run(s.id, Number(ctx.params.userId));
  });

  router.add('POST', '/api/admin/seniors/:id/pairing-code', (ctx) => {
    requireAdmin(ctx);
    const s = getSenior(ctx.params.id);
    db.prepare('DELETE FROM pairing_codes WHERE senior_id = ? OR expires_at < ?').run(s.id, now());
    let code;
    do code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    while (db.prepare('SELECT 1 FROM pairing_codes WHERE code = ?').get(code));
    const expiresAt = now() + PAIRING_MINUTES * 60000;
    db.prepare('INSERT INTO pairing_codes (code, senior_id, expires_at) VALUES (?, ?, ?)').run(code, s.id, expiresAt);
    return { code, expiresAt, serverUrl: config.publicUrl };
  });

  router.add('DELETE', '/api/admin/devices/:id', (ctx) => {
    requireAdmin(ctx);
    const d = db.prepare('SELECT * FROM devices WHERE id = ?').get(Number(ctx.params.id));
    if (!d) throw new HttpError(404, 'Not found.');
    db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(now(), d.id);
    monitor.logEvent(d.senior_id, 'warn', `Phone ${d.model || ''} was disconnected from Haru.`.replace('  ', ' '));
  });
};
