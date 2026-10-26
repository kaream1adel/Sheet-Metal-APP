// Sheet entry + review. One screen does both: type (or later, correct the OCR),
// see red/yellow cells, and confirm once every red is fixed and every yellow was visited.
import { h, toast, fmtDate, fmtNum, todayISO, fold, asciiDigits, formModal, confirmModal, fill } from './ui.js';
import { get, post, put, del } from './api.js';
import { state, can, go, loadLookups } from './app.js';
import { formLayout } from './forms.js';
import { photoToPage, uploadBody, pagePreview } from './scan.js';
import { pageFromUrl, readPage, teachFrom } from './reader.js';
import { SURE } from './ocr.js';

const LABELS = {
  pieces: 'عدد القطع', total_written: 'الإجمالي', sheets: 'عدد الألواح', minutes_per_sheet: 'دقائق للوح',
  sheet_size: 'مقاس اللوح', pieces_per_sheet: 'قطع من اللوح', hits_per_piece: 'ضربات للقطعة',
  louvers_per_piece: 'لوفر للقطعة', minutes: 'دقائق',
};
const OPS_LABEL = { press: 'تنيات للقطعة', shear: 'قصات للقطعة' };
const MACHINE_FIELDS = {
  press: ['pieces', 'ops_per_piece', 'total_written'],
  shear: ['pieces', 'ops_per_piece', 'total_written'],
  laser: ['sheets', 'minutes_per_sheet'],
  punch: ['sheets', 'sheet_size', 'pieces_per_sheet', 'pieces', 'hits_per_piece', 'louvers_per_piece', 'minutes'],
};
const DITTO = /^(~+|\/\/|〃|")$/;
const TEXT_FIELDS = ['part_name', 'sheet_size', 'client_text', 'material_text'];

function columnsFor(code) {
  const machineCols = (MACHINE_FIELDS[code] || []).map((f) => ({
    key: f, field: f, label: f === 'ops_per_piece' ? OPS_LABEL[code] : LABELS[f],
    kind: f === 'sheet_size' ? 'text' : 'num', cls: f === 'sheet_size' ? 'w-part' : 'w-n',
  }));
  return [
    { key: 'client', field: 'client_id', label: 'العميل', kind: 'client', cls: 'w-client' },
    { key: 'part_name', field: 'part_name', label: 'اسم القطعة', kind: 'text', cls: 'w-part' },
    { key: 'material', field: 'material_id', label: 'الخامة', kind: 'material', cls: 'w-mat' },
    { key: 'thickness', field: 'thickness', label: 'السمك مم', kind: 'num', cls: 'w-n' },
    ...machineCols,
    { key: 'work_date', field: 'work_date', label: 'التاريخ', kind: 'date', cls: 'w-date' },
    { key: 'material_source', field: 'material_source', label: 'الخامة من', kind: 'source', cls: 'w-mat' },
  ];
}

const blankLine = () => ({ client_id: null, client_text: '', part_name: '', material_id: null, material_text: '',
  thickness: '', pieces: '', ops_per_piece: '', total_written: '', sheets: '', minutes_per_sheet: '', sheet_size: '',
  pieces_per_sheet: '', hits_per_piece: '', louvers_per_piece: '', minutes: '', work_date: '', material_source: 'client' });

const str = (v) => (v === null || v === undefined ? '' : typeof v === 'number' ? fmtNum(v) : String(v));

// Same rule as the server: a row with nothing typed is not a line (date/source alone don't count).
const isEmpty = (l) => !l.client_id && !l.client_text.trim() && !l.part_name.trim() && !l.material_id &&
  !l.sheet_size.trim() && ['thickness', 'pieces', 'ops_per_piece', 'total_written', 'sheets', 'minutes_per_sheet',
    'pieces_per_sheet', 'hits_per_piece', 'louvers_per_piece', 'minutes'].every((f) => !String(l[f]).trim());

export async function renderSheet(main, id) {
  const L = state.lookups;
  let sheet = null;
  if (id) sheet = (await get(`/api/sheets/${id}`)).sheet;

  const params = new URLSearchParams((location.hash.split('?')[1]) || '');
  const model = sheet ? {
    id: sheet.id, machine_id: sheet.machine_id, technician_id: sheet.technician_id || '', sheet_date: sheet.sheet_date || '',
    sheet_no: sheet.sheet_no || '', notes: sheet.notes || '',
    lines: sheet.lines.map((l) => ({ ...blankLine(), ...Object.fromEntries(Object.entries(l).map(([k, v]) => [k, k.endsWith('_id') || k === 'ditto_fields' ? v : str(v)])),
      client_text: l.client_name || l.client_text || '', material_text: l.material_name || '', material_source: l.material_source || 'client' })),
  } : {
    id: null, machine_id: Number(params.get('machine')) || '', technician_id: '', sheet_date: todayISO(), sheet_no: '', notes: '',
    lines: [],
  };
  const editable = sheet ? sheet.status === 'review' && can('sheets.review') : can('sheets.create');
  // A photo sheet keeps every line on its printed row, under its strip of the photo.
  const layout = sheet?.photo ? formLayout(sheet.machine_code, sheet.photo.form_version) : null;
  if (layout) {
    const byRow = [];
    for (const l of model.lines) byRow[Number(sheet.lines.find((x) => x.id === l.id)?.row_no || byRow.length + 1) - 1] = l;
    const n = Math.max(layout.table.rows, byRow.length);
    model.lines = Array.from({ length: n }, (_, i) => byRow[i] || blankLine());
  }
  if (editable && !layout) {
    const target = Math.max(6, model.lines.length + 2);
    while (model.lines.length < target) model.lines.push(blankLine());
  }

  let issues = sheet?.issues || [];
  const acks = new Set(sheet?.acks || []);
  let saveTimer = null;
  let saving = Promise.resolve();
  let dirty = false;

  const machine = () => L.machines.find((m) => m.id === Number(model.machine_id));

  // ---------- header ----------
  const machineSel = h('select', {
    disabled: !!model.id || !editable,
    onchange: (e) => { model.machine_id = Number(e.target.value); drawTable(); },
  }, h('option', { value: '' }, 'اختار المكنة'), L.machines.map((m) => h('option', { value: m.id, selected: m.id === Number(model.machine_id) }, m.name)));
  const techSel = h('select', { disabled: !editable, dataset: { field: 'technician_id', row: 0 }, onchange: (e) => { model.technician_id = e.target.value; changed(); } },
    h('option', { value: '' }, '—'), L.technicians.map((t) => h('option', { value: t.id, selected: t.id === Number(model.technician_id) }, t.name)));
  const dateIn = h('input', { type: 'date', value: model.sheet_date, disabled: !editable, dataset: { field: 'sheet_date', row: 0 },
    onchange: (e) => { model.sheet_date = e.target.value; changed(); } });
  const noIn = h('input', { type: 'text', value: model.sheet_no, disabled: !!model.id || !editable, placeholder: 'اختياري', inputmode: 'numeric',
    oninput: (e) => { model.sheet_no = asciiDigits(e.target.value); } });
  const notesIn = h('input', { type: 'text', value: model.notes, disabled: !editable, placeholder: 'توقف / أعطال / ملاحظات',
    oninput: (e) => { model.notes = e.target.value; changed(); } });

  const countsBox = h('div', { class: 'counts' });
  const statusBox = h('div', { class: 'small muted' });
  const tableBox = h('div', { class: 'table-wrap lines-wrap' });
  const issuesBox = h('div', { class: 'issues' });
  const actionsBox = h('div', { class: 'actions' });
  // Phone: one row per screen with a pager (the PC shows the whole table).
  const phone = matchMedia('(max-width: 820px)');
  const pagerBox = h('div', { class: 'pager' });
  let cur = 0;

  const title = sheet
    ? `ورقة ${sheet.machine_name}${sheet.sheet_no ? ' رقم ' + sheet.sheet_no : ''}`
    : 'إدخال ورقة';

  const titleEl = h('h1', {}, title);
  main.replaceChildren(
    h('div', { class: 'top' },
      h('div', {}, titleEl,
        sheet ? h('div', { class: 'small muted' },
          h('span', { class: `pill ${sheet.status}` }, sheet.status_name), ' ',
          `اتسجلت ${fmtDate(sheet.created_at)} بواسطة ${sheet.created_by_name || '—'}`,
          sheet.confirmed_at ? ` · اتأكدت ${fmtDate(sheet.confirmed_at)} بواسطة ${sheet.confirmed_by_name || '—'}` : '',
          sheet.cancel_reason ? ` · سبب الإلغاء: ${sheet.cancel_reason}` : '') : null),
      countsBox),
    h('div', { class: 'sheet-head' },
      field('المكنة', machineSel), field('رقم الورقة', noIn), field('الفني', techSel), field('تاريخ الورقة', dateIn), field('ملاحظات', notesIn)),
    pagerBox, tableBox, issuesBox, actionsBox, statusBox);

  function field(label, input) { return h('div', { class: 'field' }, h('label', {}, label), input); }

  // ---------- the lines table ----------
  function drawTable() {
    const m = machine();
    if (!m) { tableBox.replaceChildren(h('div', { class: 'card muted' }, 'اختار المكنة الأول.')); return; }
    const cols = columnsFor(m.code);
    if (layout) { drawPhotoTable(cols); return; }
    if (!editable) {
      tableBox.replaceChildren(h('table', { class: 'lines' },
        h('thead', {}, h('tr', {}, h('th', {}, 'م'), cols.map((c) => h('th', {}, c.label)))),
        h('tbody', {}, model.lines.map((l, i) => h('tr', {}, h('td', { class: 'rn' }, i + 1),
          cols.map((c) => h('td', { 'data-label': c.label }, readValue(l, c))))))));
      return;
    }
    tableBox.replaceChildren(h('table', { class: 'lines' },
      h('thead', {}, h('tr', {}, h('th', {}, 'م'), cols.map((c) => h('th', {}, c.label)), h('th', {}, ''))),
      h('tbody', {}, model.lines.map((l, i) => lineRow(l, i, cols)))));
    paintIssues();
    drawPager();
  }

  // Photo sheet: columns sized like the paper's, so each input sits under its own
  // handwriting in the strip of the photo above it.
  function drawPhotoTable(cols) {
    const t = layout.table;
    const pct = (w) => `${(w / t.width) * 100}%`;
    const paper = layout.columns.slice(1); // [0] is the row number
    const colgroup = h('colgroup', {}, h('col', { style: `width:${pct(layout.columns[0].w)}` }),
      cols.map((c) => h('col', { style: `width:${pct(paper.find((p) => p.field === c.field)?.w || 15)}` })));
    const rows = [];
    model.lines.forEach((l, i) => {
      if (i < t.rows) rows.push(stripRow(i, cols.length + 1));
      if (editable) {
        const tr = h('tr', { dataset: { i } }, h('td', { class: 'rn' }, h('div', {}, i + 1),
          i > 0 ? h('button', { class: 'btn sm', type: 'button', title: 'زي اللي فوق', onclick: () => copyAbove(i) }, '⤓') : null,
          h('button', { class: 'btn sm danger', type: 'button', title: 'امسح السطر', onclick: () => removeRow(i) }, '×')));
        for (const c of cols) {
          const td = h('td', { 'data-label': c.label, dataset: { field: c.field } }, cellInput(l, i, c));
          const read = readAt(i + 1, c.field);
          if (read) markRead(td, read, l, i, c);
          tr.append(td);
        }
        rows.push(tr);
      } else {
        rows.push(h('tr', { dataset: { i } }, h('td', { class: 'rn' }, i + 1), cols.map((c) => h('td', { 'data-label': c.label }, readValue(l, c)))));
      }
    });
    tableBox.replaceChildren(h('table', { class: 'lines photo' }, colgroup,
      h('thead', {}, h('tr', {}, h('th', {}, 'م'), cols.map((c) => h('th', {}, c.label)))),
      h('tbody', {}, rows)));
    if (editable) { paintIssues(); drawPager(); }
  }

  // What the automatic reader said about a cell.
  function readAt(row, field) { return (sheet?.reads || []).find((r) => r.row_no === row && r.field === field); }
  function markRead(td, read, l, i, c) {
    const pct = Math.round(read.confidence * 100);
    if (read.kind === 'ink') { td.classList.add('ocr-ink'); td.title = 'فيه كتابة هنا البرنامج لسه مش عارف يقراها'; return; }
    td.classList.add(read.confidence >= SURE ? 'ocr-sure' : 'ocr-read');
    td.title = read.kind === 'ditto' ? `البرنامج قرا "زي اللي فوق" (متأكد ${pct}%)` : `البرنامج قرا الخانة دي (متأكد ${pct}%)`;
    // Other likely names as one-tap chips (client / material).
    if ((c.kind === 'client' || c.kind === 'material') && read.candidates.length > 1) {
      const list = c.kind === 'client' ? state.lookups.clients : state.lookups.materials;
      const idKey = c.kind === 'client' ? 'client_id' : 'material_id';
      const textKey = c.kind === 'client' ? 'client_text' : 'material_text';
      td.append(h('div', { class: 'chips' }, read.candidates.map((cand) => {
        const item = list.find((x) => String(x.id) === cand.value);
        if (!item) return null;
        return h('button', { class: `chip${String(l[idKey]) === cand.value ? ' on' : ''}`, type: 'button', onclick: () => {
          l[idKey] = item.id; l[textKey] = item.name; setDitto(l, idKey, false);
          drawTable(); changed();
        } }, item.name);
      })));
    }
  }

  // اقرا الورقة: run the reader on the photo; it fills only the empty cells.
  async function readNow(btn) {
    btn.disabled = true;
    btn.textContent = 'جاري القراءة…';
    try {
      await saving;
      await save();
      const page = await pageFromUrl(sheet.photo.url);
      const reads = await readPage(page, layout, model.technician_id ? Number(model.technician_id) : null);
      await post(`/api/sheets/${model.id}/reads`, { reads });
      const sure = reads.filter((r) => r.value !== null || r.kind === 'ditto').length;
      toast(sure ? `البرنامج قرا ${sure} خانة — بص على الصفرا` : 'البرنامج لسه بيتعلم: علّم على الخانات اللي فيها كتابة بس');
      go(`#/sheets/${model.id}`);
    } catch (ex) {
      toast(ex.message, true);
      btn.disabled = false;
      btn.textContent = 'اقرا الورقة';
    }
  }

  // One printed row cut from the straightened photo (a little above and below the lines).
  function stripRow(i, span) {
    const t = layout.table;
    const pad = 1.5;
    const y = t.bodyY + i * t.rowH - pad;
    const hgt = t.rowH + 2 * pad;
    const img = h('img', { src: sheet.photo.url, alt: '', loading: 'lazy', draggable: 'false',
      style: `width:${(layout.width / t.width) * 100}%;right:auto;left:${(-t.x / t.width) * 100}%;top:${(-y / hgt) * 100}%` });
    return h('tr', { class: 'strip', dataset: { i } },
      h('td', { colspan: span, class: 'strip-cell' }, h('div', { class: 'strip-box', style: `aspect-ratio:${t.width} / ${hgt}`,
        title: 'دوس عشان تشوف الورقة كاملة', onclick: () => showPage(i) }, img)));
  }

  // The whole page, with the chosen row outlined. Click the page to zoom in and out.
  function showPage(row) {
    const box = pagePreview(sheet.photo.url, layout);
    if (row !== undefined && row < layout.table.rows) {
      const r = { y: layout.table.bodyY + row * layout.table.rowH, h: layout.table.rowH };
      box.querySelector('svg').insertAdjacentHTML('beforeend',
        `<rect x="${layout.table.x}" y="${r.y}" width="${layout.table.width}" height="${r.h}" fill="#ffd400" fill-opacity=".18" stroke="#e0a000" stroke-width="0.8"/>`);
    }
    box.classList.add('zoomable');
    box.addEventListener('click', () => box.classList.toggle('zoomed'));
    const back = h('div', { class: 'modal-back', onclick: (e) => { if (e.target === back) back.remove(); } },
      h('div', { class: 'modal page-modal' },
        h('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:8px' },
          h('b', {}, title), h('button', { class: 'btn', onclick: () => back.remove() }, 'قفل')),
        box));
    document.body.append(back);
  }

  // Rows that still need a look: a red issue or a yellow one not yet seen.
  function rowsToCheck() {
    const rows = new Set();
    for (const is of pending()) {
      const tr = is.row ? cellFor(is)?.closest('tr') : null;
      if (tr) rows.add(Number(tr.dataset.i));
    }
    return [...rows].sort((a, b) => a - b);
  }
  function drawPager() {
    if (!tableBox.isConnected) { phone.removeEventListener('change', drawPager); return; }
    const table = tableBox.querySelector('table.lines');
    const one = editable && phone.matches && !!table;
    table?.classList.toggle('one-row', one);
    if (!one) { pagerBox.replaceChildren(); return; }
    const n = model.lines.length;
    cur = Math.max(0, Math.min(cur, n - 1));
    table.querySelectorAll('tbody tr').forEach((tr) => tr.classList.toggle('cur', Number(tr.dataset.i) === cur));
    const toCheck = rowsToCheck();
    const nextCheck = toCheck.find((i) => i > cur) ?? toCheck[0];
    const goRow = (i) => { cur = i; drawPager(); table.querySelector('tr.cur input, tr.cur select')?.focus({ preventScroll: true }); };
    fill(pagerBox,
      h('button', { class: 'btn', type: 'button', disabled: cur === 0, onclick: () => goRow(cur - 1) }, '‹ اللي قبله'),
      h('b', {}, `سطر ${cur + 1} من ${n}`),
      h('button', { class: 'btn', type: 'button', onclick: () => {
        if (cur === n - 1) { model.lines.push(blankLine()); drawTable(); }
        goRow(cur + 1);
      } }, cur === n - 1 ? 'سطر جديد +' : 'اللي بعده ›'),
      nextCheck !== undefined && nextCheck !== cur
        ? h('button', { class: 'btn primary', type: 'button', onclick: () => goRow(nextCheck) }, `محتاج مراجعة (${toCheck.length}) ›`)
        : null);
  }
  phone.addEventListener('change', drawPager);

  function readValue(l, c) {
    if (c.kind === 'client') return l.client_text || '—';
    if (c.kind === 'material') return l.material_text || '—';
    if (c.kind === 'source') return l.material_source === 'factory' ? 'مصنع' : 'عميل';
    if (c.kind === 'date') return l.work_date ? fmtDate(l.work_date) : (model.sheet_date ? fmtDate(model.sheet_date) : '—');
    return l[c.key] || '—';
  }

  function lineRow(l, i, cols) {
    const tr = h('tr', { dataset: { i } }, h('td', { class: 'rn' }, i + 1));
    for (const c of cols) {
      const td = h('td', { 'data-label': c.label, dataset: { field: c.field } });
      td.append(cellInput(l, i, c));
      tr.append(td);
    }
    tr.append(h('td', {}, h('div', { class: 'row', style: 'flex-wrap:nowrap' },
      i > 0 ? h('button', { class: 'btn sm', type: 'button', title: 'زي اللي فوق', onclick: () => copyAbove(i) }, '⤓') : null,
      h('button', { class: 'btn sm danger', type: 'button', title: 'امسح السطر', onclick: () => removeRow(i) }, '×'))));
    return tr;
  }

  function cellInput(l, i, c) {
    const onFocus = (e) => markSeen(e.target);
    if (c.kind === 'client' || c.kind === 'material') return autocomplete(l, i, c, onFocus);
    if (c.kind === 'source') {
      return h('select', { onfocus: onFocus, onchange: (e) => { l.material_source = e.target.value; changed(); } },
        h('option', { value: 'client', selected: l.material_source !== 'factory' }, 'عميل'),
        h('option', { value: 'factory', selected: l.material_source === 'factory' }, 'مصنع'));
    }
    if (c.kind === 'date') {
      return h('input', { type: 'date', value: l.work_date, onfocus: onFocus, onkeydown: keys,
        onchange: (e) => { l.work_date = e.target.value; changed(); } });
    }
    const input = h('input', {
      type: 'text', class: c.kind === 'num' ? 'n' : '', value: l[c.key], inputmode: c.kind === 'num' ? 'decimal' : null,
      onfocus: onFocus, onkeydown: keys,
      oninput: (e) => {
        const ditto = DITTO.test(e.target.value.trim());
        if (ditto) e.target.value = dittoValue(i, c.key);
        setDitto(l, c.field, ditto);
        l[c.key] = e.target.value;
        if (c.key === 'pieces' || c.key === 'ops_per_piece') updateTotalHint(i);
        changed();
      },
    });
    if (c.key === 'total_written') { input.placeholder = product(l); input.dataset.totalFor = i; }
    return input;
  }

  // Search box with a dropdown, for clients and materials.
  function autocomplete(l, i, c, onFocus) {
    const isClient = c.kind === 'client';
    const items = () => (isClient ? state.lookups.clients.map((x) => ({ id: x.id, name: x.name, keys: [x.name] }))
      : state.lookups.materials.map((x) => ({ id: x.id, name: x.name, keys: [x.name, ...x.aliases] })));
    const idKey = isClient ? 'client_id' : 'material_id';
    const textKey = isClient ? 'client_text' : 'material_text';
    const wrap = h('div', { class: 'ac' });
    let list = null;
    let active = 0;
    let options = [];
    const input = h('input', { type: 'text', value: l[textKey], autocomplete: 'off', placeholder: isClient ? 'اكتب حرفين…' : '' });
    const close = () => { list?.remove(); list = null; };
    const choose = (opt) => {
      l[idKey] = opt.id;
      l[textKey] = opt.name;
      input.value = opt.name;
      close();
      changed();
    };
    const open = () => {
      const q = fold(input.value);
      const all = items();
      options = q ? all.filter((o) => o.keys.some((k) => fold(k).includes(q))) : all;
      options = options.slice(0, 12);
      close();
      active = 0;
      const rows = options.map((o, k) => h('div', { class: k === active ? 'on' : '', onmousedown: (e) => { e.preventDefault(); choose(o); } }, o.name));
      if (isClient && can('clients.edit') && input.value.trim() && !all.some((o) => fold(o.name) === q)) {
        rows.push(h('div', { class: 'new', onmousedown: (e) => { e.preventDefault(); addClient(input.value.trim()); } }, `+ إضافة "${input.value.trim()}" كعميل جديد`));
      }
      if (!rows.length) return;
      list = h('div', { class: 'ac-list' }, rows);
      wrap.append(list);
    };
    const addClient = async (name) => {
      try {
        const { client } = await post('/api/clients', { name });
        await loadLookups();
        choose({ id: client.id, name: client.name });
        toast(`اتضاف العميل ${client.name}`);
      } catch (ex) { toast(ex.message, true); }
    };
    input.addEventListener('focus', (e) => { onFocus(e); });
    input.addEventListener('input', () => {
      if (DITTO.test(input.value.trim()) && i > 0) {
        const above = model.lines[i - 1];
        l[idKey] = above[idKey];
        l[textKey] = above[textKey];
        input.value = above[textKey];
        setDitto(l, idKey, true);
        close();
        changed();
        return;
      }
      l[idKey] = null;
      l[textKey] = input.value;
      setDitto(l, idKey, false);
      changed();
      open();
    });
    input.addEventListener('blur', () => {
      setTimeout(close, 120);
      // An exact name typed without picking from the list still counts.
      if (!l[idKey] && input.value.trim()) {
        const exact = items().find((o) => o.keys.some((k) => fold(k) === fold(input.value)));
        if (exact) choose(exact);
      }
    });
    input.addEventListener('keydown', (e) => {
      if (list && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % Math.max(options.length, 1);
        [...list.children].forEach((d, k) => d.classList.toggle('on', k === active));
        return;
      }
      if (list && e.key === 'Enter' && options[active]) { e.preventDefault(); choose(options[active]); return; }
      if (e.key === 'Escape') { close(); return; }
      keys(e);
    });
    wrap.append(input);
    return wrap;
  }

  // Cells written as ~ or // on the paper: kept so the reader learns the mark.
  function setDitto(l, field, on) {
    const set = new Set(l.ditto_fields || []);
    if (on) set.add(field); else set.delete(field);
    l.ditto_fields = [...set];
  }

  const product = (l) => {
    const a = Number(asciiDigits(l.pieces)); const b = Number(asciiDigits(l.ops_per_piece));
    return a > 0 && b > 0 ? fmtNum(a * b) : '';
  };
  function updateTotalHint(i) {
    const el = tableBox.querySelector(`[data-total-for="${i}"]`);
    if (el) el.placeholder = product(model.lines[i]);
  }
  function dittoValue(i, key) { return i > 0 ? model.lines[i - 1][key] : ''; }

  function copyAbove(i) {
    const a = model.lines[i - 1];
    const l = model.lines[i];
    for (const k of ['client_id', 'client_text', 'part_name', 'material_id', 'material_text', 'thickness', 'work_date', 'material_source']) l[k] = a[k];
    drawTable();
    changed();
  }
  function removeRow(i) {
    if (layout && i < layout.table.rows) model.lines[i] = blankLine();
    else model.lines.splice(i, 1);
    if (model.lines.length < 3) model.lines.push(blankLine());
    drawTable();
    changed();
  }

  // ---------- issues ----------
  // Server rows are numbered over non-empty lines only; map them back to table rows.
  function rowIndexMap() {
    const map = [];
    if (layout) { model.lines.forEach((l, i) => { map[i] = i; }); return map; } // photo: row n is line n
    model.lines.forEach((l, i) => { if (!isEmpty(l)) map.push(i); });
    return map;
  }
  function cellFor(issue) {
    if (issue.row === 0) return main.querySelector(`[data-field="${issue.field}"][data-row="0"]`);
    const idx = rowIndexMap()[issue.row - 1];
    if (idx === undefined) return null;
    return tableBox.querySelector(`tr[data-i="${idx}"]:not(.strip) td[data-field="${issue.field}"]`);
  }
  function paintIssues() {
    tableBox.querySelectorAll('td.is-red, td.is-yellow').forEach((td) => td.classList.remove('is-red', 'is-yellow', 'seen'));
    main.querySelectorAll('.sheet-head .is-red, .sheet-head .is-yellow').forEach((el) => el.classList.remove('is-red', 'is-yellow', 'seen'));
    for (const is of issues) {
      const el = cellFor(is);
      if (!el) continue;
      const target = is.row === 0 ? el.parentElement : el;
      if (target.classList.contains('is-red')) continue;
      target.classList.add(is.level === 'red' ? 'is-red' : 'is-yellow');
      if (is.level === 'yellow' && acks.has(is.key)) target.classList.add('seen');
      target.dataset.issue = target.dataset.issue ? target.dataset.issue + ' ' + is.key : is.key;
    }
  }
  function markSeen(input) {
    const holder = input.closest('td') || input.parentElement;
    const keysHere = (holder?.dataset.issue || '').split(' ').filter(Boolean);
    let changedAny = false;
    for (const k of keysHere) {
      const is = issues.find((x) => x.key === k);
      if (is && is.level === 'yellow' && !acks.has(k)) { acks.add(k); changedAny = true; }
    }
    if (changedAny) { holder.classList.add('seen'); drawIssues(); drawPager(); }
  }
  const pending = () => issues.filter((i) => i.level === 'red' || !acks.has(i.key));

  function drawIssues() {
    const red = issues.filter((i) => i.level === 'red').length;
    const yellow = issues.filter((i) => i.level === 'yellow');
    const seen = yellow.filter((i) => acks.has(i.key)).length;
    const pills = !sheet || sheet.status === 'review' ? [
      h('span', { class: 'pill red' }, `${red} أحمر`),
      h('span', { class: 'pill yellow' }, `${yellow.length} أصفر${yellow.length ? ` (اتشاف ${seen})` : ''}`),
      !red && seen === yellow.length && model.id ? h('span', { class: 'pill green' }, 'جاهزة للتأكيد') : null,
    ] : [];
    countsBox.replaceChildren(...pills.filter(Boolean));
    issuesBox.replaceChildren(...issues.map((is) => h('div', {
      class: `issue ${is.level}${is.level === 'yellow' && acks.has(is.key) ? ' seen' : ''}`,
      onclick: () => focusIssue(is),
    }, h('b', {}, is.row ? `سطر ${is.row}` : 'الورقة'), is.message)));
  }
  function focusIssue(is) {
    const tr = is.row ? cellFor(is)?.closest('tr') : null;
    if (tr && Number(tr.dataset.i) !== cur && phone.matches) { cur = Number(tr.dataset.i); drawPager(); }
    const el = cellFor(is);
    const input = el && (el.matches('input,select') ? el : el.querySelector('input,select'));
    if (input) { input.focus(); input.select?.(); markSeen(input); }
  }
  // Enter = jump to the next red / not-yet-seen yellow cell.
  function keys(e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); confirmSheet(); return; }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const next = pending().find((is) => cellFor(is) && !cellFor(is).contains(e.target)) || pending()[0];
    if (next) focusIssue(next);
    else actionsBox.querySelector('.btn.primary')?.focus();
  }

  // ---------- saving ----------
  function changed() {
    dirty = true;
    statusBox.textContent = 'فيه تعديلات…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saving = save(); }, 900);
  }
  function payload() {
    return {
      machine_id: model.machine_id, technician_id: model.technician_id || null, sheet_date: model.sheet_date || null,
      sheet_no: model.sheet_no || null, notes: model.notes,
      lines: model.lines.map((l, i) => ({ ...l, row_no: i + 1 })).filter((l) => !isEmpty(l)).map((l) => {
        const o = { ...l };
        if (!layout) delete o.row_no;
        for (const k of TEXT_FIELDS) o[k] = String(o[k] || '');
        delete o.material_text;
        return o;
      }),
    };
  }
  async function save() {
    if (!editable || !model.machine_id) return;
    clearTimeout(saveTimer);
    if (!model.id && payload().lines.length === 0) { statusBox.textContent = ''; return; }
    dirty = false;
    statusBox.textContent = 'جاري الحفظ…';
    try {
      const r = model.id ? await put(`/api/sheets/${model.id}`, payload()) : await post('/api/sheets', payload());
      if (!model.id) {
        model.id = r.sheet.id;
        sheet = r.sheet;
        history.replaceState(null, '', `#/sheets/${model.id}`);
        titleEl.textContent = `ورقة ${r.sheet.machine_name}${r.sheet.sheet_no ? ' رقم ' + r.sheet.sheet_no : ''}`;
        machineSel.disabled = true;
        noIn.disabled = true;
        drawActions();
      }
      issues = r.sheet.issues;
      for (const k of [...acks]) if (!issues.some((x) => x.key === k)) acks.delete(k);
      paintIssues();
      drawIssues();
      drawPager();
      statusBox.textContent = dirty ? 'فيه تعديلات…' : 'اتحفظ ✓';
    } catch (ex) {
      dirty = true;
      statusBox.textContent = '';
      toast(ex.message, true);
    }
  }

  // ---------- actions ----------
  async function confirmSheet() {
    await saving;
    await save();
    if (!model.id) { toast('الورقة فاضية', true); return; }
    const left = pending();
    if (left.length) {
      const red = left.filter((i) => i.level === 'red').length;
      toast(red ? `فاضل ${red} خانة حمرا لازم تتصلح` : `فاضل ${left.length} خانة صفرا لازم تعدي عليها`, true);
      focusIssue(left[0]);
      return;
    }
    try {
      const r = await post(`/api/sheets/${model.id}/confirm`, { acks: [...acks] });
      toast('الورقة اتأكدت ✓');
      if (layout) await teachFrom(r.sheet).catch((err) => console.warn('teaching failed', err));
      go(`#/sheets/${model.id}`);
    } catch (ex) {
      if (ex.data?.issues) { issues = ex.data.issues; paintIssues(); drawIssues(); }
      toast(ex.message, true);
    }
  }

  // صوّر تاني: a better photo of the same paper; what was typed stays.
  function retakeButton() {
    const input = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true, onchange: async () => {
      const file = input.files[0];
      input.value = '';
      if (!file) return;
      toast('جاري تجهيز الصورة…');
      try {
        await saving;
        await save();
        const { result, jpeg } = await photoToPage(file);
        if (!jpeg) { toast(result.problems[0], true); return; }
        if (!result.ok && !(await confirmModal('الصورة فيها مشكلة', `${result.problems.join(' ')} ترفعها برضه؟`, 'ارفعها'))) return;
        await post(`/api/sheets/${model.id}/photo`, uploadBody(result, jpeg, !result.ok));
        toast('الصورة اتغيرت ✓');
        go(`#/sheets/${model.id}`);
      } catch (ex) { toast(ex.message, true); }
    } });
    return h('span', {}, input, h('button', { class: 'btn', type: 'button', onclick: () => input.click() }, 'صوّر تاني'));
  }

  function drawActions() {
    const btns = [];
    if (editable) {
      btns.push(h('button', { class: 'btn', type: 'button', onclick: () => { model.lines.push(blankLine()); cur = model.lines.length - 1; drawTable(); } }, '+ سطر'));
      if (can('sheets.confirm')) btns.push(h('button', { class: 'btn primary', type: 'button', onclick: confirmSheet }, 'تأكيد الورقة'));
      btns.push(h('button', { class: 'btn', type: 'button', onclick: async () => { await save(); toast('اتحفظت — تقدر تكمل بعدين'); go('#/sheets'); } }, 'حفظ وأكمل بعدين'));
      if (model.id) {
        btns.push(h('button', { class: 'btn danger', type: 'button', onclick: async () => {
          if (!(await confirmModal('مسح الورقة', 'الورقة دي لسه ما اتأكدتش. متأكد إنك عاوز تمسحها؟', 'امسح'))) return;
          try { await del(`/api/sheets/${model.id}`); toast('اتمسحت'); go('#/sheets'); } catch (ex) { toast(ex.message, true); }
        } }, 'مسح الورقة'));
      }
      if (layout) {
        btns.push(h('button', { class: 'btn', type: 'button', onclick: (e) => readNow(e.target) }, 'اقرا الورقة'));
        btns.push(retakeButton());
        btns.push(h('button', { class: 'btn', type: 'button', title: 'ورقة تجربة: البرنامج يتعلم منها ومتتحسبش شغل', onclick: async () => {
          if (!(await confirmModal('تعليم البرنامج بس', 'الورقة دي هتتحفظ كدرس: البرنامج يتعلم منها، بس مش هتتحسب شغل ولا هتروح للتسعير. اتأكد إن كل اللي في الورقة متكتب صح. نكمل؟', 'احفظها كدرس'))) return;
          try {
            await saving;
            await save();
            const r = await post(`/api/sheets/${model.id}/lesson`);
            await teachFrom(r.sheet);
            toast('البرنامج اتعلم من الورقة ✓');
            go(`#/sheets/${model.id}`);
          } catch (ex) { toast(ex.message, true); }
        } }, 'تعليم البرنامج بس'));
      }
      btns.push(h('span', { class: 'keys' }, 'Enter = الغلط اللي بعده · Tab = الخانة اللي بعدها · ~ أو // = زي اللي فوق · Ctrl+Enter = تأكيد'));
    } else if (sheet?.status === 'confirmed' && can('sheets.cancel')) {
      btns.push(h('button', { class: 'btn danger', type: 'button', onclick: async () => {
        const ok = await formModal({
          title: 'إلغاء الورقة', submitLabel: 'إلغاء الورقة',
          fields: [{ name: 'reason', label: 'سبب الإلغاء (هيتسجل)' }],
          onSubmit: (v) => post(`/api/sheets/${model.id}/cancel`, v),
        });
        if (ok) { toast('الورقة اتلغت'); go(`#/sheets/${model.id}`); }
      } }, 'إلغاء الورقة'));
    }
    if (layout) btns.push(h('button', { class: 'btn', type: 'button', onclick: () => showPage() }, 'الورقة كاملة'));
    btns.push(h('a', { class: 'btn', href: '#/sheets' }, 'رجوع للورق'));
    actionsBox.replaceChildren(...btns);
  }

  // First draw, after every helper above is defined.
  drawTable();
  drawIssues();
  drawActions();
}
