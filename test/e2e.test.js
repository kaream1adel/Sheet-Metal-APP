// End to end, over HTTP, on a throw-away data folder: the whole product working together.
// Setup admin + staff → clients / partner / supplier → staff enters a press, a laser (single
// piece, minimum charge) and a punch sheet (louvers + factory material) → the review gate
// (red blocks, yellow must be visited) → اعتماد → the admin prices with suggested and edited
// rates and posts → statements (one مدين per sheet) → cash receipt, client cheque (portfolio →
// collected), expense split general / client with recharge, partner deposit, partner-paid
// expense, supplier purchase on credit, cash → bank transfer, cash count → المركز المالي is the
// sum of its parts, the trial balance balances, ملخص العملاء and جاري الشركاء agree with the
// ledger, and staff never receives a money field from ANY GET endpoint it can call.
// All names are invented.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, client } from './helpers.js';
import { isMoneyKey, formatMoney } from '../src/money.js';

let app;
let admin;
let staff;
let db;
let L;
const ids = {};
const E = (egp) => Math.round(egp * 1000); // EGP → millimes

const ok = (r, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.data));
  return r.data;
};
const keys = (v, out = new Set()) => {
  if (Array.isArray(v)) v.forEach((x) => keys(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keys(x, out); }
  return out;
};
const count = (sql, ...a) => db().prepare(sql).get(...a).n;

before(async () => {
  app = await startApp();
  ({ getDb: db } = await import('../src/db.js'));
  L = await import('../src/ledger.js');
  admin = client(app.base);
  staff = client(app.base);
});
after(() => app.stop());

test('setup: admin, staff, technicians, clients, partner, supplier', async () => {
  const s = ok(await admin.get('/api/session'));
  assert.equal(s.needsSetup, true);
  ok(await admin.post('/api/setup', { username: 'owner', display_name: 'المالك التجريبي', password: 'secret1' }), 201);
  ok(await admin.post('/api/users', { username: 'manager', display_name: 'مدير الورشة التجريبي', password: 'secret2', role: 'staff' }), 201);
  ok(await staff.post('/api/login', { username: 'manager', password: 'secret2' }));
  const me = ok(await staff.get('/api/session')).user;
  assert.ok(!me.permissions.includes('money.view'));

  const tech = async (name, machine) => ok(await staff.post('/api/technicians', { name, machine }), 201).technician.id;
  ids.tPress = await tech('فني تناية تجريبي', 'press');
  ids.tLaser = await tech('فني ليزر تجريبي', 'laser');
  ids.tPunch = await tech('فني بنش تجريبي', 'punch');

  const party = async (who, kind, name) => ok(await who.post('/api/parties', { kind, name, force: true }), 201).party.id;
  ids.A = await party(staff, 'client', 'ورشة النور التجريبية');
  ids.B = await party(admin, 'client', 'مصنع الأمل التجريبي');
  ids.partner = await party(admin, 'partner', 'شريك تجريبي أول');
  ids.supplier = await party(admin, 'supplier', 'مورد صاج تجريبي');

  // الأسعار العامة: the suggestions the admin starts from
  ok(await admin.put('/api/pricing/general', {
    prices: [
      { section: 'press', band: '<3', rate: '2' }, { section: 'press', band: '>=3', rate: '3' },
      { section: 'laser', band: '', rate: '5', min_charge: '150' }, { section: 'punch', band: '', rate: '4', min_charge: '150' },
      { section: 'louver', band: '', rate: '1.5' }, { section: 'material', band: '', rate: '40' },
    ],
  }));
  ok(await admin.post('/api/treasury/opening', { account: 'cash', amount: '10000', date: '2026-10-01' }), 201);
});

test('staff enters three sheets; the review gate: red blocks, yellow must be visited; then اعتماد', async () => {
  // التناية: one unknown client (red), one technician total that does not add up (yellow)
  let r = ok(await staff.post('/api/operations/sheets', {
    machine: 'press', technician_id: ids.tPress, sheet_date: '2026-10-05', submit: true,
    lines: [
      { part_name: 'جنب', client_text: 'ورشة النور التجريبية', material_text: '2م اسود', pieces: '١٠', per_piece: '٣', total_written: '٣٠' },
      { part_name: 'ركنة', client_text: 'عميل مش متسجل', material_text: '~', pieces: 2, per_piece: 1, total_written: 2, ditto_fields: ['material_text'] },
      { part_name: 'باب', client_text: 'مصنع الأمل التجريبي', material_text: '4م مجلفن', pieces: 5, per_piece: 2, total_written: 11 },
    ],
  }), 201);
  let s = r.sheet;
  ids.press = s.id;
  assert.match(s.serial, /^تش-\d{4}$/);
  assert.equal(s.view_status, 'review');
  assert.ok(s.issues.some((i) => i.level === 'red' && i.code === 'no_client'));
  assert.ok(s.issues.some((i) => i.level === 'yellow' && i.code === 'total_mismatch'));
  let a = await staff.post(`/api/operations/sheets/${s.id}/approve`);
  assert.equal(a.status, 409, 'red blocks the approval');
  // fix the red: pick the client
  const lines = s.lines.map((l) => ({ ...l }));
  lines[1].client_id = ids.A;
  lines[1].client_text = 'ورشة النور التجريبية';
  s = ok(await staff.put(`/api/operations/sheets/${s.id}`, { lines })).sheet;
  assert.equal(s.counts.red, 0);
  assert.ok(s.counts.unseen > 0);
  a = await staff.post(`/api/operations/sheets/${s.id}/approve`);
  assert.equal(a.status, 409, 'an unvisited yellow blocks the approval');
  ok(await staff.post(`/api/operations/sheets/${s.id}/ack`, { keys: s.issues.filter((i) => i.level === 'yellow' && !i.acked).map((i) => i.key) }));
  s = ok(await staff.post(`/api/operations/sheets/${s.id}/approve`)).sheet;
  assert.equal(s.status, 'approved');

  // الليزر: one piece cut from one sheet (minimum charge)
  const visitAndApprove = async (sheet) => {
    const yellow = sheet.issues.filter((i) => i.level === 'yellow' && !i.acked).map((i) => i.key);
    assert.equal(sheet.counts.red, 0, JSON.stringify(sheet.issues));
    if (yellow.length) ok(await staff.post(`/api/operations/sheets/${sheet.id}/ack`, { keys: yellow }));
    return ok(await staff.post(`/api/operations/sheets/${sheet.id}/approve`)).sheet;
  };
  r = ok(await staff.post('/api/operations/sheets', {
    machine: 'laser', technician_id: ids.tLaser, sheet_date: '2026-10-06', submit: true,
    lines: [{ part_name: 'شعار', client_text: 'ورشة النور التجريبية', material_text: 'مجلفن 2م', sheets: '1', start_time: '10 دقيقة', single_piece: true }],
  }), 201);
  ids.laser = r.sheet.id;
  assert.equal(r.sheet.lines[0].minutes_per_sheet, 10);
  assert.equal((await visitAndApprove(r.sheet)).status, 'approved');

  // البنش: minutes, louvers, and the sheet metal from our stock (factory material)
  r = ok(await staff.post('/api/operations/sheets', {
    machine: 'punch', technician_id: ids.tPunch, sheet_date: '2026-10-07', submit: true,
    lines: [{
      part_name: 'غطا', client_text: 'مصنع الأمل التجريبي', material_text: '١٫٥م اسود', pieces: 10, sheets: 2, start_time: '5 دقيقة',
      louvers_per_piece: 4, material_source: 'خامة المصنع', length_cm: 100, width_cm: 50,
    }],
  }), 201);
  ids.punch = r.sheet.id;
  assert.equal(r.sheet.lines[0].thickness, 1.5);
  assert.equal(r.sheet.lines[0].material_source, 'factory');
  assert.equal((await visitAndApprove(r.sheet)).status, 'approved');

  // staff sees the sheets with quantities only
  for (const id of [ids.press, ids.laser, ids.punch]) {
    const v = ok(await staff.get(`/api/operations/sheets/${id}`));
    assert.deepEqual([...keys(v)].filter(isMoneyKey), []);
  }
});

test('pricing reads the approved sheets: suggested and edited rates, min charge, louver and material items; post', async () => {
  const q = ok(await admin.get('/api/pricing/queue'));
  const queued = q.groups.flatMap((g) => g.sheets.map((s) => s.id));
  for (const id of [ids.press, ids.laser, ids.punch]) assert.ok(queued.includes(id), `sheet ${id} waits for pricing`);
  assert.equal(ok(await admin.get('/api/pricing/waiting-count')).sheets, 3);
  // the admin home counts the same queues: a draft the manager is still typing is not «in review»
  ok(await staff.post('/api/operations/sheets', { machine: 'shear', technician_id: ids.tPress, sheet_date: '2026-10-08', lines: [] }), 201);
  const counters = ok(await admin.get('/api/reports/home?as_of=2026-10-08')).counters;
  assert.deepEqual([counters.sheets_waiting_pricing, counters.sheets_in_review], [3, 0]);
  const staffHome = ok(await staff.get('/api/operations/home'));
  assert.deepEqual([...keys(staffHome)].filter(isMoneyKey), []);
  assert.equal((await staff.get('/api/pricing/queue')).status, 403);

  const items = (data, clientId) => data.clients.find((c) => c.client.id === clientId).items;
  // التناية: A 30 + 2 bends at 2 (< 3 mm), B 10 bends suggested 3 (≥ 3 mm), edited to 3.5
  let p = ok(await admin.get(`/api/pricing/sheets/${ids.press}`));
  const pa = items(p, ids.A);
  assert.deepEqual(pa.map((i) => [i.section, i.qty, i.rate, i.rate_source]), [['press', 30, E(2), 'general'], ['press', 2, E(2), 'general']]);
  const pb = items(p, ids.B);
  assert.deepEqual(pb.map((i) => [i.section, i.qty, i.rate]), [['press', 10, E(3)]]);
  const edited = ok(await admin.patch(`/api/pricing/items/${pb[0].id}`, { rate: '3.5' })).item;
  assert.equal(edited.amount, E(35));
  assert.equal(edited.rate_source, 'manual');
  ok(await admin.post(`/api/pricing/sheets/${ids.press}/confirm`, {}));
  const posted = ok(await admin.post(`/api/pricing/sheets/${ids.press}/post`, {}), 201);
  assert.equal(posted.batches.length, 2, 'one batch per client');
  assert.equal(posted.priced_status, 'posted');

  // الليزر: 1 sheet × 10 min + 1 = 11 min × 5 = 55 → the 150 minimum (single piece)
  p = ok(await admin.get(`/api/pricing/sheets/${ids.laser}`));
  const la = items(p, ids.A)[0];
  assert.deepEqual([la.section, la.qty, la.amount], ['laser', 11, E(150)]);
  ok(await admin.post(`/api/pricing/sheets/${ids.laser}/confirm`, {}));
  ok(await admin.post(`/api/pricing/sheets/${ids.laser}/post`, {}), 201);

  // البنش: 2 × 5 + 2 = 12 min × 4 = 48; louvers 10 × 4 = 40 × 1.5 = 60;
  // material 1.5/10 × 100 × 50 × 2 sheets × 7.85 / 1000 = 11.775 kg × 40 = 471; discount 9
  p = ok(await admin.get(`/api/pricing/sheets/${ids.punch}`));
  const pu = items(p, ids.B);
  assert.deepEqual(pu.map((i) => [i.section, i.qty, i.amount]), [['punch', 12, E(48)], ['louver', 40, E(60)], ['material', 11.775, E(471)]]);
  ok(await admin.put(`/api/pricing/sheets/${ids.punch}/adjustments`, { client_id: ids.B, discount: '9', note: 'خصم تجريبي' }));
  ok(await admin.post(`/api/pricing/sheets/${ids.punch}/confirm`, {}));
  ok(await admin.post(`/api/pricing/sheets/${ids.punch}/post`, {}), 201);
  assert.equal(ok(await admin.get('/api/pricing/waiting-count')).sheets, 0);

  // «إلغاء الورقة» and «تصحيح» are refused once the sheet is posted
  let r = await staff.post(`/api/operations/sheets/${ids.punch}/cancel`, { reason: 'تجربة الإلغاء' });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /اترحّل|اتسعرت/);
  assert.equal((await staff.post(`/api/operations/sheets/${ids.press}/correct`, { reason: 'تجربة' })).status, 409);
});

