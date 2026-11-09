// Create (or reset the password of) an admin account and print a one-time password.
// Usage: node scripts/create-admin.js you@example.com "Your Name"
const crypto = require('crypto');
const { loadDotEnv, loadConfig } = require('../server/config');
const { openDb } = require('../server/db');
const { hashPassword } = require('../server/auth');

const [email, name] = process.argv.slice(2);
if (!email || !name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Usage: node scripts/create-admin.js you@example.com "Your Name"');
  process.exit(1);
}

loadDotEnv();
const db = openDb(loadConfig().dbPath);
const password = crypto.randomBytes(12).toString('base64url');
const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
if (existing) {
  db.prepare("UPDATE users SET password_hash = ?, role = 'admin', name = ? WHERE id = ?").run(hashPassword(password), name, existing.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existing.id);
  console.log(`Reset password for admin ${email}`);
} else {
  db.prepare("INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?, ?, ?, 'admin', ?)")
    .run(email.toLowerCase(), name, hashPassword(password), Date.now());
  console.log(`Created admin ${email}`);
}
console.log(`Password: ${password}`);
console.log('Log in, then keep this password somewhere safe (it is not stored in plain text).');
db.close();
