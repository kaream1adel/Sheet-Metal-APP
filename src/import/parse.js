// Parsing the workbook into plain rows (no database): client work sheets (both layouts),
// the «عملاء» log and its sync keys, statements («كشف …»), «ملخص العملاء», partners,
// «المصروفات اليومية», «الشيكات», «الخامات», «المخزن حاليا» and the density table.
// Every row keeps a ref ("sheet!A12") so the preview and the decisions can point at it.
// Dates stay raw here ({ dateRef, dateValue }); plan.js resolves them with the decisions.
import { sheetApi, findSheet, findCol, headerKey, addr, colLetter, sheetKey } from './workbook.js';
import { mulRound } from '../money.js';
import { parseThickness, itemAmount, SECTION_BILLING } from '../pricing/formulas.js';

export const SECTION_TITLES = { 'التناية': 'press', 'الليزر': 'laser', 'البنش': 'punch', 'اللوفر': 'louver', 'المقص': 'shear', 'خامه من عندنا': 'material' };
const TITLE_BY_KEY = Object.fromEntries(Object.entries(SECTION_TITLES).map(([k, v]) => [headerKey(k), v]));

// Row-6 headers of a section → field names (headerKey text).
const FIELD_RES = [
  ['single', /قطعه واحده/], ['fixed_flag', /سعر محدد؟|سعر محدد\s*\?/], ['fixed_rate', /السعر المحدد/], ['fixed_amount', /مبلغ السعر/],
  ['date', /^التاريخ/], ['part', /^(القطعه|اللوح)/], ['pieces', /عدد القطع/], ['per_piece', /عدد (التنيات|القصات|لوفر)/],
  ['sheets', /عدد الالواح|^الكميه/], ['minutes', /الوقت بالدقيقه/], ['qty', /اجمالي الدقائق|نزله مقص|العدد الكلي للوفر/],
  ['thin', /اقل من 3/], ['thick', /3\s*مم فاكبر/], ['material', /^الخامه/], ['thickness', /السمك|سمك بالمم/],
  ['length', /طول/], ['width', /عرض/], ['weight', /الوزن الكلي/], ['w_galvanized', /وزن مجلفن/], ['w_black', /وزن اسود/],
  ['w_stainless', /وزن ستانلس/], ['w_aluminium', /وزن (الومنيوم|المونيوم|الالومنيوم)/], ['amount', /اجمالي التكلفه/],
];
const GROUP_FIELDS = { galvanized: 'w_galvanized', black: 'w_black', stainless: 'w_stainless', aluminium: 'w_aluminium' };
export const SYNC_KEY = /^OO_(\d+)_\d+_\d+_\d+$/;

// pounds (a number from a cell) → millimes, exact to the millime (round half up past that).
export const toMillimes = (x) => (x === null || x === undefined || Number.isNaN(x) ? null : mulRound(x, 1000));
// A rate in pounds that is a whole number of millimes, or null (2.5 → 2500; 1.2345 → null).
export function rateMillimes(x) {
  if (x === null || x === undefined || Number.isNaN(x) || x < 0) return null;
  const m = x * 1000;
  return Math.abs(m - Math.round(m)) < 1e-6 ? Math.round(m) : null;
}
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const numOr = (v) => (isNum(v) ? v : null);
const clean6 = (x) => (isNum(x) ? Number(x.toFixed(6)) : null);
const yes = (t) => /^نعم/.test(String(t || '').trim());

// "م/ سامي", "م. سامي", "المهندس سامي", "عميل النور" → the bare name (for matching only).
export function bareName(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim()
    .replace(/^(م\s*[/._\-ـ]\s*|م\s+|المهندس\s+|مهندس\s+|الاستاذ\s+|أ\s*[/.]\s*|عميل\s+(?!خارجي))/u, '')
    .trim();
}

