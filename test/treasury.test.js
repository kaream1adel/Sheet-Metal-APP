// الخزينة والبنك، المصروفات، الشيكات over HTTP: every posting rule of the spec's Ledger section,
// balances through the ledger, cancel = reverse with a reason, month lock, real dates, and the
// workshop manager (staff) never receiving a money field. Invented names only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, client } from './helpers.js';
import { isMoneyKey } from '../src/money.js';

let app;
let admin;
let staff;
let db;
let ledger;
const P = {};
const TODAY = (() => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; })();
const addDays = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

function keys(v, out = new Set()) {
  if (Array.isArray(v)) v.forEach((x) => keys(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keys(x, out); }
  return out;
}
const assertNoMoney = (data, what) => {
  const leaked = [...keys(data)].filter(isMoneyKey);
  assert.deepEqual(leaked, [], `${what} leaked money: ${leaked.join(', ')}`);
};
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.data)); return r.data; };
const bal = (account, partyId = null) => ledger.balance(account, partyId);

before(async () => {
  app = await startApp();
  ({ getDb: db } = await import('../src/db.js'));
  ledger = await import('../src/ledger.js');
  admin = client(app.base);
  staff = client(app.base);
  await admin.post('/api/setup', { username: 'owner', display_name: 'المالك التجريبي', password: 'secret1' });
  ok(await admin.post('/api/users', { username: 'manager', display_name: 'مدير تجريبي', password: 'secret2', role: 'staff' }), 201);
  ok(await staff.post('/api/login', { username: 'manager', password: 'secret2' }));
  const mk = async (kind, name) => (ok(await admin.post('/api/parties', { kind, name, force: true }), 201)).party.id;
  P.client = await mk('client', 'ورشة النجمة التجريبية');
  P.client2 = await mk('client', 'مصنع القمر التجريبي');
  P.supplier = await mk('supplier', 'مورد الصاج التجريبي');
  P.partner = await mk('partner', 'شريك أول تجريبي');
  P.worker = await mk('worker', 'عامل تجريبي');
});
after(() => app.stop());

test('إيصال استلام نقدي من عميل: Dr cash / Cr receivable, serial قب-, statement دائن', async () => {
  const r = ok(await admin.post('/api/treasury/receipts', { party_id: P.client, date: TODAY, amount: '1,500.50', method: 'cash' }), 201).receipt;
  assert.match(r.serial, /^قب-\d{4}$/);
  assert.equal(r.amount, 1500500);
  assert.equal(r.account, 'cash');
  assert.equal(bal('cash'), 1500500);
  assert.equal(bal('receivable', P.client), -1500500);
  const s = ok(await admin.get(`/api/parties/${P.client}/statement`));
  const row = s.rows.find((x) => x.doc_type === 'receipt' && x.doc_id === r.id);
  assert.equal(row.credit, 1500500);
  assert.equal(s.closing_text, 'له عندنا 1,500.50');
});

test('receipt by transfer / InstaPay goes to the bank; a wallet can go to the cash box', async () => {
  const bank0 = bal('bank');
  const cash0 = bal('cash');
  ok(await admin.post('/api/treasury/receipts', { party_id: P.client, date: TODAY, amount: 200, method: 'transfer' }), 201);
  ok(await admin.post('/api/treasury/receipts', { party_id: P.client, date: TODAY, amount: 100, method: 'instapay' }), 201);
  ok(await admin.post('/api/treasury/receipts', { party_id: P.client, date: TODAY, amount: 50, method: 'wallet', account: 'cash' }), 201);
  assert.equal(bal('bank') - bank0, 300000);
  assert.equal(bal('cash') - cash0, 50000);
});

test('dates must be real calendar days; amounts must be positive numbers (Arabic errors with field)', async () => {
  let r = await admin.post('/api/treasury/receipts', { party_id: P.client, date: '2026-02-30', amount: 10, method: 'cash' });
  assert.equal(r.status, 400);
  assert.equal(r.data.field, 'date');
  assert.match(r.data.error, /غلط/);
  r = await admin.post('/api/treasury/receipts', { party_id: P.client, date: '2026-13-01', amount: 10, method: 'cash' });
  assert.equal(r.status, 400);
  r = await admin.post('/api/treasury/receipts', { party_id: P.client, date: TODAY, amount: '0', method: 'cash' });
  assert.equal(r.data.field, 'amount');
  r = await admin.post('/api/treasury/receipts', { party_id: P.client, date: TODAY, amount: 'عشرة', method: 'cash' });
  assert.equal(r.data.field, 'amount');
  r = await admin.post('/api/treasury/receipts', { party_id: P.client, date: TODAY, amount: 10, method: 'cheque', cheque: { number: '1', due_date: '2026-04-31' } });
  assert.equal(r.data.field, 'cheque_due_date');
  r = await admin.post('/api/treasury/receipts', { date: TODAY, amount: 10, method: 'cash' });
  assert.equal(r.data.field, 'party_id');
  // Arabic-Indic digits are fine.
  ok(await admin.post('/api/treasury/receipts', { party_id: P.client, date: '٢٠٢٦-٠١-١٥', amount: '١٠٫٥', method: 'cash' }), 201);
});

