// Calendar helpers for the reports: real calendar dates only (2026-02-30 is refused),
// week and month ranges, day differences. All dates are 'YYYY-MM-DD' local dates.
import { httpError, toAsciiDigits, todayISO, isRealDate } from '../util.js';

// A real calendar date or null. '2026-02-29' → null (2026 is not a leap year).
export const realDate = (v) => isRealDate(v); // src/util.js

// A query/body date: blank → fallback, real date → it, anything else → 400 with an Arabic message.
export function dateParam(v, label = 'التاريخ', fallback = null, field = 'date') {
  if (v === null || v === undefined || v === '') return fallback;
  const d = realDate(v);
  if (!d) throw httpError(400, `${label} غلط — اكتبه بالشكل 2026-10-15 وبتاريخ موجود فعلاً`, { field });
  return d;
}

export function monthParam(v, fallback) {
  if (v === null || v === undefined || v === '') return fallback;
  const s = toAsciiDigits(v).trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(s)) throw httpError(400, 'الشهر لازم يكون بالشكل 2026-10', { field: 'month' });
  return s;
}

export const today = () => todayISO();

export function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Whole days from a to b (b − a).
export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
}

export function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

export function prevMonth(month, n = 1) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 - n, 1));
  return d.toISOString().slice(0, 7);
}

export const MONTH_NAMES = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
export const monthName = (month) => `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
