// Dates: only real calendar days are accepted, everywhere (util.parseDate is the one rule;
// the ledger refuses a posting dated on a day that does not exist).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDate, isRealDate, requireDate } from '../src/util.js';

test('parseDate: real days pass, impossible ones are invalid, blank is null', () => {
  for (const ok of ['2026-02-28', '2028-02-29', '2026-12-31', '٢٠٢٦-١٠-١٥', ' 2026-01-01 ']) assert.ok(parseDate(ok), ok);
  assert.equal(parseDate('٢٠٢٦-١٠-١٥'), '2026-10-15');
  for (const bad of ['2026-02-31', '2026-13-40', '2026-02-29', '2026-00-10', '2026-04-31', '2026-2-5', '15/10/2026', 'abc', '1999-01-01'])
    assert.equal(parseDate(bad), undefined, bad);
  for (const blank of ['', null, undefined, '  ']) assert.equal(parseDate(blank), null);
  assert.equal(isRealDate('2026-02-30'), null);
});

test('requireDate: Arabic 400 naming the field', () => {
  assert.throws(() => requireDate('2026-02-31', { field: 'due_date', label: 'تاريخ الاستحقاق' }),
    (e) => e.status === 400 && e.extra.field === 'due_date' && /تاريخ الاستحقاق غلط/.test(e.message));
  assert.throws(() => requireDate('', { field: 'date' }), (e) => e.status === 400 && /اكتب/.test(e.message));
  assert.equal(requireDate('', { required: false, fallback: '2026-01-01' }), '2026-01-01');
});
