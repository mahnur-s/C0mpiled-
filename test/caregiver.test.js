// Medication, location and room-sensor features.
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

async function pair(h, adminC, seniorId, kind) {
  const { code } = (await adminC.post(`/api/admin/seniors/${seniorId}/pairing-code`)).data;
  const dev = h.client();
  const r = await dev.post('/api/device/pair', { code, kind, model: kind === 'room' ? 'Lenovo Tab' : 'Pixel' });
  assert.equal(r.data.kind, kind || 'phone');
  return async (body) => (await dev.post('/api/device/heartbeat', body, { Authorization: `Bearer ${r.data.token}` })).data;
}

const answer = (h, seniorId, userText) => {
  const call = h.calls(seniorId).at(-1);
  return h.app.monitor.finishCall(call.id, { transcript: userText ? `User: ${userText}` : '', userText });
};

// START is 10:00 in New York.
test('medication: reminders on the phone, taken / missed / confirmed on a call, history kept on edits', () => withApp(async (h) => {
  const { adminC, famC, seniorId } = await h.setup();
  const beat = await pair(h, adminC, seniorId);
  const add = (b) => famC.post(`/api/seniors/${seniorId}/meds`, b);

  assert.equal((await add({ name: 'Metformin', times: ['25:00'] })).status, 400);
  const met = (await add({ name: 'Metformin', dose: '500 mg', times: ['20:00', '10:30', '10:30'] })).data.id;
  const lis = (await add({ name: 'Lisinopril', dose: '10 mg', times: '11:00' })).data.id;
  await add({ name: 'Vitamin D', times: ['13:30'] });

  let r = await beat({});
  assert.deepEqual(r.meds.map((m) => [m.name, m.status]), [['Metformin', 'due']], '10:30 is due from 10:00; 11:00 not yet');
  const dueAt = r.meds[0].dueAt;
  r = await beat({ doses: [{ medicationId: met, dueAt, status: 'taken', at: h.now() }, { medicationId: met, dueAt: dueAt + 1, status: 'taken' }] });
  assert.deepEqual(r.meds, []);
  const row = h.db.prepare('SELECT * FROM med_doses WHERE medication_id = ?').get(met);
  assert.equal(row.status, 'taken');
  assert.equal(row.source, 'phone');

  // Lisinopril at 11:00 is never marked: family hears once after the 2-hour grace period.
  await h.advance(181); // 13:01
  const pills = h.telegram.sent.filter((m) => m.html.includes('Lisinopril'));
  assert.equal(pills.length, 1);
  assert.equal(pills[0].chatId, '1001');
  await h.advance(10);
  assert.equal(h.telegram.sent.filter((m) => m.html.includes('Lisinopril')).length, 1, 'told only once');

  // Asked on a call, she says she took her pills: the outstanding Vitamin D dose is marked taken.
  await famC.post(`/api/seniors/${seniorId}/call`);
  assert.match(h.vapi.started.at(-1).variables.meds, /^Vitamin D \(due 1:30 PM\)$/);
  await answer(h, seniorId, 'Yes dear, I took my pills after lunch.');
  const sum = (await famC.get(`/api/seniors/${seniorId}/meds`)).data;
  assert.deepEqual(sum.today.map((d) => [d.name, d.time, d.status]), [
    ['Metformin', '10:30', 'taken'], ['Lisinopril', '11:00', 'missed'], ['Vitamin D', '13:30', 'taken'], ['Metformin', '20:00', 'upcoming'],
  ]);
  assert.equal(sum.today[2].source, 'call');

  // A caregiver marks a dose; changing the times keeps today's history under the old schedule.
  assert.equal((await famC.post(`/api/seniors/${seniorId}/doses`, { medicationId: lis, dueAt: dueAt + 30 * MIN, status: 'taken' })).status, 200);
  const met2 = (await famC.put(`/api/seniors/${seniorId}/meds/${met}`, { name: 'Metformin', dose: '500 mg', times: ['21:00'] })).data.id;
  assert.notEqual(met2, met);
  const after = (await famC.get(`/api/seniors/${seniorId}/meds`)).data;
  assert.deepEqual(after.today.map((d) => [d.name, d.time, d.status]), [
    ['Metformin', '10:30', 'taken'], ['Lisinopril', '11:00', 'taken'], ['Vitamin D', '13:30', 'taken'], ['Metformin', '21:00', 'upcoming'],
  ]);
  assert.equal(after.medications.length, 3);

  // Other families can't touch it.
  const other = h.addUser({ email: 'x@example.com', name: 'X' });
  const otherC = await h.login(other);
  assert.equal((await otherC.post(`/api/seniors/${seniorId}/meds`, { name: 'A', times: ['08:00'] })).status, 404);
}));

