// The client file's «شيت التسعير»: the client's work in the six sections of the Excel
// «قالب تصنيع», in the template's column order, with each section's totals (rows 3 / 5) and the
// grand total (E1), plus رقم الورقة and الفني linking to the sheet. Staff get quantities only
// (the server strips every money field); the money columns simply aren't drawn for them.
import { h, fill, icon, button, field, emptyState, skeleton, notice, pill, money, num, fmtDate, todayISO } from '../ui.js';
import { get } from '../api.js';
import { ensurePricingStyles } from './pricing-style.js';
import { materialText } from './pricing-common.js';

const yesNo = (b) => (b ? 'نعم' : 'لا');
const status = (i) => (i.status === 'suggested' ? pill('warn', 'مستني تسعير') : i.status === 'settled_in_excel' ? pill('neutral', 'اتحاسب في الإكسيل') : null);
const isBend = (band) => (i) => (i.billing === 'bend' && i.band === band ? i.qty : null);

// Excel columns per section (template row 6). m: money column (admin only); sum: key in section.sums.
const COLUMNS = {
  press: [
    { label: 'عدد القطع', v: (i) => i.pieces, sum: 'pieces' },
    { label: 'عدد التنيات', v: (i) => i.per_piece },
    { label: 'نزلة تناية (أقل من 3مم)', v: isBend('<3'), sum: 'thin_bends' },
    { label: 'الخامة', v: (i) => i.material_name, text: true },
    { label: 'السمك (مم)', v: (i) => i.thickness },
    { label: 'نزلة تناية (3مم فأكبر)', v: isBend('>=3'), sum: 'thick_bends' },
    { label: 'سعر محدد؟', v: (i) => (i.billing === 'piece' ? 'نعم' : i.billing === 'lump' ? 'مقطوعية' : 'لا'), text: true },
    { label: 'سعر الوحدة', v: (i) => i.rate, m: true },
    { label: 'مبلغ السعر المحدد', v: (i) => (i.billing === 'piece' ? i.amount : null), m: true, msum: 'fixed_amount' },
  ],
  laser: [
    { label: 'اللوح / القطعة', v: (i) => i.part_name, text: true },
    { label: 'عدد الألواح', v: (i) => i.sheets, sum: 'sheets' },
    { label: 'الوقت بالدقيقة', v: (i) => i.minutes_per_sheet },
    { label: 'إجمالي الدقائق', v: (i) => (i.billing === 'minute' ? i.qty : null), sum: 'minutes' },
    { label: 'الخامة', v: (i) => materialText(i), text: true },
    { label: 'قطعة واحدة؟', v: (i) => yesNo(i.single_piece), text: true },
    { label: 'سعر الدقيقة', v: (i) => i.rate, m: true },
  ],
  louver: [
    { label: 'القطعة', v: (i) => i.part_name, text: true },
    { label: 'عدد القطع', v: (i) => i.pieces, sum: 'pieces' },
    { label: 'عدد لوفر', v: (i) => i.per_piece },
    { label: 'العدد الكلي للوفر', v: (i) => (i.billing === 'louver' ? i.qty : null), sum: 'louvers' },
    { label: 'الخامة', v: (i) => materialText(i), text: true },
    { label: 'سعر اللوفر', v: (i) => i.rate, m: true },
  ],
  shear: [
    { label: 'القطعة', v: (i) => i.part_name, text: true },
    { label: 'عدد القطع', v: (i) => i.pieces, sum: 'pieces' },
    { label: 'عدد القصات', v: (i) => i.per_piece },
    { label: 'نزلة مقص', v: (i) => (i.billing === 'cut' ? i.qty : null), sum: 'cuts' },
    { label: 'الخامة', v: (i) => materialText(i), text: true },
    { label: 'سعر القصة', v: (i) => i.rate, m: true },
  ],
  material: [
    { label: 'الكمية (عدد الألواح)', v: (i) => i.sheets, sum: 'sheets' },
    { label: 'سمك بالمم', v: (i) => i.thickness },
    { label: 'طول بالسم', v: (i) => i.length_cm },
    { label: 'عرض بالسم', v: (i) => i.width_cm },
    { label: 'الخامة', v: (i) => i.material_name, text: true },
    { label: 'الوزن الكلي (كجم)', v: (i) => i.weight_kg, sum: 'weight_kg' },
    { label: 'وزن مجلفن', v: (i) => (i.material_group === 'galvanized' ? i.weight_kg : null), sum: 'galvanized_kg' },
    { label: 'وزن أسود', v: (i) => (i.material_group === 'black' ? i.weight_kg : null), sum: 'black_kg' },
    { label: 'وزن ستانلس', v: (i) => (i.material_group === 'stainless' ? i.weight_kg : null), sum: 'stainless_kg' },
    { label: 'وزن ألومنيوم', v: (i) => (i.material_group === 'aluminium' ? i.weight_kg : null), sum: 'aluminium_kg' },
    { label: 'سعر الكيلو', v: (i) => i.rate, m: true },
  ],
};
COLUMNS.punch = COLUMNS.laser;
// press has the piece name second (template B6), others put it in their own column above
COLUMNS.press.unshift({ label: 'القطعة', v: (i) => i.part_name, text: true });

