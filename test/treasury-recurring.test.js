// المصروفات المتكررة (drafts from the first of the month, one-click confirm, skip, never twice),
// the amount in words of the printed receipt / voucher, and the date rules of the module.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, client } from './helpers.js';
import { amountWords, numberWords } from '../public/js/modules/treasury-words.js';

let app;
let admin;
let T;
let ledger;
let db;

before(async () => {
  app = await startApp();
  T = await import('../src/treasury/index.js');
  ledger = await import('../src/ledger.js');
  ({ getDb: db } = await import('../src/db.js'));
  admin = client(app.base);
  await admin.post('/api/setup', { username: 'owner', display_name: 'المالك', password: 'secret1' });
});
after(() => app.stop());

test('a template prepares one draft per month from its start month; confirm posts a voucher once', () => {
  const r = T.createRecurring({ category_id: 2, description: 'إيجار الورشة التجريبية', amount: '4,000', day_of_month: 5, paid_from: 'cash', start_month: '2026-08' }, { userId: 1 });
  assert.equal(r.amount, 4000000);
  // Before its start: nothing.
  assert.equal(T.recurringDrafts('2026-07-20').filter((d) => d.recurring_id === r.id).length, 0);
  // On the first of October: August, September (overdue) and October.
  let drafts = T.recurringDrafts('2026-10-01').filter((d) => d.recurring_id === r.id);
  assert.deepEqual(drafts.map((d) => d.month), ['2026-08', '2026-09', '2026-10']);
  assert.deepEqual(drafts.map((d) => d.overdue), [true, true, false]);
  assert.equal(drafts[0].date, '2026-08-05', 'an old month keeps its own day');
  assert.equal(drafts[2].date, '2026-10-01', 'this month posts today when today is before the due day');

  const cash0 = ledger.balance('cash');
  const v = T.confirmDraft(r.id, '2026-08', { as_of: '2026-10-01' }, { userId: 1 });
  const voucher = T.getVoucher(v.id);
  assert.equal(voucher.total, 4000000);
  assert.equal(voucher.recurring_id, r.id);
  assert.equal(voucher.date, '2026-08-05');
  assert.equal(ledger.balance('cash') - cash0, -4000000);
  assert.throws(() => T.confirmDraft(r.id, '2026-08', { as_of: '2026-10-01' }, { userId: 1 }), /قبل كده/);

  // This month's amount and date can change before confirming (electricity varies).
  const v2 = T.confirmDraft(r.id, '2026-09', { as_of: '2026-10-01', amount: '4,250.75', date: '2026-09-07' }, { userId: 1 });
  assert.equal(T.getVoucher(v2.id).total, 4250750);
  assert.throws(() => T.confirmDraft(r.id, '2026-10', { as_of: '2026-10-01', date: '2026-11-01' }, { userId: 1 }), /جوه شهر/);

  // Skip with a reason.
  assert.throws(() => T.skipDraft(r.id, '2026-10', '', { userId: 1, asOf: '2026-10-01' }), /سبب/);
  T.skipDraft(r.id, '2026-10', 'الإيجار اتدفع مقدم', { userId: 1, asOf: '2026-10-01' });
  drafts = T.recurringDrafts('2026-10-15').filter((d) => d.recurring_id === r.id);
  assert.equal(drafts.length, 0);

  // Cancelling a confirmed month's voucher brings the draft back.
  T.cancelVoucher(v2.id, 'المبلغ غلط', { userId: 1 });
  drafts = T.recurringDrafts('2026-10-15').filter((d) => d.recurring_id === r.id);
  assert.deepEqual(drafts.map((d) => d.month), ['2026-09']);
});