test('location: home from the phone or the address, at home vs away', () => withApp(async (h) => {
  const { adminC, famC, seniorId } = await h.setup();
  const beat = await pair(h, adminC, seniorId);
  await beat({ locationAccess: true, location: { lat: 39.7817, lng: -89.6501, accuracy: 20, at: h.now() } });
  await beat({ location: { lat: 999, lng: 0 } });
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM locations').get().n, 1, 'bad point ignored');

  assert.equal((await famC.post(`/api/seniors/${seniorId}/home`, { source: 'phone' })).status, 403);
  assert.equal((await adminC.post(`/api/seniors/${seniorId}/home`, { source: 'phone' })).status, 200);
  let loc = (await famC.get(`/api/seniors/${seniorId}`)).data.location;
  assert.equal(loc.atHome, true);

  await h.advance(15);
  await beat({ location: { lat: 39.7917, lng: -89.6501, accuracy: 30, at: h.now() } });
  loc = (await famC.get(`/api/seniors/${seniorId}`)).data.location;
  assert.equal(loc.atHome, false);
  assert.ok(loc.distanceM > 1000 && loc.distanceM < 1200, String(loc.distanceM));
  assert.equal(loc.since, h.now());
}));

test('location: home from the address uses OpenStreetMap geocoding', () => withApp(async (h) => {
  const { adminC, seniorId } = await h.setup();
  assert.equal((await adminC.post(`/api/seniors/${seniorId}/home`, { source: 'address' })).status, 200);
  assert.equal(h.senior(seniorId).home_lat, 40.1);
  assert.equal(h.senior(seniorId).home_lng, -89.2);
}, {
  fetchImpl: async (url, opts) => {
    assert.match(String(url), /^https:\/\/nominatim\.openstreetmap\.org\/search\?format=json&limit=1&q=1%20Main%20St/);
    assert.match(opts.headers['User-Agent'], /Haru/);
    return { ok: true, json: async () => [{ lat: '40.1', lon: '-89.2' }] };
  },
}));

test('room sensor: movement is a sign of life; a possible fall calls at once, silence alerts with location', () => withApp(async (h) => {
  const { adminC, famC, seniorId } = await h.setup();
  const phone = await pair(h, adminC, seniorId);
  const room = await pair(h, adminC, seniorId, 'room');
  await phone({ locationAccess: true, location: { lat: 39.78, lng: -89.65, accuracy: 15, at: h.now() } });

  await h.advance(200);
  const slot = Math.floor((h.now() - 20 * MIN) / (15 * MIN)) * 15 * MIN;
  await room({ battery: 100, signals: { slots: [{ slot, motionMinutes: 6, motionPeak: 40, soundAvg: 22, soundPeak: 55 }, { slot: 'x' }] } });
  assert.equal(h.senior(seniorId).last_active, slot + 15 * MIN);
  await h.advance(100);
  assert.equal(h.calls(seniorId).length, 0, 'room movement reset the inactivity clock');

  await room({ signals: { events: [{ at: h.now(), kind: 'loud_impact', confidence: 0.9 }, { at: h.now(), kind: 'nonsense' }] } });
  assert.equal(h.calls(seniorId).length, 0, 'a thud alone is only noted');

  await phone({ location: { lat: 39.78, lng: -89.65, accuracy: 15, at: h.now() } });
  const fall = { at: h.now(), kind: 'possible_fall', confidence: 0.8 };
  await room({ signals: { events: [fall] } });
  await room({ signals: { events: [fall] } });
  assert.equal(h.calls(seniorId).length, 1, 'same event twice is one call');
  assert.equal(h.calls(seniorId)[0].reason, 'sensor');
  assert.match(h.vapi.started.at(-1).variables.why, /loud noise/);
  assert.ok(h.telegram.sent.some((m) => m.html.includes('heard what may have been a fall')));

  await answer(h, seniorId, '');
  const [inc] = h.incidents(seniorId);
  assert.equal(inc.level, 'emergency');
  const alert = h.telegram.sent.at(-1).html;
  assert.match(alert, /may have been a fall/);
  assert.match(alert, /open map/);

  const d = (await famC.get(`/api/seniors/${seniorId}`)).data;
  assert.equal(d.rooms.length, 1);
  assert.equal(d.device.model, 'Pixel', 'the phone, not the room sensor');
  assert.deepEqual(d.sensorEvents.map((e) => e.kind), ['possible_fall', 'loud_impact']);
}));

