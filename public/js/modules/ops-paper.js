// ورقة التشغيل — the technician's paper, shared by the server (src/operations/sheets.js) and the
// browser (the entry grid and the review screen), so both read the paper the same way.
// No DOM and no imports: plain functions over plain objects.
//
//   paperColumns(machine)          the paper's own columns, right to left (after م)
//   parseNum / parseMaterialText / parseMinutes / parseWorkDate / validDate / isDitto
//   resolveDitto(lines)            "~" "//" "〃": copy the row above (with its client / material)
//   computedTotal / lineSections   what the numbers mean for pricing
//   lineIssues(machine, line, ctx) red (must be fixed) / yellow (must be looked at)

export const MACHINES = ['press', 'shear', 'laser', 'punch'];
export const MACHINE_NAMES = { press: 'التناية', shear: 'المقص', laser: 'الليزر', punch: 'البنش' };
export const SOURCE_NAMES = { client: 'خامة العميل', factory: 'خامة المصنع' };
export const STATUS_NAMES = { draft: 'مسودة', review: 'في المراجعة', approved: 'معتمدة', cancelled: 'ملغية' };
export const PRICED_NAMES = { none: 'لسه متسعرتش', partial: 'متسعرة جزئياً', posted: 'اتسعرت واترحّلت' };

export const NUMBER_FIELDS = ['thickness', 'pieces', 'per_piece', 'total_written', 'sheets', 'minutes_per_sheet',
  'louvers_per_piece', 'hits_per_piece', 'pieces_per_sheet', 'length_cm', 'width_cm'];
export const TEXT_FIELDS = ['client_text', 'part_name', 'material_text', 'start_time', 'end_time', 'sheet_size', 'work_date', 'notes'];
// Keys that may carry a "same as above" mark.
export const DITTO_FIELDS = ['client_text', 'part_name', 'material_text', 'thickness', 'pieces', 'per_piece', 'total_written',
  'sheets', 'start_time', 'end_time', 'louvers_per_piece', 'material_source', 'length_cm', 'width_cm', 'work_date', 'work_order_id'];
// A ditto on these keys copies their companion too (the id the text was resolved to).
const DITTO_COMPANIONS = { client_text: ['client_id'], material_text: ['material_id'], start_time: ['minutes_per_sheet'] };

const LABELS = {
  part_name: 'اسم القطعة', client_text: 'العميل', material_text: 'الخامة', thickness: 'السمك',
  pieces: 'عدد القطع', sheets: 'الكمية (ألواح)', start_time: 'وقت البداية', end_time: 'وقت النهاية',
  minutes_per_sheet: 'دقايق اللوح', work_date: 'التاريخ', material_source: 'المراجعة',
  louvers_per_piece: 'لوفر / قطعة', length_cm: 'الطول (سم)', width_cm: 'العرض (سم)', work_order_id: 'أمر الشغل',
  sheet_size: 'مقاس اللوح', pieces_per_sheet: 'قطع من اللوح', hits_per_piece: 'ضربات / قطعة',
};
export const OPS = { press: { per: 'عدد التنيات / قطعة', all: 'إجمالي التنيات', one: 'تنية' }, shear: { per: 'عدد القصات / قطعة', all: 'إجمالي القصات', one: 'قصة' } };
export function fieldLabel(machine, key) {
  if (key === 'per_piece') return OPS[machine]?.per || 'للقطعة';
  if (key === 'total_written') return OPS[machine]?.all || 'الإجمالي';
  return LABELS[key] || key;
}

