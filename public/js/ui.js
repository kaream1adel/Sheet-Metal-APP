// The building blocks every screen uses. Module screens MUST use these (one design system):
//   h, fill, icon, button, pageHead, backLink, field, input helpers, formModal, confirmModal, modal,
//   toast (with undo), busy, pill, statusPill, emptyState, underConstruction, skeleton, loadInto,
//   tabs, dataTable, money / num / date formatting, balanceText / balanceCell, parsing helpers.
import { ICONS } from './icons.js';

// ---------- DOM ----------
// h('div', {class: 'x', onclick: fn}, child, 'text', [more children])
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// Like el.replaceChildren, but skips null/false and flattens arrays (as h() does).
export function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)
    .map((c) => (c instanceof Node ? c : document.createTextNode(String(c)))));
  return el;
}

// <svg> icon that takes the text colour. size: '' | 'sm' | 'lg' | 'xl' | 'spin'
export function icon(name, size = '') {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 256 256');
  s.setAttribute('class', `i ${size}`.trim());
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICONS[name] || ''; // trusted, generated at build time
  return s;
}

// button('حفظ', { kind: 'primary'|'danger'|'ghost'|'', size: 'sm'|'big'|'', icon, onClick, type, title, disabled })
// An async onClick locks the button while it runs (busy()).
export function button(label, { kind = '', size = '', icon: ic = null, onClick = null, type = 'button', title = null, disabled = false, href = null, target = null } = {}) {
  const cls = ['btn', kind, size].filter(Boolean).join(' ');
  const kids = [ic ? icon(ic) : null, label];
  if (href) return h('a', { class: cls, href, title, target, rel: target === '_blank' ? 'noopener' : null }, kids);
  const b = h('button', { class: cls, type, title, disabled, 'aria-label': label ? null : title }, kids);
  if (onClick) b.addEventListener('click', (e) => { const r = onClick(e); if (r && typeof r.then === 'function') busy(b, () => r); });
  return b;
}

// ---------- toast ----------
// action: { label, onClick } adds one button (افتح / تراجع / جرب تاني).
let toastTimer;
export function toast(msg, bad = false, { action = null, ms = null } = {}) {
  const t = document.getElementById('toast');
  const hide = () => { t.className = ''; };
  t.setAttribute('role', bad ? 'alert' : 'status');
  fill(t, h('span', {}, msg),
    action ? h('button', { class: 'toast-btn', type: 'button', onclick: () => { hide(); action.onClick(); } }, action.label) : null,
    bad ? h('button', { class: 'toast-x', type: 'button', 'aria-label': 'اقفل', onclick: hide }, icon('x')) : null);
  t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hide, ms ?? (bad ? 8000 : action ? 7000 : 2800));
}
// "اتحفظ" with تراجع: undo() runs if the user taps it within 7 seconds.
export const toastUndo = (msg, undo) => toast(msg, false, { action: { label: 'تراجع', onClick: undo } });
export const toastError = (ex) => toast(ex?.message || String(ex), true);

// Runs fn while the button shows it is working, so a second tap can't send it twice.
export async function busy(btn, fn, label = 'جاري…') {
  if (!btn || btn.disabled) return undefined;
  const old = [...btn.childNodes];
  btn.disabled = true;
  btn.classList.add('is-busy');
  btn.setAttribute('aria-busy', 'true');
  fill(btn, icon('circle-notch', 'spin'), label);
  try { return await fn(); } finally {
    btn.disabled = false;
    btn.classList.remove('is-busy');
    btn.removeAttribute('aria-busy');
    btn.replaceChildren(...old);
  }
}

// ---------- status words ----------
// ok (done/settled) · warn (needs a look / pending) · danger (must fix / overdue) · neutral · accent
export const pill = (kind, text) => h('span', { class: `pill ${kind}` }, text);
export const notice = (kind, ...content) => h('div', { class: `notice ${kind}` },
  icon(kind === 'danger' ? 'warning-circle' : kind === 'warn' ? 'warning' : kind === 'ok' ? 'check-circle' : 'info'),
  h('div', { class: 'grow' }, content));

// ---------- numbers, money, dates ----------
// Millimes (1 EGP = 1000) → "1,234.50". Western digits, 2 decimals, the third rounded half-up.
export function money(m, { unit = false } = {}) {
  if (m === null || m === undefined || Number.isNaN(m)) return '';
  const neg = m < 0;
  const p = Math.floor((Math.abs(m) + 5) / 10);
  const s = `${Math.floor(p / 100).toLocaleString('en-US')}.${String(p % 100).padStart(2, '0')}`;
  return `${neg ? '-' : ''}${s}${unit ? ' ج' : ''}`;
}
// A money value as an LTR span (keeps "-1,234.00" readable inside Arabic text).
export const moneySpan = (m) => h('span', { class: 'money' }, money(m));

