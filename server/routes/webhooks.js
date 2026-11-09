// Inbound webhooks: Vapi call reports and Telegram bot updates. Both are authenticated by shared secrets.
const { HttpError } = require('../http');
const { safeEqual, sha256 } = require('../auth');
const { extractCall } = require('../providers/vapi');

module.exports = (app) => {
  const { router, db, config, monitor, telegram } = app;

  router.add('POST', '/api/webhooks/vapi', async ({ req, body }) => {
    const secret = config.vapi.webhookSecret;
    const given = req.headers['x-vapi-secret'] || (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!secret || !safeEqual(given, secret)) throw new HttpError(401, 'Bad secret');
    const msg = body.message || {};
    if (msg.type !== 'end-of-call-report') return { ok: true }; // status updates etc. are not needed
    const info = extractCall({ ...(msg.call || {}), artifact: msg.artifact, endedReason: msg.endedReason });
    if (!info.id) throw new HttpError(400, 'Missing call id');
    await monitor.onVapiReport(info.id, info);
  });

  async function handleTelegramUpdate(u) {
    if (u.message && typeof u.message.text === 'string') {
      const chatId = String(u.message.chat.id);
      const m = /^\/start\s+([A-Za-z0-9_-]{10,64})/.exec(u.message.text);
      if (!m) {
        return telegram.send(chatId, 'Hi! I send Haru alerts. To connect, use the "Connect Telegram" button on your Haru dashboard.');
      }
      const user = db.prepare('SELECT * FROM users WHERE telegram_link_token = ?').get(sha256(m[1]));
      if (!user) return telegram.send(chatId, 'That link has expired. Open your Haru dashboard and press "Connect Telegram" again.');
      db.prepare('UPDATE users SET telegram_chat_id = ?, telegram_link_token = NULL WHERE id = ?').run(chatId, user.id);
      return telegram.send(chatId, `✅ Connected, ${user.name}. Haru will message you here if your family member needs help.`);
    }
    if (u.callback_query) {
      const cq = u.callback_query;
      const chatId = String((cq.message && cq.message.chat.id) || cq.from.id);
      const m = /^ack:(\d+)$/.exec(cq.data || '');
      const user = db.prepare('SELECT * FROM users WHERE telegram_chat_id = ?').get(chatId);
      const inc = m && db.prepare('SELECT * FROM incidents WHERE id = ?').get(Number(m[1]));
      const allowed = user && inc && (user.role === 'admin'
        || db.prepare('SELECT 1 FROM family_links WHERE user_id = ? AND senior_id = ?').get(user.id, inc.senior_id));
      if (!allowed) return telegram.answerCallback(cq.id, 'Not allowed.');
      const done = await monitor.acknowledge(inc.id, user);
      return telegram.answerCallback(cq.id, done ? 'Thanks. Others have been told you are handling it.' : 'Already handled.');
    }
  }
  app.handleTelegramUpdate = handleTelegramUpdate;

  router.add('POST', '/api/webhooks/telegram', async ({ req, body }) => {
    if (!telegram.configured || !safeEqual(req.headers['x-telegram-bot-api-secret-token'] || '', telegram.webhookSecret)) {
      throw new HttpError(401, 'Bad secret');
    }
    await handleTelegramUpdate(body);
  });
};