// The paper columns (OLD paper, kept as is), right to left after م.
// type: text | client | material | number | date | source
export function paperColumns(machine) {
  const head = [
    { key: 'part_name', label: 'اسم القطعة', type: 'text', width: 140 },
    { key: 'client_text', label: 'العميل', type: 'client', width: 150 },
    { key: 'material_text', label: 'الخامة', type: 'material', width: 110 },
    { key: 'thickness', label: 'السمك', type: 'number', width: 64 },
  ];
  const tail = [
    { key: 'work_date', label: 'التاريخ', type: 'date', width: 92 },
    { key: 'material_source', label: 'المراجعة', type: 'source', width: 120 },
  ];
  if (machine === 'press' || machine === 'shear') {
    return [...head,
      { key: 'pieces', label: 'عدد القطع', type: 'number', width: 70 },
      { key: 'per_piece', label: OPS[machine].per, type: 'number', width: 84 },
      { key: 'total_written', label: OPS[machine].all, type: 'number', width: 84 },
      ...tail];
  }
  if (machine === 'laser' || machine === 'punch') {
    return [...head,
      { key: 'sheets', label: 'الكمية (ألواح)', type: 'number', width: 76 },
      { key: 'start_time', label: 'وقت البداية', type: 'text', width: 84, hint: 'الدقايق (زي 7) أو الساعة (8:30)' },
      { key: 'end_time', label: 'وقت النهاية', type: 'text', width: 84 },
      ...tail];
  }
  return [];
}
// Extra columns that are not on every paper: louvers (written on the punch sheet) and the
// size of a factory sheet (material from us is priced by weight).
export const LOUVER_COLUMNS = [
  { key: 'pieces', label: 'عدد القطع', type: 'number', width: 70 },
  { key: 'louvers_per_piece', label: 'لوفر / قطعة', type: 'number', width: 76 },
];
export const FACTORY_COLUMNS = [
  { key: 'length_cm', label: 'الطول (سم)', type: 'number', width: 76 },
  { key: 'width_cm', label: 'العرض (سم)', type: 'number', width: 76 },
];

// ---------- text → values ----------
const DIGITS = '٠١٢٣٤٥٦٧٨٩';
const PDIGITS = '۰۱۲۳۴۵۶۷۸۹';
export const toAscii = (s) => String(s ?? '')
  .replace(/[٠-٩]/g, (c) => String(DIGITS.indexOf(c)))
  .replace(/[۰-۹]/g, (c) => String(PDIGITS.indexOf(c)))
  .replace(/٫/g, '.').replace(/[٬،]/g, ',');

// Arabic name folding (same as src/util.js foldName): أإآ→ا, ى→ي, ة→ه, no diacritics/tatweel,
// no leading "ال" on each word, single spaces.
export const foldName = (s) => toAscii(s).trim().toLowerCase()
  .replace(/[ً-ْـ]/g, '')
  .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
  .split(/\s+/).filter(Boolean).map((w) => w.replace(/^ال(?=..)/, '')).join(' ');

export const DITTO_MARKS = ['~', '//', '〃', '״', '"', '””', '“', '\\\\'];
export const isDitto = (raw) => typeof raw === 'string' && DITTO_MARKS.includes(toAscii(raw).trim());

// A number as the technician writes it: "١٫٥م", "2,5", "٧ دقيقة", "12 قطعة". Blank → null, bad → NaN.
export function parseNum(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  let s = toAscii(v).trim().replace(/\s+/g, '')
    .replace(/(مم|ملي|mm|م|سم|cm|دقيقه|دقيقة|دقايق|دقائق|دق|د|ق|لوح|الواح|ألواح|قطعه|قطعة|قطع)$/iu, '');
  if (s === '') return null;
  if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(',', '.'); // "2,5" is a decimal on the paper
  s = s.replace(/,/g, '');
  if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

// "١٫٥م اسود" → { thickness: 1.5, material_id, name }. materials: [{ id, name, aliases[] }].
// The longest listed name (or alias) found in the text wins; nothing found → material_id null.
export function parseMaterialText(text, materials = []) {
  const s = toAscii(text).trim();
  if (!s) return { thickness: null, material_id: null, rest: '' };
  let thickness = null;
  const m = s.match(/(\d+(?:[.,]\d+)?)\s*(?:مم|ملي|mm|م(?![ء-ي]))?/iu);
  let rest = s;
  if (m) {
    const n = Number(m[1].replace(',', '.'));
    if (Number.isFinite(n) && n > 0) thickness = n;
    rest = (s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length)).trim();
  }
  const f = foldName(rest.replace(/[^\p{L}\p{N}\s]/gu, ' '));
  let best = null;
  if (f) {
    for (const mat of materials) {
      for (const n of [mat.name, ...(mat.aliases || [])]) {
        const g = foldName(n);
        if (!g) continue;
        const hit = g === f || (` ${f} `).includes(` ${g} `) || (f.length >= 3 && g.includes(f));
        if (hit && (!best || g.length > best.len)) best = { id: mat.id, name: mat.name, len: g.length };
      }
    }
  }
  return { thickness, material_id: best?.id ?? null, name: best?.name ?? null, rest };
}

