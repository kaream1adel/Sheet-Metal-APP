// The Excel import's reading rules on a synthetic workbook (invented names): both client-sheet
// layouts found from their headers, cached formula results, E1-consistent amounts, the
// statement ↔ work-sheet link, the log's sync keys, dates (text day-first, swapped day/month,
// inherited, conflicts), partner-row classes, duplicates, categories and cost centres.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workbookBuffer, EXPECT } from './import-fixture.js';
import { loadWorkbook } from '../src/import/workbook.js';
import { readWorkbook, bareName, rateMillimes, toMillimes } from '../src/import/parse.js';
import { buildPlan, categoryFor, mentionedClient, similarNames } from '../src/import/plan.js';
import { readDateCell, resolveColumn, dateInText } from '../src/import/dates.js';

const CATS = [
  [1, 'مرتبات وأجور', ['مرتب']], [3, 'كهرباء ومياه', ['كهرباء']], [5, 'خامات ومستلزمات', ['خامات']],
  [6, 'أعمال خارجية (دهان ولحام)', ['دهان', 'لحام']], [7, 'نقل', ['نقل']], [8, 'ضيافة', ['شاي']], [11, 'متنوعة', []],
].map(([id, name, keywords]) => ({ id, name, keywords, active: 1 }));

let model;
const getModel = async () => {
  if (!model) model = readWorkbook((await loadWorkbook(await workbookBuffer())).wb);
  return model;
};
const plan = async (decisions = {}) => buildPlan(await getModel(), decisions, { lookups: { categories: CATS }, today: '2026-01-15' });

test('money helpers: pounds → millimes exactly, rates must be whole millimes', () => {
  assert.equal(toMillimes(1406.8), 1406800);
  assert.equal(toMillimes(12.34567), 12346); // half up past the millime
  assert.equal(toMillimes(1000.0004), 1000000);
  assert.equal(rateMillimes(0.5), 500);
  assert.equal(rateMillimes(13.285), 13285);
  assert.equal(rateMillimes(1.2345), null);
  assert.equal(bareName('م/ سامي'), 'سامي');
  assert.equal(bareName('عميل النور'), 'النور');
  assert.equal(bareName('عميل خارجي'), 'عميل خارجي');
});

test('dates: text is day-first, a stored date with day ≤ 12 is read the way that fits its column, empty rows inherit', () => {
  assert.deepEqual(readDateCell('27-8-2025').candidates, ['2025-08-27']);
  assert.deepEqual(readDateCell('21/9/2025').candidates, ['2025-09-21']);
  assert.equal(readDateCell('31-2-2025').invalid, true);
  const stored = readDateCell(new Date(Date.UTC(2025, 1, 9)));
  assert.deepEqual(stored.candidates, ['2025-02-09', '2025-09-02']);
  assert.equal(dateInText('شيك بتاريخ 9/10/2025'), '2025-10-09');
  const cells = [
    { ref: 'a1', value: null }, { ref: 'a2', value: '27-8-2025' }, { ref: 'a3', value: new Date(Date.UTC(2025, 1, 9)) },
    { ref: 'a4', value: null }, { ref: 'a5', value: 'كلام' },
  ];
  const r = resolveColumn(cells, { today: '2026-01-15', fallback: '2025-12-31' });
  assert.deepEqual([...r.values()].map((x) => [x.date, x.kind]).sort(), [
    ['2025-08-27', 'inherited_first'], ['2025-08-27', 'typed'], ['2025-09-02', 'inherited'], ['2025-09-02', 'invalid'], ['2025-09-02', 'swapped'],
  ].sort());
  // the admin's date wins and the rows below follow it
  const o = resolveColumn(cells, { today: '2026-01-15', overrides: { a3: '2025-08-30' } });
  assert.equal(o.get('a3').date, '2025-08-30');
  assert.equal(o.get('a4').date, '2025-08-30');
  // a stored date in the future with day ≤ 12 is the swapped one
  const f = resolveColumn([{ ref: 'b', value: new Date(Date.UTC(2025, 11, 10)) }], { today: '2025-11-02' });
  assert.equal(f.get('b').date, '2025-10-12');
  assert.equal(f.get('b').kind, 'swapped');
});

