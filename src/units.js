// Billing units: how a confirmed line is turned into a quantity to price.
// The paper records facts; the admin chooses the unit at pricing time.

const n = (v) => (v === null || v === undefined ? 0 : Number(v));

export const UNITS = {
  bend:   { label: 'تنية',  machines: ['press'], qty: (l) => n(l.pieces) * n(l.ops_per_piece) },
  cut:    { label: 'قصة',   machines: ['shear'], qty: (l) => n(l.pieces) * n(l.ops_per_piece) },
  hit:    { label: 'ضربة',  machines: ['punch'], qty: (l) => n(l.pieces) * n(l.hits_per_piece) },
  louver: { label: 'لوفر',  machines: ['punch'], qty: (l) => n(l.pieces) * n(l.louvers_per_piece) },
  minute: { label: 'دقيقة', machines: ['laser', 'punch'],
    qty: (l, code) => (code === 'laser' ? n(l.sheets) * n(l.minutes_per_sheet) : n(l.minutes)) },
  piece:  { label: 'قطعة',  machines: ['press', 'shear', 'laser', 'punch'], qty: (l) => n(l.pieces) },
  sheet:  { label: 'لوح',   machines: ['laser', 'punch'], qty: (l) => n(l.sheets) },
  meter:  { label: 'متر',   machines: ['press', 'shear', 'laser', 'punch'], manual: true },
  fixed:  { label: 'مبلغ ثابت', machines: ['press', 'shear', 'laser', 'punch'], qty: () => 1 },
};

export const DEFAULT_UNIT = { press: 'bend', shear: 'cut', laser: 'minute', punch: 'hit' };

export const unitsFor = (code) => Object.entries(UNITS).filter(([, u]) => u.machines.includes(code)).map(([k]) => k);

// Quantity for a unit, or null when the admin must type it (meter).
export function lineQty(line, machineCode, unit) {
  const u = UNITS[unit];
  if (!u || !u.machines.includes(machineCode)) return undefined;
  if (u.manual) return null;
  return Math.round(u.qty(line, machineCode) * 1000) / 1000;
}

// Amount in piastres: qty × rate (rate in piastres), to the nearest piastre.
export const amountOf = (qty, rate) => Math.round(qty * rate);

// Units a line gets by default: its machine's main unit, plus louvers on a punch line that has them.
export function defaultUnits(line, machineCode, pref) {
  const units = [pref && UNITS[pref]?.machines.includes(machineCode) ? pref : DEFAULT_UNIT[machineCode]];
  if (machineCode === 'punch' && n(line.louvers_per_piece) > 0 && !units.includes('louver')) units.push('louver');
  return units;
}
