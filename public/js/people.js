// Building blocks shared by the setup wizard and the settings page: the person's details form,
// connecting their phone, and inviting family. Admin-only APIs; family members never see these.
import { api, el, ago, flash, copyBox } from './common.js';

const US_ZONES = [
  ['America/New_York', 'Eastern'], ['America/Chicago', 'Central'], ['America/Denver', 'Mountain'],
  ['America/Phoenix', 'Arizona'], ['America/Los_Angeles', 'Pacific'], ['America/Anchorage', 'Alaska'], ['Pacific/Honolulu', 'Hawaii'],
];

function timezoneSelect(value) {
  const all = Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : [];
  const us = US_ZONES.map(([z]) => z);
  const sel = el('select', { id: 'd-tz' },
    el('optgroup', { label: 'United States' }, US_ZONES.map(([z, name]) => el('option', { value: z }, `${name} (${z.replace('_', ' ')})`))),
    el('optgroup', { label: 'Everywhere else' }, all.filter((z) => !us.includes(z)).map((z) => el('option', { value: z }, z.replace('_', ' ')))));
  sel.value = value;
  if (sel.value !== value) sel.value = 'America/New_York';
  return sel;
}

const field = (id, label, input, hint) => el('div', {}, el('label', { for: id }, label), input, hint ? el('p', { class: 'hint' }, hint) : null);

/**
 * Name, phone, timezone, address, when to call, quiet hours. With no `senior`, it creates one
 * (and asks for consent). onSaved(id) runs after a successful save.
 */
export function detailsForm({ senior = null, submitLabel = 'Save', onSaved }) {
  const s = senior || {};
  const guessTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const name = el('input', { id: 'd-name', required: true, maxlength: 80, placeholder: 'Margaret', value: s.name || '', autocomplete: 'off' });
  const phone = el('input', { id: 'd-phone', required: true, placeholder: '+1 415 555 1234', inputmode: 'tel', value: s.phone || '' });
  const tz = timezoneSelect(s.timezone || (guessTz && guessTz.startsWith('America/') ? guessTz : 'America/New_York'));
  const address = el('input', { id: 'd-addr', maxlength: 200, placeholder: '123 Main St, Springfield, IL', value: s.address || '' });
  const hours = el('select', { id: 'd-hours' }, [2, 3, 4, 6, 8, 12, 24].map((h) => el('option', { value: h * 60 }, `${h} hours`)));
  hours.value = String(s.inactivityMinutes || 240);
  if (hours.value !== String(s.inactivityMinutes || 240)) {
    hours.append(el('option', { value: s.inactivityMinutes }, `${Math.round(s.inactivityMinutes / 6) / 10} hours`));
    hours.value = String(s.inactivityMinutes);
  }
  const qs = el('input', { id: 'd-qs', type: 'time', value: s.quietStart || '22:00' });
  const qe = el('input', { id: 'd-qe', type: 'time', value: s.quietEnd || '07:00' });
  const consent = el('input', { type: 'checkbox', id: 'd-consent' });
  const err = el('p', { class: 'error' });
  const save = el('button', { class: 'primary', type: 'submit' }, submitLabel);

  const form = el('form', { class: 'card', novalidate: false },
    field('d-name', 'Their name (what Haru calls them on the phone)', name),
    field('d-phone', 'Their phone number', phone, 'The number Haru calls to check in. US numbers start with +1.'),
    field('d-tz', 'Where they live (time zone)', tz),
    field('d-addr', 'Home address', address, 'Only shared with family in an alert, so someone can go round or tell 911.'),
    field('d-hours', 'Call them if the phone is unused for', hours, 'Pick something longer than a usual nap or outing. 4 hours suits most people.'),
    el('div', { class: 'row2' }, field('d-qs', "Don't call between", qs), field('d-qe', 'and', qe)),
    el('p', { class: 'hint' }, 'At night Haru waits until morning instead of calling. Set both times the same to allow calls at any hour.'),
    senior ? null : el('label', { class: 'check mt' }, consent,
      el('span', {}, `They know about Haru and agreed to it: their phone use is watched, and Haru may call them to check in.`)),
    el('div', { class: 'form-actions' }, save),
    err);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    flash(err, '');
    if (!senior && !consent.checked) return flash(err, `Please confirm ${name.value.trim() || 'they'} agreed to Haru first. Monitoring someone without their agreement isn't allowed.`);
    const body = {
      name: name.value, phone: phone.value, timezone: tz.value, address: address.value,
      inactivityMinutes: Number(hours.value), quietStart: qs.value, quietEnd: qe.value,
    };
    save.disabled = true;
    try {
      let id = senior && senior.id;
      if (senior) await api('PUT', `/api/admin/seniors/${id}`, body);
      else ({ id } = await api('POST', '/api/admin/seniors', { ...body, consent: true }));
      if (senior) flash(err, 'Saved ✓', false);
      await onSaved?.(id);
    } catch (x) {
      flash(err, x.message);
    } finally {
      save.disabled = false;
    }
  });
  return form;
}

