// أوراق التشغيل: the list, ورقة جديدة and the sheet itself — the Excel-like grid with exactly
// the technician paper's columns of its machine, the photo beside it, and the red / yellow
// panel. The same editor is the review screen (المراجعة والاعتماد); on the phone the review
// shows one row per screen.
import { h, fill, icon, button, pageHead, backLink, emptyState, skeleton, field, textInput, selectInput, toast, toastError,
  notice, dataTable, confirmModal, pill, num, todayISO, fmtDate, loadInto } from '../ui.js';
import { get, post, put } from '../api.js';
import { createGrid, isDitto } from '../grid.js';
import * as P from './ops-paper.js';
import { opsStyles } from './ops-css.js';
import {
  clients, clientsNow, clientByText, createClient, addAlias, openOrders, ordersNow, statusPill, countsPills, photoViewer,
  machineSelect, technicianSelect, createTechnician, fileToJpeg, dateText,
} from './ops-common.js';

const PHONE = '(max-width: 820px)';
const isPhone = () => !!window.matchMedia?.(PHONE).matches;

// ---------- أوراق التشغيل ----------
export async function sheetsList(main, _params, ctx) {
  opsStyles();
  const L = ctx.state.lookups;
  const q = ctx.query || {};
  const cl = await clients().catch(() => []);
  const f = {
    machine: machineSelect(q.machine || '', 'كل المكن'),
    technician_id: technicianSelect(L.technicians, q.technician_id, 'كل الفنيين'),
    client_id: h('select', {}, h('option', { value: '' }, 'كل العملاء'), cl.map((c) => h('option', { value: c.id, selected: String(c.id) === q.client_id }, c.name))),
    from: h('input', { type: 'date', value: q.from || '' }),
    to: h('input', { type: 'date', value: q.to || '' }),
    status: selectInput([['', 'كل الحالات'], ['draft', 'مسودة'], ['review', 'في المراجعة'], ['approved', 'معتمدة'], ['priced', 'اتسعرت'], ['cancelled', 'ملغية']], q.status || ''),
    q: textInput({ placeholder: 'تش-0001', value: q.q || '', inputmode: 'numeric' }),
  };
  const box = h('div', {}, skeleton('table'));
  const actions = [
    ctx.can('operations.record') ? button('صوّر ورقة', { href: '#/ops/photos', icon: 'camera' }) : null,
    ctx.can('operations.record') ? button('ورقة جديدة', { href: '#/ops/sheets/new', icon: 'file-plus', kind: 'primary' }) : null,
  ];
  const load = () => loadInto(box, async () => {
    const params = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value]));
    const { sheets } = await get('/api/operations/sheets', params);
    const filtered = Object.values(params).some(Boolean);
    if (!sheets.length) {
      return filtered
        ? emptyState('funnel', 'مفيش أوراق بالفلتر ده', 'غيّر المكنة أو التاريخ أو الحالة.', button('شيل الفلتر', { onClick: () => { for (const el of Object.values(f)) el.value = ''; load(); } }), true)
        : emptyState('files', 'لسه مفيش أوراق تشغيل', 'صوّر ورقة الفني والبرنامج يقراها، أو اكتبها بنفس أعمدة الورق.',
          h('div', { class: 'row' }, actions));
    }
    return dataTable([
      { label: 'الرقم', value: (s) => h('b', { class: 'num' }, s.serial) },
      { label: 'المكنة', value: (s) => s.machine_name },
      { label: 'الفني', value: (s) => s.technician_name || h('span', { class: 'muted' }, '—') },
      { label: 'التاريخ', value: (s) => h('span', { class: 'num' }, fmtDate(s.sheet_date)) },
      { label: 'العملاء', value: (s) => h('span', { class: 'small' }, s.clients || '—') },
      { label: 'السطور', n: true, value: (s) => num(s.lines_count) },
      { label: 'الحالة', value: (s) => h('span', { class: 'row', style: 'gap:6px' }, statusPill(s.view_status), s.counts && s.view_status === 'review' ? countsPills(s.counts) : null,
        s.has_photo ? h('span', { title: 'ليها صورة', class: 'muted' }, icon('image', 'sm')) : null) },
      { label: 'التسعير', value: (s) => (s.status === 'approved' ? pill(s.priced_status === 'posted' ? 'ok' : s.priced_status === 'partial' ? 'warn' : 'neutral', s.priced_name) : h('span', { class: 'muted' }, '—')) },
    ], sheets, { onRow: (s) => ctx.go(s.view_status === 'review' && ctx.can('operations.approve') ? `#/ops/review/${s.id}` : `#/ops/sheets/${s.id}`) });
  });
  for (const el of Object.values(f)) el.addEventListener(el.tagName === 'INPUT' && el.type !== 'date' ? 'input' : 'change', debounce(load, 250));
  fill(main, h('div', { class: 'ops' },
    pageHead('أوراق التشغيل', 'كل أوراق الفنيين بحالتها: مسودة، في المراجعة، معتمدة، اتسعرت.', actions),
    h('div', { class: 'ops-filters' },
      field('المكنة', f.machine), field('الفني', f.technician_id), field('العميل', f.client_id), field('من', f.from), field('لحد', f.to),
      field('الحالة', f.status), field('رقم الورقة', f.q)),
    box));
  await load();
}

