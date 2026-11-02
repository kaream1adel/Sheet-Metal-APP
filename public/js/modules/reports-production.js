// الإنتاج: quantities from approved operation sheets (no money — the workshop manager sees it).
import { h, fill, pageHead, skeleton, emptyState, dataTable, num, loadInto, tabs, selectInput, field, todayISO, button } from '../ui.js';
import { get } from '../api.js';
import { filters, dateFilter } from './reports-common.js';

const GROUPS = [
  { key: 'machine', label: 'بالمكنة', icon: 'factory' },
  { key: 'technician', label: 'بالفني', icon: 'hard-hat' },
  { key: 'client', label: 'بالعميل', icon: 'users-three' },
  { key: 'month', label: 'بالشهر', icon: 'calendar-blank' },
];
const MACHINES = [['', 'كل المكن'], ['press', 'التناية'], ['shear', 'المقص'], ['laser', 'الليزر'], ['punch', 'البنش']];

const q = (v, d = 3) => (v ? num(v, d) : '—');

export async function production(main, _p, ctx) {
  const t = todayISO();
  const state = { group: ctx.query.group || 'machine', from: ctx.query.from || `${t.slice(0, 7)}-01`, to: ctx.query.to || t, machine: ctx.query.machine || '' };
  const box = h('div', {}, skeleton('table'));
  const tabBox = h('div');
  const machine = selectInput(MACHINES, state.machine);
  machine.addEventListener('change', () => { state.machine = machine.value; load(); });

  const drawTabs = () => fill(tabBox, tabs(GROUPS, state.group, (k) => { state.group = k; drawTabs(); load(); }));
  const load = () => loadInto(box, async () => {
    const r = await get('/api/reports/production', { group: state.group, from: state.from, to: state.to, machine: state.machine });
    if (!r.rows.length) {
      return emptyState('factory', 'مفيش إنتاج معتمد في الفترة دي', 'الإنتاج بيتحسب من أوراق التشغيل بعد الاعتماد. وسّع الفترة أو اعتمد الأوراق المستنية.',
        ctx.can('operations.approve') ? button('المراجعة والاعتماد', { kind: 'primary', href: '#/ops/review', icon: 'seal-check' }) : null, true);
    }
    const s = r.sum;
    const show = (k) => r.rows.some((row) => row[k]);
    const cols = [
      { label: r.group_label, value: (row) => h('b', {}, row.label) },
      { label: 'أوراق', n: true, value: (row) => num(row.op_sheets) },
      { label: 'بنود', n: true, value: (row) => num(row.lines) },
      show('pieces') ? { label: 'قطع', n: true, value: (row) => q(row.pieces) } : null,
      show('bends') ? { label: 'تنيات', n: true, value: (row) => q(row.bends) } : null,
      show('cuts') ? { label: 'قصات', n: true, value: (row) => q(row.cuts) } : null,
      show('sheets') ? { label: 'ألواح (ليزر وبنش)', n: true, value: (row) => q(row.sheets) } : null,
      show('minutes') ? { label: 'دقايق', n: true, value: (row) => q(row.minutes) } : null,
      show('louvers') ? { label: 'لوفر', n: true, value: (row) => q(row.louvers) } : null,
      show('kg') ? { label: 'وزن خامة المصنع (كجم)', n: true, value: (row) => q(row.kg, 2) } : null,
    ].filter(Boolean);
    const keyOf = { 'أوراق': 'op_sheets', 'بنود': 'lines', 'قطع': 'pieces', 'تنيات': 'bends', 'قصات': 'cuts', 'ألواح (ليزر وبنش)': 'sheets', 'دقايق': 'minutes', 'لوفر': 'louvers', 'وزن خامة المصنع (كجم)': 'kg' };
    return [
      dataTable(cols, r.rows, { foot: cols.map((c, i) => (i === 0 ? { value: 'الإجمالي' } : { n: true, value: q(s[keyOf[c.label]], keyOf[c.label] === 'kg' ? 2 : 3) })) }),
      h('p', { class: 'small muted' }, 'التنيات والقصات = عدد القطع × العدد للقطعة. الدقايق = الألواح × دقايق اللوح + دقيقة لكل لوح. الوزن لخامة المصنع بس = السمك/10 × الطول × العرض × العدد × الكثافة ÷ 1000.'),
    ];
  });
  fill(main,
    pageHead('الإنتاج', 'الشغل اللي اتعمل من أوراق التشغيل المعتمدة — كميات بس.'),
    filters(
      dateFilter('من', state.from, (v) => { state.from = v; load(); }),
      dateFilter('لحد', state.to, (v) => { state.to = v; load(); }),
      field('المكنة', machine)),
    tabBox, box);
  drawTabs();
  await load();
}
