// Turns raw slots, health days and calls into what a family wants to know:
// how today compares with this person's normal, and anything worth a look (dashboard only, never alerts).
const { awayByDay } = require('./location');
const { medsSummary } = require('./meds');

const DAY = 86400000;

const dayKey = (ms, tz) => new Date(ms).toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
function localHM(ms, tz) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
  const g = (t) => Number(p.find((x) => x.type === t).value);
  return { hour: g('hour'), minutes: g('hour') * 60 + g('minute') };
}
const dayLabel = (key) => new Date(`${key}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

function median(values) {
  const v = values.filter((x) => x != null).sort((a, b) => a - b);
  if (v.length < 4) return null; // not enough history to call anything "usual"
  const m = Math.floor(v.length / 2);
  return Math.round(v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2);
}

const clock = (min) => {
  const h = Math.floor(min / 60);
  const m = String(min % 60).padStart(2, '0');
  return `${((h + 11) % 12) + 1}:${m} ${h < 12 ? 'AM' : 'PM'}`;
};
const n = (x) => x.toLocaleString('en-US');

function insights(db, s, now, nDays = 14) {
  const tz = s.timezone;
  const keys = [];
  for (let i = nDays - 1; i >= 0; i--) {
    const k = dayKey(now - i * DAY, tz);
    if (!keys.includes(k)) keys.push(k);
  }
  const today = keys[keys.length - 1];
  const yesterday = keys[keys.length - 2];
  const byDay = Object.fromEntries(keys.map((k) => [k, {
    day: k, label: dayLabel(k), steps: null, restingHr: null, minHr: null, maxHr: null, sleepMinutes: null,
    activeHours: 0, firstActive: null, calls: { ok: 0, concern: 0, emergency: 0, no_answer: 0 }, hours: new Array(24).fill(0),
  }]));

  for (const { slot } of db.prepare('SELECT slot FROM activity_slots WHERE senior_id = ? AND slot >= ?').all(s.id, now - (nDays + 1) * DAY)) {
    const d = byDay[dayKey(slot, tz)];
    if (!d) continue;
    const { hour, minutes } = localHM(slot, tz);
    d.hours[hour] += 1;
    if (d.firstActive === null || minutes < d.firstActive) d.firstActive = minutes;
  }
  for (const h of db.prepare('SELECT * FROM health_daily WHERE senior_id = ? AND day >= ?').all(s.id, keys[0])) {
    const d = byDay[h.day];
    if (!d) continue;
    Object.assign(d, { steps: h.steps, restingHr: h.resting_hr, minHr: h.min_hr, maxHr: h.max_hr, sleepMinutes: h.sleep_minutes });
  }
  for (const c of db.prepare('SELECT started_at, outcome FROM calls WHERE senior_id = ? AND started_at >= ? AND outcome IS NOT NULL').all(s.id, now - (nDays + 1) * DAY)) {
    const d = byDay[dayKey(c.started_at, tz)];
    if (d && d.calls[c.outcome] !== undefined) d.calls[c.outcome] += 1;
  }
  // Room sensor: movement minutes per hour, night movement (midnight-5 AM), first movement of the day.
  for (const r of db.prepare('SELECT slot, motion_minutes FROM room_slots WHERE senior_id = ? AND slot >= ?').all(s.id, now - (nDays + 1) * DAY)) {
    const d = byDay[dayKey(r.slot, tz)];
    if (!d) continue;
    const { hour, minutes } = localHM(r.slot, tz);
    d.room ||= new Array(24).fill(0);
    d.room[hour] += r.motion_minutes;
    if (!r.motion_minutes) continue;
    d.motionMinutes = (d.motionMinutes || 0) + r.motion_minutes;
    if (hour < 5) d.nightMotion = (d.nightMotion || 0) + r.motion_minutes;
    if (hour >= 5 && (d.firstMotion == null || minutes < d.firstMotion)) d.firstMotion = minutes;
  }
  const away = awayByDay(db, s, now - (nDays + 1) * DAY, (ms) => dayKey(ms, tz));
  const medHistory = Object.fromEntries(medsSummary(db, s, now, nDays).history.map((h) => [h.day, h]));
  const hasRoomDevice = !!db.prepare("SELECT 1 FROM devices WHERE senior_id = ? AND kind = 'room' AND revoked_at IS NULL").get(s.id);

  const days = keys.map((k) => {
    const d = byDay[k];
    d.activeHours = d.hours.filter((x) => x > 0).length;
    if (d.room || hasRoomDevice) {
      d.motionMinutes ||= 0;
      d.nightMotion ||= 0;
    } else {
      d.motionMinutes = null;
      d.nightMotion = null;
    }
    d.firstMotion ??= null;
    const a = away[k];
    d.awayMinutes = a && a.points >= 4 ? a.awayMinutes : null;
    d.outings = a && a.points >= 4 ? a.outings : null;
    const m = medHistory[k];
    d.meds = m && m.scheduled ? { scheduled: m.scheduled, taken: m.taken, missed: m.missed } : null;
    return d;
  });

  // "Usual" = median of previous days (today is still in progress).
  const past = days.slice(0, -1);
  const typical = {
    steps: median(past.map((d) => d.steps)),
    restingHr: median(past.map((d) => d.restingHr)),
    sleepMinutes: median(past.map((d) => d.sleepMinutes)),
    firstActive: median(past.map((d) => d.firstActive)),
    activeHours: median(past.map((d) => (d.firstActive === null ? null : d.activeHours))),
    motionMinutes: median(past.map((d) => d.motionMinutes)),
    nightMotion: median(past.map((d) => d.nightMotion)),
    firstMotion: median(past.map((d) => d.firstMotion)),
    awayMinutes: median(past.map((d) => d.awayMinutes)),
    outings: median(past.map((d) => d.outings)),
  };

  const t = byDay[today];
  const y = byDay[yesterday] || {};
  const flags = [];
  const paused = s.paused_until && s.paused_until > now;
  const nowMin = localHM(now, tz).minutes;
  if (!paused && typical.firstActive !== null && t.firstActive === null && nowMin > typical.firstActive + 120 && nowMin < 22 * 60) {
    flags.push({ level: 'watch', text: `No phone use yet today. ${s.name} is usually up and about by ${clock(typical.firstActive)}.` });
  }
  if (typical.steps >= 500 && y.steps != null && y.steps < typical.steps * 0.5) {
    flags.push({ level: 'watch', text: `Much less walking yesterday: ${n(y.steps)} steps (usually about ${n(typical.steps)}).` });
  }
  const lastResting = [...past].reverse().find((d) => d.restingHr != null);
  if (typical.restingHr && lastResting && lastResting.restingHr >= typical.restingHr + 10) {
    flags.push({ level: 'watch', text: `Resting heart rate higher than usual on ${lastResting.label}: ${lastResting.restingHr} bpm (usually ${typical.restingHr}).` });
  }
  if (typical.sleepMinutes >= 240 && t.sleepMinutes != null && t.sleepMinutes < typical.sleepMinutes - 120) {
    flags.push({ level: 'info', text: `Short night: about ${Math.round(t.sleepMinutes / 60 * 10) / 10} hours of sleep (usually ${Math.round(typical.sleepMinutes / 60 * 10) / 10}).` });
  }
  if (typical.activeHours >= 4 && y.firstActive != null && y.activeHours < typical.activeHours * 0.5) {
    flags.push({ level: 'info', text: `Quieter day yesterday: phone used in ${y.activeHours} hours of the day (usually ${typical.activeHours}).` });
  }

  // ---- behaviour: room movement, getting out, medicine ----
  if (!paused && hasRoomDevice && typical.firstMotion !== null && t.firstMotion === null && nowMin > typical.firstMotion + 120 && nowMin < 22 * 60) {
    flags.push({ level: 'watch', text: `No movement seen in the room yet today. ${s.name} is usually moving about by ${clock(typical.firstMotion)}.` });
  }
  if (t.nightMotion != null && typical.nightMotion != null && t.nightMotion >= Math.max(30, typical.nightMotion * 2)) {
    flags.push({ level: 'watch', text: `Restless night: ${t.nightMotion} minutes of movement between midnight and 5 AM (usually ${typical.nightMotion}). Poor sleep or extra bathroom trips can be worth asking about.` });
  }
  if (typical.motionMinutes >= 60 && y.motionMinutes != null && y.motionMinutes < typical.motionMinutes * 0.5) {
    flags.push({ level: 'watch', text: `Much less moving about at home yesterday: ${y.motionMinutes} active minutes (usually about ${typical.motionMinutes}).` });
  }
  const lastFull = past.slice(-3);
  if (typical.outings >= 1 && lastFull.length === 3 && lastFull.every((d) => d.outings === 0)) {
    flags.push({ level: 'info', text: `${s.name} hasn't left home in 3 days (usually goes out most days). A visit or a call might be welcome.` });
  }
  const week = days.slice(-7).filter((d) => d.meds);
  const missedWeek = week.reduce((a, d) => a + d.meds.missed, 0);
  if (missedWeek >= 2) {
    const sched = week.reduce((a, d) => a + d.meds.scheduled, 0);
    flags.push({ level: 'watch', text: `${missedWeek} of ${sched} medicine doses weren't marked taken this week. A pill organiser or a reminder call might help.` });
  }
  const recentEvents = db.prepare("SELECT kind, at FROM sensor_events WHERE senior_id = ? AND at > ? AND kind IN ('loud_impact', 'crying') ORDER BY at DESC").all(s.id, now - 2 * DAY);
  if (recentEvents.length) {
    const e = recentEvents[0];
    flags.push({ level: 'watch', text: `The room sensor heard ${e.kind === 'crying' ? 'what sounded like crying' : 'a loud thud'} on ${new Date(e.at).toLocaleString('en-US', { weekday: 'long', hour: 'numeric', minute: '2-digit', timeZone: tz })}${recentEvents.length > 1 ? ` (and ${recentEvents.length - 1} more in 2 days)` : ''}. Worth asking if everything is alright.` });
  }

  const recentHr = s.latest_hr_at && now - s.latest_hr_at < 6 * 3600000 ? { bpm: s.latest_hr, at: s.latest_hr_at } : null;
  return {
    timezone: tz,
    today: {
      day: today,
      steps: t.steps,
      sleepMinutes: t.sleepMinutes,
      heartRate: recentHr,
      restingHr: t.restingHr ?? (lastResting ? lastResting.restingHr : null),
      firstActive: t.firstActive,
      activeHours: t.activeHours,
      motionMinutes: t.motionMinutes,
      nightMotion: t.nightMotion,
      firstMotion: t.firstMotion,
      awayMinutes: t.awayMinutes,
      outings: t.outings,
    },
    typical,
    days: days.map(({ hours, room, ...d }) => d),
    week: days.slice(-7).map((d) => ({ day: d.day, label: d.label, hours: d.hours, room: d.room || new Array(24).fill(0) })),
    hasRoom: hasRoomDevice || days.some((d) => d.room),
    hasLocation: days.some((d) => d.awayMinutes != null),
    hasMeds: days.some((d) => d.meds),
    hasHealth: days.some((d) => d.steps != null || d.restingHr != null || d.sleepMinutes != null),
    hasActivity: days.some((d) => d.firstActive !== null),
    flags,
  };
}

module.exports = { insights, dayKey };