// ---------- ورقة جديدة ----------
export async function sheetNew(main, _params, ctx) {
  opsStyles();
  await Promise.all([clients().catch(() => []), openOrders()]);
  const machine = P.MACHINES.includes(ctx.query?.machine) ? ctx.query.machine : null;
  // «ورقة جديدة على الأمر»: new rows start on that order and its client.
  const order = ctx.query?.order ? ordersNow().find((o) => String(o.id) === String(ctx.query.order)) : null;
  const rowDefaults = order ? { work_order_id: order.id, work_order_serial: order.serial, client_id: order.client_id, client_text: order.client_name } : {};
  return sheetEditor(main, null, ctx, { machine, rowDefaults });
}

// '#/ops/sheets/:id' and '#/ops/review/:id'
export async function sheetView(main, params, ctx) {
  opsStyles();
  const [{ sheet }] = await Promise.all([get(`/api/operations/sheets/${params.id}`), clients().catch(() => []), openOrders()]);
  return sheetEditor(main, sheet, ctx, { review: false });
}
export async function reviewSheet(main, params, ctx) {
  opsStyles();
  const [{ sheet }] = await Promise.all([get(`/api/operations/sheets/${params.id}`), clients().catch(() => []), openOrders()]);
  return sheetEditor(main, sheet, ctx, { review: true });
}

// ---------- rows ⇄ lines ----------
const DATE_KEY = 'work_date_text';
function dateTextOf(iso, sheetDate) {
  if (!iso) return '';
  if (!P.validDate(iso)) return iso;
  const [y, m, d] = iso.split('-').map(Number);
  return String(sheetDate || '').slice(0, 4) === String(y) ? `${d}/${m}` : `${d}/${m}/${y}`;
}
function toRow(l, sheetDate) {
  return {
    ...l,
    client_text: l.client_id ? (l.client_name || l.client_text) : l.client_text,
    [DATE_KEY]: dateTextOf(l.work_date, sheetDate),
    ditto_fields: (l.ditto_fields || []).map((k) => (k === 'work_date' ? DATE_KEY : k)),
    seen: [],
  };
}
const SEND = ['id', 'part_name', 'client_id', 'client_text', 'material_id', 'material_text', 'thickness', 'pieces', 'per_piece', 'total_written',
  'sheets', 'minutes_per_sheet', 'start_time', 'end_time', 'louvers_per_piece', 'hits_per_piece', 'pieces_per_sheet', 'sheet_size',
  'length_cm', 'width_cm', 'material_source', 'work_order_id', 'work_date', 'notes', 'single_piece', 'seen'];
function toLine(r) {
  const out = Object.fromEntries(SEND.map((k) => [k, r[k] ?? null]));
  out.ditto_fields = (r.ditto_fields || []).map((k) => (k === DATE_KEY ? 'work_date' : k));
  out.seen = r.seen || [];
  return out;
}