test('client cheque: held without posting («تحت التحصيل» memo), deposit, collect (Dr bank / Cr receivable), bounce reverses', async () => {
  const before = bal('receivable', P.client2);
  const r = ok(await admin.post('/api/treasury/receipts', {
    party_id: P.client2, date: TODAY, amount: 5000, method: 'cheque', cheque: { number: 'A-778', bank: 'بنك تجريبي', due_date: addDays(TODAY, 2) },
  }), 201).receipt;
  assert.equal(r.txn_id, null);
  assert.equal(r.cheque.status, 'in_portfolio');
  assert.equal(bal('receivable', P.client2), before, 'no posting on receipt of a cheque');
  let s = ok(await admin.get(`/api/parties/${P.client2}/statement`));
  assert.equal(s.pending_cheques.length, 1);
  assert.equal(s.pending_cheques_amount, 5000000);

  const id = r.cheque_id;
  let r2 = await admin.post(`/api/treasury/cheques/${id}/deposit`, { date: addDays(TODAY, -5) });
  assert.equal(r2.status, 400, 'deposit before the cheque date');
  ok(await admin.post(`/api/treasury/cheques/${id}/deposit`, { date: TODAY }));
  r2 = await admin.post(`/api/treasury/cheques/${id}/endorse`, { date: TODAY, supplier_id: P.supplier });
  assert.equal(r2.status, 409, 'a deposited cheque cannot be endorsed');
  const bank0 = bal('bank');
  const c = ok(await admin.post(`/api/treasury/cheques/${id}/collect`, { date: TODAY })).cheque;
  assert.equal(c.status, 'collected');
  assert.equal(bal('bank') - bank0, 5000000);
  assert.equal(bal('receivable', P.client2), before - 5000000);
  s = ok(await admin.get(`/api/parties/${P.client2}/statement`));
  assert.equal(s.pending_cheques.length, 0);

  // A collected cheque's receipt can't be cancelled: it must bounce.
  assert.equal((await admin.post(`/api/treasury/receipts/${r.id}/cancel`, { reason: 'غلط' })).status, 409);
  assert.equal((await admin.post(`/api/treasury/cheques/${id}/bounce`, { date: TODAY })).data.field, 'reason');
  const b = ok(await admin.post(`/api/treasury/cheques/${id}/bounce`, { date: TODAY, reason: 'رصيد غير كافي' })).cheque;
  assert.equal(b.status, 'bounced');
  assert.equal(bal('bank'), bank0);
  assert.equal(bal('receivable', P.client2), before, 'the client owes it again');
  assert.equal(b.history.some((t) => t.reversal_of), true);
  assert.equal((await admin.post(`/api/treasury/cheques/${id}/collect`, { date: TODAY })).status, 409);
});

test('endorse a client cheque to a supplier: Dr payable / Cr receivable; bounce after endorse reverses it', async () => {
  const r = ok(await admin.post('/api/treasury/receipts', {
    party_id: P.client, date: TODAY, amount: 700, method: 'cheque', cheque: { number: 'E-1', due_date: addDays(TODAY, 20) },
  }), 201).receipt;
  const cl0 = bal('receivable', P.client);
  const sp0 = bal('payable', P.supplier);
  const c = ok(await admin.post(`/api/treasury/cheques/${r.cheque_id}/endorse`, { date: TODAY, supplier_id: P.supplier })).cheque;
  assert.equal(c.status, 'endorsed');
  assert.equal(c.endorsed_to_name, 'مورد الصاج التجريبي');
  assert.equal(bal('receivable', P.client) - cl0, -700000);
  assert.equal(bal('payable', P.supplier) - sp0, 700000);
  ok(await admin.post(`/api/treasury/cheques/${r.cheque_id}/bounce`, { date: TODAY, reason: 'المورد رجّعه' }));
  assert.equal(bal('receivable', P.client), cl0);
  assert.equal(bal('payable', P.supplier), sp0);
});

