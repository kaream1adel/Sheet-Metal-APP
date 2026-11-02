// The reusable كشف حساب view for any party (client, supplier, partner, worker).
//
//   await renderStatement(box, partyId, { from, to, title, canPrint, onRow })
//
// Columns: التاريخ · البيان · المستند · مدين · خصم · دائن · الرصيد (in words: لنا عنده / له عندنا /
// خالص). A reversed line and its reversal both show, struck through. Client cheques not yet
// collected show under the table as «تحت التحصيل» (memo, no balance effect).
// A row opens its document through an opener registered by the module that owns it, with
// the permission the target screen needs (a row is clickable only for a viewer who has it):
//   registerDocOpener('pricing_batch', (row) => { location.hash = `#/pricing/batch/${row.doc_id}`; }, 'money.view');
// For staff the server sends sheet_id on a priced row: it opens the operation sheet instead.
// Staff (no money.view) get a client's rows without amounts, descriptions or reasons from the
// server (the kind names the row); other parties' statements are money.view only.
import { h, fill, icon, button, field, money, moneySpan, fmtDate, balanceCell, emptyState, skeleton, notice, todayISO } from './ui.js';
import { get } from './api.js';

const openers = new Map();
export function registerDocOpener(docType, fn, ...perms) { openers.set(docType, { fn, perms }); }

const KIND_WORDS = { reversal: 'إلغاء', opening: 'رصيد أول المدة' };

export async function renderStatement(box, partyId, { from = '', to = '', title = 'كشف حساب', canPrint = true, onRow = null, can = () => true } = {}) {
  const fromIn = h('input', { type: 'date', value: from || '' });
  const toIn = h('input', { type: 'date', value: to || '' });
  const hideIn = h('input', { type: 'checkbox' });
  const body = h('div', {}, skeleton('table'));
  const load = async () => {
    fill(body, skeleton('table'));
    try {
      const s = await get(`/api/parties/${partyId}/statement`, { from: fromIn.value, to: toIn.value, hide_reversed: hideIn.checked ? '1' : '' });
      fill(body, view(s, { title, onRow, can }));
    } catch (ex) {
      fill(body, notice('danger', ex.message, ' ', button('جرب تاني', { size: 'sm', onClick: load })));
    }
  };
  for (const el of [fromIn, toIn, hideIn]) el.addEventListener('change', load);
  const thisMonth = () => { const t = todayISO(); fromIn.value = `${t.slice(0, 7)}-01`; toIn.value = t; load(); };
  fill(box, h('div', { class: 'statement' },
    h('div', { class: 'head no-print' },
      field('من', fromIn), field('لحد', toIn),
      h('label', { class: 'check-row', style: 'height:38px' }, hideIn, 'من غير الملغي'),
      h('div', { class: 'row' },
        button('الشهر ده', { size: 'sm', kind: 'ghost', onClick: thisMonth }),
        button('من الأول', { size: 'sm', kind: 'ghost', onClick: () => { fromIn.value = ''; toIn.value = ''; load(); } })),
      h('span', { class: 'spacer' }),
      canPrint ? button('طباعة', { icon: 'printer', onClick: () => window.print() }) : null),
    body));
  await load();
}

