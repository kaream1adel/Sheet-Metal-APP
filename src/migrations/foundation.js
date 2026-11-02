// Foundation schema (ids 1-99): every table of the data model, for every module, so the
// modules rarely need a migration of their own. Money columns are INTEGER millimes
// (1 EGP = 1000). Quantities are REAL. Dates are 'YYYY-MM-DD' text, times are
// datetime('now') text. NEVER edit a shipped migration: add a new one.

const SECTIONS = "'press','shear','laser','punch','louver','material'";

// SQLite stores 1.5 in an INTEGER column as REAL without complaint, so a money column needs
// a guard: these triggers refuse any value that is not an integer (millimes) on INSERT and
// UPDATE. A module that adds a money column adds integerMoneyTriggers(table, [column]) to
// its own migration.
export function integerMoneyTriggers(table, columns) {
  return columns.map((c) => ['insert', 'update'].map((op) => `
CREATE TRIGGER ${table}_${c}_millimes_${op} BEFORE ${op.toUpperCase()}${op === 'update' ? ` OF ${c}` : ''} ON ${table}
WHEN NEW.${c} IS NOT NULL AND typeof(NEW.${c}) <> 'integer'
BEGIN SELECT RAISE(ABORT, '${table}.${c}: money must be integer millimes'); END;`).join('')).join('\n');
}

// Every money column of migration 1.
const MONEY_COLUMNS = {
  parties: ['credit_limit'],
  postings: ['debit', 'credit'],
  general_prices: ['rate', 'min_charge'],
  client_rates: ['rate'],
  pricing_batches: ['total'],
  price_items: ['rate', 'min_charge', 'amount'],
  cheques: ['amount'],
  receipts: ['amount'],
  vouchers: ['total'],
  voucher_lines: ['amount'],
  transfers: ['amount'],
  cash_counts: ['expected', 'counted', 'difference'],
  recurring_expenses: ['amount'],
};

