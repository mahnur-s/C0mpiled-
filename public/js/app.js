import { api, el, $, boot, fmtWhen, ago, flash } from './common.js';

const { me, config } = await boot('app');
const params = new URLSearchParams(location.search);
let seniors = [];
let current = null; // selected senior id
let detail = null;

const OUTCOME = {
  ok: ['ok', 'Fine'], concern: ['warn', 'Needs attention'], emergency: ['bad', 'Emergency'],
  no_answer: ['warn', 'No answer'],
};

// ---------- Telegram ----------
if (!me.telegramLinked && config.telegramBot) $('tg-note').classList.remove('hidden');
$('tg-connect').addEventListener('click', async () => {
  try {
    const { url } = await api('POST', '/api/me/telegram');
    window.open(url, '_blank', 'noopener');
    $('tg-note').firstElementChild.textContent = 'In Telegram, press Start. Then refresh this page.';
  } catch (e) {
    $('tg-note').firstElementChild.textContent = e.message;
  }
});

// ---------- rendering ----------
function renderTabs() {
  const tabs = $('tabs');
  tabs.replaceChildren(...(seniors.length > 1 ? seniors.map((s) => el('a', {
    href: `?senior=${s.id}`,
    class: s.id === current ? 'on' : '',
    onclick: (e) => { e.preventDefault(); select(s.id); },
  }, s.name, s.status.level === 'bad' ? ' 🚨' : s.status.level === 'warn' ? ' ⚠️' : '')) : []));
}

function render() {
  const { senior: s, status, device, family, events, calls } = detail;
  const tz = s.timezone;
  $('status').className = `status ${status.level}`;
  $('st-t').textContent = `${s.name}'s status`;
  $('st-h').textContent = status.title;
  $('st-s').textContent = status.text;

  const inc = status.incident;
  $('b-ack').classList.toggle('hidden', !inc || !!inc.acked_at);
  $('b-resolve').classList.toggle('hidden', !inc);
  $('st-ack').classList.toggle('hidden', !inc || !inc.acked_at);
  if (inc && inc.acked_at) {
    $('st-ack').textContent = `${inc.acked_by_name || 'Someone'} is handling this (since ${fmtWhen(inc.acked_at, tz)}).`;
  }

  const paused = s.pausedUntil && s.pausedUntil > Date.now();
  $('pause-box').classList.toggle('hidden', !!paused);
  $('b-resume').classList.toggle('hidden', !paused);
  $('b-call').disabled = s.phase === 'calling' || s.phase === 'retry';
  $('b-phone').href = `tel:${s.phone}`;
  $('b-phone').textContent = `Call ${s.name} (${s.phone})`;

  $('m-last').textContent = s.lastActive ? ago(s.lastActive) : 'None yet';
  $('m-last-n').textContent = s.lastActive ? fmtWhen(s.lastActive, tz) : 'Waiting for the phone app';
  const lastCall = calls.find((c) => c.ended_at);
  $('m-check').textContent = s.lastCheckin ? ago(s.lastCheckin) : 'None yet';
  $('m-check-n').textContent = lastCall ? `${OUTCOME[lastCall.outcome] ? OUTCOME[lastCall.outcome][1] : lastCall.outcome}, ${fmtWhen(lastCall.ended_at, tz)}` : '';
  $('m-dev').textContent = device.id ? (device.battery != null ? `${device.battery}% battery` : 'Paired') : 'Not paired';
  $('m-dev-n').textContent = device.id ? `Last heard ${ago(device.last_seen)}. ${device.usage_access === 0 ? 'Usage Access is OFF.' : ''}` : device.note;

  $('feed').replaceChildren(...(events.length ? events.map((e) => el('div', { class: 'row' },
    el('span', { class: `dot ${e.kind}` }),
    el('div', {}, el('div', {}, e.text), el('div', { class: 'when' }, fmtWhen(e.at, tz))))) : [el('p', { class: 'muted' }, 'Nothing yet.')]));

  $('calls').replaceChildren(...(calls.length ? calls.map((c) => {
    const [cls, label] = c.ended_at ? (OUTCOME[c.outcome] || ['', c.outcome || 'Ended']) : ['warn', 'In progress'];
    return el('details', {},
      el('summary', {}, el('span', { class: `pill ${cls}` }, label), ' ', fmtWhen(c.started_at, tz),
        c.reason === 'manual' ? el('span', { class: 'muted small' }, ' · requested') : '',
        c.attempt > 1 ? el('span', { class: 'muted small' }, ` · attempt ${c.attempt}`) : ''),
      c.summary ? el('p', { class: 'small' }, c.summary) : null,
      c.transcript ? el('pre', { class: 'transcript' }, c.transcript) : el('p', { class: 'small muted' }, c.ended_at ? 'No transcript.' : 'Waiting for the call to finish.'));
  }) : [el('p', { class: 'muted' }, 'No calls yet.')]));

  $('family').replaceChildren(...(family.length ? family.map((f) => el('div', { class: 'row' },
    el('div', {}, f.name, f.relationship ? el('span', { class: 'muted' }, ` · ${f.relationship}`) : ''),
    el('span', { class: `pill ${f.telegramLinked ? 'ok' : 'warn'}` }, f.telegramLinked ? 'Gets alerts' : 'No Telegram')))
    : [el('p', { class: 'muted small' }, 'No family members yet, so alerts reach no one. Invite someone from the Admin page.')]));
  const hours = Math.round((s.inactivityMinutes / 60) * 10) / 10;
  $('settings').textContent = `Haru calls if there's no phone activity for ${hours} hours`
    + (s.quietStart === s.quietEnd ? ', at any time of day.' : `, but not during quiet hours (${s.quietStart}–${s.quietEnd}, ${tz}).`);
}

