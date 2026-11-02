// Shared pieces of the reports screens: a linked stat, a linked line (label + amount),
// accessible bars, a filter bar and the "as of" date picker.
import { h, icon, money, field, fmtDate, todayISO } from '../ui.js';

// A big number that opens its source.
export const linkStat = (label, amount, href, { kind = '', sub = null, raw = null, words = false } = {}) => h(href ? 'a' : 'div',
  { class: `stat ${kind}${words ? ' words' : ''}`.trim(), href: href || null }, h('span', {}, label), h('b', { class: 'money' }, raw ?? money(amount)), sub ? h('small', {}, sub) : null);

// One line of a breakdown: icon, label, amount — the whole line is the link.
export const line = (label, amount, href, { ic = null, kind = '', extra = null, raw = null } = {}) => h(href ? 'a' : 'div',
  { class: `rp-line ${kind}`.trim(), href: href || null },
  h('span', { class: 'what' }, ic ? icon(ic, 'sm') : null, h('span', {}, label), extra),
  h('span', { class: 'amt' }, raw ?? money(amount)));

export const cardHead = (title, ...actions) => h('div', { class: 'rp-card-head' }, h('h3', {}, title), h('div', { class: 'row' }, actions));

// Horizontal bars (RTL), one per row: label · bar · value. Values are text too, so a screen
// reader reads them; the list has an accessible name. rows: [{ label, value, text, on }]
export function bars(rows, { label }) {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  return h('ul', { class: 'rp-bars', 'aria-label': label }, rows.map((r) => h('li', { class: `rp-bar${r.value < 0 ? ' neg' : ''}${r.on ? ' on' : ''}` },
    h('span', {}, r.label),
    h('span', { class: 'track', 'aria-hidden': 'true' }, h('span', { class: 'fill', style: `display:block;width:${Math.round((Math.abs(r.value) / max) * 100)}%` })),
    h('span', { class: 'v' }, r.text))));
}

export const filters = (...fields) => h('div', { class: 'rp-filters no-print' }, fields);

export function dateFilter(label, value, onChange, { type = 'date' } = {}) {
  const input = h('input', { type, value: value || '' });
  input.addEventListener('change', () => onChange(input.value));
  const f = field(label, input);
  f.input = input;
  return f;
}

export const asOfLabel = (d) => (d && d !== todayISO() ? `لحد ${fmtDate(d)}` : 'النهارده');

// "N days" in Arabic, short.
export function daysText(n) {
  if (n === null || n === undefined) return '—';
  if (n === 0) return 'النهارده';
  if (n === 1) return 'يوم';
  if (n === 2) return 'يومين';
  if (n >= 3 && n <= 10) return `${n} أيام`;
  return `${n} يوم`;
}
