import { api, el, $, boot, fmtTime, fmtWhen, ago, clock, hours, num, flash, connectTelegram } from './common.js';
import { columnChart, lineChart, heatmap, numbers } from './charts.js';

const params = new URLSearchParams(location.search);
const wanted = Number(params.get('senior')) || null;
const { me, config, seniors } = await boot(wanted);

const OUTCOME = { ok: ['ok', 'Doing fine'], concern: ['warn', 'Needs attention'], emergency: ['bad', 'Emergency'], no_answer: ['warn', 'No answer'] };
let current = null;
let detail = null;
let showAllEvents = false;
let insightsAt = 0;
let ins = null;

// ---------- start (called at the end of this file, once every function and constant exists) ----------
async function start() {
if (!seniors.length) {
  $('empty').classList.remove('hidden');
  if (me.role === 'admin') {
    $('empty-h').textContent = 'Who would you like Haru to look out for?';
    $('empty-p').textContent = "Add a parent or relative who lives alone. It takes about 5 minutes: their details, their phone, and who should get alerts.";
    $('empty-add').classList.remove('hidden');
  } else {
    $('empty-h').textContent = "You're not connected to anyone yet";
    $('empty-p').textContent = 'Ask the person who set up Haru for your family to send you an invite link.';
  }
} else {
  current = seniors.some((s) => s.id === wanted) ? wanted : seniors[0].id;
  if (current !== wanted) history.replaceState(null, '', `?senior=${current}`);
  document.querySelectorAll('header.top .people a').forEach((a) => a.classList.toggle('on', a.getAttribute('href') === `/app.html?senior=${current}`));
  $('person').classList.remove('hidden');
  banners();
  await refresh(true);
  setInterval(() => { if (!document.hidden) refresh(false); }, 10000);
}
}

function banners() {
  const box = $('banners');
  if (config.demoMode && me.role === 'admin') {
    box.append(el('div', { class: 'banner demo' },
      el('span', {}, "You're looking at a demo with two weeks of sample data. Try the demo controls at the bottom of the page to act out a fall."),
      el('a', { class: 'btn', href: '#demo' }, 'Go to demo controls')));
  }
  if (config.telegramBot && !me.telegramLinked) {
    box.append(el('div', { class: 'banner' },
      el('span', {}, 'Get an alert on your phone if something is wrong.'),
      el('button', { class: 'primary', onclick: connectTelegram }, 'Connect Telegram')));
  }
}

// ---------- data ----------
async function refresh(full) {
  try {
    detail = await api('GET', `/api/seniors/${current}`);
    if (full || Date.now() - insightsAt > 60000) {
      ins = await api('GET', `/api/seniors/${current}/insights`);
      insightsAt = Date.now();
      renderCharts();
    }
    render();
  } catch (e) {
    flash($('act-err'), e.message);
  }
}

// ---------- top: status, tiles, flags ----------
function heroCopy(s, status) {
  const n = s.name;
  if (status.level === 'paused') return ['⏸', 'Monitoring is paused', status.text];
  if (status.level === 'bad') return ['!', `${n} may need help`, status.text];
  if (status.title === 'Calling now') return ['☎', `Haru is calling ${n} now`, 'Checking in because the phone has been quiet for longer than usual.'];
  if (status.title === 'No answer yet') return ['☎', `${n} hasn't answered yet`, status.text];
  if (status.title === 'Unusually quiet') return ['…', `${n} has been quiet`, status.text];
  if (status.level === 'warn') return ['!', `${n} may need attention`, status.text];
  return ['✓', `${n} is doing fine`, s.lastActive ? `Phone last used ${ago(s.lastActive)}.` : 'Waiting for the first activity from the phone.'];
}

