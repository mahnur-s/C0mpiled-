// Medication schedules. A medication has local dose times ("08:00,20:00"); each scheduled dose is
// identified by (medication_id, due_at). Only actions are stored (taken / skipped / missed-and-told-family);
// "due", "late" and "upcoming" are worked out from the clock.
const { HHMM, localToEpoch, dayKey, fmtTime } = require('./time');

const MIN = 60000;
const DAY = 86400000;
const DUE_EARLY = 30 * MIN; // a dose shows as "due" from 30 min before its time
const LATE_AFTER = 60 * MIN; // and as "late" an hour after

function parseTimes(v) {
  const list = (Array.isArray(v) ? v : String(v || '').split(','))
    .map((x) => String(x).trim()).filter(Boolean);
  const uniq = [...new Set(list)].sort();
  if (!uniq.length || uniq.length > 8 || !uniq.every((x) => HHMM.test(x))) return null;
  return uniq;
}

const medView = (m) => ({
  id: m.id, name: m.name, dose: m.dose, times: m.times.split(','), instructions: m.instructions, active: !!m.active, createdAt: m.created_at,
});

// Every scheduled dose for the local days in [fromDay, toDay], newest last. A dose only exists if the
// medication was already on the list when it was due.
function scheduledDoses(db, s, days) {
  const meds = db.prepare('SELECT * FROM medications WHERE senior_id = ?').all(s.id);
  if (!meds.length) return [];
  const out = [];
  for (const day of days) {
    for (const m of meds) {
      for (const time of m.times.split(',')) {
        const dueAt = localToEpoch(day, time, s.timezone);
        // Doses scheduled up to 30 min after it was added still count (added "8:00" at 7:45).
        if (dueAt + DUE_EARLY < m.created_at) continue;
        if (!m.active && dueAt > (m.stopped_at || 0)) continue;
        out.push({ medicationId: m.id, name: m.name, dose: m.dose, instructions: m.instructions, time, day, dueAt, active: !!m.active });
      }
    }
  }
  if (!out.length) return out;
  const recorded = db.prepare('SELECT * FROM med_doses WHERE senior_id = ? AND due_at BETWEEN ? AND ?')
    .all(s.id, out.reduce((a, d) => Math.min(a, d.dueAt), Infinity), out.reduce((a, d) => Math.max(a, d.dueAt), 0));
  const byKey = new Map(recorded.map((r) => [`${r.medication_id}:${r.due_at}`, r]));
  return out.map((d) => {
    const r = byKey.get(`${d.medicationId}:${d.dueAt}`);
    return r ? { ...d, recorded: r.status, recordedAt: r.at, source: r.source, byUser: r.by_user } : d;
  }).sort((a, b) => a.dueAt - b.dueAt || a.name.localeCompare(b.name));
}

// taken | skipped | missed | late | due | upcoming
function statusOf(d, s, t) {
  if (d.recorded) return d.recorded;
  if (t < d.dueAt - DUE_EARLY) return 'upcoming';
  if (t < d.dueAt + LATE_AFTER) return 'due';
  if (t < d.dueAt + s.med_grace_minutes * MIN) return 'late';
  return 'missed';
}

function lastDays(t, tz, n) {
  const keys = [];
  for (let i = n - 1; i >= 0; i--) {
    const k = dayKey(t - i * DAY, tz);
    if (!keys.includes(k)) keys.push(k);
  }
  return keys;
}