// ---------- client work sheets ----------
function isWorkSheet(s) {
  const sections = new Set();
  for (let c = 1; c <= s.colCount; c++) {
    const sec = TITLE_BY_KEY[headerKey(s.text(2, c))];
    if (sec) sections.add(sec);
  }
  return sections.size >= 2 && headerKey(s.text(6, 1)) === 'التاريخ';
}
const isTemplate = (s) => /قالب/.test(s.name) || /^اكتب/.test(s.text(1, 1));

// The layout of one work sheet: sections with their field columns, rates (row 4), E1, the
// density table, and the sync-key columns.
export function workLayout(s) {
  const spans = {};
  for (let c = 1; c <= s.colCount; c++) {
    const sec = TITLE_BY_KEY[headerKey(s.text(2, c))];
    if (!sec) continue;
    if (!spans[sec]) spans[sec] = { from: c, to: c };
    spans[sec].to = c;
  }
  const sections = {};
  for (const [sec, span] of Object.entries(spans)) {
    const cols = {};
    for (let c = span.from; c <= span.to; c++) {
      const h = headerKey(s.text(6, c));
      if (!h) continue;
      const f = FIELD_RES.find(([, re]) => re.test(h));
      if (f && !cols[f[0]]) cols[f[0]] = c;
    }
    sections[sec] = { ...span, cols };
  }
  // E1: the cell after «إجمالي المبلغ» in row 1
  const totalLabel = findCol(s, 1, /اجمالي المبلغ/);
  const e1Col = totalLabel ? totalLabel + 1 : 5;
  // density table: the «الكثافة» header in row 6 outside the sections
  const dCol = findCol(s, 6, /الكثافه/);
  return { sections, e1Col, densityCol: dCol };
}

export function readRates(s, layout) {
  const r = (sec, f) => { const c = layout.sections[sec]?.cols[f]; return c ? numOr(s.num(4, c)) : null; };
  return {
    press_thin: r('press', 'thin'), press_thick: r('press', 'thick'),
    laser: r('laser', 'qty'), laser_min: r('laser', 'amount'),
    punch: r('punch', 'qty'), punch_min: r('punch', 'amount'),
    louver: r('louver', 'qty'), shear: r('shear', 'qty'),
    material: Object.fromEntries(Object.entries(GROUP_FIELDS).map(([g, f]) => [g, r('material', f)])),
  };
}

export function readDensities(s, layout) {
  const out = [];
  const d = layout.densityCol;
  if (!d) return out;
  for (let r = 7; r <= Math.min(s.rowCount, 60); r++) {
    const name = s.text(r, d - 1);
    const density = s.num(r, d);
    if (!name || !isNum(density)) continue;
    if (/^الافتراضي/.test(name)) continue;
    out.push({ name, density, group: s.text(r, d + 1) });
  }
  return out;
}

// Material group of a row: the group weight column that carries the weight, else the
// density table's group of the material name, else black (the Excel default).
function groupOf(s, r, cols, densities) {
  for (const [g, f] of Object.entries(GROUP_FIELDS)) {
    if (cols[f] && isNum(s.num(r, cols[f])) && s.num(r, cols[f]) > 0) return g;
  }
  const name = s.text(r, cols.material);
  const row = densities.find((x) => headerKey(x.name) === headerKey(name));
  const g = headerKey(row?.group || '');
  if (/مجلفن/.test(g)) return 'galvanized';
  if (/ستانل/.test(g)) return 'stainless';
  if (/الومن|المون/.test(g)) return 'aluminium';
  return 'black';
}

const INPUTS = ['part', 'pieces', 'per_piece', 'sheets', 'minutes', 'material', 'length', 'width', 'fixed_rate', 'fixed_flag', 'single'];