test('statements: one مدين line per priced sheet per client, the discount in خصم', async () => {
  const a = ok(await admin.get(`/api/parties/${ids.A}/statement`));
  assert.deepEqual(a.rows.map((x) => [x.doc_type, x.debit]), [['pricing_batch', E(64)], ['pricing_batch', E(150)]]);
  assert.match(a.rows[0].description, /بيان أعمال التناية — ورقة تش-\d{4} — 5\/10\/2026/);
  assert.equal(a.closing, E(214));
  const b = ok(await admin.get(`/api/parties/${ids.B}/statement`));
  assert.deepEqual(b.rows.map((x) => [x.debit, x.discount]), [[E(35), 0], [E(579), 0], [0, E(9)]]);
  assert.equal(b.closing, E(605));
  assert.equal(b.closing_text, 'لنا عنده 605.00');
  // the client's شيت التسعير: staff gets quantities only
  const sheet = ok(await staff.get(`/api/pricing/clients/${ids.B}/sheet`));
  assert.deepEqual([...keys(sheet)].filter(isMoneyKey), []);
  // staff's كشف الحساب: no free text, so every row is named by its kind, and a priced row
  // carries its operation sheet (the بيان أعمال screen is money.view only)
  const sb = ok(await staff.get(`/api/parties/${ids.B}/statement`));
  assert.deepEqual(sb.rows.map((x) => x.kind_name), ['بيان أعمال', 'بيان أعمال', 'خصم']);
  assert.ok(sb.rows.every((x) => !('description' in x) && !('reason' in x)));
  for (const r of sb.rows.filter((x) => x.doc_type === 'pricing_batch')) {
    assert.equal(r.sheet_id, ok(await admin.get(`/api/pricing/batches/${r.doc_id}`)).sheet.id);
  }
});