test('confirm all, inactive templates prepare nothing, rules on the template', () => {
  const a = T.createRecurring({ category_id: 3, amount: 900, day_of_month: 1, paid_from: 'bank', start_month: '2026-10' }, { userId: 1 });
  const b = T.createRecurring({ category_id: 4, amount: 300, day_of_month: 10, paid_from: 'cash', start_month: '2026-10' }, { userId: 1 });
  T.updateRecurring(b.id, { active: false }, { userId: 1 });
  const before = T.recurringDrafts('2026-10-20');
  assert.ok(before.some((d) => d.recurring_id === a.id));
  assert.ok(!before.some((d) => d.recurring_id === b.id));
  const done = T.confirmAllDrafts('2026-10-20', { userId: 1 });
  assert.equal(done.length, before.length);
  assert.equal(T.recurringDrafts('2026-10-20').length, 0);
  assert.throws(() => T.createRecurring({ category_id: 3, amount: 1, day_of_month: 31 }), /يوم الشهر/);
  assert.throws(() => T.createRecurring({ category_id: 3, amount: 1, paid_from: 'partner' }), /الشريك/);
  assert.throws(() => T.createRecurring({ amount: 1 }), /بند/);
});

test('recurring over HTTP: list with drafts, confirm, confirm-all', async () => {
  const month = T.today().slice(0, 7);
  const r = (await admin.post('/api/treasury/recurring', { category_id: 10, amount: 150, day_of_month: 1, paid_from: 'cash' })).data.recurring;
  assert.equal(r.start_month, month);
  const l = (await admin.get('/api/treasury/recurring')).data;
  assert.ok(l.drafts.some((d) => d.recurring_id === r.id && d.month === month));
  const c = await admin.post('/api/treasury/recurring/drafts/confirm', { recurring_id: r.id, month });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  assert.equal((await admin.post('/api/treasury/recurring/drafts/confirm', { recurring_id: r.id, month })).status, 409);
  const all = await admin.post('/api/treasury/recurring/drafts/confirm-all', {});
  assert.equal(all.status, 201);
});

test('amount in words (تفقيط) for the printed documents', () => {
  assert.equal(amountWords(1235500), 'فقط ألف ومائتان وخمسة وثلاثون جنيهًا وخمسون قرشًا لا غير');
  assert.equal(amountWords(1000), 'فقط جنيه واحد لا غير');
  assert.equal(amountWords(2000), 'فقط جنيهان لا غير');
  assert.equal(amountWords(5000), 'فقط خمسة جنيهات لا غير');
  assert.equal(amountWords(100000), 'فقط مائة جنيه لا غير');
  assert.equal(amountWords(250000), 'فقط مائتان وخمسون جنيهًا لا غير');
  assert.equal(amountWords(10000), 'فقط عشرة جنيهات لا غير');
  assert.equal(amountWords(11000), 'فقط أحد عشر جنيهًا لا غير');
  assert.equal(amountWords(500), 'فقط خمسون قرشًا لا غير');
  assert.equal(amountWords(12345670), 'فقط اثنا عشر ألف وثلاثمائة وخمسة وأربعون جنيهًا وسبعة وستون قرشًا لا غير');
  assert.equal(numberWords(2000000), 'مليونان');
  assert.equal(numberWords(3000), 'ثلاثة آلاف');
  assert.equal(numberWords(12000), 'اثنا عشر ألف');
  assert.equal(numberWords(1001), 'ألف وواحد');
});

test('real calendar dates only (leap years, month ends, Arabic digits)', () => {
  assert.equal(T.isRealDate('2028-02-29'), '2028-02-29');
  assert.equal(T.isRealDate('2026-02-29'), null);
  assert.equal(T.isRealDate('2026-04-31'), null);
  assert.equal(T.isRealDate('2026-12-31'), '2026-12-31');
  assert.equal(T.isRealDate('٢٠٢٦-١٠-٠٥'), '2026-10-05');
  assert.equal(T.isRealDate('5/10/2026'), null);
  assert.equal(T.weekStart('2026-11-02'), '2026-10-31'); // Monday → the Saturday before
  assert.equal(T.weekStart('2026-10-31'), '2026-10-31');
  assert.equal(db().prepare("SELECT COUNT(*) n FROM schema_migrations WHERE id = 300").get().n, 1);
});

test('money columns added by the module refuse non-integer millimes', () => {
  assert.throws(() => db().prepare('UPDATE vouchers SET deduction_amount = 1.5 WHERE id = (SELECT MIN(id) FROM vouchers)').run(), /integer millimes/);
});
