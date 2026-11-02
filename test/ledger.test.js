// The ledger: balanced atomic postings, reversal, balances, the statement columns
// (مدين / خصم / دائن / الرصيد), month lock and serial numbers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safa-ledger-'));
process.env.SHEETMETAL_DATA = dir;
const { openDb, closeDb, getDb } = await import('../src/db.js');
const L = await import('../src/ledger.js');

let client;
let client2;
let supplier;
let partner;
let userId;

const addParty = (kind, name) => Number(getDb().prepare('INSERT INTO parties (kind, name) VALUES (?, ?)').run(kind, name).lastInsertRowid);
const count = (t) => getDb().prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;

before(() => {
  openDb();
  userId = Number(getDb().prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('u','u','x','admin')").run().lastInsertRowid);
  client = addParty('client', 'ورشة النور التجريبية');
  client2 = addParty('client', 'مصنع الأمل التجريبي');
  supplier = addParty('supplier', 'مورد صاج تجريبي');
  partner = addParty('partner', 'شريك تجريبي');
});
after(() => { closeDb(); fs.rmSync(dir, { recursive: true, force: true }); });

const work = (amount, date = '2026-10-05', party = client) => L.post('pricing', date, 'بيان أعمال التناية', [
  { account: 'receivable', party_id: party, debit: amount },
  { account: 'revenue:press', credit: amount, section: 'press' },
], { userId, partyId: party, ref: 'تس-0001' });

test('serial numbers count per prefix with Arabic prefixes', () => {
  assert.equal(L.nextSerial('تش'), 'تش-0001');
  assert.equal(L.nextSerial('تش'), 'تش-0002');
  assert.equal(L.nextSerial('قب'), 'قب-0001');
  assert.throws(() => L.nextSerial('xx'));
});

test('post writes a balanced transaction with postings and an audit row', () => {
  const t = work(12345670);
  assert.match(t.serial, /^قد-\d{4}$/);
  assert.equal(t.status, 'posted');
  assert.equal(t.postings.length, 2);
  assert.equal(t.total, 12345670);
  assert.equal(L.balance('receivable', client), 12345670);
  assert.equal(L.balance('revenue:press'), -12345670);
  assert.ok(getDb().prepare("SELECT 1 FROM audit_log WHERE entity = 'txn' AND entity_id = ?").get(t.id));
});

test('unbalanced, zero, negative, float or wrong-party postings are refused and write nothing', () => {
  const before = [count('txns'), count('postings'), count('audit_log')];
  const bad = [
    [{ account: 'cash', debit: 100 }, { account: 'revenue:manual', credit: 90 }],
    [{ account: 'cash', debit: 0 }, { account: 'revenue:manual', credit: 0 }],
    [{ account: 'cash', debit: -5 }, { account: 'revenue:manual', credit: -5 }],
    [{ account: 'cash', debit: 1.5 }, { account: 'revenue:manual', credit: 1.5 }],
    [{ account: 'cash', debit: 100, credit: 100 }, { account: 'revenue:manual', credit: 0 }],
    [{ account: 'receivable', debit: 100 }, { account: 'revenue:manual', credit: 100 }],                  // no party
    [{ account: 'receivable', party_id: supplier, debit: 100 }, { account: 'revenue:manual', credit: 100 }], // wrong kind
    [{ account: 'cash', party_id: client, debit: 100 }, { account: 'revenue:manual', credit: 100 }],    // party on cash
    [{ account: 'nope', debit: 100 }, { account: 'revenue:manual', credit: 100 }],
    [{ account: 'cash', debit: 100 }],
  ];
  for (const lines of bad) assert.throws(() => L.post('manual', '2026-10-05', 'x', lines, { userId }), JSON.stringify(lines));
  assert.throws(() => L.post('manual', '2026-13-45', 'x', [{ account: 'cash', debit: 1 }, { account: 'bank', credit: 1 }]));
  assert.deepEqual([count('txns'), count('postings'), count('audit_log')], before);
});

test('an imbalance below a piastre is reported in millimes, not as 0.00 against 0.00', () => {
  assert.throws(() => L.post('manual', '2026-10-05', 'x', [{ account: 'cash', debit: 1 }, { account: 'revenue:manual', credit: 2 }], { userId }),
    (e) => e.status === 400 && e.message.includes('0.001') && e.message.includes('0.002'));
  assert.throws(() => L.post('manual', '2026-10-05', 'x', [{ account: 'cash', debit: 100000 }, { account: 'revenue:manual', credit: 90000 }], { userId }),
    (e) => e.message.includes('100.00') && e.message.includes('90.00'));
});

test('posting is atomic: a failure inside an outer transaction rolls everything back', () => {
  const before = [count('txns'), count('postings')];
  assert.throws(() => getDb().transaction(() => {
    work(1000);
    throw new Error('boom');
  })());
  assert.deepEqual([count('txns'), count('postings')], before);
});

test('reverse posts the mirror image, marks the original and keeps both', () => {
  const t = work(5000, '2026-10-06', client2);
  assert.equal(L.partyBalance(client2), 5000);
  assert.throws(() => L.reverse(t.id, ''), /سبب/);
  const r = L.reverse(t.id, 'سعر غلط', { userId, date: '2026-10-07' });
  assert.equal(r.reversal_of, t.id);
  assert.equal(r.kind, 'reversal');
  assert.equal(r.reason, 'سعر غلط');
  assert.equal(L.partyBalance(client2), 0);
  const orig = L.getTxn(t.id);
  assert.equal(orig.status, 'reversed');
  assert.equal(orig.reversed_by, r.id);
  assert.deepEqual(orig.postings.map((p) => [p.debit, p.credit]), [[5000, 0], [0, 5000]]); // never edited
  assert.throws(() => L.reverse(t.id, 'تاني'), /اتلغى/);
  assert.throws(() => L.reverse(r.id, 'إلغاء الإلغاء'), /قيد إلغاء/);
  assert.ok(getDb().prepare("SELECT 1 FROM audit_log WHERE action = 'reverse' AND entity_id = ?").get(t.id));
});

test('statement: مدين / خصم / دائن / الرصيد with running balance and wording', () => {
  const c = addParty('client', 'عميل كشف تجريبي');
  work(10000000, '2026-09-01', c);                     // 10,000 opening work
  work(2500500, '2026-10-02', c);                      // 2,500.50
  L.post('discount', '2026-10-03', 'خصم', [
    { account: 'discount_given', debit: 500500 },
    { account: 'receivable', party_id: c, credit: 500500 },
  ], { userId, partyId: c });
  L.post('receipt', '2026-10-04', 'إيصال استلام نقدية', [
    { account: 'cash', debit: 3000000 },
    { account: 'receivable', party_id: c, credit: 3000000 },
  ], { userId, partyId: c, ref: 'قب-0009' });
  const bad = work(700000, '2026-10-05', c);
  L.reverse(bad.id, 'اتسجل مرتين', { userId, date: '2026-10-05' });

  const s = L.statement(c, '2026-10-01', '2026-10-31');
  assert.equal(s.opening, 10000000);
  assert.equal(s.opening_text, 'لنا عنده 10,000.00');
  assert.deepEqual(s.rows.map((r) => [r.date, r.debit, r.discount, r.credit, r.balance]), [
    ['2026-10-02', 2500500, 0, 0, 12500500],
    ['2026-10-03', 0, 500500, 0, 12000000],
    ['2026-10-04', 0, 0, 3000000, 9000000],
    ['2026-10-05', 700000, 0, 0, 9700000],
    ['2026-10-05', 0, 0, 700000, 9000000],
  ]);
  assert.equal(s.rows[2].ref, 'قب-0009');
  assert.equal(s.rows[3].status, 'reversed');
  assert.ok(s.rows[4].reversal_of);
  assert.deepEqual(s.totals, { debit: 3200500, discount: 500500, credit: 3700000 });
  assert.equal(s.closing, 9000000);
  assert.equal(s.closing_text, 'لنا عنده 9,000.00');
  assert.equal(s.closing, L.partyBalance(c));

  const hidden = L.statement(c, '2026-10-01', '2026-10-31', { hideReversed: true });
  assert.equal(hidden.rows.length, 3);
  assert.equal(hidden.closing, 9000000);

  const all = L.statement(c);
  assert.equal(all.opening, 0);
  assert.equal(all.closing, 9000000);
});

test('balance wording: له عندنا for a supplier we owe, خالص when settled', () => {
  L.post('material_purchase', '2026-10-08', 'مشتريات صاج', [
    { account: 'materials_purchases', debit: 3210450 },
    { account: 'payable', party_id: supplier, credit: 3210450 },
  ], { userId });
  const s = L.statement(supplier);
  assert.equal(s.closing, -3210450);
  assert.equal(s.closing_text, 'له عندنا 3,210.45');
  assert.equal(s.rows[0].credit, 3210450);
  L.post('payment', '2026-10-09', 'دفعة', [
    { account: 'payable', party_id: supplier, debit: 3210450 },
    { account: 'bank', credit: 3210450 },
  ], { userId });
  assert.equal(L.statement(supplier).closing_text, 'خالص');
});

test('pending client cheques show as memo (تحت التحصيل) without changing the balance', () => {
  const c = addParty('client', 'عميل شيكات تجريبي');
  work(900000, '2026-10-10', c);
  getDb().prepare(`INSERT INTO cheques (serial, direction, party_id, number, amount, received_date, due_date, status)
    VALUES ('شك-9001', 'in', ?, '123', 400000, '2026-10-10', '2026-11-10', 'in_portfolio')`).run(c);
  const s = L.statement(c);
  assert.equal(s.closing, 900000);
  assert.equal(s.pending_cheques.length, 1);
  assert.equal(s.pending_cheques_amount, 400000);
});

test('accountBalances sums to zero and partyBalances groups by party', () => {
  const rows = L.accountBalances();
  assert.equal(rows.reduce((s, r) => s + r.balance, 0), 0);
  assert.ok(rows.find((r) => r.code === 'cash' && r.name === 'الخزينة'));
  const map = L.partyBalances('client');
  assert.equal(map[client], L.partyBalance(client));
});

test('month lock refuses postings in a locked month; unlock needs a reason', () => {
  L.lockMonth('2026-08', userId, 'اتراجع');
  assert.equal(L.isMonthLocked('2026-08-15'), true);
  assert.throws(() => L.lockMonth('2026-08', userId), /مقفول/);
  assert.throws(() => L.lockMonth('2026-8', userId), /الشهر/);
  const before = count('txns');
  assert.throws(() => work(1000, '2026-08-20'), (e) => e.status === 409 && /مقفول/.test(e.message));
  assert.equal(count('txns'), before);
  work(1000, '2026-09-01'); // the next month is open
  // Reversing a transaction from an open month into a locked date is refused too.
  const t = work(1000, '2026-09-02');
  assert.throws(() => L.reverse(t.id, 'x', { userId, date: '2026-08-31' }), /مقفول/);
  assert.equal(L.getTxn(t.id).status, 'posted');
  assert.throws(() => L.unlockMonth('2026-08', userId, ''), /سبب/);
  L.unlockMonth('2026-08', userId, 'تصحيح فاتورة');
  assert.equal(L.isMonthLocked('2026-08-15'), false);
  work(1000, '2026-08-20');
  const a = getDb().prepare("SELECT after_json FROM audit_log WHERE action = 'unlock'").get();
  assert.match(a.after_json, /تصحيح فاتورة/);
});

test('partner account and opening equity behave like any other party account', () => {
  L.post('partner_deposit', '2026-10-01', 'تغذية', [
    { account: 'bank', debit: 50000000 },
    { account: 'partner', party_id: partner, credit: 50000000 },
  ], { userId });
  assert.equal(L.statement(partner).closing_text, 'له عندنا 50,000.00');
});

test('hide reversed: a pair split by the range boundary stays, so the closing is the real balance', () => {
  const c = addParty('client', 'عميل الحدود التجريبي');
  const first = work(1000000, '2026-09-20', c);
  work(500000, '2026-10-05', c);
  L.reverse(first.id, 'اتسجل غلط', { userId, date: '2026-10-10' });
  const asOf = L.partyBalance(c, { asOf: '2026-10-31' });
  assert.equal(asOf, 500000);
  for (const hideReversed of [false, true]) {
    const s = L.statement(c, '2026-10-01', '2026-10-31', { hideReversed });
    assert.equal(s.closing, asOf, `hideReversed=${hideReversed}`);
    assert.equal(s.opening + s.totals.debit - s.totals.discount - s.totals.credit, s.closing);
    assert.equal(s.rows.at(-1).balance, s.closing);
    assert.equal(s.rows.length, 2); // the reversal shows: its original is in the opening
  }
  // The other way round: the original in range, its reversal after `to`.
  const c2 = addParty('client', 'عميل الحدود التاني');
  const t = work(300000, '2026-10-20', c2);
  L.reverse(t.id, 'غلط', { userId, date: '2026-11-02' });
  const s2 = L.statement(c2, '2026-10-01', '2026-10-31', { hideReversed: true });
  assert.equal(s2.closing, L.partyBalance(c2, { asOf: '2026-10-31' }));
  assert.equal(s2.closing, 300000);
  // Both halves in range: the pair is hidden and the balance is unchanged.
  const all = L.statement(c, null, null, { hideReversed: true });
  assert.equal(all.rows.length, 1);
  assert.equal(all.closing, L.partyBalance(c));
});

test('money columns refuse anything but integer millimes', () => {
  const d = getDb();
  assert.throws(() => d.prepare("INSERT INTO receipts (serial, date, party_id, amount, method) VALUES ('r1', '2026-10-01', ?, 1.5, 'cash')").run(client), /integer millimes/);
  assert.throws(() => d.prepare('UPDATE parties SET credit_limit = 2.5 WHERE id = ?').run(client), /integer millimes/);
  assert.throws(() => d.prepare("UPDATE general_prices SET rate = 'كتير'").run(), /integer millimes/);
  d.prepare('UPDATE parties SET credit_limit = 2500 WHERE id = ?').run(client);
  d.prepare('UPDATE parties SET credit_limit = NULL WHERE id = ?').run(client);
  d.prepare('UPDATE general_prices SET rate = 3.0 WHERE id = (SELECT MIN(id) FROM general_prices)').run(); // 3.0 is stored as 3
  d.prepare('UPDATE general_prices SET rate = NULL').run();
});

test('new expense categories get their own expense account', () => {
  const id = Number(getDb().prepare("INSERT INTO expense_categories (name) VALUES ('بند تجريبي')").run().lastInsertRowid);
  L.ensureExpenseAccount({ id, name: 'بند تجريبي', sort: 50 });
  const t = L.post('expense', '2026-10-11', 'مصروف', [
    { account: `expense:${id}`, debit: 1000, cost_party_id: client },
    { account: 'cash', credit: 1000 },
  ], { userId });
  assert.equal(t.postings[0].cost_party_id, client);
  assert.equal(L.partyBalance(client) > 0, true); // a cost center is not on his statement
});

test('post refuses a date that is not a real calendar day', async () => {
  const { post } = await import('../src/ledger.js');
  for (const d of ['2026-02-31', '2026-13-40']) {
    assert.throws(() => post('test', d, 'تجربة', [{ account: 'cash', debit: 1000 }, { account: 'opening_equity', credit: 1000 }]),
      (e) => e.status === 400, d);
  }
});
