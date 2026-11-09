// "Add a loved one": details -> their devices -> medicine -> family. Admins only.
// The step and person live in the URL, so a refresh (or coming back later) resumes where you were.
import { api, el, $ } from './common.js';
import { boot } from './common.js';
import { detailsForm, phonePanel, medsEditor, familyPanel } from './people.js';

const params = new URLSearchParams(location.search);
const { me } = await boot(null);
if (me.role !== 'admin') location.replace('/app.html');

const STEPS = ['About them', 'Phone & sensors', 'Medicine', 'Family'];
let seniorId = Number(params.get('senior')) || null;
let step = seniorId ? Math.min(Math.max(Number(params.get('step')) || 1, 1), 3) : 0;
let senior = null;

function go(n) {
  step = n;
  history.replaceState(null, '', seniorId ? `?senior=${seniorId}&step=${n}` : location.pathname);
  render();
}

const nav = (back, next, nextLabel = 'Continue', nextPrimary = true) => el('div', { class: 'form-actions wizard-nav' },
  back != null ? el('button', { type: 'button', onclick: () => go(back) }, '← Back') : null,
  el('span', { class: 'grow' }),
  el('button', { type: 'button', class: nextPrimary ? 'primary' : '', onclick: next }, nextLabel));

async function render() {
  $('steps').replaceChildren(...STEPS.map((s, i) => el('div', { class: `s${i === step ? ' on' : i < step ? ' done' : ''}` }, `${i + 1}. ${s}`)));
  if (seniorId && !senior) senior = (await api('GET', `/api/seniors/${seniorId}`)).senior;
  const n = senior ? senior.name : 'them';
  if (senior) $('title').textContent = `Setting up Haru for ${n}`;
  const body = $('body');

  if (step === 0) {
    body.replaceChildren(
      el('p', { class: 'lead' }, 'Who is Haru looking out for? Haru notices when their day looks unusual, calls them to check in, and tells you if they need help.'),
      detailsForm({
        submitLabel: 'Save and continue',
        onSaved: (id) => { seniorId = id; senior = null; go(1); },
      }));
  } else if (step === 1) {
    body.replaceChildren(
      el('div', { class: 'card' },
        el('h3', {}, `${n}'s phone`),
        el('p', { class: 'small muted mt-s' }, `Haru learns ${n}'s daily rhythm from when the phone is used, reminds them about medicine, and (if they agree) shares whether they're home.`),
        phonePanel({ seniorId, seniorName: n, kind: 'phone' })),
      el('div', { class: 'card mt' },
        el('h3', {}, 'Room sensor ', el('span', { class: 'pill' }, 'optional')),
        el('p', { class: 'small muted mt-s' },
          `A spare Android phone or tablet in the living room notices movement and sounds such as a fall or a smoke alarm, and can tell Haru to call straight away. `,
          el('b', {}, 'Video and sound never leave the device'), ': it only sends numbers like "moving about" or "loud thud at 3:12 PM".'),
        phonePanel({ seniorId, seniorName: n, kind: 'room' })),
      nav(0, () => go(2), 'Continue'),
      el('p', { class: 'small muted' }, 'No phone handy? Continue anyway; you can connect it later in Settings.'));
  } else if (step === 2) {
    body.replaceChildren(
      el('div', { class: 'card' },
        el('h3', {}, `${n}'s medicines`),
        el('p', { class: 'small muted mt-s' }, `Their phone shows a reminder with an "I took it" button. You see what was taken, and Haru tells you if a dose is still missing two hours later.`),
        medsEditor({ seniorId, seniorName: n })),
      nav(1, () => go(3), 'Continue'));
  } else {
    body.replaceChildren(
      el('div', { class: 'card' },
        el('h3', {}, 'Who should hear from Haru?'),
        el('p', { class: 'small muted mt-s' }, `Invite the people who can act if ${n} needs help. Each gets their own login and connects Telegram for alerts.`),
        familyPanel({ seniorId, seniorName: n })),
      nav(2, () => { location.href = `/app.html?senior=${seniorId}`; }, `Done: open ${n}'s dashboard`));
  }
}

render();
