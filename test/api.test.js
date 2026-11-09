const test = require('node:test');
const assert = require('node:assert/strict');
const { makeApp, MIN } = require('./helpers');

async function withApp(fn, opts) {
  const h = await makeApp(opts);
  try {
    await fn(h);
  } finally {
    await h.close();
  }
}

test('login, me, logout, and wrong passwords', () => withApp(async (h) => {
  const u = h.addUser({ email: 'a@example.com', name: 'A' });
  const c = h.client();
  assert.equal((await c.get('/api/me')).status, 401);
  assert.equal((await c.post('/api/login', { email: 'a@example.com', password: 'nope' })).status, 401);
  assert.equal((await c.post('/api/login', { email: 'A@Example.com', password: u.password })).status, 200);
  assert.equal((await c.get('/api/me')).data.user.name, 'A');
  await c.post('/api/logout');
  assert.equal((await c.get('/api/me')).status, 401);
}));

test('login is rate limited', () => withApp(async (h) => {
  h.addUser({ email: 'a@example.com', name: 'A' });
  const c = h.client();
  for (let i = 0; i < 10; i++) await c.post('/api/login', { email: 'a@example.com', password: 'wrong' });
  assert.equal((await c.post('/api/login', { email: 'a@example.com', password: 'wrong' })).status, 429);
}));

test('cross-origin writes with a session cookie are rejected', () => withApp(async (h) => {
  const { famC, seniorId } = await h.setup();
  const r = await famC.post(`/api/seniors/${seniorId}/call`, {}, { Origin: 'https://evil.example' });
  assert.equal(r.status, 403);
}));

test('family members only see their own seniors; only admins manage', () => withApp(async (h) => {
  const { adminC, famC, seniorId } = await h.setup();
  const other = await adminC.post('/api/admin/seniors', {
    name: 'Other', phone: '+14155550199', timezone: 'America/Chicago', inactivityMinutes: 240, consent: true,
  });
  assert.deepEqual((await famC.get('/api/seniors')).data.seniors.map((s) => s.id), [seniorId]);
  assert.equal((await famC.get(`/api/seniors/${other.data.id}`)).status, 404);
  assert.equal((await famC.post(`/api/seniors/${other.data.id}/call`)).status, 404);
  assert.equal((await famC.post('/api/admin/seniors', {})).status, 403);
  assert.equal((await adminC.get('/api/seniors')).data.seniors.length, 2);
}));

test('senior validation and consent', () => withApp(async (h) => {
  const { adminC } = await h.setup();
  const base = { name: 'X', phone: '+14155550111', timezone: 'America/New_York', inactivityMinutes: 240, consent: true };
  assert.equal((await adminC.post('/api/admin/seniors', { ...base, phone: '415-555' })).status, 400);
  assert.equal((await adminC.post('/api/admin/seniors', { ...base, timezone: 'Mars/Base' })).status, 400);
  assert.equal((await adminC.post('/api/admin/seniors', { ...base, inactivityMinutes: 5 })).status, 400);
  assert.equal((await adminC.post('/api/admin/seniors', { ...base, consent: false })).status, 400);
  assert.equal((await adminC.post('/api/admin/seniors', { ...base, phone: '+1 (415) 555-0111' })).status, 200);
}));

test('invite flow: new account, then existing account linking to a second senior', () => withApp(async (h) => {
  const { adminC, seniorId } = await h.setup();
  const inv = await adminC.post(`/api/admin/seniors/${seniorId}/invites`, { email: 'Son@example.com', name: 'Sam', relationship: 'son' });
  assert.equal(inv.status, 200);
  const token = inv.data.url.split('#')[1];
  const c = h.client();
  assert.equal((await c.get(`/api/invites/${token}`)).data.seniorName, 'Margaret');
  assert.equal((await c.post(`/api/invites/${token}/accept`, { password: 'short' })).status, 400);
  assert.equal((await c.post(`/api/invites/${token}/accept`, { password: 'a long enough password' })).status, 200);
  assert.equal((await c.get('/api/me')).data.user.email, 'son@example.com');
  assert.equal((await c.get('/api/seniors')).data.seniors.length, 1);
  assert.equal((await h.client().get(`/api/invites/${token}`)).status, 404, 'one-time use');

  const s2 = await adminC.post('/api/admin/seniors', { name: 'Dad', phone: '+14155550122', timezone: 'America/New_York', inactivityMinutes: 240, consent: true });
  const inv2 = await adminC.post(`/api/admin/seniors/${s2.data.id}/invites`, { email: 'son@example.com', name: 'Sam' });
  const r = await h.client().post(`/api/invites/${inv2.data.url.split('#')[1]}/accept`, {});
  assert.equal(r.data.needsLogin, true);
  assert.equal((await c.get('/api/seniors')).data.seniors.length, 2);
}));

