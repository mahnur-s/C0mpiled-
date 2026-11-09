// Entry point: load config, open the database, pick real or simulated providers, start serving.
const { loadDotEnv, loadConfig, configWarnings } = require('./config');
const { openDb } = require('./db');
const { createApp } = require('./app');
const { createVapi, createFakeVapi } = require('./providers/vapi');
const { createTelegram } = require('./providers/telegram');
const { randomToken, hashPassword } = require('./auth');

loadDotEnv();
const config = loadConfig();
const db = openDb(config.dbPath);

let vapi = createVapi(config.vapi, config.publicUrl);
if (!vapi.configured && config.demoMode) vapi = createFakeVapi();
const telegram = createTelegram(config.telegram);

const app = createApp({ config, db, vapi, telegram });

app.server.listen(config.port, async () => {
  console.log(`Haru running at http://localhost:${config.port} (public URL ${config.publicUrl})`);
  console.log(`  Calls:     ${vapi.simulated ? 'simulated (demo mode)' : vapi.configured ? 'Vapi' : 'NOT CONFIGURED'}`);
  console.log(`  Telegram:  ${telegram.configured ? `@${telegram.username || '?'}` : 'off'}`);
  console.log(`  Classify:  ${config.openai.key ? `OpenAI ${config.openai.model}` : 'keyword rules'}`);
  console.log(`  Database:  ${config.dbPath}`);
  for (const w of configWarnings(config)) console.warn(`  ! ${w}`);
  if (!db.prepare("SELECT 1 FROM users WHERE role = 'admin'").get()) {
    if (config.demoMode) {
      // Local demo convenience only: a ready-to-use admin, password shown once in this console.
      const password = randomToken(9);
      db.prepare("INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?, 'Demo Admin', ?, 'admin', ?)")
        .run('admin@haru.local', hashPassword(password), Date.now());
      console.log(`\n  Demo admin created. Log in with  admin@haru.local  /  ${password}\n`);
    } else {
      console.warn('  ! No admin account yet. Create one with: node scripts/create-admin.js you@example.com "Your Name"');
    }
  }
  await app.startBackground();
});

const shutdown = () => {
  app.stopBackground();
  app.server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
