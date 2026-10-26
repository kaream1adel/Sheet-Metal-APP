// What each machine's sheet records, and the checks a sheet must pass before it
// can be confirmed: every RED issue fixed, every YELLOW issue acknowledged.
import { parseNumber, parseDate, cleanText, todayISO } from './util.js';

// Columns per machine (beyond the common ones), in paper order.
export const MACHINE_FIELDS = {
  press: ['pieces', 'ops_per_piece', 'total_written'],
  shear: ['pieces', 'ops_per_piece', 'total_written'],
  laser: ['sheets', 'minutes_per_sheet'],
  punch: ['sheets', 'sheet_size', 'pieces_per_sheet', 'pieces', 'hits_per_piece', 'louvers_per_piece', 'minutes'],
};

const REQUIRED = {
  press: ['pieces', 'ops_per_piece'],
  shear: ['pieces', 'ops_per_piece'],
  laser: ['sheets', 'minutes_per_sheet'],
  punch: ['sheets', 'pieces'],
};

export const FIELD_LABELS = {
  client_id: 'العميل', part_name: 'اسم القطعة', material_id: 'الخامة', thickness: 'السمك',
  pieces: 'عدد القطع', ops_per_piece: 'العمليات للقطعة', total_written: 'الإجمالي',
  sheets: 'عدد الألواح', minutes_per_sheet: 'دقائق للوح', sheet_size: 'مقاس اللوح',
  pieces_per_sheet: 'قطع من اللوح', hits_per_piece: 'ضربات للقطعة', louvers_per_piece: 'لوفر للقطعة',
  minutes: 'دقائق', work_date: 'التاريخ', material_source: 'الخامة من',
};

const NUMERIC = ['thickness', 'pieces', 'ops_per_piece', 'total_written', 'sheets', 'minutes_per_sheet',
  'pieces_per_sheet', 'hits_per_piece', 'louvers_per_piece', 'minutes'];

// Normal ranges; outside them is a yellow "check this" warning, not an error.
const USUAL_MAX = { thickness: 25, pieces: 5000, ops_per_piece: 30, sheets: 500, minutes_per_sheet: 240,
  pieces_per_sheet: 500, hits_per_piece: 2000, louvers_per_piece: 500, minutes: 1440 };

// Turn a submitted row into a clean line. Numbers that can't be read become NaN
// (reported as red) so nothing typed is silently dropped.
export function normalizeLine(raw, rowNo) {
  const line = {
    row_no: rowNo,
    client_id: raw.client_id ? Number(raw.client_id) : null,
    client_text: cleanText(raw.client_text, 80),
    part_name: cleanText(raw.part_name, 120),
    material_id: raw.material_id ? Number(raw.material_id) : null,
    sheet_size: cleanText(raw.sheet_size, 40),
    work_date: raw.work_date ? (parseDate(raw.work_date) ?? 'invalid') : null,
    material_source: ['client', 'factory'].includes(raw.material_source) ? raw.material_source : null,
    notes: cleanText(raw.notes, 300),
  };
  for (const f of NUMERIC) line[f] = parseNumber(raw[f]);
  // Cells written as ~ or // on the paper (kept so the reader can learn the mark).
  const ditto = Array.isArray(raw.ditto_fields) ? raw.ditto_fields : [];
  line.ditto_fields = [...new Set(ditto.filter((f) => f in FIELD_LABELS))];
  return line;
}

// A row with nothing in it is not a line.
export function isEmptyLine(l) {
  return !l.client_id && !l.client_text && !l.part_name && !l.material_id && !l.sheet_size && !l.notes &&
    NUMERIC.every((f) => l[f] === null);
}

const near = (a, b) => Math.abs(a - b) < 1e-6;