test('invites expire', () => withApp(async (h) => {
  const { adminC, seniorId } = await h.setup();
  const inv = await adminC.post(`/api/admin/seniors/${seniorId}/invites`, { email: 's@example.com', name: 'S' });
  h.clock.t += 8 * 24 * 60 * MIN;
  assert.equal((await h.client().get(`/api/invites/${inv.data.url.split('#')[1]}`)).status, 404);
}));

test('device pairing and heartbeats update activity', () => withApp(async (h) => {
  const { adminC, famC, seniorId } = await h.setup();
  const { code } = (await adminC.post(`/api/admin/seniors/${seniorId}/pairing-code`)).data;
  assert.match(code, /^\d{6}$/);
  const phone = h.client();
  assert.equal((await phone.post('/api/device/pair', { code: '000000' })).status, 400);
  const paired = await phone.post('/api/device/pair', { code, model: 'Pixel 7', appVersion: '1.0' });
  assert.equal(paired.data.seniorName, 'Margaret');
  assert.equal((await phone.post('/api/device/pair', { code })).status, 400, 'codes are single use');
  const auth = { Authorization: `Bearer ${paired.data.token}` };

  assert.equal((await phone.post('/api/device/heartbeat', {}, { Authorization: 'Bearer nope' })).status, 401);
  const unlockAt = h.now() - 5 * MIN;
  await phone.post('/api/device/heartbeat', { activityAt: unlockAt, battery: 80, usageAccess: true }, auth);
  assert.equal(h.senior(seniorId).last_active, unlockAt);
  await phone.post('/api/device/heartbeat', { activityAt: h.now() + 365 * 86400000 }, auth);
  assert.equal(h.senior(seniorId).last_active, unlockAt, 'ignores timestamps far in the future');

  await phone.post('/api/device/heartbeat', { usageAccess: false }, auth);
  assert.ok(h.events(seniorId).some((e) => /Usage Access was turned off/.test(e)));

  const detail = (await famC.get(`/api/seniors/${seniorId}`)).data;
  assert.equal(detail.device.battery, 80);
  assert.match(detail.device.note, /Usage Access is turned off/);

  await adminC.del(`/api/admin/devices/${detail.device.id}`);
  assert.equal((await phone.post('/api/device/heartbeat', {}, auth)).status, 401);
}));

test('"I\'m OK" on the phone cancels a pending retry', () => withApp(async (h) => {
  const { adminC, seniorId } = await h.setup();
  const { code } = (await adminC.post(`/api/admin/seniors/${seniorId}/pairing-code`)).data;
  const phone = h.client();
  const { token } = (await phone.post('/api/device/pair', { code })).data;
  await h.advance(241);
  await h.app.monitor.finishCall(h.calls(seniorId)[0].id, { userText: '' });
  assert.equal(h.senior(seniorId).phase, 'retry');
  await phone.post('/api/device/heartbeat', { manual: true }, { Authorization: `Bearer ${token}` });
  assert.equal(h.senior(seniorId).phase, 'watching');
  await h.advance(15);
  assert.equal(h.calls(seniorId).length, 1);
}));

test('Vapi webhook requires the secret and finishes the matching call', () => withApp(async (h) => {
  const { seniorId } = await h.setup();
  await h.advance(241);
  const vapiId = h.calls(seniorId)[0].vapi_call_id;
  const report = {
    message: {
      type: 'end-of-call-report',
      endedReason: 'customer-ended-call',
      call: { id: vapiId },
      artifact: {
        transcript: 'AI: Are you okay?\nUser: I fell down',
        messages: [{ role: 'assistant', message: 'Are you okay?' }, { role: 'user', message: 'I fell down' }],
      },
    },
  };
  const c = h.client();
  assert.equal((await c.post('/api/webhooks/vapi', report)).status, 401);
  assert.equal((await c.post('/api/webhooks/vapi', report, { 'X-Vapi-Secret': 'wrong' })).status, 401);
  assert.equal((await c.post('/api/webhooks/vapi', report, { 'X-Vapi-Secret': 'vapi-secret' })).status, 200);
  assert.equal(h.calls(seniorId)[0].outcome, 'emergency');
  assert.equal(h.incidents(seniorId).length, 1);
  await c.post('/api/webhooks/vapi', report, { 'X-Vapi-Secret': 'vapi-secret' });
  assert.equal(h.incidents(seniorId).length, 1, 'duplicate reports are ignored');
}));

