// Store what the phone reports: 15-minute usage slots and daily health summaries (Health Connect).
const SLOT_MS = 15 * 60000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const int = (v, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : null);

function recordUsage(db, seniorId, times, now) {
  if (!Array.isArray(times)) return;
  const ins = db.prepare('INSERT OR IGNORE INTO activity_slots (senior_id, slot) VALUES (?, ?)');
  for (const t of times.slice(0, 2000)) {
    if (Number.isFinite(t) && t <= now + 5 * 60000 && t >= now - 30 * 86400000) ins.run(seniorId, Math.floor(t / SLOT_MS) * SLOT_MS);
  }
}

// days: [{ day: 'YYYY-MM-DD' (senior's local date), steps, restingHr, avgHr, minHr, maxHr, sleepMinutes }]
function recordHealth(db, seniorId, health, now) {
  if (!health || typeof health !== 'object') return;
  const up = db.prepare(
    `INSERT INTO health_daily (senior_id, day, steps, resting_hr, avg_hr, min_hr, max_hr, sleep_minutes, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (senior_id, day) DO UPDATE SET
       steps = COALESCE(excluded.steps, steps), resting_hr = COALESCE(excluded.resting_hr, resting_hr),
       avg_hr = COALESCE(excluded.avg_hr, avg_hr), min_hr = COALESCE(excluded.min_hr, min_hr),
       max_hr = COALESCE(excluded.max_hr, max_hr), sleep_minutes = COALESCE(excluded.sleep_minutes, sleep_minutes),
       updated_at = excluded.updated_at`,
  );
  for (const d of Array.isArray(health.days) ? health.days.slice(0, 60) : []) {
    if (!d || !DAY_RE.test(d.day)) continue;
    up.run(seniorId, d.day, int(d.steps, 0, 200000), int(d.restingHr, 25, 220), int(d.avgHr, 25, 250),
      int(d.minHr, 25, 250), int(d.maxHr, 25, 250), int(d.sleepMinutes, 0, 1440), now);
  }
  const hr = health.latestHeartRate;
  if (hr && int(hr.bpm, 25, 250) !== null && Number.isFinite(hr.at) && hr.at <= now + 5 * 60000) {
    db.prepare('UPDATE seniors SET latest_hr = ?, latest_hr_at = ? WHERE id = ? AND (latest_hr_at IS NULL OR latest_hr_at <= ?)')
      .run(hr.bpm, hr.at, seniorId, hr.at);
  }
}

function purgeHealth(db, now) {
  db.prepare('DELETE FROM activity_slots WHERE slot < ?').run(now - 90 * 86400000);
}

module.exports = { SLOT_MS, recordUsage, recordHealth, purgeHealth };
