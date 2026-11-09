// Timezone-aware helpers. Each senior has an IANA timezone; quiet hours are local "HH:MM" strings.

function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch (_) {
    return false;
  }
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const toMinutes = (hhmm) => {
  const m = HHMM.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

function localMinutes(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms));
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return get('hour') * 60 + get('minute');
}

// True when ms falls inside [start, end) local time; handles windows that cross midnight.
function inQuietHours(ms, tz, start, end) {
  const s = toMinutes(start);
  const e = toMinutes(end);
  if (s === null || e === null || s === e) return false;
  const m = localMinutes(ms, tz);
  return s < e ? m >= s && m < e : m >= s || m < e;
}

function fmtTime(ms, tz) {
  return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz });
}

function fmtDateTime(ms, tz) {
  return new Date(ms).toLocaleString('en-US', {
    weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: tz, timeZoneName: 'short',
  });
}

function fmtDuration(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h} hour${h === 1 ? '' : 's'}` : `${Math.floor(h / 24)} days`;
}

module.exports = { isValidTimezone, HHMM, inQuietHours, fmtTime, fmtDateTime, fmtDuration };
