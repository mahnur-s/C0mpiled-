// Config: .env loader plus typed settings. Real environment variables win over .env.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function loadDotEnv(file = path.join(ROOT, '.env')) {
  try {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line) => {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    });
  } catch (_) { /* no .env */ }
}

function loadConfig(e = process.env) {
  const get = (k, d = '') => (e[k] === undefined || e[k] === '' ? d : e[k]);
  const publicUrl = get('PUBLIC_URL', `http://localhost:${get('PORT', 3000)}`).replace(/\/+$/, '');
  return {
    port: Number(get('PORT', 3000)),
    publicUrl,
    secureCookies: publicUrl.startsWith('https://'),
    dbPath: get('DB_PATH', path.join(ROOT, 'data', 'haru.db')),
    demoMode: get('DEMO_MODE') === '1' || get('DEMO_MODE') === 'true',
    vapi: {
      privateKey: get('VAPI_PRIVATE_KEY'),
      assistantId: get('VAPI_ASSISTANT_ID'),
      phoneNumberId: get('VAPI_PHONE_NUMBER_ID'),
      webhookSecret: get('VAPI_WEBHOOK_SECRET'),
    },
    telegram: {
      token: get('TELEGRAM_BOT_TOKEN'),
      username: get('TELEGRAM_BOT_USERNAME').replace(/^@/, ''),
      webhookSecret: get('TELEGRAM_WEBHOOK_SECRET'),
    },
    openai: { key: get('OPENAI_API_KEY'), model: get('LLM_MODEL', 'gpt-4o-mini') },
    // Monitor timings (minutes). Overridable for testing; defaults are the pilot policy.
    timing: {
      tickSeconds: Number(get('MONITOR_TICK_SECONDS', 60)),
      callTimeoutMin: Number(get('CALL_TIMEOUT_MINUTES', 5)),
      retryAfterMin: Number(get('RETRY_AFTER_MINUTES', 10)),
      escalateAfterMin: Number(get('ESCALATE_AFTER_MINUTES', 15)),
      maxAlerts: Number(get('MAX_ALERTS_PER_INCIDENT', 4)),
    },
  };
}

// Problems that should be fixed before real seniors depend on this server.
function configWarnings(c) {
  const w = [];
  const v = c.vapi;
  if (!(v.privateKey && v.assistantId && v.phoneNumberId)) w.push('Vapi not configured: check-in calls cannot be placed' + (c.demoMode ? ' (demo mode uses simulated calls)' : ''));
  else if (!v.webhookSecret) w.push('VAPI_WEBHOOK_SECRET missing: Vapi webhooks are rejected, results only arrive via polling');
  if (!c.telegram.token) w.push('Telegram not configured: alerts are shown on the dashboard only');
  else if (!c.telegram.username) w.push('TELEGRAM_BOT_USERNAME missing: families cannot link Telegram');
  if (!c.openai.key) w.push('OpenAI not configured: calls are classified with keyword rules');
  if (!c.secureCookies && !c.demoMode) w.push('PUBLIC_URL is not https: fine locally, not for a real deployment');
  return w;
}

module.exports = { ROOT, loadDotEnv, loadConfig, configWarnings };
