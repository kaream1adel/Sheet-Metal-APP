// أوامر الشغل (optional): a client's request with a serial (أم-0001), a delivery date and a
// status. Lines of any sheet may point at one; the order shows that work as its progress.
import { h, fill, icon, button, pageHead, backLink, emptyState, skeleton, field, textInput, selectInput, formModal, confirmModal,
  toast, toastError, notice, dataTable, pill, num, todayISO, fmtDate, loadInto } from '../ui.js';
import { get, post, patch, del } from '../api.js';
import { opsStyles } from './ops-css.js';
import { clients, ORDER_PILL, openOrders } from './ops-common.js';

const STATUS = { open: 'مفتوح', in_progress: 'شغال', done: 'خلص', delivered: 'اتسلم', cancelled: 'ملغي' };
const NEXT_LABEL = { open: 'رجّعه مفتوح', in_progress: 'بدأ الشغل', done: 'الشغل خلص', delivered: 'اتسلم للعميل' };
const statusPill = (s) => pill(ORDER_PILL[s] || 'neutral', STATUS[s] || s);
const dueCell = (o) => {
  if (!o.due_date) return h('span', { class: 'muted' }, '—');
  const late = !['delivered', 'cancelled'].includes(o.status) && o.due_date < todayISO();
  return h('span', { class: 'row', style: 'gap:6px' }, h('span', { class: 'num' }, fmtDate(o.due_date)), late ? pill('danger', 'متأخر') : null);
};
const progress = (o) => {
  if (!o.lines_count) return h('span', { class: 'muted small' }, 'لسه مفيش شغل');
  const p = Math.round((o.approved_lines / o.lines_count) * 100);
  return h('span', { class: 'row', style: 'gap:8px' }, h('span', { class: 'ops-progress', title: `${p}%` }, h('i', { style: `width:${p}%` })),
    h('span', { class: 'small num' }, `${o.approved_lines}/${o.lines_count}`));
};

// The form (new or edit). Resolves to the saved order, or null.
export async function orderForm(order, ctx, { clientId = null } = {}) {
  const list = await clients();
  const linked = order?.lines_count > 0;
  return formModal({
    title: order ? `تعديل ${order.serial}` : 'أمر شغل جديد',
    intro: order ? null : 'أمر الشغل اختياري: سطور ورق التشغيل ممكن تتربط بيه عشان تتابع الطلب.',
    fields: [
      { name: 'client_id', label: 'العميل', type: 'select', value: order?.client_id ?? clientId ?? '', wide: true,
        options: [['', 'اختار العميل'], ...list.map((c) => [c.id, c.name])], help: linked ? 'العميل مش بيتغير بعد ما سطور اتربطت بالأمر' : null },
      { name: 'description', label: 'الشغل المطلوب', type: 'textarea', value: order?.description || '', wide: true },
      { name: 'date', label: 'تاريخ الأمر', type: 'date', value: order?.date || todayISO() },
      { name: 'due_date', label: 'ميعاد التسليم (اختياري)', type: 'date', value: order?.due_date || '' },
      { name: 'notes', label: 'ملاحظات', type: 'textarea', value: order?.notes || '', wide: true },
    ],
    submitLabel: order ? 'حفظ التعديل' : 'اعمل الأمر',
    onSubmit: async (v) => {
      if (!v.client_id) { const e = new Error('اختار العميل'); e.data = { field: 'client_id' }; throw e; }
      const body = { ...v, client_id: Number(v.client_id), due_date: v.due_date || null };
      const r = order ? await patch(`/api/operations/orders/${order.id}`, body) : await post('/api/operations/orders', body);
      openOrders(true);
      return r.order;
    },
  });
}

