// Shared bits of the pricing screens: words for sources and states, how an item was counted
// («10 قطعة × 4 تنية»), and money <-> the pounds typed in a rate cell.
import { num, money, fmtDate } from '../ui.js';

export const SOURCE_NAMES = {
  last_same: 'آخر سعر لنفس الخامة والسمك',
  last_section: 'آخر سعر للعميل في القسم',
  general: 'السعر العام',
  manual: 'اتكتب بالإيد',
  import: 'من الإكسيل',
};
export const SOURCE_SHORT = { last_same: 'آخر سعر', last_section: 'سعر العميل', general: 'عام', manual: 'يدوي', import: 'إكسيل' };

const BAND_WORDS = { '<3': 'أقل من 3 مم', '>=3': '3 مم وأكتر', '': '' };
export const bandWords = (b) => BAND_WORDS[b] ?? '';

// Millimes → the text a person types in a rate cell (no thousands separator, up to 3 decimals).
export const ratePounds = (m) => (m === null || m === undefined ? null : Number((m / 1000).toFixed(3)));

export function materialText(i) {
  const t = i.thickness ? `${num(i.thickness)}مم` : '';
  return [i.material_name, t].filter(Boolean).join(' ');
}

// How the quantity came out, in the paper's words.
export function calcText(i) {
  const q = (v) => num(v);
  switch (i.billing) {
    case 'bend': return `${q(i.pieces)} قطعة × ${q(i.per_piece)} تنية`;
    case 'cut': return `${q(i.pieces)} قطعة × ${q(i.per_piece)} قصة`;
    case 'louver': return `${q(i.pieces)} قطعة × ${q(i.per_piece)} لوفر`;
    case 'minute': return `${q(i.sheets)} لوح × ${q(i.minutes_per_sheet)} د + ${q(i.sheets)}${i.single_piece ? ' · قطعة واحدة' : ''}`;
    case 'kg': return i.length_cm && i.width_cm ? `${q(i.length_cm)}×${q(i.width_cm)} سم × ${q(i.sheets || 1)}` : 'ناقص الطول أو العرض';
    case 'piece': return `${q(i.pieces ?? i.sheets)} قطعة`;
    case 'lump': return 'مبلغ مقطوع';
    default: return '';
  }
}

export const qtyText = (i) => (i.qty === null || i.qty === undefined ? '' : `${num(i.qty)} ${i.unit_name}`);

export function needsText(i) {
  if (!i.needs?.length) return '';
  if (i.needs.includes('dims')) return 'ناقص الطول أو العرض أو السمك';
  if (i.needs.includes('qty')) return 'ناقص الكمية';
  return 'محتاج سعر';
}

export const dayName = (iso) => {
  try { return new Date(`${iso}T12:00:00`).toLocaleDateString('ar-EG', { weekday: 'long' }); } catch { return ''; }
};
export const dayTitle = (iso) => `${dayName(iso)} ${fmtDate(iso)}`.trim();
export { money };