test('cancel a receipt = reversal with a reason; twice is refused; a held cheque is cancelled with it', async () => {
  const cash0 = bal('cash');
  const r = ok(await admin.post('/api/treasury/receipts', { party_id: P.client, date: TODAY, amount: 300, method: 'cash' }), 201).receipt;
  assert.equal((await admin.post(`/api/treasury/receipts/${r.id}/cancel`, { reason: ' ' })).data.field, 'reason');
  const c = ok(await admin.post(`/api/treasury/receipts/${r.id}/cancel`, { reason: 'اتكتب مرتين' })).receipt;
  assert.equal(c.status, 'cancelled');
  assert.equal(bal('cash'), cash0);
  const t = db().prepare('SELECT * FROM txns WHERE id = ?').get(r.txn_id);
  assert.equal(t.status, 'reversed');
  assert.equal((await admin.post(`/api/treasury/receipts/${r.id}/cancel`, { reason: 'تاني' })).status, 409);

  const rc = ok(await admin.post('/api/treasury/receipts', { party_id: P.client, date: TODAY, amount: 90, method: 'cheque', cheque: { number: 'X9', due_date: TODAY } }), 201).receipt;
  ok(await admin.post(`/api/treasury/receipts/${rc.id}/cancel`, { reason: 'العميل خده تاني' }));
  assert.equal(db().prepare('SELECT status FROM cheques WHERE id = ?').get(rc.cheque_id).status, 'cancelled');
});

test('إذن صرف: general expense from cash; split cost centers; «يتحمّل على العميل» posts to the client and revenue:recharge', async () => {
  const cash0 = bal('cash');
  const v = ok(await admin.post('/api/treasury/vouchers', {
    kind: 'expense', date: TODAY, paid_from: 'cash', description: 'لمبات للورشة', lines: [{ category_id: 10, amount: '120' }],
  }), 201).voucher;
  assert.match(v.serial, /^صر-\d{4}$/);
  assert.equal(v.total, 120000);
  assert.equal(bal('cash') - cash0, -120000);
  assert.equal(bal('expense:10'), 120000);

  const cl0 = bal('receivable', P.client2);
  const split = ok(await admin.post('/api/treasury/vouchers', {
    kind: 'expense', date: TODAY, paid_from: 'cash', description: 'دهان',
    lines: [
      { category_id: 6, amount: 400, cost_party_id: P.client2, recharge: true },
      { category_id: 6, amount: 100, cost_party_id: P.client },
      { category_id: 6, amount: 50 },
    ],
  }), 201).voucher;
  assert.equal(split.total, 550000);
  assert.equal(split.lines.length, 3);
  const posts = db().prepare('SELECT * FROM postings WHERE txn_id = ?').all(split.txn_id);
  const exp = posts.filter((p) => p.account === 'expense:6');
  assert.deepEqual(exp.map((p) => [p.debit, p.cost_party_id]), [[400000, P.client2], [100000, P.client], [50000, null]]);
  assert.equal(bal('revenue:recharge'), -400000);
  assert.equal(bal('receivable', P.client2) - cl0, 400000, 'recharged to the client statement');
  // The non-recharged client cost center is our cost, not on his statement.
  const s = ok(await admin.get(`/api/parties/${P.client}/statement`));
  assert.equal(s.rows.some((r) => r.doc_type === 'voucher' && r.doc_id === split.id), false);

  let r = await admin.post('/api/treasury/vouchers', { kind: 'expense', date: TODAY, paid_from: 'cash', lines: [{ category_id: 6, amount: 5, recharge: true }] });
  assert.equal(r.data.field, 'recharge');
  r = await admin.post('/api/treasury/vouchers', { kind: 'expense', date: TODAY, paid_from: 'cash', lines: [{ category_id: 999, amount: 5 }] });
  assert.equal(r.data.field, 'category_id');
  r = await admin.post('/api/treasury/vouchers', { kind: 'expense', date: TODAY, paid_from: 'cash', lines: [{ category_id: 6, amount: 5, cost_party_id: P.supplier }] });
  assert.equal(r.data.field, 'cost_party_id');
});