export async function clientPricingSheetTab(box, party, ctx) {
  ensurePricingStyles();
  const moneyView = ctx.can('money.view');
  const fromIn = h('input', { type: 'date' });
  const toIn = h('input', { type: 'date' });
  const body = h('div', {}, skeleton('table'));
  const load = async () => {
    fill(body, skeleton('table'));
    try {
      const s = await get(`/api/pricing/clients/${party.id}/sheet`, { from: fromIn.value, to: toIn.value });
      fill(body, view(s, party, ctx, moneyView));
    } catch (ex) {
      fill(body, notice('danger', ex.message, ' ', button('جرب تاني', { size: 'sm', onClick: load })));
    }
  };
  for (const el of [fromIn, toIn]) el.addEventListener('change', load);
  const thisMonth = () => { const t = todayISO(); fromIn.value = `${t.slice(0, 7)}-01`; toIn.value = t; load(); };
  fill(box, h('div', { class: 'statement' },
    h('div', { class: 'head no-print pr-tabhead' },
      field('من', fromIn), field('لحد', toIn),
      h('div', { class: 'row' },
        button('الشهر ده', { size: 'sm', kind: 'ghost', onClick: thisMonth }),
        button('من الأول', { size: 'sm', kind: 'ghost', onClick: () => { fromIn.value = ''; toIn.value = ''; load(); } })),
      h('span', { class: 'spacer' }),
      ctx.can('money.post') && moneyView ? button('قيد يدوي', { icon: 'plus', onClick: async () => {
        const { manualEntryForm } = await import('./pricing.js');
        if (await manualEntryForm(ctx, party)) load();
      } }) : null,
      button('طباعة', { icon: 'printer', onClick: () => window.print() })),
    body));
  await load();
}

function view(s, party, ctx, moneyView) {
  const range = s.from || s.to ? `من ${s.from ? fmtDate(s.from) : 'الأول'} لحد ${s.to ? fmtDate(s.to) : 'النهارده'}` : 'كل الشغل';
  const printHead = h('div', { class: 'print-head' }, h('div', {}, h('b', {}, 'شركة الصفا'), h('div', {}, `شيت التسعير — ${party.name}`)), h('div', {}, range));
  const withItems = s.sections.filter((x) => x.items.length);
  if (!withItems.length) {
    return [printHead, emptyState('table', 'لسه مفيش شغل للعميل ده', s.from || s.to ? 'مفيش شغل في الفترة دي. جرب «من الأول».'
      : 'أول ما ورقة تشغيل عليها اسمه تتعتمد، شغله هيظهر هنا في أقسامه زي شيت الإكسيل.', null, true)];
  }
  const sheetHref = (i) => (ctx.can('pricing') ? `#/pricing/sheet/${i.sheet_id}` : `#/ops/sheets/${i.sheet_id}`);
  const grand = h('div', { class: 'pr-grand' },
    moneyView ? h('div', { class: 'stat', style: 'min-width:220px' }, h('span', {}, 'إجمالي المبلغ'), h('b', { class: 'money' }, money(s.total))) : null,
    s.waiting_count ? notice('warn', `${s.waiting_count} بند مستني تسعير — مش داخل في الإجمالي لحد ما يترحّل.`) : null,
    !moneyView ? notice('info', 'الأسعار والمبالغ بتظهر للأدمن بس. هنا الكميات.') : null);

  // all six sections in the template's order, as in the Excel: an empty one says so
  return [printHead, grand, s.sections.map((sec) => section(sec, moneyView, sheetHref))];
}

