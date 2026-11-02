// Money: integer millimes, parsing what people type, formatting, the one rounding rule,
// balance wording and stripping money for staff.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMoney, formatMoney, mulRound, roundMillimes, balanceWords, stripMoney, isMoneyKey } from '../src/money.js';

test('parseMoney: Western and Arabic digits, separators, currency words', () => {
  const cases = [
    ['1234.5', 1234500], ['1,234.50', 1234500], ['١٬٢٣٤٫٥٠', 1234500], ['١٢٣٤٫٥', 1234500],
    ['150', 150000], ['0.001', 1], ['.5', 500], ['2,5', 2500], ['12,50', 12500], ['1,234', 1234000],
    ['  99 ج', 99000], ['100 جنيه', 100000], ['-20', -20000], [1234.5, 1234500], [0, 0], ['12345.67', 12345670],
  ];
  for (const [input, want] of cases) assert.equal(parseMoney(input), want, String(input));
  assert.equal(parseMoney(''), null);
  assert.equal(parseMoney(null), null);
  for (const bad of ['abc', '1.2345', '1..2', '12a', '--1', Infinity, NaN]) assert.ok(Number.isNaN(parseMoney(bad)), String(bad));
});

test('formatMoney: 2 decimals, thousands, Western digits', () => {
  assert.equal(formatMoney(12345670), '12,345.67');
  assert.equal(formatMoney(3210450), '3,210.45');
  assert.equal(formatMoney(0), '0.00');
  assert.equal(formatMoney(5), '0.01');      // half a piastre shows up
  assert.equal(formatMoney(4), '0.00');
  assert.equal(formatMoney(-1500), '-1.50');
  assert.equal(formatMoney(1234567890), '1,234,567.89');
  assert.equal(formatMoney(null), '');
});

test('mulRound: qty × rate rounded half up, exact for decimals', () => {
  assert.equal(mulRound(3, 350), 1050);
  assert.equal(mulRound(1.5, 333), 500);       // 499.5 → 500
  assert.equal(mulRound(0.1, 3), 0);           // 0.3 → 0
  assert.equal(mulRound(2.5, 1), 3);           // half up
  assert.equal(mulRound(1.005, 1000), 1005);   // no float drift
  assert.equal(mulRound(12.345, 2000), 24690);
  assert.equal(mulRound(0, 99999), 0);
  assert.equal(mulRound(-2.5, 1), -3);
  assert.equal(roundMillimes(149.5), 150);
  assert.equal(roundMillimes(149.4999), 149);
});

test('balance wording is never a bare sign', () => {
  assert.deepEqual(balanceWords(12345670), { label: 'لنا عنده', amount: 12345670, text: 'لنا عنده 12,345.67', side: 'owes_us' });
  assert.equal(balanceWords(-3210450).text, 'له عندنا 3,210.45');
  assert.equal(balanceWords(0).text, 'خالص');
});

test('stripMoney removes every money field, deep, for users without money.view', () => {
  const staff = { role: 'staff', extra_permissions: '[]' };
  const admin = { role: 'admin', extra_permissions: '[]' };
  const data = {
    party: { id: 1, name: 'س', balance: 5, balance_text: 'لنا عنده', credit_limit: 9 },
    rows: [{ date: '2026-10-01', description: 'x', debit: 1, discount: 2, credit: 3, balance: 4, pieces: 7, total_written: 8 }],
    totals: { debit: 1 }, opening: 1, opening_text: 'x', closing: 2, closing_text: 'y',
    items: [{ qty: 3, rate: 100, amount: 300, line_total: 300, unit_rate: 1, rate_source: 'general' }],
    pending_cheques_amount: 5,
  };
  const s = stripMoney(staff, data);
  assert.deepEqual(s, {
    party: { id: 1, name: 'س' },
    rows: [{ date: '2026-10-01', description: 'x', pieces: 7, total_written: 8 }],
    items: [{ qty: 3, rate_source: 'general' }],
  });
  assert.equal(stripMoney(admin, data), data);
  const elevated = { role: 'staff', extra_permissions: '["money.view"]' };
  assert.equal(stripMoney(elevated, data), data);
  assert.ok(isMoneyKey('cash_total') && isMoneyKey('amount') && !isMoneyKey('client_text') && !isMoneyKey('qty'));
});