// "8:30" → 510 (minutes of the day). Not a clock → null.
export function parseClock(v) {
  const s = toAscii(v).trim().replace(/\s+/g, '');
  const m = s.match(/^(\d{1,2})[:;](\d{2})$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  return hh * 60 + mm;
}

// وقت البداية / وقت النهاية on the laser and punch paper. Technicians usually write the minutes
// in وقت البداية ("٧ دقيقة" = 7 minutes per sheet). Two clock times → the minutes between them,
// spread over the sheets. Returns { minutes_per_sheet, from: 'minutes'|'clock'|null, error }.
export function parseMinutes(start, end, sheets) {
  const a = String(start ?? '').trim();
  const b = String(end ?? '').trim();
  if (!a && !b) return { minutes_per_sheet: null, from: null, error: null };
  const ca = parseClock(a);
  const cb = parseClock(b);
  if (ca !== null && cb !== null) {
    let diff = cb - ca;
    if (diff <= 0) diff += 24 * 60; // over midnight
    const n = Number(sheets) > 0 ? Number(sheets) : 1;
    return { minutes_per_sheet: Math.round((diff / n) * 100) / 100, from: 'clock', error: null, clock_minutes: diff };
  }
  const n = a ? parseNum(a) : parseNum(b);
  if (n === null) return { minutes_per_sheet: null, from: null, error: null };
  if (Number.isNaN(n) || n < 0) {
    return { minutes_per_sheet: null, from: null, error: 'bad' };
  }
  return { minutes_per_sheet: n, from: 'minutes', error: null };
}

// A real calendar date "YYYY-MM-DD" (2026-02-30 is not).
export function validDate(v) {
  const s = toAscii(v).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1) return false;
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return d <= days;
}

// The date column: "٢٠/١٠" → 20 October of the sheet's year; "20/10/26", "2026-10-20".
// Returns { value, ok }: value is ISO when ok, the text as written when not (it stays red).
export function parseWorkDate(v, sheetDate = null) {
  const raw = toAscii(v).trim();
  if (!raw) return { value: null, ok: true };
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(raw)) {
    const [y, m, d] = raw.split('-').map(Number);
    const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    return validDate(iso) ? { value: iso, ok: true } : { value: raw, ok: false };
  }
  const m = raw.match(/^(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{2,4}))?$/);
  if (!m) return { value: raw, ok: false };
  let y = m[3] ? Number(m[3]) : Number(String(sheetDate || '').slice(0, 4)) || new Date().getFullYear();
  if (y < 100) y += 2000;
  const iso = `${y}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[1])).padStart(2, '0')}`;
  return validDate(iso) ? { value: iso, ok: true } : { value: raw, ok: false };
}

// "~" on the server side: a key listed in ditto_fields takes the row above's value (and its
// companions: the client / material it was matched to). The first row can't copy anything.
export function resolveDitto(lines) {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const list = Array.isArray(l.ditto_fields) ? l.ditto_fields : [];
    if (i === 0) { l.ditto_fields = []; continue; }
    const prev = lines[i - 1];
    l.ditto_fields = [...new Set(list.filter((k) => DITTO_FIELDS.includes(k)))];
    for (const k of l.ditto_fields) {
      l[k] = prev[k] ?? null;
      for (const c of DITTO_COMPANIONS[k] || []) l[c] = prev[c] ?? null;
    }
  }
  return lines;
}

// ---------- what the numbers mean ----------
export function computedTotal(machine, l) {
  if ((machine === 'press' || machine === 'shear') && isNum(l.pieces) && isNum(l.per_piece)) return round6(l.pieces * l.per_piece);
  return null;
}
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round6 = (x) => Math.round(x * 1e6) / 1e6;

