// التسعير over HTTP: the queue, idempotent item generation (punch → punch + louver, factory
// material → material item), the suggested-rate order, rates and apply-to-similar, posting one
// balanced transaction per client per sheet, discounts in خصم, month lock, «تصحيح سعر»,
// manual client entries, الأسعار العامة, the client's شيت التسعير, and staff never receiving money.
// Operation sheets are inserted directly (the operations module is built in parallel).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, client } from './helpers.js';
import { isMoneyKey } from '../src/money.js';

let app;
let admin;
let staff;
let db;
let L;
let A; // clients
let B;
let C;
let tech;
let black;
let galv;

const keys = (v, out = new Set()) => {
  if (Array.isArray(v)) v.forEach((x) => keys(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keys(x, out); }
  return out;
};
const assertNoMoney = (data, what) => {
  const leaked = [...keys(data)].filter(isMoneyKey);
  assert.deepEqual(leaked, [], `${what} leaked money: ${leaked.join(', ')}`);
};

before(async () => {
  app = await startApp();
  ({ getDb: db } = await import('../src/db.js'));
  L = await import('../src/ledger.js');
  admin = client(app.base);
  staff = client(app.base);
  await admin.post('/api/setup', { username: 'owner', display_name: 'المالك', password: 'secret1' });
  await admin.post('/api/users', { username: 'manager', display_name: 'المدير', password: 'secret2', role: 'staff' });
  await staff.post('/api/login', { username: 'manager', password: 'secret2' });
  const add = (name) => Number(db().prepare("INSERT INTO parties (kind, name) VALUES ('client', ?)").run(name).lastInsertRowid);
  A = add('ورشة الفجر التجريبية');
  B = add('مصنع النسيم التجريبي');
  C = add('عميل الواحة التجريبي');
  tech = Number(db().prepare("INSERT INTO technicians (name) VALUES ('فني تجريبي')").run().lastInsertRowid);
  black = db().prepare("SELECT id FROM materials WHERE name = 'أسود'").get().id;
  galv = db().prepare("SELECT id FROM materials WHERE name = 'مجلفن'").get().id;
});
after(() => app.stop());

// An approved operation sheet with its lines (as the operations module would leave it).
function sheet(machine, date, lines, { status = 'approved', source = 'manual' } = {}) {
  const serial = L.nextSerial('تش');
  const id = Number(db().prepare(`INSERT INTO op_sheets (serial, machine, technician_id, sheet_date, status, source, photo_path)
    VALUES (?,?,?,?,?,?,?)`).run(serial, machine, tech, date, status, source, 'photos/x.jpg').lastInsertRowid);
  lines.forEach((l, i) => {
    const row = { sheet_id: id, row_no: i + 1, client_id: null, part_name: '', material_id: null, material_text: '', thickness: null,
      pieces: null, per_piece: null, sheets: null, minutes_per_sheet: null, single_piece: 0, louvers_per_piece: null,
      material_source: null, length_cm: null, width_cm: null, status: 'active', ...l };
    db().prepare(`INSERT INTO op_lines (sheet_id, row_no, client_id, part_name, material_id, material_text, thickness, pieces, per_piece,
      sheets, minutes_per_sheet, single_piece, louvers_per_piece, material_source, length_cm, width_cm, status)
      VALUES (@sheet_id, @row_no, @client_id, @part_name, @material_id, @material_text, @thickness, @pieces, @per_piece, @sheets,
      @minutes_per_sheet, @single_piece, @louvers_per_piece, @material_source, @length_cm, @width_cm, @status)`).run(row);
  });
  return { id, serial };
}
const count = (sql, ...p) => db().prepare(sql).get(...p).n;
const itemsOf = (data, clientId) => data.clients.find((c) => c.client.id === clientId).items;
const setRates = async (data, rate) => {
  for (const c of data.clients) for (const i of c.items) if (i.status === 'suggested' && i.rate === null) await admin.patch(`/api/pricing/items/${i.id}`, { rate });
};

let press;
let punch;

test('the queue: approved sheets not fully posted, grouped by date, counts by client; staff refused', async () => {
  press = sheet('press', '2026-10-15', [
    { client_id: A, part_name: 'رف تجريبي', material_id: black, material_text: '2مم اسود', pieces: 10, per_piece: 4 },
    { client_id: A, part_name: 'زاوية تجريبية', material_id: black, material_text: '4مم اسود', thickness: 4, pieces: 5, per_piece: 2 },
    { client_id: B, part_name: 'غطا تجريبي', material_id: galv, material_text: '1.5مم مجلفن', pieces: 3, per_piece: 2,
      material_source: 'factory', length_cm: 100, width_cm: 50 },
  ]);
  punch = sheet('punch', '2026-10-16', [
    { client_id: A, part_name: 'باب تجريبي', material_id: galv, thickness: 1, sheets: 2, minutes_per_sheet: 5, pieces: 4, louvers_per_piece: 10 },
    { client_id: C, part_name: 'لوفر بس', pieces: 6, louvers_per_piece: 8 },
  ]);
  sheet('press', '2026-10-16', [{ client_id: A, pieces: 1, per_piece: 1 }], { status: 'review' });
  sheet('shear', '2026-10-16', [{ client_id: A, pieces: 1, per_piece: 1 }], { source: 'import' });

  const r = await admin.get('/api/pricing/queue');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.totals.sheets, 2);
  assert.deepEqual(r.data.groups.map((g) => g.date), ['2026-10-16', '2026-10-15']);
  const ps = r.data.groups[1].sheets[0];
  assert.equal(ps.serial, press.serial);
  assert.equal(ps.machine_name, 'التناية');
  assert.equal(ps.technician_name, 'فني تجريبي');
  assert.equal(ps.waiting_count, 4); // 3 press items + 1 material item
  assert.equal(ps.needs_rate_count, 4);
  const a = r.data.clients.find((c) => c.id === A);
  assert.equal(a.sheets, 2);
  assert.equal((await staff.get('/api/pricing/queue')).status, 403);
  assert.equal((await staff.get(`/api/pricing/sheets/${press.id}`)).status, 403);
});