function render() {
  const { senior: s, status, device, family } = detail;
  const tz = s.timezone;
  document.title = `${s.name} · Haru`;
  $('name').textContent = s.name;
  const rel = family.map((f) => f.name).join(', ');
  $('sub').textContent = rel ? `Looked after by ${rel}` : 'No family members yet';
  $('settings-link').href = `/settings.html?senior=${s.id}`;

  const [icon, title, text] = heroCopy(s, status);
  $('hero').className = `hero ${status.level}`;
  $('hero-icon').textContent = icon;
  $('hero-title').textContent = title;
  $('hero-text').textContent = text;
  const inc = status.incident;
  const paused = s.pausedUntil && s.pausedUntil > Date.now();
  $('hero-meta').textContent = inc && inc.acked_at
    ? `${inc.acked_by_name || 'Someone'} is handling this (since ${fmtTime(inc.acked_at, tz)}).`
    : inc ? `Alert sent ${fmtWhen(inc.opened_at, tz)}. Let the family know you're on it.`
      : paused || s.phase !== 'watching' ? ''
        : `Haru will check in if the phone isn't used by ${fmtWhen(s.nextCheckAt, tz).replace('Today ', '')}.`;
  $('b-ack').classList.toggle('hidden', !inc || !!inc.acked_at);
  $('b-resolve').classList.toggle('hidden', !inc);
  $('b-resume').classList.toggle('hidden', !paused);
  $('b-call').classList.toggle('hidden', !!paused);
  $('b-call').disabled = s.phase === 'calling' || s.phase === 'retry';
  $('b-phone').href = `tel:${s.phone}`;
  $('b-phone').textContent = `📞 Call ${s.name}`;

  renderTiles(s, device);
  renderFlags(s, device, family);
  renderMeds(s, detail.meds);
  renderWhere(s, detail.location, device);
  renderSounds(detail.rooms, detail.sensorEvents, tz);
  renderCalls(detail.calls, tz);
  renderFeed(detail.events, tz);
  renderDemo(s);
}

const dist = (m) => (m < 160 ? `${Math.round(m * 3.281)} ft` : `${(m / 1609).toFixed(m < 16000 ? 1 : 0)} mi`);

function tile(label, value, unit, note, cls = '') {
  return el('div', { class: `tile${value == null || value === '-' ? ' none' : ''}` },
    el('p', { class: 'k' }, label),
    el('p', { class: 'v' }, value == null ? '—' : value, unit && value != null ? el('small', {}, unit) : null),
    el('p', { class: `n ${cls}` }, note || ''));
}

function vsUsual(v, usual, fmt = num) {
  if (v == null || !usual) return ['', ''];
  const pct = Math.round(((v - usual) / usual) * 100);
  if (Math.abs(pct) < 10) return [`About usual (${fmt(usual)})`, ''];
  return [`${pct > 0 ? '▲' : '▼'} ${Math.abs(pct)}% vs usual ${fmt(usual)}`, pct > 0 ? 'up' : 'down'];
}

function renderTiles(s, device) {
  const t = ins ? ins.today : {};
  const u = ins ? ins.typical : {};
  const tz = s.timezone;
  const healthNote = device.id && device.health_access === 0 ? 'Not shared from the phone' : 'Needs Health Connect';
  const stepsSoFar = t.steps != null && u.steps ? `So far today · usually ~${num(u.steps)}` : t.steps != null ? 'So far today' : healthNote;
  const hr = t.heartRate;
  const m = detail.meds;
  const past = m.today.filter((d) => d.status !== 'upcoming');
  const taken = past.filter((d) => d.status === 'taken').length;
  const open = m.today.filter((d) => d.status === 'due' || d.status === 'late').length;
  const missed = m.today.filter((d) => d.status === 'missed').length;
  const loc = detail.location;
  const tiles = [
    tile('Last sign of activity', s.lastActive ? ago(s.lastActive) : null, '', s.lastActive ? fmtWhen(s.lastActive, tz) : 'Nothing yet'),
    tile('Medicine today', m.today.length ? `${taken} of ${past.length || m.today.length}` : null, m.today.length ? 'taken' : '',
      !m.today.length ? 'No medicines added' : missed ? `${missed} missed` : open ? `${open} due now` : past.length < m.today.length ? `Next at ${fmtTime(m.today.find((d) => d.status === 'upcoming').dueAt, tz)}` : 'All done for today',
      missed ? 'down' : ''),
    tile('Where', loc && loc.homeSet && !loc.stale ? (loc.atHome ? 'At home' : 'Out') : loc && !loc.stale ? 'Shared' : null, '',
      !loc ? (device.location_access === 0 ? 'Location is off on the phone' : 'Location not shared') : loc.stale ? `Last seen ${ago(loc.at)}`
        : loc.atHome ? (loc.since ? `Since ${fmtWhen(loc.since, tz).replace('Today ', '')}` : 'Right now') : loc.distanceM != null ? `${dist(loc.distanceM)} from home` : 'Home not set'),
    tile('Steps today', t.steps != null ? num(t.steps) : null, '', stepsSoFar),
    tile('Heart rate', hr ? hr.bpm : t.restingHr ?? null, 'bpm',
      hr ? `${ago(hr.at)}${t.restingHr ? ` · resting ${t.restingHr}` : ''}` : t.restingHr ? 'Resting, latest day' : 'Needs a watch + Health Connect'),
    tile('Sleep last night', t.sleepMinutes != null ? hours(t.sleepMinutes) : null, '', ...(t.sleepMinutes != null ? vsUsual(t.sleepMinutes, u.sleepMinutes, hours) : ['Needs a watch + Health Connect'])),
  ];
  $('tiles').replaceChildren(...tiles);
}