// ---------- the editor ----------
// sheet: the server's sheet, or null for a new one. opts: { machine, review }
function sheetEditor(main, sheet, ctx, opts = {}) {
  const L = ctx.state.lookups;
  const canRecord = ctx.can('operations.record');
  const canApprove = ctx.can('operations.approve');
  const view = sheet ? sheet.view_status : 'draft';
  const editable = (view === 'draft' || view === 'review') && (canRecord || canApprove);
  const st = {
    machine: sheet?.machine || opts.machine || null,
    technician_id: sheet?.technician_id ?? null,
    sheet_date: sheet?.sheet_date || todayISO(),
    notes: sheet?.notes || '',
    rows: (sheet?.lines || []).map((l) => toRow(l, sheet.sheet_date)),
    dirty: false,
    acked: new Set((sheet?.issues || []).filter((i) => i.acked).map((i) => i.key)),
    sheetSeen: new Set(),
    candidates: new Map(),
  };
  st.showLouver = st.rows.some((r) => r.louvers_per_piece != null);
  st.showFactory = st.rows.some((r) => r.material_source === 'factory');
  st.showOrders = st.rows.some((r) => r.work_order_id) || !!ctx.query?.order;
  let grid = null;
  let stepIndex = 0;
  const stepMode = () => opts.review && editable && isPhone();

  const markDirty = () => {
    st.dirty = true;
    stateLine.textContent = 'فيه تعديلات لسه متحفظتش';
    stateLine.classList.add('warn');
  };
  const onUnload = (e) => { if (st.dirty) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', onUnload);
  window.addEventListener('hashchange', () => window.removeEventListener('beforeunload', onUnload), { once: true });

  // ----- the columns of this machine's paper -----
  const localLine = (r) => {
    const l = { ...r };
    if (st.machine === 'laser' || st.machine === 'punch') {
      if (r.start_time || r.end_time) {
        const m = P.parseMinutes(r.start_time, r.end_time, r.sheets);
        l.minutes_per_sheet = m.minutes_per_sheet;
        l.minutes_error = m.error;
      }
    }
    return l;
  };
  const ordersMap = () => {
    const m = Object.fromEntries(ordersNow().map((o) => [o.id, o]));
    for (const r of st.rows) if (r.work_order_id && !m[r.work_order_id]) m[r.work_order_id] = { client_id: r.client_id, status: 'open', serial: r.work_order_serial || '' };
    return m;
  };
  const issueCtx = () => ({ sheetDate: st.sheet_date, today: todayISO(), orders: ordersMap() });
  const rowIssues = (r) => P.lineIssues(st.machine, localLine(r), issueCtx());
  const colOf = (fieldKey) => (fieldKey === 'work_date' ? DATE_KEY : fieldKey === 'minutes_per_sheet' ? 'start_time' : fieldKey);
  const isSeen = (r, i) => (r.id && st.acked.has(`${r.id}|${P.issueKey(i)}`)) || (r.seen || []).includes(P.issueKey(i));

  function columns() {
    const mats = (L.materials || []).map((m) => m.name);
    const names = clientsNow().flatMap((c) => [c.name, ...(c.aliases || [])]);
    const numParse = (t) => P.parseNum(t);
    const map = (c) => {
      const base = { key: c.key, label: c.label, width: c.width, title: c.hint || null };
      if (c.type === 'number') return { ...base, type: 'number', parse: numParse, total: ['pieces', 'sheets', 'total_written'].includes(c.key) ? 'sum' : null };
      if (c.type === 'client') return { ...base, type: 'text', suggest: names, placeholder: 'اسم العميل' };
      if (c.type === 'material') return { ...base, type: 'text', suggest: mats, placeholder: '١٫٥م اسود' };
      if (c.type === 'date') return { ...base, key: DATE_KEY, type: 'text', placeholder: 'يوم/شهر' };
      if (c.type === 'source') return { ...base, type: 'select', options: [['client', 'خامة العميل'], ['factory', 'خامة المصنع']] };
      return { ...base, type: 'text' };
    };
    const cols = P.paperColumns(st.machine).map(map);
    if (st.machine === 'laser' || st.machine === 'punch') {
      const at = cols.findIndex((c) => c.key === 'end_time') + 1;
      cols.splice(at, 0, { key: 'mins', label: 'دقايق اللوح', type: 'computed', title: 'محسوبة من وقت البداية والنهاية',
        compute: (r) => localLine(r).minutes_per_sheet, format: (v) => (v === null || v === undefined ? '' : num(v)) });
    }
    if (st.machine === 'punch' && st.showLouver) cols.push(...P.LOUVER_COLUMNS.filter((c) => !cols.some((x) => x.key === c.key)).map(map));
    if (st.showFactory) cols.push(...P.FACTORY_COLUMNS.map(map));
    if (st.showOrders) {
      cols.push({ key: 'work_order_id', label: 'أمر الشغل', type: 'select', width: 130,
        options: (r) => {
          const list = ordersNow().filter((o) => !r.client_id || o.client_id === r.client_id).map((o) => [o.id, `${o.serial} · ${o.description.slice(0, 22)}`]);
          if (r.work_order_id && !list.some(([id]) => id === r.work_order_id)) list.push([r.work_order_id, r.work_order_serial || `#${r.work_order_id}`]);
          return list;
        } });
    }
    return cols;
  }

  // A committed cell (grid or stepper): resolve the client and material, parse the date.
  function onCell(r, key, value) {
    if (key === 'client_text') {
      const c = clientByText(value);
      r.client_id = c?.id ?? null;
      if (c) r.client_text = c.name;
      if (r.work_order_id && ordersNow().find((o) => o.id === r.work_order_id)?.client_id !== r.client_id) { /* stays red until fixed */ }
    } else if (key === 'material_text') {
      if (value) r.material_text = P.toAscii(value);
      const m = P.parseMaterialText(value, L.materials || []);
      r.material_id = m.material_id;
      if ((r.thickness === null || r.thickness === undefined) && m.thickness) r.thickness = m.thickness;
    } else if ((key === 'start_time' || key === 'end_time') && value) {
      r[key] = P.toAscii(value);
    } else if (key === DATE_KEY) {
      r.work_date = P.parseWorkDate(value, st.sheet_date).value;
    } else if (key === 'material_source' && value === 'factory' && !st.showFactory) {
      st.showFactory = true;
      setTimeout(buildGrid, 0);
    }
    markDirty();
    renderIssues();
  }

  // ----- header: machine, technician, date -----
  const machineBtns = h('div', { class: 'row', role: 'group', 'aria-label': 'المكنة' });
  const drawMachines = () => fill(machineBtns, P.MACHINES.map((m) => h('button', {
    type: 'button', class: `btn${st.machine === m ? ' primary' : ''}`, 'aria-pressed': st.machine === m ? 'true' : 'false',
    disabled: !editable || (sheet && sheet.lines.length > 0 && st.machine !== m) ? true : null,
    onclick: async () => {
      if (st.machine === m) return;
      if (st.rows.some((r) => !P.isEmptyLine(r))) {
        const ok = await confirmModal('تغيير المكنة', 'أعمدة المكنة التانية مختلفة، والسطور اللي اتكتبت هتتمسح. تكمل؟', 'غيّر المكنة', { danger: true });
        if (!ok) return;
        st.rows = [];
      }
      st.machine = m;
      markDirty();
      drawMachines();
      buildGrid();
    },
  }, P.MACHINE_NAMES[m])));
  drawMachines();
  const techSel = technicianSelect(L.technicians.filter((t) => !st.machine || !t.machine || t.machine === st.machine || t.id === st.technician_id), st.technician_id, 'اختار الفني', { disabled: !editable });
  techSel.addEventListener('change', () => { st.technician_id = techSel.value ? Number(techSel.value) : null; markDirty(); renderIssues(); });
  const dateIn = h('input', { type: 'date', value: st.sheet_date, disabled: !editable, required: true });
  const dateField = field('تاريخ الورقة', dateIn);
  dateIn.addEventListener('change', () => {
    if (!P.validDate(dateIn.value)) { dateField.setError('التاريخ غلط'); return; }
    st.sheet_date = dateIn.value;
    for (const r of st.rows) if (r[DATE_KEY]) r.work_date = P.parseWorkDate(r[DATE_KEY], st.sheet_date).value;
    markDirty();
    renderIssues();
    grid?.refresh();
  });
  const notesIn = textInput({ value: st.notes, placeholder: 'وقفة مكنة، ملاحظة من الفني…', disabled: !editable });
  notesIn.addEventListener('input', () => { st.notes = notesIn.value; markDirty(); });
  const newTech = editable && canRecord ? button('فني جديد', { size: 'sm', kind: 'ghost', icon: 'user-plus', onClick: async () => {
    const t = await createTechnician(st.machine);
    if (!t) return;
    await ctx.loadLookups();
    L.technicians = ctx.state.lookups.technicians;
    techSel.append(h('option', { value: t.id }, t.name));
    techSel.value = String(t.id);
    st.technician_id = t.id;
    markDirty();
    renderIssues();
  } }) : null;

  // ----- grid / stepper -----
  const gridBox = h('div', {});
  const issuesBox = h('div', { class: 'ops-issues', 'aria-live': 'polite' });
  const toolbar = h('div', { class: 'ops-toolbar' });

  function buildGrid() {
    drawToolbar();
    if (!st.machine) {
      fill(gridBox, emptyState('factory', 'اختار المكنة الأول', 'كل مكنة ليها أعمدة ورقتها: التناية والمقص بالقطع والتنيات، والليزر والبنش بالألواح والدقايق.', null, true));
      fill(issuesBox);
      return;
    }
    if (stepMode()) { renderStep(); renderIssues(); return; }
    grid?.destroy();
    grid = createGrid({
      columns: columns(),
      rows: st.rows,
      readOnly: !editable,
      canAdd: editable,
      canDelete: editable,
      newRow: () => ({ ditto_fields: [], seen: [], ...(opts.rowDefaults || {}) }),
      totals: 'top',
      maxHeight: sheet?.photo_url ? '62vh' : '70vh',
      emptyText: 'مفيش سطور لسه — اكتب أول سطر من ورقة الفني',
      onChange: (r, key, value) => onCell(r, key, value),
      onRowsChange: () => { st.rows = grid.rows; markDirty(); renderIssues(); },
      marks: (r, key) => {
        if (P.isEmptyLine(r) && !r.ditto_fields?.length) return null; // a fresh row is not an error yet
        const list = rowIssues(r).filter((i) => colOf(i.field) === key);
        const i = list.find((x) => x.level === 'red') || list[0];
        return i ? { level: i.level, message: i.message, seen: i.level === 'yellow' && isSeen(r, i) } : null;
      },
      onVisit: (r, key) => {
        for (const i of rowIssues(r).filter((x) => x.level === 'yellow' && colOf(x.field) === key)) {
          if (!isSeen(r, i)) { (r.seen ||= []).push(P.issueKey(i)); markDirty(); }
        }
        renderIssues();
      },
      rowTitle: (r, i) => `سطر ${i + 1}${r.client_text ? ` · ${r.client_text}` : ''}`,
    });
    st.rows = grid.rows;
    fill(gridBox, grid.el);
    renderIssues();
  }

  function drawToolbar() {
    if (!st.machine) return fill(toolbar);
    const toggles = [];
    if (editable && st.machine === 'punch') {
      toggles.push(button(st.showLouver ? 'اخفي أعمدة اللوفر' : 'أعمدة اللوفر', { size: 'sm', icon: 'list-checks', onClick: () => { st.showLouver = !st.showLouver; buildGrid(); } }));
    }
    if (editable) {
      toggles.push(button(st.showOrders ? 'اخفي أمر الشغل' : 'اربط بأمر شغل', { size: 'sm', icon: 'clipboard-text', onClick: () => { st.showOrders = !st.showOrders; buildGrid(); } }));
    }
    if (editable && sheet?.id && !sheet.photo_url && canRecord) {
      const file = h('input', { type: 'file', accept: 'image/*', hidden: true });
      file.addEventListener('change', async () => {
        const f = file.files?.[0];
        if (!f) return;
        try {
          const { url } = await fileToJpeg(f);
          await post(`/api/operations/sheets/${sheet.id}/photo`, { image: url });
          toast('الصورة اتضافت');
          ctx.refresh();
        } catch (ex) { toastError(ex); }
      });
      toggles.push(file, button('ضيف صورة الورقة', { size: 'sm', icon: 'camera', onClick: () => file.click() }));
    }
    fill(toolbar, toggles,
      h('span', { class: 'legend' }, h('span', {}, h('i', { class: 't' }), 'بتتكتب'), h('span', {}, h('i', { class: 'c' }), 'محسوبة'),
        h('span', {}, h('i', { class: 'r' }), 'لازم تتصلح'), h('span', {}, h('i', { class: 'y' }), 'محتاجة تتشاف')));
  }

  // ----- the phone review: one row per screen -----
  function renderStep() {
    if (!st.rows.length) st.rows.push({ ditto_fields: [], seen: [] });
    stepIndex = Math.max(0, Math.min(stepIndex, st.rows.length - 1));
    const i = stepIndex;
    const r = st.rows[i];
    const issues = rowIssues(r);
    const cols = columns();
    const fieldsEls = cols.map((c) => {
      const list = issues.filter((x) => colOf(x.field) === c.key);
      const top = list.find((x) => x.level === 'red') || list[0];
      const cls = `f${top ? ` mark-${top.level}` : ''}`;
      if (c.type === 'computed') return h('div', { class: cls }, h('label', {}, c.label), h('div', { class: 'v' }, c.format(c.compute(r))));
      let input;
      const raw = r[c.key];
      if (c.type === 'select') {
        const opts2 = typeof c.options === 'function' ? c.options(r) : c.options;
        input = h('select', {}, h('option', { value: '' }, ''), opts2.map(([v, l]) => h('option', { value: v, selected: String(v) === String(raw ?? '') }, l)));
      } else {
        input = h('input', { type: 'text', value: raw ?? '', inputmode: c.type === 'number' ? 'decimal' : null, class: c.type === 'number' ? 'ltr' : null,
          list: c.suggest ? `st-dl-${c.key}` : null, placeholder: c.placeholder || '' });
      }
      input.addEventListener('focus', () => {
        for (const x of list.filter((y) => y.level === 'yellow' && !isSeen(r, y))) { (r.seen ||= []).push(P.issueKey(x)); markDirty(); }
        renderIssues();
        paintDots();
      });
      input.addEventListener('change', () => {
        const v = input.value;
        const at = (r.ditto_fields ||= []).indexOf(c.key);
        if (isDitto(v) && i > 0) {
          r[c.key] = st.rows[i - 1][c.key];
          if (at < 0) r.ditto_fields.push(c.key);
        } else {
          let parsed = c.type === 'number' ? P.parseNum(v) : c.type === 'select' ? (v === '' ? null : /^\d+$/.test(v) ? Number(v) : v) : (v.trim() || null);
          if (Number.isNaN(parsed)) { toast('اكتب رقم صحيح', true); return; }
          r[c.key] = parsed;
          if (at >= 0) r.ditto_fields.splice(at, 1);
        }
        onCell(r, c.key, r[c.key]);
        renderStep();
      });
      return h('div', { class: cls }, h('label', {}, c.label), input, top ? h('div', { class: 'msg' }, top.message) : null);
    });
    const dl = cols.filter((c) => c.suggest).map((c) => h('datalist', { id: `st-dl-${c.key}` }, c.suggest.map((s) => h('option', { value: s }))));
    const dots = h('div', { class: 'dots' });
    const paintDots = () => fill(dots, st.rows.map((row, j) => {
      const is = rowIssues(row);
      const lvl = is.some((x) => x.level === 'red') ? 'red' : is.some((x) => x.level === 'yellow' && !isSeen(row, x)) ? 'yellow' : '';
      return h('button', { type: 'button', class: `${j === i ? 'on' : ''} ${lvl}`.trim(), 'aria-label': `سطر ${j + 1}`, onclick: () => { stepIndex = j; renderStep(); } }, String(j + 1));
    }));
    paintDots();
    fill(gridBox, h('div', { class: 'step' },
      dots,
      h('div', { class: 'card' },
        h('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:10px' }, h('b', {}, `سطر ${i + 1} من ${st.rows.length}`),
          h('button', { class: 'icon-btn danger', type: 'button', 'aria-label': 'امسح السطر', onclick: () => { st.rows.splice(i, 1); markDirty(); renderStep(); renderIssues(); } }, icon('trash', 'sm'))),
        h('div', { class: 'grid' }, fieldsEls), dl),
      h('div', { class: 'nav' },
        button('السطر اللي قبله', { icon: 'arrow-right', disabled: i === 0, onClick: () => { stepIndex -= 1; renderStep(); } }),
        i < st.rows.length - 1
          ? button('السطر اللي بعده', { icon: 'arrow-left', kind: 'primary', onClick: () => { stepIndex += 1; renderStep(); } })
          : button('سطر جديد', { icon: 'plus', onClick: () => { st.rows.push({ ditto_fields: [], seen: [] }); stepIndex = st.rows.length - 1; markDirty(); renderStep(); } }))));
  }

  // ----- the red / yellow panel -----
  function renderIssues() {
    if (!st.machine) return fill(issuesBox);
    if (!editable) {
      return fill(issuesBox);
    }
    const list = [];
    const filled = st.rows.filter((r) => !P.isEmptyLine(r) || r.ditto_fields?.length);
    if (!filled.length) list.push({ row: null, level: 'red', code: 'no_lines', field: '', message: 'الورقة مفيهاش سطور — اكتب سطور الفني' });
    if (!st.technician_id) list.push({ row: null, level: 'yellow', code: 'no_technician', field: 'technician_id', message: 'الفني مش متحدد', sheetLevel: true });
    st.rows.forEach((r, idx) => {
      if (P.isEmptyLine(r) && !r.ditto_fields?.length) return;
      for (const i of rowIssues(r)) list.push({ ...i, row: idx, r });
    });
    const sheetKey = (i) => `|${P.issueKey(i)}`;
    const seen = (i) => (i.sheetLevel ? st.acked.has(sheetKey(i)) || st.sheetSeen.has(sheetKey(i)) : isSeen(i.r, i));
    const red = list.filter((i) => i.level === 'red');
    const yellow = list.filter((i) => i.level === 'yellow');
    const unseen = yellow.filter((i) => !seen(i));
    const item = (i) => {
      const where = i.row === null ? 'الورقة' : `سطر ${i.row + 1}`;
      const acts = [];
      if (i.code === 'no_client' && i.r) acts.push(clientActions(i.r, i.row));
      if (i.row !== null && !stepMode()) acts.push(button('روح للخانة', { size: 'sm', kind: 'ghost', icon: 'caret-left', onClick: () => grid?.focus(i.row, colOf(i.field)) }));
      if (i.row !== null && stepMode()) acts.push(button('افتح السطر', { size: 'sm', kind: 'ghost', icon: 'caret-left', onClick: () => { stepIndex = i.row; renderStep(); } }));
      if (i.level === 'yellow' && !seen(i)) {
        acts.push(button('شفته', { size: 'sm', icon: 'eye', onClick: async () => {
          if (i.sheetLevel) {
            st.sheetSeen.add(sheetKey(i));
            if (sheet?.id && !st.dirty) {
              try { await post(`/api/operations/sheets/${sheet.id}/ack`, { keys: [sheetKey(i)] }); st.acked.add(sheetKey(i)); } catch { /* saved with the next save */ }
            }
          } else {
            (i.r.seen ||= []).push(P.issueKey(i));
            markDirty();
          }
          grid?.refresh();
          if (stepMode()) renderStep();
          renderIssues();
        } }));
      }
      return h('div', { class: `ops-issue ${i.level}${i.level === 'yellow' && seen(i) ? ' seen' : ''}` },
        icon(i.level === 'red' ? 'warning-circle' : seen(i) ? 'check-circle' : 'warning', 'sm'),
        h('div', { class: 'what' }, h('span', { class: 'where' }, `${where}${i.field && i.row !== null ? ` · ${P.fieldLabel(st.machine, i.field)}` : ''}: `), i.message,
          acts.length ? h('div', { class: 'acts' }, acts) : null));
    };
    fill(issuesBox,
      !red.length && !unseen.length
        ? notice('ok', h('b', {}, 'الورقة جاهزة'), yellow.length ? ` — كل الخانات الصفرا (${yellow.length}) اتشافت.` : ' — مفيش غلطات.')
        : notice(red.length ? 'danger' : 'warn',
          red.length ? `${red.length} ${red.length === 1 ? 'غلطة لازم تتصلح' : 'غلطات لازم تتصلح'}` : '',
          red.length && unseen.length ? ' · ' : '',
          unseen.length ? `${unseen.length} ${unseen.length === 1 ? 'خانة صفرا محتاجة تتشاف' : 'خانات صفرا محتاجة تتشاف'}` : ''),
      red.length ? [h('h3', {}, icon('warning-circle', 'sm'), 'لازم تتصلح'), red.map(item)] : null,
      yellow.length ? [h('h3', {}, icon('warning', 'sm'), 'محتاجة تتشاف'), yellow.map(item)] : null);
    approveBtn?.toggleAttribute('data-blocked', !!(red.length || unseen.length));
  }

  // The written name is not a client: the closest clients, or a new one.
  function clientActions(r, idx) {
    const wrap = h('span', { class: 'row', style: 'gap:6px' });
    const text = r.client_text || '';
    const choose = (c) => {
      const written = r.client_text;
      r.client_id = c.id;
      r.client_text = c.name;
      markDirty();
      grid?.refreshRow(idx);
      grid?.refresh();
      if (stepMode()) renderStep();
      renderIssues();
      if (written && P.foldName(written) !== P.foldName(c.name)) {
        toast(`اتربط السطر بـ ${c.name}`, false, { action: { label: `احفظ «${written}» كاسم تاني ليه`, onClick: async () => {
          try { await addAlias(c, written); toast('اتحفظ الاسم'); } catch (ex) { toastError(ex); }
        } } });
      }
    };
    const draw = (cands) => fill(wrap,
      cands.length ? h('span', { class: 'small muted' }, 'تقصد:') : null,
      cands.map((c) => h('button', { type: 'button', class: 'chip', onclick: () => choose(c) }, c.name)),
      h('button', { type: 'button', class: 'chip', onclick: async () => {
        const c = await createClient(text);
        if (c) { toast(`اتضاف ${c.name}`); choose(c); }
      } }, icon('user-plus', 'sm'), 'عميل جديد'));
    if (!text) { draw([]); return wrap; }
    if (st.candidates.has(text)) draw(st.candidates.get(text));
    else {
      draw([]);
      get('/api/operations/clients/match', { text }).then((m) => { st.candidates.set(text, m.candidates); draw(m.candidates); }).catch(() => {});
    }
    return wrap;
  }

  // ----- saving -----
  const stateLine = h('span', { class: 'state' }, sheet ? (sheet.updated_at ? `آخر حفظ ${dateText(sheet.updated_at.slice(0, 10))}` : '') : 'ورقة جديدة — لسه متحفظتش');
  async function save({ submit = false, quiet = false } = {}) {
    if (!st.machine) throw new Error('اختار المكنة الأول');
    if (!P.validDate(st.sheet_date)) { dateField.setError('التاريخ غلط'); throw new Error('تاريخ الورقة غلط'); }
    const bad = grid?.errors() || [];
    if (bad.length) {
      grid.focus(bad[0].row, bad[0].key);
      throw new Error(`في ${bad.length === 1 ? 'خانة فيها' : `${bad.length} خانات فيها`} رقم غلط — صلحها الأول`);
    }
    const body = { machine: st.machine, technician_id: st.technician_id, sheet_date: st.sheet_date, notes: st.notes,
      lines: st.rows.filter((r) => !P.isEmptyLine(r) || r.ditto_fields?.length).map(toLine), submit };
    let r;
    try {
      r = sheet ? await put(`/api/operations/sheets/${sheet.id}`, body) : await post('/api/operations/sheets', body);
    } catch (ex) {
      if (Number.isInteger(ex.data?.row) && ex.data.field && grid) grid.focus(ex.data.row, colOf(ex.data.field));
      throw ex;
    }
    st.dirty = false;
    if (!sheet) {
      if (!quiet) toast(submit ? `اتبعتت للمراجعة ${r.sheet.serial}` : `اتحفظت ${r.sheet.serial}`);
      window.removeEventListener('beforeunload', onUnload);
      ctx.go(submit && canApprove ? `#/ops/review/${r.sheet.id}` : `#/ops/sheets/${r.sheet.id}`);
      return r.sheet;
    }
    if (st.sheetSeen.size) {
      try { await post(`/api/operations/sheets/${sheet.id}/ack`, { keys: [...st.sheetSeen] }); } catch { /* changed meanwhile */ }
    }
    if (!quiet) toast(submit ? 'اتبعتت للمراجعة' : 'اتحفظت');
    return r.sheet;
  }

  const go = (hash) => { window.removeEventListener('beforeunload', onUnload); st.dirty = false; ctx.go(hash); };
  let approveBtn = null;
  const actions = [];
  if (editable) {
    if (view === 'draft') {
      actions.push(button('احفظ مسودة', { icon: 'note-pencil', onClick: async () => { try { await save(); if (sheet) ctx.refresh(); } catch (ex) { toastError(ex); } } }));
      actions.push(button('ابعت للمراجعة', { kind: 'primary', icon: 'paper-plane-tilt', onClick: async () => {
        try {
          const s = await save({ submit: true });
          if (sheet) go(canApprove ? `#/ops/review/${s.id}` : '#/ops/sheets');
        } catch (ex) { toastError(ex); }
      } }));
    } else {
      actions.push(button('احفظ التعديلات', { icon: 'check', onClick: async () => { try { await save(); ctx.refresh(); } catch (ex) { toastError(ex); } } }));
      if (canApprove) {
        approveBtn = button('اعتمد الورقة', { kind: 'primary', icon: 'seal-check', onClick: async () => {
          try {
            await save({ quiet: true });
            const r = await post(`/api/operations/sheets/${sheet.id}/approve`);
            // اعتماد → تسعير: the next step is one tap away for whoever prices
            toast(`اتعتمدت ${r.sheet.serial}`, false, ctx.can('pricing') ? { action: { label: 'سعّرها', onClick: () => go(`#/pricing/sheet/${sheet.id}`) } } : {});
            const next = (await get('/api/operations/review')).sheets.find((s) => s.id !== sheet.id);
            go(next ? `#/ops/review/${next.id}` : '#/ops/review');
          } catch (ex) {
            toastError(ex);
            if (ex.status === 409 && ex.data?.issues) ctx.refresh();
          }
        } });
        actions.push(approveBtn);
      }
    }
    if (sheet && (canApprove || (view === 'draft' && sheet.created_by === ctx.state.user.id))) {
      actions.push(button(view === 'draft' ? 'ارمي المسودة' : 'إلغاء الورقة', { kind: 'danger', icon: 'prohibit', onClick: () => cancelFlow(sheet, ctx, go) }));
    }
  } else if (sheet && view === 'approved' && canApprove) {
    actions.push(button('تصحيح', { icon: 'pencil-line', onClick: async () => {
      if (sheet.posted_lines) return toast('الورقة دي فيها بنود اترحّلت على العميل — صحّح السعر من التسعير الأول', true);
      const reason = await confirmModal('تصحيح ورقة معتمدة', 'هتتعمل نسخة جديدة من الورقة في المراجعة تعدّل فيها، والنسخة دي هتتلغي وتفضل في السجل. اكتب سبب التصحيح.', 'اعمل نسخة للتصحيح', { withReason: true, reasonLabel: 'سبب التصحيح' });
      if (!reason) return;
      try {
        const r = await post(`/api/operations/sheets/${sheet.id}/correct`, { reason });
        toast(`اتعملت ${r.sheet.serial}`);
        go(`#/ops/review/${r.sheet.id}`);
      } catch (ex) { toastError(ex); }
    } }));
    actions.push(button('إلغاء الورقة', { kind: 'danger', icon: 'prohibit', onClick: () => cancelFlow(sheet, ctx, go) }));
  }

  // ----- the page -----
  const title = sheet ? `ورقة ${sheet.machine_name} ${sheet.serial}` : 'ورقة جديدة';
  const sub = sheet
    ? h('span', { class: 'row', style: 'gap:8px' }, statusPill(view), view === 'review' ? countsPills(sheet.counts) : null,
      sheet.version > 1 ? pill('accent', `نسخة ${sheet.version}`) : null,
      sheet.source === 'photo' ? h('span', { class: 'small muted' }, 'من صورة') : null)
    : 'اكتب ورقة الفني بنفس أعمدة الورق: Enter للسطر اللي تحت، و ~ أو // يعني زي اللي فوقه.';
  const back = opts.review ? backLink('#/ops/review', 'المراجعة والاعتماد') : backLink('#/ops/sheets', 'أوراق التشغيل');
  const notices = [];
  if (sheet && view === 'approved') {
    notices.push(notice('ok', h('b', {}, 'الورقة معتمدة ومقفولة'), ` — اعتمدها ${sheet.approved_by_name || ''} ${sheet.approved_at ? dateText(sheet.approved_at.slice(0, 10)) : ''}. لو فيها غلط: «تصحيح» بيعمل نسخة جديدة، أو «إلغاء الورقة» بسبب.`));
    if (sheet.posted_lines) notices.push(notice('info', `فيها ${sheet.posted_lines} ${sheet.posted_lines === 1 ? 'بند اتسعر واترحّل' : 'بنود اتسعرت واترحّلت'} — أي تعديل بيبدأ من التسعير («تصحيح سعر»).`));
  }
  if (sheet && view === 'cancelled') {
    notices.push(notice('warn', h('b', {}, 'الورقة دي ملغية'), sheet.cancel_reason ? ` — السبب: ${sheet.cancel_reason}` : '',
      sheet.superseded_by ? [' ', h('a', { href: `#/ops/sheets/${sheet.superseded_by}` }, 'افتح النسخة الجديدة')] : null));
  }
  if (sheet?.photo_job?.error) notices.push(notice('warn', sheet.photo_job.error));
  if (sheet?.versions?.length > 1) {
    notices.push(h('div', { class: 'ops-meta' }, h('span', {}, 'النسخ:'), sheet.versions.map((v) => (v.id === sheet.id
      ? h('b', { class: 'num' }, v.serial) : h('a', { href: `#/ops/sheets/${v.id}`, class: 'num' }, v.serial)))));
  }
  const header = h('div', { class: 'card', style: 'margin-bottom:14px' },
    h('div', { class: 'ops-form' },
      h('div', { class: 'field', style: 'grid-column: 1 / -1' }, h('label', {}, 'المكنة'), machineBtns),
      h('div', {}, field('الفني', techSel), newTech),
      dateField,
      field('ملاحظات', notesIn)),
    sheet ? h('div', { class: 'ops-meta', style: 'margin:4px 0 0' },
      h('span', {}, 'كتبها: ', h('b', {}, sheet.created_by_name || '—')),
      h('span', {}, 'المصدر: ', h('b', {}, sheet.source === 'photo' ? 'صورة' : sheet.source === 'import' ? 'من الإكسيل' : 'كتابة')),
      sheet.status === 'approved' ? h('span', {}, 'التسعير: ', h('b', {}, sheet.priced_name)) : null,
      sheet.status === 'approved' && sheet.priced_status !== 'posted' && ctx.can('pricing')
        ? button('سعّر الورقة', { size: 'sm', icon: 'calculator', href: `#/pricing/sheet/${sheet.id}` }) : null) : null);
  const work = h('div', {}, toolbar, gridBox, issuesBox);
  const split = sheet?.photo_url ? h('div', { class: 'ops-split with-photo' }, work, photoViewer(sheet.photo_url)) : h('div', { class: 'ops-split' }, work);
  fill(main, h('div', { class: 'ops' },
    back,
    pageHead(title, sub),
    notices.length ? h('div', { class: 'grid', style: 'margin-bottom:12px' }, notices) : null,
    header,
    split,
    actions.length ? h('div', { class: 'ops-bar no-print' }, stateLine, actions) : null));
  buildGrid();
  if (editable && !sheet && st.machine) setTimeout(() => grid?.focus(0, 'part_name') || (grid?.addRow(), grid?.focus(0, 'part_name')), 50);
}

