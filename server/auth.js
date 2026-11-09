// Passwords (scrypt), opaque random tokens stored only as SHA-256 hashes, sessions, login rate limiting.
const crypto = require('crypto');

const SESSION_DAYS = 30;
const COOKIE = 'haru_session';

const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [algo, salt, hash] = stored.split('$');
  if (algo !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const got = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(got, expected);
}

function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password must be at least 10 characters.';
  if (pw.length > 200) return 'Password is too long.';
  return null;
}

function createSession(db, userId, now) {
  const token = randomToken();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(sha256(token), userId, now + SESSION_DAYS * 86400000);
  return { token, maxAgeSec: SESSION_DAYS * 86400 };
}

function sessionUser(db, token, now) {
  if (!token) return null;
  return db.prepare(
    `SELECT u.id, u.email, u.name, u.role, u.telegram_chat_id FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
  ).get(sha256(token), now) || null;
}

// Fixed-window limiter, in memory: good enough for a single-machine pilot.
function rateLimiter({ max, windowMs }) {
  const hits = new Map();
  return (key, now) => {
    const h = hits.get(key);
    if (!h || now - h.start > windowMs) {
      hits.set(key, { start: now, n: 1 });
      if (hits.size > 10000) hits.clear();
      return true;
    }
    h.n += 1;
    return h.n <= max;
  };
}

module.exports = {
  COOKIE, randomToken, sha256, safeEqual, hashPassword, verifyPassword, passwordProblem,
  createSession, sessionUser, rateLimiter,
};
