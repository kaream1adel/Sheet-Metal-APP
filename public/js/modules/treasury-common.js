// Pieces shared by the treasury screens: the module's few extra styles (on top of app.css, with
// its tokens), a party picker that knows aliases, segmented choices, money / date fields,
// a phone photo shrinker, the print-size switch, and status pills.
import { h, fill, icon, field, numberInput, selectInput, money, fold, todayISO, balanceText, parseMoneyInput, busy } from '../ui.js';
import { get } from '../api.js';
import { amountWords } from './treasury-words.js';

// ---------- styles (scoped to .tr-*) ----------
const CSS = `
.tr-seg { display: inline-flex; flex-wrap: wrap; gap: 4px; padding: 3px; background: var(--surface-3); border-radius: 10px; }
.tr-seg button { border: 0; background: transparent; color: var(--text-2); font: inherit; font-size: 14px; padding: 0 12px; min-height: 32px; border-radius: 8px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
.tr-seg button.on { background: var(--surface); color: var(--accent); font-weight: 600; box-shadow: 0 1px 2px rgba(16,24,40,.08); }
.tr-seg button:active { transform: scale(.98); }
.tr-form { max-width: 860px; }
.tr-form .card + .card { margin-top: 14px; }
.tr-form h3 { margin: 0 0 12px; font-size: 15px; }
.tr-amount input { font-size: 20px; height: 48px; font-weight: 600; }
.tr-words { font-size: 13px; color: var(--muted); min-height: 18px; }
.tr-calc { background: var(--cell-computed); border-radius: 8px; padding: 0 12px; min-height: var(--tap); display: flex; align-items: center; justify-content: flex-end; direction: ltr; font-variant-numeric: tabular-nums; font-weight: 600; }
.tr-calc.bad { background: var(--red-soft); color: var(--red); }
.tr-calc.good { background: var(--green-soft); color: var(--green); }
.tr-calc.warn { background: var(--yellow-soft); color: var(--yellow); }
.tr-hint { font-size: 13px; color: var(--muted); }
.tr-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-start; margin-top: 16px; }
.tr-day { margin-bottom: 14px; }
.tr-day-head { display: flex; flex-wrap: wrap; gap: 6px 18px; align-items: baseline; padding: 10px 14px; background: var(--surface-2); border: 1px solid var(--border); border-bottom: 0; border-radius: var(--radius) var(--radius) 0 0; font-size: 13px; color: var(--text-2); }
.tr-day-head b { font-size: 14px; color: var(--text); margin-inline-end: auto; }
.tr-day .table-wrap { border-radius: 0 0 var(--radius) var(--radius); }
.tr-in { color: var(--green); }
.tr-out { color: var(--red); }
.tr-week { margin-bottom: 16px; }
.tr-week.now .tr-day-head { background: var(--accent-soft); border-color: var(--accent-line); }
.tr-row-actions { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.tr-photo { max-width: 100%; max-height: 420px; border-radius: 8px; border: 1px solid var(--border); display: block; }
.tr-thumb { width: 72px; height: 72px; object-fit: cover; border-radius: 8px; border: 1px solid var(--border); }
.tr-kv { display: grid; grid-template-columns: 160px minmax(0, 1fr); gap: 8px 14px; font-size: 14px; }
.tr-kv dt { color: var(--muted); }
.tr-kv dd { margin: 0; }
.tr-alerts { display: grid; gap: 8px; margin-bottom: 14px; }
.tr-toolbar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 14px; }
.tr-filters { display: grid; gap: 10px 12px; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); align-items: end; margin-bottom: 14px; }
.tr-cats { display: grid; gap: 6px; }
.tr-cats div { display: flex; justify-content: space-between; gap: 12px; font-size: 14px; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
/* the printed document */
.tr-paper { background: #fff; color: #000; border: 1px solid var(--border); border-radius: 6px; padding: 28px 32px; max-width: 760px; margin: 0 auto; position: relative; }
.tr-paper.half { max-width: 760px; min-height: 0; }
.tr-paper .ph { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #000; padding-bottom: 10px; margin-bottom: 16px; }
.tr-paper .ph .co b { font-size: 22px; display: block; }
.tr-paper .ph .co span { font-size: 12px; color: #444; }
.tr-paper .ph .doc { text-align: left; font-size: 13px; }
.tr-paper .ph .doc b { font-size: 17px; display: block; text-align: right; }
.tr-paper .line { display: flex; gap: 10px; align-items: baseline; margin: 10px 0; font-size: 15px; }
.tr-paper .line .k { color: #444; white-space: nowrap; }
.tr-paper .line .v { flex: 1; border-bottom: 1px dotted #777; padding-bottom: 2px; min-height: 22px; }
.tr-paper .big { font-size: 20px; font-weight: 700; direction: ltr; display: inline-block; border: 2px solid #000; padding: 4px 14px; border-radius: 4px; }
.tr-paper table { width: 100%; border-collapse: collapse; margin: 10px 0; font-size: 13px; }
.tr-paper th, .tr-paper td { border: 1px solid #999; padding: 5px 8px; }
.tr-paper .sign { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin-top: 36px; font-size: 13px; text-align: center; }
.tr-paper .sign div { border-top: 1px solid #000; padding-top: 6px; }
.tr-paper .void { position: absolute; inset: 40% 0 auto; text-align: center; font-size: 64px; font-weight: 700; color: rgba(180, 35, 24, .25); transform: rotate(-18deg); pointer-events: none; }
@media (max-width: 820px) {
  .tr-seg button { min-height: 44px; padding: 0 14px; }
  .tr-row-actions .btn.sm, .tr-toolbar .btn.sm, .tr-actions .btn { min-height: 44px; }
  .tr-kv { grid-template-columns: 1fr; gap: 2px; }
  .tr-kv dd { margin-bottom: 8px; }
  .tr-paper { padding: 16px; }
  .tr-paper .sign { grid-template-columns: 1fr 1fr; }
  .tr-actions .btn { flex: 1 1 auto; }
}
@media print {
  .tr-paper { border: 0; padding: 0; max-width: none; }
  .tr-noprint { display: none !important; }
}
`;
let styled = false;
export function useStyles() {
  if (styled) return;
  styled = true;
  document.head.append(h('style', { id: 'treasury-css' }, CSS));
}