// The pricing sections a line feeds (spec «Section ← paper»): its machine, louvers written on
// the punch sheet, and material from us (factory) by weight.
export function lineSections(machine, l) {
  const out = [];
  const hasMachineWork = (machine === 'press' || machine === 'shear') ? isNum(l.pieces) && l.pieces > 0
    : isNum(l.sheets) && l.sheets > 0;
  if (hasMachineWork) out.push(machine);
  if (machine === 'punch' && isNum(l.louvers_per_piece) && l.louvers_per_piece > 0) out.push('louver');
  if (l.material_source === 'factory') out.push('material');
  return out;
}

// A line with nothing written on it is not a line.
export function isEmptyLine(l) {
  return !TEXT_FIELDS.some((k) => String(l[k] ?? '').trim()) && !NUMBER_FIELDS.some((k) => l[k] !== null && l[k] !== undefined && l[k] !== '')
    && !l.client_id && !l.material_id && !l.material_source && !l.work_order_id;
}

// Values that are possible but rare on this workshop's paper: worth a second look.
const UNUSUAL = { thickness: [0.2, 25], pieces: [0, 20000], per_piece: [0, 40], sheets: [0, 300], minutes_per_sheet: [0, 300],
  louvers_per_piece: [0, 200], length_cm: [1, 1000], width_cm: [1, 1000] };
export const SURE = 0.9; // an AI reading below this is yellow

const issue = (field, level, code, message) => ({ field, level, code, message });