test('paid from: bank, partner pocket, supplier credit (آجل), client offset (مقاصة)', async () => {
  const b0 = bal('bank');
  ok(await admin.post('/api/treasury/vouchers', { kind: 'expense', date: TODAY, paid_from: 'bank', lines: [{ category_id: 3, amount: 900 }] }), 201);
  assert.equal(bal('bank') - b0, -900000);
  const p0 = bal('partner', P.partner);
  ok(await admin.post('/api/treasury/vouchers', { kind: 'expense', date: TODAY, paid_from: 'partner', paid_from_party_id: P.partner, lines: [{ category_id: 2, amount: 3000 }] }), 201);
  assert.equal(bal('partner', P.partner) - p0, -3000000, 'the partner is owed it (Cr partner)');
  const s0 = bal('payable', P.supplier);
  ok(await admin.post('/api/treasury/vouchers', { kind: 'expense', date: TODAY, paid_from: 'supplier_credit', paid_from_party_id: P.supplier, lines: [{ category_id: 9, amount: 250 }] }), 201);
  assert.equal(bal('payable', P.supplier) - s0, -250000);
  const c0 = bal('receivable', P.client);
  ok(await admin.post('/api/treasury/vouchers', { kind: 'expense', date: TODAY, paid_from: 'client_offset', paid_from_party_id: P.client, lines: [{ category_id: 7, amount: 80 }] }), 201);
  assert.equal(bal('receivable', P.client) - c0, -80000);
  const r = await admin.post('/api/treasury/vouchers', { kind: 'expense', date: TODAY, paid_from: 'partner', lines: [{ category_id: 2, amount: 1 }] });
  assert.equal(r.data.field, 'paid_from_party_id');
});

test('our cheque: issue Dr target / Cr cheques_payable, صرف Dr cheques_payable / Cr bank; a cleared cheque blocks cancelling the voucher', async () => {
  const v = ok(await admin.post('/api/treasury/vouchers', {
    kind: 'supplier_payment', date: TODAY, paid_from: 'cheque', party_id: P.supplier, amount: 2000,
    cheque: { number: 'OUT-1', bank: 'بنك تجريبي', due_date: addDays(TODAY, 1) },
  }), 201).voucher;
  assert.equal(v.cheque.status, 'issued');
  const cp = db().prepare('SELECT SUM(credit) - SUM(debit) b FROM postings WHERE account = ? AND txn_id = ?').get('cheques_payable', v.txn_id).b;
  assert.equal(cp, 2000000);
  const alerts = ok(await admin.get('/api/treasury/cheques/alerts?direction=out')).alerts;
  assert.equal(alerts.some((a) => a.id === v.cheque.id && a.alert === 'due_soon'), true);
  const b0 = bal('bank');
  ok(await admin.post(`/api/treasury/cheques/${v.cheque.id}/clear`, { date: TODAY }));
  assert.equal(bal('bank') - b0, -2000000);
  const r = await admin.post(`/api/treasury/vouchers/${v.id}/cancel`, { reason: 'غلط' });
  assert.equal(r.status, 409);

  // An issued (not cleared) cheque is cancelled with its voucher.
  const v2 = ok(await admin.post('/api/treasury/vouchers', {
    kind: 'partner_withdrawal', date: TODAY, paid_from: 'cheque', party_id: P.partner, amount: 100, cheque: { number: 'OUT-2', due_date: TODAY },
  }), 201).voucher;
  ok(await admin.post(`/api/treasury/vouchers/${v2.id}/cancel`, { reason: 'اتلغى السحب' }));
  assert.equal(db().prepare('SELECT status FROM cheques WHERE id = ?').get(v2.cheque.id).status, 'cancelled');

  // Our cheque bouncing: we owe the payee again.
  const v3 = ok(await admin.post('/api/treasury/vouchers', {
    kind: 'supplier_payment', date: TODAY, paid_from: 'cheque', party_id: P.supplier, amount: 600, cheque: { number: 'OUT-3', due_date: TODAY },
  }), 201).voucher;
  const s0 = bal('payable', P.supplier);
  ok(await admin.post(`/api/treasury/cheques/${v3.cheque.id}/bounce`, { date: TODAY, reason: 'رصيد البنك مكفاش' }));
  assert.equal(bal('payable', P.supplier) - s0, -600000);
  assert.equal(db().prepare('SELECT status FROM cheques WHERE id = ?').get(v3.cheque.id).status, 'bounced');
});

