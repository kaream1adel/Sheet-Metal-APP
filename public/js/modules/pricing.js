// Module pricing (التسعير): أوراق مستنية تسعير (queue), تسعير ورقة (pricing-sheet.js), الأسعار العامة,
// بيان أعمال + تصحيح سعر (pricing-batch.js), قيد يدوي على عميل, and the client file's شيت التسعير tab
// (pricing-client.js). Statement rows open their documents through registerDocOpener.
// Screen: async (main, params, ctx). Tab: async (box, party, ctx).
import { h, fill, icon, button, pageHead, emptyState, skeleton, notice, pill, formModal, confirmModal, modal, toast, toastError,
  dataTable, money, fmtDate, fmtDateTime, todayISO } from '../ui.js';
import { get, post, put } from '../api.js';
import { createGrid } from '../grid.js';
import { registerDocOpener } from '../statement.js';
import { ensurePricingStyles } from './pricing-style.js';
import { bandWords, ratePounds, dayTitle } from './pricing-common.js';
import { priceSheet } from './pricing-sheet.js';
import { pricingBatch } from './pricing-batch.js';
import { clientPricingSheetTab } from './pricing-client.js';

export { priceSheet, pricingBatch, clientPricingSheetTab };

// ---------- أوراق مستنية تسعير ----------
export async function pricingQueue(main, _params, ctx) {
  ensurePricingStyles();
  const box = h('div', {}, skeleton('table'));
  const stats = h('div', { class: 'stats', style: 'margin-bottom:14px' });
  const chips = h('div', { class: 'pr-chips' });
  let data = null;
  let only = ctx.query.client ? Number(ctx.query.client) : null;

  fill(main,
    pageHead('أوراق مستنية تسعير', 'الأوراق اللي مدير الورشة اعتمدها ولسه مترحّلتش على العملاء. افتح الورقة، راجع الأسعار، ورحّل.',
      ctx.can('money.post') ? button('قيد يدوي على عميل', { icon: 'plus', onClick: async () => { await manualEntryForm(ctx); } }) : null,
      button('الأسعار العامة', { icon: 'table', href: '#/pricing/general' })),
    stats, chips, box);

  const draw = () => {
    const groups = data.groups.map((g) => ({ ...g, sheets: g.sheets.filter((s) => !only || s.clients.some((c) => c.id === only)) }))
      .filter((g) => g.sheets.length);
    fill(stats,
      h('div', { class: 'stat' }, h('span', {}, 'أوراق مستنية'), h('b', {}, data.totals.sheets)),
      h('div', { class: 'stat' }, h('span', {}, 'بنود محتاجة سعر'), h('b', {}, data.totals.needs_rate_count)),
      h('div', { class: 'stat' }, h('span', {}, 'قيمة مبدئية بالأسعار المقترحة'), h('b', { class: 'money' }, money(data.totals.waiting_amount))));
    fill(chips, data.clients.length > 1 ? [
      h('button', { class: `pr-chip${only ? '' : ' on'}`, type: 'button', onclick: () => { only = null; draw(); } }, 'كل العملاء'),
      data.clients.map((c) => h('button', { class: `pr-chip${only === c.id ? ' on' : ''}`, type: 'button', title: `${c.items} بند`,
        onclick: () => { only = only === c.id ? null : c.id; draw(); } }, c.name, h('b', {}, c.sheets))),
    ] : null);
    if (!data.totals.sheets) {
      return fill(box, emptyState('check-circle', 'مفيش أوراق مستنية تسعير', 'كل الأوراق المعتمدة اترحّلت. الورقة بتوصل هنا أول ما مدير الورشة يعتمدها.',
        ctx.can('operations.approve') ? button('المراجعة والاعتماد', { href: '#/ops/review', icon: 'seal-check' }) : null));
    }
    fill(box, groups.map((g) => [
      h('div', { class: 'pr-day' }, h('h2', {}, dayTitle(g.date)), h('span', {}, `${g.sheets.length} ورقة`)),
      dataTable([
        { label: 'الورقة', value: (s) => h('b', { class: 'num' }, s.serial) },
        { label: 'المكنة', value: (s) => s.machine_name },
        { label: 'الفني', value: (s) => s.technician_name || '—' },
        { label: 'العملاء', value: (s) => s.clients.map((c) => c.name).join('، ') || '—' },
        { label: 'البنود', value: (s) => s.waiting_count, n: true },
        { label: 'الحالة', value: (s) => [
          !s.waiting_count && !s.clients.length ? pill('neutral', 'مفيش بنود') : s.needs_rate_count ? pill('warn', `${s.needs_rate_count} محتاج سعر`) : pill('accent', 'جاهزة للترحيل'),
          s.priced_status === 'partial' ? [' ', pill('neutral', 'اترحّل جزء')] : null] },
        { label: 'القيمة', value: (s) => money(s.waiting_amount), n: true },
      ], g.sheets, { onRow: (s) => ctx.go(`#/pricing/sheet/${s.id}`) }),
    ]));
  };

  try {
    data = await get('/api/pricing/queue');
    draw();
  } catch (ex) {
    fill(box, notice('danger', ex.message, ' ', button('جرب تاني', { size: 'sm', onClick: () => ctx.refresh() })));
  }
}