test('treasury: receipt, cheque portfolio → collected, split expense with recharge, partner, supplier credit, transfer, count', async () => {
  // A pays 100 cash
  const rc = ok(await admin.post('/api/treasury/receipts', { party_id: ids.A, date: '2026-10-10', amount: '100', method: 'cash' }), 201).receipt;
  assert.match(rc.serial, /^قب-\d{4}$/);

  // B gives a cheque of 200: «تحت التحصيل» until collected, no posting
  const ch = ok(await admin.post('/api/treasury/receipts', {
    party_id: ids.B, date: '2026-10-11', amount: '200', method: 'cheque', cheque: { number: 'T-1001', bank: 'بنك تجريبي', due_date: '2026-10-20' },
  }), 201).receipt;
  const chequeId = ch.cheque_id ?? ch.cheque.id;
  let st = ok(await admin.get(`/api/parties/${ids.B}/statement`));
  assert.equal(st.closing, E(605), 'a cheque in the portfolio does not move the balance');
  assert.equal(st.pending_cheques.length, 1);
  assert.equal(st.pending_cheques_amount, E(200));
  const home = ok(await admin.get('/api/reports/home?as_of=2026-10-12'));
  assert.equal(home.position.ours.find((l) => l.key === 'cheques_in').amount, E(200));
  ok(await admin.post(`/api/treasury/cheques/${chequeId}/deposit`, { date: '2026-10-20' }));
  // the held cheque is already inside B's receivable: shown as a memo line, never summed,
  // so collecting it (Dr bank / Cr receivable) leaves صافي المركز exactly where it was
  const held = ok(await admin.get('/api/reports/home?as_of=2026-10-21')).position;
  assert.equal(held.ours.find((l) => l.key === 'cheques_in').amount, E(200));
  assert.equal(held.net_total, held.ours.filter((l) => !l.memo).reduce((s, l) => s + l.amount, 0)
    + held.cash_balance + held.bank_balance - held.theirs_total);
  const collected = ok(await admin.post(`/api/treasury/cheques/${chequeId}/collect`, { date: '2026-10-21' })).cheque;
  assert.equal(collected.status, 'collected');
  const cleared = ok(await admin.get('/api/reports/home?as_of=2026-10-21')).position;
  assert.equal(cleared.ours.find((l) => l.key === 'cheques_in').amount, 0);
  assert.equal(cleared.bank_balance, held.bank_balance + E(200));
  assert.equal(cleared.net_total, held.net_total, 'collecting a held cheque does not change the position');
  // as of the day before, the cheque was still held (the position is dated)
  assert.equal(ok(await admin.get('/api/reports/home?as_of=2026-10-20')).position.ours.find((l) => l.key === 'cheques_in').amount, E(200));
  st = ok(await admin.get(`/api/parties/${ids.B}/statement`));
  assert.equal(st.closing, E(405));
  assert.equal(st.pending_cheques.length, 0);

  // expense 130 from cash: 80 general + 50 on A, charged to him («يتحمّل على العميل»)
  const v = ok(await admin.post('/api/treasury/vouchers', {
    kind: 'expense', date: '2026-10-12', paid_from: 'cash', description: 'دهان تجريبي',
    lines: [{ category_id: 6, amount: '80' }, { category_id: 6, amount: '50', cost_party_id: ids.A, recharge: true }],
  }), 201).voucher;
  assert.equal(v.total, E(130));
  assert.equal(L.partyBalance(ids.A), E(214 - 100 + 50));

  // partner puts 5,000 in the bank, and pays the 1,000 rent from his pocket
  ok(await admin.post('/api/treasury/receipts', { party_id: ids.partner, date: '2026-10-02', amount: '5000', method: 'transfer' }), 201);
  ok(await admin.post('/api/treasury/vouchers', {
    kind: 'expense', date: '2026-10-03', paid_from: 'partner', paid_from_party_id: ids.partner, lines: [{ category_id: 2, amount: '1000' }],
  }), 201);
  assert.equal(L.partyBalance(ids.partner), -E(6000));

  // sheet metal bought on credit: 3 × 250
  const pv = ok(await admin.post('/api/treasury/vouchers', {
    kind: 'material_purchase', date: '2026-10-04', paid_from: 'supplier_credit', party_id: ids.supplier,
    items: [{ material_id: 1, qty: '3', unit: 'لوح', unit_rate: '250' }],
  }), 201).voucher;
  assert.equal(pv.total, E(750));
  assert.equal(L.partyBalance(ids.supplier), -E(750));

  // 2,000 from the cash box to the bank
  ok(await admin.post('/api/treasury/transfers', { date: '2026-10-15', from_account: 'cash', to_account: 'bank', amount: '2000' }), 201);

  // جرد الخزينة: 10 short, with a reason
  const exp = ok(await admin.get('/api/treasury/counts/expected?account=cash&date=2026-10-31')).expected;
  assert.equal(exp, E(10000 + 100 - 130 - 2000));
  ok(await admin.post('/api/treasury/counts', { account: 'cash', date: '2026-10-31', counted: (exp - E(10)) / 1000, notes: 'فكة ناقصة' }), 201);
  assert.equal(L.balance('cash'), E(7960));
  assert.equal(L.balance('bank'), E(7200));

  // a date that does not exist is refused everywhere money moves
  for (const [url, body] of [
    ['/api/treasury/receipts', { party_id: ids.A, date: '2026-02-31', amount: '1', method: 'cash' }],
    ['/api/treasury/transfers', { date: '2026-13-40', from_account: 'cash', to_account: 'bank', amount: '1' }],
    ['/api/pricing/manual', { client_id: ids.A, kind: 'debit', date: '2026-04-31', amount: '1', description: 'تجربة' }],
  ]) {
    const r = await admin.post(url, body);
    assert.equal(r.status, 400, `${url} ${JSON.stringify(r.data)}`);
    assert.equal(r.data.field, 'date');
  }
});