// Quantities: up to 3 decimals, no trailing zeros, thousands separators.
export const num = (n, digits = 3) => (n === null || n === undefined || n === '' || Number.isNaN(Number(n))
  ? '' : Number(n).toLocaleString('en-US', { maximumFractionDigits: digits }));
export const fmtNum = num;

// Balance in words, never a bare sign: لنا عنده / له عندنا / خالص (balance = debit − credit).
export function balanceText(b) {
  const v = Number(b) || 0;
  if (v === 0) return 'خالص';
  return `${v > 0 ? 'لنا عنده' : 'له عندنا'} ${money(Math.abs(v))}`;
}
export function balanceCell(b) {
  const v = Number(b) || 0;
  if (v === 0) return h('span', { class: 'balance-chip settled' }, 'خالص');
  return h('span', { class: `balance-chip ${v > 0 ? 'owes-us' : 'we-owe'}` }, v > 0 ? 'لنا عنده ' : 'له عندنا ', moneySpan(Math.abs(v)));
}

export function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${Number(d)}/${Number(m)}/${y}`;
}
export const fmtDateTime = (iso) => (iso ? new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }) : '—');

export function todayISO(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Arabic-Indic / Persian digits → Western, ٫ → ".", ٬ → ",", for anything typed.
export const asciiDigits = (s) => String(s ?? '')
  .replace(/[٠-٩]/g, (c) => '٠١٢٣٤٥٦٧٨٩'.indexOf(c))
  .replace(/[۰-۹]/g, (c) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(c))
  .replace(/٫/g, '.').replace(/[٬،]/g, ',');

// A typed number: "١٫٥" / "2,5" / "1,234" → number. Blank → null. Invalid → NaN.
export function parseNum(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  let s = asciiDigits(v).trim().replace(/\s+/g, '').replace(/(مم|م)$/u, '');
  if (s === '') return null;
  if (/^-?\d+,\d{1,2}$/.test(s)) s = s.replace(',', '.');
  s = s.replace(/,/g, '');
  const n = Number(s);
  return /^-?(\d+\.?\d*|\.\d+)$/.test(s) && Number.isFinite(n) ? n : NaN;
}
// A typed amount in pounds → millimes (integer). Blank → null. Invalid → NaN.
export function parseMoneyInput(v) {
  const n = parseNum(typeof v === 'string' ? v.replace(/(جنيه|ج)$/u, '') : v);
  if (n === null || Number.isNaN(n)) return n;
  return Math.round(n * 1000);
}

// Arabic letter folding for search: أإآ→ا, ى→ي, ة→ه, no diacritics.
export const fold = (s) => asciiDigits(s).toLowerCase()
  .replace(/[ً-ْـ]/g, '')
  .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').trim();

// ---------- page frame ----------
// Page title, one line saying what the page is for, and its main actions.
export const pageHead = (title, sub, ...actions) => h('div', { class: 'page-head' },
  h('div', {}, h('h1', {}, title), sub ? h('div', { class: 'sub' }, sub) : null),
  actions.flat().filter(Boolean).length ? h('div', { class: 'row' }, actions) : null);

// "‹ العملاء" above a detail page's title.
export const backLink = (href, label) => h('a', { class: 'back-link', href }, icon('arrow-right', 'sm'), label);

// Nothing to show yet: say why, and what to do next. compact: inside a tab or a card.
export const emptyState = (iconName, title, hint, action = null, compact = false) => h('div', { class: `card empty${compact ? ' compact' : ''}` },
  h('div', { class: 'ic' }, icon(iconName, 'lg')), h('b', {}, title), hint ? h('div', { class: 'small' }, hint) : null,
  action ? h('div', { class: 'row', style: 'justify-content:center;margin-top:6px' }, action) : null);

// The module stubs' screen: a composed «قيد البناء» state that still says what the screen will do.
export function underConstruction(main, { title, sub = '', icon: ic = 'hammer', will = [], back = null } = {}) {
  fill(main,
    back,
    pageHead(title, sub),
    h('div', { class: 'card empty building' },
      h('div', { class: 'ic' }, icon(ic, 'lg')),
      h('b', {}, 'قيد البناء'),
      h('div', { class: 'small' }, 'الشاشة دي لسه بتتعمل. البيانات اللي بتتسجل في باقي البرنامج محفوظة وهتظهر هنا أول ما تجهز.'),
      will.length ? h('ul', { class: 'steps-list' }, will.map((w) => h('li', {}, w))) : null,
      h('div', { class: 'row', style: 'justify-content:center;margin-top:6px' }, button('الرئيسية', { href: '#/', icon: 'house' }))));
}

export const skeleton = (kind = '') => h('div', { class: `skeleton ${kind}`.trim(), 'aria-busy': 'true', 'aria-label': 'جاري التحميل' },
  h('div'), h('div'), h('div'), h('div'));

// Reloads part of a page in place: the old content dims while the new one loads, and a
// failure shows in the box with "جرب تاني" instead of leaving stale data looking current.
export async function loadInto(box, fn) {
  box.setAttribute('aria-busy', 'true');
  box.classList.add('is-loading');
  try {
    const content = await fn();
    if (content !== undefined) fill(box, content);
  } catch (ex) {
    fill(box, notice('danger', ex.message, ' ', button('جرب تاني', { size: 'sm', onClick: () => loadInto(box, fn) })));
  } finally {
    box.removeAttribute('aria-busy');
    box.classList.remove('is-loading');
  }
}

// tabs([{ key, label, icon?, href? }], current, onPick) — links when href is given.
export function tabs(items, current, onPick) {
  return h('div', { class: 'tabs', role: 'tablist' }, items.map((t) => (t.href
    ? h('a', { class: `tab${t.key === current ? ' on' : ''}`, href: t.href, role: 'tab', 'aria-selected': t.key === current ? 'true' : 'false' }, t.icon ? icon(t.icon, 'sm') : null, t.label)
    : h('button', { class: `tab${t.key === current ? ' on' : ''}`, type: 'button', role: 'tab', 'aria-selected': t.key === current ? 'true' : 'false', onclick: () => onPick?.(t.key) }, t.icon ? icon(t.icon, 'sm') : null, t.label))));
}

// A read-only table that becomes cards on the phone.
// columns: [{ label, value: (row) => text|Node, n: true (number, LTR), class }]
// opts: { onRow(row), rowClass(row), empty: Node, foot: [cells] }
export function dataTable(columns, rows, { onRow = null, rowClass = null, empty = null, foot = null } = {}) {
  if (!rows.length && empty) return empty;
  return h('div', { class: 'table-wrap' }, h('table', { class: 'cards' },
    h('thead', {}, h('tr', {}, columns.map((c) => h('th', { class: c.n ? 'n' : c.class || null }, c.label)))),
    h('tbody', {}, rows.map((r) => h('tr', {
      class: [onRow ? 'click' : '', rowClass?.(r) || ''].join(' ').trim() || null,
      onclick: onRow ? () => onRow(r) : null,
    }, columns.map((c) => h('td', { class: [c.n ? 'n' : '', c.class || ''].join(' ').trim() || null, 'data-label': c.label }, c.value(r)))))),
    foot ? h('tfoot', {}, h('tr', { class: 'sum' }, foot.map((f) => h('td', { class: f?.n ? 'n' : null }, f?.value ?? f ?? '')))) : null));
}

// ---------- forms ----------
// A labelled field: label above, help under it, error below the input. Returns the wrapper;
// .input is the control and .setError(msg) shows / clears the error.
export function field(label, control, { help = null, error = '', wide = false, id = null } = {}) {
  const cid = id || control.id || `f-${Math.random().toString(36).slice(2, 8)}`;
  control.id = cid;
  const err = h('div', { class: 'field-err', role: 'alert' }, error || '');
  const wrap = h('div', { class: `field${wide ? ' wide' : ''}${error ? ' has-err' : ''}` },
    h('label', { for: cid }, label), control, help ? h('div', { class: 'help' }, help) : null, err);
  wrap.input = control;
  wrap.setError = (msg) => { err.textContent = msg || ''; wrap.classList.toggle('has-err', !!msg); };
  control.addEventListener('input', () => wrap.setError(''));
  return wrap;
}
export const textInput = (attrs = {}) => h('input', { type: 'text', autocomplete: 'off', ...attrs });
export const numberInput = (attrs = {}) => h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', class: 'ltr', ...attrs });
export const selectInput = (options, value, attrs = {}) => h('select', attrs,
  options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value ?? '') }, l)));

// The dialog shell: Esc and the backdrop close it, focus goes back where it was.
export function modal(content, { wide = false, onClose = null } = {}) {
  const before = document.activeElement;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    back.remove();
    before?.focus?.();
    onClose?.();
  };
  const back = h('div', { class: 'modal-back', onclick: (e) => { if (e.target === back) close(); } },
    h('div', { class: `modal${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true' }, content));
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  document.body.append(back);
  return close;
}