const DEVICE_COPY = {
  phone: (n) => ({
    none: 'Android phone',
    steps: [
      `Install the Haru app on ${n}'s own Android phone (the APK from your GitHub build).`,
      `Open it, choose "This is ${n}'s own phone" and type in the pairing code below.`,
      'Follow the app: turn on "Usage access", medicine reminders, and (if they agree) location.',
    ],
    first: 'Get a pairing code', another: 'Connect another phone', disconnect: `Haru will stop seeing when ${n} uses it.`,
  }),
  room: (n) => ({
    none: 'Room sensor',
    steps: [
      'Take a spare Android phone or tablet and install the Haru app on it.',
      `Prop it up in the room ${n} uses most, facing the room, and keep it plugged in.`,
      'Open the app, choose "This is a room sensor" and type in the pairing code below.',
    ],
    first: 'Get a room sensor code', another: 'Connect another room sensor', disconnect: 'Haru will stop watching that room.',
  }),
};

/**
 * Pairing the Android app (the senior's phone, or a spare device as a room sensor): connected devices,
 * or a code to type into the app. Polls while a code is showing; onConnected() when a device appears.
 */
export function phonePanel({ seniorId, seniorName, kind = 'phone', onConnected }) {
  const copy = DEVICE_COPY[kind](seniorName);
  const box = el('div');
  let timer = null;
  let known = null;
  const mine = (d) => d.devices.filter((x) => (x.kind || 'phone') === kind);

  async function load() {
    const devices = mine(await api('GET', `/api/admin/seniors/${seniorId}`));
    if (known !== null && devices.length > known) {
      clearInterval(timer);
      timer = null;
      onConnected?.();
    }
    known = devices.length;
    render(devices);
  }

  function render(devices, code) {
    const list = devices.map((dev) => el('div', { class: 'row' },
      el('span', { class: `dot ${dev.usage_access === 0 || Date.now() - dev.last_seen > 2 * 3600000 ? 'warn' : 'ok'}` }),
      el('div', { class: 'grow' }, dev.model || copy.none,
        el('div', { class: 'small muted' }, `Checked in ${ago(dev.last_seen)}`,
          dev.battery != null ? ` · battery ${dev.battery}%` : '', dev.usage_access === 0 ? ' · Usage access is OFF' : '',
          kind === 'phone' ? (dev.location_access === 1 ? ' · sharing location' : dev.location_access === 0 ? ' · location off' : '') : '')),
      el('button', {
        class: 'linkish',
        onclick: async () => {
          if (!confirm(`Disconnect ${dev.model || 'this device'}? ${copy.disconnect}`)) return;
          await api('DELETE', `/api/admin/devices/${dev.id}`);
          known = null;
          load();
        },
      }, 'Disconnect')));
    const codeBox = code ? el('div', { class: 'pair' },
      el('p', { class: 'small muted' }, 'Pairing code'),
      el('p', { class: 'code' }, `${code.code.slice(0, 3)} ${code.code.slice(3)}`),
      el('p', { class: 'small muted' }, 'Works once, for one hour. ', el('span', { class: 'waiting' }, 'Waiting for the device…'))) : null;
    box.replaceChildren(
      ...list,
      ...(devices.length ? [] : [el('ol', { class: 'how' }, copy.steps.map((x) => el('li', {}, x)))]),
      codeBox || el('button', { class: devices.length || kind === 'room' ? '' : 'primary', type: 'button', onclick: getCode }, devices.length ? copy.another : copy.first));
  }

  async function getCode() {
    const code = await api('POST', `/api/admin/seniors/${seniorId}/pairing-code`);
    const devices = mine(await api('GET', `/api/admin/seniors/${seniorId}`));
    known = devices.length;
    render(devices, code);
    clearInterval(timer);
    timer = setInterval(() => { if (!document.hidden) load().catch(() => {}); }, 3000);
    setTimeout(() => { clearInterval(timer); timer = null; }, 60 * 60000);
  }

  load();
  return box;
}