test('المركز المالي is the sum of its parts and agrees with the ledger; trial balance balances', async () => {
  const r = ok(await admin.get('/api/reports/home?as_of=2026-10-31'));
  const p = r.position;
  const line = (list, key) => list.find((l) => l.key === key)?.amount ?? 0;
  assert.equal(line(p.ours, 'receivables'), E(164 + 405));
  assert.equal(line(p.ours, 'cheques_in'), 0);
  assert.equal(line(p.theirs, 'partners'), E(6000));
  assert.equal(line(p.theirs, 'suppliers'), E(750));
  assert.equal(p.ours_total, p.ours.reduce((s, l) => s + l.amount, 0));
  assert.equal(p.theirs_total, p.theirs.reduce((s, l) => s + l.amount, 0));
  assert.equal(p.cash_balance, E(7960));
  assert.equal(p.bank_balance, E(7200));
  assert.equal(p.net_total, p.ours_total + p.cash_balance + p.bank_balance - p.theirs_total);
  assert.equal(p.net_total, E(569 + 7960 + 7200 - 6750));

  // trial balance: every txn and the whole ledger balance
  assert.deepEqual(db().prepare('SELECT txn_id FROM postings GROUP BY txn_id HAVING SUM(debit) <> SUM(credit)').all(), []);
  const tb = L.accountBalances();
  assert.equal(tb.reduce((s, a) => s + a.debit, 0), tb.reduce((s, a) => s + a.credit, 0));
  assert.equal(tb.reduce((s, a) => s + a.balance, 0), 0);
  // the net position = what the business earned + what was put in (revenue, expenses, equity)
  const bal = Object.fromEntries(db().prepare('SELECT account, SUM(debit) - SUM(credit) b FROM postings GROUP BY account').all().map((x) => [x.account, x.b]));
  const pnl = Object.entries(bal).filter(([k]) => /^(revenue:|expense:|discount_given|materials_purchases|cash_over_short|opening_equity)/.test(k))
    .reduce((s, [, b]) => s + b, 0);
  assert.equal(p.net_total - line(p.ours, 'cheques_in'), -pnl);
  assert.equal(bal['revenue:press'], -E(99));
  assert.equal(bal['revenue:laser'], -E(150));
  assert.equal(bal['revenue:louver'], -E(60));
  assert.equal(bal['revenue:material'], -E(471));
  assert.equal(bal['revenue:recharge'], -E(50));
  assert.equal(bal.discount_given, E(9));
  assert.equal(bal.cash_over_short, E(10));
});