function section(sec, moneyView, sheetHref) {
  const cols = [{ label: 'التاريخ', v: (i) => fmtDate(i.work_date), text: true, cls: 'num' }, ...COLUMNS[sec.section]]
    .filter((c) => moneyView || !c.m);
  if (moneyView) cols.push({ label: 'إجمالي التكلفة (جنيه)', v: (i) => i.amount, m: true, msum: 'amount' });
  const cell = (c, i) => {
    const x = c.v(i);
    if (x === null || x === undefined || x === '') return '';
    if (c.m) return money(x);
    return c.text ? x : num(x);
  };
  const strip = [];
  for (const c of cols) if (c.sum && sec.sums[c.sum]) strip.push(h('span', {}, c.label, h('b', {}, num(sec.sums[c.sum]))));
  if (moneyView) {
    if (sec.section === 'press') {
      if (sec.thin_amount) strip.push(h('span', {}, 'مبلغ أقل من 3مم', h('b', {}, money(sec.thin_amount))));
      if (sec.thick_amount) strip.push(h('span', {}, 'مبلغ 3مم فأكبر', h('b', {}, money(sec.thick_amount))));
      if (sec.fixed_amount) strip.push(h('span', {}, 'مبلغ السعر المحدد', h('b', {}, money(sec.fixed_amount))));
      if (sec.lump_amount) strip.push(h('span', {}, 'مبالغ مقطوعة', h('b', {}, money(sec.lump_amount))));
    }
    strip.push(h('span', {}, 'المبلغ', h('b', {}, money(sec.amount))));
  }
  const table = h('table', { class: 'cards pr-sheet' },
    h('thead', {}, h('tr', {}, cols.map((c) => h('th', { class: c.text ? null : 'n' }, c.label)), h('th', {}, 'رقم الورقة'), h('th', {}, 'الفني'), h('th', {}, ''))),
    h('tbody', {}, sec.items.length ? null : h('tr', { class: 'muted-row' }, h('td', { colspan: cols.length + 3, class: 'muted' }, 'مفيش شغل في القسم ده')),
      sec.items.map((i) => h('tr', { class: i.status === 'suggested' ? 'muted-row' : null },
      cols.map((c) => h('td', { 'data-label': c.label, class: [c.text ? '' : 'n', c.cls || '', c.m || c.sum ? 'computed' : ''].join(' ').trim() || null }, cell(c, i))),
      h('td', { 'data-label': 'رقم الورقة', class: 'num' }, i.sheet_id ? h('a', { href: sheetHref(i) }, i.sheet_serial) : ''),
      h('td', { 'data-label': 'الفني' }, i.technician_name || ''),
      h('td', { 'data-label': 'الحالة' }, status(i))))));
  return h('div', { class: 'pr-section' },
    h('div', { class: 'section-title' }, h('h2', {}, icon('table', 'sm'), ` ${sec.name}`), h('span', { class: 'small muted' }, `${sec.items.length} سطر`)),
    h('div', { class: 'pr-sumstrip' }, strip.length ? strip : h('span', {}, 'الإجمالي')),
    h('div', { class: 'table-wrap' }, table));
}
