// Vapi outbound phone calls. API: POST /call to start, GET /call/:id to poll.
const API = 'https://api.vapi.ai';

// Pull what we need out of a Vapi call object or end-of-call report, tolerating shape differences.
function extractCall(obj = {}) {
  const artifact = obj.artifact || {};
  const messages = artifact.messages || obj.messages || [];
  const said = (role) => messages.filter((m) => m.role === role).map((m) => m.message || m.content || '').join(' ').trim();
  return {
    id: obj.id || (obj.call && obj.call.id) || null,
    status: obj.status || null,
    endedReason: obj.endedReason || null,
    transcript: artifact.transcript || obj.transcript || '',
    userText: said('user'),
  };
}

function createVapi({ privateKey, assistantId, phoneNumberId, webhookSecret }, publicUrl, fetchImpl = fetch) {
  const configured = !!(privateKey && assistantId && phoneNumberId);
  const headers = { Authorization: `Bearer ${privateKey}`, 'Content-Type': 'application/json' };

  async function startCall({ phone, variables }) {
    const server = { url: `${publicUrl}/api/webhooks/vapi` };
    // Vapi does not attach org credentials to a per-call server URL, so send our secret as a header.
    if (webhookSecret) server.headers = { 'X-Vapi-Secret': webhookSecret };
    const r = await fetchImpl(`${API}/call`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(20000),
      body: JSON.stringify({
        assistantId,
        phoneNumberId,
        customer: { number: phone },
        assistantOverrides: { variableValues: variables, server },
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.id) throw new Error(`Vapi HTTP ${r.status}: ${j.message || JSON.stringify(j).slice(0, 200)}`);
    return { id: j.id };
  }

  async function getCall(id) {
    const r = await fetchImpl(`${API}/call/${encodeURIComponent(id)}`, { headers, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`Vapi HTTP ${r.status}`);
    return extractCall(await r.json());
  }

  return { configured, simulated: false, startCall, getCall };
}

// Demo/test stand-in: calls "ring" until something posts a simulated result.
function createFakeVapi() {
  let n = 0;
  const started = [];
  return {
    configured: true,
    simulated: true,
    started,
    failNext: null,
    async startCall(args) {
      if (this.failNext) {
        const e = this.failNext;
        this.failNext = null;
        throw e;
      }
      const id = `fake-call-${Date.now()}-${++n}`;
      started.push({ id, ...args });
      return { id };
    },
    async getCall(id) {
      return { id, status: 'in-progress', endedReason: null, transcript: '', userText: '' };
    },
  };
}

module.exports = { createVapi, createFakeVapi, extractCall };
