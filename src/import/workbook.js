// Reading the workbook «حسابات شركة الصفا» with exceljs: cached formula results (never
// re-computed), cells addressed by number, and the column of every field found from the
// header rows (the workbook has two client-sheet layouts, 63 and 69 columns, so nothing
// relies on a fixed letter).
import { createRequire } from 'module';
import crypto from 'crypto';
import { toAsciiDigits } from '../util.js';

const require = createRequire(import.meta.url);
const ExcelJS = require('exceljs');

// path or Buffer → { wb, hash }
export async function loadWorkbook(input) {
  const wb = new ExcelJS.Workbook();
  let buf = input;
  if (typeof input === 'string') {
    const fs = await import('fs');
    buf = fs.readFileSync(input);
  }
  await wb.xlsx.load(buf);
  return { wb, hash: crypto.createHash('sha256').update(buf).digest('hex') };
}

// The cached value of a cell: number | string | Date | boolean | null. Formulas give their
// cached result (null when the file has none), rich text gives its text, errors give null.
export function plain(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if ('formula' in v || 'sharedFormula' in v) return v.result === undefined ? null : plain(v.result);
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
    if ('error' in v) return null;
    if ('text' in v) return plain(v.text);
    return null;
  }
  if (typeof v === 'string') return v.trim() === '' ? null : v;
  return v;
}

export function formulaOf(v) {
  if (v && typeof v === 'object' && ('formula' in v || 'sharedFormula' in v)) return v.formula || null;
  return null;
}

// A sheet as a small API: get(r, c) cached value, text(r, c), num(r, c), formula(r, c).
export function sheetApi(ws) {
  const cell = (r, c) => ws.getRow(r).getCell(c).value;
  const api = {
    name: ws.name,
    ws,
    rowCount: ws.rowCount,
    colCount: ws.columnCount,
    raw: cell,
    get: (r, c) => plain(cell(r, c)),
    formula: (r, c) => formulaOf(cell(r, c)),
    text: (r, c) => {
      const v = plain(cell(r, c));
      if (v === null) return '';
      if (v instanceof Date) return v.toISOString().slice(0, 10);
      return String(v).replace(/\s+/g, ' ').trim();
    },
    // A number typed or computed: numbers as they are, digits in text («١٢٥٠», "1,250") parsed.
    // Blank → null; text that is not a number → NaN.
    num: (r, c) => toNumber(plain(cell(r, c))),
    // Every non-empty cell of a row: [{ c, v }]
    cells: (r) => {
      const out = [];
      ws.getRow(r).eachCell({ includeEmpty: false }, (x) => {
        const v = plain(x.value);
        if (v !== null) out.push({ c: x.col, v });
      });
      return out;
    },
  };
  return api;
}

export function toNumber(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'boolean' || v instanceof Date) return NaN;
  const s = toAsciiDigits(v).replace(/\s+/g, '').replace(/,/g, '');
  if (s === '') return null;
  return /^-?(\d+\.?\d*|\.\d+)$/.test(s) ? Number(s) : NaN;
}

// "A1"-style address for messages.
export function colLetter(c) {
  let s = '';
  let n = c;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
export const addr = (r, c) => `${colLetter(c)}${r}`;

// Header text folded for matching: no line breaks, single spaces, أإآ→ا, ة→ه, ى→ي.
export function headerKey(v) {
  return String(v ?? '').replace(/\s+/g, ' ').trim()
    .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي');
}

// Finds the first column in row r whose header matches re (on headerKey), within [from, to].
export function findCol(s, r, re, from = 1, to = s.colCount) {
  for (let c = from; c <= to; c++) if (re.test(headerKey(s.text(r, c)))) return c;
  return null;
}

// Sheet names are compared folded (a trailing space or ة/ه never matters).
export const sheetKey = (name) => headerKey(name).replace(/\s+/g, ' ');
export function findSheet(wb, ...names) {
  const wanted = names.map(sheetKey);
  return wb.worksheets.find((w) => wanted.includes(sheetKey(w.name))) || null;
}
