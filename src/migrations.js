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
];