function flag(level, text, action) {
  const icon = { fine: '✓', info: 'i', watch: '!', problem: '!' }[level];
  return el('div', { class: `flag ${level}` }, el('span', { class: 'fi', 'aria-hidden': 'true' }, icon),
    el('span', {}, el('span', { class: 'sr' }, ''), text), action ? el('span', { class: 'fa' }, action) : null);
}

function renderFlags(s, device, family) {
  const out = [];
  const settings = (label) => el('a', { class: 'btn', href: `/settings.html?senior=${s.id}` }, label);
  if (!family.some((f) => f.telegramLinked)) {
    out.push(flag('problem', 'Nobody will get alerts: no family member has connected Telegram yet.', me.role === 'admin' ? settings('Family settings') : null));
  }
  if (!device.id) out.push(flag('problem', `${s.name}'s phone isn't connected, so Haru can't notice when it goes quiet. Haru will still call after ${Math.round(s.inactivityMinutes / 60)} hours without activity.`, me.role === 'admin' ? settings('Connect phone') : null));
  else {
    if (device.usage_access === 0) out.push(flag('problem', `Haru can't see when the phone is used: "Usage access" was turned off on ${s.name}'s phone. Open the Haru app on that phone to fix it.`));
    if (device.last_seen && Date.now() - device.last_seen > 2 * 3600000) out.push(flag('watch', device.note));
    if (device.battery != null && device.battery <= 15 && Date.now() - device.last_seen < 2 * 3600000) out.push(flag('watch', `Phone battery is low (${device.battery}%). A reminder to charge might help.`));
    if (device.location_access === 0) out.push(flag('info', `Location sharing is off on ${s.name}'s phone, so you can't see whether they're home.`));
    if (device.location_access === 1 && !s.homeSet) out.push(flag('info', `Home isn't set yet, so Haru can't tell "at home" from "out".`, me.role === 'admin' ? el('a', { class: 'btn', href: `/settings.html?senior=${s.id}#location` }, 'Set home') : null));
    if (device.health_access === 0) out.push(flag('info', `Steps and heart rate aren't shared yet. Open the Haru app on ${s.name}'s phone and allow Health Connect.`));
  }
  for (const r of detail.rooms) {
    if (Date.now() - r.last_seen > 2 * 3600000) out.push(flag('watch', `The room sensor (${r.model || 'tablet'}) hasn't reported since ${fmtWhen(r.last_seen, s.timezone)}. Check it's plugged in and on Wi-Fi.`));
  }
  for (const d of detail.meds.today.filter((x) => x.status === 'missed')) {
    out.push(flag('watch', `${d.name}${d.dose ? ` ${d.dose}` : ''} (${fmtTime(d.dueAt, s.timezone)}) wasn't marked as taken.`, markButton(d, 'Mark taken')));
  }
  for (const f of ins ? ins.flags : []) out.push(flag(f.level, f.text));
  if (!out.length) out.push(flag('fine', ins && ins.hasActivity ? 'Nothing unusual. Today looks like a normal day.' : 'Nothing to flag. Haru learns what "normal" looks like over the first few days.'));
  $('flags').replaceChildren(...out);
}