// The review gate for one line. ctx: { sheetDate, today, orders: { id: { client_id, status, serial } } }.
// line: the normalized line (client_id / material_id resolved, numbers parsed, read_json parsed).
export function lineIssues(machine, l, ctx = {}) {
  const out = [];
  const lab = (k) => fieldLabel(machine, k);
  // red: must be fixed
  if (!l.client_id) {
    out.push(issue('client_text', 'red', 'no_client', l.client_text
      ? `«${l.client_text}» مش في قايمة العملاء — اختار العميل أو ضيفه` : 'العميل مش مكتوب'));
  }
  const need = (k) => { if (!isNum(l[k])) out.push(issue(k, 'red', 'missing', `${lab(k)} ناقص`)); };
  if (machine === 'press' || machine === 'shear') {
    need('pieces');
    need('per_piece');
    if (machine === 'press' && !isNum(l.thickness)) out.push(issue('thickness', 'red', 'missing', 'السمك ناقص (سعر التناية بيفرق تحت 3 مم وفوقها)'));
  } else if (machine === 'laser' || machine === 'punch') {
    const louverOnly = machine === 'punch' && isNum(l.louvers_per_piece) && !isNum(l.sheets) && !String(l.start_time ?? '').trim();
    if (!louverOnly) {
      need('sheets');
      if (l.minutes_error) out.push(issue('start_time', 'red', 'bad_minutes', 'الوقت مش مفهوم — اكتب الدقايق (زي 7) أو الساعة (8:30)'));
      else if (!isNum(l.minutes_per_sheet)) out.push(issue('start_time', 'red', 'missing', 'دقايق اللوح ناقصة — اكتبها في وقت البداية'));
    }
    if (machine === 'punch' && isNum(l.louvers_per_piece) && !isNum(l.pieces)) out.push(issue('pieces', 'red', 'missing', 'عدد القطع ناقص (اللوفر بيتحسب بالقطعة)'));
  }
  if (l.work_date && !validDate(l.work_date)) out.push(issue('work_date', 'red', 'bad_date', 'التاريخ غلط — اكتبه زي 20/10'));
  if (l.material_source === 'factory') {
    if (!isNum(l.length_cm) || !isNum(l.width_cm)) out.push(issue(!isNum(l.length_cm) ? 'length_cm' : 'width_cm', 'red', 'factory_size', 'خامة المصنع محتاجة الطول والعرض بالسنتي'));
    if (!l.material_id) out.push(issue('material_text', 'red', 'factory_material', 'خامة المصنع محتاجة نوع الخامة من القايمة (عشان الوزن)'));
    if (!isNum(l.thickness)) out.push(issue('thickness', 'red', 'missing', 'خامة المصنع محتاجة السمك (عشان الوزن)'));
    if (machine !== 'laser' && machine !== 'punch' && !isNum(l.sheets) && !isNum(l.pieces)) out.push(issue('pieces', 'red', 'missing', 'عدد القطع ناقص'));
  }
  if (l.work_order_id) {
    const o = ctx.orders?.[l.work_order_id];
    if (!o) out.push(issue('work_order_id', 'red', 'order_missing', 'أمر الشغل ده مش موجود'));
    else if (o.status === 'cancelled') out.push(issue('work_order_id', 'red', 'order_cancelled', `أمر الشغل ${o.serial} ملغي`));
    else if (l.client_id && o.client_id !== l.client_id) out.push(issue('work_order_id', 'red', 'order_client', `أمر الشغل ${o.serial} لعميل تاني`));
  }
  // yellow: must be looked at
  const calc = computedTotal(machine, l);
  if (calc !== null && isNum(l.total_written) && Math.abs(calc - l.total_written) > 1e-6) {
    out.push(issue('total_written', 'yellow', 'total_mismatch', `إجمالي الفني ${fmt(l.total_written)} والمحسوب ${fmt(calc)} (${fmt(l.pieces)} × ${fmt(l.per_piece)})`));
  }
  for (const [k, [lo, hi]] of Object.entries(UNUSUAL)) {
    if (isNum(l[k]) && (l[k] > hi || (lo > 0 && l[k] < lo))) out.push(issue(k === 'minutes_per_sheet' ? 'start_time' : k, 'yellow', `unusual_${k}`, `${lab(k)} ${fmt(l[k])} رقم مش معتاد — اتأكد منه`));
  }
  if (l.material_text && !l.material_id && l.material_source !== 'factory') {
    out.push(issue('material_text', 'yellow', 'material_unknown', `الخامة «${l.material_text}» مش في القايمة`));
  }
  if (machine !== 'press' && !isNum(l.thickness) && l.material_source !== 'factory') out.push(issue('thickness', 'yellow', 'thickness_missing', 'السمك مش مكتوب'));
  if (l.work_date && validDate(l.work_date) && ctx.sheetDate && validDate(ctx.sheetDate)) {
    const days = Math.abs(Date.parse(l.work_date) - Date.parse(ctx.sheetDate)) / 864e5;
    if (days > 31) out.push(issue('work_date', 'yellow', 'date_far', 'التاريخ بعيد عن تاريخ الورقة بأكتر من شهر'));
  }
  if (l.work_date && validDate(l.work_date) && ctx.today && l.work_date > ctx.today) out.push(issue('work_date', 'yellow', 'date_future', 'التاريخ لسه ماجاش'));
  // the AI reader was not sure of a cell, and nobody has changed it since
  const read = l.read_json && typeof l.read_json === 'object' ? l.read_json : null;
  if (read?.fields) {
    for (const [k, r] of Object.entries(read.fields)) {
      if (!r || typeof r.c !== 'number' || r.c >= SURE) continue;
      const cur = k === 'client_text' ? l.client_id ?? l.client_text ?? null : k === 'material_text' ? l.material_id ?? l.material_text ?? null : l[k] ?? null;
      if (sameValue(cur, r.v) && !out.some((x) => x.field === k && x.level === 'red')) {
        out.push(issue(k, 'yellow', 'ai_unsure', 'القراءة مش متأكدة من الخانة دي — قارنها بالصورة'));
      }
    }
  }
  return out;
}
const sameValue = (a, b) => (a === null || a === undefined || a === '' ? null : String(a)) === (b === null || b === undefined || b === '' ? null : String(b));
const fmt = (n) => (isNum(n) ? String(Math.round(n * 1000) / 1000) : '—');

// The key an acknowledgement is stored under: a changed value gives a new message, so the
// yellow comes back after an edit until somebody looks again.
export const issueKey = (i) => `${i.field}|${i.code}|${i.message}`;