test('work sheets: both layouts from their headers, E1-consistent amounts, the template is never imported', async () => {
  const m = await getModel();
  assert.deepEqual(m.work.map((w) => w.name).sort(), ['النجمة', 'ورشة النسيم', 'عميل خارجي'].sort());
  assert.deepEqual(m.templates.map((t) => t.name), ['قالب تصنيع']);
  const a = m.work.find((w) => w.name === 'ورشة النسيم');
  const b = m.work.find((w) => w.name === 'النجمة');
  assert.equal(a.layout.material, 'AV');
  assert.equal(b.layout.material, 'AW');
  for (const w of m.work) {
    const sum = w.items.reduce((s, i) => s + (i.excel_amount || 0), 0);
    assert.equal(sum, toMillimes(EXPECT.e1[w.name]), w.name);
  }
  assert.equal(a.rates.press_thin, 2);
  assert.equal(a.rates.shear, 0.5);
  assert.equal(a.rates.material.black, 48);
  const thick = a.items.find((i) => i.section === 'press' && i.row === 9);
  assert.equal(thick.thickness, 4);
  assert.equal(thick.rate, 3000); // ≥ 3 mm band
  const single = a.items.find((i) => i.section === 'laser' && i.row === 8);
  assert.equal(single.single_piece, 1);
  assert.equal(single.excel_amount, 150000);
  assert.equal(single.formula_amount, 150000); // the minimum for one piece
  const typed = a.items.find((i) => i.section === 'material' && i.row === 11);
  assert.equal(typed.excel_amount, 500000);
  assert.equal(typed.formula_amount, 376800);
  assert.deepEqual(b.keys.sort(), ['OO_1_2_1700000000001_1', 'OO_2_2_1700000000002_2']);
  assert.ok(a.densities.some((d) => d.name === 'المونيا' && d.density === 2.7));
});

test('statements: row 2 linked by C2 is skipped (not its payment), a literal C2 is a debit, «تم تحصيل شيك» is a cheque', async () => {
  const m = await getModel();
  const n = m.statements.find((s) => s.name === 'كشف ورشة النسيم');
  assert.equal(n.link, 'ورشة النسيم');
  assert.equal(n.linkFromFormula, true);
  assert.deepEqual(n.rows.map((r) => [r.kind, r.amount, r.cheque]), [['credit', 1000000, false], ['credit', 300000, true], ['debit', 200000, false], ['discount', 6800, false]]);
  const s = m.statements.find((x) => x.name === 'كشف مصنع النجمة');
  assert.deepEqual(s.rows.map((r) => [r.row, r.kind, r.amount, r.desc]), [[2, 'credit', 60000, ''], [3, 'credit', 20000, 'باقي']]);
  const f = m.statements.find((x) => x.name === 'كشف تجارة الفجر');
  assert.equal(f.link, null);
  assert.deepEqual(f.rows.map((r) => [r.row, r.kind, r.amount]), [[2, 'debit', 500000], [3, 'credit', 100000]]);
});

test('plan: names merged through the links, with the summary name; the log row that never reached a sheet', async () => {
  const p = await plan();
  const star = p.clients.find((c) => c.spellings.includes('النجمة'));
  assert.equal(star.name, 'مصنع النجمة');
  assert.deepEqual(star.spellings.sort(), ['النجمة', 'م/ النجمة', 'مصنع النجمة'].sort());
  assert.ok(star.reasons.some((r) => /C2/.test(r)));
  assert.equal(p.clients.find((c) => c.name === 'عميل خارجي').walk_in, 1);
  // the admin may pick another spelling
  const p2 = await plan({ names: { [star.id]: 'النجمة' } });
  assert.equal(p2.clients.find((c) => c.id === star.id).name, 'النجمة');
  assert.deepEqual(p2.clients.find((c) => c.id === star.id).aliases.sort(), ['م/ النجمة', 'مصنع النجمة'].sort());
  // synced log rows are not imported twice; the unsynced one is history; no client → left out
  assert.equal(p.logLines.length, 1);
  assert.equal(p.logLines[0].client, star.id);
  assert.equal(p.logLines[0].section, 'laser');
  assert.ok(p.preview.skipped.some((s) => /من غير اسم عميل/.test(s.reason)));
  // rows without a rate are settled in Excel (no money), the typed-over amount is a lump
  assert.ok(p.work.some((w) => w.section === 'punch' && w.status === 'settled'));
  const lump = p.work.find((w) => w.lump);
  assert.equal(lump.amount, 500000);
  assert.ok(p.preview.formula.some((f) => f.ref === lump.ref && f.formula_amount === 376800));
  // row-4 rates → client rates (the suggested-rate source)
  assert.ok(p.clientRates.some((r) => r.section === 'shear' && r.rate === 500));
  assert.ok(p.clientRates.some((r) => r.section === 'press' && r.band === '>=3' && r.rate === 3000));
});

