// بيان أعمال: one posted batch (one client, one sheet) — the items with quantities and rates,
// خصم / إضافة, the transactions, the sheet and its photo — opened from كشف الحساب.
// «تصحيح سعر»: new rates (and discount / addition) with a reason; the server reverses the
// posting and posts the corrected items.
import { h, fill, icon, button, pageHead, backLink, notice, pill, field, numberInput, textInput, toast, toastError,
  dataTable, money, fmtDate, fmtDateTime } from '../ui.js';
import { get, post } from '../api.js';
import { createGrid } from '../grid.js';
import { ensurePricingStyles } from './pricing-style.js';
import { SOURCE_NAMES, ratePounds, materialText, calcText, qtyText } from './pricing-common.js';

export async function pricingBatch(main, params, ctx) {
  ensurePricingStyles();
  const v = await get(`/api/pricing/batches/${Number(params.id)}`);
  const b = v.batch;
  const posted = b.status === 'posted';
  const mayCorrect = posted && ctx.can('pricing') && ctx.can('money.post');
  const correctBox = h('div', { class: 'pr-correct' });

  const cols = [
    { label: 'القطعة', value: (i) => i.part_name || '—' },
    { label: 'القسم', value: (i) => i.section_name },
    { label: 'الخامة', value: (i) => materialText(i) || '—' },
    { label: 'الحساب', value: (i) => calcText(i) },
    { label: 'الكمية', value: (i) => qtyText(i) },
    { label: 'سعر الوحدة', value: (i) => h('span', { title: SOURCE_NAMES[i.rate_source] || '' }, money(i.rate)), n: true },
    { label: 'المبلغ', value: (i) => h('span', {}, money(i.amount), i.min_applied ? h('div', { class: 'small muted' }, 'الحد الأدنى') : null), n: true },
  ];
  const kv = (label, value) => h('div', { class: 'stat' }, h('span', {}, label), h('b', { class: 'money' }, value));

  fill(main,
    backLink(`#/clients/${v.client.id}/statement`, `كشف حساب ${v.client.name}`),
    pageHead(`بيان أعمال ${b.serial}`,
      h('span', { class: 'row', style: 'gap:10px' },
        h('a', { href: `#/clients/${v.client.id}` }, v.client.name),
        v.sheet ? h('span', {}, `${v.sheet.machine_name} — ورقة ${v.sheet.serial} — ${fmtDate(v.sheet.sheet_date)}`) : h('span', {}, fmtDate(b.date)),
        posted ? pill('ok', 'مترحّل') : pill('neutral', 'اتصحح')),
      v.sheet?.has_photo ? button('صورة الورقة', { icon: 'camera', href: `/api/operations/sheets/${v.sheet.id}/photo`, target: '_blank' }) : null,
      v.sheet ? button('تسعير الورقة', { icon: 'tag', href: `#/pricing/sheet/${v.sheet.id}`, kind: 'ghost' }) : null,
      button('طباعة', { icon: 'printer', onClick: () => window.print() }),
      mayCorrect ? button('تصحيح سعر', { kind: 'primary', icon: 'pencil-simple', onClick: () => openCorrection() }) : null),
    h('div', { class: 'print-head' }, h('div', {}, h('b', {}, 'شركة الصفا'), h('div', {}, `بيان أعمال ${b.serial} — ${v.client.name}`)),
      h('div', {}, v.sheet ? `${v.sheet.machine_name} — ورقة ${v.sheet.serial} — ${fmtDate(v.sheet.sheet_date)}` : fmtDate(b.date))),
    !posted ? notice('warn', h('b', {}, 'البيان ده اتصحح. '), b.reason ? `السبب: ${b.reason}. ` : '',
      v.corrected_by ? ['البيان الجديد: ', h('a', { href: `#/pricing/batch/${v.corrected_by.id}` }, v.corrected_by.serial)] : null) : null,
    v.corrected_from ? notice('info', 'البيان ده تصحيح لـ ', h('a', { href: `#/pricing/batch/${v.corrected_from.id}` }, v.corrected_from.serial)) : null,
    h('div', { class: 'stats', style: 'margin:14px 0' },
      kv('الشغل', money(b.work_amount)),
      b.addition_amount ? kv('إضافة', money(b.addition_amount)) : null,
      b.discount_amount ? kv('خصم', money(b.discount_amount)) : null,
      kv('الصافي على العميل', money(b.net_amount))),
    b.note ? h('p', { class: 'muted' }, `ملاحظة: ${b.note}`) : null,
    dataTable(cols, v.items, {
      rowClass: (i) => (i.status === 'cancelled' ? 'struck' : ''),
      foot: ['الإجمالي', '', '', '', '', '', { n: true, value: money(b.work_amount) }],
    }),
    h('div', { class: 'section-title' }, h('h2', {}, 'القيود')),
    dataTable([
      { label: 'رقم القيد', value: (t) => h('span', { class: 'num' }, t.serial) },
      { label: 'التاريخ', value: (t) => fmtDate(t.date), class: 'num' },
      { label: 'البيان', value: (t) => h('div', {}, t.description, t.reason ? h('div', { class: 'small muted' }, `السبب: ${t.reason}`) : null) },
      { label: 'الحالة', value: (t) => (t.reversal_of ? pill('neutral', 'إلغاء') : t.status === 'reversed' ? pill('neutral', 'اتلغى') : pill('ok', 'مترحّل')) },
    ], v.txns),
    h('p', { class: 'small muted', style: 'margin-top:10px' }, `اترحّل ${fmtDateTime(b.created_at)}${b.created_by_name ? ` — ${b.created_by_name}` : ''}`),
    correctBox);

  // ---------- تصحيح سعر ----------
  function openCorrection() {
    const rows = v.items.filter((i) => i.status === 'posted').map((i) => ({ ...i, rate_typed: ratePounds(i.rate), old_rate: i.rate }));
    const g = createGrid({
      columns: [
        { key: 'part_name', label: 'القطعة', type: 'computed', text: true, compute: (r) => r.part_name || r.section_name },
        { key: 'calc', label: 'الحساب', type: 'computed', text: true, compute: (r) => calcText(r) },
        { key: 'qty', label: 'الكمية', type: 'computed', text: true, compute: (r) => r.qty, format: (_v, r) => qtyText(r) },
        { key: 'old', label: 'السعر القديم', type: 'computed', compute: (r) => r.old_rate, format: (x) => money(x) },
        { key: 'rate_typed', label: 'السعر الصح', type: 'number', width: 90, ditto: false },
        { key: 'new_amount', label: 'المبلغ الجديد', type: 'computed', compute: (r) => amountOf(r), format: (x) => (x === null ? '' : money(x)),
          total: (rs) => rs.reduce((s, r) => s + (amountOf(r) || 0), 0), totalFormat: (x) => money(x) },
      ],
      rows, canAdd: false, canDelete: false, keysHint: false, totals: 'top',
      marks: (r, key) => (key === 'rate_typed' && (r.rate_typed === null || r.rate_typed < 0) ? { level: 'red', message: 'اكتب السعر' } : null),
      cellClass: (r, key) => (key === 'new_amount' && Math.round((r.rate_typed ?? 0) * 1000) === r.old_rate ? 'suggested' : ''),
      rowTitle: (r) => r.part_name || r.section_name,
    });
    const disc = numberInput({ value: b.discount_amount ? ratePounds(b.discount_amount) : '', placeholder: '0' });
    const add = numberInput({ value: b.addition_amount ? ratePounds(b.addition_amount) : '', placeholder: '0' });
    const note = textInput({ value: b.note || '' });
    const reason = h('textarea', { rows: 2, placeholder: 'مثال: السعر المتفق عليه مع العميل أقل' });
    const fReason = field('سبب التصحيح (بيظهر في كشف الحساب والسجل)', reason, { wide: true });
    const fDisc = field('الخصم', disc);
    const fAdd = field('الإضافة', add);
    const err = h('div', { class: 'err', role: 'alert' });
    const submit = button('صحّح ورحّل تاني', { kind: 'primary', icon: 'check', onClick: async () => {
      err.textContent = '';
      if (!reason.value.trim()) { fReason.setError('اكتب سبب التصحيح'); reason.focus(); return; }
      if (g.errors().length || g.rows.some((r) => r.rate_typed === null)) { err.textContent = 'اكتب سعر كل بند'; return; }
      try {
        const r = await post(`/api/pricing/batches/${b.id}/correct`, {
          reason: reason.value, discount: disc.value, addition: add.value, note: note.value,
          items: g.rows.map((x) => ({ id: x.id, rate: String(x.rate_typed) })),
        });
        toast(`اتصحح — البيان الجديد ${r.batch.serial}`);
        ctx.go(`#/pricing/batch/${r.batch.id}`);
      } catch (ex) {
        const target = { reason: fReason, discount: fDisc, addition: fAdd }[ex.data?.field];
        if (target) target.setError(ex.message); else err.textContent = ex.message;
      }
    } });
    fill(correctBox, h('div', { class: 'card' },
      h('h2', {}, icon('pencil-simple', 'sm'), ' تصحيح سعر'),
      h('p', { class: 'muted small', style: 'margin-top:-4px' },
        'القيد القديم هيتلغى بقيد عكسي بالسبب، والبنود هتترحّل تاني بالأسعار الجديدة', v.month_locked ? ' — وبما إن شهر الورقة مقفول، الترحيل الجديد هيبقى بتاريخ النهارده.' : '.'),
      g.el,
      h('div', { class: 'form-grid', style: 'margin-top:14px' }, fDisc, fAdd, field('ملاحظة', note), fReason),
      err,
      h('div', { class: 'row', style: 'margin-top:12px' }, submit, button('رجوع', { onClick: () => fill(correctBox) }))));
    correctBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  if (mayCorrect && ctx.query.correct === '1') openCorrection();
}

function amountOf(r) {
  if (r.rate_typed === null || r.rate_typed === undefined || Number.isNaN(r.rate_typed)) return null;
  const rate = Math.round(r.rate_typed * 1000);
  if (r.billing === 'lump') return rate;
  const base = Math.round(r.qty * rate); // display only; the server rounds half up and posts
  return r.billing === 'minute' && r.single_piece && r.min_charge ? Math.max(base, r.min_charge) : base;
}