// A dialog with a form. fields: [{ name, label, type: text|number|money|date|month|password|select|checkbox|textarea,
//   value, options: [[v, label]], help, placeholder, showIf(values), wide, required }]
// extra: a Node added under the fields (e.g. a list of checkboxes); onChange(values) on every edit.
// onSubmit(values) may throw an ApiError: its data.field (if any) marks that field, else the form error.
// The submit button locks while saving (a double tap never records twice). "رجوع" closes.
export function formModal({ title, intro = null, fields, submitLabel = 'حفظ', danger = false, wide = false, extra = null, onChange = null, onSubmit }) {
  return new Promise((resolve) => {
    const err = h('div', { class: 'err', role: 'alert' });
    const inputs = {};
    const rows = {};
    const values = () => Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.type === 'checkbox' ? el.checked : el.value]));
    const applyShowIf = () => {
      const v = values();
      for (const f of fields) if (f.showIf) rows[f.name].hidden = !f.showIf(v);
    };
    const body = fields.map((f) => {
      let input;
      const id = `fm-${f.name}`;
      if (f.type === 'select') input = selectInput(f.options, f.value, { name: f.name, id });
      else if (f.type === 'checkbox') input = h('input', { type: 'checkbox', name: f.name, id, checked: !!f.value });
      else if (f.type === 'textarea') input = h('textarea', { name: f.name, id, rows: 3, placeholder: f.placeholder || '' }, f.value ?? '');
      else if (f.type === 'number' || f.type === 'money') input = numberInput({ name: f.name, id, value: f.value ?? '', placeholder: f.placeholder || '' });
      else input = h('input', { type: f.type || 'text', name: f.name, id, value: f.value ?? '', autocomplete: 'off', placeholder: f.placeholder || '', inputmode: f.inputmode || null });
      input.addEventListener('input', () => { err.textContent = ''; applyShowIf(); onChange?.(values()); });
      input.addEventListener('change', () => { applyShowIf(); onChange?.(values()); });
      inputs[f.name] = input;
      rows[f.name] = f.type === 'checkbox'
        ? h('label', { class: `check-row${f.wide ? ' wide' : ''}`, for: id }, input, h('span', {}, f.label))
        : field(f.label, input, { help: f.help, wide: f.wide });
      return rows[f.name];
    });
    applyShowIf();
    let done = false;
    const finish = (v) => { if (done) return; done = true; close(); resolve(v); };
    const submit = h('button', { class: `btn ${danger ? 'danger solid' : 'primary'}`, type: 'submit' }, submitLabel);
    const form = h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        if (submit.disabled) return;
        err.textContent = '';
        for (const f of fields) rows[f.name].setError?.('');
        try {
          const r = await busy(submit, () => onSubmit(values()), 'جاري الحفظ…');
          finish(r ?? true);
        } catch (ex) {
          const target = ex?.data?.field && rows[ex.data.field];
          if (target?.setError) target.setError(ex.message); else err.textContent = ex.message;
        }
      },
    }, h('h2', {}, title), intro ? h('p', { class: 'muted small', style: 'margin-top:-6px' }, intro) : null,
    h('div', { class: 'form-grid' }, body, extra ? h('div', { class: 'wide' }, extra) : null), err,
    h('div', { class: 'modal-actions', style: 'margin-top:12px' }, submit, h('button', { class: 'btn', type: 'button', onclick: () => finish(null) }, 'رجوع')));
    const close = modal(form, { wide, onClose: () => { if (!done) { done = true; resolve(null); } } });
    setTimeout(() => form.querySelector('input:not([type=checkbox]),select,textarea')?.focus(), 30);
  });
}

// "Are you sure?" — the button names the action ("ألغِ الإيصال"); danger when it removes or cancels.
// withReason: asks for a reason (required) and resolves to it (or null).
export function confirmModal(title, text, okLabel = 'تمام', { danger = false, withReason = false, reasonLabel = 'السبب' } = {}) {
  if (withReason) {
    return formModal({ title, intro: text, submitLabel: okLabel, danger,
      fields: [{ name: 'reason', label: reasonLabel, type: 'textarea', wide: true }],
      onSubmit: (v) => { if (!v.reason.trim()) throw new Error('اكتب السبب'); return v.reason.trim(); } });
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; close(); resolve(v); };
    const ok = h('button', { class: `btn ${danger ? 'danger solid' : 'primary'}`, type: 'button', onclick: () => finish(true) }, okLabel);
    const close = modal([h('h2', {}, title), h('p', {}, text),
      h('div', { class: 'modal-actions' }, ok, h('button', { class: 'btn', type: 'button', onclick: () => finish(false) }, 'رجوع'))],
    { onClose: () => { if (!done) { done = true; resolve(false); } } });
    setTimeout(() => ok.focus(), 30);
  });
}