// ---------- today: medicine, location, room sensor ----------
const DOSE = {
  taken: ['ok', 'Taken'], skipped: ['', 'Skipped'], missed: ['bad', 'Missed'], late: ['warn', 'Late'], due: ['warn', 'Due now'], upcoming: ['', 'Later'],
};
const SOURCE = { phone: 'on the phone', family: 'by family', call: 'on a check-in call', haru: '' };

function markButton(d, label = 'Taken') {
  return el('button', {
    class: 'small-btn',
    onclick: (e) => act(e.target, () => api('POST', `/api/seniors/${current}/doses`, { medicationId: d.medicationId, dueAt: d.dueAt, status: 'taken' })),
    title: `Mark ${d.name} as taken (for example after you spoke to them)`,
  }, label);
}

function renderMeds(s, m) {
  $('meds-edit').href = `/settings.html?senior=${s.id}#medicine`;
  const tz = s.timezone;
  if (!m.medications.length) {
    return $('meds-today').replaceChildren(el('p', { class: 'muted small' }, `No medicines added. Add ${s.name}'s medicines and times; their phone will remind them and you'll see what's been taken.`),
      el('a', { class: 'btn mt', href: `/settings.html?senior=${s.id}#medicine` }, '+ Add medicines'));
  }
  if (!m.today.length) return $('meds-today').replaceChildren(el('p', { class: 'muted small' }, 'Nothing scheduled today.'));
  $('meds-today').replaceChildren(...m.today.map((d) => {
    const [cls, label] = DOSE[d.status];
    const who = d.status === 'taken' && d.recordedAt ? ` at ${fmtTime(d.recordedAt, tz)} ${SOURCE[d.source] || ''}` : '';
    return el('div', { class: `dose ${d.status}` },
      el('span', { class: 'dt' }, fmtTime(d.dueAt, tz)),
      el('div', { class: 'grow' }, el('b', {}, d.name), d.dose ? ` ${d.dose}` : '', d.instructions ? el('span', { class: 'muted small' }, ` · ${d.instructions}`) : '',
        who ? el('div', { class: 'small muted' }, `Taken${who}`.trim()) : null),
      el('span', { class: `pill ${cls}` }, label),
      ['due', 'late', 'missed'].includes(d.status) ? markButton(d) : null);
  }), m.adherence != null ? el('p', { class: 'small muted mt' }, `${m.adherence}% of doses taken over the last two weeks.`) : '');
}

const osmEmbed = (lat, lng, d) => `https://www.openstreetmap.org/export/embed.html?bbox=${lng - d},${lat - d / 2},${lng + d},${lat + d / 2}&layer=mapnik&marker=${lat},${lng}`;
let mapKey = '';

function renderWhere(s, loc, device) {
  const tz = s.timezone;
  if (!loc) {
    mapKey = '';
    $('where-when').textContent = '';
    return $('where').replaceChildren(el('p', { class: 'muted small' }, device.id
      ? `${s.name}'s phone isn't sharing its location. If they agree, open the Haru app on their phone and tap "Share where you are".`
      : `Connect ${s.name}'s phone to see whether they're home.`));
  }
  $('where-when').textContent = `updated ${ago(loc.at)}`;
  const headline = !loc.homeSet ? 'Location shared' : loc.atHome ? `${s.name} is at home` : `${s.name} is out`;
  const sub = !loc.homeSet ? 'Set a home location in Settings to see "at home" or "out".'
    : loc.atHome ? (loc.since ? `Home since ${fmtWhen(loc.since, tz)}.` : '')
      : `About ${dist(loc.distanceM)} from home${loc.since ? `, left ${fmtWhen(loc.since, tz)}` : ''}.`;
  // Only rebuild the map when the position changes, so the 10-second refresh doesn't reload it.
  const key = `${loc.lat},${loc.lng}`;
  const map = key === mapKey && $('where').querySelector('iframe') ? $('where').querySelector('iframe')
    : el('iframe', { class: 'map', title: `Map showing ${s.name}'s phone`, src: osmEmbed(loc.lat, loc.lng, loc.atHome === false ? 0.012 : 0.005) });
  mapKey = key;
  $('where').replaceChildren(...[
    el('p', { class: `where-h ${loc.atHome === false ? 'out' : ''}` }, headline),
    sub ? el('p', { class: 'small muted' }, sub) : null,
    loc.stale ? el('p', { class: 'small warn-text' }, `The phone hasn't reported a position for ${ago(loc.at).replace(' ago', '')}. It may be off, or location may be switched off.`) : null,
    map,
    el('div', { class: 'actions mt-s' },
      el('a', { class: 'btn', href: `https://www.google.com/maps?q=${loc.lat},${loc.lng}`, target: '_blank', rel: 'noopener' }, 'Open in Google Maps'),
      el('span', { class: 'small muted' }, loc.accuracy ? `Accurate to about ${dist(loc.accuracy)}` : '')),
  ].filter(Boolean));
}

