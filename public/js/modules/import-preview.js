// معاينة الاستيراد: what the admin decides before anything is written. Each panel edits the
// decisions object in place and calls changed(); the run screen sends them to the server,
// which rebuilds the preview and the simulated reconciliation.
//   names       the name each merged party gets, and similar names to merge
//   partners    the class of every partner row (إيداع / مصروف / سحب / شيك) and its account
//   dates       swapped day/month, rows with no date above them, conflicts
//   duplicates  rows that look entered twice (kept unless ticked), rows left out
//   formula     rows whose Excel amount is not our formula (imported as a lump amount)
//   expenses    category and cost centre of each daily expense
import { h, notice, pill, money, fmtDate, selectInput, emptyState, num } from '../ui.js';

const KIND_NAMES = {
  swapped: 'اليوم والشهر متبدلين (الإكسيل قراه بالأمريكاني)', inherited_first: 'مفيش تاريخ فوقه — خد أول تاريخ تحته',
  invalid: 'التاريخ مكتوب غلط', conflict: 'التاريخ في العمود غير اللي مكتوب في الوصف', stored_ambiguous: 'ممكن يتقري بطريقتين',
};
const cell = (label, ...c) => h('td', { 'data-label': label }, ...c);
const table = (heads, rows) => h('div', { class: 'table-wrap' }, h('table', { class: 'cards' },
  h('thead', {}, h('tr', {}, heads.map((x) => h('th', { class: x.n ? 'n' : null }, x.label || x)))), h('tbody', {}, rows)));
const ref = (r) => h('span', { class: 'small muted ltr' }, r);

export function namesPanel(p, dec, changed) {
  const names = p.names || [];
  const sugg = p.suggestions || [];
  if (!names.length && !sugg.length) return emptyState('users-three', 'مفيش أسماء محتاجة قرار', 'كل اسم في الملف ليه شكل واحد.', null, true);
  dec.names ||= {};
  dec.merges ||= [];
  const isMerged = (a, b) => dec.merges.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  return h('div', {},
    names.length ? h('div', {},
      h('p', { class: 'muted small' }, 'الأسماء دي اتجمعت على طرف واحد (من الكشف المربوط أو صف الملخص أو نفس الاسم من غير «م/»). اختار الاسم اللي يظهر في البرنامج — الباقي يتسجل أسماء تانية ليه.'),
      table(['النوع', 'الأشكال اللي في الملف', 'ليه اتجمعوا', 'الاسم في البرنامج'], names.map((n) => {
        const sel = selectInput(n.spellings.map((s) => [s, s]), dec.names[n.group] || n.name);
        sel.addEventListener('change', () => { dec.names[n.group] = sel.value; changed(); });
        return h('tr', {}, cell('النوع', n.kind === 'supplier' ? 'مورد' : 'عميل'), cell('الأشكال', n.spellings.join(' / ')),
          cell('ليه', (n.reasons || []).join('، ') || '—'), cell('الاسم', sel));
      }))) : null,
    sugg.length ? h('div', {},
      h('h3', { class: 'section-title' }, 'أسماء شبه بعض ومش متجمعة'),
      h('p', { class: 'muted small' }, 'علّم على الاتنين لو هما نفس الطرف عشان يتسجلوا طرف واحد.'),
      table(['النوع', 'الاسم الأول', 'الاسم التاني', 'نفس الطرف؟'], sugg.map((s) => {
        const box = h('input', { type: 'checkbox', checked: isMerged(s.a, s.b) });
        box.addEventListener('change', () => {
          dec.merges = dec.merges.filter(([x, y]) => !((x === s.a && y === s.b) || (x === s.b && y === s.a)));
          if (box.checked) dec.merges.push([s.a, s.b]);
          changed();
        });
        return h('tr', {}, cell('النوع', s.kind === 'supplier' ? 'مورد' : 'عميل'), cell('الأول', s.a_name), cell('التاني', s.b_name),
          cell('نفس الطرف', h('label', { class: 'check-row' }, box, 'ادمجهم')));
      }))) : null);
}

const CLASS_NAMES = { deposit: 'إيداع من الشريك', expense: 'مصروف دفعه الشريك', withdrawal: 'سحب نقدي للشريك', cheque: 'شيك من الشركة للشريك', skip: 'متستوردش' };

