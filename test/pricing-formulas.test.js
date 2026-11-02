// التسعير formulas (the Excel «قالب تصنيع»): press bends and bands, fixed price per piece,
// shear cuts, laser / punch minutes (+1 minute per sheet) and the single-piece minimum,
// louvers, factory material weight × rate per kg, per piece / lump, rounding half up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../src/pricing/formulas.js';

const item = (x) => F.computeItem(x);

test('press: bends = pieces × bends per piece; amount = bends × rate', () => {
  const r = item({ section: 'press', pieces: 10, per_piece: 4, rate: 2500 }); // 2.500 ج per bend
  assert.equal(r.qty, 40);
  assert.equal(r.unit, 'bend');
  assert.equal(r.amount, 100000);
  // fractional rate × qty rounds half up at the item only
  assert.equal(item({ section: 'press', pieces: 3, per_piece: 1, rate: 1 }).amount, 3); // 3 × 1 millime
  assert.equal(item({ section: 'press', pieces: 1.5, per_piece: 1, rate: 1 }).amount, 2); // 1.5 millimes → 2
  assert.equal(item({ section: 'press', pieces: 2.5, per_piece: 1, rate: 3 }).amount, 8); // 7.5 → 8
});

test('press bands: < 3 mm and ≥ 3 mm; blank thickness is thin', () => {
  assert.equal(F.bandOf(2.99), '<3');
  assert.equal(F.bandOf(3), '>=3');
  assert.equal(F.bandOf(6), '>=3');
  assert.equal(F.bandOf(null), '<3');
  assert.equal(F.bandOf(''), '<3');
  assert.equal(F.sectionBand('press', 4), '>=3');
  assert.equal(F.sectionBand('laser', 4), '');
});

test('press fixed price per piece («سعر محدد؟ نعم»): amount = pieces × fixed rate', () => {
  const r = item({ section: 'press', billing: 'piece', pieces: 12, per_piece: 6, rate: 7500 });
  assert.equal(r.qty, 12);
  assert.equal(r.unit, 'piece');
  assert.equal(r.amount, 90000);
});

test('shear: cuts = pieces × cuts per piece', () => {
  const r = item({ section: 'shear', pieces: 7, per_piece: 3, rate: 1250 });
  assert.equal(r.qty, 21);
  assert.equal(r.unit, 'cut');
  assert.equal(r.amount, 26250);
});

test('laser: total minutes = sheets × minutes + sheets (one extra minute per sheet)', () => {
  const r = item({ section: 'laser', sheets: 3, minutes_per_sheet: 10, rate: 20000 });
  assert.equal(r.qty, 33); // 3 × 10 + 3
  assert.equal(r.amount, 660000);
  // decimals without float noise: 2.5 × 3.3 + 2.5 = 10.75
  assert.equal(item({ section: 'laser', sheets: 2.5, minutes_per_sheet: 3.3, rate: 1000 }).qty, 10.75);
  // one sheet, zero minutes still costs the extra minute
  assert.equal(item({ section: 'laser', sheets: 1, minutes_per_sheet: 0, rate: 1000 }).qty, 1);
});

test('laser / punch single piece: amount = max(amount, min charge); only when single piece', () => {
  const small = { section: 'laser', sheets: 1, minutes_per_sheet: 2, rate: 20000, min_charge: 150000 }; // 3 min × 20 = 60
  assert.equal(item(small).amount, 60000);
  assert.equal(item(small).min_applied, false);
  const single = item({ ...small, single_piece: true });
  assert.equal(single.amount, 150000);
  assert.equal(single.min_applied, true);
  // above the minimum: the real amount
  assert.equal(item({ ...small, single_piece: true, minutes_per_sheet: 9 }).amount, 200000); // 10 × 20
  // punch uses the same rule with its own min
  assert.equal(item({ section: 'punch', sheets: 1, minutes_per_sheet: 1, rate: 10000, single_piece: 1, min_charge: 100000 }).amount, 100000);
  // no min configured: plain amount
  assert.equal(item({ ...small, single_piece: true, min_charge: null }).amount, 60000);
  // the minimum is for minute billing only
  assert.equal(item({ ...small, billing: 'piece', pieces: 1, single_piece: true, rate: 5000 }).amount, 5000);
});

test('louver: total = pieces × louvers per piece', () => {
  const r = item({ section: 'louver', pieces: 4, per_piece: 25, rate: 500 });
  assert.equal(r.qty, 100);
  assert.equal(r.unit, 'louver');
  assert.equal(r.amount, 50000);
});

