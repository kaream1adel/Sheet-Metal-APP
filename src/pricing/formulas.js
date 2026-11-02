// التسعير: the Excel «قالب تصنيع» formulas, as pure functions (no database).
//
//   press     bends   = pieces × bends_per_piece          amount = bends × rate
//             fixed   («سعر محدد؟ نعم»): amount = pieces × fixed_rate          (billing 'piece')
//             the rate is suggested from the < 3 mm or ≥ 3 mm history (bandOf(thickness))
//   shear     cuts    = pieces × cuts_per_piece           amount = cuts × rate
//   laser     minutes = sheets × minutes_per_sheet + sheets   (one extra minute per sheet)
//   punch     amount  = minutes × rate; «قطعة واحدة؟ نعم» → amount = max(amount, min_charge)
//   louver    total   = pieces × louvers_per_piece        amount = total × rate
//   material  weight  = thickness_mm / 10 × length_cm × width_cm × sheets × density / 1000
//             amount  = weight × rate_per_kg                (Excel: blank sheets count as 1)
//   any line may be billed per piece (qty = pieces) or as a lump amount (qty = 1, amount = rate).
//
// Money is integer millimes; the only rounding is mulRound(qty, rate) (round half up).
import { mulRound } from '../money.js';
import { toAsciiDigits } from '../util.js';

export const SECTION_BILLING = {
  press: 'bend', shear: 'cut', laser: 'minute', punch: 'minute', louver: 'louver', material: 'kg',
};
// The ways a section's item may be billed: its natural unit, per piece, or a lump amount.
export const BILLINGS = {
  press: ['bend', 'piece', 'lump'],
  shear: ['cut', 'piece', 'lump'],
  laser: ['minute', 'piece', 'lump'],
  punch: ['minute', 'piece', 'lump'],
  louver: ['louver', 'piece', 'lump'],
  material: ['kg', 'piece', 'lump'],
};
export const UNIT_NAMES = {
  bend: 'تنية', cut: 'قصة', minute: 'دقيقة', louver: 'لوفر', kg: 'كجم', piece: 'قطعة', lump: 'مقطوعية',
};
export const BILLING_NAMES = {
  bend: 'بالتنية', cut: 'بالقصة', minute: 'بالدقيقة', louver: 'باللوفر', kg: 'بالكيلو', piece: 'سعر محدد للقطعة', lump: 'مبلغ مقطوع',
};

// The Excel default density when the material is unknown (black steel).
export const DEFAULT_DENSITY = 7.85;

// Press rates differ for thin and thick sheet: < 3 mm and ≥ 3 mm. A blank thickness counts as
// thin (Excel: N(G7) >= 3 is false for a blank).
export function bandOf(thickness) {
  const t = Number(thickness);
  return Number.isFinite(t) && t >= 3 ? '>=3' : '<3';
}
// The general-price band of a section (only the press has bands).
export const sectionBand = (section, thickness) => (section === 'press' ? bandOf(thickness) : '');

// "2مم اسود" → 2 · "١٫٥م اسود" → 1.5 · "1,5 مم" → 1.5 · "اسود 3مم" → 3 · "اسود" → null.
export function parseThickness(text) {
  const s = toAsciiDigits(text).replace(/\s+/g, ' ');
  const m = s.match(/(\d+(?:[.,]\d+)?)\s*(?:مم|م|mm)/i) || s.match(/^\s*(\d+(?:[.,]\d+)?)\s*$/);
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  return Number.isFinite(n) && n > 0 && n < 100 ? n : null;
}

const has = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
const n = (v) => Number(v);
// Products of paper numbers (2.5 × 3.3) carry float noise: keep 6 decimals, like mulRound.
const clean = (x) => Number(Number(x).toFixed(6));

// Weight of factory material in kg (null when a dimension is missing).
export function materialWeight({ thickness, length_cm, width_cm, sheets, density }) {
  if (!has(thickness) || !has(length_cm) || !has(width_cm)) return null;
  const count = has(sheets) && n(sheets) > 0 ? n(sheets) : 1;
  const d = has(density) && n(density) > 0 ? n(density) : DEFAULT_DENSITY;
  return clean((n(thickness) / 10) * n(length_cm) * n(width_cm) * count * d / 1000);
}