test('material purchase (qty × unit price, round half up) on credit; supplier payment; partner deposit and withdrawal; worker advance and salary', async () => {
  const s0 = bal('payable', P.supplier);
  const v = ok(await admin.post('/api/treasury/vouchers', {
    kind: 'material_purchase', date: TODAY, paid_from: 'supplier_credit', party_id: P.supplier,
    items: [{ material_id: 1, qty: '2.5', unit: 'لوح', unit_rate: '333.333' }, { material_text: 'مسامير', qty: 3, unit: 'علبة', unit_rate: 10 }],
  }), 201).voucher;
  assert.equal(v.items[0].line_amount, 833333); // 2.5 × 333,333 = 833,332.5 → 833,333
  assert.equal(v.total, 863333);
  assert.equal(bal('materials_purchases') >= 863333, true);
  assert.equal(bal('payable', P.supplier) - s0, -863333);
  ok(await admin.post('/api/treasury/vouchers', { kind: 'supplier_payment', date: TODAY, paid_from: 'cash', party_id: P.supplier, amount: 500 }), 201);
  assert.equal(bal('payable', P.supplier) - s0, -363333);

  const p0 = bal('partner', P.partner);
  ok(await admin.post('/api/treasury/receipts', { party_id: P.partner, date: TODAY, amount: 10000, method: 'transfer' }), 201);
  assert.equal(bal('partner', P.partner) - p0, -10000000, 'deposit: Dr bank / Cr partner');
  ok(await admin.post('/api/treasury/vouchers', { kind: 'partner_withdrawal', date: TODAY, paid_from: 'cash', party_id: P.partner, amount: 1000 }), 201);
  assert.equal(bal('partner', P.partner) - p0, -9000000);

  ok(await admin.post('/api/treasury/vouchers', { kind: 'worker_advance', date: TODAY, paid_from: 'cash', party_id: P.worker, amount: 300 }), 201);
  assert.equal(bal('worker', P.worker), 300000);
  const cash0 = bal('cash');
  const sal = ok(await admin.post('/api/treasury/vouchers', {
    kind: 'expense', date: TODAY, paid_from: 'cash', deduction: 200, lines: [{ category_id: 1, amount: 2500, worker_id: P.worker }],
  }), 201).voucher;
  assert.equal(sal.total, 2500000);
  assert.equal(sal.paid_amount, 2300000);
  assert.equal(bal('cash') - cash0, -2300000);
  assert.equal(bal('worker', P.worker), 100000, 'part of the advance taken back');
  const r = await admin.post('/api/treasury/vouchers', { kind: 'worker_advance', date: TODAY, paid_from: 'partner', paid_from_party_id: P.partner, party_id: P.worker, amount: 1 });
  assert.equal(r.data.field, 'paid_from');
});

test('تحويل between cash and bank, and its cancel', async () => {
  const c0 = bal('cash');
  const b0 = bal('bank');
  const t = ok(await admin.post('/api/treasury/transfers', { date: TODAY, from_account: 'cash', to_account: 'bank', amount: 1000 }), 201).transfer;
  assert.match(t.serial, /^تح-/);
  assert.equal(bal('cash') - c0, -1000000);
  assert.equal(bal('bank') - b0, 1000000);
  assert.equal((await admin.post('/api/treasury/transfers', { date: TODAY, from_account: 'cash', to_account: 'cash', amount: 1 })).status, 400);
  ok(await admin.post(`/api/treasury/transfers/${t.id}/cancel`, { reason: 'اتحول بالغلط' }));
  assert.equal(bal('cash'), c0);
  assert.equal(bal('bank'), b0);
});

test('جرد الخزينة: the difference needs a reason and posts to cash_over_short', async () => {
  ok(await admin.post('/api/treasury/opening', { account: 'cash', amount: '100000', date: '2026-01-01' }), 201);
  const exp = ok(await admin.get(`/api/treasury/counts/expected?account=cash&date=${TODAY}`)).expected;
  assert.equal(exp, bal('cash'));
  const same = ok(await admin.post('/api/treasury/counts', { account: 'cash', date: TODAY, counted: exp / 1000 }), 201).count;
  assert.equal(same.difference, 0);
  assert.equal(same.txn_id, null);
  const r = await admin.post('/api/treasury/counts', { account: 'cash', date: TODAY, counted: (exp - 5000) / 1000 });
  assert.equal(r.data.field, 'notes');
  const short = ok(await admin.post('/api/treasury/counts', { account: 'cash', date: TODAY, counted: (exp - 5000) / 1000, notes: 'فكة ناقصة' }), 201).count;
  assert.equal(short.difference, -5000);
  assert.equal(bal('cash'), exp - 5000);
  assert.equal(bal('cash_over_short'), 5000);
});

test('month lock: documents dated in a locked month are refused; unlock with a reason', async () => {
  ok(await admin.post('/api/month-locks', { month: '2025-03' }), 201);
  let r = await admin.post('/api/treasury/receipts', { party_id: P.client, date: '2025-03-10', amount: 10, method: 'cash' });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /مقفول/);
  r = await admin.post('/api/treasury/receipts', { party_id: P.client, date: '2025-03-10', amount: 10, method: 'cheque', cheque: { number: 'L1', due_date: '2025-04-01' } });
  assert.equal(r.status, 409, 'a cheque receipt (no posting) is refused too');
  r = await admin.post('/api/treasury/vouchers', { kind: 'expense', date: '2025-03-02', paid_from: 'cash', lines: [{ category_id: 11, amount: 1 }] });
  assert.equal(r.status, 409);
  r = await admin.post('/api/treasury/transfers', { date: '2025-03-02', from_account: 'cash', amount: 1 });
  assert.equal(r.status, 409);
  assert.equal(db().prepare("SELECT COUNT(*) n FROM receipts WHERE date LIKE '2025-03%'").get().n, 0, 'nothing half-written');
  assert.equal(db().prepare("SELECT COUNT(*) n FROM cheques WHERE number = 'L1'").get().n, 0);
  // A cheque held from an open month can't be collected into the locked one.
  const rc = ok(await admin.post('/api/treasury/receipts', { party_id: P.client, date: '2025-02-20', amount: 10, method: 'cheque', cheque: { number: 'L2', due_date: '2025-03-05' } }), 201).receipt;
  assert.equal((await admin.post(`/api/treasury/cheques/${rc.cheque_id}/collect`, { date: '2025-03-05' })).status, 409);
});

