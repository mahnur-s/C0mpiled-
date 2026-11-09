// Wires config, database, providers, monitor and routes into an http.Server.
const http = require('http');
const path = require('path');
const { HttpError, json, readBody, parseCookies, Router, serveStatic } = require('./http');
const { COOKIE, sessionUser } = require('./auth');
const { classifyCall } = require('./classify');
const { createMonitor } = require('./monitor');
const { ROOT } = require('./config');

const PUBLIC_DIR = path.join(ROOT, 'public');

function createApp({ config, db, vapi, telegram, now = Date.now, fetchImpl = fetch }) {
  const classify = (call) => classifyCall(call, config.openai, fetchImpl);
  const monitor = createMonitor({ db, config, now, vapi, telegram, classify });
  const router = new Router();
  const app = { config, db, now, vapi, telegram, monitor, router };

  require('./routes/auth')(app);
  require('./routes/family')(app);
  require('./routes/admin')(app);
  require('./routes/device')(app);
  require('./routes/webhooks')(app);
  if (config.demoMode) require('./routes/demo')(app);

  router.add('GET', '/healthz', () => {
    const stale = now() - monitor.lastTickAt() > Math.max(180000, config.timing.tickSeconds * 3000);
    if (stale) throw new HttpError(503, 'monitor loop is not running');
    db.prepare('SELECT 1').get();
    return { ok: true };
  });

  // Same-origin check for cookie-authenticated writes (SameSite=Lax already blocks most CSRF).
  const allowedOrigins = new Set([config.publicUrl]);
  function checkOrigin(req) {
    const origin = req.headers.origin;
    if (!origin || ['GET', 'HEAD'].includes(req.method)) return;
    const proto = req.headers['x-forwarded-proto'] || (config.secureCookies ? 'https' : 'http');
    if (!allowedOrigins.has(origin) && origin !== `${proto}://${req.headers.host}`) throw new HttpError(403, 'Bad origin');
  }

  const server = http.createServer(async (req, res) => {
    const [pathname, search = ''] = req.url.split('?');
    try {
      if (!pathname.startsWith('/api/') && pathname !== '/healthz') {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
        return serveStatic(PUBLIC_DIR, pathname, res);
      }
      const m = router.match(req.method, pathname);
      if (!m) throw new HttpError(404, 'Not found');
      const cookies = parseCookies(req);
      if (cookies[COOKIE]) checkOrigin(req);
      const ctx = {
        req,
        res,
        params: m.params,
        query: Object.fromEntries(new URLSearchParams(search)),
        body: ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readBody(req) : {},
        user: sessionUser(db, cookies[COOKIE], now()),
      };
      const out = await m.handler(ctx);
      if (!res.headersSent) json(res, 200, out === undefined ? { ok: true } : out);
    } catch (e) {
      if (res.headersSent) return;
      if (e instanceof HttpError) return json(res, e.status, { error: e.message });
      console.error(`${req.method} ${pathname} failed:`, e);
      json(res, 500, { error: 'Something went wrong on the server.' });
    }
  });

  let stopUpdates = () => {};
  app.server = server;
  app.startBackground = async () => {
    monitor.start();
    stopUpdates = await telegram.startUpdates(config.publicUrl, (u) => app.handleTelegramUpdate(u));
  };
  app.stopBackground = () => {
    monitor.stop();
    stopUpdates();
  };
  return app;
}

module.exports = { createApp };
