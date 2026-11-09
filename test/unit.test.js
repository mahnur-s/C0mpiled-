const test = require('node:test');
const assert = require('node:assert/strict');
const { keywordClassify, classifyCall } = require('../server/classify');
const { inQuietHours } = require('../server/time');
const { extractCall } = require('../server/providers/vapi');
const { hashPassword, verifyPassword } = require('../server/auth');

test('keyword classification', () => {
  assert.equal(keywordClassify('').status, 'no_answer');
  assert.equal(keywordClassify("I fell and I can't get up").status, 'emergency');
  assert.equal(keywordClassify('I feel dizzy').status, 'concern');
  assert.equal(keywordClassify('넘어졌어요').status, 'emergency');
  assert.equal(keywordClassify("I'm fine, thanks").status, 'ok');
});

test('LLM failures fall back to keywords; silence never reaches the LLM', async () => {
  let called = 0;
  const failing = async () => { called++; throw new Error('down'); };
  const r = await classifyCall({ transcript: 'User: I fell', userText: 'I fell' }, { key: 'k', model: 'm' }, failing);
  assert.equal(r.status, 'emergency');
  assert.equal(r.source, 'keywords');
  const bogus = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"status":"great"}' } }] }) });
  assert.equal((await classifyCall({ userText: 'I fell' }, { key: 'k', model: 'm' }, bogus)).source, 'keywords');
  called = 0;
  assert.equal((await classifyCall({ userText: '' }, { key: 'k', model: 'm' }, failing)).status, 'no_answer');
  assert.equal(called, 0);
});

test('quiet hours across midnight, in the senior timezone', () => {
  const ny = 'America/New_York';
  assert.equal(inQuietHours(Date.UTC(2026, 10, 11, 4, 0), ny, '22:00', '07:00'), true); // 23:00 NY
  assert.equal(inQuietHours(Date.UTC(2026, 10, 11, 11, 59), ny, '22:00', '07:00'), true); // 06:59
  assert.equal(inQuietHours(Date.UTC(2026, 10, 11, 12, 0), ny, '22:00', '07:00'), false); // 07:00
  assert.equal(inQuietHours(Date.UTC(2026, 10, 11, 15, 0), ny, '13:00', '14:00'), false); // 10:00
  assert.equal(inQuietHours(Date.UTC(2026, 10, 11, 18, 30), ny, '13:00', '14:00'), true); // 13:30
  assert.equal(inQuietHours(Date.UTC(2026, 10, 11, 18, 30), ny, '00:00', '00:00'), false);
});

test('extractCall reads user speech from Vapi messages', () => {
  const r = extractCall({
    id: 'c1', status: 'ended', endedReason: 'customer-ended-call',
    artifact: { transcript: 'AI: hi\nUser: fine', messages: [{ role: 'system', message: 'x' }, { role: 'bot', message: 'hi' }, { role: 'user', message: 'fine' }] },
  });
  assert.deepEqual(r, { id: 'c1', status: 'ended', endedReason: 'customer-ended-call', transcript: 'AI: hi\nUser: fine', userText: 'fine' });
  assert.equal(extractCall({ id: 'c2', messages: [] }).userText, '');
});

test('password hashing', () => {
  const h = hashPassword('correct horse battery');
  assert.equal(verifyPassword('correct horse battery', h), true);
  assert.equal(verifyPassword('wrong', h), false);
  assert.equal(verifyPassword('x', null), false);
});