// The page size of the next print: A4 or half a page (A5).
export function setPrintSize(size) {
  let s = document.getElementById('treasury-page');
  if (!s) { s = h('style', { id: 'treasury-page' }); document.head.append(s); }
  s.textContent = size === 'half' ? '@media print { @page { size: A5; margin: 8mm; } body { font-size: 11px; } }' : '';
}

// ---------- choices ----------
// seg([[value, label, icon?]], value, onChange) — a row of buttons, one selected (radio group).
export function seg(options, value, onChange, { label = '' } = {}) {
  let cur = value;
  const wrap = h('div', { class: 'tr-seg', role: 'radiogroup', 'aria-label': label || null });
  const draw = () => fill(wrap, options.map(([v, l, ic]) => h('button', {
    type: 'button', role: 'radio', class: String(v) === String(cur) ? 'on' : null, 'aria-checked': String(v) === String(cur) ? 'true' : 'false',
    onclick: () => { if (String(v) === String(cur)) return; cur = v; draw(); onChange?.(v); },
  }, ic ? icon(ic, 'sm') : null, l)));
  draw();
  wrap.get = () => cur;
  wrap.set = (v) => { cur = v; draw(); };
  return wrap;
}

// ---------- parties ----------
const cache = new Map();
export async function partiesOf(kind) {
  if (!cache.has(kind)) cache.set(kind, get('/api/parties', { kind }).then((r) => r.parties).catch((e) => { cache.delete(kind); throw e; }));
  return cache.get(kind);
}
export const forgetParties = () => cache.clear();

// A typed name (or alias) chosen from a list. field.getId() → id or null; .setKind(kind).
// opts: { label, kind, value (id), onPick(party), help, optional }
export function partyPicker({ label, kind, value = null, onPick = null, help = null, optional = false, placeholder = 'اكتب الاسم…' }) {
  const listId = `tr-dl-${Math.random().toString(36).slice(2, 8)}`;
  const input = h('input', { type: 'text', list: listId, autocomplete: 'off', placeholder });
  const dl = h('datalist', { id: listId });
  let list = [];
  let picked = null;
  const f = field(label, input, { help });
  f.append(dl);
  const resolve = () => {
    const v = fold(input.value);
    if (!v) { picked = null; return null; }
    picked = list.find((p) => fold(p.name) === v) || list.find((p) => p.aliases.some((a) => fold(a) === v)) || null;
    return picked;
  };
  input.addEventListener('change', () => {
    const p = resolve();
    if (p && input.value !== p.name) input.value = p.name;
    if (!p && input.value.trim()) f.setError('الاسم ده مش متسجل — اختار من القايمة أو ضيفه الأول من صفحة الأطراف');
    onPick?.(p);
  });
  const load = async (k) => {
    kind = k;
    list = await partiesOf(k);
    fill(dl, list.map((p) => h('option', { value: p.name }, p.aliases.length ? p.aliases.join('، ') : null)));
  };
  f.ready = load(kind).then(() => {
    if (value) {
      const p = list.find((x) => x.id === Number(value));
      if (p) { input.value = p.name; picked = p; onPick?.(p); }
    }
  }).catch(() => f.setError('مقدرتش أجيب الأسماء — حدّث الصفحة'));
  f.setKind = async (k) => { input.value = ''; picked = null; await load(k); };
  f.getId = () => (resolve()?.id ?? null);
  f.getParty = () => resolve();
  f.require = (msg) => {
    const id = f.getId();
    if (!id && !optional) { f.setError(input.value.trim() ? 'الاسم ده مش متسجل' : msg); input.focus(); }
    return id;
  };
  f.clear = () => { input.value = ''; picked = null; };
  return f;
}