// One section row → an item, or null when the row carries nothing typed.
function workItem(s, r, sec, layout, rates, densities) {
  const { cols } = layout.sections[sec];
  const typed = (f) => cols[f] && s.get(r, cols[f]) !== null && !s.formula(r, cols[f]);
  const has = INPUTS.some(typed) || (sec === 'material' && typed('thickness')) || typed('amount');
  if (!has) return null;
  const n = (f) => (cols[f] ? numOr(s.num(r, cols[f])) : null);
  const t = (f) => (cols[f] ? s.text(r, cols[f]) : '');
  const item = {
    ref: `${s.name}!${addr(r, layout.sections[sec].from)}`, sheet: s.name, row: r, section: sec,
    dateRef: cols.date ? `${s.name}!${addr(r, cols.date)}` : null, dateValue: cols.date ? s.get(r, cols.date) : null,
    part_name: t('part'), material_text: t('material'), thickness: null, pieces: null, per_piece: null, sheets: null,
    minutes_per_sheet: null, single_piece: 0, length_cm: null, width_cm: null, weight_kg: null,
    qty: null, total_written: null, billing: SECTION_BILLING[sec], rate: null, rate_pounds: null, min_charge: null,
    excel_amount: null, cell_amount: null, formula_amount: null, notes: [], group: null, computed: false,
  };
  let rate = null;
  if (sec === 'press') {
    item.pieces = n('pieces'); item.per_piece = n('per_piece');
    item.thickness = n('thickness') ?? parseThickness(item.material_text);
    const thin = n('thin');
    const thick = n('thick');
    const fixed = yes(t('fixed_flag'));
    if (fixed) {
      item.billing = 'piece';
      rate = n('fixed_rate');
      item.qty = item.pieces;
      item.excel_amount = toMillimes(n('fixed_amount') ?? (isNum(item.pieces) && isNum(rate) ? item.pieces * rate : null));
    } else {
      const thickBand = (isNum(thick) && thick > 0) || (isNum(item.thickness) && item.thickness >= 3);
      rate = thickBand ? rates.press_thick : rates.press_thin;
      item.qty = thickBand ? thick : thin;
      if (!isNum(item.qty) && isNum(item.pieces) && isNum(item.per_piece)) { item.qty = clean6(item.pieces * item.per_piece); item.computed = true; }
      // E1 = E3 × E4 + H3 × H4 + K: the bends of the row times the sheet's rate
      const rm = rateMillimes(rate);
      item.excel_amount = rm === null && isNum(rate) && rate > 0 ? toMillimes((item.qty || 0) * rate)
        : (isNum(item.qty) && rm !== null ? mulRound(item.qty, rm) : 0);
    }
    item.total_written = item.qty;
    item.cell_amount = toMillimes(n('amount'));
  } else if (sec === 'laser' || sec === 'punch') {
    item.sheets = n('sheets'); item.minutes_per_sheet = n('minutes');
    item.thickness = parseThickness(item.material_text);
    item.single_piece = yes(t('single')) ? 1 : 0;
    rate = rates[sec];
    item.min_charge = rateMillimes(rates[`${sec}_min`]);
    item.qty = n('qty');
    if (!isNum(item.qty) && isNum(item.sheets) && isNum(item.minutes_per_sheet)) { item.qty = clean6(item.sheets * item.minutes_per_sheet + item.sheets); item.computed = true; }
    item.total_written = item.qty;
    item.cell_amount = toMillimes(n('amount'));
    item.excel_amount = item.cell_amount ?? 0; // R5 = SUM(U)
  } else if (sec === 'louver' || sec === 'shear') {
    item.pieces = n('pieces'); item.per_piece = n('per_piece');
    item.thickness = parseThickness(item.material_text);
    rate = rates[sec];
    item.qty = n('qty');
    if (!isNum(item.qty) && isNum(item.pieces) && isNum(item.per_piece)) { item.qty = clean6(item.pieces * item.per_piece); item.computed = true; }
    item.total_written = item.qty;
    item.cell_amount = toMillimes(n('amount'));
    // AJ5 = AJ3 × AJ4, AR5 = AR3 × AR4
    const rm = rateMillimes(rate);
    item.excel_amount = isNum(item.qty) && isNum(rate) ? (rm !== null ? mulRound(item.qty, rm) : toMillimes(item.qty * rate)) : 0;
  } else {
    item.sheets = n('sheets');
    item.thickness = n('thickness') ?? parseThickness(item.material_text);
    item.length_cm = n('length'); item.width_cm = n('width');
    item.weight_kg = clean6(n('weight'));
    item.group = groupOf(s, r, cols, densities);
    rate = rates.material[item.group];
    item.qty = item.weight_kg;
    item.cell_amount = toMillimes(n('amount'));
    item.excel_amount = item.cell_amount ?? 0; // BG5 = SUM(BG)
  }
  item.rate_pounds = isNum(rate) ? rate : null;
  item.rate = rateMillimes(rate);
  if (isNum(rate) && item.rate === null) item.notes.push('سعر الوحدة فيه كسور أقل من المليم');
  if (item.computed && item.qty > 0) item.notes.push('الكمية اتحسبت من الأعمدة (الخانة المحسوبة كانت فاضية في الملف)');
  // what our formula gives for the same row
  if (item.rate !== null && isNum(item.qty)) {
    item.formula_amount = itemAmount({ qty: item.qty, rate: item.rate, billing: item.billing, single_piece: !!item.single_piece, min_charge: item.min_charge });
  }
  if (item.cell_amount !== null && item.excel_amount !== null && item.cell_amount !== item.excel_amount && sec !== 'laser' && sec !== 'punch' && sec !== 'material') {
    item.notes.push('مبلغ الصف مختلف عن اللي داخل في الإجمالي E1');
  }
  return item;
}

