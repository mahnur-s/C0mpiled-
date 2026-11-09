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

// Offset (ms) of timezone tz from UTC at instant ms.
function tzOffset(ms, tz) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms));
  const g = (t) => Number(p.find((x) => x.type === t).value);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - Math.floor(ms / 1000) * 1000;
}

// 'YYYY-MM-DD' + 'HH:MM' in tz -> epoch ms. Two passes settle daylight-saving changes.
function localToEpoch(day, hhmm, tz) {
  const [y, mo, d] = day.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let t = wall - tzOffset(wall, tz);
  t = wall - tzOffset(t, tz);
  return t;
}

const dayKey = (ms, tz) => new Date(ms).toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD

module.exports = { isValidTimezone, HHMM, toMinutes, localMinutes, inQuietHours, fmtTime, fmtDateTime, fmtDuration, localToEpoch, dayKey };
