// Settings for one person. Every caregiver: pause monitoring, medicines, their own alerts.
// Admins also: details, home location, phone and room sensor, family, remove.
import { api, el, $, boot, flash, fmtWhen, connectTelegram } from './common.js';
import { detailsForm, phonePanel, medsEditor, familyPanel } from './people.js';

const id = Number(new URLSearchParams(location.search).get('senior'));
const { me, config } = await boot(id);
let detail = await api('GET', `/api/seniors/${id}`);
const s = detail.senior;
const admin = me.role === 'admin';
document.title = `Settings for ${s.name} · Haru`;
$('title').textContent = `Settings for ${s.name}`;
$('sub').textContent = admin ? 'You can change everything here.' : 'Some settings can only be changed by the person who set up Haru.';
$('back').href = `/app.html?senior=${id}`;

const sections = [];
function section(key, title, lead, ...content) {
  sections.push([key, title]);
  return el('section', { class: 'card set', id: key }, el('h2', {}, title), lead ? el('p', { class: 'small muted lead' }, lead) : null, ...content);
}

// ---------- monitoring / pause ----------
function pauseBox() {
  const box = el('div');
  const err = el('p', { class: 'error' });
  const render = () => {
    const paused = s.pausedUntil && s.pausedUntil > Date.now();
    const choose = el('select', { id: 'p-len', 'aria-label': 'Pause for' },
      [['1', '1 day'], ['3', '3 days'], ['7', '1 week'], ['14', '2 weeks']].map(([v, t]) => el('option', { value: v }, t)));
    box.replaceChildren(
      paused
        ? el('p', {}, `Paused until ${fmtWhen(s.pausedUntil, s.timezone)}. Haru won't call ${s.name} or send alerts until then.`)
        : el('p', {}, `Haru calls ${s.name} if there's no sign of activity for ${Math.round(s.inactivityMinutes / 6) / 10} hours, except between ${s.quietStart} and ${s.quietEnd}.`),
      el('div', { class: 'actions mt' }, paused
        ? el('button', { class: 'primary', onclick: () => pause(null) }, 'Resume monitoring now')
        : [el('span', {}, 'Away or in hospital? Pause for'), el('span', { class: 'inline' }, choose), el('button', { onclick: () => pause(Date.now() + Number(choose.value) * 86400000) }, 'Pause')]),
      err);
  };
  async function pause(until) {
    try {
      await api('POST', `/api/seniors/${id}/pause`, { until });
      s.pausedUntil = until;
      render();
    } catch (e) {
      flash(err, e.message);
    }
  }
  render();
  return box;
}

// ---------- home & location ----------
function homeBox() {
  const box = el('div');
  const err = el('p', { class: 'error' });
  const radius = el('select', { id: 'h-radius', 'aria-label': 'Counts as home within' },
    [[100, '100 m (a flat or small house)'], [150, '150 m (house and garden)'], [300, '300 m (a big plot)'], [500, '500 m (a farm or estate)']]
      .map(([v, t]) => el('option', { value: v }, t)));
  radius.value = String(s.homeRadiusM || 150);
  async function setHome(source) {
    flash(err, '');
    try {
      await api('POST', `/api/seniors/${id}/home`, { source, radius: Number(radius.value) });
      detail = await api('GET', `/api/seniors/${id}`);
      Object.assign(s, detail.senior);
      render();
      flash(err, source === 'radius' ? 'Saved ✓' : 'Home location saved ✓', false);
    } catch (e) {
      flash(err, e.message);
    }
  }
  function render() {
    const loc = detail.location;
    const home = loc && loc.home;
    box.replaceChildren(...[
      el('p', {}, s.homeSet
        ? `Home is set${home ? '' : ''}. The dashboard shows "At home" when ${s.name}'s phone is within ${s.homeRadiusM} m of it.`
        : `Home isn't set yet, so Haru can't tell "at home" from "out".`),
      home ? el('iframe', { class: 'map small-map', title: 'Home on a map', loading: 'lazy', src: osmEmbed(home.lat, home.lng, 0.004) }) : null,
      el('div', { class: 'actions mt' },
        el('button', { onclick: () => setHome('address'), disabled: !s.address }, 'Find their address on the map'),
        el('button', { onclick: () => setHome('phone') }, 'Use where the phone is now')),
      el('p', { class: 'hint' }, 'Use "where the phone is now" while the phone is at home if the address lookup lands in the wrong spot.'),
      el('label', { for: 'h-radius' }, 'Counts as home within'),
      el('div', { class: 'actions' }, el('span', { class: 'inline' }, radius), el('button', { onclick: () => setHome('radius') }, 'Save')),
      err,
      detail.device.id && detail.device.location_access !== 1
        ? el('p', { class: 'small muted mt' }, `${s.name}'s phone isn't sharing its location. Open the Haru app on their phone and tap "Share where you are" (only if they agree).`)
        : null,
    ].filter(Boolean));
  }
  render();
  return box;
}