export async function workOrders(main, _params, ctx) {
  opsStyles();
  const list = await clients().catch(() => []);
  const q = ctx.query || {};
  const f = {
    status: selectInput([['', 'كل الحالات'], ['open', 'مفتوح'], ['in_progress', 'شغال'], ['done', 'خلص'], ['delivered', 'اتسلم'], ['cancelled', 'ملغي']], q.status || ''),
    client_id: h('select', {}, h('option', { value: '' }, 'كل العملاء'), list.map((c) => h('option', { value: c.id, selected: String(c.id) === q.client_id }, c.name))),
    q: textInput({ placeholder: 'رقم الأمر أو الشغل', type: 'search' }),
  };
  const box = h('div', {}, skeleton('table'));
  const create = async () => {
    const o = await orderForm(null, ctx);
    if (o) { toast(`اتعمل ${o.serial}`); ctx.go(`#/ops/orders/${o.id}`); }
  };
  const load = () => loadInto(box, async () => {
    const { orders } = await get('/api/operations/orders', { status: f.status.value, client_id: f.client_id.value, q: f.q.value });
    if (!orders.length) {
      return f.status.value || f.client_id.value || f.q.value
        ? emptyState('funnel', 'مفيش أوامر بالفلتر ده', 'غيّر الحالة أو العميل.', null, true)
        : emptyState('clipboard-text', 'لسه مفيش أوامر شغل', 'أمر الشغل اختياري: اعمله لما عميل يطلب شغل وعايز تتابعه لحد التسليم.',
          button('أمر شغل جديد', { kind: 'primary', icon: 'plus', onClick: create }));
    }
    return dataTable([
      { label: 'الرقم', value: (o) => h('b', { class: 'num' }, o.serial) },
      { label: 'العميل', value: (o) => o.client_name },
      { label: 'الشغل', value: (o) => h('span', { class: 'small' }, o.description) },
      { label: 'التاريخ', value: (o) => h('span', { class: 'num' }, fmtDate(o.date)) },
      { label: 'التسليم', value: dueCell },
      { label: 'الحالة', value: (o) => statusPill(o.status) },
      { label: 'الشغل المعتمد', value: progress },
    ], orders, { onRow: (o) => ctx.go(`#/ops/orders/${o.id}`) });
  });
  let t;
  f.q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 250); });
  f.status.addEventListener('change', load);
  f.client_id.addEventListener('change', load);
  fill(main, h('div', { class: 'ops' },
    pageHead('أوامر الشغل', 'طلبات العملاء (اختيارية): سطور ورق التشغيل ممكن تتربط بأمر شغل وتبان كتقدم فيه.',
      button('أمر شغل جديد', { kind: 'primary', icon: 'plus', onClick: create })),
    h('div', { class: 'ops-filters' }, field('الحالة', f.status), field('العميل', f.client_id), h('div', { class: 'field grow' }, h('label', {}, 'بحث'), f.q)),
    box));
  await load();
}

