// Haru backend: zero dependencies, Node 18+. Run: node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');

// ---------- tiny .env loader ----------
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n').forEach((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
} catch (_) { /* no .env, demo mode */ }

const env = (k, d = '') => process.env[k] || d;
const PORT = Number(env('PORT', 3000));
const INACTIVITY_MS = Number(env('INACTIVITY_MINUTES', 240)) * 60 * 1000;
const SENIOR = env('SENIOR_NAME', 'Soon-ja');
const FAMILY = env('FAMILY_NAME', 'Ji-woo');
const ADDRESS = env('HOME_ADDRESS', 'Gangnam-gu, Seoul');

// ---------- state (in memory, good enough for a demo) ----------
let offsetMs = 0; // simulated clock offset for "fast-forward"
const now = () => Date.now() + offsetMs;
let state;

function freshState() {
  offsetMs = 0;
  state = {
    senior: SENIOR,
    family: FAMILY,
    usualActiveBy: '8:00 AM',
    lastActive: now(),
    lastCheckin: null,
    status: 'ok', // ok | quiet | calling | concern | emergency
    statusText: 'Active as usual.',
    alert: null, // last Telegram text
    alertDelivered: null,
    feed: [
      { at: now() - 86400000 + 3600000 * 5, kind: 'ok', text: 'Haru check-in: feeling well, took medicine' },
    ],
  };
  log('ok', 'Phone used');
}

function log(kind, text) {
  state.feed.unshift({ at: now(), kind, text });
  state.feed = state.feed.slice(0, 30);
}

// ---------- inactivity check ----------
function checkInactivity() {
  if (['calling', 'emergency'].includes(state.status)) return;
  const idle = now() - state.lastActive;
  if (idle > INACTIVITY_MS) {
    state.status = 'calling';
    state.statusText = `No activity for ${Math.round(idle / 3600000)} hours. Haru is calling now.`;
    log('warn', 'No activity past usual window. Starting AI check-in call');
  }
}
setInterval(checkInactivity, 5000);

// ---------- classify the call ----------
const EMERGENCY = /\b(fell|fall|fallen|can'?t get up|help me|need help|chest|can'?t breathe|breathing|bleeding|ambulance|stroke)\b|넘어|도와|숨|가슴/i;
const CONCERN = /\b(dizzy|pain|hurt|sick|ache|didn'?t eat|haven'?t eaten|forgot (my )?(medicine|pills)|lonely|sad|tired|weak|confused)\b|어지|아파|외로/i;

function keywordClassify(userText) {
  if (!userText.trim()) return { status: 'no_answer', reason: 'No response from the senior.' };
  if (EMERGENCY.test(userText)) return { status: 'emergency', reason: 'Possible fall or medical emergency mentioned.' };
  if (CONCERN.test(userText)) return { status: 'concern', reason: 'Mentioned feeling unwell or a missed routine.' };
  return { status: 'ok', reason: 'Said they are fine.' };
}

async function llmClassify(transcript) {
  const key = env('OPENAI_API_KEY');
  if (!key) return null;
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: env('LLM_MODEL', 'gpt-4o-mini'),
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'You classify a wellness check-in call with an older adult living alone. Return JSON: ' +
              '{"status":"ok|concern|emergency|no_answer","reason":"short","location_in_home":"string or null",' +
              '"summary_for_family":"1-2 sentences"}. emergency = fall, cannot get up, chest pain, trouble breathing, ' +
              'bleeding, confusion, asks for help. concern = dizziness, pain, missed meals or medicine, low mood. ' +
              'no_answer = the senior never spoke. When unsure between levels, choose the more serious one.',
          },
          { role: 'user', content: transcript || '(no transcript)' },
        ],
      }),
    });
    const j = await r.json();
    return JSON.parse(j.choices[0].message.content);
  } catch (e) {
    console.warn('LLM classify failed, using keywords:', e.message);
    return null;
  }
}

// ---------- Telegram ----------
async function sendTelegram(text) {
  const token = env('TELEGRAM_BOT_TOKEN');
  const chat = env('TELEGRAM_CHAT_ID');
  if (!token || !chat) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    return r.ok;
  } catch (e) {
    console.warn('Telegram failed:', e.message);
    return false;
  }
}

const fmtTime = (ms) =>
  new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Seoul' });

