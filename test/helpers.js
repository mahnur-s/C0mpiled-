// Test harness: in-memory DB, fake clock, fake Vapi/Telegram, real HTTP server on a random port.
const { loadConfig } = require('../server/config');
const { openDb } = require('../server/db');
const { createApp } = require('../server/app');
const { createFakeVapi } = require('../server/providers/vapi');
const { createFakeTelegram } = require('../server/providers/telegram');
const { hashPassword } = require('../server/auth');

const MIN = 60000;
// Tuesday 2026-11-10 15:00 UTC = 10:00 in New York (outside default quiet hours).
const START = Date.UTC(2026, 10, 10, 15, 0, 0);

async function makeApp({ env = {}, fetchImpl } = {}) {
  const config = loadConfig({ DB_PATH: ':memory:', VAPI_WEBHOOK_SECRET: 'vapi-secret', ...env });
  const db = openDb(':memory:');
  const clock = { t: START };
  const now = () => clock.t;
  const vapi = createFakeVapi();
  const telegram = createFakeTelegram();
  const app = createApp({ config, db, vapi, telegram, now, fetchImpl: fetchImpl || (async () => { throw new Error('no network in tests'); }) });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;

  const advance = async (minutes) => {
    clock.t += minutes * MIN;
    await app.monitor.tick();
  };

  function client() {
    let cookie = '';
    const call = async (method, path, body, headers = {}) => {
      const r = await fetch(base + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = r.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const data = await r.json().catch(() => null);
      return { status: r.status, data };
    };
    return {
      get: (p, h) => call('GET', p, undefined, h),
      post: (p, b = {}, h) => call('POST', p, b, h),
      put: (p, b = {}, h) => call('PUT', p, b, h),
      del: (p, h) => call('DELETE', p, undefined, h),
    };
  }

  function addUser({ email, name, role = 'family', password = 'correct horse battery', chat = null }) {
    const id = db.prepare('INSERT INTO users (email, name, password_hash, role, telegram_chat_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(email, name, hashPassword(password), role, chat, now()).lastInsertRowid;
    return { id, email, name, password };
  }

  async function login(user) {
    const c = client();
    const r = await c.post('/api/login', { email: user.email, password: user.password });
    if (r.status !== 200) throw new Error(`login failed: ${JSON.stringify(r.data)}`);
    return c;
  }

  // Admin + senior + one linked family member with Telegram, the common starting point.
  async function setup(seniorOverrides = {}) {
    const admin = addUser({ email: 'admin@example.com', name: 'Admin', role: 'admin' });
    const adminC = await login(admin);
    const r = await adminC.post('/api/admin/seniors', {
      name: 'Margaret', phone: '+14155550100', timezone: 'America/New_York', address: '1 Main St, Springfield',
      inactivityMinutes: 240, quietStart: '22:00', quietEnd: '07:00', consent: true, ...seniorOverrides,
    });
    if (r.status !== 200) throw new Error(`create senior failed: ${JSON.stringify(r.data)}`);
    const seniorId = r.data.id;
    const fam = addUser({ email: 'daughter@example.com', name: 'Jane', chat: '1001' });
    db.prepare('INSERT INTO family_links (user_id, senior_id, relationship) VALUES (?, ?, ?)').run(fam.id, seniorId, 'daughter');
    const famC = await login(fam);
    return { admin, adminC, seniorId, fam, famC };
  }

  const senior = (id) => db.prepare('SELECT * FROM seniors WHERE id = ?').get(id);
  const calls = (id) => db.prepare('SELECT * FROM calls WHERE senior_id = ? ORDER BY id').all(id);
  const incidents = (id) => db.prepare('SELECT * FROM incidents WHERE senior_id = ? ORDER BY id').all(id);
  const events = (id) => db.prepare('SELECT * FROM events WHERE senior_id = ? ORDER BY id').all(id).map((e) => e.text);

  const close = () => new Promise((r) => {
    app.stopBackground();
    app.server.close(() => r());
  });

  return { app, db, config, clock, now, vapi, telegram, base, advance, client, addUser, login, setup, senior, calls, incidents, events, close };
}

module.exports = { makeApp, MIN, START };