/** Today's doses with status, plus a per-day adherence history for the dashboard. */
function medsSummary(db, s, t, nDays = 14) {
  const days = lastDays(t, s.timezone, nDays);
  const doses = scheduledDoses(db, s, days).map((d) => ({ ...d, status: statusOf(d, s, t) }));
  const today = days[days.length - 1];
  const history = days.map((day) => {
    const ds = doses.filter((d) => d.day === day && d.status !== 'upcoming' && d.status !== 'due' && d.status !== 'late');
    const taken = ds.filter((d) => d.status === 'taken').length;
    return { day, scheduled: ds.length, taken, skipped: ds.filter((d) => d.status === 'skipped').length, missed: ds.filter((d) => d.status === 'missed').length };
  });
  const past = history.filter((h) => h.scheduled > 0);
  const totalScheduled = past.reduce((a, h) => a + h.scheduled, 0);
  return {
    medications: db.prepare('SELECT * FROM medications WHERE senior_id = ? AND active = 1 ORDER BY name').all(s.id).map(medView),
    today: doses.filter((d) => d.day === today),
    history,
    adherence: totalScheduled ? Math.round((past.reduce((a, h) => a + h.taken, 0) / totalScheduled) * 100) : null,
  };
}

/** Doses the senior's phone should remind about right now. */
function dueForPhone(db, s, t) {
  return scheduledDoses(db, s, lastDays(t, s.timezone, 2))
    .map((d) => ({ ...d, status: statusOf(d, s, t) }))
    .filter((d) => d.status === 'due' || d.status === 'late')
    .map((d) => ({ medicationId: d.medicationId, name: d.name, dose: d.dose, dueAt: d.dueAt, status: d.status }));
}

/** "your 8:00 AM Metformin and Lisinopril" for the check-in call, or '' if nothing is outstanding. */
function outstandingPhrase(db, s, t) {
  const open = scheduledDoses(db, s, lastDays(t, s.timezone, 1))
    .filter((d) => !d.recorded && d.dueAt - DUE_EARLY <= t);
  if (!open.length) return '';
  const names = [...new Set(open.map((d) => d.name))];
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
  return `${list} (due ${fmtTime(open[0].dueAt, s.timezone)})`;
}

/** Record taken/skipped for a scheduled dose. Throws a message for doses that don't exist. */
function recordDose(db, s, { medicationId, dueAt, status, source, userId = null, at }) {
  if (!['taken', 'skipped'].includes(status)) throw new Error('Status must be taken or skipped.');
  const m = db.prepare('SELECT * FROM medications WHERE id = ? AND senior_id = ?').get(Number(medicationId), s.id);
  if (!m) throw new Error('Unknown medication.');
  const due = Number(dueAt);
  const known = scheduledDoses(db, s, [dayKey(due, s.timezone)]).some((d) => d.medicationId === m.id && d.dueAt === due);
  if (!known) throw new Error('That dose is not on the schedule.');
  db.prepare(
    `INSERT INTO med_doses (medication_id, due_at, senior_id, status, at, source, by_user) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (medication_id, due_at) DO UPDATE SET status = excluded.status, at = excluded.at, source = excluded.source, by_user = excluded.by_user`,
  ).run(m.id, due, s.id, status, at, source, userId);
  return m;
}

/** Mark every outstanding dose of the last 12 hours as taken (the senior said so on a call). */
function markOutstandingTaken(db, s, t, source) {
  const open = scheduledDoses(db, s, lastDays(t, s.timezone, 2))
    .filter((d) => !d.recorded && d.dueAt - DUE_EARLY <= t && d.dueAt > t - 12 * 3600000);
  for (const d of open) recordDose(db, s, { medicationId: d.medicationId, dueAt: d.dueAt, status: 'taken', source, at: t });
  return open.length;
}

/** Doses that just passed their grace period: stored as 'missed' so family is told once. */
function newlyMissed(db, s, t) {
  const missed = scheduledDoses(db, s, lastDays(t, s.timezone, 2))
    .filter((d) => !d.recorded && statusOf(d, s, t) === 'missed' && d.dueAt > t - DAY);
  const ins = db.prepare("INSERT OR IGNORE INTO med_doses (medication_id, due_at, senior_id, status, at, source) VALUES (?, ?, ?, 'missed', ?, 'haru')");
  for (const d of missed) ins.run(d.medicationId, d.dueAt, s.id, t);
  return missed;
}

module.exports = { parseTimes, medView, medsSummary, dueForPhone, outstandingPhrase, recordDose, markOutstandingTaken, newlyMissed, statusOf };