// The quantity an item is billed on: { qty, unit, weight_kg?, missing: [field…] }.
// item: { section, billing, pieces, per_piece, sheets, minutes_per_sheet, thickness, length_cm, width_cm, density }
export function itemQuantity(item) {
  const billing = item.billing || SECTION_BILLING[item.section];
  const missing = [];
  const need = (...keys) => { for (const k of keys) if (!has(item[k])) missing.push(k); return !missing.length; };
  let qty = null;
  let weight = null;
  if (item.section === 'material') {
    weight = materialWeight(item);
    if (weight === null) { need('thickness', 'length_cm', 'width_cm'); }
  }
  switch (billing) {
    case 'bend':
    case 'cut':
      if (need('pieces', 'per_piece')) qty = clean(n(item.pieces) * n(item.per_piece));
      break;
    case 'louver':
      if (need('pieces', 'per_piece')) qty = clean(n(item.pieces) * n(item.per_piece));
      break;
    case 'minute':
      // the Excel: total minutes = sheets × minutes per sheet + sheets (one extra minute per sheet)
      if (need('sheets', 'minutes_per_sheet')) qty = clean(n(item.sheets) * n(item.minutes_per_sheet) + n(item.sheets));
      break;
    case 'kg':
      qty = weight;
      break;
    case 'piece':
      // per piece: the pieces; a laser / punch line may only have sheets
      if (has(item.pieces) && n(item.pieces) > 0) qty = n(item.pieces);
      else if (has(item.sheets) && n(item.sheets) > 0) qty = n(item.sheets);
      else missing.push('pieces');
      break;
    case 'lump':
      qty = 1;
      break;
    default:
      throw new Error(`unknown billing ${billing}`);
  }
  // a lump or per-piece material item does not need the dimensions
  const out = { qty, unit: billing, weight_kg: weight, missing: billing === 'lump' || billing === 'piece' ? missing.filter((k) => k === 'pieces') : missing };
  return out;
}

// amount in millimes: round-half-up(qty × rate), with the laser / punch minimum for a single piece.
// rate: millimes per unit (integer ≥ 0). Returns null when qty or rate is missing.
export function itemAmount({ qty, rate, billing, single_piece = false, min_charge = null }) {
  if (rate === null || rate === undefined || qty === null || qty === undefined) return null;
  if (!Number.isSafeInteger(rate) || rate < 0) throw new Error(`rate must be integer millimes, got ${rate}`);
  if (billing === 'lump') return rate;
  const base = mulRound(qty, rate);
  if (billing === 'minute' && single_piece && Number.isSafeInteger(min_charge) && min_charge > 0) {
    return Math.max(base, min_charge);
  }
  return base;
}

// Both at once: { qty, unit, weight_kg, missing, amount, min_applied }.
export function computeItem(item) {
  const q = itemQuantity(item);
  const billing = item.billing || SECTION_BILLING[item.section];
  const amount = q.missing.length ? null : itemAmount({ qty: q.qty, rate: item.rate ?? null, billing, single_piece: !!item.single_piece, min_charge: item.min_charge ?? null });
  const base = amount !== null && billing === 'minute' && q.qty !== null ? mulRound(q.qty, item.rate) : amount;
  return { ...q, billing, amount, min_applied: amount !== null && base !== null && amount > base };
}

// Material group of a material (Excel BK): galvanized / black / stainless / aluminium.
export function materialGroup(grp) {
  const g = String(grp || '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/\s+/g, '');
  if (/مجلفن|جلفن/.test(g)) return 'galvanized';
  if (/ستانل|استانل/.test(g)) return 'stainless';
  if (/الومن|المون|المنيوم|الومينيوم/.test(g)) return 'aluminium';
  return 'black'; // Excel: unknown → «اسود»
}
