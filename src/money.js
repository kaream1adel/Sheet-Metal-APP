// Money is stored as integer piastres (1 EGP = 100) and never sent to anyone
// without the money.view permission — it is removed here, on the server.
import { can } from './permissions.js';
import { toAsciiDigits } from './util.js';

// "1,234.50" / "١٬٢٣٤٫٥٠" / 1234.5 → 123450. Blank → 0. Invalid → NaN.
export function toPiastres(v) {
  if (v === null || v === undefined || v === '') return 0;
  const s = typeof v === 'number' ? String(v) : toAsciiDigits(v).replace(/[,\s]/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return NaN;
  const [whole, frac = ''] = s.replace('-', '').split('.');
  const p = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  return s.startsWith('-') ? -p : p;
}

// Drop money fields from a record (or list of records) for users who may not see money.
export function stripMoney(user, data, fields) {
  if (can(user, 'money.view')) return data;
  const strip = (o) => {
    const copy = { ...o };
    for (const f of fields) delete copy[f];
    return copy;
  };
  return Array.isArray(data) ? data.map(strip) : strip(data);
}

export const CLIENT_MONEY_FIELDS = ['opening_balance', 'opening_date', 'balance'];
