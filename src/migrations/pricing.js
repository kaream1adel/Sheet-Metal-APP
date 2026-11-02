// Pricing module migrations (ids 200-299). The foundation already created price_items,
// pricing_batches, general_prices and client_rates; this adds what the pricing screens need.
// NEVER edit a shipped migration: add a new one.
import { integerMoneyTriggers } from './foundation.js';

export const MIGRATIONS = [
  {
    id: 200,
    name: 'pricing: confirmed rates, sheet discounts/additions, manual client entries',
    sql: `
-- A suggested rate shows grey until the admin confirms it (types it or accepts it).
ALTER TABLE price_items ADD COLUMN rate_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (rate_confirmed IN (0,1));
-- Why a cancelled item is cancelled: excluded by the admin (can be restored), replaced by a
-- «تصحيح سعر», or its line left the sheet.
ALTER TABLE price_items ADD COLUMN cancel_kind TEXT CHECK (cancel_kind IS NULL OR cancel_kind IN ('excluded','corrected','line_removed'));
ALTER TABLE price_items ADD COLUMN cancel_reason TEXT NOT NULL DEFAULT '';

-- Item generation is idempotent: one live (suggested / posted) item per line per section.
CREATE UNIQUE INDEX uq_price_items_live ON price_items(op_line_id, section)
  WHERE op_line_id IS NOT NULL AND status IN ('suggested','posted');

-- خصم / إضافة on one client's part of a sheet. batch_id NULL = a draft before the posting.
CREATE TABLE pricing_adjustments (
  id INTEGER PRIMARY KEY,
  sheet_id INTEGER NOT NULL REFERENCES op_sheets(id),
  client_id INTEGER NOT NULL REFERENCES parties(id),
  batch_id INTEGER REFERENCES pricing_batches(id),
  discount_amount INTEGER NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  addition_amount INTEGER NOT NULL DEFAULT 0 CHECK (addition_amount >= 0),
  note TEXT NOT NULL DEFAULT '',
  discount_txn_id INTEGER REFERENCES txns(id),
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX uq_pricing_adjustments_draft ON pricing_adjustments(sheet_id, client_id) WHERE batch_id IS NULL;
CREATE INDEX idx_pricing_adjustments_batch ON pricing_adjustments(batch_id);

-- قيد يدوي على عميل (serial قي): a manual debit, discount or addition on the client's account.
CREATE TABLE manual_entries (
  id INTEGER PRIMARY KEY,
  serial TEXT NOT NULL UNIQUE,
  client_id INTEGER NOT NULL REFERENCES parties(id),
  kind TEXT NOT NULL CHECK (kind IN ('debit','discount','addition')),
  date TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  amount INTEGER NOT NULL CHECK (amount > 0),
  description TEXT NOT NULL CHECK (length(trim(description)) > 0),
  txn_id INTEGER REFERENCES txns(id),
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','cancelled')),
  cancel_reason TEXT NOT NULL DEFAULT '',
  cancelled_by INTEGER REFERENCES users(id),
  cancelled_at TEXT,
  import_run_id INTEGER REFERENCES import_runs(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_manual_entries_client ON manual_entries(client_id, date);

${integerMoneyTriggers('pricing_adjustments', ['discount_amount', 'addition_amount'])}
${integerMoneyTriggers('manual_entries', ['amount'])}
`,
  },
];