test('plan: dates — swapped, first empty flagged with its followers, partner date from the description (conflict shown)', async () => {
  const p = await plan();
  const swapped = p.preview.dates.find((d) => d.ref === 'ورشة النسيم!A8');
  assert.equal(swapped.kind, 'swapped');
  assert.equal(swapped.date, '2025-09-02');
  const exp = p.preview.dates.find((d) => d.ref === 'المصروفات اليومية!A4');
  assert.equal(exp.kind, 'inherited_first');
  assert.equal(exp.date, '2025-10-15');
  assert.equal(exp.followers, 2);
  assert.ok(p.preview.dates.some((d) => d.ref === 'شريك تجريبي!L4' && d.kind === 'conflict' && d.date === '2025-10-09'));
  // overriding the first row moves the rows that inherit it
  const p2 = await plan({ dates: { 'المصروفات اليومية!A4': '2025-10-01' } });
  assert.deepEqual(p2.expenses.slice(0, 3).map((e) => e.date), ['2025-10-01', '2025-10-01', '2025-10-01']);
});

test('plan: partner rows classified, the partner cheque matched once with «الشيكات», the other cheque is an expense', async () => {
  const p = await plan();
  const cls = p.partnerOps.map((o) => [o.desc, o.class, o.account]);
  assert.deepEqual(cls, [
    ['تغذية الحساب', 'deposit', 'bank'], ['كهرباء', 'expense', 'bank'], ['شيك بتاريخ 9/10/2025', 'cheque', 'bank'],
    ['مبلغ مسحوب', 'withdrawal', 'cash'], ['إيداع بتاريخ 11/10/2025', 'deposit', 'bank'],
  ]);
  assert.equal(p.partnerOps[1].category.name, 'كهرباء ومياه');
  assert.equal(p.partnerOps[2].cheque.ref, 'الشيكات!E4');
  assert.equal(p.otherCheques.length, 1);
  assert.equal(p.otherCheques[0].category.name, 'كهرباء ومياه');
  // the admin changes a class and an account
  const p2 = await plan({ partners: { 'شريك تجريبي!B2': { class: 'deposit', account: 'cash' }, 'شريك تجريبي!C4': { class: 'withdrawal', account: 'bank' } } });
  assert.equal(p2.partnerOps[0].account, 'cash');
  assert.equal(p2.partnerOps[2].class, 'withdrawal');
  assert.equal(p2.otherCheques.length, 2); // the cheque is no longer the partner's
});

test('plan: expenses — categories by keyword, a client in the text is the cost centre, duplicates flagged, words as amounts left out', async () => {
  const p = await plan();
  assert.deepEqual(p.expenses.map((e) => [e.desc, e.category.name]), [
    ['شاي وقهوه', 'ضيافة'], ['نقل', 'نقل'], ['نقل', 'نقل'], ['لحام لورشة النسيم', 'أعمال خارجية (دهان ولحام)'],
  ]);
  const nasim = p.clients.find((c) => c.name === 'ورشة النسيم').id;
  assert.equal(p.expenses[3].cost_client, nasim);
  assert.deepEqual(p.preview.duplicates.map((d) => [d.ref, d.of]), [['المصروفات اليومية!C6', 'المصروفات اليومية!C5']]);
  assert.ok(p.preview.skipped.some((s) => s.ref === 'المصروفات اليومية!C7'));
  const p2 = await plan({ skip: { 'المصروفات اليومية!C6': true } });
  assert.equal(p2.expenses.length, 3);
  assert.equal(categoryFor('نقل للدهان', CATS).name, 'نقل');
  assert.equal(mentionedClient('استرتش لمصنع الأمل', [{ id: 'x', spellings: ['مصنع الأمل'] }]), 'x');
  assert.equal(similarNames('السلام', 'السلامين'), true);
  assert.equal(similarNames('نو', 'نور'), false);
});