test('ملخص العملاء and جاري الشركاء agree with the ledger', async () => {
  const c = ok(await admin.get('/api/reports/clients?as_of=2026-10-31'));
  const a = c.rows.find((x) => x.id === ids.A);
  const b = c.rows.find((x) => x.id === ids.B);
  assert.deepEqual([a.debit_total, a.discount_total, a.credit_total, a.balance], [E(264), 0, E(100), E(164)]);
  assert.deepEqual([b.debit_total, b.discount_total, b.credit_total, b.balance], [E(614), E(9), E(200), E(405)]);
  assert.equal(b.balance_text, 'لنا عنده 405.00');
  for (const row of c.rows) assert.equal(row.balance, L.partyBalance(row.id), row.name);
  assert.equal(c.totals.balance, E(569));
  assert.equal(c.totals.debit_total - c.totals.discount_total - c.totals.credit_total, c.totals.balance);

  const pr = ok(await admin.get('/api/reports/partners'));
  const p = pr.rows.find((x) => x.id === ids.partner);
  assert.deepEqual([p.paid_total, p.taken_total, p.net_amount, p.balance_text], [E(6000), 0, E(6000), 'له عندنا 6,000.00']);
  assert.equal(pr.totals.net_amount, E(6000));

  // الإنتاج: the manager reads it, with quantities only
  const prod = ok(await staff.get('/api/reports/production?group=machine&from=2026-10-01&to=2026-10-31'));
  assert.deepEqual([...keys(prod)].filter(isMoneyKey), []);
});

