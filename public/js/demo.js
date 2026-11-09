import { api, el, $, boot, fmtTime, fmtWhen, ago, flash } from './common.js';

const { me, config } = await boot('demo');
if (me.role !== 'admin' || !config.demoMode) location.href = '/app.html';

let current = null;
const show = (v) => ['v-home', 'v-ring'].forEach((id) => $(id).classList.toggle('hidden', id !== v));

async function run(fn) {
  flash($('err'), '');
  try {
    await fn();
  } catch (e) {
    flash($('err'), e.message);
  }
  refresh();
}

async function refresh() {
  if (!current) return;
  const d = await api('GET', `/api/seniors/${current}`);
  const s = d.senior;
  const tz = s.timezone;
  $('p-time').textContent = fmtTime(Date.now(), tz);
  $('p-clock').textContent = fmtTime(Date.now(), tz).replace(/ (AM|PM)/, '');
  $('greet').textContent = `Hello, ${s.name}`;
  $('p-last').textContent = `Last active: ${ago(s.lastActive)}`;
  $('ring-quote').textContent = `"Hi ${s.name}, this is Haru. I noticed you haven't used your phone for a while. Are you okay?"`;
  show(s.phase === 'calling' ? 'v-ring' : 'v-home');
  $('status').className = `status ${d.status.level}`;
  $('st-h').textContent = d.status.title;
  $('st-s').textContent = d.status.text;
  $('dash-link').href = `/app.html?senior=${s.id}`;
  $('feed').replaceChildren(...d.events.slice(0, 15).map((e) => el('div', { class: 'row' },
    el('span', { class: `dot ${e.kind}` }), el('div', {}, el('div', {}, e.text), el('div', { class: 'when' }, fmtWhen(e.at, tz))))));
}

const base = () => `/api/demo/seniors/${current}`;
$('b-use').addEventListener('click', () => run(() => api('POST', `${base()}/activity`, {})));
$('b-ok').addEventListener('click', () => run(() => api('POST', `${base()}/activity`, { manual: true })));
$('b-ff').addEventListener('click', () => run(() => api('POST', `${base()}/fast-forward`, { hours: 6 })));
$('b-ff1').addEventListener('click', () => run(() => api('POST', `${base()}/fast-forward`, { hours: 0.25 })));
document.querySelectorAll('[data-say]').forEach((b) => b.addEventListener('click', () => run(() => api('POST', `${base()}/answer`, { userText: b.dataset.say }))));
$('say').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const userText = $('say').value;
  $('say').value = '';
  run(() => api('POST', `${base()}/answer`, { userText }));
});

const { seniors } = await api('GET', '/api/seniors');
if (!seniors.length) flash($('err'), 'Add a person on the Admin page first.');
$('who').replaceChildren(...seniors.map((s) => el('option', { value: s.id }, s.name)));
$('who').addEventListener('change', () => { current = Number($('who').value); refresh(); });
if (seniors.length) {
  current = seniors[0].id;
  refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, 3000);
}