test('المصروفات list: filters (date, category, cost center, paid from) and totals by category for money users', async () => {
  const all = ok(await admin.get(`/api/treasury/vouchers?from=${TODAY}&to=${TODAY}`));
  assert.ok(all.vouchers.length > 5);
  assert.ok(all.totals.grand_total > 0);
  const paint = ok(await admin.get('/api/treasury/vouchers?category_id=6'));
  assert.equal(paint.totals.grand_total, 550000);
  const cl = ok(await admin.get(`/api/treasury/vouchers?category_id=6&cost=${P.client2}`));
  assert.equal(cl.totals.grand_total, 400000);
  const gen = ok(await admin.get('/api/treasury/vouchers?category_id=6&cost=general'));
  assert.equal(gen.totals.grand_total, 50000);
  const bank = ok(await admin.get('/api/treasury/vouchers?paid_from=bank'));
  assert.ok(bank.vouchers.every((v) => v.paid_from === 'bank'));
  assert.equal((await admin.get('/api/treasury/vouchers?from=2026-02-31')).status, 400);
});

test('staff: records expense vouchers from the cash box, never receives a money field, sees only his own', async () => {
  const opts = ok(await staff.get('/api/treasury/options'));
  assert.equal(opts.limited, true);
  assert.deepEqual(opts.kinds.map(([k]) => k), ['expense']);
  // The labels of the sources he may use survive stripMoney (cash / bank are money key names).
  assert.deepEqual(opts.kind_sources.expense, ['cash', 'supplier_credit']);
  assert.deepEqual(opts.paid_from.map(([k]) => k), ['cash', 'supplier_credit']);
  assert.ok(opts.paid_from.every(([, label]) => typeof label === 'string' && label.length > 0));
  const v = ok(await staff.post('/api/treasury/vouchers', { kind: 'expense', date: TODAY, paid_from: 'cash', description: 'شاي', lines: [{ category_id: 8, amount: 35 }] }), 201);
  assertNoMoney(v, 'staff voucher create');
  assert.equal(db().prepare('SELECT total FROM vouchers WHERE id = ?').get(v.voucher.id).total, 35000, 'still recorded with its amount');
  const list = ok(await staff.get('/api/treasury/vouchers'));
  assertNoMoney(list, 'staff voucher list');
  assert.equal(list.own_only, true);
  assert.ok(list.vouchers.every((x) => x.created_by_name === 'مدير تجريبي'));
  assertNoMoney(ok(await staff.get(`/api/treasury/vouchers/${v.voucher.id}`)), 'staff voucher one');
  // Not his: refused.
  const adminV = db().prepare("SELECT id FROM vouchers WHERE created_by = 1 LIMIT 1").get().id;
  assert.equal((await staff.get(`/api/treasury/vouchers/${adminV}`)).status, 403);
  // Limits: kind, source, recharge.
  assert.equal((await staff.post('/api/treasury/vouchers', { kind: 'material_purchase', date: TODAY, paid_from: 'cash', party_id: P.supplier, items: [] })).status, 403);
  assert.equal((await staff.post('/api/treasury/vouchers', { kind: 'expense', date: TODAY, paid_from: 'bank', lines: [{ category_id: 8, amount: 1 }] })).status, 403);
  assert.equal((await staff.post('/api/treasury/vouchers', { kind: 'expense', date: TODAY, paid_from: 'cash', lines: [{ category_id: 8, amount: 1, cost_party_id: P.client, recharge: true }] })).status, 403);
  // A client cost center (our cost) is fine for him.
  ok(await staff.post('/api/treasury/vouchers', { kind: 'expense', date: TODAY, paid_from: 'cash', lines: [{ category_id: 7, amount: 20, cost_party_id: P.client }] }), 201);
  // Everything else in the treasury is closed to him.
  for (const u of ['/api/treasury/summary', '/api/treasury/movements', '/api/treasury/receipts', '/api/treasury/cheques', '/api/treasury/transfers',
    '/api/treasury/counts', '/api/treasury/recurring', `/api/treasury/receipts/1`]) {
    assert.equal((await staff.get(u)).status, 403, u);
  }
  assert.equal((await staff.post(`/api/treasury/vouchers/${v.voucher.id}/cancel`, { reason: 'x' })).status, 403);
  assert.equal((await staff.post('/api/treasury/receipts', { party_id: P.client, date: TODAY, amount: 1, method: 'cash' })).status, 403);
});

