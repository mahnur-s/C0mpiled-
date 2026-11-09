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