function renderSounds(rooms, events, tz) {
  $('sounds-card').classList.toggle('hidden', !rooms.length && !events.length);
  const list = events.map((e) => el('div', { class: 'row' },
    el('span', { class: `dot ${['possible_fall', 'call_for_help', 'smoke_alarm'].includes(e.kind) ? 'bad' : 'warn'}` }),
    el('div', { class: 'grow' }, `Heard ${e.label}`, el('div', { class: 'when' }, fmtWhen(e.at, tz), e.confidence != null ? ` · ${Math.round(e.confidence * 100)}% sure` : ''))));
  $('sounds').replaceChildren(...rooms.map((r) => el('p', { class: 'small' }, el('span', { class: `sdot ${Date.now() - r.last_seen > 2 * 3600000 ? 'warn' : ''}` }), ` ${r.model || 'Room sensor'} · checked in ${ago(r.last_seen)}`)),
    ...(list.length ? list : [el('p', { class: 'muted small' }, 'Nothing unusual heard this week.')]));
}

// ---------- charts ----------
function renderCharts() {
  if (!ins) return;
  const tz = ins.timezone;
  $('tz-note').textContent = `Times shown in ${detail ? detail.senior.name : 'their'}'s time zone (${tz.replace('_', ' ')})`;
  const short = (d) => d.label.split(', ')[1] || d.label;
  const isToday = (d) => d.day === ins.today.day;

  // Activity heatmap
  const u = ins.typical;
  $('take-activity').textContent = u.firstActive != null
    ? `Usually up and using the phone by ${clock(u.firstActive)}, active in about ${u.activeHours} hours of the day.`
    : 'Darker squares mean more phone use in that hour.';
  heatmap($('c-activity'), { rows: ins.week.map((d) => ({ label: isToday(d) ? 'Today' : d.label.split(',')[0] + ' ' + short(d).split(' ')[1], hours: d.hours })) });

  // Room movement heatmap (minutes of movement per hour -> 0..4)
  $('room-card').classList.toggle('hidden', !ins.hasRoom);
  if (ins.hasRoom) {
    $('take-room').textContent = u.firstMotion != null
      ? `Usually up and about by ${clock(u.firstMotion)}, moving for about ${hours(u.motionMinutes)} a day.${u.nightMotion != null ? ` At night (midnight–5 AM) usually ${u.nightMotion} min.` : ''}`
      : 'Darker squares mean more movement in that hour. Blank hours while out are normal.';
    heatmap($('c-room'), {
      rows: ins.week.map((d) => ({ label: isToday(d) ? 'Today' : d.label.split(',')[0] + ' ' + short(d).split(' ')[1], hours: d.room })),
      level: (min) => (min <= 0 ? 0 : Math.min(4, Math.ceil(min / 12))),
      describe: (label, h, min, hourName) => `${label}, ${hourName(h)}–${hourName((h + 1) % 24)}: ${min ? `moving about ${min} min` : 'no movement seen'}`,
      ariaLabel: 'Movement at home by hour, last 7 days', legend: 'More movement',
    });
  }

  // Medicine adherence
  const medDays = ins.days.map((d) => ({
    short: short(d).split(' ')[1], value: d.meds ? Math.round((d.meds.taken / d.meds.scheduled) * 100) : null, partial: isToday(d),
    tip: `${d.label}: ${d.meds ? `${d.meds.taken} of ${d.meds.scheduled} doses taken${d.meds.missed ? `, ${d.meds.missed} missed` : ''}` : 'nothing due'}`,
  }));
  $('take-meds').textContent = detail.meds.adherence != null ? `${detail.meds.adherence}% of doses taken in the last two weeks.` : 'Add medicines in Settings to track doses.';
  columnChart($('c-meds'), { data: medDays, typical: null, format: (v) => `${Math.round(v)}%`, unitLabel: 'Medicine doses taken per day', max: 100 });

  // Time away from home
  const toHrs = (m) => (m == null ? null : Math.round((m / 60) * 10) / 10);
  $('take-away').textContent = u.awayMinutes != null
    ? `Usually out for about ${hours(u.awayMinutes)} a day${u.outings ? `, ${u.outings} outing${u.outings === 1 ? '' : 's'}` : ''}. Days without going out are worth noticing.`
    : 'Needs location sharing on their phone and a home location.';
  columnChart($('c-away'), {
    data: ins.days.map((d) => ({ short: short(d).split(' ')[1], value: toHrs(d.awayMinutes), partial: isToday(d), tip: `${d.label}: ${d.awayMinutes == null ? 'no data' : d.awayMinutes ? `out for ${hours(d.awayMinutes)} (${d.outings} outing${d.outings === 1 ? '' : 's'})` : 'stayed home'}` })),
    typical: toHrs(u.awayMinutes), format: (v) => `${Math.round(v * 10) / 10}h`, unitLabel: 'Hours out of the house per day',
  });

  // Steps
  const stepsData = ins.days.map((d) => ({
    short: short(d).split(' ')[1], value: d.steps, partial: isToday(d),
    tip: `${d.label}: ${d.steps == null ? 'no data' : `${num(d.steps)} steps${isToday(d) ? ' so far' : ''}`}`,
  }));
  $('take-steps').textContent = u.steps ? `Usually about ${num(u.steps)} steps a day. Today is still in progress (lighter bar).` : 'Steps counted by the phone or a watch.';
  columnChart($('c-steps'), { data: stepsData, typical: u.steps, unitLabel: 'Steps per day' });
  $('n-steps').replaceChildren(ins.hasHealth ? numbers(['Day', 'Steps'], ins.days.slice().reverse().map((d) => [d.label, d.steps == null ? '-' : num(d.steps)])) : '');

  // Resting heart rate
  $('take-hr').textContent = u.restingHr ? `Usually around ${u.restingHr} bpm at rest. Big jumps from normal can be worth asking about.` : 'Measured by a watch while resting.';
  lineChart($('c-hr'), {
    data: ins.days.map((d) => ({ short: short(d).split(' ')[1], value: d.restingHr, tip: `${d.label}: ${d.restingHr == null ? 'no data' : `${d.restingHr} bpm resting${d.minHr ? ` (range ${d.minHr}–${d.maxHr})` : ''}`}` })),
    typical: u.restingHr, unitLabel: 'Resting heart rate',
  });
  $('n-hr').replaceChildren(ins.hasHealth ? numbers(['Day', 'Resting', 'Low', 'High'], ins.days.slice().reverse().map((d) => [d.label, d.restingHr ?? '-', d.minHr ?? '-', d.maxHr ?? '-'])) : '');

  // Sleep
  const toH = (m) => (m == null ? null : Math.round((m / 60) * 10) / 10);
  $('take-sleep').textContent = u.sleepMinutes ? `Usually about ${hours(u.sleepMinutes)} a night.` : 'Measured by a watch worn at night.';
  columnChart($('c-sleep'), {
    data: ins.days.map((d) => ({ short: short(d).split(' ')[1], value: toH(d.sleepMinutes), tip: `Night before ${d.label}: ${d.sleepMinutes == null ? 'no data' : hours(d.sleepMinutes)}` })),
    typical: toH(u.sleepMinutes), format: (v) => `${Math.round(v * 10) / 10}h`, unitLabel: 'Sleep per night',
  });
  $('n-sleep').replaceChildren(ins.hasHealth ? numbers(['Night before', 'Sleep'], ins.days.slice().reverse().map((d) => [d.label, d.sleepMinutes == null ? '-' : hours(d.sleepMinutes)])) : '');
}

