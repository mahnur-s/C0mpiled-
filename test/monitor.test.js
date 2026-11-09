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

const answer = (h, seniorId, userText) => {
  const call = h.calls(seniorId).at(-1);
  return h.app.monitor.finishCall(call.id, { transcript: userText ? `User: ${userText}` : '', userText });
};

test('activity within the threshold never triggers a call', () => withApp(async (h) => {
  const { seniorId } = await h.setup();
  await h.advance(200);
  h.app.monitor.recordActivity(seniorId, h.now());
  await h.advance(200);
  assert.equal(h.calls(seniorId).length, 0);
  assert.equal(h.senior(seniorId).phase, 'watching');
}));

test('idle past threshold calls; "I\'m fine" logs a check-in and resets the clock', () => withApp(async (h) => {
  const { seniorId } = await h.setup();
  await h.advance(241);
  assert.equal(h.senior(seniorId).phase, 'calling');
  assert.equal(h.vapi.started.length, 1);
  assert.equal(h.vapi.started[0].phone, '+14155550100');
  assert.deepEqual(h.vapi.started[0].variables, { name: 'Margaret', family: 'Jane' });

  await answer(h, seniorId, "I'm fine, just napping");
  const s = h.senior(seniorId);
  assert.equal(s.phase, 'watching');
  assert.equal(s.last_checkin, h.now());
  assert.equal(h.incidents(seniorId).length, 0);
  assert.equal(h.telegram.sent.length, 0);
  await h.advance(60); // no immediate second call
  assert.equal(h.calls(seniorId).length, 1);
}));

test('emergency answer opens an incident and alerts family on Telegram', () => withApp(async (h) => {
  const { seniorId } = await h.setup();
  await h.advance(241);
  await answer(h, seniorId, "I fell in the bathroom and can't get up");
  const [inc] = h.incidents(seniorId);
  assert.equal(inc.level, 'emergency');
  assert.equal(inc.delivered_count, 1);
  assert.equal(h.telegram.sent.length, 1);
  const msg = h.telegram.sent[0];
  assert.equal(msg.chatId, '1001');
  assert.match(msg.html, /URGENT: Margaret may need help/);
  assert.match(msg.html, /\+14155550100/);
  assert.match(msg.html, /911/);
  assert.equal(msg.buttons[0].callback_data, `ack:${inc.id}`);
}));

test('concern answer alerts without 911 language and does not escalate', () => withApp(async (h) => {
  const { seniorId } = await h.setup();
  await h.advance(241);
  await answer(h, seniorId, 'I feel a bit dizzy today');
  assert.equal(h.incidents(seniorId)[0].level, 'concern');
  assert.doesNotMatch(h.telegram.sent[0].html, /911/);
  await h.advance(60);
  assert.equal(h.telegram.sent.length, 1);
}));

test('no answer retries once, then raises an emergency', () => withApp(async (h) => {
  const { seniorId } = await h.setup();
  await h.advance(241);
  await answer(h, seniorId, '');
  assert.equal(h.senior(seniorId).phase, 'retry');
  assert.equal(h.incidents(seniorId).length, 0);
  await h.advance(5);
  assert.equal(h.calls(seniorId).length, 1, 'waits for the retry time');
  await h.advance(6);
  assert.equal(h.calls(seniorId).length, 2);
  assert.equal(h.calls(seniorId)[1].attempt, 2);
  await answer(h, seniorId, '');
  const [inc] = h.incidents(seniorId);
  assert.equal(inc.level, 'emergency');
  assert.match(h.telegram.sent[0].html, /Margaret is not answering/);
  assert.equal(h.senior(seniorId).phase, 'watching');
}));

test('a lost webhook times out and counts as no answer', () => withApp(async (h) => {
  const { seniorId } = await h.setup();
  await h.advance(241);
  await h.advance(4);
  assert.equal(h.senior(seniorId).phase, 'calling');
  await h.advance(2);
  assert.equal(h.senior(seniorId).phase, 'retry');
  assert.match(h.calls(seniorId)[0].ended_reason, /timeout/);
}));

test('a call that cannot be placed is treated as no answer, never silently dropped', () => withApp(async (h) => {
  const { seniorId } = await h.setup();
  h.vapi.failNext = new Error('Vapi HTTP 500');
  await h.advance(241);
  assert.equal(h.senior(seniorId).phase, 'retry');
  h.vapi.failNext = new Error('Vapi HTTP 500');
  await h.advance(11);
  assert.equal(h.incidents(seniorId)[0].level, 'emergency');
  assert.ok(h.events(seniorId).some((e) => /could not be completed/.test(e)));
}));

test('quiet hours defer the call until they end', () => withApp(async (h) => {
  // Start at 10:00 New York; threshold 13h puts the deadline at 23:00, inside 22:00-07:00.
  const { seniorId } = await h.setup({ inactivityMinutes: 13 * 60 });
  await h.advance(13 * 60 + 1);
  assert.equal(h.senior(seniorId).phase, 'quiet');
  assert.equal(h.calls(seniorId).length, 0);
  await h.advance(7 * 60); // 06:01
  assert.equal(h.calls(seniorId).length, 0);
  await h.advance(60); // 07:01
  assert.equal(h.calls(seniorId).length, 1);
}));