export function partnersPanel(p, dec, changed, categories) {
  const rows = p.partners || [];
  if (!rows.length) return emptyState('handshake', 'مفيش حركات شركاء في الملف', 'شيت «حسابات الشركاء» فاضي أو مش موجود.', null, true);
  dec.partners ||= {};
  return h('div', {},
    h('p', { class: 'muted small' }, 'كل صف في شيت الشريك اتصنف: «تغذية/إيداع» إيداع في البنك، البنود المعروفة (كهرباء، إيجار، مرتبات…) مصروف دفعه الشريك من جيبه، والشيكات اللي في شيت «الشيكات» شيك من الشركة ليه (بيتسجل مرة واحدة)، والباقي سحب نقدي. غيّر أي تصنيف هنا.'),
    table(['الشريك', 'الوصف', 'التاريخ', { label: 'المبلغ', n: true }, 'التصنيف', 'الحساب / البند'], rows.map((r) => {
      const d = dec.partners[r.ref] ||= {};
      const cls = selectInput(r.options.map((o) => [o, CLASS_NAMES[o]]), d.class || r.class);
      const acc = selectInput([['bank', 'البنك'], ['cash', 'الخزينة']], d.account || r.account);
      const cat = selectInput(categories.map((c) => [c.id, c.name]), d.category_id || r.category_id || '');
      const extra = h('div', {});
      const show = () => {
        const c = cls.value;
        extra.replaceChildren(...(c === 'deposit' || c === 'withdrawal' ? [acc] : c === 'expense' ? [cat] : c === 'cheque' ? [h('span', { class: 'small muted' }, r.cheque_ref ? `من شيت الشيكات ${r.cheque_ref}` : 'مش لاقي الشيك في شيت الشيكات')] : []));
      };
      cls.addEventListener('change', () => { d.class = cls.value; show(); changed(); });
      acc.addEventListener('change', () => { d.account = acc.value; changed(); });
      cat.addEventListener('change', () => { d.category_id = Number(cat.value); changed(); });
      show();
      return h('tr', {}, cell('الشريك', r.partner, h('div', {}, ref(r.ref))),
        cell('الوصف', r.desc || h('span', { class: 'muted' }, 'من غير وصف'), r.flag ? h('div', {}, pill('warn', r.flag)) : null, h('div', { class: 'small muted' }, r.side_name)),
        cell('التاريخ', fmtDate(r.date)), h('td', { class: 'n', 'data-label': 'المبلغ' }, money(r.amount)), cell('التصنيف', cls), cell('الحساب', extra));
    })));
}

export function datesPanel(p, dec, changed) {
  const rows = p.dates || [];
  if (!rows.length) return emptyState('calendar-check', 'كل التواريخ واضحة', 'مفيش تاريخ محتاج قرار.', null, true);
  dec.dates ||= {};
  return h('div', {},
    h('p', { class: 'muted small' }, `التاريخ الفاضي بياخد تاريخ الصف اللي فوقه. لو غيّرت تاريخ هنا، الصفوف اللي تحته من غير تاريخ بتمشي وراه. تاريخ احتياطي للملف: ${fmtDate(p.fallback)}.`),
    table(['الخلية', 'المكتوب', 'السبب', 'التاريخ اللي هيتسجل'], rows.map((r) => {
      const input = h('input', { type: 'date', class: 'ltr', value: dec.dates[r.ref] || r.date || '' });
      input.addEventListener('change', () => { if (input.value) dec.dates[r.ref] = input.value; else delete dec.dates[r.ref]; changed(); });
      const opts = (r.options || []).length > 1 ? h('div', { class: 'small muted' }, 'ممكن: ', r.options.map((o, i) => [i ? ' أو ' : '', fmtDate(o)])) : null;
      return h('tr', {}, cell('الخلية', ref(r.ref)), cell('المكتوب', r.text || h('span', { class: 'muted' }, 'فاضي')),
        cell('السبب', pill(r.kind === 'override' ? 'neutral' : 'warn', KIND_NAMES[r.kind] || r.kind), r.followers ? h('div', { class: 'small muted' }, `ومعاه ${r.followers} صف تحته`) : null, opts),
        cell('التاريخ', input));
    })));
}

export function duplicatesPanel(p, dec, changed) {
  dec.skip ||= {};
  const dups = p.duplicates || [];
  const skipped = p.skipped || [];
  const log = p.log || [];
  return h('div', {},
    dups.length ? h('div', {},
      h('p', { class: 'muted small' }, 'الصفوف دي شبه صف قبلها بالظبط (نفس التاريخ والبيان والمبلغ). بتتستورد زي ما هي عشان الإجماليات تطابق الإكسيل — علّم «متستوردش» لو اتكتبت مرتين بالغلط.'),
      table(['الخلية', 'البيان', 'التاريخ', { label: 'المبلغ', n: true }, 'نفس صف', ''], dups.map((d) => {
        const box = h('input', { type: 'checkbox', checked: !!dec.skip[d.ref] });
        box.addEventListener('change', () => { if (box.checked) dec.skip[d.ref] = true; else delete dec.skip[d.ref]; changed(); });
        return h('tr', {}, cell('الخلية', ref(d.ref)), cell('البيان', d.text || '—'), cell('التاريخ', fmtDate(d.date)),
          h('td', { class: 'n', 'data-label': 'المبلغ' }, money(d.amount)), cell('نفس صف', ref(d.of)), cell('', h('label', { class: 'check-row' }, box, 'متستوردش')));
      }))) : notice('ok', 'مفيش صفوف مكررة.'),
    skipped.length ? h('div', {},
      h('h3', { class: 'section-title' }, 'صفوف مش هتتستورد'),
      table(['الخلية', 'السبب', 'المكتوب'], skipped.map((s) => h('tr', {}, cell('الخلية', ref(s.ref)), cell('السبب', s.reason), cell('المكتوب', s.text || '—'))))) : null,
    log.length ? h('div', {},
      h('h3', { class: 'section-title' }, 'سطور في «عملاء» مش موجودة في شيت العميل'),
      h('p', { class: 'muted small' }, 'بتتسجل في التاريخ بس (اتحاسبت في الإكسيل) — من غير فلوس ومن غير ما تدخل طابور التسعير.'),
      table(['الخلية', 'القسم', 'العميل', 'التاريخ'], log.map((l) => h('tr', {}, cell('الخلية', ref(l.ref)), cell('القسم', l.section_name), cell('العميل', l.client_name || '—'), cell('التاريخ', fmtDate(l.date)))))) : null);
}