// ---------- calls & feed ----------
function renderCalls(calls, tz) {
  if (!calls.length) return $('calls').replaceChildren(el('p', { class: 'muted small' }, 'No calls yet.'));
  $('calls').replaceChildren(...calls.slice(0, 6).map((c) => {
    const [cls, label] = c.ended_at ? (OUTCOME[c.outcome] || ['', 'Ended']) : ['warn', 'Calling…'];
    return el('details', { class: 'call' },
      el('summary', {}, el('span', { class: `pill ${cls}` }, label), el('span', { class: 'when' }, fmtWhen(c.started_at, tz)),
        el('span', { class: 'when' }, c.reason === 'manual' ? '· asked by family' : c.reason === 'sensor' ? '· room sensor heard something' : c.attempt > 1 ? `· attempt ${c.attempt}` : '· phone was quiet')),
      c.summary ? el('p', { class: 'sum' }, c.summary) : null,
      c.transcript ? el('pre', { class: 'transcript' }, c.transcript.replace(/^AI:/gm, 'Haru:').replace(/^User:/gm, `${detail.senior.name}:`))
        : el('p', { class: 'small muted' }, c.ended_at ? 'No conversation recorded.' : 'Waiting for the call to finish.'));
  }));
}

function renderFeed(events, tz) {
  const list = showAllEvents ? events : events.slice(0, 8);
  $('more').classList.toggle('hidden', showAllEvents || events.length <= 8);
  $('feed').replaceChildren(...(list.length ? list.map((e) => el('div', { class: 'row' },
    el('span', { class: `dot ${e.kind}` }),
    el('div', { class: 'grow' }, el('div', {}, e.text), el('div', { class: 'when' }, fmtWhen(e.at, tz))))) : [el('p', { class: 'muted' }, 'Nothing yet.')]));
}
$('more').addEventListener('click', () => { showAllEvents = true; renderFeed(detail.events, detail.senior.timezone); });