/** Medicine list with dose times. Any caregiver linked to the person can edit it. */
export function medsEditor({ seniorId, seniorName, onChange }) {
  const box = el('div');
  const err = el('p', { class: 'error' });
  let editing = null;

  const timeRow = (value = '08:00') => {
    const row = el('span', { class: 'time-chip' },
      el('input', { type: 'time', value, 'aria-label': 'Time of day', required: true }),
      el('button', { type: 'button', class: 'linkish', 'aria-label': 'Remove this time', onclick: () => row.remove() }, '×'));
    return row;
  };

  function form(m) {
    const name = el('input', { id: 'm-name', required: true, maxlength: 80, placeholder: 'Metformin', value: m ? m.name : '' });
    const dose = el('input', { id: 'm-dose', maxlength: 60, placeholder: '500 mg', value: m ? m.dose : '' });
    const notes = el('input', { id: 'm-notes', maxlength: 200, placeholder: 'With food', value: m ? m.instructions : '' });
    const times = el('div', { class: 'times' }, (m ? m.times : ['08:00']).map(timeRow));
    const f = el('form', { class: 'med-form' },
      el('div', { class: 'row2' },
        el('div', {}, el('label', { for: 'm-name' }, 'Medicine'), name),
        el('div', {}, el('label', { for: 'm-dose' }, 'Dose'), dose)),
      el('label', {}, 'Times of day'),
      el('div', { class: 'actions' }, times, el('button', { type: 'button', onclick: () => times.append(timeRow('20:00')) }, '+ Add a time')),
      el('label', { for: 'm-notes' }, 'Notes (optional)'), notes,
      el('div', { class: 'form-actions' },
        el('button', { class: 'primary', type: 'submit' }, m ? 'Save changes' : 'Add medicine'),
        el('button', { type: 'button', onclick: () => { editing = null; load(); } }, 'Cancel')),
      err);
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      flash(err, '');
      const body = { name: name.value, dose: dose.value, instructions: notes.value, times: [...times.querySelectorAll('input')].map((i) => i.value) };
      try {
        if (m) await api('PUT', `/api/seniors/${seniorId}/meds/${m.id}`, body);
        else await api('POST', `/api/seniors/${seniorId}/meds`, body);
        editing = null;
        await load();
        onChange?.();
      } catch (x) {
        flash(err, x.message);
      }
    });
    return f;
  }

  const to12 = (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  };

  async function load() {
    const { medications } = await api('GET', `/api/seniors/${seniorId}/meds`);
    const rows = medications.map((m) => (editing === m.id ? form(m) : el('div', { class: 'row' },
      el('span', { class: 'pill-ico', 'aria-hidden': 'true' }, '💊'),
      el('div', { class: 'grow' }, el('b', {}, m.name), m.dose ? ` ${m.dose}` : '',
        el('div', { class: 'small muted' }, m.times.map(to12).join(' · '), m.instructions ? ` — ${m.instructions}` : '')),
      el('button', { class: 'linkish', onclick: () => { editing = m.id; load(); } }, 'Edit'),
      el('button', {
        class: 'linkish',
        onclick: async () => {
          if (!confirm(`Stop reminding ${seniorName} about ${m.name}? Past doses stay in the history.`)) return;
          await api('DELETE', `/api/seniors/${seniorId}/meds/${m.id}`);
          await load();
          onChange?.();
        },
      }, 'Remove'))));
    box.replaceChildren(
      ...(rows.length ? rows : [el('p', { class: 'muted small' }, `No medicines yet. Add each one with the times ${seniorName} takes it; their phone will remind them and you'll see what was taken.`)]),
      editing === 'new' ? form(null) : el('button', { type: 'button', class: 'mt', onclick: () => { editing = 'new'; load(); } }, '+ Add a medicine'));
  }

  load();
  return box;
}

