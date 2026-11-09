// Shared browser helpers. All DOM text goes through textContent (el()), never innerHTML.

// Never leave a blank page: show any unexpected failure at the top of the screen.
window.addEventListener('unhandledrejection', (e) => {
  const msg = (e.reason && e.reason.message) || String(e.reason);
  if (msg === 'Please log in.') return;
  let bar = document.getElementById('fatal');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'fatal';
    bar.className = 'note warn';
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

export function fmtTime(ms, tz) {
  if (!ms) return '-';
  return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz });
}

// "3:05 PM" today, "Yesterday 3:05 PM", or "Mon, Nov 9, 3:05 PM"
export function fmtWhen(ms, tz) {
  if (!ms) return '-';
  const day = (t) => new Date(t).toLocaleDateString('en-CA', { timeZone: tz });
  const now = Date.now();
  if (day(ms) === day(now)) return fmtTime(ms, tz);
  if (day(ms) === day(now - 86400000)) return `Yesterday ${fmtTime(ms, tz)}`;
  return new Date(ms).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz });
}

export function ago(ms) {
  if (!ms) return 'never';
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`;
  return `${Math.floor(h / 24)} days ago`;
}

export function flash(target, message, isError = true) {
  target.textContent = message || '';
  target.className = isError ? 'error' : 'muted small';
}

// Header with nav; returns { me, config }. Redirects to login when signed out.
export async function boot(active) {
  const [{ user }, config] = await Promise.all([api('GET', '/api/me'), api('GET', '/api/config')]);
  const link = (href, text, key) => el('a', { href, class: key === active ? 'on' : '' }, text);
  const nav = el('nav', {},
    link('/app.html', 'Dashboard', 'app'),
    user.role === 'admin' ? link('/admin.html', 'Admin', 'admin') : null,
    user.role === 'admin' && config.demoMode ? link('/demo.html', 'Simulator', 'demo') : null,
    el('span', { class: 'muted small' }, user.name),
    el('button', { onclick: async () => { await api('POST', '/api/logout'); location.href = '/login.html'; } }, 'Log out'));
  document.body.prepend(el('header', { class: 'top' },
    el('a', { class: 'brand', href: '/app.html' }, 'Haru', el('span', {}, 'family safety net')), nav));
  return { me: user, config };
}

export function copyBox(value) {
  const input = el('input', { value, readonly: true });
  const btn = el('button', {
    onclick: async () => {
      input.select();
      try { await navigator.clipboard.writeText(value); btn.textContent = 'Copied'; } catch (_) { document.execCommand('copy'); }
    },
  }, 'Copy');
  return el('div', { class: 'copy' }, input, btn);
}
