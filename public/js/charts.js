// Small SVG charts: columns, a line, and a day x hour heatmap. One series each, so no legend boxes;
// the card title names the measure. Every chart has a hover tooltip and a "Show numbers" table.
import { el } from './common.js';

const NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs = {}, text) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
}

function niceMax(v) {
  if (!v || v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * p).find((m) => m >= v);
}
const compact = (v) => (v >= 10000 ? `${Math.round(v / 1000)}K` : Math.round(v).toLocaleString('en-US'));

function withTooltip(box) {
  const tip = el('div', { class: 'tip hidden' });
  box.append(tip);
  return {
    show(evt, text) {
      const r = box.getBoundingClientRect();
      tip.textContent = text;
      tip.classList.remove('hidden');
      const x = Math.min(Math.max(evt.clientX - r.left, 70), r.width - 70);
      tip.style.left = `${x}px`;
      tip.style.top = `${evt.clientY - r.top}px`;
    },
    hide() { tip.classList.add('hidden'); },
  };
}

function numbers(headers, rows) {
  return el('details', { class: 'numbers' }, el('summary', {}, 'Show numbers'),
    el('table', {}, el('thead', {}, el('tr', {}, headers.map((h) => el('th', {}, h)))),
      el('tbody', {}, rows.map((r) => el('tr', {}, r.map((c) => el('td', {}, c)))))));
}