test('bill photo: attach to a voucher, read it back; staff only for his own', async () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const v = ok(await staff.post('/api/treasury/vouchers', { kind: 'expense', date: TODAY, paid_from: 'cash', lines: [{ category_id: 9, amount: 15 }] }), 201).voucher;
  const r = ok(await staff.post(`/api/treasury/vouchers/${v.id}/photo`, { photo: png }));
  assert.equal(r.voucher.has_photo, true);
  const res = await fetch(`${app.base}/api/treasury/vouchers/${v.id}/photo`, { headers: { cookie: admin.cookie } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal((await staff.post(`/api/treasury/vouchers/${v.id}/photo`, { photo: 'data:text/plain;base64,aGk=' })).data.field, 'photo');
  const adminV = db().prepare("SELECT id FROM vouchers WHERE created_by = 1 LIMIT 1").get().id;
  assert.equal((await staff.post(`/api/treasury/vouchers/${adminV}/photo`, { photo: png })).status, 403);
});

test('bill photo: the bytes must be the image type, staff attaches once, a cancelled voucher is frozen, nosniff', async () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const html = `data:image/webp;base64,${Buffer.from('<html><body><script>document.title="x"</script>hi</body></html>').toString('base64')}`;
  const v = ok(await staff.post('/api/treasury/vouchers', { kind: 'expense', date: TODAY, paid_from: 'cash', lines: [{ category_id: 9, amount: 12 }] }), 201).voucher;
  const fake = await staff.post(`/api/treasury/vouchers/${v.id}/photo`, { photo: html });
  assert.equal(fake.status, 400);
  assert.equal(fake.data.field, 'photo');
  assert.equal((await staff.post(`/api/treasury/vouchers/${v.id}/photo`, { photo: png.replace('image/png', 'image/jpeg') })).status, 400, 'PNG bytes are not a JPEG');
  ok(await staff.post(`/api/treasury/vouchers/${v.id}/photo`, { photo: png }));
  assert.equal((await staff.post(`/api/treasury/vouchers/${v.id}/photo`, { photo: png })).status, 403, 'staff cannot swap the evidence');
  ok(await admin.post(`/api/treasury/vouchers/${v.id}/photo`, { photo: png }));
  const res = await fetch(`${app.base}/api/treasury/vouchers/${v.id}/photo`, { headers: { cookie: admin.cookie } });
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  ok(await admin.post(`/api/treasury/vouchers/${v.id}/cancel`, { reason: 'غلط' }));
  assert.equal((await admin.post(`/api/treasury/vouchers/${v.id}/photo`, { photo: png })).status, 409);
});

test('staff never receives the reason the admin wrote when cancelling his voucher (it can carry an amount)', async () => {
  const v = ok(await staff.post('/api/treasury/vouchers', { kind: 'expense', date: TODAY, paid_from: 'cash', lines: [{ category_id: 9, amount: 11 }] }), 201).voucher;
  const reason = 'المبلغ غلط، المفروض 450';
  ok(await admin.post(`/api/treasury/vouchers/${v.id}/cancel`, { reason }));
  assert.equal(ok(await admin.get(`/api/treasury/vouchers/${v.id}`)).voucher.cancel_reason, reason);
  const one = ok(await staff.get(`/api/treasury/vouchers/${v.id}`));
  assert.equal(one.voucher.status, 'cancelled');
  assert.ok(!JSON.stringify(one).includes('450'), 'one voucher');
  assert.ok(!JSON.stringify(ok(await staff.get('/api/treasury/vouchers'))).includes('450'), 'voucher list');
});

test('a big body is never read before the session: no cookie → 401, no upload permission → 403', async () => {
  const body = JSON.stringify({ photo: `data:image/png;base64,${'A'.repeat(3 * 1024 * 1024)}` });
  for (const u of ['/api/operations/photos', '/api/operations/sheets/1/photo', '/api/treasury/vouchers/1/photo', '/api/import']) {
    const r = await fetch(app.base + u, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal(r.status, 401, u);
  }
  // signed in without the upload permission (staff has no import): refused before parsing as well
  const r = await fetch(`${app.base}/api/import`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: staff.cookie }, body });
  assert.equal(r.status, 403);
});

