// Small shared helpers.

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
export const httpError = (status, message, extra) => new HttpError(status, message, extra);

// Arabic-Indic / Persian digits and Arabic separators → ASCII, so "١٫٥" reads as 1.5.
const DIGITS = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9' };
export function toAsciiDigits(s) {
  return String(s ?? '')
    .replace(/[٠-٩۰-۹]/g, (c) => DIGITS[c])
    .replace(/٫/g, '.')
    .replace(/[٬،]/g, ',');
}

// A number typed by a person: Arabic or Western digits, "١٫٥م", "2,5". Blank → null.
export function parseNumber(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = toAsciiDigits(v).trim().replace(/\s+/g, '').replace(/(مم|م)$/u, '');
  if (s === '') return null;
  if (/^\d+,\d+$/.test(s)) s = s.replace(',', '.'); // "2,5" is a decimal here, not thousands
  s = s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

// A real calendar day 'YYYY-MM-DD' (Arabic digits accepted), or null. 2026-02-31, 2026-13-40,
// 2026-2-5 and years outside 2000-2100 are not dates. Every date the app stores goes through here.
export function isRealDate(v) {
  if (v === null || v === undefined) return null;
  const s = toAsciiDigits(v).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1) return null;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate() ? s : null;
}

// Blank → null, a real date → 'YYYY-MM-DD', anything else → undefined (invalid).
export function parseDate(v) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  return isRealDate(v) ?? undefined;
}

// A date from a request: blank → fallback (or a 400 when required), invalid → a 400 naming the field.
export function requireDate(v, { field = 'date', label = 'التاريخ', required = true, fallback = null } = {}) {
  const d = parseDate(v);
  if (d === null) {
    if (required) throw httpError(400, `اكتب ${label}`, { field });
    return fallback;
  }
  if (d === undefined) throw httpError(400, `${label} غلط — لازم يكون يوم موجود في النتيجة (زي 2026-10-15)`, { field });
  return d;
}

export function todayISO(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function cleanText(v, max = 200) {
  return String(v ?? '').trim().slice(0, max);
}

// Arabic name folding for comparing names: أإآ→ا, ى→ي, ة→ه, no diacritics/tatweel,
// no leading "ال" on each word, single spaces. "المصريه" and "مصرية" fold the same.
export function foldName(s) {
  return String(s ?? '').trim().toLowerCase()
    .replace(/[\u064B-\u0652\u0640]/g, '')
    .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .split(/\s+/).map((w) => w.replace(/^ال(?=..)/, '')).join(' ');
}

// Express 4 doesn't catch errors from async handlers: pass them on to the error handler.
export const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
