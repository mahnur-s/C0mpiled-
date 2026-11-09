import { api, $, flash } from './common.js';

const next = new URLSearchParams(location.search).get('next');
const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : '/app.html';

$('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  flash($('err'), '');
  try {
    await api('POST', '/api/login', { email: $('email').value, password: $('password').value });
    location.href = safeNext;
  } catch (err) {
    flash($('err'), err.message);
  }
});

// Demo servers only: one click into a sample family with two weeks of history.
fetch('/api/config').then((r) => r.json()).then((c) => {
  if (!c.demoMode) return;
  $('demo').classList.remove('hidden');
  $('b-demo').addEventListener('click', async () => {
    $('b-demo').disabled = true;
    try {
      const { seniorId } = await api('POST', '/api/demo/start');
      location.href = `/app.html?senior=${seniorId}`;
    } catch (err) {
      flash($('demo-err'), err.message);
      $('b-demo').disabled = false;
    }
  });
}).catch(() => {});
