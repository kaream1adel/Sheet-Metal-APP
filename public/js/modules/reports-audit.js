// سجل التعديلات: who did what and when. The server removes money and free text for a user
// without money.view; this screen only shows what it gets.
import { h, fill, pageHead, skeleton, emptyState, notice, dataTable, fmtDateTime, selectInput, field, textInput, button, modal, loadInto, pill } from '../ui.js';
import { get } from '../api.js';
import { filters, dateFilter } from './reports-common.js';

const show = (v) => {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

function details(e) {
  const before = e.before && typeof e.before === 'object' ? e.before : {};
  const after = e.after && typeof e.after === 'object' ? e.after : {};
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const changed = (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]);
  const close = modal([
    h('h2', {}, `${e.action_name} — ${e.entity_name}${e.entity_id ? ` رقم ${e.entity_id}` : ''}`),
    h('p', { class: 'small muted' }, `${e.user_name} · ${fmtDateTime(e.at)}`),
    keys.length ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'الخانة'), h('th', {}, 'قبل'), h('th', {}, 'بعد'))),
      h('tbody', {}, keys.map((k) => h('tr', { class: changed(k) ? '' : 'muted-row' },
        h('td', { class: 'num' }, k), h('td', { class: 'ltr', style: 'overflow-wrap:anywhere' }, show(before[k])), h('td', { class: 'ltr', style: 'overflow-wrap:anywhere' }, show(after[k]))))))) : notice('info', 'مفيش تفاصيل متسجلة للحركة دي.'),
    h('div', { class: 'modal-actions' }, button('اقفل', { onClick: () => close() })),
  ], { wide: true });
}

export async function auditLog(main, _p, ctx) {
  const f = { from: ctx.query.from || '', to: ctx.query.to || '', user_id: '', entity: ctx.query.entity || '', action: '', q: '' };
  fill(main, pageHead('سجل التعديلات', 'مين عمل إيه وإمتى.'), skeleton('table'));
  const meta = await get('/api/reports/audit/filters');
  const userSel = selectInput([['', 'كل المستخدمين'], ...meta.users.map((u) => [u.id, u.display_name])], '');
  const entSel = selectInput([['', 'كل الأنواع'], ...meta.entities.map((x) => [x.code, x.name])], f.entity);
  const actSel = selectInput([['', 'كل الحركات'], ...meta.actions.map((x) => [x.code, x.name])], '');
  const search = textInput({ type: 'search', placeholder: 'كلمة في التفاصيل…' });
  const box = h('div', {}, skeleton('table'));
  const moreBox = h('div', { class: 'row', style: 'justify-content:center;margin-top:12px' });
  let entries = [];
  let hidden = false;

  const cols = [
    { label: 'الوقت', value: (e) => h('span', { class: 'num' }, fmtDateTime(e.at)) },
    { label: 'المستخدم', value: (e) => e.user_name },
    { label: 'الحركة', value: (e) => pill(e.action === 'reverse' || e.action === 'delete' || e.action === 'cancel' ? 'warn' : 'neutral', e.action_name) },
    { label: 'النوع', value: (e) => `${e.entity_name}${e.entity_id ? ` رقم ${e.entity_id}` : ''}` },
  ];
  const draw = () => fill(box,
    hidden ? notice('info', 'المبالغ والبيانات المكتوبة بإيد مش ظاهرة ليك، والسجل هنا للتشغيل بس.') : null,
    dataTable(cols, entries, { onRow: details, empty: emptyState('clock-counter-clockwise', 'مفيش حركات بالفلتر ده', 'غيّر الفترة أو امسح الفلتر.', null, true) }));

  const load = async (append = false) => {
    const params = { ...f, limit: 100, before_id: append && entries.length ? entries.at(-1).id : '' };
    const run = async () => {
      const r = await get('/api/reports/audit', params);
      entries = append ? [...entries, ...r.entries] : r.entries;
      hidden = r.money_hidden;
      draw();
      fill(moreBox, r.more ? button('حمّل أقدم', { icon: 'caret-down', onClick: () => load(true) }) : null);
    };
    if (append) await run(); else await loadInto(box, run);
  };
  const on = (el, k) => el.addEventListener('change', () => { f[k] = el.value; load(); });
  on(userSel, 'user_id'); on(entSel, 'entity'); on(actSel, 'action');
  let t;
  search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { f.q = search.value.trim(); load(); }, 300); });
  fill(main,
    pageHead('سجل التعديلات', 'مين عمل إيه وإمتى. اضغط على أي سطر عشان تشوف قبل وبعد.'),
    filters(
      dateFilter('من', f.from, (v) => { f.from = v; load(); }),
      dateFilter('لحد', f.to, (v) => { f.to = v; load(); }),
      field('المستخدم', userSel), field('النوع', entSel), field('الحركة', actSel), field('بحث', search)),
    box, moreBox);
  await load();
}
