// Module reports over HTTP: المركز المالي, ملخص العملاء (+ Excel), أعمار الديون (FIFO),
// مكسب الشهر, التدفق المتوقع, جاري الشركاء, الإنتاج, سجل التعديلات and متابعة التحصيل.
// Transactions are posted straight through ledger.post (the other modules are built in
// parallel); cheques, recurring expenses and operation sheets are inserted as rows.
// Every name is invented. Amounts are millimes (1 EGP = 1000).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { startApp, client } from './helpers.js';
import { isMoneyKey } from '../src/money.js';
import { getDb } from '../src/db.js';
import * as L from '../src/ledger.js';
import { realDate } from '../src/reports/dates.js';
import { fifoOpenDebits, bucketOf } from '../src/reports/clients.js';
import { lineMetrics } from '../src/reports/production.js';

const AS_OF = '2026-10-31';
const E = (pounds) => pounds * 1000;

let app; let admin; let staff; let viewer;
let adminId;
const ids = {};

const keys = (v, out = new Set()) => {
  if (Array.isArray(v)) v.forEach((x) => keys(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keys(x, out); }
  return out;
};
const assertNoMoney = (data, what) => {
  const bad = [...keys(data)].filter(isMoneyKey);
  assert.deepEqual(bad, [], `${what} leaked money: ${bad.join(', ')}`);
};

const addParty = (kind, name, extra = {}) => Number(getDb().prepare('INSERT INTO parties (kind, name, credit_limit) VALUES (?, ?, ?)')
  .run(kind, name, extra.credit_limit ?? null).lastInsertRowid);
const post = (kind, date, lines, partyId = null) => L.post(kind, date, kind, lines, { userId: adminId, partyId });
const work = (party, date, amount, section = 'press') => post('pricing', date, [
  { account: 'receivable', party_id: party, debit: amount }, { account: `revenue:${section}`, credit: amount, section }], party);
let seq = 0;
const cheque = (direction, party, amount, due, status) => Number(getDb().prepare(`INSERT INTO cheques
  (serial, direction, party_id, number, amount, due_date, status, received_date, issued_date) VALUES (?,?,?,?,?,?,?,?,?)`)
  .run(`شك-9${String(++seq).padStart(3, '0')}`, direction, party, `N${seq}`, amount, due, status,
    direction === 'in' ? '2026-10-01' : null, direction === 'out' ? '2026-10-15' : null).lastInsertRowid);

before(async () => {
  app = await startApp();
  admin = client(app.base);
  staff = client(app.base);
  viewer = client(app.base);
  await admin.post('/api/setup', { username: 'owner', display_name: 'المالك التجريبي', password: 'secret1' });
  adminId = getDb().prepare("SELECT id FROM users WHERE username = 'owner'").get().id;
  assert.equal((await admin.post('/api/users', { username: 'manager', display_name: 'مدير تجريبي', password: 'secret2', role: 'staff' })).status, 201);
  assert.equal((await admin.post('/api/users', { username: 'viewer', display_name: 'متابع تجريبي', password: 'secret3', role: 'staff', extra_permissions: ['reports'] })).status, 201);
  await staff.post('/api/login', { username: 'manager', password: 'secret2' });
  await viewer.post('/api/login', { username: 'viewer', password: 'secret3' });

  ids.a = addParty('client', 'ورشة الاختبار الأولى');
  ids.b = addParty('client', 'مصنع التجربة الثاني', { credit_limit: E(2000) });
  ids.c = addParty('client', 'عميل من غير حركة');
  ids.d = addParty('client', 'عميل دافع مقدم');
  ids.p = addParty('partner', 'شريك تجريبي');
  ids.s = addParty('supplier', 'مورد صاج تجريبي');
  ids.w = addParty('worker', 'عامل تجريبي');

  // A: work, discount, payment, more work, and one cancelled work.
  work(ids.a, '2026-07-01', E(10000), 'press');
  work(ids.a, '2026-09-15', E(5000), 'laser');
  post('discount', '2026-09-20', [{ account: 'discount_given', debit: E(500) }, { account: 'receivable', party_id: ids.a, credit: E(500) }], ids.a);
  post('receipt', '2026-10-01', [{ account: 'cash', debit: E(6000) }, { account: 'receivable', party_id: ids.a, credit: E(6000) }], ids.a);
  const cancelled = work(ids.a, '2026-10-10', E(1000), 'shear');
  L.reverse(cancelled.id, 'اتسجلت غلط', { userId: adminId, date: '2026-10-12' });
  work(ids.a, '2026-10-20', E(2000), 'press');
  // B: over his credit limit. D: paid before any work.
  work(ids.b, '2026-10-25', E(3000), 'louver');
  post('receipt', '2026-10-02', [{ account: 'bank', debit: E(1000) }, { account: 'receivable', party_id: ids.d, credit: E(1000) }], ids.d);
  // Partner, supplier, expenses, worker.
  post('partner_deposit', '2026-08-01', [{ account: 'bank', debit: E(20000) }, { account: 'partner', party_id: ids.p, credit: E(20000) }]);
  post('partner_withdrawal', '2026-10-05', [{ account: 'partner', party_id: ids.p, debit: E(3000) }, { account: 'cash', credit: E(3000) }]);
  post('material_purchase', '2026-10-03', [{ account: 'materials_purchases', debit: E(4000) }, { account: 'payable', party_id: ids.s, credit: E(4000) }]);
  post('expense', '2026-10-07', [{ account: 'expense:3', debit: E(800) }, { account: 'cash', credit: E(800) }]);
  post('worker_advance', '2026-10-08', [{ account: 'worker', party_id: ids.w, debit: E(300) }, { account: 'cash', credit: E(300) }]);
  // Our cheque to the supplier (issued, not cleared) and two client cheques we hold.
  post('cheque_issue', '2026-10-15', [{ account: 'payable', party_id: ids.s, debit: E(1500) }, { account: 'cheques_payable', credit: E(1500) }]);
  cheque('out', ids.s, E(1500), '2026-11-03', 'issued');
  cheque('in', ids.a, E(2500), '2026-11-05', 'in_portfolio');
  cheque('in', ids.b, E(700), '2026-10-25', 'in_portfolio'); // overdue
  cheque('in', ids.a, E(999), '2026-10-20', 'collected'); // done: never counted
  // Recurring: rent from the cash on the 10th (October already paid); one paid by a partner.
  getDb().prepare("INSERT INTO recurring_expenses (category_id, description, amount, day_of_month, paid_from, last_month) VALUES (2, 'إيجار الورشة', ?, 10, 'cash', '2026-10')").run(E(5000));
  getDb().prepare("INSERT INTO recurring_expenses (category_id, description, amount, day_of_month, paid_from, paid_from_party_id) VALUES (3, 'من جيب الشريك', ?, 12, 'partner', ?)").run(E(400), ids.p);
});
after(() => app.stop());

// ---------- pure rules ----------
test('real calendar dates only', () => {
  assert.equal(realDate('2026-10-31'), '2026-10-31');
  assert.equal(realDate('٢٠٢٦-١٠-٠٥'), '2026-10-05');
  assert.equal(realDate('2028-02-29'), '2028-02-29');
  for (const bad of ['2026-02-29', '2026-02-30', '2026-04-31', '2026-13-01', '2026-00-10', '2026-1-5', 'x', '2026-10-32']) assert.equal(realDate(bad), null, bad);
});

test('FIFO: credits settle the oldest work first; leftovers are an advance', () => {
  const t = [{ txn_id: 1, date: '2026-01-01', net: 100 }, { txn_id: 2, date: '2026-02-01', net: 50 }, { txn_id: 3, date: '2026-03-01', net: -120 }];
  assert.deepEqual(fifoOpenDebits(t), { open: [{ txn_id: 2, date: '2026-02-01', open_amount: 30 }], advance_amount: 0 });
  assert.deepEqual(fifoOpenDebits([{ txn_id: 1, date: '2026-01-01', net: -10 }]), { open: [], advance_amount: 10 });
  assert.equal(bucketOf(0).key, 'b0_amount');
  assert.equal(bucketOf(29).key, 'b0_amount');
  assert.equal(bucketOf(30).key, 'b30_amount');
  assert.equal(bucketOf(59).key, 'b30_amount');
  assert.equal(bucketOf(60).key, 'b60_amount');
  assert.equal(bucketOf(89).key, 'b60_amount');
  assert.equal(bucketOf(90).key, 'b90_amount');
});

test('production formulas: bends, cuts, +1 minute per sheet, louvers, factory kg', () => {
  assert.equal(lineMetrics({ machine: 'press', pieces: 10, per_piece: 4 }).bends, 40);
  assert.equal(lineMetrics({ machine: 'press', pieces: 5, per_piece: null, total_written: 12 }).bends, 12);
  assert.equal(lineMetrics({ machine: 'shear', pieces: 3, per_piece: 2 }).cuts, 6);
  assert.equal(lineMetrics({ machine: 'laser', sheets: 3, minutes_per_sheet: 10 }).minutes, 33);
  assert.equal(lineMetrics({ machine: 'punch', pieces: 20, louvers_per_piece: 6, sheets: 2, minutes_per_sheet: 5 }).louvers, 120);
  const kg = lineMetrics({ machine: 'laser', material_source: 'factory', thickness: 2, length_cm: 100, width_cm: 50, sheets: 3, density: 7.85 }).kg;
  assert.ok(Math.abs(kg - 23.55) < 1e-9);
  assert.equal(lineMetrics({ machine: 'laser', material_source: 'client', thickness: 2, length_cm: 100, width_cm: 50, sheets: 3, density: 7.85 }).kg, 0);
});

// ---------- permissions ----------
test('money reports are admin only; staff never get them', async () => {
  for (const u of ['/api/reports/home', '/api/reports/clients', '/api/reports/clients.xlsx', '/api/reports/aging', '/api/reports/profit', '/api/reports/cashflow', '/api/reports/partners']) {
    assert.equal((await staff.get(u)).status, 403, `staff ${u}`);
    assert.equal((await viewer.get(u)).status, 403, `viewer (reports, no money.view) ${u}`);
  }
  assert.equal((await staff.get('/api/reports/audit')).status, 403);
  assert.equal((await staff.get('/api/reports/followups')).status, 403);
  assert.equal((await admin.get('/api/reports/nothing-here')).status, 404);
});

test('as_of must be a real calendar date', async () => {
  const r = await admin.get('/api/reports/aging?as_of=2026-02-30');
  assert.equal(r.status, 400);
  assert.match(r.data.error, /غلط/);
  assert.equal(r.data.field, 'as_of');
  assert.equal((await admin.get('/api/reports/profit?month=2026-13')).status, 400);
});

// ---------- المركز المالي ----------
test('home: لينا / علينا / الخزينة / البنك / صافي المركز, each with its source', async () => {
  const r = await admin.get(`/api/reports/home?as_of=${AS_OF}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const p = r.data.position;
  const line = (list, key) => list.find((l) => l.key === key);
  assert.equal(line(p.ours, 'receivables').amount, E(13500)); // A 10,500 + B 3,000
  assert.equal(line(p.ours, 'cheques_in').amount, E(3200)); // held, not collected
  assert.equal(line(p.ours, 'cheques_in').memo, true); // already inside the receivables: never summed
  assert.equal(line(p.ours, 'worker_advances').amount, E(300));
  assert.equal(p.ours_total, E(13800)); // receivables + worker advances; the held cheques are inside the receivables
  assert.equal(line(p.theirs, 'partners').amount, E(17000));
  assert.equal(line(p.theirs, 'suppliers').amount, E(2500));
  assert.equal(line(p.theirs, 'cheques_payable').amount, E(1500));
  assert.equal(line(p.theirs, 'client_advances').amount, E(1000));
  assert.equal(p.theirs_total, E(22000));
  assert.equal(p.cash_balance, E(1900));
  assert.equal(p.bank_balance, E(21000));
  assert.equal(p.net_total, E(14700));
  for (const l of [...p.ours, ...p.theirs]) assert.match(l.href, /^#\//, `${l.key} has a source`);

  // Cheques due this week (in and out), the overdue one included and flagged.
  assert.deepEqual(r.data.cheques_due.in.map((c) => [c.amount, c.overdue]), [[E(700), true], [E(2500), false]]);
  assert.deepEqual(r.data.cheques_due.out.map((c) => c.amount), [E(1500)]);
  const kinds = r.data.attention.items.map((i) => i.kind);
  assert.ok(kinds.includes('cheque_in_overdue'));
  assert.ok(kinds.includes('over_credit_limit'));
  assert.equal(r.data.attention.items.find((i) => i.kind === 'over_credit_limit').party_id, ids.b);
});

// ---------- ملخص العملاء ----------
test('clients summary: Excel columns, every client, balances equal the ledger', async () => {
  const r = await admin.get(`/api/reports/clients?as_of=${AS_OF}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.rows.length, 4, 'every client, also the one with no movement');
  const a = r.data.rows.find((x) => x.id === ids.a);
  assert.equal(a.debit_total, E(17000)); // the cancelled 1,000 and its reversal are left out
  assert.equal(a.discount_total, E(500));
  assert.equal(a.credit_total, E(6000));
  assert.equal(a.balance, E(10500));
  assert.equal(a.balance_text, 'لنا عنده 10,500.00');
  assert.equal(a.last_payment_date, '2026-10-01');
  assert.equal(a.last_payment_amount, E(6000));
  assert.equal(a.oldest_open_date, '2026-07-01');
  assert.equal(a.debt_age_days, 122);
  const c = r.data.rows.find((x) => x.id === ids.c);
  assert.deepEqual([c.debit_total, c.balance, c.balance_text, c.debt_age_days], [0, 0, 'خالص', null]);
  assert.equal(r.data.rows.find((x) => x.id === ids.d).balance_text, 'له عندنا 1,000.00');
  assert.equal(r.data.rows.find((x) => x.id === ids.b).over_limit, true);
  for (const row of r.data.rows) assert.equal(row.balance, L.partyBalance(row.id), row.name);
  assert.equal(r.data.totals.balance, E(12500));
  assert.equal(r.data.totals.debit_total - r.data.totals.discount_total - r.data.totals.credit_total, r.data.totals.balance);
});

test('clients summary exports to Excel in the same layout', async () => {
  const res = await fetch(`${app.base}/api/reports/clients.xlsx?as_of=${AS_OF}`, { headers: { cookie: admin.cookie } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /spreadsheetml/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
  const ws = wb.getWorksheet('ملخص العملاء');
  assert.ok(ws.views[0].rightToLeft);
  assert.deepEqual(ws.getRow(2).values.slice(1, 6), ['العميل', 'إجمالي المدين', 'إجمالي الخصم', 'إجمالي الدائن', 'الرصيد النهائي']);
  const rows = [];
  ws.eachRow((row, n) => { if (n > 2) rows.push(row.values.slice(1)); });
  assert.equal(rows.length, 5); // 4 clients + total
  const a = rows.find((x) => x[0] === 'ورشة الاختبار الأولى');
  assert.deepEqual(a.slice(0, 5), ['ورشة الاختبار الأولى', 17000, 500, 6000, 10500]);
  assert.deepEqual(rows.at(-1).slice(0, 5), ['الإجمالي', 20000, 500, 7000, 12500]);
});

// ---------- أعمار الديون ----------
test('aging: FIFO buckets per client, totals equal the balances', async () => {
  const r = await admin.get(`/api/reports/aging?as_of=${AS_OF}`);
  assert.equal(r.status, 200);
  const a = r.data.rows.find((x) => x.id === ids.a);
  // 6,500 of credits settle the July work first: 3,500 of it is still open (122 days).
  assert.deepEqual([a.b0_amount, a.b30_amount, a.b60_amount, a.b90_amount], [E(2000), E(5000), 0, E(3500)]);
  assert.equal(a.balance, E(10500));
  const b = r.data.rows.find((x) => x.id === ids.b);
  assert.equal(b.b0_amount, E(3000));
  const d = r.data.rows.find((x) => x.id === ids.d);
  assert.equal(d.advance_amount, E(1000));
  assert.equal(r.data.rows.some((x) => x.id === ids.c), false, 'nothing open: not listed');
  assert.equal(r.data.totals.balance, E(12500));
  // Earlier as_of: the October work is not there yet, the September discount is.
  const early = await admin.get('/api/reports/aging?as_of=2026-09-30');
  const a2 = early.data.rows.find((x) => x.id === ids.a);
  assert.equal(a2.open_total, E(14500));
  assert.equal(a2.b90_amount, E(9500));
});

test('aging as of a date between a work and its cancellation still counts the work', async () => {
  const r = await admin.get('/api/reports/aging?as_of=2026-10-11');
  const a = r.data.rows.find((x) => x.id === ids.a);
  assert.equal(a.open_total, E(9500)); // 15,000 + 1,000 not yet cancelled − 6,500 paid and discounted
  assert.equal(a.balance, L.partyBalance(ids.a, { asOf: '2026-10-11' }));
});

// ---------- مكسب الشهر ----------
test('month profit: revenue by section − discounts − expenses − materials, with previous months', async () => {
  const r = await admin.get('/api/reports/profit?month=2026-10&months=4');
  assert.equal(r.status, 200);
  const rev = Object.fromEntries(r.data.revenue.map((x) => [x.key, x.line_amount]));
  assert.equal(rev.press, E(2000));
  assert.equal(rev.shear, 0); // posted and reversed inside the month
  assert.equal(rev.louver, E(3000));
  assert.equal(r.data.revenue_total, E(5000));
  assert.equal(r.data.discount_total, 0);
  assert.deepEqual(r.data.expenses.map((e) => [e.label, e.line_amount]), [['كهرباء ومياه', E(800)]]);
  assert.equal(r.data.materials_total, E(4000));
  assert.equal(r.data.profit_amount, E(200));
  assert.deepEqual(r.data.series.map((s) => [s.month, s.profit_amount]), [['2026-07', E(10000)], ['2026-08', 0], ['2026-09', E(4500)], ['2026-10', E(200)]]);
});

test('a locked month never changes: a later cancellation lands in the later month', async () => {
  const late = work(ids.c, '2026-10-30', E(700), 'punch');
  L.lockMonth('2026-10', adminId, 'إقفال تجريبي');
  assert.throws(() => work(ids.c, '2026-10-30', E(1), 'punch'), /مقفول/);
  L.reverse(late.id, 'إلغاء تجريبي بعد الإقفال', { userId: adminId, date: '2026-11-01' });
  const oct = await admin.get('/api/reports/profit?month=2026-10');
  assert.equal(oct.data.profit_amount, E(900));
  const nov = await admin.get('/api/reports/profit?month=2026-11');
  assert.equal(nov.data.revenue_total, -E(700));
  L.unlockMonth('2026-10', adminId, 'نهاية الاختبار');
});

// ---------- التدفق المتوقع ----------
test('cashflow: 4 weeks of cheques and recurring expenses on top of cash + bank', async () => {
  const r = await admin.get(`/api/reports/cashflow?as_of=${AS_OF}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.opening_balance, E(22900));
  assert.equal(r.data.weeks.length, 4);
  const [w1, w2, w3, w4] = r.data.weeks;
  assert.equal(w1.in_amount, E(3200)); // the overdue cheque lands in week 1
  assert.ok(w1.items.find((i) => i.late));
  assert.equal(w1.out_amount, E(1500));
  assert.equal(w2.out_amount, E(5000)); // rent on 2026-11-10; the partner-paid one is not cash
  assert.equal(w2.running_balance, E(19600));
  assert.equal(w3.net_amount + w4.net_amount, 0);
  assert.equal(r.data.first_negative_week, null);

  cheque('out', ids.s, E(30000), '2026-11-20', 'issued');
  const neg = await admin.get(`/api/reports/cashflow?as_of=${AS_OF}`);
  assert.equal(neg.data.first_negative_week, 3);
  assert.equal(neg.data.weeks[2].negative, true);
  assert.equal(neg.data.weeks[2].running_balance, E(19600 - 30000));
});

// ---------- جاري الشركاء ----------
test('partners: ما دفعه / ما أخذه / صافي المستحق', async () => {
  const r = await admin.get('/api/reports/partners');
  assert.equal(r.status, 200);
  const p = r.data.rows.find((x) => x.id === ids.p);
  assert.deepEqual([p.paid_total, p.taken_total, p.net_amount, p.balance_text], [E(20000), E(3000), E(17000), 'له عندنا 17,000.00']);
  assert.equal(r.data.totals.net_amount, E(17000));
  assert.equal(p.balance, L.partyBalance(ids.p));
});

// ---------- الإنتاج ----------
test('production: approved sheets only, by machine / technician / client / month, no money for staff', async () => {
  const db = getDb();
  const t1 = Number(db.prepare("INSERT INTO technicians (name, machine) VALUES ('فني تناية تجريبي', 'press')").run().lastInsertRowid);
  const t2 = Number(db.prepare("INSERT INTO technicians (name, machine) VALUES ('فني ليزر تجريبي', 'laser')").run().lastInsertRowid);
  const black = db.prepare("SELECT id FROM materials WHERE name = 'أسود'").get().id;
  const sheet = (serial, machine, tech, date, status) => Number(db.prepare(`INSERT INTO op_sheets (serial, machine, technician_id, sheet_date, status)
    VALUES (?,?,?,?,?)`).run(serial, machine, tech, date, status).lastInsertRowid);
  let row = 0;
  const line = (sheetId, f) => db.prepare(`INSERT INTO op_lines (sheet_id, row_no, client_id, pieces, per_piece, total_written, sheets,
    minutes_per_sheet, louvers_per_piece, material_source, material_id, thickness, length_cm, width_cm)
    VALUES (@sheet_id, @row_no, @client_id, @pieces, @per_piece, @total_written, @sheets, @minutes_per_sheet, @louvers_per_piece,
      @material_source, @material_id, @thickness, @length_cm, @width_cm)`).run({ sheet_id: sheetId, row_no: ++row, client_id: null,
    pieces: null, per_piece: null, total_written: null, sheets: null, minutes_per_sheet: null, louvers_per_piece: null,
    material_source: null, material_id: null, thickness: null, length_cm: null, width_cm: null, ...f });
  const s1 = sheet('تش-9001', 'press', t1, '2026-10-05', 'approved');
  line(s1, { client_id: ids.a, pieces: 10, per_piece: 4 });
  line(s1, { client_id: ids.b, pieces: 5, total_written: 12 });
  const s2 = sheet('تش-9002', 'laser', t2, '2026-10-06', 'approved');
  line(s2, { client_id: ids.a, sheets: 3, minutes_per_sheet: 10, material_source: 'factory', material_id: black, thickness: 2, length_cm: 100, width_cm: 50 });
  const s3 = sheet('تش-9003', 'punch', null, '2026-09-28', 'approved');
  line(s3, { client_id: ids.b, pieces: 20, louvers_per_piece: 6, sheets: 2, minutes_per_sheet: 5 });
  const s4 = sheet('تش-9004', 'shear', t1, '2026-10-07', 'review');
  line(s4, { client_id: ids.a, pieces: 100, per_piece: 1 });

  const r = await staff.get('/api/reports/production?group=machine');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assertNoMoney(r.data, 'production');
  const by = Object.fromEntries(r.data.rows.map((x) => [x.key, x]));
  assert.equal(by.press.bends, 52);
  assert.equal(by.laser.minutes, 33);
  assert.equal(by.laser.kg, 23.55);
  assert.equal(by.punch.louvers, 120);
  assert.equal(by.punch.minutes, 12);
  assert.equal(by.shear, undefined, 'a sheet in review is not production yet');
  assert.equal(r.data.sum.op_sheets, 3);

  const tech = await staff.get('/api/reports/production?group=technician&from=2026-10-01&to=2026-10-31');
  assert.deepEqual(tech.data.rows.map((x) => x.label).sort(), ['فني تناية تجريبي', 'فني ليزر تجريبي']);
  const cli = await admin.get(`/api/reports/production?group=client&client_id=${ids.a}`);
  assert.equal(cli.data.rows.length, 1);
  assert.equal(cli.data.rows[0].bends, 40);
  const month = await admin.get('/api/reports/production?group=month');
  assert.deepEqual(month.data.rows.map((x) => x.key), ['2026-09', '2026-10']);
  assert.equal((await staff.get('/api/reports/production?from=2026-10-31&to=2026-10-01')).status, 400);
  assert.equal((await staff.get('/api/reports/production?group=price')).status, 400);
  assert.equal((await staff.get('/api/reports/production?from=2026-09-31')).status, 400);

  // The home counts them too.
  const home = await admin.get(`/api/reports/home?as_of=${AS_OF}`);
  assert.equal(home.data.counters.sheets_waiting_pricing, 3);
  assert.equal(home.data.counters.sheets_in_review, 1);
  assert.ok(home.data.attention.items.some((i) => i.kind === 'sheets_in_review' && i.href === '#/ops/review'));
});

// ---------- متابعة التحصيل ----------
test('follow-ups: validation, due list, done with the next one, edit, delete — all audited', async () => {
  let r = await admin.post('/api/reports/followups', { party_id: ids.a, note: 'اتصلت بيه', next_date: '2026-02-30' });
  assert.equal(r.status, 400);
  assert.equal(r.data.field, 'next_date');
  r = await admin.post('/api/reports/followups', { party_id: ids.a, note: '   ', next_date: '2026-10-30' });
  assert.equal(r.status, 400);
  assert.equal(r.data.field, 'note');
  r = await admin.post('/api/reports/followups', { party_id: 99999, note: 'x' });
  assert.equal(r.status, 400);

  r = await admin.post('/api/reports/followups', { party_id: ids.a, note: 'وعد يدفع آخر الشهر', next_date: '2026-10-30' });
  assert.equal(r.status, 201);
  const first = r.data.follow_up;
  await admin.post('/api/reports/followups', { party_id: ids.b, note: 'هيعدي الأسبوع الجاي', next_date: '2026-11-15' });

  r = await admin.get(`/api/reports/followups?status=due&as_of=${AS_OF}`);
  assert.deepEqual(r.data.follow_ups.map((f) => [f.party_id, f.overdue]), [[ids.a, true]]);
  assert.equal(r.data.follow_ups[0].balance, E(10500));
  const home = await admin.get(`/api/reports/home?as_of=${AS_OF}`);
  assert.equal(home.data.counters.follow_ups_due, 1);
  assert.equal(home.data.follow_ups_due.length, 1);

  r = await admin.get(`/api/reports/followups?party_id=${ids.a}&status=all&as_of=${AS_OF}`);
  assert.equal(r.data.summary.last_payment_date, '2026-10-01');
  assert.equal(r.data.summary.debt_age_days, 122);

  r = await admin.post(`/api/reports/followups/${first.id}/done`, { next_date: '2026-11-31' });
  assert.equal(r.status, 400, 'next date must be real');
  r = await admin.post(`/api/reports/followups/${first.id}/done`, { next_date: '2026-11-07', next_note: 'يتصل بيه تاني' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.done.done, 1);
  assert.equal(r.data.next.next_date, '2026-11-07');
  assert.equal((await admin.post(`/api/reports/followups/${first.id}/done`, {})).status, 409);

  r = await admin.patch(`/api/reports/followups/${r.data.next.id}`, { note: 'يتصل بيه السبت', next_date: '2026-11-08' });
  assert.equal(r.status, 200);
  assert.equal(r.data.follow_up.next_date, '2026-11-08');
  assert.equal((await admin.patch(`/api/reports/followups/${r.data.follow_up.id}`, { next_date: '2026-11-31' })).status, 400);
  const del = await admin.del(`/api/reports/followups/${r.data.follow_up.id}`);
  assert.equal(del.status, 200);
  assert.equal((await admin.patch(`/api/reports/followups/${r.data.follow_up.id}`, { note: 'x' })).status, 404);

  const actions = getDb().prepare("SELECT action FROM audit_log WHERE entity = 'follow_up' ORDER BY id").all().map((x) => x.action);
  assert.deepEqual(actions, ['create', 'create', 'done', 'create', 'update', 'delete']);
});

test('reports without money.view: follow-ups without balances, partners hidden', async () => {
  const r = await viewer.get(`/api/reports/followups?status=all&party_id=${ids.a}&as_of=${AS_OF}`);
  assert.equal(r.status, 200);
  assert.ok(r.data.follow_ups.length >= 1);
  assertNoMoney(r.data, 'follow-ups for a user without money.view');
  assert.equal(r.data.summary, undefined);
  assert.equal((await viewer.post('/api/reports/followups', { party_id: ids.p, note: 'شريك' })).status, 403);
});

// ---------- سجل التعديلات ----------
test('audit viewer: filters for the admin; the operations side only, without money or text, otherwise', async () => {
  let r = await admin.get('/api/reports/audit?entity=txn&action=reverse');
  assert.equal(r.status, 200);
  assert.ok(r.data.entries.length >= 2);
  assert.ok(r.data.entries.every((e) => e.entity === 'txn' && e.action_name === 'إلغاء بقيد عكسي'));
  assert.ok(r.data.entries.some((e) => e.after.reason === 'اتسجلت غلط'));
  r = await admin.get('/api/reports/audit?limit=2');
  assert.equal(r.data.entries.length, 2);
  assert.equal(r.data.more, true);
  const next = await admin.get(`/api/reports/audit?limit=2&before_id=${r.data.next_before_id}`);
  assert.ok(next.data.entries[0].id < r.data.entries[1].id + 1);
  r = await admin.get(`/api/reports/audit?q=${encodeURIComponent('اتسجلت غلط')}`);
  assert.ok(r.data.entries.length >= 1);
  assert.equal((await admin.get('/api/reports/audit?from=2026-02-30')).status, 400);

  const today = new Date().toISOString().slice(0, 10);
  r = await viewer.get(`/api/reports/audit?to=${today}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.money_hidden, true);
  assert.ok(r.data.entries.length >= 1);
  assert.ok(r.data.entries.every((e) => ['op_sheet', 'op_line', 'sheet', 'work_order', 'photo_job', 'technician', 'material', 'follow_up', 'party'].includes(e.entity)));
  assertNoMoney(r.data, 'audit for a user without money.view');
  assert.equal(JSON.stringify(r.data).includes('وعد يدفع'), false, 'free text hidden');
  assert.equal((await viewer.get('/api/reports/audit?entity=txn')).data.entries.length, 0);
  // Searching the JSON would reveal amounts by elimination: without money.view it only matches the kind.
  assert.equal((await viewer.get('/api/reports/audit?q=10500')).data.entries.length, 0);
  const f = await viewer.get('/api/reports/audit/filters');
  assert.equal(f.data.entities.some((e) => e.code === 'txn'), false);
  const fa = await admin.get('/api/reports/audit/filters');
  assert.ok(fa.data.entities.some((e) => e.code === 'txn' && e.name === 'قيد'));
});
