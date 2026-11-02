// الرئيسية for staff (المطلوب النهارده) and سجل الإنتاج (approved lines, quantities only).
import { h, fill, icon, button, pageHead, emptyState, skeleton, field, dataTable, pill, num, todayISO, fmtDate, loadInto } from '../ui.js';
import { get } from '../api.js';
import { opsStyles } from './ops-css.js';
import { clients, machineSelect, technicianSelect, countsPills } from './ops-common.js';
import { OPS } from './ops-paper.js';

const WEEKDAY = new Intl.DateTimeFormat('ar-EG-u-nu-latn', { weekday: 'long', day: 'numeric', month: 'long' });

export async function homeStaff(main, _params, ctx) {
  opsStyles();
  const d = await get('/api/operations/home');
  const stat = (href, label, value, kind = '', hint = '') => h('a', { class: `stat ${kind}`.trim(), href },
    h('span', {}, label), h('b', { class: 'num' }, num(value)), hint ? h('span', { class: 'small' }, hint) : null);
  const stats = [];
  if (d.review) stats.push(stat('#/ops/review', 'ورق مستني مراجعة', d.review.count, d.review.red ? 'danger' : d.review.count ? 'warn' : '', d.review.red ? `${d.review.red} فيها أحمر` : ''));
  if (d.photos) stats.push(stat('#/ops/photos', 'صور بتتقري', d.photos.reading, '', d.photos.needs_machine || d.photos.failed ? `${d.photos.needs_machine + d.photos.failed} محتاجة منك حاجة` : ''));
  if (d.drafts) stats.push(stat('#/ops/sheets?status=draft', 'مسوداتك', d.drafts.length));
  if (d.orders) stats.push(stat('#/ops/orders', 'أوامر شغل مفتوحة', d.orders.count, d.orders.due_soon.length ? 'warn' : '', d.orders.due_soon.length ? `${d.orders.due_soon.length} ميعادها قرّب` : ''));

  const listCard = (title, ic, items, empty) => h('div', { class: 'card list-card' }, h('h3', {}, icon(ic, 'sm'), title),
    items.length ? h('div', { class: 'ops-list' }, items) : h('div', { class: 'empty compact' }, h('div', { class: 'small' }, empty)));
  const sheetLink = (s, href) => h('a', { href }, h('b', { class: 'num' }, s.serial),
    h('span', { class: 'grow' }, `${s.machine_name}${s.technician_name ? ` · ${s.technician_name}` : ''}`, h('div', { class: 'small' }, `${fmtDate(s.sheet_date)} · ${s.lines_count} ${s.lines_count === 1 ? 'سطر' : 'سطور'}`)),
    s.counts ? countsPills(s.counts) : null, icon('caret-left', 'sm'));
  const lists = [];
  if (d.review) lists.push(listCard('مستنية مراجعة (الأقدم الأول)', 'seal-check', d.review.oldest.map((s) => sheetLink(s, `#/ops/review/${s.id}`)), 'مفيش ورق مستني مراجعة.'));
  if (d.drafts) lists.push(listCard('مسوداتك', 'note-pencil', d.drafts.map((s) => sheetLink(s, `#/ops/sheets/${s.id}`)), 'مفيش مسودات — كل اللي كتبته اتبعت.'));
  if (d.orders) {
    lists.push(listCard('أوامر شغل ميعادها قرّب', 'clipboard-text', d.orders.due_soon.map((o) => h('a', { href: `#/ops/orders/${o.id}` },
      h('b', { class: 'num' }, o.serial), h('span', { class: 'grow' }, o.client_name, h('div', { class: 'small' }, o.description)),
      o.due_date < d.today ? pill('danger', 'متأخر') : pill('warn', fmtDate(o.due_date)), icon('caret-left', 'sm'))), 'مفيش أوامر ميعادها قرّب.'));
  }
  const nothing = !d.review?.count && !d.photos?.reading && !d.photos?.needs_machine && !d.photos?.failed && !d.drafts?.length && !d.orders?.due_soon.length;
  fill(main, h('div', { class: 'ops ops-home' },
    pageHead('المطلوب النهارده', WEEKDAY.format(new Date(`${d.today}T12:00:00`)),
      ctx.can('operations.record') ? [button('ورقة جديدة', { href: '#/ops/sheets/new', icon: 'file-plus' }), button('صوّر ورقة', { href: '#/ops/photos', icon: 'camera', kind: 'primary' })] : null),
    stats.length ? h('div', { class: 'stats' }, stats) : null,
    nothing ? h('div', { style: 'margin-top:16px' }, emptyState('check-circle', 'مفيش حاجة مستنياك دلوقتي',
      d.approved_today ? `اتعتمد النهارده ${d.approved_today} ${d.approved_today === 1 ? 'ورقة' : 'أوراق'}. أول ما ورقة جديدة تتصور هتظهر هنا.` : 'أول ما ورقة الفني تتصور أو تتكتب هتظهر هنا للمراجعة.',
      ctx.can('operations.record') ? button('صوّر ورقة', { href: '#/ops/photos', icon: 'camera', kind: 'primary' }) : null)) : null,
    !nothing ? h('div', { class: 'lists' }, lists) : null));
}