// ---------- fields ----------
export function dateField(label, value = todayISO(), opts = {}) {
  return field(label, h('input', { type: 'date', value: value || '' }), opts);
}

// An amount in pounds with its words under it. .millimes() → integer, NaN or null.
export function amountField(label = 'المبلغ', { value = '', big = true, words = true, help = null } = {}) {
  const input = numberInput({ value, placeholder: '0.00' });
  const w = h('div', { class: 'tr-words' });
  const f = field(label, input, { help });
  if (big) f.classList.add('tr-amount');
  if (words) f.insertBefore(w, f.querySelector('.field-err'));
  const update = () => {
    const m = parseMoneyInput(input.value);
    w.textContent = m && !Number.isNaN(m) && m > 0 ? amountWords(m) : '';
  };
  input.addEventListener('input', update);
  update();
  f.millimes = () => parseMoneyInput(input.value);
  return f;
}

export const textField = (label, value = '', opts = {}) => field(label, h('input', { type: 'text', value, autocomplete: 'off' }), opts);
export const areaField = (label, value = '', opts = {}) => field(label, h('textarea', { rows: 2 }, value), opts);
export const selectField = (label, options, value, opts = {}) => field(label, selectInput(options, value), opts);

// Maps a server error to its field (data.field) or the form's error line.
// After a failed check: bring the first marked input (or the form error) into view and focus it,
// so on a phone the manager sees what to fix instead of a button that seems to do nothing.
export function revealError(root, formErr) {
  const bad = root.querySelector('.has-err');
  const target = bad || (formErr?.textContent ? formErr : null);
  if (!target) return;
  target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  bad?.querySelector('input,select,textarea')?.focus({ preventScroll: true });
}

export function showError(ex, fields, formErr) {
  const f = ex?.data?.field && fields[ex.data.field];
  if (f?.setError) { f.setError(ex.message); f.querySelector?.('input,select,textarea')?.focus(); } else fill(formErr, ex.message);
}

// The party's balance in words under a picker (money users only).
export async function balanceHint(box, party, ctx) {
  fill(box, '');
  if (!party || !ctx.can('money.view')) return;
  try {
    const { party: p } = await get(`/api/parties/${party.id}`);
    if ('balance' in p) fill(box, `رصيده دلوقتي: ${balanceText(p.balance)}`);
  } catch { /* the hint is optional */ }
}

// ---------- photos ----------
// A phone photo shrunk to at most 1600 px (JPEG), so it travels fast over the tunnel.
export function shrinkPhoto(file, max = 1600) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\//.test(file.type)) { reject(new Error('اختار صورة')); return; }
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = h('canvas', { width: Math.round(img.width * k), height: Math.round(img.height * k) });
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('الصورة دي مش بتتفتح — جرب صورة تانية')); };
    img.src = url;
  });
}

// ---------- status words ----------
const CHEQUE_PILL = {
  in_portfolio: 'warn', deposited: 'accent', collected: 'ok', endorsed: 'ok', bounced: 'danger', issued: 'warn', cleared: 'ok', cancelled: 'neutral',
};
export const chequePill = (c) => h('span', { class: `pill ${CHEQUE_PILL[c.status] || 'neutral'}` }, c.status_name || c.status);
export const docPill = (status) => (status === 'cancelled' ? h('span', { class: 'pill neutral' }, 'ملغي') : null);
export function duePill(c) {
  if (c.alert === 'overdue') return h('span', { class: 'pill danger' }, `متأخر ${Math.abs(c.days_to_due)} يوم`);
  if (c.alert === 'due_soon') return h('span', { class: 'pill warn' }, c.days_to_due === 0 ? 'النهارده' : c.days_to_due === 1 ? 'بكرة' : `خلال ${c.days_to_due} أيام`);
  return null;
}

export const kv = (pairs) => h('dl', { class: 'tr-kv' }, pairs.filter((p) => p && p[1] !== null && p[1] !== undefined && p[1] !== '')
  .map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));

export const moneyText = (m) => h('span', { class: 'money' }, money(m));
export const monthStart = (iso = todayISO()) => `${iso.slice(0, 7)}-01`;
export function prevMonthRange(iso = todayISO()) {
  const [y, m] = iso.split('-').map(Number);
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  const last = new Date(Date.UTC(py, pm, 0)).getUTCDate();
  const p = (n) => String(n).padStart(2, '0');
  return [`${py}-${p(pm)}-01`, `${py}-${p(pm)}-${p(last)}`];
}

// A form whose submit button locks while saving (a double tap never records twice).
export function trForm(onSave, ...children) {
  const form = h('form', { class: 'tr-form', novalidate: true }, ...children);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    if (btn?.disabled) return;
    busy(btn, onSave, 'جاري الحفظ…');
  });
  return form;
}