/** Family members who get alerts: current list, pending invites, and an invite form. */
export function familyPanel({ seniorId, seniorName }) {
  const list = el('div');
  const out = el('div', { class: 'hidden' });
  const err = el('p', { class: 'error' });
  const name = el('input', { id: 'f-name', required: true, maxlength: 80 });
  const rel = el('input', { id: 'f-rel', maxlength: 40, placeholder: 'daughter' });
  const email = el('input', { id: 'f-email', type: 'email', required: true });

  async function load() {
    const d = await api('GET', `/api/admin/seniors/${seniorId}`);
    const rows = [
      ...d.family.map((f) => el('div', { class: 'row' },
        el('span', { class: `dot ${f.telegramLinked ? 'ok' : 'warn'}` }),
        el('div', { class: 'grow' }, f.name, f.relationship ? el('span', { class: 'muted' }, ` · ${f.relationship}`) : '',
          el('div', { class: 'small muted' }, f.email, f.telegramLinked ? ' · gets alerts on Telegram' : ' · hasn’t connected Telegram, so gets no alerts yet')),
        el('button', {
          class: 'linkish',
          onclick: async () => {
            if (!confirm(`Remove ${f.name}? They will stop seeing ${seniorName} and stop getting alerts.`)) return;
            await api('DELETE', `/api/admin/seniors/${seniorId}/family/${f.id}`);
            load();
          },
        }, 'Remove'))),
      ...d.invites.map((i) => el('div', { class: 'row muted' }, el('span', { class: 'dot' }),
        el('div', { class: 'grow' }, `${i.name} (${i.email})`, el('div', { class: 'small' }, 'Invited, hasn’t joined yet')))),
    ];
    list.replaceChildren(...(rows.length ? rows : [el('p', { class: 'muted small' }, `No one yet. Invite at least one person who can act quickly if ${seniorName} needs help.`)]));
  }

  const form = el('form', {},
    el('div', { class: 'row2' },
      el('div', {}, el('label', { for: 'f-name' }, 'Their name'), name),
      el('div', {}, el('label', { for: 'f-rel' }, `Relation to ${seniorName}`), rel)),
    el('label', { for: 'f-email' }, 'Email'), email,
    el('div', { class: 'form-actions' }, el('button', { type: 'submit' }, 'Create invite link')),
    err);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    flash(err, '');
    try {
      const r = await api('POST', `/api/admin/seniors/${seniorId}/invites`, { name: name.value, email: email.value, relationship: rel.value });
      out.replaceChildren(el('p', { class: 'small' }, `Send this link to ${name.value} by text or email. It works once, for ${r.expiresInDays} days.`), copyBox(r.url));
      out.classList.remove('hidden');
      form.reset();
      load();
    } catch (x) {
      flash(err, x.message);
    }
  });

  load();
  return el('div', {}, list, el('div', { class: 'mt' }, form, out));
}