async function cancelFlow(sheet, ctx, go) {
  const draft = sheet.view_status === 'draft';
  if (sheet.posted_lines) return toast('الورقة دي فيها بنود اترحّلت على العميل — لازم يتلغى الترحيل الأول من التسعير', true);
  const reason = await confirmModal(draft ? 'ارمي المسودة' : `إلغاء الورقة ${sheet.serial}`,
    draft ? 'المسودة هتتلغي وتفضل في السجل.' : 'الورقة هتتلغي وتفضل في السجل بالسبب، ومش هتدخل في التسعير ولا الإنتاج.',
    draft ? 'ارميها' : 'الغي الورقة', { danger: true, withReason: true, reasonLabel: 'سبب الإلغاء' });
  if (!reason) return;
  try {
    await post(`/api/operations/sheets/${sheet.id}/cancel`, { reason });
    toast(draft ? 'المسودة اترمت' : `اتلغت ${sheet.serial}`);
    go('#/ops/sheets');
  } catch (ex) { toastError(ex); }
}

// ---------- المراجعة والاعتماد: the queue ----------
export async function reviewQueue(main, _params, ctx) {
  opsStyles();
  const box = h('div', {}, skeleton('table'));
  fill(main, h('div', { class: 'ops' },
    pageHead('المراجعة والاعتماد', 'الأحمر لازم يتصلح، والأصفر لازم يتشاف، وبعدين الاعتماد. الأقدم الأول.',
      ctx.can('operations.record') ? button('صوّر ورقة', { href: '#/ops/photos', icon: 'camera' }) : null),
    box));
  await loadInto(box, async () => {
    const { sheets } = await get('/api/operations/review');
    if (!sheets.length) {
      return emptyState('seal-check', 'مفيش ورق مستني مراجعة', 'الأوراق اللي بتتبعت للمراجعة أو اللي القراءة الآلية خلصتها بتظهر هنا.',
        h('div', { class: 'row' }, ctx.can('operations.record') ? button('صوّر ورقة', { href: '#/ops/photos', icon: 'camera', kind: 'primary' }) : null,
          button('أوراق التشغيل', { href: '#/ops/sheets', icon: 'files' })));
    }
    const ready = sheets.filter((s) => !s.counts.red && !s.counts.unseen).length;
    return h('div', { class: 'grid' },
      h('div', { class: 'stats' },
        h('div', { class: 'stat' }, h('span', {}, 'مستنية مراجعة'), h('b', {}, num(sheets.length))),
        h('div', { class: `stat${sheets.some((s) => s.counts.red) ? ' danger' : ''}` }, h('span', {}, 'فيها أحمر'), h('b', {}, num(sheets.filter((s) => s.counts.red).length))),
        h('div', { class: 'stat' }, h('span', {}, 'جاهزة للاعتماد'), h('b', {}, num(ready)))),
      dataTable([
        { label: 'الرقم', value: (s) => h('b', { class: 'num' }, s.serial) },
        { label: 'المكنة', value: (s) => s.machine_name },
        { label: 'الفني', value: (s) => s.technician_name || h('span', { class: 'muted' }, '—') },
        { label: 'التاريخ', value: (s) => h('span', { class: 'num' }, fmtDate(s.sheet_date)) },
        { label: 'العملاء', value: (s) => h('span', { class: 'small' }, s.clients || '—') },
        { label: 'السطور', n: true, value: (s) => num(s.lines_count) },
        { label: 'المطلوب', value: (s) => h('span', { class: 'row', style: 'gap:6px' }, countsPills(s.counts), s.has_photo ? h('span', { class: 'muted', title: 'ليها صورة' }, icon('image', 'sm')) : null) },
      ], sheets, { onRow: (s) => ctx.go(`#/ops/review/${s.id}`) }));
  });
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