// issues: [{ key, level: 'red'|'yellow', row, field, message }]
export function validateSheet(sheet, lines, machineCode, today = todayISO()) {
  const issues = [];
  const add = (level, row, field, code, message) =>
    issues.push({ key: `${row}:${field}:${code}`, level, row, field, message });

  if (!sheet.technician_id) add('yellow', 0, 'technician_id', 'missing', 'الفني مش متحدد');
  if (!sheet.sheet_date) add('yellow', 0, 'sheet_date', 'missing', 'تاريخ الورقة مش مكتوب');
  if (lines.length === 0) add('red', 0, 'lines', 'empty', 'الورقة مفيهاش ولا سطر');
  readIssues(sheet.reads, lines, add);

  const fields = MACHINE_FIELDS[machineCode] || [];
  for (const l of lines) {
    const r = l.row_no;
    for (const f of NUMERIC) {
      if (Number.isNaN(l[f])) add('red', r, f, 'nan', `${FIELD_LABELS[f]}: الرقم مش مفهوم`);
      else if (l[f] !== null && l[f] < 0) add('red', r, f, 'neg', `${FIELD_LABELS[f]} مينفعش يكون بالسالب`);
      else if (l[f] !== null && USUAL_MAX[f] && l[f] > USUAL_MAX[f]) {
        add('yellow', r, f, 'high', `${FIELD_LABELS[f]} = ${l[f]} — رقم كبير، اتأكد منه`);
      }
    }
    if (!l.client_id) {
      add('red', r, 'client_id', 'missing', l.client_text ? `اختار العميل ("${l.client_text}" مكتوب على الورقة)` : 'اختار العميل');
    }
    if (!l.material_id) add('yellow', r, 'material_id', 'missing', 'الخامة مش متحددة');
    if (l.thickness === null) add('yellow', r, 'thickness', 'missing', 'السمك مش مكتوب');
    else if (l.thickness === 0) add('red', r, 'thickness', 'zero', 'السمك مينفعش يكون صفر');

    for (const f of REQUIRED[machineCode] || []) {
      if (l[f] === null) add('red', r, f, 'missing', `اكتب ${FIELD_LABELS[f]}`);
      else if (l[f] === 0) add('red', r, f, 'zero', `${FIELD_LABELS[f]} مينفعش يكون صفر`);
    }

    // The technician's own total must match what we read.
    if ((machineCode === 'press' || machineCode === 'shear') && l.total_written !== null &&
        l.pieces > 0 && l.ops_per_piece > 0 && !near(l.pieces * l.ops_per_piece, l.total_written)) {
      add('red', r, 'total_written', 'mismatch',
        `القطع × العمليات = ${l.pieces * l.ops_per_piece} لكن الإجمالي المكتوب ${l.total_written} — صحّح واحد منهم`);
    }
    if (machineCode === 'punch' && l.sheets > 0 && l.pieces_per_sheet > 0 && l.pieces !== null &&
        !Number.isNaN(l.pieces) && !near(l.sheets * l.pieces_per_sheet, l.pieces)) {
      add('red', r, 'pieces', 'mismatch',
        `الألواح × القطع من اللوح = ${l.sheets * l.pieces_per_sheet} لكن إجمالي القطع ${l.pieces} — صحّح واحد منهم`);
    }

    const date = l.work_date || sheet.sheet_date;
    if (l.work_date === 'invalid') add('red', r, 'work_date', 'invalid', 'التاريخ غلط');
    else if (!date) add('red', r, 'work_date', 'missing', 'اكتب التاريخ (في السطر أو فوق الورقة)');
    else if (date > today) add('yellow', r, 'work_date', 'future', 'التاريخ في المستقبل');

    // Fields that don't belong to this machine must be empty.
    for (const f of NUMERIC) {
      if (f !== 'thickness' && !fields.includes(f) && l[f] !== null && !Number.isNaN(l[f])) {
        add('red', r, f, 'foreign', `${FIELD_LABELS[f]} مش من أعمدة المكنة دي`);
      }
    }
  }
  return issues;
}

// The automatic reader's suggestions, while the sheet is in review: a suggestion that is
// still in the cell and isn't sure is yellow (someone must look at it); writing it
// couldn't read, left empty, is yellow too. reads: rows of cell_reads.
export const SURE = 0.9;
function readIssues(reads, lines, add) {
  const byRow = new Map(lines.map((l) => [l.row_no, l]));
  for (const r of reads || []) {
    const l = byRow.get(r.row_no);
    const cur = l ? l[r.field] : null;
    const blank = cur === null || cur === undefined || cur === '' || Number.isNaN(cur);
    if (r.kind === 'ink') {
      if (!l) add('yellow', r.row_no, 'client_id', 'unread_row', 'السطر ده فيه كتابة ومتسجلش — اكتبه أو اتأكد إنه شخبطة');
      else if (blank) add('yellow', r.row_no, r.field, 'unread', `${FIELD_LABELS[r.field]}: فيه كتابة البرنامج مقدرش يقراها — اكتبها`);
      continue;
    }
    if (blank || r.value === null || r.confidence >= SURE) continue;
    const same = NUMERIC.includes(r.field) ? Number(cur) === Number(r.value) : String(cur) === String(r.value);
    if (same) {
      add('yellow', r.row_no, r.field, 'ocr', `${FIELD_LABELS[r.field]}: ${r.kind === 'ditto' ? 'اتقرت "زي اللي فوق"' : 'اتقرت أوتوماتيك'} (متأكد ${Math.round(r.confidence * 100)}%) — بص عليها`);
    }
  }
}

export const summarize = (issues) => ({
  red: issues.filter((i) => i.level === 'red').length,
  yellow: issues.filter((i) => i.level === 'yellow').length,
});