test('Telegram: linking by deep link, and acknowledging from the button', () => withApp(async (h) => {
  const { seniorId, fam, famC } = await h.setup();
  h.db.prepare('UPDATE users SET telegram_chat_id = NULL WHERE id = ?').run(fam.id);
  const { url } = (await famC.post('/api/me/telegram')).data;
  const token = new URL(url).searchParams.get('start');
  const tg = h.client();
  const secret = { 'X-Telegram-Bot-Api-Secret-Token': 'tg-secret' };
  const update = { update_id: 1, message: { chat: { id: 555 }, text: `/start ${token}` } };
  assert.equal((await tg.post('/api/webhooks/telegram', update)).status, 401);
  await tg.post('/api/webhooks/telegram', update, secret);
  assert.equal(h.db.prepare('SELECT telegram_chat_id FROM users WHERE id = ?').get(fam.id).telegram_chat_id, '555');

  await h.advance(241);
  await h.app.monitor.finishCall(h.calls(seniorId)[0].id, { userText: 'I fell' });
  const inc = h.incidents(seniorId)[0];
  await tg.post('/api/webhooks/telegram', { update_id: 2, callback_query: { id: 'q', from: { id: 777 }, message: { chat: { id: 777 } }, data: `ack:${inc.id}` } }, secret);
  assert.equal(h.incidents(seniorId)[0].acked_at, null, 'strangers cannot acknowledge');
  await tg.post('/api/webhooks/telegram', { update_id: 3, callback_query: { id: 'q', from: { id: 555 }, message: { chat: { id: 555 } }, data: `ack:${inc.id}` } }, secret);
  assert.equal(h.incidents(seniorId)[0].acked_by, fam.id);
}));

test('dashboard: acknowledge and resolve an incident', () => withApp(async (h) => {
  const { seniorId, famC } = await h.setup();
  await h.advance(241);
  await h.app.monitor.finishCall(h.calls(seniorId)[0].id, { userText: 'I fell' });
  let d = (await famC.get(`/api/seniors/${seniorId}`)).data;
  assert.equal(d.status.level, 'bad');
  await famC.post(`/api/incidents/${d.status.incident.id}/ack`);
  await famC.post(`/api/incidents/${d.status.incident.id}/resolve`);
  d = (await famC.get(`/api/seniors/${seniorId}`)).data;
  assert.equal(d.status.level, 'ok');
}));

test('demo routes exist only in demo mode', async () => {
  await withApp(async (h) => {
    const { adminC, seniorId } = await h.setup();
    assert.equal((await adminC.post(`/api/demo/seniors/${seniorId}/fast-forward`, { hours: 6 })).status, 404);
  });
  await withApp(async (h) => {
    const { adminC, famC, seniorId } = await h.setup();
    assert.equal((await famC.post(`/api/demo/seniors/${seniorId}/fast-forward`, { hours: 6 })).status, 403);
    await adminC.post(`/api/demo/seniors/${seniorId}/fast-forward`, { hours: 6 });
    assert.equal(h.senior(seniorId).phase, 'calling');
    await adminC.post(`/api/demo/seniors/${seniorId}/answer`, { userText: "I'm fine, thank you" });
    assert.equal(h.senior(seniorId).phase, 'watching');
  }, { env: { DEMO_MODE: '1' } });
});

test('static files, path traversal, healthz', () => withApp(async (h) => {
  const r = await fetch(`${h.base}/../server/config.js`);
  assert.notEqual(r.status, 200);
  const enc = await fetch(`${h.base}/%2e%2e/server/config.js`);
  assert.notEqual(enc.status, 200);
  assert.equal((await fetch(`${h.base}/healthz`)).status, 503, 'monitor has not ticked yet');
  await h.app.monitor.tick();
  assert.equal((await fetch(`${h.base}/healthz`)).status, 200);
}));
