// Shared browser helpers. All DOM text goes through textContent (el()), never innerHTML.

// Never leave a blank page: show any unexpected failure at the top of the screen.
window.addEventListener('unhandledrejection', (e) => {
  const msg = (e.reason && e.reason.message) || String(e.reason);
  if (msg === 'Please log in.') return;
  let bar = document.getElementById('fatal');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'fatal';
    bar.className = 'banner warn';
    document.body.prepend(bar);
  }
  bar.textContent = `Haru couldn't load this page: ${msg}. If you just updated Haru, close the old server window and run start.bat again.`;
});

export async function api(method, path, body) {
  const r = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && !path.startsWith('/api/login') && !location.pathname.startsWith('/login')) {
    location.href = `/login.html?next=${encodeURIComponent(location.pathname + location.search)}`;
    throw new Error('Please log in.');
  }
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}

// el('div', { class: 'x', onclick: fn }, 'text', childNode, ...)
export function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'class') n.className = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) n.append(c instanceof Node ? c : String(c));
  return n;
}

export const $ = (id) => document.getElementById(id);
export const num = (x) => (x == null ? '-' : Math.round(x).toLocaleString('en-US'));

export function fmtTime(ms, tz) {
  if (!ms) return '-';
  return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz });
}

// "3:05 PM" today, "Yesterday 3:05 PM", or "Mon, Nov 9, 3:05 PM"
export function fmtWhen(ms, tz) {
  if (!ms) return '-';
  const day = (t) => new Date(t).toLocaleDateString('en-CA', { timeZone: tz });
  const now = Date.now();
  if (day(ms) === day(now)) return `Today ${fmtTime(ms, tz)}`;
  if (day(ms) === day(now - 86400000)) return `Yesterday ${fmtTime(ms, tz)}`;
  return new Date(ms).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz });
}

export function ago(ms) {
  if (!ms) return 'never';
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} hr${h === 1 ? '' : 's'} ago`;
  return `${Math.floor(h / 24)} days ago`;
}

// Minutes after midnight -> "7:40 AM"
export function clock(min) {
  if (min == null) return '-';
  const h = Math.floor(min / 60);
  return `${((h + 11) % 12) + 1}:${String(min % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

export const hours = (min) => (min == null ? '-' : `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`);

export function flash(target, message, isError = true) {
  target.textContent = message || '';
  target.className = isError ? 'error' : 'ok-msg';
}

const LEVEL_DOT = { ok: '', warn: 'warn', bad: 'bad', paused: 'paused' };

// Header: brand, one pill per person (with a status dot), add button, account menu.
// Returns { me, config, seniors }. Redirects to login when signed out.
export async function boot(activeSeniorId) {
  const [{ user }, config, { seniors }] = await Promise.all([
    api('GET', '/api/me'), api('GET', '/api/config'), api('GET', '/api/seniors'),
  ]);
  const people = el('nav', { class: 'people', 'aria-label': 'People' },
    seniors.map((s) => el('a', { href: `/app.html?senior=${s.id}`, class: s.id === activeSeniorId ? 'on' : '' },
      el('span', { class: `sdot ${LEVEL_DOT[s.status.level]}`, title: s.status.title }), s.name)));
  const drop = el('div', { class: 'drop hidden' },
    el('div', { class: 'who' }, user.name, el('br'), user.email),
    config.telegramBot ? el('button', { onclick: connectTelegram }, user.telegramLinked ? '✓ Telegram connected (reconnect)' : 'Connect Telegram for alerts') : null,
    user.role === 'admin' ? el('a', { href: '/setup.html' }, '+ Add a loved one') : null,
    el('button', { onclick: async () => { await api('POST', '/api/logout'); location.href = '/login.html'; } }, 'Log out'));
  const menuBtn = el('button', { 'aria-haspopup': 'true', onclick: (e) => { e.stopPropagation(); drop.classList.toggle('hidden'); } }, `${user.name.split(' ')[0]} ▾`);
  document.addEventListener('click', () => drop.classList.add('hidden'));
  document.body.prepend(el('header', { class: 'top' },
    el('a', { class: 'brand', href: '/app.html' }, 'Haru'),
    people,
    user.role === 'admin' ? el('a', { class: 'btn', href: '/setup.html' }, '+ Add') : null,
    el('div', { class: 'menu' }, menuBtn, drop)));
  return { me: user, config, seniors };
}

export async function connectTelegram() {
  try {
    const { url } = await api('POST', '/api/me/telegram');
    window.open(url, '_blank', 'noopener');
    alert('Telegram is opening. Press "Start" there, then come back. You will get a confirmation message from the bot.');
  } catch (e) {
    alert(e.message);
  }
}

export function copyBox(value) {
  const input = el('input', { value, readonly: true });
  const btn = el('button', {
    type: 'button',
    onclick: async () => {
      input.select();
      try { await navigator.clipboard.writeText(value); } catch (_) { document.execCommand('copy'); }
      btn.textContent = 'Copied ✓';
    },
  }, 'Copy');
  return el('div', { class: 'copy' }, input, btn);
}