export const MIGRATIONS = [
  {
    id: 1,
    name: 'foundation',
    sql: `
-- ---------- infrastructure ----------
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','staff')),
  extra_permissions TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
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
CREATE INDEX idx_audit_at ON audit_log(at);

CREATE TABLE settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
INSERT INTO meta (k, v) VALUES ('product', 'safa-v2');

-- Serial numbers for every document: prefix → next number. "تش-0001".
CREATE TABLE sequences (
  prefix TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  next INTEGER NOT NULL DEFAULT 1 CHECK (next >= 1)
);
INSERT INTO sequences (prefix, name) VALUES
  ('تش', 'ورقة تشغيل'), ('أم', 'أمر شغل'), ('قب', 'إيصال استلام نقدية'), ('صر', 'إذن صرف'),
  ('شك', 'شيك'), ('تس', 'تسعير وترحيل ورقة'), ('قي', 'قيد يدوي'), ('قد', 'رقم القيد'),
  ('تح', 'تحويل'), ('جر', 'جرد الخزينة');

-- Posted dates inside a locked month are refused (src/ledger.js).
CREATE TABLE month_locks (
  month TEXT PRIMARY KEY CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  locked_by INTEGER REFERENCES users(id),
  locked_at TEXT NOT NULL DEFAULT (datetime('now')),
  note TEXT NOT NULL DEFAULT ''
);

-- One run of the Excel import (module import). Everything it created carries its id.
CREATE TABLE import_runs (
  id INTEGER PRIMARY KEY,
  file_name TEXT NOT NULL DEFAULT '',
  file_hash TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'preview' CHECK (status IN ('preview','applied','rolled_back','failed')),
  summary_json TEXT NOT NULL DEFAULT '{}',
  decisions_json TEXT NOT NULL DEFAULT '{}',
  reconciliation_json TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  applied_at TEXT,
  rolled_back_at TEXT
);

-- ---------- people ----------
-- Clients, suppliers, partners and workers. One name per kind; other spellings are aliases.
CREATE TABLE parties (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('client','supplier','partner','worker')),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  aliases TEXT NOT NULL DEFAULT '[]',
  phone TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  credit_limit INTEGER CHECK (credit_limit IS NULL OR credit_limit >= 0),
  is_walk_in INTEGER NOT NULL DEFAULT 0 CHECK (is_walk_in IN (0,1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  import_run_id INTEGER REFERENCES import_runs(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (kind, name)
);
CREATE INDEX idx_parties_kind ON parties(kind, active);

CREATE TABLE technicians (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE CHECK (length(trim(name)) > 0),
  machine TEXT CHECK (machine IS NULL OR machine IN ('press','shear','laser','punch')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Material names with their density (g/cm3) and group (Excel density table).
CREATE TABLE materials (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE CHECK (length(trim(name)) > 0),
  aliases TEXT NOT NULL DEFAULT '[]',
  density REAL CHECK (density IS NULL OR density > 0),
  grp TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  import_run_id INTEGER REFERENCES import_runs(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Generic common densities. The real table comes from the Excel import.
INSERT INTO materials (name, aliases, density, grp, sort) VALUES
  ('أسود', '["اسود","حديد اسود","صاج اسود","بلاك"]', 7.85, 'أسود', 1),
  ('مجلفن', '["جلفنة","مجلفن","صاج مجلفن"]', 7.85, 'مجلفن', 2),
  ('ستانلس', '["استانلس","ستانلس ستيل","ستانليس"]', 7.93, 'ستانلس', 3),
  ('ألومنيوم', '["الومنيوم","المونيوم","ألمنيوم"]', 2.7, 'ألومنيوم', 4);

CREATE TABLE expense_categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE CHECK (length(trim(name)) > 0),
  keywords TEXT NOT NULL DEFAULT '[]',
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO expense_categories (id, name, keywords, sort) VALUES
  (1, 'مرتبات وأجور', '["مرتب","مرتبات","أجور","اجور","يومية"]', 1),
  (2, 'إيجار', '["إيجار","ايجار"]', 2),
  (3, 'كهرباء ومياه', '["كهرباء","كهربا","مياه","مية"]', 3),
  (4, 'تأمينات', '["تأمينات","تامينات"]', 4),
  (5, 'خامات ومستلزمات', '["خامات","مستلزمات"]', 5),
  (6, 'أعمال خارجية (دهان ولحام)', '["دهان","لحام","خارجي"]', 6),
  (7, 'نقل', '["نقل","نولون","عربية"]', 7),
  (8, 'ضيافة', '["ضيافة","شاي","قهوة","أكل"]', 8),
  (9, 'صيانة وقطع غيار', '["صيانة","قطع غيار","تصليح"]', 9),
  (10, 'مصاريف إدارية', '["إدارية","ادارية","أدوات مكتبية"]', 10),
  (11, 'متنوعة', '[]', 11);

-- ---------- the ledger (src/ledger.js is the only writer) ----------
-- Chart of accounts. Accounts with party_kind need a party on every posting.
CREATE TABLE accounts (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('asset','liability','equity','revenue','expense')),
  party_kind TEXT CHECK (party_kind IS NULL OR party_kind IN ('client','supplier','partner','worker')),
  expense_category_id INTEGER REFERENCES expense_categories(id),
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
);
INSERT INTO accounts (code, name, type, party_kind, sort) VALUES
  ('cash', 'الخزينة', 'asset', NULL, 10),
  ('bank', 'البنك', 'asset', NULL, 11),
  ('receivable', 'العملاء', 'asset', 'client', 20),
  ('cheques_in_portfolio', 'أوراق القبض', 'asset', NULL, 21),
  ('worker', 'سلف العمال', 'asset', 'worker', 22),
  ('cheques_payable', 'أوراق الدفع', 'liability', NULL, 30),
  ('payable', 'الموردين', 'liability', 'supplier', 31),
  ('partner', 'جاري الشركاء', 'equity', 'partner', 40),
  ('opening_equity', 'أرصدة أول المدة', 'equity', NULL, 41),
  ('revenue:press', 'إيراد التناية', 'revenue', NULL, 50),
  ('revenue:shear', 'إيراد المقص', 'revenue', NULL, 51),
  ('revenue:laser', 'إيراد الليزر', 'revenue', NULL, 52),
  ('revenue:punch', 'إيراد البنش', 'revenue', NULL, 53),
  ('revenue:louver', 'إيراد اللوفر', 'revenue', NULL, 54),
  ('revenue:material', 'إيراد الخامات', 'revenue', NULL, 55),
  ('revenue:manual', 'إيرادات أخرى (قيود يدوية)', 'revenue', NULL, 56),
  ('revenue:recharge', 'مصروفات محملة على العملاء', 'revenue', NULL, 57),
  ('discount_given', 'خصم مسموح به', 'expense', NULL, 60),
  ('materials_purchases', 'مشتريات خامات', 'expense', NULL, 61),
  ('cash_over_short', 'فروق جرد الخزينة', 'expense', NULL, 62);
INSERT INTO accounts (code, name, type, expense_category_id, sort)
  SELECT 'expense:' || id, 'مصروف: ' || name, 'expense', id, 100 + sort FROM expense_categories;

-- A transaction: one balanced set of postings. Never edited or deleted after posting;
-- a cancel is a reversing transaction (reversal_of) and the original becomes 'reversed'.
CREATE TABLE txns (
  id INTEGER PRIMARY KEY,
  serial TEXT NOT NULL UNIQUE,
  ref TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  date TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  description TEXT NOT NULL DEFAULT '',
  doc_type TEXT,
  doc_id INTEGER,
  party_id INTEGER REFERENCES parties(id),
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','reversed')),
  reversal_of INTEGER REFERENCES txns(id),
  reversed_by INTEGER REFERENCES txns(id),
  reason TEXT NOT NULL DEFAULT '',
  import_run_id INTEGER REFERENCES import_runs(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_txns_date ON txns(date);
CREATE INDEX idx_txns_doc ON txns(doc_type, doc_id);
CREATE INDEX idx_txns_party ON txns(party_id);
CREATE INDEX idx_txns_import ON txns(import_run_id);

CREATE TABLE postings (
  id INTEGER PRIMARY KEY,
  txn_id INTEGER NOT NULL REFERENCES txns(id),
  account TEXT NOT NULL REFERENCES accounts(code),
  party_id INTEGER REFERENCES parties(id),
  debit INTEGER NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit INTEGER NOT NULL DEFAULT 0 CHECK (credit >= 0),
  cost_party_id INTEGER REFERENCES parties(id),
  section TEXT CHECK (section IS NULL OR section IN (${SECTIONS})),
  memo TEXT NOT NULL DEFAULT '',
  CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0))
);
CREATE INDEX idx_postings_txn ON postings(txn_id);
CREATE INDEX idx_postings_account ON postings(account, party_id);
CREATE INDEX idx_postings_party ON postings(party_id);
CREATE INDEX idx_postings_cost ON postings(cost_party_id);

-- ---------- operations ----------
CREATE TABLE work_orders (
  id INTEGER PRIMARY KEY,
  serial TEXT NOT NULL UNIQUE,
  client_id INTEGER NOT NULL REFERENCES parties(id),
  date TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done','delivered','cancelled')),
  notes TEXT NOT NULL DEFAULT '',
  cancel_reason TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE INDEX idx_work_orders_client ON work_orders(client_id, status);

-- ورقة تشغيل: one technician's daily paper for one machine.
CREATE TABLE op_sheets (
  id INTEGER PRIMARY KEY,
  serial TEXT NOT NULL UNIQUE,
  machine TEXT NOT NULL CHECK (machine IN ('press','shear','laser','punch')),
  technician_id INTEGER REFERENCES technicians(id),
  sheet_date TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','photo','import')),
  photo_path TEXT,
  status TEXT NOT NULL DEFAULT 'review' CHECK (status IN ('review','approved','cancelled')),
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  priced_status TEXT NOT NULL DEFAULT 'none' CHECK (priced_status IN ('none','partial','posted')),
  cancel_reason TEXT NOT NULL DEFAULT '',
  cancelled_by INTEGER REFERENCES users(id),
  cancelled_at TEXT,
  notes TEXT NOT NULL DEFAULT '',
  import_run_id INTEGER REFERENCES import_runs(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_op_sheets_status ON op_sheets(status, priced_status);
CREATE INDEX idx_op_sheets_date ON op_sheets(sheet_date, machine);

-- بند تشغيل: one line of the paper, with the paper's own columns.
CREATE TABLE op_lines (
  id INTEGER PRIMARY KEY,
  sheet_id INTEGER NOT NULL REFERENCES op_sheets(id),
  row_no INTEGER NOT NULL,
  client_id INTEGER REFERENCES parties(id),
  client_text TEXT NOT NULL DEFAULT '',
  work_order_id INTEGER REFERENCES work_orders(id),
  part_name TEXT NOT NULL DEFAULT '',
  material_id INTEGER REFERENCES materials(id),
  material_text TEXT NOT NULL DEFAULT '',
  thickness REAL CHECK (thickness IS NULL OR thickness > 0),
  pieces REAL CHECK (pieces IS NULL OR pieces >= 0),
  per_piece REAL CHECK (per_piece IS NULL OR per_piece >= 0),        -- bends / cuts per piece
  total_written REAL,                                                -- the technician's own total
  sheets REAL CHECK (sheets IS NULL OR sheets >= 0),                 -- laser / punch: sheets
  minutes_per_sheet REAL CHECK (minutes_per_sheet IS NULL OR minutes_per_sheet >= 0),
  start_time TEXT NOT NULL DEFAULT '',
  end_time TEXT NOT NULL DEFAULT '',
  single_piece INTEGER NOT NULL DEFAULT 0 CHECK (single_piece IN (0,1)),
  louvers_per_piece REAL CHECK (louvers_per_piece IS NULL OR louvers_per_piece >= 0),
  hits_per_piece REAL CHECK (hits_per_piece IS NULL OR hits_per_piece >= 0),
  sheet_size TEXT NOT NULL DEFAULT '',
  pieces_per_sheet REAL,
  material_source TEXT CHECK (material_source IS NULL OR material_source IN ('client','factory')),
  length_cm REAL CHECK (length_cm IS NULL OR length_cm > 0),
  width_cm REAL CHECK (width_cm IS NULL OR width_cm > 0),
  work_date TEXT,
  ditto_fields TEXT NOT NULL DEFAULT '[]',
  read_json TEXT,                                                    -- what the AI read, per cell
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','settled_in_excel','cancelled')),
  import_run_id INTEGER REFERENCES import_runs(id),
  UNIQUE (sheet_id, row_no)
);
CREATE INDEX idx_op_lines_client ON op_lines(client_id);
CREATE INDEX idx_op_lines_order ON op_lines(work_order_id);

-- The review gate: red must be fixed, yellow must be visited (acked).
CREATE TABLE sheet_issues (
  id INTEGER PRIMARY KEY,
  sheet_id INTEGER NOT NULL REFERENCES op_sheets(id),
  line_id INTEGER REFERENCES op_lines(id),
  field TEXT NOT NULL DEFAULT '',
  level TEXT NOT NULL CHECK (level IN ('red','yellow')),
  code TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  acked_by INTEGER REFERENCES users(id),
  acked_at TEXT,
  resolved INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_sheet_issues_sheet ON sheet_issues(sheet_id, resolved);

-- The AI reading queue (photo → op_sheet in review).
CREATE TABLE photo_jobs (
  id INTEGER PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','reading','done','needs_machine','failed','dismissed')),
  photo_path TEXT NOT NULL,
  photo_meta TEXT NOT NULL DEFAULT '{}',
  machine TEXT CHECK (machine IS NULL OR machine IN ('press','shear','laser','punch')),
  technician_id INTEGER REFERENCES technicians(id),
  sheet_id INTEGER REFERENCES op_sheets(id),
  result_json TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  ready_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX idx_photo_jobs_status ON photo_jobs(status, ready_at);

CREATE TABLE ai_usage (
  id INTEGER PRIMARY KEY,
  sheet_id INTEGER REFERENCES op_sheets(id),
  job_id INTEGER REFERENCES photo_jobs(id),
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micro_usd INTEGER NOT NULL DEFAULT 0,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------- pricing ----------
-- الأسعار العامة: the fallback rate per section (press by thickness band).
CREATE TABLE general_prices (
  id INTEGER PRIMARY KEY,
  section TEXT NOT NULL CHECK (section IN (${SECTIONS})),
  band TEXT NOT NULL DEFAULT '' CHECK (band IN ('<3','>=3','')),
  rate INTEGER CHECK (rate IS NULL OR rate >= 0),
  min_charge INTEGER CHECK (min_charge IS NULL OR min_charge >= 0),
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT,
  UNIQUE (section, band)
);
INSERT INTO general_prices (section, band, rate, min_charge) VALUES
  ('press', '<3', NULL, NULL), ('press', '>=3', NULL, NULL), ('shear', '', NULL, NULL),
  ('laser', '', NULL, 150000), ('punch', '', NULL, 150000), ('louver', '', NULL, NULL), ('material', '', NULL, NULL);

-- A client's known rate per section (Excel row 4, or set by the admin): a suggested-rate source.
CREATE TABLE client_rates (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES parties(id),
  section TEXT NOT NULL CHECK (section IN (${SECTIONS})),
  band TEXT NOT NULL DEFAULT '' CHECK (band IN ('<3','>=3','')),
  rate INTEGER NOT NULL CHECK (rate >= 0),
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','import')),
  import_run_id INTEGER REFERENCES import_runs(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (client_id, section, band)
);

-- تسعير ورقة: one client's items of one sheet, posted in one transaction (serial تس).
CREATE TABLE pricing_batches (
  id INTEGER PRIMARY KEY,
  serial TEXT NOT NULL UNIQUE,
  sheet_id INTEGER REFERENCES op_sheets(id),
  client_id INTEGER NOT NULL REFERENCES parties(id),
  date TEXT NOT NULL,
  total INTEGER NOT NULL DEFAULT 0,
  txn_id INTEGER REFERENCES txns(id),
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','reversed')),
  reason TEXT NOT NULL DEFAULT '',
  import_run_id INTEGER REFERENCES import_runs(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_pricing_batches_sheet ON pricing_batches(sheet_id);
CREATE INDEX idx_pricing_batches_client ON pricing_batches(client_id);

-- One priced item (from an op_line, or imported / added by hand).
CREATE TABLE price_items (
  id INTEGER PRIMARY KEY,
  serial TEXT,
  op_line_id INTEGER REFERENCES op_lines(id),
  sheet_id INTEGER REFERENCES op_sheets(id),
  batch_id INTEGER REFERENCES pricing_batches(id),
  client_id INTEGER NOT NULL REFERENCES parties(id),
  section TEXT NOT NULL CHECK (section IN (${SECTIONS})),
  work_date TEXT,
  part_name TEXT NOT NULL DEFAULT '',
  material_id INTEGER REFERENCES materials(id),
  thickness REAL,
  pieces REAL,
  per_piece REAL,
  sheets REAL,
  minutes_per_sheet REAL,
  single_piece INTEGER NOT NULL DEFAULT 0 CHECK (single_piece IN (0,1)),
  length_cm REAL,
  width_cm REAL,
  weight_kg REAL,
  qty REAL,
  unit TEXT NOT NULL DEFAULT '',
  rate INTEGER CHECK (rate IS NULL OR rate >= 0),
  min_charge INTEGER CHECK (min_charge IS NULL OR min_charge >= 0),
  amount INTEGER,
  billing TEXT NOT NULL CHECK (billing IN ('bend','cut','minute','louver','kg','piece','lump')),
  rate_source TEXT CHECK (rate_source IS NULL OR rate_source IN ('last_same','last_section','general','manual','import')),
  status TEXT NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested','posted','cancelled','settled_in_excel')),
  txn_id INTEGER REFERENCES txns(id),
  corrected_from INTEGER REFERENCES price_items(id),
  import_ref TEXT,
  import_run_id INTEGER REFERENCES import_runs(id),
  notes TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_price_items_client ON price_items(client_id, section, status);
CREATE INDEX idx_price_items_sheet ON price_items(sheet_id);
CREATE INDEX idx_price_items_line ON price_items(op_line_id);
CREATE INDEX idx_price_items_import ON price_items(import_run_id);

-- ---------- treasury ----------
CREATE TABLE cheques (
  id INTEGER PRIMARY KEY,
  serial TEXT NOT NULL UNIQUE,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  party_id INTEGER REFERENCES parties(id),
  number TEXT NOT NULL DEFAULT '',
  bank TEXT NOT NULL DEFAULT '',
  amount INTEGER NOT NULL CHECK (amount > 0),
  received_date TEXT,
  issued_date TEXT,
  due_date TEXT,
  deposit_date TEXT,
  cleared_date TEXT,
  bounced_date TEXT,
  bounce_reason TEXT NOT NULL DEFAULT '',
  endorsed_to_party_id INTEGER REFERENCES parties(id),
  status TEXT NOT NULL CHECK (status IN ('in_portfolio','deposited','collected','endorsed','bounced','issued','cleared','cancelled')),
  issue_txn_id INTEGER REFERENCES txns(id),
  collect_txn_id INTEGER REFERENCES txns(id),
  clear_txn_id INTEGER REFERENCES txns(id),
  endorse_txn_id INTEGER REFERENCES txns(id),
  bounce_txn_id INTEGER REFERENCES txns(id),
  notes TEXT NOT NULL DEFAULT '',
  import_run_id INTEGER REFERENCES import_runs(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((direction = 'in' AND status IN ('in_portfolio','deposited','collected','endorsed','bounced','cancelled'))
      OR (direction = 'out' AND status IN ('issued','cleared','bounced','cancelled')))
);
CREATE INDEX idx_cheques_status ON cheques(direction, status, due_date);
CREATE INDEX idx_cheques_party ON cheques(party_id);

-- إيصال استلام نقدية (serial قب). Partner deposits are receipts from a partner.
CREATE TABLE receipts (
  id INTEGER PRIMARY KEY,
  serial TEXT NOT NULL UNIQUE,
  party_id INTEGER NOT NULL REFERENCES parties(id),
  date TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL CHECK (method IN ('cash','transfer','instapay','wallet','cheque')),
  account TEXT CHECK (account IS NULL OR account IN ('cash','bank')),
  cheque_id INTEGER REFERENCES cheques(id),
  notes TEXT NOT NULL DEFAULT '',
  txn_id INTEGER REFERENCES txns(id),
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','cancelled')),
  cancel_reason TEXT NOT NULL DEFAULT '',
  import_run_id INTEGER REFERENCES import_runs(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_receipts_party ON receipts(party_id, date);

-- إذن صرف (serial صر): expenses, partner withdrawals, material purchases, worker advances.
CREATE TABLE vouchers (
  id INTEGER PRIMARY KEY,
  serial TEXT NOT NULL UNIQUE,
  date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('expense','partner_withdrawal','material_purchase','worker_advance','supplier_payment','other')),
  paid_from TEXT NOT NULL CHECK (paid_from IN ('cash','bank','cheque','partner','supplier_credit','client_offset')),
  paid_from_party_id INTEGER REFERENCES parties(id),
  party_id INTEGER REFERENCES parties(id),
  cheque_id INTEGER REFERENCES cheques(id),
  total INTEGER NOT NULL CHECK (total > 0),
  description TEXT NOT NULL DEFAULT '',
  txn_id INTEGER REFERENCES txns(id),
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','cancelled')),
  cancel_reason TEXT NOT NULL DEFAULT '',
  recurring_id INTEGER,
  import_run_id INTEGER REFERENCES import_runs(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_vouchers_date ON vouchers(date, kind);

CREATE TABLE voucher_lines (
  id INTEGER PRIMARY KEY,
  voucher_id INTEGER NOT NULL REFERENCES vouchers(id),
  category_id INTEGER REFERENCES expense_categories(id),
  cost_party_id INTEGER REFERENCES parties(id),      -- مركز التكلفة: a client (or NULL = general)
  worker_id INTEGER REFERENCES parties(id),
  recharge INTEGER NOT NULL DEFAULT 0 CHECK (recharge IN (0,1)),   -- يتحمّل على العميل
  amount INTEGER NOT NULL CHECK (amount > 0),
  description TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_voucher_lines_voucher ON voucher_lines(voucher_id);
CREATE INDEX idx_voucher_lines_cost ON voucher_lines(cost_party_id);

CREATE TABLE transfers (
  id INTEGER PRIMARY KEY,
  serial TEXT NOT NULL UNIQUE,
  date TEXT NOT NULL,
  from_account TEXT NOT NULL CHECK (from_account IN ('cash','bank')),
  to_account TEXT NOT NULL CHECK (to_account IN ('cash','bank')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  notes TEXT NOT NULL DEFAULT '',
  txn_id INTEGER REFERENCES txns(id),
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','cancelled')),
  cancel_reason TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (from_account <> to_account)
);

-- جرد الخزينة: counted vs the ledger; the difference posts to cash_over_short.
CREATE TABLE cash_counts (
  id INTEGER PRIMARY KEY,
  serial TEXT NOT NULL UNIQUE,
  date TEXT NOT NULL,
  account TEXT NOT NULL DEFAULT 'cash' CHECK (account IN ('cash','bank')),
  expected INTEGER NOT NULL,
  counted INTEGER NOT NULL CHECK (counted >= 0),
  difference INTEGER NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  txn_id INTEGER REFERENCES txns(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE recurring_expenses (
  id INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES expense_categories(id),
  description TEXT NOT NULL DEFAULT '',
  amount INTEGER NOT NULL CHECK (amount > 0),
  day_of_month INTEGER NOT NULL DEFAULT 1 CHECK (day_of_month BETWEEN 1 AND 28),
  paid_from TEXT NOT NULL DEFAULT 'cash' CHECK (paid_from IN ('cash','bank','partner')),
  paid_from_party_id INTEGER REFERENCES parties(id),
  cost_party_id INTEGER REFERENCES parties(id),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  last_month TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------- follow-up ----------
CREATE TABLE follow_ups (
  id INTEGER PRIMARY KEY,
  party_id INTEGER NOT NULL REFERENCES parties(id),
  note TEXT NOT NULL DEFAULT '',
  next_date TEXT,
  done INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0,1)),
  done_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_follow_ups_due ON follow_ups(done, next_date);
`,
  },
  {
    id: 2,
    name: 'money columns hold integer millimes only',
    sql: Object.entries(MONEY_COLUMNS).map(([t, cols]) => integerMoneyTriggers(t, cols)).join('\n'),
  },
];