export async function workOrderView(main, params, ctx) {
  opsStyles();
  const data = await get(`/api/operations/orders/${params.id}`);
  const o = data.order;
  const refresh = () => ctx.refresh();
  const setStatus = async (s) => {
    try { await patch(`/api/operations/orders/${o.id}`, { status: s }); toast(`الأمر بقى «${STATUS[s]}»`); openOrders(true); refresh(); } catch (ex) { toastError(ex); }
  };
  const actions = [];
  if (o.status !== 'cancelled') {
    for (const s of data.next_statuses.filter((x) => x !== 'cancelled')) {
      actions.push(button(NEXT_LABEL[s], { kind: s === 'delivered' || s === 'done' ? 'primary' : '', icon: s === 'delivered' ? 'truck' : s === 'done' ? 'check' : null, onClick: () => setStatus(s) }));
    }
    actions.push(button('تعديل', { icon: 'pencil-simple', onClick: async () => { if (await orderForm(o, ctx)) { toast('اتحفظ'); refresh(); } } }));
    if (data.next_statuses.includes('cancelled')) {
      actions.push(button('إلغاء الأمر', { kind: 'danger', icon: 'prohibit', onClick: async () => {
        const reason = await confirmModal(`إلغاء ${o.serial}`, 'الأمر هيتلغي ويفضل في السجل بالسبب. السطور المربوطة بيه بتفضل زي ما هي.', 'الغي الأمر', { danger: true, withReason: true, reasonLabel: 'سبب الإلغاء' });
        if (!reason) return;
        try { await post(`/api/operations/orders/${o.id}/cancel`, { reason }); toast('اتلغى الأمر'); openOrders(true); refresh(); } catch (ex) { toastError(ex); }
      } }));
    }
    if (!o.lines_count) {
      actions.push(button('امسحه', { kind: 'ghost', icon: 'trash', onClick: async () => {
        if (!(await confirmModal(`مسح ${o.serial}`, 'الأمر ده مفيش عليه شغل، هيتمسح خالص (ومتسجل في سجل التعديلات).', 'امسحه', { danger: true }))) return;
        try { await del(`/api/operations/orders/${o.id}`); toast('اتمسح'); openOrders(true); ctx.go('#/ops/orders'); } catch (ex) { toastError(ex); }
      } }));
    }
  }
  const row = (label, value) => h('tr', {}, h('th', { style: 'width:160px' }, label), h('td', {}, value));
  fill(main, h('div', { class: 'ops' },
    backLink('#/ops/orders', 'أوامر الشغل'),
    pageHead(`أمر شغل ${o.serial}`, h('span', { class: 'row', style: 'gap:8px' }, statusPill(o.status), h('a', { href: `#/clients/${o.client_id}` }, o.client_name)), actions),
    o.status === 'cancelled' ? notice('warn', h('b', {}, 'الأمر ده ملغي'), o.cancel_reason ? ` — السبب: ${o.cancel_reason}` : '') : null,
    h('div', { class: 'grid', style: 'margin-top:12px' },
      h('div', { class: 'table-wrap' }, h('table', {}, h('tbody', {},
        row('الشغل المطلوب', o.description),
        row('العميل', o.client_name),
        row('تاريخ الأمر', h('span', { class: 'num' }, fmtDate(o.date))),
        row('ميعاد التسليم', dueCell(o)),
        o.notes ? row('ملاحظات', o.notes) : null,
        row('اتعمل بواسطة', o.created_by_name || '—')))),
      h('div', { class: 'section-title' }, h('h2', {}, 'الشغل اللي اتعمل'),
        ctx.can('operations.record') && o.status !== 'cancelled' ? button('ورقة جديدة على الأمر', { size: 'sm', icon: 'file-plus', href: `#/ops/sheets/new?order=${o.id}` }) : null),
      data.by_machine.length ? h('div', { class: 'stats' }, data.by_machine.map((m) => h('div', { class: 'stat' },
        h('span', {}, m.machine_name),
        h('b', { class: 'num' }, m.machine === 'press' || m.machine === 'shear' ? `${num(m.pieces)} قطعة` : `${num(m.sheets)} لوح`),
        h('span', { class: 'small' }, `${m.lines} ${m.lines === 1 ? 'سطر' : 'سطور'} · ${m.approved} معتمد`, m.ops ? ` · ${num(m.ops)} ${m.machine === 'shear' ? 'قصة' : 'تنية'}` : '')))) : null,
      dataTable([
        { label: 'الورقة', value: (l) => h('a', { href: `#/ops/sheets/${l.sheet_id}`, class: 'num', onclick: (e) => e.stopPropagation() }, l.sheet_serial) },
        { label: 'المكنة', value: (l) => l.machine_name },
        { label: 'التاريخ', value: (l) => h('span', { class: 'num' }, fmtDate(l.work_date || l.sheet_date)) },
        { label: 'القطعة', value: (l) => l.part_name || '—' },
        { label: 'الخامة', value: (l) => [l.material_text, l.thickness ? ` ${num(l.thickness)} مم` : ''].join('') || '—' },
        { label: 'الكمية', value: (l) => h('span', { class: 'qty' }, l.sheets != null ? `${num(l.sheets)} لوح` : `${num(l.pieces)} قطعة${l.per_piece ? ` × ${num(l.per_piece)}` : ''}`) },
        { label: 'حالة الورقة', value: (l) => pill(l.sheet_status === 'approved' ? 'ok' : 'warn', l.sheet_status_name) },
      ], data.lines, { empty: emptyState('factory', 'لسه مفيش شغل على الأمر ده', 'وإنت بتكتب ورقة التشغيل اختار الأمر ده في عمود «أمر الشغل».', null, true) }))));
}

// The client file's «أوامر الشغل» tab.
export async function clientWorkOrdersTab(box, party, ctx) {
  opsStyles();
  fill(box, skeleton('table'));
  const create = async () => {
    const o = await orderForm(null, ctx, { clientId: party.id });
    if (o) { toast(`اتعمل ${o.serial}`); ctx.go(`#/ops/orders/${o.id}`); }
  };
  await loadInto(box, async () => {
    const { orders } = await get('/api/operations/orders', { client_id: party.id });
    if (!orders.length) {
      return emptyState('clipboard-text', 'مفيش أوامر شغل للعميل ده', 'أمر الشغل اختياري: اعمله لما العميل يطلب شغل وعايز تتابعه لحد التسليم.',
        button('أمر شغل جديد', { kind: 'primary', icon: 'plus', onClick: create }), true);
    }
    return h('div', { class: 'grid ops' },
      h('div', { class: 'row end' }, button('أمر شغل جديد', { kind: 'primary', icon: 'plus', size: 'sm', onClick: create })),
      dataTable([
        { label: 'الرقم', value: (o) => h('b', { class: 'num' }, o.serial) },
        { label: 'الشغل', value: (o) => h('span', { class: 'small' }, o.description) },
        { label: 'التاريخ', value: (o) => h('span', { class: 'num' }, fmtDate(o.date)) },
        { label: 'التسليم', value: dueCell },
        { label: 'الحالة', value: (o) => statusPill(o.status) },
        { label: 'الشغل المعتمد', value: progress },
      ], orders, { onRow: (o) => ctx.go(`#/ops/orders/${o.id}`) }));
  });
}
