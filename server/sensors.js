// Room sensor: a spare Android phone/tablet that watches a room with its camera and microphone.
// All video/audio is analysed on that device and discarded; it only sends numbers:
//   slots:  15-minute summaries { slot, motionMinutes 0-15, motionPeak 0-100, soundAvg 0-100, soundPeak 0-100 }
//   events: { at, kind, confidence 0-1 } for sounds/motions worth knowing about
const SLOT_MS = 15 * 60000;

const EVENT_KINDS = {
  possible_fall: { label: 'what may have been a fall', urgent: true },
  call_for_help: { label: 'someone calling for help', urgent: true },
  smoke_alarm: { label: 'a smoke or CO alarm', urgent: true },
  loud_impact: { label: 'a loud thud or crash', urgent: false },
  crying: { label: 'crying or distress', urgent: false },
};
const URGENT_CONFIDENCE = 0.6;

const pct = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : null);

function recordSlots(db, seniorId, slots, now) {
  if (!Array.isArray(slots)) return null;
  const up = db.prepare('INSERT OR REPLACE INTO room_slots (senior_id, slot, motion_minutes, motion_peak, sound_avg, sound_peak) VALUES (?, ?, ?, ?, ?, ?)');
  let lastMotion = null;
  for (const x of slots.slice(0, 700)) {
    if (!x || !Number.isFinite(x.slot) || x.slot > now || x.slot < now - 7 * 86400000) continue;
    const slot = Math.floor(x.slot / SLOT_MS) * SLOT_MS;
    const motion = Number.isInteger(x.motionMinutes) ? Math.max(0, Math.min(15, x.motionMinutes)) : 0;
    up.run(seniorId, slot, motion, pct(x.motionPeak), pct(x.soundAvg), pct(x.soundPeak));
    if (motion > 0) lastMotion = Math.max(lastMotion || 0, Math.min(slot + SLOT_MS, now));
  }
  return lastMotion;
}

/** Stores new events and returns the ones that were not seen before. */
function recordEvents(db, seniorId, events, now) {
  if (!Array.isArray(events)) return [];
  const ins = db.prepare('INSERT OR IGNORE INTO sensor_events (senior_id, at, kind, confidence) VALUES (?, ?, ?, ?)');
  const fresh = [];
  for (const e of events.slice(0, 100)) {
    if (!e || !EVENT_KINDS[e.kind] || !Number.isFinite(e.at) || e.at > now + 5 * 60000 || e.at < now - 2 * 86400000) continue;
    const confidence = Number.isFinite(e.confidence) ? Math.max(0, Math.min(1, e.confidence)) : null;
    if (ins.run(seniorId, Math.min(e.at, now), e.kind, confidence).changes) fresh.push({ at: Math.min(e.at, now), kind: e.kind, confidence });
  }
  return fresh;
}

const isUrgent = (e) => EVENT_KINDS[e.kind].urgent && (e.confidence == null || e.confidence >= URGENT_CONFIDENCE);

function purgeSensors(db, now) {
  db.prepare('DELETE FROM room_slots WHERE slot < ?').run(now - 90 * 86400000);
  db.prepare('DELETE FROM sensor_events WHERE at < ?').run(now - 365 * 86400000);
}

module.exports = { EVENT_KINDS, recordSlots, recordEvents, isUrgent, purgeSensors };