export function readWorkSheet(ws) {
  const s = sheetApi(ws);
  const layout = workLayout(s);
  const rates = readRates(s, layout);
  const densities = readDensities(s, layout);
  const items = [];
  const keys = [];
  const title = s.text(1, 1).replace(/\s*[—-]+\s*حساب الشغل\s*$/u, '').trim();
  for (let r = 7; r <= s.rowCount; r++) {
    for (const sec of Object.keys(layout.sections)) {
      const it = workItem(s, r, sec, layout, rates, densities);
      if (it) items.push(it);
    }
    for (const { v } of s.cells(r)) if (typeof v === 'string' && SYNC_KEY.test(v.trim())) keys.push(v.trim());
  }
  // the sync key of a row belongs to the section of its number (1 press … 5 material)
  return {
    name: s.name, title, cols: s.colCount, layout: Object.fromEntries(Object.entries(layout.sections).map(([k, v]) => [k, colLetter(v.from)])),
    e1: numOr(s.num(1, layout.e1Col)), e1Ref: `${s.name}!${addr(1, layout.e1Col)}`,
    rates, densities, items, keys,
  };
}

// ---------- the «عملاء» log ----------
const LOG_SECTION = { 'الليزر': 'laser', 'لوفر': 'louver', 'اللوفر': 'louver', 'مقص': 'shear', 'المقص': 'shear', 'خامه من عندنا': 'material', 'البنش': 'punch', 'التناية': 'press', 'التنايه': 'press' };
const LOG_FIELDS = [
  ['client', /^عميل/], ['date', /^التاريخ/], ['pieces', /عدد القطع/], ['per_piece', /عدد (التنيات|القصات|لوفر)/],
  ['sheets', /عدد الالواح/], ['minutes', /الوقت بالدقيقه/], ['qty', /^(نزله تنايه|اجمالي الدقائق|العدد الكلي للوفر|نزله مقص)/],
  ['thickness', /سمك/], ['length', /طول/], ['width', /عرض/], ['material', /^الخامه/],
];