async function handleCallResult({ transcript = '', userText = '' }) {
  const kw = keywordClassify(userText);
  let result = kw;
  if (kw.status !== 'no_answer') {
    const llm = await llmClassify(transcript);
    if (llm && llm.status) result = llm;
  }
  state.lastCheckin = now();
  const map = `https://maps.google.com/?q=${encodeURIComponent(ADDRESS)}`;
  const last = fmtTime(state.lastActive);
  const clean = (t) => String(t || '').replace(/[.\s]+$/, '');
  const where = result.location_in_home ? ` (${result.location_in_home})` : '';
  let alert = null;

  if (result.status === 'ok') {
    state.status = 'ok';
    state.statusText = `Haru checked in: ${result.summary_for_family || result.reason}`;
    state.lastActive = now();
    log('ok', `Haru check-in: ${result.summary_for_family || result.reason}`);
  } else if (result.status === 'concern') {
    state.status = 'concern';
    state.statusText = result.summary_for_family || result.reason;
    log('warn', `Haru: ${clean(result.summary_for_family || result.reason)}. Alert sent`);
    alert = `⚠️ <b>Check on ${SENIOR}</b>\n${result.summary_for_family || result.reason}\nLast active: ${last}`;
  } else if (result.status === 'emergency') {
    state.status = 'emergency';
    state.statusText = `${result.summary_for_family || result.reason} Call her now.`;
    log('bad', `Haru: ${clean(result.reason)}${where}. Urgent alert sent`);
    alert =
      `🚨 <b>URGENT: ${SENIOR} may need help</b>\n${result.summary_for_family || result.reason}${where}\n` +
      `Last active: ${last}\nHome: <a href="${map}">${ADDRESS}</a>\nIf you can't reach her, call 119 / 911.`;
  } else {
    state.status = 'emergency';
    state.statusText = 'Haru called with no answer. Check on her now.';
    log('bad', 'Haru: no answer to check-in call. Urgent alert sent');
    alert =
      `🚨 <b>URGENT: ${SENIOR} is not answering</b>\nNo phone activity since ${last} and no answer to Haru's check-in call.\n` +
      `Home: <a href="${map}">${ADDRESS}</a>\nIf you can't reach her, call 119 / 911.`;
  }

  if (alert) {
    state.alert = alert.replace(/<[^>]+>/g, '');
    state.alertDelivered = await sendTelegram(alert);
  }
  return result;
}

// ---------- HTTP ----------
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function body(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => {
      try { resolve(d ? JSON.parse(d) : {}); } catch (_) { resolve({}); }
    });
  });
}
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  if (req.method === 'GET' && url === '/api/config') {
    return json(res, 200, {
      vapiPublicKey: env('VAPI_PUBLIC_KEY'),
      vapiAssistantId: env('VAPI_ASSISTANT_ID'),
      telegram: !!(env('TELEGRAM_BOT_TOKEN') && env('TELEGRAM_CHAT_ID')),
      llm: !!env('OPENAI_API_KEY'),
    });
  }
  if (req.method === 'GET' && url === '/api/status') {
    checkInactivity();
    return json(res, 200, { ...state, now: now(), nowText: fmtTime(now()), lastActiveText: fmtTime(state.lastActive) });
  }
  if (req.method === 'POST' && url === '/api/heartbeat') {
    state.lastActive = now();
    if (state.status !== 'calling') { state.status = 'ok'; state.statusText = 'Active as usual.'; }
    log('ok', 'Phone used');
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url === '/api/fast-forward') {
    const { hours = 6 } = await body(req);
    offsetMs += hours * 3600000;
    checkInactivity();
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url === '/api/call-result') {
    const result = await handleCallResult(await body(req));
    return json(res, 200, result);
  }
  if (req.method === 'POST' && url === '/api/reset') {
    freshState();
    return json(res, 200, { ok: true });
  }
  // static files
  const file = path.join(__dirname, 'public', url === '/' ? 'index.html' : url);
  if (!file.startsWith(path.join(__dirname, 'public'))) return json(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

freshState();
server.listen(PORT, () => {
  console.log(`Haru running at http://localhost:${PORT}`);
  console.log(`  Voice (Vapi): ${env('VAPI_PUBLIC_KEY') && env('VAPI_ASSISTANT_ID') ? 'on' : 'demo buttons'}`);
  console.log(`  Telegram:     ${env('TELEGRAM_BOT_TOKEN') && env('TELEGRAM_CHAT_ID') ? 'on' : 'off (shown on dashboard only)'}`);
  console.log(`  LLM classify: ${env('OPENAI_API_KEY') ? 'on' : 'keyword rules'}`);
});
