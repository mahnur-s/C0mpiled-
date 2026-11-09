const test = require('node:test');
const assert = require('node:assert/strict');
const { makeApp, MIN } = require('./helpers');
const { dayKey } = require('../server/insights');

async function withApp(fn, opts) {
  const h = await makeApp(opts);
  try {
    await fn(h);
  } finally {
    await h.close();
  }
}

async function pairPhone(h, adminC, seniorId) {
  const { code } = (await adminC.post(`/api/admin/seniors/${seniorId}/pairing-code`)).data;
  const phone = h.client();
  const { token } = (await phone.post('/api/device/pair', { code })).data;
  return (body) => phone.post('/api/device/heartbeat', body, { Authorization: `Bearer ${token}` });
}

test('heartbeats store usage slots and Health Connect days, with validation', () => withApp(async (h) => {
  const { adminC, famC, seniorId } = await h.setup();
  const beat = await pairPhone(h, adminC, seniorId);
  const tz = 'America/New_York';
  const today = dayKey(h.now(), tz);
  await beat({
    usage: [h.now() - 20 * MIN, h.now() - 25 * MIN, h.now() + 365 * 86400000, 'x'],
    healthAccess: true,
    health: {
      days: [{ day: today, steps: 2345, restingHr: 64, sleepMinutes: 430 }, { day: 'bad', steps: 1 }, { day: today, steps: -5 }],
      latestHeartRate: { at: h.now() - 5 * MIN, bpm: 72 },
    },
  });
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM activity_slots').get().n, 1, 'two times in one slot, future dropped');
  const row = h.db.prepare('SELECT * FROM health_daily').get();
  assert.equal(row.steps, 2345, 'invalid later value does not overwrite a good one');
  assert.equal(h.senior(seniorId).latest_hr, 72);

  const ins = (await famC.get(`/api/seniors/${seniorId}/insights`)).data;
  assert.equal(ins.today.steps, 2345);
  assert.equal(ins.today.heartRate.bpm, 72);
  assert.equal(ins.today.sleepMinutes, 430);
  assert.equal(ins.hasHealth, true);
  assert.equal(ins.week.length, 7);
  assert.equal(ins.week[6].hours.reduce((a, b) => a + b, 0), 1);
}));

test('gentle flags compare with this person\'s own normal', () => withApp(async (h) => {
  const { famC, seniorId } = await h.setup();
  const tz = 'America/New_York';
  const ins = h.db.prepare('INSERT INTO health_daily (senior_id, day, steps, resting_hr, updated_at) VALUES (?, ?, ?, ?, ?)');
  const slot = h.db.prepare('INSERT INTO activity_slots (senior_id, slot) VALUES (?, ?)');
  for (let i = 1; i <= 10; i++) {
    const t = h.now() - i * 86400000;
    ins.run(seniorId, dayKey(t, tz), i === 1 ? 900 : 4000, i === 1 ? 80 : 65, h.now());
    slot.run(seniorId, Math.floor((t - 2 * 3600000) / 900000) * 900000); // ~8 AM New York
  }
  // START is 10:00 New York; nothing logged today, usual first use ~8 AM: not yet 2h late.
  let flags = (await famC.get(`/api/seniors/${seniorId}/insights`)).data.flags.map((f) => f.text);
  assert.ok(flags.some((t) => /Much less walking yesterday: 900 steps \(usually about 4,000\)/.test(t)));
  assert.ok(flags.some((t) => /Resting heart rate higher than usual.*80 bpm \(usually 65\)/.test(t)));
  assert.ok(!flags.some((t) => /No phone use yet today/.test(t)));
  h.clock.t += 90 * MIN;
  flags = (await famC.get(`/api/seniors/${seniorId}/insights`)).data.flags.map((f) => f.text);
  assert.ok(flags.some((t) => /No phone use yet today/.test(t)));
}));

test('no flags without enough history', () => withApp(async (h) => {
  const { famC, seniorId } = await h.setup();
  const ins = (await famC.get(`/api/seniors/${seniorId}/insights`)).data;
  assert.deepEqual(ins.flags, []);
  assert.equal(ins.typical.steps, null);
  assert.equal(ins.hasHealth, false);
}));

test('"Try the demo" logs in and seeds a sample person with history', () => withApp(async (h) => {
  const c = h.client();
  const r = await c.post('/api/demo/start');
  assert.equal(r.status, 200);
  const me = (await c.get('/api/me')).data.user;
  assert.equal(me.role, 'admin');
  const ins = (await c.get(`/api/seniors/${r.data.seniorId}/insights`)).data;
  assert.equal(ins.hasHealth, true);
  assert.ok(ins.typical.steps > 3000);
  assert.ok(ins.flags.some((f) => /Much less walking yesterday/.test(f.text)));
  const again = await h.client().post('/api/demo/start');
  assert.equal(again.data.seniorId, r.data.seniorId, 'does not seed twice');
  await c.post(`/api/demo/seniors/${r.data.seniorId}/fast-forward`, { hours: 6 });
  const reset = await c.post('/api/demo/reset');
  assert.equal(reset.status, 200);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM seniors').get().n, 1);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM calls WHERE ended_at IS NULL').get().n, 0, 'reset clears the open call');
}, { env: { DEMO_MODE: '1' } }));

test('demo start does not exist outside demo mode', () => withApp(async (h) => {
  assert.equal((await h.client().post('/api/demo/start')).status, 404);
}));
