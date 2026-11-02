// Treasury module schema (ids 300-399). The foundation already has receipts, vouchers,
// voucher_lines, cheques, transfers, cash_counts and recurring_expenses; this adds what the
// module needs on top: the bill photo and salary advance deduction on a voucher, the items of
// a material purchase, the payee text of our cheques, and the record of each recurring
// expense month (confirmed or skipped), so a month's draft is prepared exactly once.
// NEVER edit a shipped migration: add a new one.
import { integerMoneyTriggers } from './foundation.js';

export const MIGRATIONS = [
  {
    id: 300,
    name: 'treasury: voucher photo, purchase items, recurring runs, cheque payee',
    sql: `
ALTER TABLE vouchers ADD COLUMN photo_path TEXT;
-- Salary paid with part of the worker's advance taken back (خصم من السلفة).
ALTER TABLE vouchers ADD COLUMN deduction_amount INTEGER NOT NULL DEFAULT 0 CHECK (deduction_amount >= 0);
${integerMoneyTriggers('vouchers', ['deduction_amount'])}

-- شراء خامات: one line per material on the supplier's bill. line_amount = mulRound(qty, unit_rate).
CREATE TABLE purchase_items (
  id INTEGER PRIMARY KEY,
  voucher_id INTEGER NOT NULL REFERENCES vouchers(id),
  material_id INTEGER REFERENCES materials(id),
  material_text TEXT NOT NULL DEFAULT '',
  thickness REAL CHECK (thickness IS NULL OR thickness > 0),
  qty REAL NOT NULL CHECK (qty > 0),
  unit TEXT NOT NULL DEFAULT '',
  unit_rate INTEGER NOT NULL CHECK (unit_rate > 0),
  line_amount INTEGER NOT NULL CHECK (line_amount > 0)
);
CREATE INDEX idx_purchase_items_voucher ON purchase_items(voucher_id);
${integerMoneyTriggers('purchase_items', ['unit_rate', 'line_amount'])}

-- Who our cheque is written to when the payee is not a party (e.g. the electricity company).
ALTER TABLE cheques ADD COLUMN payee_text TEXT NOT NULL DEFAULT '';

-- The month a recurring template starts preparing drafts (YYYY-MM).
ALTER TABLE recurring_expenses ADD COLUMN start_month TEXT;
UPDATE recurring_expenses SET start_month = substr(created_at, 1, 7) WHERE start_month IS NULL;

-- One row per template per month once the admin confirmed it (a voucher) or skipped it.
-- A month with no row is a draft waiting for the admin.
CREATE TABLE recurring_runs (
  id INTEGER PRIMARY KEY,
  recurring_id INTEGER NOT NULL REFERENCES recurring_expenses(id),
  month TEXT NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  status TEXT NOT NULL CHECK (status IN ('confirmed','skipped')),
  voucher_id INTEGER REFERENCES vouchers(id),
  reason TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (recurring_id, month)
);
CREATE INDEX idx_vouchers_recurring ON vouchers(recurring_id);
CREATE INDEX idx_receipts_cheque ON receipts(cheque_id);
`,
  },
];