// Every GET route the app has, read from the routers themselves (so a new endpoint is crawled too).
async function allGetPaths() {
  const mounts = [
    ['/api', 'users'], ['/api', 'parties'], ['/api', 'lookups'], ['/api', 'system'],
    ['/api/operations', 'operations'], ['/api/pricing', 'pricing'], ['/api/treasury', 'treasury'],
    ['/api/reports', 'reports'], ['/api/import', 'import'],
  ];
  const out = new Set(['/api/session', '/api/audit']);
  for (const [prefix, file] of mounts) {
    const mod = await import(`../src/routes/${file}.js`);
    const router = Object.values(mod).find((x) => typeof x === 'function' && Array.isArray(x.stack));
    for (const layer of router.stack) {
      if (layer.route?.methods?.get && typeof layer.route.path === 'string') out.add(prefix + layer.route.path);
    }
  }
  return [...out];
}

test('staff never receives money: crawl every GET endpoint it can call and scan keys and values', async () => {
  // the manager records an expense voucher himself (he may), and gets it back without amounts
  const sv = ok(await staff.post('/api/treasury/vouchers', {
    kind: 'expense', date: '2026-10-20', paid_from: 'cash', description: 'كهربا تجريبي', lines: [{ category_id: 3, amount: '120' }],
  }), 201).voucher;
  assert.match(sv.serial, /^صر-[0-9]{4}$/);
  assert.deepEqual([...keys(sv)].filter(isMoneyKey), []);
  assert.equal(L.balance('cash'), E(7960 - 120));

  const paths = await allGetPaths();
  assert.ok(paths.length > 50, `found ${paths.length} GET routes`);
  const maxId = Math.max(...['parties', 'op_sheets', 'op_lines', 'price_items', 'receipts', 'vouchers', 'cheques', 'transfers',
    'cash_counts', 'work_orders', 'pricing_batches', 'manual_entries', 'photo_jobs', 'technicians', 'users']
    .map((t) => count(`SELECT COALESCE(MAX(id), 0) n FROM ${t}`)));
  const urls = new Set();
  for (const p of paths) {
    if (!p.includes(':')) { urls.add(p); continue; }
    for (let i = 1; i <= Math.max(maxId, 3); i++) urls.add(p.replace(/:id\b/g, String(i)).replace(/:[a-z_]+/g, 'x'));
  }
  // list filters that change what comes back
  for (const k of ['client', 'supplier', 'partner', 'worker']) urls.add(`/api/parties?kind=${k}`);
  for (const g of ['machine', 'technician', 'client', 'month']) urls.add(`/api/reports/production?group=${g}&from=2026-10-01&to=2026-10-31`);
  urls.add('/api/operations/production?from=2026-10-01&to=2026-10-31');
  urls.add('/api/operations/sheets?status=approved');
  urls.add('/api/treasury/vouchers?mine=1');
  urls.add('/api/parties/similar?kind=client&name=ورشة');
  urls.add('/api/operations/clients/match?text=النور');

  // every money figure in the ledger and the documents, as a number and as written
  const amounts = new Set();
  const addAmount = (v) => { if (Number.isSafeInteger(v) && Math.abs(v) >= 100000) amounts.add(Math.abs(v)); };
  for (const r of db().prepare('SELECT debit, credit FROM postings').all()) { addAmount(r.debit); addAmount(r.credit); }
  for (const r of db().prepare('SELECT amount, rate FROM price_items').all()) { addAmount(r.amount); addAmount(r.rate); }
  for (const t of ['receipts', 'cheques']) for (const r of db().prepare(`SELECT amount FROM ${t}`).all()) addAmount(r.amount);
  for (const k of ['client', 'supplier', 'partner']) for (const b of Object.values(L.partyBalances(k))) addAmount(b);
  addAmount(L.balance('cash'));
  addAmount(L.balance('bank'));
  const written = [...amounts].map((v) => formatMoney(v));

  const crawl = async (who) => {
  let scanned = 0;
  const leaks = [];
  for (const u of urls) {
    const res = await fetch(app.base + encodeURI(u), { headers: { cookie: who.cookie } });
    if (res.status !== 200 || !/json/.test(res.headers.get('content-type') || '')) continue;
    const data = await res.json();
    scanned++;
    const badKeys = [...keys(data)].filter(isMoneyKey);
    if (badKeys.length) leaks.push(`${u}: keys ${badKeys.join(', ')}`);
    const walk = (v, where) => {
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${where}[${i}]`));
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${where}.${k}`);
      else if (typeof v === 'number' && amounts.has(Math.abs(v))) leaks.push(`${u}: ${where} = ${v}`);
      else if (typeof v === 'string') {
        if (/لنا عنده|له عندنا/.test(v)) leaks.push(`${u}: ${where} says a balance`);
        const hit = written.find((w) => v.includes(w));
        if (hit) leaks.push(`${u}: ${where} contains ${hit}`);
      }
    };
    walk(data, '');
  }
  return { scanned, leaks };
  };
  // the scanner itself works: as the admin it finds the money
  const asAdmin = await crawl(admin);
  assert.ok(asAdmin.leaks.length > 50, `the scanner sees money for the admin (${asAdmin.leaks.length})`);
  const { scanned, leaks } = await crawl(staff);
  assert.ok(scanned > 30, `staff could read ${scanned} endpoints`);
  console.log(`crawl: ${urls.size} urls, staff read ${scanned}, admin leaks found ${asAdmin.leaks.length}`);
  assert.deepEqual(leaks, []);
  // and the money screens themselves are closed to staff
  for (const u of ['/api/reports/home', '/api/reports/clients', '/api/treasury/summary', '/api/pricing/queue', '/api/audit']) {
    assert.equal((await staff.get(u)).status, 403, u);
  }
});