async function refresh() {
  if (!current) return;
  try {
    detail = await api('GET', `/api/seniors/${current}`);
    render();
  } catch (e) {
    flash($('act-err'), e.message);
  }
}

async function select(id) {
  current = id;
  history.replaceState(null, '', `?senior=${id}`);
  renderTabs();
  await refresh();
  $('dash').classList.remove('hidden');
}

// ---------- actions ----------
async function act(button, fn) {
  flash($('act-err'), '');
  button.disabled = true;
  try {
    await fn();
    await refresh();
  } catch (e) {
    flash($('act-err'), e.message);
  } finally {
    button.disabled = false;
  }
}
$('b-ack').addEventListener('click', (e) => act(e.target, () => api('POST', `/api/incidents/${detail.status.incident.id}/ack`)));
$('b-resolve').addEventListener('click', (e) => {
  if (confirm(`Mark this resolved? Only do this once you know ${detail.senior.name} is safe.`)) {
    act(e.target, () => api('POST', `/api/incidents/${detail.status.incident.id}/resolve`));
  }
});
$('b-call').addEventListener('click', (e) => act(e.target, () => api('POST', `/api/seniors/${current}/call`)));
$('b-pause').addEventListener('click', (e) => {
  const days = Number($('pause-len').value);
  if (!confirm(`Pause monitoring for ${days} day(s)? Haru won't call or alert anyone until then.`)) return;
  act(e.target, () => api('POST', `/api/seniors/${current}/pause`, { until: Date.now() + days * 86400000 }));
});
$('b-resume').addEventListener('click', (e) => act(e.target, () => api('POST', `/api/seniors/${current}/pause`, { until: null })));

// ---------- start ----------
seniors = (await api('GET', '/api/seniors')).seniors;
if (!seniors.length) {
  $('empty').textContent = me.role === 'admin'
    ? 'No one is set up yet. Go to Admin to add the first person.'
    : 'You are not linked to anyone yet. Ask your Haru admin for an invite.';
  $('empty').classList.remove('hidden');
} else {
  const wanted = Number(params.get('senior'));
  await select(seniors.some((s) => s.id === wanted) ? wanted : seniors[0].id);
  setInterval(async () => {
    if (document.hidden) return;
    seniors = (await api('GET', '/api/seniors')).seniors;
    renderTabs();
    refresh();
  }, 10000);
}