// ---------- actions ----------
async function act(button, fn, errTarget = $('act-err')) {
  flash(errTarget, '');
  button.disabled = true;
  try {
    await fn();
    insightsAt = 0;
    await refresh(true);
  } catch (e) {
    flash(errTarget, e.message);
  } finally {
    button.disabled = false;
  }
}
$('b-ack').addEventListener('click', (e) => act(e.target, () => api('POST', `/api/incidents/${detail.status.incident.id}/ack`)));
$('b-resolve').addEventListener('click', (e) => {
  if (confirm(`Only mark this resolved once you know ${detail.senior.name} is safe. Continue?`)) {
    act(e.target, () => api('POST', `/api/incidents/${detail.status.incident.id}/resolve`));
  }
});
$('b-call').addEventListener('click', (e) => act(e.target, () => api('POST', `/api/seniors/${current}/call`)));
$('b-resume').addEventListener('click', (e) => act(e.target, () => api('POST', `/api/seniors/${current}/pause`, { until: null })));

// ---------- demo controls ----------
function renderDemo(s) {
  if (!(config.demoMode && me.role === 'admin')) return;
  $('demo').classList.remove('hidden');
  const calling = s.phase === 'calling';
  $('demo-call').classList.toggle('hidden', !calling);
  $('demo-q').textContent = `How does ${s.name} answer?`;
}
const demo = (path, body) => api('POST', `/api/demo/seniors/${current}/${path}`, body);
document.querySelectorAll('[data-demo]').forEach((b) => b.addEventListener('click', () => {
  const kind = b.dataset.demo;
  if (kind === 'reset') {
    if (!confirm('Reset the demo to its starting data?')) return;
    return act(b, async () => {
      const { seniorId } = await api('POST', '/api/demo/reset');
      location.href = `/app.html?senior=${seniorId}`;
    }, $('demo-err'));
  }
  const run = {
    ff: () => demo('fast-forward', { hours: 6 }),
    meds: () => demo('take-meds'),
    out: () => demo('location', { away: true }),
    home: () => demo('location', { away: false }),
    fall: () => demo('sensor', { kind: 'possible_fall' }),
  }[kind] || (() => demo('activity', { manual: kind === 'ok' }));
  act(b, run, $('demo-err'));
}));
document.querySelectorAll('[data-say]').forEach((b) => b.addEventListener('click', () => act(b, () => demo('answer', { userText: b.dataset.say }), $('demo-err'))));
$('say').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const userText = $('say').value;
  $('say').value = '';
  act($('say'), () => demo('answer', { userText }), $('demo-err'));
});

await start();