// ---------- سجل الإنتاج ----------
export async function productionLog(main, _params, ctx) {
  opsStyles();
  const L = ctx.state.lookups;
  const today = todayISO();
  const list = await clients().catch(() => []);
  const f = {
    from: h('input', { type: 'date', value: ctx.query?.from || `${today.slice(0, 7)}-01` }),
    to: h('input', { type: 'date', value: ctx.query?.to || today }),
    machine: machineSelect(ctx.query?.machine || '', 'كل المكن'),
    technician_id: technicianSelect(L.technicians, ctx.query?.technician_id, 'كل الفنيين'),
    client_id: h('select', {}, h('option', { value: '' }, 'كل العملاء'), list.map((c) => h('option', { value: c.id }, c.name))),
  };
  const box = h('div', {}, skeleton('table'));
  const qtyText = (r) => {
    if (r.machine === 'press' || r.machine === 'shear') {
      return `${num(r.pieces)} قطعة${r.per_piece != null ? ` × ${num(r.per_piece)} = ${num(r.ops)} ${OPS[r.machine].one}` : ''}`;
    }
    const parts = [];
    if (r.sheets != null) parts.push(`${num(r.sheets)} لوح${r.minutes_per_sheet != null ? ` × ${num(r.minutes_per_sheet)} د` : ''}`);
    if (r.louvers_per_piece != null) parts.push(`${num(r.pieces)} قطعة × ${num(r.louvers_per_piece)} لوفر`);
    return parts.join(' · ') || '—';
  };
  const load = () => loadInto(box, async () => {
    const d = await get('/api/operations/production', Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value])));
    if (!d.rows.length) {
      return emptyState('factory', 'مفيش إنتاج معتمد في الفترة دي', 'السجل بيعرض السطور من الأوراق المعتمدة بس. غيّر التاريخ أو راجع الأوراق اللي مستنية.',
        ctx.can('operations.approve') ? button('المراجعة والاعتماد', { href: '#/ops/review', icon: 'seal-check' }) : null, true);
    }
    return h('div', { class: 'grid' },
      h('div', { class: 'stats' }, d.by_machine.map((m) => h('div', { class: 'stat' },
        h('span', {}, m.machine_name),
        h('b', { class: 'num' }, m.machine === 'press' || m.machine === 'shear' ? `${num(m.ops)} ${OPS[m.machine].one}` : `${num(m.sheets)} لوح`),
        h('span', { class: 'small' }, m.machine === 'press' || m.machine === 'shear' ? `${num(m.pieces)} قطعة` : `${num(m.minutes)} دقيقة`, ` · ${m.lines} ${m.lines === 1 ? 'سطر' : 'سطور'}`)))),
      dataTable([
        { label: 'التاريخ', value: (r) => h('span', { class: 'num' }, fmtDate(r.work_date)) },
        { label: 'الورقة', value: (r) => h('a', { href: `#/ops/sheets/${r.sheet_id}`, class: 'num', onclick: (e) => e.stopPropagation() }, r.sheet_serial) },
        { label: 'المكنة', value: (r) => r.machine_name },
        { label: 'الفني', value: (r) => r.technician_name || '—' },
        { label: 'العميل', value: (r) => r.client_name || '—' },
        { label: 'القطعة', value: (r) => r.part_name || '—' },
        { label: 'الخامة', value: (r) => `${r.material_name || r.material_text || ''}${r.thickness ? ` ${num(r.thickness)} مم` : ''}` || '—' },
        { label: 'الكمية', value: (r) => h('span', { class: 'qty' }, qtyText(r)) },
        { label: 'المصدر', value: (r) => (r.material_source === 'factory' ? pill('accent', 'خامة المصنع') : h('span', { class: 'small muted' }, 'خامة العميل')) },
      ], d.rows));
  });
  for (const el of Object.values(f)) el.addEventListener('change', load);
  fill(main, h('div', { class: 'ops' },
    pageHead('سجل الإنتاج', 'الشغل اللي اتعمل على كل مكنة من الأوراق المعتمدة، بالكميات.'),
    h('div', { class: 'ops-filters' }, field('من', f.from), field('لحد', f.to), field('المكنة', f.machine), field('الفني', f.technician_id), field('العميل', f.client_id)),
    box));
  await load();
}