test('activity during quiet hours cancels the pending call', () => withApp(async (h) => {
  const { seniorId } = await h.setup({ inactivityMinutes: 13 * 60 });
  await h.advance(13 * 60 + 1);
  h.app.monitor.recordActivity(seniorId, h.now());
  assert.equal(h.senior(seniorId).phase, 'watching');
  await h.advance(9 * 60);
  assert.equal(h.calls(seniorId).length, 0);
}));

test('paused seniors are not called, and resume with a fresh window', () => withApp(async (h) => {
  const { seniorId, famC } = await h.setup();
  const r = await famC.post(`/api/seniors/${seniorId}/pause`, { until: h.now() + 24 * 60 * MIN });
  assert.equal(r.status, 200);
  await h.advance(24 * 60 + 1);
  assert.equal(h.calls(seniorId).length, 0);
  assert.equal(h.senior(seniorId).paused_until, null);
  await h.advance(200);
  assert.equal(h.calls(seniorId).length, 0);
  await h.advance(45);
  assert.equal(h.calls(seniorId).length, 1);
}));

test('unacknowledged emergencies are re-sent, capped, and stop once acknowledged', () => withApp(async (h) => {
  const { seniorId, fam } = await h.setup();
  await h.advance(241);
  await answer(h, seniorId, 'help me, I fell');
  await h.advance(16);
  assert.equal(h.telegram.sent.length, 2);
  assert.match(h.telegram.sent[1].html, /Reminder 2 of 4/);
  await h.advance(16);
  assert.equal(h.telegram.sent.length, 3);
  const inc = h.incidents(seniorId)[0];
  await h.app.monitor.acknowledge(inc.id, { id: fam.id, name: fam.name });
  await h.advance(60);
  assert.equal(h.telegram.sent.length, 3);
  assert.ok(h.events(seniorId).includes('Jane is handling the alert.'));
}));

test('alerts that reach nobody are logged loudly', () => withApp(async (h) => {
  const { seniorId, fam } = await h.setup();
  h.db.prepare('UPDATE users SET telegram_chat_id = NULL WHERE id = ?').run(fam.id);
  await h.advance(241);
  await answer(h, seniorId, 'I fell');
  assert.ok(h.events(seniorId).some((e) => /Alert NOT sent: no family member has connected Telegram/.test(e)));
  h.db.prepare("UPDATE users SET telegram_chat_id = '1001' WHERE id = ?").run(fam.id);
  h.telegram.deliver = false;
  await h.advance(16);
  assert.ok(h.events(seniorId).some((e) => /Alert NOT delivered/.test(e)));
}));

test('emergencies also reach admins who linked Telegram', () => withApp(async (h) => {
  const { seniorId, admin } = await h.setup();
  h.db.prepare("UPDATE users SET telegram_chat_id = '9999' WHERE id = ?").run(admin.id);
  await h.advance(241);
  await answer(h, seniorId, 'I fell');
  assert.deepEqual(h.telegram.sent.map((m) => m.chatId).sort(), ['1001', '9999']);
}));

test('manual "Call now" that goes unanswered does not escalate', () => withApp(async (h) => {
  const { seniorId, famC } = await h.setup();
  assert.equal((await famC.post(`/api/seniors/${seniorId}/call`)).status, 200);
  assert.equal((await famC.post(`/api/seniors/${seniorId}/call`)).status, 409);
  await answer(h, seniorId, '');
  assert.equal(h.senior(seniorId).phase, 'watching');
  assert.equal(h.incidents(seniorId).length, 0);
}));

test('alert text escapes HTML in names and addresses', () => withApp(async (h) => {
  const { seniorId } = await h.setup({ name: 'Bob <b>x</b>', address: '<script>' });
  await h.advance(241);
  await answer(h, seniorId, 'I fell');
  const html = h.telegram.sent[0].html;
  assert.ok(html.includes('Bob &lt;b&gt;x&lt;/b&gt;'));
  assert.ok(!html.includes('<script>'));
}));

test('device silence is noted once in the feed and included in alerts', () => withApp(async (h) => {
  const { seniorId } = await h.setup();
  h.db.prepare('INSERT INTO devices (senior_id, token_hash, battery, last_seen, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(seniorId, 'x', 7, h.now(), h.now());
  await h.advance(121);
  await h.advance(30);
  assert.equal(h.events(seniorId).filter((e) => /hasn't heard from the phone/.test(e)).length, 1);
  await h.advance(100);
  await answer(h, seniorId, 'I fell');
  assert.match(h.telegram.sent[0].html, /battery 7%/);
}));

test('the LLM result is used when available', () => withApp(async (h) => {
  const { seniorId } = await h.setup();
  await h.advance(241);
  await answer(h, seniorId, 'I am alright but I slipped on the stairs earlier');
  assert.equal(h.incidents(seniorId)[0].level, 'emergency');
  assert.match(h.incidents(seniorId)[0].summary, /slipped on the stairs/);
}, {
  env: { OPENAI_API_KEY: 'sk-test' },
  fetchImpl: async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({
      status: 'emergency', reason: 'fall', location_in_home: 'stairs', summary_for_family: 'Margaret slipped on the stairs earlier.',
    }) } }] }),
  }),
}));