function view(s, { title, onRow, can }) {
  const hasMoney = 'closing' in s;
  const range = s.from || s.to ? `من ${s.from ? fmtDate(s.from) : 'الأول'} لحد ${s.to ? fmtDate(s.to) : 'النهارده'}` : 'كل الحركات';
  const printHead = h('div', { class: 'print-head' },
    h('div', {}, h('b', {}, 'شركة الصفا'), h('div', {}, `${title} — ${s.party.name}`)), h('div', {}, range));
  if (!s.rows.length && !(hasMoney && s.opening)) {
    return [printHead, emptyState('notebook', 'مفيش حركات في الفترة دي', 'أول ما يتسجل شغل أو دفعة للطرف ده هتظهر هنا.', null, true)];
  }
  // the opener the viewer may use: its own permission, or (staff) the operation sheet of a priced row
  const opener = (r) => {
    const o = openers.get(r.doc_type);
    if (o && (!o.perms.length || o.perms.some((p) => can(p)))) return () => o.fn(r);
    if (r.sheet_id && (can('operations.record') || can('operations.approve'))) return () => { location.hash = `#/ops/sheets/${r.sheet_id}`; };
    return null;
  };
  const clickable = (r) => !!(onRow || opener(r));
  const open = (r) => (onRow ? onRow(r) : opener(r)?.());
  const rows = s.rows.map((r) => h('tr', {
    class: [r.status === 'reversed' || r.reversal_of ? 'struck' : '', clickable(r) ? 'click' : ''].join(' ').trim() || null,
    onclick: clickable(r) ? () => open(r) : null,
  },
  h('td', { 'data-label': 'التاريخ', class: 'num' }, fmtDate(r.date)),
  h('td', { 'data-label': 'البيان', class: 'desc' }, r.description || r.kind_name || KIND_WORDS[r.kind] || 'حركة',
    r.reason ? h('div', { class: 'small muted' }, `السبب: ${r.reason}`) : null),
  h('td', { 'data-label': 'المستند', class: 'num' }, r.ref || r.serial),
  hasMoney ? [
    h('td', { 'data-label': 'مدين', class: 'n' }, r.debit ? money(r.debit) : ''),
    h('td', { 'data-label': 'خصم', class: 'n' }, r.discount ? money(r.discount) : ''),
    h('td', { 'data-label': 'دائن', class: 'n' }, r.credit ? money(r.credit) : ''),
    h('td', { 'data-label': 'الرصيد', class: 'keep' }, balanceCell(r.balance)),
  ] : null));

  const table = h('table', { class: 'cards' },
    h('thead', {}, h('tr', {}, h('th', {}, 'التاريخ'), h('th', {}, 'البيان'), h('th', {}, 'المستند'),
      hasMoney ? [h('th', { class: 'n' }, 'مدين'), h('th', { class: 'n' }, 'خصم'), h('th', { class: 'n' }, 'دائن'), h('th', {}, 'الرصيد')] : null)),
    h('tbody', {},
      hasMoney && s.from ? h('tr', { class: 'muted-row' }, h('td', { 'data-label': 'التاريخ', class: 'num' }, fmtDate(s.from)),
        h('td', { 'data-label': 'البيان' }, 'رصيد سابق'), h('td'), h('td'), h('td'), h('td'), h('td', { 'data-label': 'الرصيد' }, balanceCell(s.opening))) : null,
      rows),
    hasMoney ? h('tfoot', {}, h('tr', { class: 'sum' }, h('td'), h('td', {}, 'الإجمالي'), h('td'),
      h('td', { class: 'n' }, money(s.totals.debit)), h('td', { class: 'n' }, money(s.totals.discount)),
      h('td', { class: 'n' }, money(s.totals.credit)), h('td'))) : null);

  const pending = (s.pending_cheques || []).length ? h('div', { class: 'card', style: 'margin-top:12px' },
    h('h3', {}, icon('hourglass-medium', 'sm'), ' شيكات تحت التحصيل (مش داخلة في الرصيد)'),
    h('table', {}, h('tbody', {}, s.pending_cheques.map((c) => h('tr', { class: 'memo' },
      h('td', {}, `شيك ${c.number || c.serial}${c.bank ? ` — ${c.bank}` : ''}`),
      h('td', { class: 'num' }, c.due_date ? `يستحق ${fmtDate(c.due_date)}` : ''),
      hasMoney ? h('td', { class: 'n' }, money(c.amount)) : null))))) : null;

  return [printHead,
    h('div', { class: 'table-wrap' }, table,
      hasMoney ? h('div', { class: 'closing' }, h('span', {}, 'الرصيد في الآخر'), h('b', {}, balanceCell(s.closing))) : null),
    hasMoney ? null : h('p', { class: 'small muted' }, 'المبالغ بتظهر للأدمن بس.'),
    pending];
}

// The balance line on its own, e.g. on a party card.
export const balanceLine = (b) => h('span', {}, balanceCell(b));
export { moneySpan };