test('items: one per line per section, punch gives punch + louver, factory material gives a material item, idempotent', async () => {
  const r = await admin.get(`/api/pricing/sheets/${punch.id}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const a = itemsOf(r.data, A);
  assert.deepEqual(a.map((i) => i.section), ['punch', 'louver']);
  assert.equal(a[0].qty, 12); // 2 × 5 + 2
  assert.equal(a[1].qty, 40); // 4 × 10
  assert.deepEqual(itemsOf(r.data, C).map((i) => i.section), ['louver']);
  const p = await admin.get(`/api/pricing/sheets/${press.id}`);
  const b = itemsOf(p.data, B);
  assert.deepEqual(b.map((i) => i.section), ['press', 'material']);
  assert.equal(b[1].weight_kg, 17.6625); // 1.5/10 × 100 × 50 × 3 pieces × 7.85 / 1000
  assert.equal(itemsOf(p.data, A)[0].thickness, 2); // parsed from «2مم اسود»
  assert.equal(itemsOf(p.data, A)[1].band, '>=3');
  assert.ok(itemsOf(p.data, A).every((i) => i.needs.includes('rate') && i.rate_source === null));
  const before_ = count('SELECT COUNT(*) n FROM price_items');
  await admin.get(`/api/pricing/sheets/${press.id}`);
  await admin.get('/api/pricing/queue');
  assert.equal(count('SELECT COUNT(*) n FROM price_items'), before_);
  assert.equal((await admin.get('/api/pricing/sheets/999999')).status, 404);
});

test('general prices: sections, bands, min charges; validation; suggestions follow until confirmed', async () => {
  let r = await admin.get('/api/pricing/general');
  assert.equal(r.status, 200);
  assert.equal(r.data.prices.length, 7);
  assert.equal(r.data.prices.find((p) => p.section === 'laser').min_charge, 150000);
  r = await admin.put('/api/pricing/general', { prices: [{ section: 'press', band: '<3', rate: '2.5' }, { section: 'press', band: '>=3', rate: '4' }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.changed, 2);
  assert.equal((await admin.put('/api/pricing/general', { prices: [{ section: 'press', band: '<3', rate: 'abc' }] })).status, 400);
  assert.equal((await admin.put('/api/pricing/general', { prices: [{ section: 'press', band: '<3', rate: '-2' }] })).status, 400);
  r = await admin.put('/api/pricing/general', { prices: [{ section: 'shear', band: '', min_charge: '10' }] });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /الحد الأدنى/);
  assert.equal((await admin.put('/api/pricing/general', { prices: [{ section: 'nope', band: '', rate: 1 }] })).status, 400);
  assert.equal((await staff.put('/api/pricing/general', { prices: [{ section: 'press', band: '<3', rate: 1 }] })).status, 403);
  assert.ok(count("SELECT COUNT(*) n FROM audit_log WHERE entity = 'general_price'") >= 2);

  const p = await admin.get(`/api/pricing/sheets/${press.id}`);
  const [thin, thick] = itemsOf(p.data, A);
  assert.equal(thin.rate, 2500);
  assert.equal(thin.rate_source, 'general');
  assert.equal(thin.rate_confirmed, false);
  assert.equal(thin.amount, 100000); // 40 bends × 2.5
  assert.equal(thick.rate, 4000); // the ≥ 3 mm band
  assert.equal(thick.amount, 40000);
});

test('a rate: typed (confirmed, manual), validated in Arabic, cleared back to the suggestion', async () => {
  const p = await admin.get(`/api/pricing/sheets/${press.id}`);
  const thin = itemsOf(p.data, A)[0];
  let r = await admin.patch(`/api/pricing/items/${thin.id}`, { rate: '٣' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.item.rate, 3000);
  assert.equal(r.data.item.rate_confirmed, true);
  assert.equal(r.data.item.rate_source, 'manual');
  assert.equal(r.data.item.amount, 120000);
  r = await admin.patch(`/api/pricing/items/${thin.id}`, { rate: 'تلاتة' });
  assert.equal(r.status, 400);
  assert.equal(r.data.field, 'rate');
  assert.match(r.data.error, /سعر الوحدة/);
  assert.equal((await admin.patch(`/api/pricing/items/${thin.id}`, { rate: '-1' })).status, 400);
  assert.equal((await admin.patch(`/api/pricing/items/${thin.id}`, { billing: 'kg' })).status, 400);
  r = await admin.patch(`/api/pricing/items/${thin.id}`, { rate: '' });
  assert.equal(r.data.item.rate, 2500);
  assert.equal(r.data.item.rate_confirmed, false);
  r = await admin.patch(`/api/pricing/items/${thin.id}`, { confirm: true });
  assert.equal(r.data.item.rate_confirmed, true);
  assert.equal(r.data.item.rate_source, 'general');
  // fixed price per piece: the rate is suggested again for the new billing (none yet)
  r = await admin.patch(`/api/pricing/items/${thin.id}`, { billing: 'piece' });
  assert.equal(r.data.item.qty, 10);
  assert.equal(r.data.item.rate, null);
  r = await admin.patch(`/api/pricing/items/${thin.id}`, { billing: 'bend', rate: '3' });
  assert.equal(r.data.item.amount, 120000);
  assert.ok(count("SELECT COUNT(*) n FROM audit_log WHERE entity = 'price_item' AND entity_id = ?", thin.id) >= 5);
  assert.equal((await staff.patch(`/api/pricing/items/${thin.id}`, { rate: 1 })).status, 403);
});

test('apply a rate to the rest of the sheet or to similar items only', async () => {
  const s = sheet('shear', '2026-10-17', [
    { client_id: A, part_name: 'ق1', material_id: black, thickness: 1, pieces: 2, per_piece: 2 },
    { client_id: A, part_name: 'ق2', material_id: black, thickness: 1, pieces: 3, per_piece: 1 },
    { client_id: A, part_name: 'ق3', material_id: galv, thickness: 1, pieces: 1, per_piece: 1 },
    { client_id: B, part_name: 'ق4', material_id: black, thickness: 1, pieces: 1, per_piece: 1 },
  ]);
  let r = await admin.get(`/api/pricing/sheets/${s.id}`);
  const first = itemsOf(r.data, A)[0];
  await admin.patch(`/api/pricing/items/${first.id}`, { rate: '1.5' });
  r = await admin.post(`/api/pricing/sheets/${s.id}/apply-rate`, { item_id: first.id, scope: 'similar' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.applied, 1); // ق2 only: same client, material, thickness
  assert.deepEqual(itemsOf(r.data.sheet, A).map((i) => i.rate), [1500, 1500, null]);
  r = await admin.post(`/api/pricing/sheets/${s.id}/apply-rate`, { item_id: first.id, scope: 'sheet' });
  assert.equal(r.data.applied, 3);
  assert.equal(itemsOf(r.data.sheet, B)[0].rate, 1500);
  assert.equal((await admin.post(`/api/pricing/sheets/${s.id}/apply-rate`, { item_id: first.id, scope: 'x' })).status, 400);
  assert.equal((await admin.post(`/api/pricing/sheets/${press.id}/apply-rate`, { item_id: first.id, scope: 'sheet' })).status, 400);
});

test('posting refuses while an item has no rate, and posts nothing', async () => {
  const txns = count('SELECT COUNT(*) n FROM txns');
  const r = await admin.post(`/api/pricing/sheets/${press.id}/post`, {});
  assert.equal(r.status, 400);
  assert.match(r.data.error, /محتاج سعر/);
  assert.equal(r.data.problems.length, 1); // B's material item
  assert.equal(r.data.problems[0].client_id, B);
  assert.equal(count('SELECT COUNT(*) n FROM txns'), txns);
  assert.equal(count("SELECT COUNT(*) n FROM price_items WHERE sheet_id = ? AND status = 'posted'", press.id), 0);
});

test('discount / addition drafts are validated', async () => {
  let r = await admin.put(`/api/pricing/sheets/${press.id}/adjustments`, { client_id: A, discount: 'عشرة' });
  assert.equal(r.status, 400);
  assert.equal(r.data.field, 'discount');
  r = await admin.put(`/api/pricing/sheets/${press.id}/adjustments`, { client_id: A, discount: '-5' });
  assert.equal(r.status, 400);
  r = await admin.put(`/api/pricing/sheets/${press.id}/adjustments`, { client_id: A, discount: '10', addition: '5', note: 'نقل تجريبي' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.adjustment.discount_amount, 10000);
  const s = await admin.get(`/api/pricing/sheets/${press.id}`);
  const a = s.data.clients.find((c) => c.client.id === A);
  assert.equal(a.work_amount, 160000); // 120 + 40
  assert.equal(a.net_amount, 155000);
});

test('اعتماد التسعير والترحيل: one balanced transaction per client per sheet, discount in خصم', async () => {
  let s = await admin.get(`/api/pricing/sheets/${press.id}`);
  const mat = itemsOf(s.data, B)[1];
  let r = await admin.patch(`/api/pricing/items/${mat.id}`, { rate: '40' });
  assert.equal(r.data.item.amount, 706500); // 17.6625 kg × 40 = 706.50
  const before_ = count('SELECT COUNT(*) n FROM txns');
  assert.equal((await staff.post(`/api/pricing/sheets/${press.id}/post`, {})).status, 403);
  r = await admin.post(`/api/pricing/sheets/${press.id}/post`, {});
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.batches.length, 2);
  assert.equal(r.data.priced_status, 'posted');
  assert.equal(count('SELECT COUNT(*) n FROM txns') - before_, 3); // A work + A discount + B work
  const ba = r.data.batches.find((b) => b.client_id === A);
  assert.match(ba.serial, /^تس-\d{4}$/);
  const t = L.getTxn(ba.txn_id);
  assert.equal(t.description, `بيان أعمال التناية — ورقة ${press.serial} — 15/10/2026`);
  assert.equal(t.ref, ba.serial);
  assert.equal(t.date, '2026-10-15');
  assert.equal(t.doc_type, 'pricing_batch');
  const dr = t.postings.filter((p) => p.debit);
  const cr = t.postings.filter((p) => p.credit);
  assert.deepEqual(dr.map((p) => [p.account, p.party_id, p.debit]), [['receivable', A, 165000]]);
  assert.deepEqual(cr.map((p) => [p.account, p.credit]), [['revenue:press', 160000], ['revenue:manual', 5000]]);
  const tb = L.getTxn(r.data.batches.find((b) => b.client_id === B).txn_id);
  assert.deepEqual(tb.postings.filter((p) => p.credit).map((p) => [p.account, p.credit]), [['revenue:press', 15000], ['revenue:material', 706500]]);
  // statement: work in مدين, the discount in خصم
  const st = await admin.get(`/api/parties/${A}/statement`);
  assert.equal(st.data.rows.length, 2);
  assert.equal(st.data.rows[0].debit, 165000);
  assert.equal(st.data.rows[1].discount, 10000);
  assert.equal(st.data.closing, 155000);
  assert.equal(L.partyBalance(B), 721500); // 6 bends × 2.5 + 706.50
  // items posted with the txn; the sheet left the queue
  assert.equal(count("SELECT COUNT(*) n FROM price_items WHERE sheet_id = ? AND status = 'posted' AND txn_id IS NOT NULL AND rate_confirmed = 1", press.id), 4);
  assert.equal(db().prepare('SELECT priced_status FROM op_sheets WHERE id = ?').get(press.id).priced_status, 'posted');
  const q = await admin.get('/api/pricing/queue');
  assert.ok(!q.data.groups.some((g) => g.sheets.some((x) => x.id === press.id)));
  // posted items are frozen; posting again finds nothing
  const posted = itemsOf((await admin.get(`/api/pricing/sheets/${press.id}`)).data, A)[0];
  r = await admin.patch(`/api/pricing/items/${posted.id}`, { rate: '9' });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /تصحيح سعر/);
  assert.equal((await admin.post(`/api/pricing/items/${posted.id}/exclude`, { reason: 'x' })).status, 409);
  assert.equal((await admin.post(`/api/pricing/sheets/${press.id}/post`, {})).status, 409);
  assert.equal((await admin.put(`/api/pricing/sheets/${press.id}/adjustments`, { client_id: A, discount: '1' })).status, 409);
  // every txn balanced
  const unbalanced = db().prepare('SELECT txn_id FROM postings GROUP BY txn_id HAVING SUM(debit) <> SUM(credit)').all();
  assert.deepEqual(unbalanced, []);
});

test('suggested rate order: same client+section+material+thickness → client+section (+band) → general → none', async () => {
  const s = sheet('press', '2026-10-20', [
    { client_id: A, part_name: 'نفس الخامة', material_id: black, thickness: 2, pieces: 1, per_piece: 1 },
    { client_id: A, part_name: 'سمك تاني رفيع', material_id: black, thickness: 1, pieces: 1, per_piece: 1 },
    { client_id: A, part_name: 'تخين', material_id: galv, thickness: 5, pieces: 1, per_piece: 1 },
    { client_id: C, part_name: 'عميل جديد', thickness: 1, pieces: 1, per_piece: 1 },
  ]);
  await admin.put('/api/pricing/general', { prices: [{ section: 'press', band: '<3', rate: '2' }] });
  const r = await admin.get(`/api/pricing/sheets/${s.id}`);
  const [same, thinOther, thick] = itemsOf(r.data, A);
  assert.deepEqual([same.rate, same.rate_source], [3000, 'last_same']);
  assert.deepEqual([thinOther.rate, thinOther.rate_source], [3000, 'last_section']); // the < 3 band history
  assert.deepEqual([thick.rate, thick.rate_source], [4000, 'last_section']); // the ≥ 3 band history
  const c = itemsOf(r.data, C)[0];
  assert.deepEqual([c.rate, c.rate_source], [2000, 'general']);
  // no general price for shear → «محتاج سعر»
  const sh = sheet('shear', '2026-10-20', [{ client_id: C, pieces: 1, per_piece: 1 }]);
  const r2 = await admin.get(`/api/pricing/sheets/${sh.id}`);
  assert.deepEqual(itemsOf(r2.data, C)[0].needs, ['rate']);
  // the client's known rate (Excel row 4) comes before the general price
  db().prepare("INSERT INTO client_rates (client_id, section, band, rate, source) VALUES (?, 'shear', '', 1750, 'import')").run(C);
  const r3 = await admin.get(`/api/pricing/sheets/${sh.id}`);
  assert.deepEqual([itemsOf(r3.data, C)[0].rate, itemsOf(r3.data, C)[0].rate_source], [1750, 'last_section']);
});

test('laser single piece: the general minimum applies', async () => {
  await admin.put('/api/pricing/general', { prices: [{ section: 'laser', band: '', rate: '20', min_charge: '150' }] });
  const s = sheet('laser', '2026-10-21', [
    { client_id: C, part_name: 'قطعة وحيدة', sheets: 1, minutes_per_sheet: 2, single_piece: 1 },
    { client_id: C, part_name: 'كمية', sheets: 1, minutes_per_sheet: 2 },
  ]);
  const r = await admin.get(`/api/pricing/sheets/${s.id}`);
  const [one, many] = itemsOf(r.data, C);
  assert.equal(one.qty, 3);
  assert.equal(one.amount, 150000);
  assert.equal(one.min_applied, true);
  assert.equal(many.amount, 60000);
});

test('post one client only: the sheet becomes partial; exclude / restore; all excluded closes it', async () => {
  let r = await admin.get(`/api/pricing/sheets/${punch.id}`);
  for (const i of itemsOf(r.data, A)) await admin.patch(`/api/pricing/items/${i.id}`, { rate: '1' });
  r = await admin.post(`/api/pricing/sheets/${punch.id}/post`, { client_ids: [A] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.priced_status, 'partial');
  const lone = itemsOf(r.data.sheet, C)[0];
  assert.equal((await admin.post(`/api/pricing/items/${lone.id}/exclude`, {})).status, 400);
  r = await admin.post(`/api/pricing/items/${lone.id}/exclude`, { reason: 'شغل ضمان' });
  assert.equal(r.status, 200);
  assert.equal(db().prepare('SELECT priced_status FROM op_sheets WHERE id = ?').get(punch.id).priced_status, 'posted');
  const n = count('SELECT COUNT(*) n FROM price_items WHERE sheet_id = ?', punch.id);
  const s = await admin.get(`/api/pricing/sheets/${punch.id}`);
  await admin.get('/api/pricing/queue');
  assert.equal(count('SELECT COUNT(*) n FROM price_items WHERE sheet_id = ?', punch.id), n); // never generated again
  assert.equal(s.data.clients.find((c) => c.client.id === C).excluded.length, 1);
  r = await admin.post(`/api/pricing/items/${lone.id}/restore`, {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.item.status, 'suggested');
  assert.equal(db().prepare('SELECT priced_status FROM op_sheets WHERE id = ?').get(punch.id).priced_status, 'partial');
});

test('a sheet with nothing to bill can be closed', async () => {
  const s = sheet('press', '2026-10-22', [{ part_name: 'بدون عميل', pieces: 1, per_piece: 1 }]);
  let r = await admin.get(`/api/pricing/sheets/${s.id}`);
  assert.equal(r.data.clients.length, 0);
  r = await admin.post(`/api/pricing/sheets/${s.id}/post`, {});
  assert.equal(r.status, 201);
  assert.equal(r.data.priced_status, 'posted');
  assert.equal((await admin.get(`/api/pricing/sheets/${s.id}`)).data.sheet.priced_status, 'posted');
});

test('month lock: a sheet dated in a locked month is refused and nothing is written', async () => {
  const s = sheet('shear', '2026-09-10', [{ client_id: B, pieces: 2, per_piece: 2 }]);
  let r = await admin.get(`/api/pricing/sheets/${s.id}`);
  await admin.patch(`/api/pricing/items/${itemsOf(r.data, B)[0].id}`, { rate: '1' });
  assert.equal((await admin.post('/api/month-locks', { month: '2026-09' })).status < 300, true);
  const batches = count('SELECT COUNT(*) n FROM pricing_batches');
  r = await admin.post(`/api/pricing/sheets/${s.id}/post`, {});
  assert.equal(r.status, 409);
  assert.match(r.data.error, /مقفول/);
  assert.equal(count('SELECT COUNT(*) n FROM pricing_batches'), batches);
  assert.equal(count("SELECT COUNT(*) n FROM price_items WHERE sheet_id = ? AND status = 'posted'", s.id), 0);
  // unlocking with a reason lets it post
  const u = await fetch(`${app.base}/api/month-locks/2026-09`, { method: 'DELETE', headers: { cookie: admin.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'تصحيح تجريبي' }) });
  assert.equal(u.status, 200);
  r = await admin.post(`/api/pricing/sheets/${s.id}/post`, {});
  assert.equal(r.status, 201, JSON.stringify(r.data));
});

test('بيان أعمال: the batch with its items (admin only)', async () => {
  const b = db().prepare('SELECT * FROM pricing_batches WHERE sheet_id = ? AND client_id = ?').get(press.id, A);
  const r = await admin.get(`/api/pricing/batches/${b.id}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.batch.serial, b.serial);
  assert.equal(r.data.items.length, 2);
  assert.equal(r.data.batch.work_amount, 160000);
  assert.equal(r.data.batch.discount_amount, 10000);
  assert.equal(r.data.batch.addition_amount, 5000);
  assert.equal(r.data.batch.net_amount, 155000);
  assert.equal(r.data.sheet.serial, press.serial);
  assert.equal(r.data.sheet.has_photo, true);
  assert.equal(r.data.txns.length, 2);
  assert.equal((await staff.get(`/api/pricing/batches/${b.id}`)).status, 403);
  assert.equal((await admin.get('/api/pricing/batches/999999')).status, 404);
});