// ---------- الأسعار العامة ----------
export async function generalPrices(main, _params, ctx) {
  ensurePricingStyles();
  let data = await get('/api/pricing/general');
  const box = h('div', {});
  const err = h('div', { class: 'err', role: 'alert' });
  let bad = null; // { key, message } from the server

  const keyOf = (p) => `${p.section}${p.band ? `:${p.band}` : ''}`;
  let grid;
  const draw = () => {
    grid = createGrid({
      columns: [
        { key: 'section_name', label: 'القسم', type: 'computed', text: true, compute: (r) => r.section_name },
        { key: 'band', label: 'الشريحة', type: 'computed', text: true, compute: (r) => bandWords(r.band) || '—' },
        { key: 'unit_name', label: 'الوحدة', type: 'computed', text: true, compute: (r) => `لل${r.unit_name}` },
        { key: 'rate_typed', label: 'سعر الوحدة', type: 'number', width: 100, ditto: false, placeholder: 'مفيش' },
        { key: 'min_typed', label: 'الحد الأدنى للقطعة الواحدة', type: 'number', width: 100, ditto: false, readOnly: (r) => !r.has_min },
        { key: 'updated', label: 'آخر تعديل', type: 'computed', text: true, compute: (r) => (r.updated_at ? `${fmtDateTime(r.updated_at)}${r.updated_by_name ? ` — ${r.updated_by_name}` : ''}` : '—') },
      ],
      rows: data.prices.map((p) => ({ ...p, rate_typed: ratePounds(p.rate), min_typed: ratePounds(p.min_charge) })),
      canAdd: false, canDelete: false, totals: false, keysHint: true, maxHeight: 'none',
      rowTitle: (r) => `${r.section_name}${r.band ? ` — ${bandWords(r.band)}` : ''}`,
      marks: (r, key) => {
        if (!bad) return null;
        if (bad.key === `rate:${keyOf(r)}` && key === 'rate_typed') return { level: 'red', message: bad.message };
        if (bad.key === `min_charge:${keyOf(r)}` && key === 'min_typed') return { level: 'red', message: bad.message };
        return null;
      },
      onChange: () => { err.textContent = ''; },
    });
    fill(box, grid.el);
  };

  const save = async () => {
    err.textContent = '';
    if (grid.errors().length) { err.textContent = 'فيه خانة مكتوب فيها حاجة مش رقم'; return; }
    const prices = grid.rows.map((r) => {
      const p = { section: r.section, band: r.band, rate: r.rate_typed === null ? '' : String(r.rate_typed) };
      if (r.has_min) p.min_charge = r.min_typed === null ? '' : String(r.min_typed);
      return p;
    });
    try {
      const r = await put('/api/pricing/general', { prices });
      bad = null;
      data = r;
      draw();
      toast(r.changed ? `اتحفظ ${r.changed} سعر` : 'مفيش تغيير');
    } catch (ex) {
      bad = ex.data?.field ? { key: ex.data.field, message: ex.message } : null;
      grid.refresh();
      err.textContent = ex.message;
    }
  };

  fill(main,
    pageHead('الأسعار العامة', 'السعر اللي بيتقترح لما العميل ملوش سعر قبل كده. أي سعر بيتكتب في الورقة بيتقدّم عليه.',
      button('احفظ الأسعار', { kind: 'primary', icon: 'check', onClick: save })),
    notice('info', 'ترتيب السعر المقترح: آخر سعر لنفس العميل ونفس الخامة والسمك، بعدين آخر سعر للعميل في القسم (والتناية حسب السمك)، بعدين السعر العام هنا. لو مفيش، البند بيظهر بالأصفر «محتاج سعر».'),
    h('div', { style: 'margin-top:14px' }, box), err,
    h('p', { class: 'small muted' }, 'الحد الأدنى بيتطبق على الليزر والبنش لما الورقة مكتوب فيها «قطعة واحدة»: المبلغ = الأكبر من (الدقائق × السعر) والحد الأدنى.'));
  draw();
  if (!ctx.can('money.view')) fill(box, emptyState('lock-key', 'الأسعار للأدمن بس', '', null, true));
}