export function formulaPanel(p) {
  const rows = p.formula || [];
  if (!rows.length) return emptyState('check-circle', 'كل الصفوف مطابقة للمعادلة', 'مبلغ كل صف في شيتات الشغل هو نفس اللي بيحسبه البرنامج.', null, true);
  return h('div', {},
    h('p', { class: 'muted small' }, 'الصفوف دي مبلغها في الإكسيل مختلف عن المعادلة (غالبًا مكتوب بإيد فوق المعادلة). بتتسجل بمبلغ الإكسيل كـ«مبلغ مقطوع» عشان الحساب يطابق، والفرق مكتوب في ملاحظة البند.'),
    table(['الخلية', 'القسم', { label: 'الإكسيل', n: true }, { label: 'المعادلة', n: true }, 'السبب'], rows.map((r) => h('tr', {},
      cell('الخلية', ref(r.ref)), cell('القسم', r.section_name), h('td', { class: 'n', 'data-label': 'الإكسيل' }, r.excel_amount === null ? '—' : money(r.excel_amount)),
      h('td', { class: 'n', 'data-label': 'المعادلة' }, r.formula_amount === null || r.formula_amount === undefined ? '—' : money(r.formula_amount)),
      cell('السبب', r.info ? pill('neutral', r.reason) : r.reason)))));
}

export function expensesPanel(p, dec, changed, categories) {
  const rows = p.expenses || [];
  if (!rows.length) return emptyState('receipt', 'مفيش مصروفات يومية في الملف', '', null, true);
  dec.expenses ||= {};
  const clients = [['', 'عام (من غير عميل)'], ...(p.clients || []).map((c) => [c.id, c.name])];
  return h('div', {},
    h('p', { class: 'muted small' }, 'كل مصروف بيتسجل إذن صرف من الخزينة. البند متخمّن من الكلام، ولو البيان فيه اسم عميل بيتحط مركز تكلفة (مش بيتحمّل على حسابه).'),
    table(['التاريخ', 'البيان', { label: 'المبلغ', n: true }, 'البند', 'مركز التكلفة'], rows.map((r) => {
      const d = dec.expenses[r.ref] ||= {};
      const cat = selectInput(categories.map((c) => [c.id, c.name]), d.category_id || r.category_id || '');
      const cost = selectInput(clients, d.cost_client !== undefined ? d.cost_client : r.cost_client || '');
      cat.addEventListener('change', () => { d.category_id = Number(cat.value); changed(); });
      cost.addEventListener('change', () => { d.cost_client = cost.value; changed(); });
      return h('tr', {}, cell('التاريخ', fmtDate(r.date)), cell('البيان', r.desc, h('div', {}, ref(r.ref))),
        h('td', { class: 'n', 'data-label': 'المبلغ' }, money(r.amount)), cell('البند', cat), cell('مركز التكلفة', cost));
    })));
}

export function countsLine(c = {}, simulated = null) {
  const items = [
    ['عملاء', c.clients], ['موردين', c.suppliers], ['شركاء', c.partners], ['بنود شغل متسعرة', c.work_posted],
    ['بنود اتحاسبت في الإكسيل', c.work_settled], ['قيود من الكشوف', c.manual], ['إيصالات', c.receipts],
    ['حركات شركاء', c.partner_rows], ['مصروفات', c.expenses], ['شراء خامات', c.purchases],
  ].filter(([, v]) => v);
  return h('div', { class: 'stats' }, items.map(([label, v]) => h('div', { class: 'stat' }, h('div', { class: 'small muted' }, label), h('strong', { class: 'num' }, num(v)))),
    simulated ? h('div', { class: 'stat' }, h('div', { class: 'small muted' }, 'أوراق تشغيل'), h('strong', { class: 'num' }, num(simulated.sheets))) : null);
}
