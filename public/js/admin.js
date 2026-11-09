import { api, el, $, boot, ago, flash, copyBox } from './common.js';

const { me } = await boot('admin');
if (me.role !== 'admin') location.href = '/app.html';

let seniors = [];
let editing = null; // senior object or null for "new"

// Timezone picker: common US zones first, then everything else.
const US = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu'];
const all = Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : US;
$('timezone').replaceChildren(
  el('optgroup', { label: 'United States' }, US.map((z) => el('option', { value: z }, z))),
  el('optgroup', { label: 'All' }, all.filter((z) => !US.includes(z)).map((z) => el('option', { value: z }, z))));

const LEVEL = { ok: 'ok', warn: 'warn', bad: 'bad', paused: 'paused' };

async function loadList() {
  seniors = (await api('GET', '/api/seniors')).seniors;
  $('list-empty').classList.toggle('hidden', seniors.length > 0);
  $('list').replaceChildren(...seniors.map((s) => el('tr', {
    class: `pick${editing && editing.id === s.id ? ' sel' : ''}`,
    onclick: () => open(s),
  },
  el('td', {}, s.name, el('div', { class: 'small muted' }, s.phone)),
  el('td', {}, el('span', { class: `pill ${LEVEL[s.status.level]}` }, s.status.title)),
  el('td', { class: 'small' }, s.lastActive ? `Active ${ago(s.lastActive)}` : 'No activity yet'),
  el('td', {}, el('a', { href: `/app.html?senior=${s.id}`, onclick: (e) => e.stopPropagation() }, 'Dashboard')))));
}

function fill(s) {
  $('name').value = s ? s.name : '';
  $('phone').value = s ? s.phone : '';
  $('timezone').value = s ? s.timezone : (Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York');
  $('address').value = s ? s.address : '';
  $('hours').value = s ? s.inactivityMinutes / 60 : 4;
  $('qs').value = s ? s.quietStart : '22:00';
  $('qe').value = s ? s.quietEnd : '07:00';
  $('consent').checked = false;
}

async function open(s) {
  editing = s;
  fill(s);
  flash($('f-err'), '');
  $('f-title').textContent = s ? `Settings for ${s.name}` : 'Add a person';
  $('consent-row').classList.toggle('hidden', !!s);
  $('b-del').classList.toggle('hidden', !s);
  $('extras').classList.toggle('hidden', !s);
  $('pair-out').classList.add('hidden');
  $('inv-out').classList.add('hidden');
  $('panel').classList.remove('hidden');
  await loadList();
  if (s) await loadExtras();
  $('panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function loadExtras() {
  const d = await api('GET', `/api/admin/seniors/${editing.id}`);
  $('devices').replaceChildren(...d.devices.map((dev) => el('div', { class: 'row' },
    el('div', {}, dev.model || 'Android phone',
      el('div', { class: 'small muted' }, `Last heard ${ago(dev.last_seen)}`,
        dev.battery != null ? ` · battery ${dev.battery}%` : '', dev.usage_access === 0 ? ' · Usage Access OFF' : '')),
    el('button', {
      class: 'link',
      onclick: async () => {
        if (!confirm('Disconnect this phone? Haru will stop seeing its activity.')) return;
        await api('DELETE', `/api/admin/devices/${dev.id}`);
        loadExtras();
      },
    }, 'Disconnect'))));
  $('family').replaceChildren(
    ...d.family.map((f) => el('div', { class: 'row' },
      el('div', {}, f.name, f.relationship ? el('span', { class: 'muted' }, ` · ${f.relationship}`) : '',
        el('div', { class: 'small muted' }, f.email, f.telegramLinked ? ' · Telegram connected' : ' · no Telegram yet')),
      el('button', {
        class: 'link',
        onclick: async () => {
          if (!confirm(`Remove ${f.name}? They will stop seeing ${editing.name} and stop getting alerts.`)) return;
          await api('DELETE', `/api/admin/seniors/${editing.id}/family/${f.id}`);
          loadExtras();
        },
      }, 'Remove'))),
    ...d.invites.map((i) => el('div', { class: 'row muted' }, el('div', {}, `${i.name} (${i.email})`, el('div', { class: 'small' }, 'Invite not accepted yet')))),
  );
  if (!d.family.length && !d.invites.length) $('family').replaceChildren(el('p', { class: 'muted small' }, 'No family yet. Invite at least one person who will get alerts.'));
}

$('b-new').addEventListener('click', () => open(null));

$('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  flash($('f-err'), '');
  const body = {
    name: $('name').value,
    phone: $('phone').value,
    timezone: $('timezone').value,
    address: $('address').value,
    inactivityMinutes: Math.round(Number($('hours').value) * 60),
    quietStart: $('qs').value,
    quietEnd: $('qe').value,
  };
  try {
    if (editing) {
      await api('PUT', `/api/admin/seniors/${editing.id}`, body);
    } else {
      const { id } = await api('POST', '/api/admin/seniors', { ...body, consent: $('consent').checked });
      editing = { id };
    }
    await loadList();
    await open(seniors.find((s) => s.id === editing.id));
    flash($('f-err'), 'Saved.', false);
  } catch (err) {
    flash($('f-err'), err.message);
  }
});

$('b-del').addEventListener('click', async () => {
  if (!confirm(`Delete ${editing.name} and all their history? This cannot be undone.`)) return;
  await api('DELETE', `/api/admin/seniors/${editing.id}`);
  editing = null;
  $('panel').classList.add('hidden');
  loadList();
});

$('b-pair').addEventListener('click', async () => {
  const r = await api('POST', `/api/admin/seniors/${editing.id}/pairing-code`);
  $('pair-code').textContent = r.code;
  $('pair-exp').textContent = `Valid for 1 hour, once. Server: ${r.serverUrl}`;
  $('pair-out').classList.remove('hidden');
});

$('inv').addEventListener('submit', async (e) => {
  e.preventDefault();
  flash($('i-err'), '');
  try {
    const r = await api('POST', `/api/admin/seniors/${editing.id}/invites`, {
      name: $('i-name').value, email: $('i-email').value, relationship: $('i-rel').value,
    });
    $('inv-link').replaceChildren(copyBox(r.url));
    $('inv-out').classList.remove('hidden');
    $('inv').reset();
    loadExtras();
  } catch (err) {
    flash($('i-err'), err.message);
  }
});

await loadList();