export function readLog(ws) {
  const s = sheetApi(ws);
  const blocks = [];
  let section = 'press';
  let cur = null;
  for (let c = 1; c <= s.colCount; c++) {
    const h = headerKey(s.text(1, c));
    const marker = h.match(/^<-+\s*(.+)$/);
    if (marker) {
      section = LOG_SECTION[marker[1].trim()] || null;
      cur = null;
      continue;
    }
    if (/^التاريخ/.test(h)) {
      cur = { section, cols: {}, index: blocks.length + 1 };
      blocks.push(cur);
    }
    if (!cur || !h) continue;
    const f = LOG_FIELDS.find(([, re]) => re.test(h));
    if (f && !cur.cols[f[0]]) cur.cols[f[0]] = c;
  }
  const rows = [];
  for (let r = 2; r <= s.rowCount; r++) {
    const keys = {};
    for (const { v } of s.cells(r)) {
      const m = typeof v === 'string' && v.trim().match(SYNC_KEY);
      if (m) keys[Number(m[1])] = v.trim();
    }
    for (const b of blocks) {
      if (!b.section || !b.cols.client) continue;
      const client = s.text(r, b.cols.client);
      const n = (f) => (b.cols[f] ? numOr(s.num(r, b.cols[f])) : null);
      const anyData = ['pieces', 'per_piece', 'sheets', 'minutes', 'thickness', 'length', 'width'].some((f) => n(f) !== null && n(f) !== 0);
      if (!client && !anyData) continue;
      rows.push({
        ref: `${s.name}!${addr(r, b.cols.date || b.cols.client)}`, sheet: s.name, row: r, section: b.section,
        client_text: client, dateRef: b.cols.date ? `${s.name}!${addr(r, b.cols.date)}` : null, dateValue: b.cols.date ? s.get(r, b.cols.date) : null,
        pieces: n('pieces'), per_piece: n('per_piece'), sheets: n('sheets'), minutes_per_sheet: n('minutes'), qty: n('qty'),
        thickness: n('thickness') ?? parseThickness(b.cols.material ? s.text(r, b.cols.material) : ''),
        length_cm: n('length'), width_cm: n('width'), material_text: b.cols.material ? s.text(r, b.cols.material) : '',
        key: keys[b.index] || null,
      });
    }
  }
  return { name: s.name, rows };
}

// ---------- statements «كشف …» ----------
export function readStatement(ws) {
  const s = sheetApi(ws);
  const col = (re) => findCol(s, 1, re);
  const c = { date: col(/^التاريخ/), desc: col(/^(الوصف|البيان)/), debit: col(/^مدين/), discount: col(/^خصم/), credit: col(/^دائن/) };
  // the linked row 2: C2 = 'work sheet'!E1 (the work total, replaced by the posted items)
  const f = c.debit ? s.formula(2, c.debit) : null;
  const m = f && f.match(/^\s*'?([^'!]+?)'?!\$?[A-Z]+\$?\d+\s*$/u);
  const textLink = (s.text(2, c.desc || 2).match(/«([^»]+)»/) || [])[1] || null;
  const link = m ? m[1].trim() : null;
  const rows = [];
  const skipped = [];
  for (let r = 2; r <= s.rowCount; r++) {
    const v = (k) => (c[k] ? s.num(r, c[k]) : null);
    const linked = r === 2 && (link || textLink);
    const desc = c.desc && !linked ? s.text(r, c.desc) : ''; // row 2's text only names the linked sheet
    const amounts = { debit: v('debit'), discount: v('discount'), credit: v('credit') };
    if (linked) amounts.debit = null; // the work total: posted item by item
    for (const [k, x] of Object.entries(amounts)) {
      if (Number.isNaN(x)) {
        skipped.push({ ref: `${s.name}!${addr(r, c[k])}`, sheet: s.name, row: r, reason: 'مبلغ مش رقم', text: s.text(r, c[k]) });
        amounts[k] = null;
      }
    }
    for (const [k, x] of Object.entries(amounts)) {
      if (!isNum(x) || x === 0) continue;
      rows.push({
        ref: `${s.name}!${addr(r, c[k])}`, sheet: s.name, row: r, kind: k, amount: toMillimes(Math.abs(x)), negative: x < 0,
        desc, dateRef: c.date ? `${s.name}!${addr(r, c.date)}` : null, dateValue: c.date ? s.get(r, c.date) : null,
        cheque: k === 'credit' && /شيك/.test(desc),
      });
    }
  }
  return { name: s.name, client: s.name.replace(/^كشف\s+/u, '').trim(), link: link || textLink, linkFromFormula: !!link, rows, skipped };
}