test('الشيكات: lists by due week with totals, alerts for due within 3 days and overdue', async () => {
  for (const [n, d] of [['W1', addDays(TODAY, 1)], ['W2', addDays(TODAY, 10)], ['W3', addDays(TODAY, 11)], ['W4', addDays(TODAY, -3)]]) {
    ok(await admin.post('/api/treasury/receipts', { party_id: P.client, date: addDays(TODAY, -4), amount: 100, method: 'cheque', cheque: { number: n, due_date: d } }), 201);
  }
  const l = ok(await admin.get('/api/treasury/cheques?direction=in'));
  const rows = l.weeks.flatMap((w) => w.rows);
  assert.ok(rows.every((c) => ['in_portfolio', 'deposited'].includes(c.status)));
  for (const w of l.weeks) {
    assert.equal(w.week_total, w.rows.reduce((s, c) => s + c.amount, 0));
    assert.ok(w.rows.every((c) => c.due_date >= w.week_start && c.due_date <= w.week_end));
    assert.equal(new Date(`${w.week_start}T12:00:00Z`).getUTCDay(), 6, 'weeks start on Saturday');
  }
  assert.equal(l.grand_total, l.weeks.reduce((s, w) => s + w.week_total, 0));
  assert.equal(rows.find((c) => c.number === 'W1').alert, 'due_soon');
  assert.equal(rows.find((c) => c.number === 'W4').alert, 'overdue');
  assert.equal(rows.find((c) => c.number === 'W2').alert, null);
  const al = ok(await admin.get('/api/treasury/cheques/alerts')).alerts;
  assert.ok(al.some((a) => a.number === 'W1') && al.some((a) => a.number === 'W4') && !al.some((a) => a.number === 'W2'));
  const sum = ok(await admin.get('/api/treasury/summary'));
  assert.ok(sum.alerts.length >= 2);
  assert.equal(sum.cash, bal('cash'));
  assert.equal(sum.bank, bal('bank'));
  const allIn = ok(await admin.get('/api/treasury/cheques?direction=in&status=all'));
  assert.ok(allIn.count > l.count);
});

test('movements: by day, newest first, running balance after each row, opening before the range', async () => {
  const m = ok(await admin.get('/api/treasury/movements?account=cash'));
  assert.equal(m.closing_balance, bal('cash'));
  const day = m.days[0];
  const last = day.rows[day.rows.length - 1];
  assert.equal(last.running_balance, day.closing_balance);
  let run = 0;
  for (const d of [...m.days].reverse()) for (const r of d.rows) { run += r.in_amount - r.out_amount; assert.equal(r.running_balance, run); }
  const r = ok(await admin.get(`/api/treasury/movements?account=cash&from=${TODAY}`));
  assert.equal(r.opening_balance, ledger.balance('cash', null, { asOf: addDays(TODAY, -1) }));
  const q = ok(await admin.get('/api/treasury/movements?account=cash&q=شاي'));
  assert.ok(q.days.flatMap((d) => d.rows).every((x) => /شاي|ضيافة/.test(x.description)));
  assert.equal((await admin.get('/api/treasury/movements?account=safe')).status, 400);
});

test('treasury opening balance: Dr cash / Cr opening_equity (money.post)', async () => {
  const c0 = bal('cash');
  ok(await admin.post('/api/treasury/opening', { account: 'cash', amount: '2,000', date: '2026-01-01' }), 201);
  assert.equal(bal('cash') - c0, 2000000);
  assert.equal((await admin.post('/api/treasury/opening', { account: 'cash', amount: '-5', date: '2026-01-01' })).data.field, 'amount');
  assert.equal((await staff.post('/api/treasury/opening', { account: 'cash', amount: '5', date: '2026-01-01' })).status, 403);
});

test('every treasury transaction is balanced and every document is audited', () => {
  const unbalanced = db().prepare('SELECT txn_id FROM postings GROUP BY txn_id HAVING SUM(debit) <> SUM(credit)').all();
  assert.deepEqual(unbalanced, []);
  for (const [entity, table] of [['receipt', 'receipts'], ['voucher', 'vouchers'], ['transfer', 'transfers'], ['cash_count', 'cash_counts']]) {
    const missing = db().prepare(`SELECT x.id FROM ${table} x WHERE NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.entity = ? AND a.entity_id = x.id AND a.action = 'create')`).all(entity);
    assert.deepEqual(missing, [], `${table} without audit`);
  }
  // Posted rows are never deleted: every reversed txn has its reversal.
  const orphan = db().prepare("SELECT id FROM txns WHERE status = 'reversed' AND reversed_by IS NULL").all();
  assert.deepEqual(orphan, []);
});