// ---------- قيد يدوي على عميل ----------
// Resolves to the created entry (or null). party: a client to fix the form on.
export async function manualEntryForm(ctx, party = null) {
  let clients = [];
  if (!party) {
    const r = await get('/api/parties', { kind: 'client' });
    clients = r.parties;
    if (!clients.length) { toast('لسه مفيش عملاء', true); return null; }
  }
  const fields = [
    party ? null : { name: 'client_id', label: 'العميل', type: 'select', options: [['', 'اختار العميل'], ...clients.map((c) => [c.id, c.name])], wide: true },
    { name: 'kind', label: 'نوع القيد', type: 'select', value: 'debit', options: [['debit', 'قيد مدين (شغل أو فاتورة على العميل)'], ['addition', 'إضافة على العميل'], ['discount', 'خصم للعميل']] },
    { name: 'date', label: 'التاريخ', type: 'date', value: todayISO() },
    { name: 'amount', label: 'المبلغ', type: 'money', placeholder: '0.00' },
    { name: 'description', label: 'البيان (بيظهر في كشف الحساب)', type: 'textarea', wide: true, placeholder: 'مثال: فاتورة شغل قديمة، خصم تعجيل دفع' },
  ].filter(Boolean);
  const entry = await formModal({
    title: party ? `قيد يدوي على ${party.name}` : 'قيد يدوي على عميل',
    intro: 'المدين والإضافة بيزودوا اللي على العميل، والخصم بيظهر في عمود الخصم في كشف الحساب.',
    fields, submitLabel: 'سجّل القيد',
    onSubmit: async (v) => {
      const clientId = party ? party.id : Number(v.client_id);
      if (!clientId) { const e = new Error('اختار العميل'); e.data = { field: 'client_id' }; throw e; }
      return (await post('/api/pricing/manual', { ...v, client_id: clientId })).entry;
    },
  });
  if (entry) {
    toast(`اتسجل القيد ${entry.serial}`, false, { action: { label: 'كشف الحساب', onClick: () => ctx.go(`#/clients/${entry.client_id}/statement`) } });
  }
  return entry;
}

async function openManualEntry(row) {
  let e;
  try { e = (await get(`/api/pricing/manual/${row.doc_id}`)).entry; } catch (ex) { toastError(ex); return; }
  const kv = (k, v) => h('tr', {}, h('th', { style: 'width:120px' }, k), h('td', {}, v));
  const close = modal([
    h('h2', {}, `قيد يدوي ${e.serial}`),
    h('div', { class: 'table-wrap' }, h('table', {}, h('tbody', {},
      kv('العميل', e.client_name), kv('النوع', e.kind_name), kv('التاريخ', h('span', { class: 'num' }, fmtDate(e.date))),
      kv('المبلغ', h('span', { class: 'money' }, money(e.amount))), kv('البيان', e.description),
      kv('الحالة', e.status === 'posted' ? pill('ok', 'مترحّل') : [pill('neutral', 'اتلغى'), e.cancel_reason ? ` — ${e.cancel_reason}` : '']),
      kv('سجّله', `${e.created_by_name || ''} ${fmtDateTime(e.created_at)}`)))),
    h('div', { class: 'modal-actions', style: 'margin-top:14px' },
      e.status === 'posted' ? button('إلغاء القيد', { kind: 'danger', icon: 'arrow-counter-clockwise', onClick: async () => {
        const reason = await confirmModal('إلغاء القيد', 'هيتسجل قيد عكسي بنفس المبلغ بتاريخ النهارده، والقيد الأصلي يفضل ظاهر ومشطوب.', 'ألغِ القيد', { danger: true, withReason: true });
        if (!reason) return;
        try {
          await post(`/api/pricing/manual/${e.id}/cancel`, { reason });
          close();
          toast('القيد اتلغى');
          window.dispatchEvent(new HashChangeEvent('hashchange'));
        } catch (ex) { toastError(ex); }
      } }) : null,
      button('اقفل', { onClick: () => close() })),
  ]);
}

// A statement row opens its document.
registerDocOpener('pricing_batch', (row) => { location.hash = `#/pricing/batch/${row.doc_id}`; }, 'money.view');
registerDocOpener('manual_entry', (row) => openManualEntry(row), 'money.view');

export const routes = [
  { path: '#/pricing', screen: pricingQueue, perm: 'pricing' },
  { path: '#/pricing/sheet/:id', screen: priceSheet, perm: 'pricing' },
  { path: '#/pricing/general', screen: generalPrices, perm: 'pricing' },
  { path: '#/pricing/batch/:id', screen: pricingBatch, perm: 'money.view' },
];