// Column path: 4px rounded data-end, square at the baseline.
function column(x, y, w, h) {
  const r = Math.min(4, h, w / 2);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/** data: [{ label, short, value, partial, tip }]; typical: number|null */
export function columnChart(box, { data, typical, format = compact, unitLabel, max: fixedMax }) {
  box.replaceChildren();
  if (!data.some((d) => d.value != null)) return box.append(el('div', { class: 'nodata' }, 'No data yet.'));
  const W = 640, H = 190, L = 44, R = 70, T = 12, B = 26;
  const pw = W - L - R, ph = H - T - B;
  const max = fixedMax || niceMax(Math.max(...data.map((d) => d.value || 0), typical || 0) * 1.08);
  const y = (v) => T + ph - (v / max) * ph;
  const band = pw / data.length;
  const bw = Math.min(24, band * 0.62);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': unitLabel });
  for (const v of [max / 2, max]) {
    svg.append(s('line', { class: 'grid', x1: L, x2: L + pw, y1: y(v), y2: y(v) }));
    svg.append(s('text', { x: L - 8, y: y(v) + 4, 'text-anchor': 'end' }, format(v)));
  }
  svg.append(s('text', { x: L - 8, y: y(0) + 4, 'text-anchor': 'end' }, '0'));
  const tt = withTooltip(box);
  data.forEach((d, i) => {
    const cx = L + band * i + band / 2;
    if (d.value != null && d.value > 0) {
      const top = y(d.value);
      svg.append(s('path', { class: `bar${d.partial ? ' partial' : ''}`, d: column(cx - bw / 2, top, bw, y(0) - top) }));
    }
    if (i % 2 === (data.length - 1) % 2) svg.append(s('text', { x: cx, y: H - 8, 'text-anchor': 'middle' }, d.short));
    const hit = s('rect', { class: 'hit', x: L + band * i, y: T, width: band, height: ph });
    const hl = s('rect', { class: 'hl', x: L + band * i + 2, y: T, width: band - 4, height: ph, rx: 4 });
    hit.addEventListener('mousemove', (e) => { hl.classList.add('on'); tt.show(e, d.tip); });
    hit.addEventListener('mouseleave', () => { hl.classList.remove('on'); tt.hide(); });
    svg.append(hl, hit);
  });
  svg.append(s('line', { class: 'base', x1: L, x2: L + pw, y1: y(0), y2: y(0) }));
  if (typical) {
    svg.append(s('line', { class: 'typical', x1: L, x2: L + pw, y1: y(typical), y2: y(typical) }));
    svg.append(s('text', { class: 'typ', x: L + pw + 6, y: y(typical) + 4 }, `usual ${format(typical)}`));
  }
  // Direct-label only the latest value.
  const last = data[data.length - 1];
  if (last.value != null) svg.append(s('text', { class: 'typ', x: L + band * (data.length - 0.5), y: y(last.value) - 6, 'text-anchor': 'middle' }, format(last.value)));
  box.append(svg);
}

/** data: [{ label, short, value, tip }]; a 2px line with an end marker, no baseline at zero. */
export function lineChart(box, { data, typical, format = (v) => String(v), unitLabel }) {
  box.replaceChildren();
  const vals = data.map((d) => d.value).filter((v) => v != null);
  if (vals.length < 2) return box.append(el('div', { class: 'nodata' }, vals.length ? 'Need a few more days of data.' : 'No data yet.'));
  const W = 640, H = 170, L = 44, R = 70, T = 14, B = 26;
  const pw = W - L - R, ph = H - T - B;
  let lo = Math.min(...vals, typical ?? Infinity) - 4;
  let hi = Math.max(...vals, typical ?? -Infinity) + 4;
  lo = Math.floor(lo / 5) * 5;
  hi = Math.ceil(hi / 5) * 5;
  const y = (v) => T + ph - ((v - lo) / (hi - lo)) * ph;
  const step = pw / (data.length - 1);
  const x = (i) => L + step * i;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': unitLabel });
  for (const v of [lo, Math.round((lo + hi) / 2), hi]) {
    svg.append(s('line', { class: 'grid', x1: L, x2: L + pw, y1: y(v), y2: y(v) }));
    svg.append(s('text', { x: L - 8, y: y(v) + 4, 'text-anchor': 'end' }, format(v)));
  }
  if (typical) {
    svg.append(s('line', { class: 'typical', x1: L, x2: L + pw, y1: y(typical), y2: y(typical) }));
    svg.append(s('text', { class: 'typ', x: L + pw + 6, y: y(typical) + 4 }, `usual ${format(typical)}`));
  }
  let d = '';
  data.forEach((p, i) => {
    if (p.value == null) return;
    const prev = i > 0 && data[i - 1].value != null;
    d += `${prev ? 'L' : 'M'}${x(i)},${y(p.value)}`;
  });
  svg.append(s('path', { class: 'line', d }));
  const tt = withTooltip(box);
  data.forEach((p, i) => {
    if (i % 2 === (data.length - 1) % 2) svg.append(s('text', { x: x(i), y: H - 8, 'text-anchor': 'middle' }, p.short));
    if (p.value == null) return;
    const dot = s('circle', { class: 'dot', cx: x(i), cy: y(p.value), r: 4, opacity: i === data.length - 1 || data.slice(i + 1).every((q) => q.value == null) ? 1 : 0 });
    const hit = s('rect', { class: 'hit', x: x(i) - step / 2, y: T, width: step, height: ph });
    hit.addEventListener('mousemove', (e) => { dot.setAttribute('opacity', 1); tt.show(e, p.tip); });
    hit.addEventListener('mouseleave', () => { if (dot.dataset.end !== '1') dot.setAttribute('opacity', 0); tt.hide(); });
    if (dot.getAttribute('opacity') === '1') {
      dot.dataset.end = '1';
      svg.append(s('text', { class: 'typ', x: x(i), y: y(p.value) - 10, 'text-anchor': 'middle' }, format(p.value)));
    }
    svg.append(dot, hit);
  });
  box.append(svg);
}

const phoneText = (label, h, c, hourName) => (c
  ? `${label}, ${hourName(h)}–${hourName((h + 1) % 24)}: phone used (${c * 15 > 45 ? 'most of the hour' : `about ${c * 15} min`})`
  : `${label}, ${hourName(h)}: no phone use`);

/** rows: [{ label, hours: [24 levels 0..4] }]; describe(label, hour, value, hourName) -> tooltip */
export function heatmap(box, { rows, describe = phoneText, ariaLabel = 'Phone use by hour, last 7 days', legend = 'More phone use', level = (c) => Math.min(c, 4) }) {
  box.replaceChildren();
  const W = 640, L = 78, T = 4, B = 22, gap = 0;
  const cw = (W - L - 6) / 24;
  const ch = 22;
  const H = T + rows.length * (ch + gap) + B;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': ariaLabel });
  const tt = withTooltip(box);
  const hourName = (h) => `${((h + 11) % 12) + 1} ${h < 12 ? 'AM' : 'PM'}`;
  rows.forEach((r, ri) => {
    const yy = T + ri * (ch + gap);
    svg.append(s('text', { x: L - 10, y: yy + ch / 2 + 4, 'text-anchor': 'end' }, r.label));
    r.hours.forEach((c, h) => {
      const cell = s('rect', { class: `cell c${level(c)}`, x: L + h * cw, y: yy, width: cw, height: ch, rx: 3 });
      const text = describe(r.label, h, c, hourName);
      cell.addEventListener('mousemove', (e) => tt.show(e, text));
      cell.addEventListener('mouseleave', () => tt.hide());
      svg.append(cell);
    });
  });
  [[0, '12 AM'], [6, '6 AM'], [12, 'Noon'], [18, '6 PM']].forEach(([h, t]) => {
    svg.append(s('text', { x: L + h * cw + 2, y: H - 6 }, t));
  });
  box.append(svg);
  box.append(el('div', { class: 'legend' }, 'Less', ...[0, 1, 2, 3, 4].map((c) => el('span', { class: `sw c${c}` })), legend));
}

export { numbers };
