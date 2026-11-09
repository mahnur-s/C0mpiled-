// Demo data: one sample person with two weeks of believable routine, health and history.
// Only used when DEMO_MODE=1. Deterministic, so the demo looks the same every time.
const { hashPassword, randomToken, sha256 } = require('./auth');
const { dayKey, localToEpoch } = require('./time');
const { SLOT_MS } = require('./health');

const DEMO_EMAIL = 'demo@haru.local';

function rng(seed) {
  let x = seed;
  return () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
}

// Calendar date i days before today in tz (stepping by 24h would repeat a day around DST changes).
function daysAgo(now, i, tz) {
  const d = new Date(`${dayKey(now, tz)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - i);
  return d.toISOString().slice(0, 10);
}

function ensureDemoUser(db, now) {
  let u = db.prepare('SELECT * FROM users WHERE email = ?').get(DEMO_EMAIL);
  if (!u) {
    db.prepare("INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?, 'Demo', ?, 'admin', ?)")
      .run(DEMO_EMAIL, hashPassword(randomToken()), now);
    u = db.prepare('SELECT * FROM users WHERE email = ?').get(DEMO_EMAIL);
  }
  return u;
}

function seedDemo(db, now) {
  const tz = 'America/Chicago';
  const r = rng(42);
  const created = now - 15 * 86400000;
  const id = db.prepare(
    `INSERT INTO seniors (name, phone, timezone, address, inactivity_minutes, quiet_start, quiet_end, consent_at, watch_from, created_at)
     VALUES ('Margaret', '+14155550100', ?, '12 Oak Street, Springfield, IL', 240, '00:00', '00:00', ?, ?, ?)`,
  ).run(tz, created, created, created).lastInsertRowid;

  const fam = db.prepare("INSERT INTO users (email, name, password_hash, role, telegram_chat_id, created_at) VALUES (?, ?, NULL, 'family', ?, ?)");
  const link = db.prepare('INSERT INTO family_links (user_id, senior_id, relationship) VALUES (?, ?, ?)');
  const jane = db.prepare('SELECT id FROM users WHERE email = ?').get('jane.demo@haru.local')
    || { id: fam.run('jane.demo@haru.local', 'Jane', 'demo-chat', created).lastInsertRowid };
  const tom = db.prepare('SELECT id FROM users WHERE email = ?').get('tom.demo@haru.local')
    || { id: fam.run('tom.demo@haru.local', 'Tom', null, created).lastInsertRowid };
  link.run(jane.id, id, 'daughter');
  link.run(tom.id, id, 'son');

  db.prepare("INSERT INTO devices (senior_id, token_hash, model, app_version, battery, usage_access, health_access, last_seen, created_at) VALUES (?, ?, 'Samsung Galaxy A15', '1.1', 72, 1, 1, ?, ?)")
    .run(id, sha256(randomToken()), now - 6 * 60000, created);

  // Routine: up around 7:30, phone use spread through the day, quiet after ~9:30 PM.
  const slot = db.prepare('INSERT OR IGNORE INTO activity_slots (senior_id, slot) VALUES (?, ?)');
  const health = db.prepare('INSERT INTO health_daily (senior_id, day, steps, resting_hr, avg_hr, min_hr, max_hr, sleep_minutes, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  let lastActive = created;
  for (let i = 14; i >= 0; i--) {
    const day = daysAgo(now, i, tz);
    const midnight = localToEpoch(day, '00:00', tz);
    const wake = (7 * 60 + 10 + Math.floor(r() * 45)) * 60000;
    const bed = (21 * 60 + Math.floor(r() * 50)) * 60000;
    for (let t = midnight + wake; t < midnight + bed; t += SLOT_MS) {
      const h = (t - midnight) / 3600000;
      const busy = h < 10 || (h > 11.5 && h < 13) || (h > 17 && h < 20.5);
      if (r() < (busy ? 0.7 : 0.3) && t < now - 40 * 60000) {
        slot.run(id, Math.floor(t / SLOT_MS) * SLOT_MS);
        lastActive = Math.max(lastActive, t + Math.floor(r() * 10) * 60000);
      }
    }
    const isYesterday = i === 1; // a quieter day, so the demo shows a gentle flag
    const isToday = i === 0;
    const hoursSoFar = Math.max(0, Math.min(1, ((now - midnight) / 3600000 - 7) / 14));
    const fullSteps = isYesterday ? 1840 : 3600 + Math.floor(r() * 2200);
    health.run(id, day,
      isToday ? Math.round(fullSteps * hoursSoFar) : fullSteps,
      isToday ? null : 63 + Math.floor(r() * 5) + (isYesterday ? 2 : 0),
      72 + Math.floor(r() * 6), 55 + Math.floor(r() * 4), 104 + Math.floor(r() * 20),
      400 + Math.floor(r() * 70), now);
  }
  db.prepare('UPDATE seniors SET last_active = ?, last_checkin = ?, latest_hr = 71, latest_hr_at = ? WHERE id = ?')
    .run(lastActive, now - 3 * 86400000 - 5 * 3600000, now - 25 * 60000, id);

  const call = db.prepare(
    `INSERT INTO calls (senior_id, vapi_call_id, attempt, reason, started_at, ended_at, ended_reason, transcript, outcome, summary)
     VALUES (?, ?, 1, ?, ?, ?, 'customer-ended-call', ?, ?, ?)`,
  );
  const t1 = now - 8 * 86400000 - 9 * 3600000;
  call.run(id, `demo-${randomToken(6)}`, 'inactivity', t1, t1 + 70000,
    "AI: Hi Margaret, this is Haru. Your phone has been quiet for a while, so I'm checking in. Are you okay?\nUser: Oh hello. Yes, I'm fine, I was in the garden all morning.\nAI: That sounds lovely. Have you eaten and taken your medicine today?\nUser: Yes, both. Thank you dear.",
    'ok', 'Margaret is fine; she was gardening all morning and has eaten and taken her medicine.');
  const t2 = now - 3 * 86400000 - 5 * 3600000;
  call.run(id, `demo-${randomToken(6)}`, 'manual', t2, t2 + 55000,
    "AI: Hi Margaret, this is Haru. Jane asked me to check in. How are you feeling?\nUser: A little tired today, but I'm alright. I had soup for lunch.\nAI: I'm glad you had lunch. Take it easy this afternoon.",
    'ok', 'Margaret feels a little tired but is alright and has eaten lunch.');

  const ev = db.prepare('INSERT INTO events (senior_id, at, kind, text) VALUES (?, ?, ?, ?)');
  ev.run(id, created, 'ok', 'Haru was set up for Margaret.');
  ev.run(id, created + 3600000, 'ok', 'Phone paired (Samsung Galaxy A15).');
  ev.run(id, created + 2 * 3600000, 'ok', 'Jane joined as family.');
  ev.run(id, t1 - 60000, 'warn', 'No phone activity for 4 hours. Haru is calling Margaret to check in.');
  ev.run(id, t1 + 70000, 'ok', 'Check-in call: Margaret is fine; she was gardening all morning and has eaten and taken her medicine.');
  ev.run(id, t2 - 60000, 'ok', 'Jane asked Haru to call Margaret.');
  ev.run(id, t2 + 55000, 'ok', 'Check-in call: Margaret feels a little tired but is alright and has eaten lunch.');

  // ---- caregiver features: medicine, location, living-room sensor ----
  const HOME = { lat: 39.79904, lng: -89.64398 };
  db.prepare('UPDATE seniors SET home_lat = ?, home_lng = ? WHERE id = ?').run(HOME.lat, HOME.lng, id);
  db.prepare("UPDATE devices SET location_access = 1 WHERE senior_id = ? AND kind = 'phone'").run(id);
  db.prepare("INSERT INTO devices (senior_id, token_hash, model, app_version, battery, kind, last_seen, created_at) VALUES (?, ?, 'Lenovo Tab M8 (living room)', '1.1', 100, 'room', ?, ?)")
    .run(id, sha256(randomToken()), now - 4 * 60000, created);

  const addMed = db.prepare('INSERT INTO medications (senior_id, name, dose, times, instructions, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const medList = [
    { id: addMed.run(id, 'Metformin', '500 mg', '08:00,20:00', 'With food', created).lastInsertRowid, times: ['08:00', '20:00'] },
    { id: addMed.run(id, 'Lisinopril', '10 mg', '08:00', 'For blood pressure', created).lastInsertRowid, times: ['08:00'] },
    { id: addMed.run(id, 'Vitamin D', '1000 IU', '12:00', '', created).lastInsertRowid, times: ['12:00'] },
  ];
  const dose = db.prepare("INSERT INTO med_doses (medication_id, due_at, senior_id, status, at, source) VALUES (?, ?, ?, ?, ?, ?)");
  const loc = db.prepare('INSERT OR IGNORE INTO locations (senior_id, at, lat, lng, accuracy) VALUES (?, ?, ?, ?, ?)');
  const room = db.prepare('INSERT OR REPLACE INTO room_slots (senior_id, slot, motion_minutes, motion_peak, sound_avg, sound_peak) VALUES (?, ?, ?, ?, ?, ?)');
  const SHOP = { lat: HOME.lat + 0.0068, lng: HOME.lng + 0.0021 };
  const PARK = { lat: HOME.lat - 0.0041, lng: HOME.lng + 0.0063 };

  for (let i = 14; i >= 0; i--) {
    const day = daysAgo(now, i, tz);
    const midnight = localToEpoch(day, '00:00', tz);
    const at = (h) => midnight + h * 3600000;
    // Medicine: usually taken within ~40 min; yesterday's evening Metformin was missed.
    for (const m of medList) {
      for (const time of m.times) {
        const dueAt = localToEpoch(day, time, tz);
        if (dueAt > now - 90 * 60000) continue; // today's recent doses stay open for the demo
        const missed = (i === 1 && time === '20:00') || (i === 6 && time === '12:00');
        if (missed) dose.run(m.id, dueAt, id, 'missed', dueAt + 2 * 3600000, 'haru');
        else dose.run(m.id, dueAt, id, 'taken', dueAt + Math.floor(r() * 40) * 60000, 'phone');
      }
    }
    // Outings: shops most mornings, the park some afternoons; none on Sundays.
    const weekday = new Date(midnight + 12 * 3600000).getUTCDay();
    const trips = weekday === 0 ? [] : [[10.25 + r() * 0.5, 1.2, SHOP], ...(r() < 0.45 ? [[15 + r(), 0.8, PARK]] : [])];
    const where = (h) => {
      const trip = trips.find(([start, len]) => h >= start && h < start + len);
      return trip ? trip[2] : null;
    };
    for (let h = 0; h < 24; h += 0.25) {
      const t = at(h);
      if (t > now - 5 * 60000) break;
      const out = where(h);
      // Location: one fix per 15 min while the phone is awake (7 AM to 10 PM).
      if (h >= 7 && h < 22) {
        const p = out || HOME;
        loc.run(id, t + Math.floor(r() * 60000), p.lat + (r() - 0.5) * 0.0003, p.lng + (r() - 0.5) * 0.0003, 12 + Math.floor(r() * 25));
      }
      // Room sensor: moving about in the day, still at night, nothing while out.
      let motion = 0;
      if (!out) {
        if (h >= 7.25 && h < 21.75) motion = Math.floor(r() * ((h < 10 || (h > 17 && h < 20)) ? 12 : 7));
        else if (h >= 3 && h < 3.25) motion = 3; // bathroom trip
        if (i === 0 && h >= 2 && h < 4.5) motion = 6 + Math.floor(r() * 6); // a restless last night
      }
      if (motion || (h >= 7 && h < 22 && !out)) room.run(id, t, motion, motion ? 20 + Math.floor(r() * 50) : 2, 15 + Math.floor(r() * 15), 30 + Math.floor(r() * 30));
    }
  }
  // Right now she is at home.
  loc.run(id, now - 7 * 60000, HOME.lat + 0.00004, HOME.lng - 0.00003, 14);
  const thud = now - 4 * 86400000 - 2 * 3600000;
  db.prepare("INSERT INTO sensor_events (senior_id, at, kind, confidence) VALUES (?, ?, 'loud_impact', 0.74)").run(id, thud);
  ev.run(id, created + 3 * 3600000, 'ok', 'Room sensor paired (Lenovo Tab M8 (living room)).');
  ev.run(id, created + 4 * 3600000, 'ok', 'Jane added Metformin 500 mg at 08:00, 20:00.');
  ev.run(id, thud, 'warn', `Room sensor heard a loud thud or crash.`);
  ev.run(id, thud + 20 * 60000, 'ok', 'Jane spoke to Margaret: she dropped a saucepan, all fine.');
  return id;
}

module.exports = { DEMO_EMAIL, ensureDemoUser, seedDemo };