test('behaviour flags: restless night, staying in, missed doses, a thud', () => withApp(async (h) => {
  const { adminC, famC, seniorId } = await h.setup();
  await pair(h, adminC, seniorId, 'room');
  const DAY = 86400000;
  const slot = h.db.prepare('INSERT INTO room_slots (senior_id, slot, motion_minutes) VALUES (?, ?, ?)');
  const loc = h.db.prepare('INSERT INTO locations (senior_id, at, lat, lng, accuracy) VALUES (?, ?, ?, ?, 20)');
  h.db.prepare('UPDATE seniors SET home_lat = 39.78, home_lng = -89.65 WHERE id = ?').run(seniorId);
  const q = (ms) => Math.floor(ms / (15 * MIN)) * 15 * MIN;
  // START = 10:00 New York. Each past day: active morning, quiet night, and an outing except the last 3 days.
  for (let i = 1; i <= 10; i++) {
    const day10 = h.now() - i * DAY;
    for (let k = 0; k < 8; k++) slot.run(seniorId, q(day10 - 2 * 3600000 + k * 15 * MIN), 10); // 8-10 AM
    slot.run(seniorId, q(day10 - 7 * 3600000), 3); // 3 AM, a short bathroom trip
    for (let k = 0; k < 12; k++) {
      const out = i > 3 && k >= 4 && k < 8;
      loc.run(seniorId, day10 + k * 15 * MIN, out ? 39.80 : 39.78, -89.65);
    }
  }
  for (let k = 0; k < 6; k++) slot.run(seniorId, q(h.now() - 7 * 3600000 + k * 15 * MIN), 10); // last night: an hour up at 3 AM
  slot.run(seniorId, q(h.now() - 30 * MIN), 5);
  h.db.prepare('INSERT INTO sensor_events (senior_id, at, kind, confidence) VALUES (?, ?, ?, ?)').run(seniorId, h.now() - 5 * 3600000, 'loud_impact', 0.7);
  const med = h.db.prepare("INSERT INTO medications (senior_id, name, times, created_at) VALUES (?, 'Metformin', '08:00', ?)").run(seniorId, h.now() - 10 * DAY).lastInsertRowid;
  for (let i = 0; i <= 9; i++) { // missed yesterday and the day before
    const due = h.now() - i * DAY - 2 * 3600000;
    if (i === 0 || i > 2) h.db.prepare("INSERT INTO med_doses (medication_id, due_at, senior_id, status, at, source) VALUES (?, ?, ?, 'taken', ?, 'phone')").run(med, due, seniorId, due);
  }

  const ins = (await famC.get(`/api/seniors/${seniorId}/insights`)).data;
  const text = ins.flags.map((f) => f.text).join('\n');
  assert.match(text, /Restless night: 60 minutes/);
  assert.match(text, /hasn't left home in 3 days/);
  assert.match(text, /2 of \d+ medicine doses weren't marked taken/);
  assert.match(text, /loud thud/);
  assert.equal(ins.typical.nightMotion, 3);
  assert.equal(ins.typical.outings, 1);
  assert.equal(ins.hasRoom, true);
  assert.deepEqual(ins.week[6].room.slice(3, 5), [40, 20]);
}));
