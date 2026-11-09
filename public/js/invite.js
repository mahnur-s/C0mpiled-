import { api, $, flash } from './common.js';

// The token lives in the URL fragment so it is never sent to the server in logs or Referer headers.
const token = location.hash.slice(1);

async function load() {
  try {
    const inv = await api('GET', `/api/invites/${encodeURIComponent(token)}`);
    $('intro').textContent = `Hi ${inv.name}. You've been invited to look out for ${inv.seniorName} with Haru.`;
    $('email').value = inv.email;
    if (inv.existingAccount) {
      $('pw-block').classList.add('hidden');
      $('go').textContent = `Add ${inv.seniorName} to my account`;
    }
    $('f').classList.remove('hidden');
  } catch (e) {
    $('bad-msg').textContent = e.message;
    $('bad').classList.remove('hidden');
  } finally {
    $('loading').classList.add('hidden');
  }
}

$('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  flash($('err'), '');
  try {
    const r = await api('POST', `/api/invites/${encodeURIComponent(token)}/accept`, { password: $('password').value });
    history.replaceState(null, '', '/invite.html');
    location.href = r.needsLogin ? '/login.html' : '/app.html?welcome=1';
  } catch (err) {
    flash($('err'), err.message);
  }
});

if (token) load();
else {
  $('loading').classList.add('hidden');
  $('bad-msg').textContent = 'This page needs the full invite link. Open the link you were sent.';
  $('bad').classList.remove('hidden');
}