// ---------- «ملخص العملاء» ----------
export function readSummary(ws) {
  const s = sheetApi(ws);
  const c = { name: findCol(s, 1, /^العميل/) || 1, debit: findCol(s, 1, /المدين/), discount: findCol(s, 1, /الخصم/), credit: findCol(s, 1, /الدائن/), balance: findCol(s, 1, /الرصيد/) };
  const rows = [];
  let total = null;
  for (let r = 2; r <= s.rowCount; r++) {
    const name = s.text(r, c.name);
    if (!name) continue;
    const vals = { debit: numOr(s.num(r, c.debit)), discount: numOr(s.num(r, c.discount)), credit: numOr(s.num(r, c.credit)), balance: numOr(s.num(r, c.balance)) };
    if (/^الاجمالي|^الإجمالي/.test(name)) { total = vals; break; }
    const f = s.formula(r, c.debit) || '';
    const m = f.match(/'?([^'!]+?)'?!\$?I\$?2/u);
    rows.push({ name, statement: m ? m[1].trim() : null, row: r, ...vals });
  }
  return { rows, total };
}

// ---------- partners ----------
export function readPartnersSummary(ws) {
  const s = sheetApi(ws);
  const c = { name: 1, credit: findCol(s, 1, /^دائن/), debit: findCol(s, 1, /^مدين/), net: findCol(s, 1, /صافي/) };
  const rows = [];
  let total = null;
  for (let r = 2; r <= s.rowCount; r++) {
    const name = s.text(r, c.name);
    if (!name) continue;
    const vals = { credit: numOr(s.num(r, c.credit)), debit: numOr(s.num(r, c.debit)), net: numOr(s.num(r, c.net)) };
    if (/^(الاجمالي|الإجمالي)/.test(name)) { total = vals; break; }
    if (vals.credit === null && vals.debit === null) continue; // notes under the table
    const f = s.formula(r, c.credit) || '';
    const m = f.match(/'?([^'!(]+?)'?!\$?B/u);
    rows.push({ name, sheet: m ? m[1].trim() : name, ...vals });
  }
  return { rows, total };
}

export function readPartnerSheet(ws) {
  const s = sheetApi(ws);
  const c = { credit: findCol(s, 1, /^دائن/), debit: findCol(s, 1, /^مدين/), desc: findCol(s, 1, /^(الوصف|البيان)/), date: findCol(s, 1, /تاريخ/) };
  const rows = [];
  const skipped = [];
  for (let r = 2; r <= s.rowCount; r++) {
    const credit = c.credit ? s.num(r, c.credit) : null;
    const debit = c.debit ? s.num(r, c.debit) : null;
    if (Number.isNaN(credit) || Number.isNaN(debit)) { skipped.push({ ref: `${s.name}!${addr(r, c.credit)}`, sheet: s.name, row: r, reason: 'مبلغ مش رقم', text: s.text(r, c.desc) }); continue; }
    const hasC = isNum(credit) && credit !== 0;
    const hasD = isNum(debit) && debit !== 0;
    if (!hasC && !hasD) continue;
    const desc = c.desc ? s.text(r, c.desc) : '';
    const base = { sheet: s.name, row: r, desc, dateRef: c.date ? `${s.name}!${addr(r, c.date)}` : `${s.name}!${addr(r, 1)}`, dateValue: c.date ? s.get(r, c.date) : null };
    if (hasC) rows.push({ ...base, ref: `${s.name}!${addr(r, c.credit)}`, side: 'credit', amount: toMillimes(Math.abs(credit)), negative: credit < 0 });
    if (hasD) rows.push({ ...base, ref: `${s.name}!${addr(r, c.debit)}`, side: 'debit', amount: toMillimes(Math.abs(debit)), negative: debit < 0 });
  }
  return { name: s.name, rows, skipped };
}

