// جدول المطابقة: every figure of the workbook next to the app's figure and the difference.
// A row is green when the difference prints as 0.00; «المخزن حاليا» is a known wrong Excel
// figure and is shown with its explanation instead of a red mark.
import { h, pill, notice, money } from '../ui.js';

const GROUPS = { clients: 'العملاء («ملخص العملاء»)', work: 'شيتات الشغل (الإجمالي E1)', partners: 'الشركاء («حسابات الشركاء»)', ledgers: 'المصروفات والشيكات والخامات', store: '«المخزن حاليا»' };
const shown = (m) => money(Math.abs(m) < 5 ? 0 : m);

function partsLine(r) {
  if (!r.parts?.length) return null;
  const list = r.total || !r.ok ? r.parts : [];
  if (!list.length) return null;
  return h('div', { class: 'small muted' }, list.map((p, i) => [i ? ' · ' : '', `${p.label}: `,
    h('span', { class: 'num' }, `${shown(p.excel_amount)} / ${shown(p.app_amount)}`), p.ok ? '' : h('span', { style: 'color:var(--red)' }, ` (فرق ${shown(p.diff_amount)})`)]));
}

export function reconciliationTable(rec, { title = 'المطابقة: الإكسيل قصاد البرنامج' } = {}) {
  if (!rec?.rows?.length) return notice('info', 'المطابقة هتظهر هنا بعد ما الملف يتقري.');
  const body = [];
  let group = null;
  for (const r of rec.rows) {
    if (r.group !== group) {
      group = r.group;
      body.push(h('tr', { class: 'sum' }, h('td', { colspan: 5 }, h('strong', {}, GROUPS[group] || group))));
    }
    const status = r.known ? pill(r.explained_ok ? 'neutral' : 'warn', r.explained_ok ? 'غلط معروف ومتفسّر' : 'محتاج مراجعة')
      : pill(r.ok ? 'ok' : 'danger', r.ok ? 'مطابق' : 'مش مطابق');
    body.push(h('tr', { class: r.total ? 'sum' : null },
      h('td', { 'data-label': 'البند' }, r.label, partsLine(r), r.note ? h('div', { class: 'small muted' }, r.note) : null),
      h('td', { class: 'n', 'data-label': 'الإكسيل' }, shown(r.excel_amount)),
      h('td', { class: 'n', 'data-label': 'البرنامج' }, shown(r.app_amount)),
      h('td', { class: 'n', 'data-label': 'الفرق', style: !r.ok && !r.known ? 'color:var(--red)' : null }, shown(r.diff_amount)),
      h('td', { 'data-label': 'الحالة' }, status)));
  }
  return h('div', {},
    h('h3', { class: 'section-title' }, title),
    rec.ok ? notice('ok', 'كل الأرقام مطابقة للإكسيل لحد القرش.') : notice('danger', `فيه ${rec.mismatches} سطر مش مطابق — راجع الاختيارات قبل التأكيد.`),
    ...(rec.warnings || []).map((w) => notice('warn', w)),
    h('div', { class: 'table-wrap' }, h('table', { class: 'cards' },
      h('thead', {}, h('tr', {}, h('th', {}, 'البند'), h('th', { class: 'n' }, 'الإكسيل'), h('th', { class: 'n' }, 'البرنامج'), h('th', { class: 'n' }, 'الفرق'), h('th', {}, 'الحالة'))),
      h('tbody', {}, body))));
}