test('تصحيح سعر: reverses with a reason and reposts the corrected items (audited)', async () => {
  const b = db().prepare('SELECT * FROM pricing_batches WHERE sheet_id = ? AND client_id = ?').get(press.id, A);
  const v = (await admin.get(`/api/pricing/batches/${b.id}`)).data;
  const thin = v.items.find((i) => i.band === '<3');
  let r = await admin.post(`/api/pricing/batches/${b.id}/correct`, { items: [{ id: thin.id, rate: '2.75' }] });
  assert.equal(r.status, 400);
  assert.equal(r.data.field, 'reason');
  r = await admin.post(`/api/pricing/batches/${b.id}/correct`, { reason: 'مفيش تغيير', items: [] });
  assert.equal(r.status, 400);
  r = await admin.post(`/api/pricing/batches/${b.id}/correct`, { reason: 'x', items: [{ id: 999999, rate: '1' }] });
  assert.equal(r.status, 400);
  assert.equal((await staff.post(`/api/pricing/batches/${b.id}/correct`, { reason: 'x', items: [] })).status, 403);
  r = await admin.post(`/api/pricing/batches/${b.id}/correct`, { reason: 'السعر المتفق عليه أقل', items: [{ id: thin.id, rate: '2.75' }], discount: '0' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const nb = r.data.batch;
  assert.notEqual(nb.serial, b.serial);
  assert.equal(nb.total, 155000); // 40 × 2.75 + 40 + 5 addition
  assert.equal(nb.discount_amount, 0);
  const old = db().prepare('SELECT * FROM pricing_batches WHERE id = ?').get(b.id);
  assert.equal(old.status, 'reversed');
  assert.equal(old.reason, 'السعر المتفق عليه أقل');
  assert.equal(L.getTxn(old.txn_id).status, 'reversed');
  assert.equal(count("SELECT COUNT(*) n FROM price_items WHERE batch_id = ? AND status = 'cancelled' AND cancel_kind = 'corrected'", b.id), 2);
  const fresh = db().prepare('SELECT * FROM price_items WHERE batch_id = ?').all(nb.id);
  assert.equal(fresh.length, 2);
  assert.ok(fresh.every((i) => i.corrected_from && i.status === 'posted'));
  // balance: corrected work 155 (no discount now) + the punch sheet posted earlier (12 + 40 = 52)
  assert.equal(L.partyBalance(A), 155000 + 52000);
  assert.ok(count("SELECT COUNT(*) n FROM audit_log WHERE entity = 'pricing_batch' AND action = 'correct' AND entity_id = ?", b.id) === 1);
  const view = (await admin.get(`/api/pricing/batches/${nb.id}`)).data;
  assert.equal(view.corrected_from.id, b.id);
  assert.equal((await admin.get(`/api/pricing/batches/${b.id}`)).data.corrected_by.id, nb.id);
  // a reversed batch can't be corrected again
  assert.equal((await admin.post(`/api/pricing/batches/${b.id}/correct`, { reason: 'تاني', items: [{ id: thin.id, rate: '1' }] })).status, 409);
  // the statement keeps the honest history: original, its discount, both reversals, the new one
  const st = await admin.get(`/api/parties/${A}/statement?hide_reversed=1`);
  assert.ok(st.data.rows.every((x) => x.status !== 'reversed' && !x.reversal_of));
  assert.equal(st.data.closing, L.partyBalance(A));
  // the sheet stays posted (nothing waits)
  assert.equal(db().prepare('SELECT priced_status FROM op_sheets WHERE id = ?').get(press.id).priced_status, 'posted');
});

test('تصحيح سعر in a locked month posts today (the locked figures never change)', async () => {
  const s = sheet('shear', '2026-08-10', [{ client_id: C, pieces: 1, per_piece: 10 }]);
  let r = await admin.get(`/api/pricing/sheets/${s.id}`);
  await admin.patch(`/api/pricing/items/${itemsOf(r.data, C)[0].id}`, { rate: '1' });
  r = await admin.post(`/api/pricing/sheets/${s.id}/post`, {});
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const b = r.data.batches[0];
  await admin.post('/api/month-locks', { month: '2026-08' });
  const augBefore = L.partyBalance(C, { asOf: '2026-08-31' });
  const item = (await admin.get(`/api/pricing/batches/${b.id}`)).data.items[0];
  r = await admin.post(`/api/pricing/batches/${b.id}/correct`, { reason: 'سعر غلط', items: [{ id: item.id, rate: '2' }] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const nt = L.getTxn(r.data.batch.txn_id);
  assert.notEqual(nt.date.slice(0, 7), '2026-08');
  assert.match(nt.description, /^تصحيح: /);
  assert.equal(L.partyBalance(C, { asOf: '2026-08-31' }), augBefore);
});

test('قيد يدوي على عميل: debit / discount / addition with a serial قي-, real dates, cancel = reversal', async () => {
  const bal = L.partyBalance(B);
  let r = await admin.post('/api/pricing/manual', { client_id: B, kind: 'debit', date: '2026-10-25', amount: '1,200.50', description: 'فاتورة قديمة تجريبية' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.match(r.data.entry.serial, /^قي-\d{4}$/);
  assert.equal(r.data.entry.amount, 1200500);
  const t = L.getTxn(r.data.entry.txn_id);
  assert.deepEqual(t.postings.map((p) => [p.account, p.debit, p.credit]), [['receivable', 1200500, 0], ['revenue:manual', 0, 1200500]]);
  assert.equal(t.ref, r.data.entry.serial);
  assert.equal(t.doc_type, 'manual_entry');
  const d = await admin.post('/api/pricing/manual', { client_id: B, kind: 'discount', date: '2026-10-26', amount: '200.50', description: 'خصم تجريبي' });
  assert.equal(d.status, 201);
  assert.deepEqual(L.getTxn(d.data.entry.txn_id).postings.map((p) => [p.account, p.debit, p.credit]), [['discount_given', 200500, 0], ['receivable', 0, 200500]]);
  const a = await admin.post('/api/pricing/manual', { client_id: B, kind: 'addition', date: '2026-10-26', amount: '50', description: 'نقل تجريبي' });
  assert.equal(a.status, 201);
  assert.equal(L.partyBalance(B), bal + 1200500 - 200500 + 50000);
  const st = await admin.get(`/api/parties/${B}/statement?from=2026-10-25`);
  assert.equal(st.data.rows.find((x) => x.ref === d.data.entry.serial).discount, 200500);

  for (const [body, field] of [
    [{ client_id: B, kind: 'debit', date: '2026-02-30', amount: '1', description: 'x' }, 'date'],
    [{ client_id: B, kind: 'debit', date: '2026-13-01', amount: '1', description: 'x' }, 'date'],
    [{ client_id: B, kind: 'debit', date: '', amount: '1', description: 'x' }, 'date'],
    [{ client_id: B, kind: 'debit', date: '2026-10-01', amount: '0', description: 'x' }, 'amount'],
    [{ client_id: B, kind: 'debit', date: '2026-10-01', amount: 'abc', description: 'x' }, 'amount'],
    [{ client_id: B, kind: 'debit', date: '2026-10-01', amount: '5', description: '  ' }, 'description'],
    [{ client_id: B, kind: 'nope', date: '2026-10-01', amount: '5', description: 'x' }, 'kind'],
    [{ client_id: 999999, kind: 'debit', date: '2026-10-01', amount: '5', description: 'x' }, 'client_id'],
  ]) {
    const x = await admin.post('/api/pricing/manual', body);
    assert.equal(x.status, 400, JSON.stringify(body));
    assert.equal(x.data.field, field, JSON.stringify(x.data));
  }
  // leap day is a real date
  assert.equal((await admin.post('/api/pricing/manual', { client_id: B, kind: 'debit', date: '2028-02-29', amount: '1', description: 'يوم كبيسة' })).status, 201);
  // locked month refused
  r = await admin.post('/api/pricing/manual', { client_id: B, kind: 'debit', date: '2026-08-05', amount: '1', description: 'x' });
  assert.equal(r.status, 409);
  assert.equal((await staff.post('/api/pricing/manual', { client_id: B, kind: 'debit', date: '2026-10-01', amount: '5', description: 'x' })).status, 403);
  // cancel: reason required, reversal posted, no second cancel
  const id = a.data.entry.id;
  assert.equal((await admin.post(`/api/pricing/manual/${id}/cancel`, {})).status, 400);
  r = await admin.post(`/api/pricing/manual/${id}/cancel`, { reason: 'اتسجل بالغلط' });
  assert.equal(r.status, 200);
  assert.equal(r.data.entry.status, 'cancelled');
  assert.equal(L.getTxn(a.data.entry.txn_id).status, 'reversed');
  assert.equal((await admin.post(`/api/pricing/manual/${id}/cancel`, { reason: 'تاني' })).status, 409);
  const list = await admin.get(`/api/pricing/manual?client_id=${B}`);
  assert.equal(list.data.entries.length, 4);
  assert.equal((await staff.get(`/api/pricing/manual/${id}`)).status, 403);
});

test('شيت التسعير: six sections in the Excel order with totals; staff gets quantities only', async () => {
  const r = await admin.get(`/api/pricing/clients/${A}/sheet`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.sections.map((s) => s.section), ['press', 'laser', 'punch', 'louver', 'shear', 'material']);
  const press_ = r.data.sections[0];
  assert.equal(press_.sums.pieces, 10 + 5 + 1 + 1 + 1); // posted + waiting items of the sheets above
  assert.equal(press_.thin_amount >= 110000, true);
  assert.equal(press_.amount, press_.thin_amount + press_.thick_amount + press_.fixed_amount + press_.lump_amount);
  const it = press_.items.find((i) => i.status === 'posted');
  assert.equal(it.sheet_serial, press.serial);
  assert.equal(it.technician_name, 'فني تجريبي');
  assert.equal(r.data.sections[2].sums.minutes, 12);
  assert.equal(r.data.sections[3].sums.louvers, 40);
  assert.equal(r.data.total, r.data.sections.reduce((s, x) => s + x.amount, 0));
  const bm = (await admin.get(`/api/pricing/clients/${B}/sheet`)).data.sections[5];
  assert.equal(bm.sums.galvanized_kg, 17.6625);
  assert.equal(bm.sums.weight_kg, 17.6625);
  assert.equal(bm.sums.black_kg, 0);
  // date range, validated
  const f = await admin.get(`/api/pricing/clients/${A}/sheet?from=2026-10-16&to=2026-10-16`);
  assert.equal(f.data.sections[0].items.length, 0);
  assert.equal((await admin.get(`/api/pricing/clients/${A}/sheet?from=2026-02-31`)).status, 400);
  // staff
  const s = await staff.get(`/api/pricing/clients/${A}/sheet`);
  assert.equal(s.status, 200);
  assertNoMoney(s.data, 'client pricing sheet');
  assert.equal(s.data.sections[0].sums.pieces, press_.sums.pieces);
  assert.equal(s.data.sections[0].items[0].pieces, press_.items[0].pieces);
  // the routes staff may not use never answer with money either
  for (const u of ['/api/pricing/queue', `/api/pricing/sheets/${press.id}`, '/api/pricing/general', '/api/pricing/manual']) {
    const x = await staff.get(u);
    assert.equal(x.status, 403, u);
    assertNoMoney(x.data, u);
  }
});

test('every pricing transaction is balanced and every batch is audited', () => {
  assert.deepEqual(db().prepare('SELECT txn_id FROM postings GROUP BY txn_id HAVING SUM(debit) <> SUM(credit)').all(), []);
  const batches = db().prepare('SELECT id FROM pricing_batches').all();
  for (const b of batches) assert.equal(count("SELECT COUNT(*) n FROM audit_log WHERE entity = 'pricing_batch' AND action = 'post' AND entity_id = ?", b.id), 1);
  // a non-integer amount can't reach the new money columns
  assert.throws(() => db().prepare('INSERT INTO pricing_adjustments (sheet_id, client_id, discount_amount) VALUES (?, ?, 1.5)').run(press.id, A), /integer millimes/);
});