// ---------- ledgers with a header row: expenses, cheques, materials ----------
function headerRow(s, re) {
  for (let r = 1; r <= Math.min(10, s.rowCount); r++) for (let c = 1; c <= s.colCount; c++) if (re.test(headerKey(s.text(r, c)))) return r;
  return null;
}
// The number in the cell after a label in the first rows («إجمالي المصروفات» → D1).
function labelled(s, re) {
  for (let r = 1; r <= 3; r++) {
    const c = findCol(s, r, re);
    if (c) return numOr(s.num(r, c + 1));
  }
  return null;
}

export function readExpenses(ws) {
  const s = sheetApi(ws);
  const hr = headerRow(s, /^البند|البيان/) || 3;
  const c = { date: findCol(s, hr, /^التاريخ/), desc: findCol(s, hr, /البند|البيان/), amount: findCol(s, hr, /^المبلغ/), notes: findCol(s, hr, /ملاحظات/) };
  const rows = [];
  const skipped = [];
  for (let r = hr + 1; r <= s.rowCount; r++) {
    const desc = s.text(r, c.desc);
    const amount = s.num(r, c.amount);
    if (!desc && (amount === null || amount === 0)) continue;
    if (!isNum(amount) || amount === 0) {
      skipped.push({ ref: `${s.name}!${addr(r, c.amount)}`, sheet: s.name, row: r, reason: amount === null ? 'من غير مبلغ' : 'المبلغ مكتوب كلام مش رقم', text: [desc, s.text(r, c.amount)].filter(Boolean).join(' — ') });
      continue;
    }
    rows.push({ ref: `${s.name}!${addr(r, c.amount)}`, sheet: s.name, row: r, desc, notes: c.notes ? s.text(r, c.notes) : '',
      amount: toMillimes(Math.abs(amount)), negative: amount < 0,
      dateRef: `${s.name}!${addr(r, c.date)}`, dateValue: s.get(r, c.date) });
  }
  return { name: s.name, rows, skipped, total: labelled(s, /اجمالي المصروفات/) };
}

export function readCheques(ws) {
  const s = sheetApi(ws);
  const hr = headerRow(s, /رقم الشيك/) || 3;
  const c = { date: findCol(s, hr, /^التاريخ/), number: findCol(s, hr, /رقم الشيك/), payee: findCol(s, hr, /المستفيد/), desc: findCol(s, hr, /البيان/), amount: findCol(s, hr, /^المبلغ/) };
  const rows = [];
  const skipped = [];
  for (let r = hr + 1; r <= s.rowCount; r++) {
    const amount = s.num(r, c.amount);
    const payee = s.text(r, c.payee);
    if (amount === null && !payee) continue;
    if (!isNum(amount) || amount <= 0) { skipped.push({ ref: `${s.name}!${addr(r, c.amount)}`, sheet: s.name, row: r, reason: 'مبلغ مش رقم', text: payee }); continue; }
    rows.push({ ref: `${s.name}!${addr(r, c.amount)}`, sheet: s.name, row: r, number: c.number ? s.text(r, c.number) : '', payee,
      desc: c.desc ? s.text(r, c.desc) : '', amount: toMillimes(amount), dateRef: `${s.name}!${addr(r, c.date)}`, dateValue: s.get(r, c.date) });
  }
  return { name: s.name, rows, skipped, total: labelled(s, /اجمالي الشيكات/) };
}

