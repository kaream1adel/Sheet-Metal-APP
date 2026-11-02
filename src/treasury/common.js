// Shared input rules of the treasury module: real calendar dates, money in millimes, parties
// of the right kind, and the Arabic names of methods / sources / kinds. Every error is a 400
// with { field } so the form marks the right input.
import { getDb } from '../db.js';
import { parseMoney } from '../money.js';
import { httpError, toAsciiDigits, cleanText, isRealDate as utilIsRealDate } from '../util.js';

export const METHODS = { cash: 'نقدي', transfer: 'تحويل بنكي', instapay: 'إنستاباي', wallet: 'محفظة', cheque: 'شيك' };
export const ACCOUNTS = { cash: 'الخزينة', bank: 'البنك' };
export const PAID_FROM = {
  cash: 'الخزينة', bank: 'البنك', cheque: 'شيك من عندنا', partner: 'شريك دفع من جيبه',
  supplier_credit: 'على حساب مورد (آجل)', client_offset: 'مقاصة مع عميل',
};
export const VOUCHER_KINDS = {
  expense: 'مصروف', material_purchase: 'شراء خامات', supplier_payment: 'دفعة لمورد',
  partner_withdrawal: 'سحب شريك', worker_advance: 'سلفة عامل',
};
// Which sources each kind of voucher can be paid from.
export const KIND_SOURCES = {
  expense: ['cash', 'bank', 'cheque', 'partner', 'supplier_credit', 'client_offset'],
  material_purchase: ['cash', 'bank', 'cheque', 'partner', 'supplier_credit'],
  supplier_payment: ['cash', 'bank', 'cheque', 'partner'],
  partner_withdrawal: ['cash', 'bank', 'cheque'],
  worker_advance: ['cash', 'bank'],
};
// The party each kind of voucher is for.
export const KIND_PARTY = { material_purchase: 'supplier', supplier_payment: 'supplier', partner_withdrawal: 'partner', worker_advance: 'worker' };
// The workshop manager (expenses.record without treasury) records plain expenses only,
// paid from the cash box or on a supplier's account.
export const LIMITED_SOURCES = ['cash', 'supplier_credit'];

export const CHEQUE_STATUS = {
  in_portfolio: 'في الحافظة', deposited: 'متودع في البنك', collected: 'اتحصّل', endorsed: 'اتظهّر لمورد',
  bounced: 'مرتد', issued: 'لسه متصرفش', cleared: 'اتصرف', cancelled: 'ملغي',
};
export const OPEN_IN = ['in_portfolio', 'deposited'];
export const OPEN_OUT = ['issued'];
export const KIND_NAMES = { client: 'عميل', supplier: 'مورد', partner: 'شريك', worker: 'عامل' };

export const bad = (field, msg) => httpError(400, msg, { field });

// 'YYYY-MM-DD' that is a real day of the calendar (no 2026-02-30). Arabic digits accepted.
export const isRealDate = (v) => utilIsRealDate(v ?? ''); // src/util.js

export function realDate(v, field = 'date', label = 'التاريخ', { required = true } = {}) {
  if (v === undefined || v === null || String(v).trim() === '') {
    if (required) throw bad(field, `اكتب ${label}`);
    return null;
  }
  const d = isRealDate(v);
  if (!d) throw bad(field, `${label} غلط — لازم يكون يوم موجود في النتيجة`);
  return d;
}

export function isRealMonth(v) {
  const s = toAsciiDigits(v ?? '').trim();
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(s) ? s : null;
}

// A typed amount in pounds ("1,250.5", "١٢٥٠") → millimes > 0. Code that already holds
// millimes (the Excel import) passes them as `millimes` (an integer) instead.
export function amountIn(v, field = 'amount', label = 'المبلغ', millimes = undefined) {
  if (millimes !== undefined && millimes !== null) {
    if (!Number.isSafeInteger(millimes) || millimes <= 0) throw bad(field, `${label} لازم يكون أكبر من صفر`);
    return millimes;
  }
  if (v === undefined || v === null || String(v).trim() === '') throw bad(field, `اكتب ${label}`);
  const m = parseMoney(v);
  if (m === null || Number.isNaN(m)) throw bad(field, `${label} رقم غلط`);
  if (m <= 0) throw bad(field, `${label} لازم يكون أكبر من صفر`);
  return m;
}

export function partyOf(id, kinds, field = 'party_id', label = 'الطرف') {
  const n = Number(id);
  if (!id || !Number.isInteger(n)) throw bad(field, `اختار ${label}`);
  const p = getDb().prepare('SELECT * FROM parties WHERE id = ?').get(n);
  if (!p) throw bad(field, `${label} مش موجود`);
  const allowed = Array.isArray(kinds) ? kinds : kinds ? [kinds] : null;
  if (allowed && !allowed.includes(p.kind)) throw bad(field, `${label} لازم يكون ${allowed.map((k) => KIND_NAMES[k]).join(' أو ')}`);
  if (!p.active) throw bad(field, `${p.name} موقوف — شغّله الأول من صفحته`);
  return p;
}

export const text = (v, max = 300) => cleanText(v, max);

export function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// The Saturday that starts the week of a date (the Egyptian work week).
export function weekStart(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  const back = (d.getUTCDay() + 1) % 7; // Sat=6 → 0, Sun=0 → 1, ... Fri=5 → 6
  return addDays(iso, -back);
}

export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
