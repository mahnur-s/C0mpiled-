// Telegram Bot API: send alerts with an "I'm on it" button, receive updates by webhook (https) or polling (local).
const crypto = require('crypto');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function createTelegram({ token, username, webhookSecret }, fetchImpl = fetch) {
  const configured = !!token;
  // Telegram echoes this back on every webhook call; derive a stable one from the token if none was set.
  webhookSecret = webhookSecret || (token ? crypto.createHash('sha256').update(token).digest('hex') : '');
  const api = async (method, body, timeoutMs = 20000) => {
    const r = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(`Telegram ${method}: ${j.description || r.status}`);
    return j.result;
  };

  async function send(chatId, html, buttons) {
    try {
      await api('sendMessage', {
        chat_id: chatId,
        text: html,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...(buttons ? { reply_markup: { inline_keyboard: [buttons] } } : {}),
      });
      return true;
    } catch (e) {
      console.warn('Telegram send failed:', e.message);
      return false;
    }
  }

  const answerCallback = (id, text) => api('answerCallbackQuery', { callback_query_id: id, text }).catch(() => {});

  // Webhook when we have a public https URL, otherwise long polling so local development works too.
  async function startUpdates(publicUrl, onUpdate) {
    if (!configured) return () => {};
    if (publicUrl.startsWith('https://')) {
      await api('setWebhook', {
        url: `${publicUrl}/api/webhooks/telegram`,
        secret_token: webhookSecret,
        allowed_updates: ['message', 'callback_query'],
      }).catch((e) => console.warn('Telegram setWebhook failed:', e.message));
      return () => {};
    }
    let stopped = false;
    let offset = 0;
    await api('deleteWebhook', {}).catch(() => {});
    (async () => {
      while (!stopped) {
        try {
          const updates = await api('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, 35000);
          for (const u of updates) {
            offset = u.update_id + 1;
            await onUpdate(u).catch((e) => console.warn('Telegram update failed:', e.message));
          }
        } catch (e) {
          if (!stopped) await new Promise((r) => setTimeout(r, 5000));
        }
      }
    })();
    return () => { stopped = true; };
  }

  return { configured, username, webhookSecret, send, answerCallback, startUpdates };
}

function createFakeTelegram() {
  const sent = [];
  return {
    configured: true,
    username: 'haru_test_bot',
    webhookSecret: 'tg-secret',
    sent,
    deliver: true,
    async send(chatId, html, buttons) {
      sent.push({ chatId, html, buttons });
      return this.deliver;
    },
    async answerCallback() {},
    async startUpdates() { return () => {}; },
  };
}

module.exports = { createTelegram, createFakeTelegram, esc };