test('material: weight = thickness/10 × length × width × sheets × density / 1000; amount = weight × rate per kg', () => {
  // 2 mm × 100 cm × 200 cm × 1 sheet × 7.85 = 31.4 kg
  const w = F.materialWeight({ thickness: 2, length_cm: 100, width_cm: 200, sheets: 1, density: 7.85 });
  assert.equal(w, 31.4);
  const r = item({ section: 'material', thickness: 2, length_cm: 100, width_cm: 200, sheets: 3, density: 7.85, rate: 45000 });
  assert.equal(r.weight_kg, 94.2);
  assert.equal(r.qty, 94.2);
  assert.equal(r.unit, 'kg');
  assert.equal(r.amount, 4239000); // 94.2 × 45.000
  // blank sheets count as one (Excel IF(AW="",1,AW)); unknown density = 7.85
  assert.equal(F.materialWeight({ thickness: 2, length_cm: 100, width_cm: 200 }), 31.4);
  // aluminium density
  assert.equal(F.materialWeight({ thickness: 1, length_cm: 100, width_cm: 100, sheets: 1, density: 2.7 }), 2.7);
  // missing a dimension: no weight, the item asks for it
  const m = item({ section: 'material', thickness: 2, length_cm: 100, rate: 45000 });
  assert.equal(m.qty, null);
  assert.equal(m.amount, null);
  assert.deepEqual(m.missing, ['width_cm']);
});

test('material billed per piece or as a lump needs no dimensions', () => {
  assert.equal(item({ section: 'material', billing: 'lump', rate: 250000 }).amount, 250000);
  assert.deepEqual(item({ section: 'material', billing: 'lump', rate: 250000 }).missing, []);
  assert.equal(item({ section: 'material', billing: 'piece', pieces: 4, rate: 10000 }).amount, 40000);
});

test('per piece and lump alternatives on any section', () => {
  assert.equal(item({ section: 'shear', billing: 'piece', pieces: 9, per_piece: 2, rate: 1000 }).amount, 9000);
  const lump = item({ section: 'laser', billing: 'lump', rate: 333333 });
  assert.equal(lump.qty, 1);
  assert.equal(lump.amount, 333333);
  // per piece on a laser line with only sheets: the sheets are the pieces
  assert.equal(item({ section: 'laser', billing: 'piece', sheets: 5, rate: 2000 }).amount, 10000);
});

test('missing quantities or rate give no amount; a zero rate is a real price', () => {
  assert.equal(item({ section: 'press', pieces: 10, rate: 1000 }).amount, null);
  assert.deepEqual(item({ section: 'press', pieces: 10, rate: 1000 }).missing, ['per_piece']);
  assert.equal(item({ section: 'press', pieces: 10, per_piece: 2, rate: null }).amount, null);
  assert.equal(item({ section: 'press', pieces: 10, per_piece: 2 }).qty, 20);
  assert.equal(item({ section: 'press', pieces: 10, per_piece: 2, rate: 0 }).amount, 0);
  assert.deepEqual(item({ section: 'laser', sheets: 2, rate: 1 }).missing, ['minutes_per_sheet']);
  assert.throws(() => F.itemAmount({ qty: 1, rate: 1.5, billing: 'bend' }), /integer millimes/);
  assert.throws(() => F.itemAmount({ qty: 1, rate: -1, billing: 'bend' }), /integer millimes/);
});

test('thickness parsed from the material text: Arabic digits and decimals', () => {
  assert.equal(F.parseThickness('2مم اسود'), 2);
  assert.equal(F.parseThickness('١٫٥م اسود'), 1.5);
  assert.equal(F.parseThickness('1.25 مم مجلفن'), 1.25);
  assert.equal(F.parseThickness('1,5مم'), 1.5);
  assert.equal(F.parseThickness('ستانلس 3مم'), 3);
  assert.equal(F.parseThickness('4'), 4);
  assert.equal(F.parseThickness('اسود'), null);
  assert.equal(F.parseThickness(''), null);
  assert.equal(F.parseThickness(null), null);
});

test('material groups for the weight columns (مجلفن / أسود / ستانلس / ألومنيوم)', () => {
  assert.equal(F.materialGroup('مجلفن'), 'galvanized');
  assert.equal(F.materialGroup('أسود'), 'black');
  assert.equal(F.materialGroup('اسود'), 'black');
  assert.equal(F.materialGroup('ستانلس'), 'stainless');
  assert.equal(F.materialGroup('ألومنيوم'), 'aluminium');
  assert.equal(F.materialGroup('المونيا'), 'aluminium');
  assert.equal(F.materialGroup(''), 'black');
});

test('every section has its natural billing first, then per piece and lump', () => {
  for (const [s, list] of Object.entries(F.BILLINGS)) {
    assert.equal(list[0], F.SECTION_BILLING[s]);
    assert.deepEqual(list.slice(1), ['piece', 'lump']);
    for (const b of list) assert.ok(F.UNIT_NAMES[b] && F.BILLING_NAMES[b]);
  }
});
