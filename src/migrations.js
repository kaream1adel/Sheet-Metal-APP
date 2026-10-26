// Schema migrations. Each entry runs once, in order, inside one transaction:
// it fully succeeds or nothing changes. NEVER edit a migration that has shipped —
// add a new one. Money columns are integer piastres (1 EGP = 100).

export const MIGRATIONS = [
  {
    id: 1,
    name: 'core',
    sql: `
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','staff')),
  extra_permissions TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  user_agent TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE technicians (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  digit_system TEXT NOT NULL DEFAULT 'arabic' CHECK (digit_system IN ('arabic','western')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE clients (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  opening_balance INTEGER NOT NULL DEFAULT 0,  -- money (piastres), admin only
  opening_date TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE machines (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE materials (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  aliases TEXT NOT NULL DEFAULT '[]',   -- other spellings technicians write
  density REAL NOT NULL DEFAULT 0,      -- g/cm3, for factory material weight
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

-- One paper sheet (or one manual entry) for one machine.
CREATE TABLE sheets (
  id INTEGER PRIMARY KEY,
  machine_id INTEGER NOT NULL REFERENCES machines(id),
  sheet_no TEXT,                        -- printed number from the QR; null for manual
  technician_id INTEGER REFERENCES technicians(id),
  sheet_date TEXT,                      -- YYYY-MM-DD, header date
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','photo')),
  status TEXT NOT NULL DEFAULT 'review' CHECK (status IN ('review','confirmed','cancelled')),
  notes TEXT NOT NULL DEFAULT '',
  photo_path TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  confirmed_by INTEGER REFERENCES users(id),
  confirmed_at TEXT,
  cancelled_by INTEGER REFERENCES users(id),
  cancelled_at TEXT,
  cancel_reason TEXT
);
CREATE UNIQUE INDEX idx_sheets_machine_no ON sheets(machine_id, sheet_no) WHERE sheet_no IS NOT NULL AND status <> 'cancelled';
CREATE INDEX idx_sheets_status ON sheets(status);

-- One row on the sheet: facts only, no money.
CREATE TABLE lines (
  id INTEGER PRIMARY KEY,
  sheet_id INTEGER NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  row_no INTEGER NOT NULL,
  client_id INTEGER REFERENCES clients(id),
  client_text TEXT NOT NULL DEFAULT '',  -- name as written on the paper
  part_name TEXT NOT NULL DEFAULT '',
  material_id INTEGER REFERENCES materials(id),
  thickness REAL,                        -- mm
  pieces REAL,
  ops_per_piece REAL,                    -- bends / cuts per piece
  total_written REAL,                    -- the total the technician wrote (cross-check)
  sheets REAL,                           -- laser / punch: number of sheets
  minutes_per_sheet REAL,                -- laser
  sheet_size TEXT NOT NULL DEFAULT '',   -- punch: e.g. 2500x1250
  pieces_per_sheet REAL,                 -- punch
  hits_per_piece REAL,                   -- punch
  louvers_per_piece REAL,                -- punch
  minutes REAL,                          -- punch: minutes for the row
  work_date TEXT,                        -- YYYY-MM-DD, per row
  material_source TEXT CHECK (material_source IN ('client','factory')),
  notes TEXT NOT NULL DEFAULT '',
  delivered_at TEXT                      -- set by deliveries (step 2)
);
CREATE INDEX idx_lines_sheet ON lines(sheet_id);
CREATE INDEX idx_lines_client ON lines(client_id);

-- Warnings the reviewer looked at before confirming (yellow must be visited).
CREATE TABLE sheet_acks (
  sheet_id INTEGER NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  issue_key TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (sheet_id, issue_key)
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  before_json TEXT,
  after_json TEXT
);
CREATE INDEX idx_audit_entity ON audit_log(entity, entity_id);

CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
`,
  },
  {
    id: 2,
    name: 'pricing-payments-deliveries',
    sql: `
CREATE TABLE settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);

-- A delivery to the client (manager, no money). Lines point at it.
CREATE TABLE deliveries (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  delivery_date TEXT NOT NULL,
  receiver TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  cancelled_by INTEGER REFERENCES users(id),
  cancelled_at TEXT,
  cancel_reason TEXT
);
ALTER TABLE lines ADD COLUMN delivery_id INTEGER REFERENCES deliveries(id);

-- One "اعتماد التسعير": everything approved together, cancellable together.
CREATE TABLE pricing_batches (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  due_date TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  cancelled_by INTEGER REFERENCES users(id),
  cancelled_at TEXT,
  cancel_reason TEXT
);

-- A line priced on its own (a punch line may carry two: hits and louvers).
CREATE TABLE line_prices (
  id INTEGER PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES pricing_batches(id),
  line_id INTEGER NOT NULL REFERENCES lines(id),
  unit TEXT NOT NULL,
  qty REAL NOT NULL,
  rate INTEGER NOT NULL,      -- piastres per unit
  amount INTEGER NOT NULL,    -- piastres
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled'))
);
CREATE UNIQUE INDEX idx_line_prices_active ON line_prices(line_id, unit) WHERE status = 'active';
CREATE INDEX idx_line_prices_batch ON line_prices(batch_id);

-- A grouped item (بند مجمّع): several lines billed as one.
CREATE TABLE billing_items (
  id INTEGER PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES pricing_batches(id),
  client_id INTEGER NOT NULL REFERENCES clients(id),
  description TEXT NOT NULL,
  unit TEXT NOT NULL,
  qty REAL NOT NULL,
  rate INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  item_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled'))
);
CREATE TABLE billing_item_lines (
  item_id INTEGER NOT NULL REFERENCES billing_items(id),
  line_id INTEGER NOT NULL REFERENCES lines(id),
  PRIMARY KEY (item_id, line_id)
);

-- Last rate used per client + operation + material + thickness (0 = none).
CREATE TABLE price_memory (
  client_id INTEGER NOT NULL REFERENCES clients(id),
  machine_code TEXT NOT NULL,
  unit TEXT NOT NULL,
  material_id INTEGER NOT NULL DEFAULT 0,
  thickness REAL NOT NULL DEFAULT 0,
  rate INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (client_id, machine_code, unit, material_id, thickness)
);
CREATE TABLE client_unit_prefs (
  client_id INTEGER NOT NULL REFERENCES clients(id),
  machine_code TEXT NOT NULL,
  unit TEXT NOT NULL,
  PRIMARY KEY (client_id, machine_code)
);

-- Discounts (negative) and extra charges (positive).
CREATE TABLE adjustments (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  adj_date TEXT NOT NULL,
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL,
  batch_id INTEGER REFERENCES pricing_batches(id),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  cancelled_by INTEGER REFERENCES users(id),
  cancelled_at TEXT,
  cancel_reason TEXT
);

-- A cheque counts against the balance only once cleared.
CREATE TABLE payments (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  pay_date TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL,
  reference TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  is_cheque INTEGER NOT NULL DEFAULT 0,
  cheque_due TEXT,
  cheque_status TEXT CHECK (cheque_status IN ('pending','cleared','bounced')),
  cheque_cleared_at TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  cancelled_by INTEGER REFERENCES users(id),
  cancelled_at TEXT,
  cancel_reason TEXT
);
CREATE INDEX idx_payments_client ON payments(client_id);

CREATE TABLE promises (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  promised_date TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  done_at TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`,
  },
  {
    id: 3,
    name: 'printed-forms-photos',
    sql: `
-- Every printed form number, so the same sheet can't be entered twice and a
-- printed sheet that never came back is noticed. Spoiled papers are voided, not deleted.
CREATE TABLE printed_sheets (
  id INTEGER PRIMARY KEY,
  machine_id INTEGER NOT NULL REFERENCES machines(id),
  sheet_no INTEGER NOT NULL,
  form_version INTEGER NOT NULL,
  printed_at TEXT NOT NULL DEFAULT (datetime('now')),
  printed_by INTEGER REFERENCES users(id),
  voided_at TEXT,
  voided_by INTEGER REFERENCES users(id),
  void_reason TEXT,
  UNIQUE (machine_id, sheet_no)
);

-- Photo of the straightened page: { form_version, width, height, quality, uploaded_at }.
ALTER TABLE sheets ADD COLUMN photo_meta TEXT;
`,
  },
  {
    id: 4,
    name: 'ocr',
    sql: `
-- What a reviewed sheet teaches the reader: one row per cut-out (a digit, a whole cell,
-- or "this cell is ~"), as feature bytes. Always rebuildable from the stored photos.
CREATE TABLE ocr_samples (
  id INTEGER PRIMARY KEY,
  sheet_id INTEGER NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  technician_id INTEGER REFERENCES technicians(id),
  type TEXT NOT NULL CHECK (type IN ('kind','cell','digit')),
  field TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL,
  features BLOB NOT NULL,
  feature_version INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_ocr_samples_sheet ON ocr_samples(sheet_id);

-- What the reader suggested for each cell, and (after confirming) what it really was.
CREATE TABLE cell_reads (
  id INTEGER PRIMARY KEY,
  sheet_id INTEGER NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  row_no INTEGER NOT NULL,
  field TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('value','ditto','ink')),
  value TEXT,
  confidence REAL NOT NULL DEFAULT 0,
  candidates TEXT NOT NULL DEFAULT '[]',
  read_at TEXT NOT NULL DEFAULT (datetime('now')),
  final_value TEXT,
  correct INTEGER,
  finalized_at TEXT,
  UNIQUE (sheet_id, row_no, field)
);

-- Cells the reviewer marked "same as above" (~ or //): the reader learns that mark.
ALTER TABLE lines ADD COLUMN ditto_fields TEXT NOT NULL DEFAULT '[]';
`,
  },
  {
    id: 5,
    name: 'profiles-forget',
    sql: `
-- Problems found on each sheet while it was reviewed (first time seen), for the
-- technician's "most frequent mistakes" report.
CREATE TABLE sheet_issue_log (
  sheet_id INTEGER NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  issue_key TEXT NOT NULL,
  code TEXT NOT NULL,
  field TEXT NOT NULL,
  level TEXT NOT NULL,
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (sheet_id, issue_key)
);

-- 1 = the reader must not learn from this sheet (it taught something wrong).
ALTER TABLE sheets ADD COLUMN no_teach INTEGER NOT NULL DEFAULT 0;
`,
  },
];
