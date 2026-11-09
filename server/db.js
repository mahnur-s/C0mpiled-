// SQLite via Node's built-in node:sqlite. Migrations are numbered by PRAGMA user_version.
const fs = require('fs');
const path = require('path');

// node:sqlite is stable enough for us but still prints an ExperimentalWarning on load.
const emit = process.emitWarning;
process.emitWarning = (w, ...a) => (String(w).includes('SQLite') ? undefined : emit.call(process, w, ...a));
const { DatabaseSync } = require('node:sqlite');
process.emitWarning = emit;

const MIGRATIONS = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    password_hash TEXT,
    role TEXT NOT NULL CHECK (role IN ('admin', 'family')),
    telegram_chat_id TEXT,
    telegram_link_token TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE seniors (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    timezone TEXT NOT NULL,
    address TEXT NOT NULL DEFAULT '',
    inactivity_minutes INTEGER NOT NULL DEFAULT 240,
    quiet_start TEXT NOT NULL DEFAULT '22:00',
    quiet_end TEXT NOT NULL DEFAULT '07:00',
    consent_at INTEGER,
    phase TEXT NOT NULL DEFAULT 'watching',
    retry_at INTEGER,
    last_active INTEGER,
    watch_from INTEGER NOT NULL,
    last_checkin INTEGER,
    paused_until INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE family_links (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    senior_id INTEGER NOT NULL REFERENCES seniors(id) ON DELETE CASCADE,
    relationship TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (user_id, senior_id)
  );
  CREATE TABLE invites (
    token_hash TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    name TEXT NOT NULL,
    relationship TEXT NOT NULL DEFAULT '',
    senior_id INTEGER NOT NULL REFERENCES seniors(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  CREATE TABLE pairing_codes (
    code TEXT PRIMARY KEY,
    senior_id INTEGER NOT NULL REFERENCES seniors(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE devices (
    id INTEGER PRIMARY KEY,
    senior_id INTEGER NOT NULL REFERENCES seniors(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    model TEXT NOT NULL DEFAULT '',
    app_version TEXT NOT NULL DEFAULT '',
    battery INTEGER,
    usage_access INTEGER,
    last_seen INTEGER,
    silence_noted_at INTEGER,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
  );
  CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    senior_id INTEGER NOT NULL REFERENCES seniors(id) ON DELETE CASCADE,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('ok', 'warn', 'bad')),
    text TEXT NOT NULL
  );
  CREATE INDEX events_by_senior ON events (senior_id, at DESC);
  CREATE TABLE calls (
    id INTEGER PRIMARY KEY,
    senior_id INTEGER NOT NULL REFERENCES seniors(id) ON DELETE CASCADE,
    vapi_call_id TEXT UNIQUE,
    attempt INTEGER NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('inactivity', 'manual')),
    requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    ended_reason TEXT,
    transcript TEXT,
    outcome TEXT,
    summary TEXT
  );
  CREATE INDEX calls_by_senior ON calls (senior_id, started_at DESC);
  CREATE TABLE incidents (
    id INTEGER PRIMARY KEY,
    senior_id INTEGER NOT NULL REFERENCES seniors(id) ON DELETE CASCADE,
    level TEXT NOT NULL CHECK (level IN ('concern', 'emergency')),
    summary TEXT NOT NULL,
    alert_text TEXT NOT NULL,
    opened_at INTEGER NOT NULL,
    last_alert_at INTEGER NOT NULL,
    alert_count INTEGER NOT NULL DEFAULT 1,
    delivered_count INTEGER NOT NULL DEFAULT 0,
    acked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    acked_at INTEGER,
    resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    resolved_at INTEGER
  );
  CREATE INDEX incidents_open ON incidents (senior_id, resolved_at);
  `,
  // 2: activity patterns (15-minute slots with phone use) and daily health from Health Connect.
  `
  CREATE TABLE activity_slots (
    senior_id INTEGER NOT NULL REFERENCES seniors(id) ON DELETE CASCADE,
    slot INTEGER NOT NULL,
    PRIMARY KEY (senior_id, slot)
  ) WITHOUT ROWID;
  CREATE TABLE health_daily (
    senior_id INTEGER NOT NULL REFERENCES seniors(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    steps INTEGER,
    resting_hr INTEGER,
    avg_hr INTEGER,
    min_hr INTEGER,
    max_hr INTEGER,
    sleep_minutes INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (senior_id, day)
  ) WITHOUT ROWID;
  ALTER TABLE seniors ADD COLUMN latest_hr INTEGER;
  ALTER TABLE seniors ADD COLUMN latest_hr_at INTEGER;
  ALTER TABLE devices ADD COLUMN health_access INTEGER;
  `,
  // 3: caregiver features. Medication schedules and doses, phone location, and a room sensor
  // (spare phone/tablet: camera motion + microphone sound, analysed on the device; only numbers arrive here).
  `
  CREATE TABLE medications (
    id INTEGER PRIMARY KEY,
    senior_id INTEGER NOT NULL REFERENCES seniors(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    dose TEXT NOT NULL DEFAULT '',
    times TEXT NOT NULL,
    instructions TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    stopped_at INTEGER
  );
  CREATE TABLE med_doses (
    medication_id INTEGER NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
    due_at INTEGER NOT NULL,
    senior_id INTEGER NOT NULL REFERENCES seniors(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('taken', 'skipped', 'missed')),
    at INTEGER NOT NULL,
    source TEXT NOT NULL,
    by_user INTEGER REFERENCES users(id) ON DELETE SET NULL,
    PRIMARY KEY (medication_id, due_at)
  ) WITHOUT ROWID;
  CREATE INDEX med_doses_by_senior ON med_doses (senior_id, due_at);
  CREATE TABLE locations (
    senior_id INTEGER NOT NULL REFERENCES seniors(id) ON DELETE CASCADE,
    at INTEGER NOT NULL,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    accuracy REAL,
    PRIMARY KEY (senior_id, at)
  ) WITHOUT ROWID;
  CREATE TABLE room_slots (
    senior_id INTEGER NOT NULL REFERENCES seniors(id) ON DELETE CASCADE,
    slot INTEGER NOT NULL,
    motion_minutes INTEGER NOT NULL,
    motion_peak INTEGER,
    sound_avg INTEGER,
    sound_peak INTEGER,
    PRIMARY KEY (senior_id, slot)
  ) WITHOUT ROWID;
  CREATE TABLE sensor_events (
    id INTEGER PRIMARY KEY,
    senior_id INTEGER NOT NULL REFERENCES seniors(id) ON DELETE CASCADE,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    confidence REAL,
    UNIQUE (senior_id, kind, at)
  );
  ALTER TABLE seniors ADD COLUMN home_lat REAL;
  ALTER TABLE seniors ADD COLUMN home_lng REAL;
  ALTER TABLE seniors ADD COLUMN home_radius_m INTEGER NOT NULL DEFAULT 150;
  ALTER TABLE seniors ADD COLUMN med_grace_minutes INTEGER NOT NULL DEFAULT 120;
  ALTER TABLE devices ADD COLUMN kind TEXT NOT NULL DEFAULT 'phone';
  ALTER TABLE devices ADD COLUMN location_access INTEGER;
  CREATE TABLE calls_v3 (
    id INTEGER PRIMARY KEY,
    senior_id INTEGER NOT NULL REFERENCES seniors(id) ON DELETE CASCADE,
    vapi_call_id TEXT UNIQUE,
    attempt INTEGER NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('inactivity', 'manual', 'sensor')),
    requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    ended_reason TEXT,
    transcript TEXT,
    outcome TEXT,
    summary TEXT
  );
  INSERT INTO calls_v3 SELECT * FROM calls;
  DROP TABLE calls;
  ALTER TABLE calls_v3 RENAME TO calls;
  CREATE INDEX calls_by_senior ON calls (senior_id, started_at DESC);
  `,
];

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return db;
}

// Run fn inside a transaction; nested calls join the outer one. fn must be synchronous.
const depth = new WeakMap();
function tx(db, fn) {
  const d = depth.get(db) || 0;
  if (d > 0) return fn();
  db.exec('BEGIN');
  depth.set(db, 1);
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    depth.set(db, 0);
  }
}

module.exports = { openDb, tx };
