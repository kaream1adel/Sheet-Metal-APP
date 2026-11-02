// Money is stored as integer millimes (مليم): 1 EGP = 1000. Never floats in the database.
// The only rounding in the whole app is mulRound(): qty × rate at the item level.
// Money never reaches a user without money.view — stripMoney() removes it on the server.
import { can } from './permissions.js';
import { toAsciiDigits } from './util.js';

export const MILLIMES = 1000;

// "1,234.50" / "١٬٢٣٤٫٥" / "1234.5 ج" / 1234.5 → 1234500. Blank → null. Invalid → NaN.
// Up to 3 decimals (millimes); more is refused rather than silently rounded.
export function parseMoney(v) {
  if (v === null || v === undefined) return null;
  let s;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return NaN;
    s = String(v);
    if (/e/i.test(s)) return NaN;
  } else {
    s = toAsciiDigits(v).replace(/\s+/g, '').replace(/(جنيه|جنية|ج\.م|ج)$/u, '');
    if (s === '') return null;
    if (/^-?\d+,\d{1,3}$/.test(s) && !/^-?\d{1,3},\d{3}$/.test(s)) s = s.replace(',', '.'); // "2,5" = 2.5
    s = s.replace(/,/g, '');
  }
  const m = s.match(/^(-?)(\d+)(?:\.(\d{1,3}))?$/) || s.match(/^(-?)()\.(\d{1,3})$/);
  if (!m) return NaN;
  const whole = Number(m[2] || 0);
  const frac = Number(((m[3] || '') + '000').slice(0, 3));
  const out = whole * MILLIMES + frac;
  if (!Number.isSafeInteger(out)) return NaN;
  return m[1] === '-' && out !== 0 ? -out : out;
}

// Millimes → "1,234.50" (2 decimals, thousands separators, Western digits). The third
// decimal (one millime) is rounded half-up for display only.
export function formatMoney(m, { sign = true } = {}) {
  if (m === null || m === undefined || Number.isNaN(m)) return '';
  const neg = m < 0;
  const piastres = Math.floor((Math.abs(m) + 5) / 10); // half-up on the absolute value
  const s = `${Math.floor(piastres / 100).toLocaleString('en-US')}.${String(piastres % 100).padStart(2, '0')}`;
  return neg && sign ? `-${s}` : s;
}

// Exact decimal of a number as [BigInt digits, scale]: 1.25 → [125n, 2].
function decimal(x) {
  if (typeof x === 'bigint') return [x, 0];
  const n = Number(x);
  if (!Number.isFinite(n)) throw new Error(`not a number: ${x}`);
  // Up to 6 decimals is far beyond any quantity on the paper; strip float noise.
  const s = n.toFixed(6).replace(/\.?0+$/, '');
  const [w, f = ''] = s.replace('-', '').split('.');
  const digits = BigInt(w + f) * (s.startsWith('-') ? -1n : 1n);
  return [digits, f.length];
}

// Round half up (away from zero for negatives): q = a / 10^scale.
function roundScaled(v, scale) {
  if (scale === 0) return v;
  const d = 10n ** BigInt(scale);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const r = (a + d / 2n) / d;
  return neg ? -r : r;
}

// amount = round-half-up(qty × rate). rate is millimes per unit (integer), qty may be fractional.
export function mulRound(qty, rate) {
  const [q, qs] = decimal(qty);
  const [r, rs] = decimal(rate);
  return Number(roundScaled(q * r, qs + rs));
}

// round-half-up of any decimal to an integer number of millimes (e.g. a computed weight × rate).
export const roundMillimes = (x) => Number(roundScaled(...decimal(x)));

// Balance wording, never a bare sign. balance = debit − credit on the party's account:
// positive = he owes us (لنا عنده), negative = we owe him (له عندنا).
export function balanceWords(balance) {
  const b = Number(balance) || 0;
  if (b === 0) return { label: 'خالص', amount: 0, text: 'خالص', side: 'settled' };
  const label = b > 0 ? 'لنا عنده' : 'له عندنا';
  return { label, amount: Math.abs(b), text: `${label} ${formatMoney(Math.abs(b))}`, side: b > 0 ? 'owes_us' : 'we_owe' };
}

// ---------- keeping money away from staff ----------
// A key is money when it is one of these, or ends with one of the suffixes. Every module
// MUST name its money fields this way (amount, rate, unit_rate, line_total, ...).
const MONEY_KEYS = new Set(['amount', 'rate', 'balance', 'debit', 'credit', 'discount', 'total', 'totals',
  'min_charge', 'credit_limit', 'opening_balance', 'closing_balance', 'opening', 'closing', 'price', 'cost',
  'expected', 'counted', 'difference', 'balance_text', 'balance_words', 'opening_text', 'closing_text', 'wording',
  'net', 'paid', 'due',
  'suggested_rate', 'cash', 'bank', 'receivable', 'payable']);
const MONEY_SUFFIX = /(_amount|_rate|_price|_cost|_balance|_total|_millimes|_money|_debit|_credit)$/;

export const isMoneyKey = (k) => MONEY_KEYS.has(k) || MONEY_SUFFIX.test(k);

function strip(v) {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const out = {};
    for (const [k, x] of Object.entries(v)) if (!isMoneyKey(k)) out[k] = strip(x);
    return out;
  }
  return v;
}

// Removes every money field (deep) unless the user has money.view.
export function stripMoney(user, data) {
  return can(user, 'money.view') ? data : strip(data);
}
