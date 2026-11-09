// Login, logout, current user, invite acceptance, Telegram account linking.
const { HttpError, setCookie } = require('../http');
const { COOKIE, sha256, randomToken, verifyPassword, hashPassword, passwordProblem, createSession, rateLimiter } = require('../auth');
const { requireUser } = require('../guards');
const { tx } = require('../db');

module.exports = (app) => {
  const { router, db, now, config, telegram } = app;
  const loginLimit = rateLimiter({ max: 10, windowMs: 15 * 60000 });

  const publicUser = (u) => ({
    id: u.id, name: u.name, email: u.email, role: u.role, telegramLinked: !!u.telegram_chat_id,
  });

  function startSession(res, userId) {
    const { token, maxAgeSec } = createSession(db, userId, now());
    setCookie(res, COOKIE, token, { maxAgeSec, secure: config.secureCookies });
  }

  router.add('POST', '/api/login', ({ req, res, body }) => {
    const email = String(body.email || '').trim().toLowerCase();
    const ip = req.headers['fly-client-ip'] || req.socket.remoteAddress;
    if (!loginLimit(`${ip}|${email}`, now())) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
    const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!u || !verifyPassword(String(body.password || ''), u.password_hash)) throw new HttpError(401, 'Wrong email or password.');
    startSession(res, u.id);
    return { user: publicUser(u) };
  });

  router.add('POST', '/api/logout', ({ req, res }) => {
    const token = (req.headers.cookie || '').match(new RegExp(`${COOKIE}=([^;]+)`));
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(decodeURIComponent(token[1])));
    setCookie(res, COOKIE, '', { maxAgeSec: 0, secure: config.secureCookies });
  });

  router.add('GET', '/api/me', (ctx) => ({ user: publicUser(requireUser(ctx)) }));

  router.add('GET', '/api/config', () => ({
    demoMode: config.demoMode,
    telegramBot: telegram.configured ? telegram.username : null,
  }));

  // ---------- invites ----------
  function findInvite(token) {
    const inv = db.prepare(
      `SELECT i.*, s.name AS senior_name FROM invites i JOIN seniors s ON s.id = i.senior_id
       WHERE i.token_hash = ? AND i.used_at IS NULL AND i.expires_at > ?`,
    ).get(sha256(token), now());
    if (!inv) throw new HttpError(404, 'This invite link is invalid or has expired. Ask your Haru admin for a new one.');
    return inv;
  }

  router.add('GET', '/api/invites/:token', ({ params }) => {
    const inv = findInvite(params.token);
    const existing = !!db.prepare('SELECT 1 FROM users WHERE email = ?').get(inv.email);
    return { name: inv.name, email: inv.email, seniorName: inv.senior_name, existingAccount: existing };
  });

  router.add('POST', '/api/invites/:token/accept', ({ params, body, res }) => {
    const inv = findInvite(params.token);
    const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(inv.email);
    if (!existing) {
      const problem = passwordProblem(body.password);
      if (problem) throw new HttpError(400, problem);
    }
    const userId = tx(db, () => {
      const id = existing
        ? existing.id
        : db.prepare("INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?, ?, ?, 'family', ?)")
          .run(inv.email, inv.name, hashPassword(body.password), now()).lastInsertRowid;
      db.prepare('INSERT OR IGNORE INTO family_links (user_id, senior_id, relationship) VALUES (?, ?, ?)')
        .run(id, inv.senior_id, inv.relationship);
      db.prepare('UPDATE invites SET used_at = ? WHERE token_hash = ?').run(now(), inv.token_hash);
      return id;
    });
    app.monitor.logEvent(inv.senior_id, 'ok', `${inv.name} joined as family.`);
    if (existing) return { ok: true, needsLogin: true };
    startSession(res, userId);
    return { ok: true };
  });

  // ---------- Telegram linking: user taps t.me/<bot>?start=<token>, bot receives "/start <token>" ----------
  router.add('POST', '/api/me/telegram', (ctx) => {
    const u = requireUser(ctx);
    if (!telegram.configured || !telegram.username) throw new HttpError(400, 'Telegram is not set up on this server yet.');
    const token = randomToken(24);
    db.prepare('UPDATE users SET telegram_link_token = ? WHERE id = ?').run(sha256(token), u.id);
    return { url: `https://t.me/${telegram.username}?start=${token}` };
  });

  router.add('DELETE', '/api/me/telegram', (ctx) => {
    const u = requireUser(ctx);
    db.prepare('UPDATE users SET telegram_chat_id = NULL, telegram_link_token = NULL WHERE id = ?').run(u.id);
  });
};