const osmEmbed = (lat, lng, d) => `https://www.openstreetmap.org/export/embed.html?bbox=${lng - d},${lat - d / 2},${lng + d},${lat + d / 2}&layer=mapnik&marker=${lat},${lng}`;

// ---------- my alerts ----------
function alertsBox() {
  return el('div', {},
    el('p', {}, me.telegramLinked ? '✓ Telegram is connected. Haru messages you there if something is wrong or a medicine dose is missed.' : 'Connect Telegram to get alerts on your phone.'),
    config.telegramBot ? el('div', { class: 'actions mt' }, el('button', { class: me.telegramLinked ? '' : 'primary', onclick: connectTelegram }, me.telegramLinked ? 'Reconnect Telegram' : 'Connect Telegram')) : el('p', { class: 'small muted' }, 'Telegram is not set up on this server yet.'));
}

const blocks = [
  section('monitoring', 'Check-ins', 'Haru calls when the day looks unusually quiet, and alerts family if something is wrong.', pauseBox()),
  section('medicine', 'Medicine', `Reminders on ${s.name}'s phone and a daily record you can see on the dashboard.`, medsEditor({ seniorId: id, seniorName: s.name })),
  section('alerts', 'My alerts', null, alertsBox()),
];
if (admin) {
  blocks.push(
    section('location', 'Home & location', `Location is only shared if ${s.name} allowed it on their phone. It's kept for 30 days.`, homeBox()),
    section('about', `About ${s.name}`, null, detailsForm({
      senior: s,
      onSaved: async () => { Object.assign(s, (await api('GET', `/api/seniors/${id}`)).senior); },
    })),
    section('devices', 'Phone & room sensor', null,
      el('h3', {}, `${s.name}'s phone`), phonePanel({ seniorId: id, seniorName: s.name, kind: 'phone' }),
      el('h3', { class: 'mt' }, 'Room sensor'),
      el('p', { class: 'small muted' }, 'A spare phone or tablet that notices movement and sounds like a fall or smoke alarm. Video and audio never leave it.'),
      phonePanel({ seniorId: id, seniorName: s.name, kind: 'room' })),
    section('family', 'Family & caregivers', 'Everyone here can see the dashboard and gets alerts once they connect Telegram.', familyPanel({ seniorId: id, seniorName: s.name })),
    section('remove', `Stop using Haru for ${s.name}`, null,
      el('p', { class: 'small' }, 'Deletes their details, history, medicine records and locations. This cannot be undone.'),
      el('button', {
        class: 'danger mt',
        onclick: async () => {
          if (prompt(`Type ${s.name} to delete everything Haru has about them.`) !== s.name) return;
          await api('DELETE', `/api/admin/seniors/${id}`);
          location.href = '/app.html';
        },
      }, `Delete ${s.name} from Haru`)),
  );
} else {
  blocks.push(section('about', `About ${s.name}`, null,
    el('dl', { class: 'facts' },
      el('dt', {}, 'Phone'), el('dd', {}, s.phone),
      el('dt', {}, 'Home'), el('dd', {}, s.address || '—'),
      el('dt', {}, 'Time zone'), el('dd', {}, s.timezone.replace('_', ' '))),
    el('p', { class: 'small muted' }, 'To change these, ask the person who set up Haru for your family.')));
}

$('toc').replaceChildren(...sections.map(([k, t]) => el('a', { href: `#${k}` }, t)));
$('sections').replaceChildren(...blocks);
if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