export function readMaterials(ws) {
  const s = sheetApi(ws);
  const hr = headerRow(s, /^المورد/) || 3;
  const c = { date: findCol(s, hr, /^التاريخ/), supplier: findCol(s, hr, /^المورد/), material: findCol(s, hr, /^الخامه/), qty: findCol(s, hr, /^الكميه/),
    rate: findCol(s, hr, /سعر الوحده/), total: findCol(s, hr, /^الاجمالي/), method: findCol(s, hr, /طريقه الدفع/), cheque: findCol(s, hr, /رقم الشيك/), notes: findCol(s, hr, /ملاحظات/) };
  const rows = [];
  const skipped = [];
  for (let r = hr + 1; r <= s.rowCount; r++) {
    const total = s.num(r, c.total);
    const supplier = s.text(r, c.supplier);
    if ((total === null || total === 0) && !supplier) continue;
    if (!isNum(total) || total <= 0) { skipped.push({ ref: `${s.name}!${addr(r, c.total)}`, sheet: s.name, row: r, reason: 'من غير إجمالي', text: supplier }); continue; }
    rows.push({ ref: `${s.name}!${addr(r, c.total)}`, sheet: s.name, row: r, supplier, material_text: s.text(r, c.material),
      qty: numOr(s.num(r, c.qty)), unit_rate: numOr(s.num(r, c.rate)), amount: toMillimes(total),
      method: /شيك/.test(s.text(r, c.method)) ? 'cheque' : 'cash', cheque_number: c.cheque ? s.text(r, c.cheque) : '', notes: c.notes ? s.text(r, c.notes) : '',
      dateRef: `${s.name}!${addr(r, c.date)}`, dateValue: s.get(r, c.date) });
  }
  return { name: s.name, rows, skipped, total: labelled(s, /اجمالي الخامات/), cash: labelled(s, /مدفوع كاش/), cheque: labelled(s, /مدفوع بشيك/) };
}

export function readStore(ws) {
  const s = sheetApi(ws);
  for (let r = 1; r <= s.rowCount; r++) {
    if (/الرصيد الموجود/.test(headerKey(s.text(r, 1)))) return { balance: numOr(s.num(r, 2)), ref: `${s.name}!B${r}` };
  }
  return null;
}

// ---------- the whole workbook ----------
export function readWorkbook(wb) {
  const out = { work: [], templates: [], statements: [], log: null, summary: null, partners: null, partnerSheets: [],
    expenses: null, cheques: null, materials: null, store: null, sheets: wb.worksheets.map((w) => w.name) };
  const summaryWs = findSheet(wb, 'ملخص العملاء');
  const partnersWs = findSheet(wb, 'حسابات الشركاء');
  const logWs = findSheet(wb, 'عملاء');
  const expensesWs = findSheet(wb, 'المصروفات اليومية');
  const chequesWs = findSheet(wb, 'الشيكات');
  const materialsWs = findSheet(wb, 'الخامات');
  const storeWs = findSheet(wb, 'المخزن حاليا', 'المخزن حاليًا');
  if (summaryWs) out.summary = readSummary(summaryWs);
  if (partnersWs) out.partners = readPartnersSummary(partnersWs);
  if (logWs) out.log = readLog(logWs);
  if (expensesWs) out.expenses = readExpenses(expensesWs);
  if (chequesWs) out.cheques = readCheques(chequesWs);
  if (materialsWs) out.materials = readMaterials(materialsWs);
  if (storeWs) out.store = readStore(storeWs);
  const partnerNames = new Set((out.partners?.rows || []).map((p) => sheetKey(p.sheet)));
  for (const ws of wb.worksheets) {
    if ([summaryWs, partnersWs, logWs, expensesWs, chequesWs, materialsWs, storeWs].includes(ws)) continue;
    const s = sheetApi(ws);
    if (partnerNames.has(sheetKey(ws.name))) { out.partnerSheets.push(readPartnerSheet(ws)); continue; }
    if (/^كشف\s/u.test(ws.name) && headerKey(s.text(1, 1)) === 'التاريخ') {
      if (!/قالب/.test(ws.name)) out.statements.push(readStatement(ws));
      continue;
    }
    if (/^قالب/.test(ws.name) && /كشف/.test(ws.name)) continue;
    if (isWorkSheet(s)) {
      if (isTemplate(s)) out.templates.push(readWorkSheet(ws));
      else out.work.push(readWorkSheet(ws));
    }
  }
  return out;
}
