// The schema from an empty database: every table, the seeds, the loader rules, and the
// old app's database being recognised (and left alone) by check-db.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safa-mig-'));
process.env.SHEETMETAL_DATA = dir;
const { openDb, closeDb, getDb, dbPath, MIGRATIONS, LATEST_SCHEMA, schemaVersion, migrate, isLegacyDatabase } = await import('../src/db.js');

before(() => openDb());
after(() => { closeDb(); fs.rmSync(dir, { recursive: true, force: true }); });

const TABLES = ['users', 'sessions', 'audit_log', 'settings', 'meta', 'schema_migrations', 'sequences', 'month_locks',
  'import_runs', 'parties', 'technicians', 'materials', 'expense_categories', 'accounts', 'txns', 'postings',
  'work_orders', 'op_sheets', 'op_lines', 'sheet_issues', 'photo_jobs', 'ai_usage', 'general_prices', 'client_rates',
  'pricing_batches', 'price_items', 'cheques', 'receipts', 'vouchers', 'voucher_lines', 'transfers', 'cash_counts',
  'recurring_expenses', 'follow_ups'];

test('the database file is data/safa.sqlite and every table exists', () => {
  assert.equal(path.basename(dbPath()), 'safa.sqlite');
  assert.ok(fs.existsSync(path.join(dir, 'safa.sqlite')));
  const have = new Set(getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
  for (const t of TABLES) assert.ok(have.has(t), t);
  assert.equal(schemaVersion(), LATEST_SCHEMA);
  assert.equal(getDb().pragma('foreign_key_check').length, 0);
});

test('seeds: accounts with Arabic names, categories with accounts, materials, general prices, sequences', () => {
  const d = getDb();
  const acc = Object.fromEntries(d.prepare('SELECT code, name FROM accounts').all().map((a) => [a.code, a.name]));
  assert.equal(acc.cash, 'الخزينة');
  assert.equal(acc.bank, 'البنك');
  assert.equal(acc.cheques_in_portfolio, 'أوراق القبض');
  assert.equal(acc.cheques_payable, 'أوراق الدفع');
  for (const c of ['receivable', 'payable', 'partner', 'worker', 'discount_given', 'materials_purchases', 'cash_over_short', 'opening_equity',
    'revenue:press', 'revenue:shear', 'revenue:laser', 'revenue:punch', 'revenue:louver', 'revenue:material', 'revenue:manual', 'revenue:recharge']) {
    assert.ok(acc[c], c);
  }
  const cats = d.prepare('SELECT * FROM expense_categories').all();
  assert.equal(cats.length, 11);
  assert.ok(cats.some((c) => c.name === 'مرتبات وأجور'));
  for (const c of cats) assert.ok(acc[`expense:${c.id}`], c.name);
  const mats = d.prepare('SELECT name, density, grp FROM materials').all();
  assert.deepEqual(mats.map((m) => m.density).sort(), [2.7, 7.85, 7.85, 7.93]);
  const gp = d.prepare('SELECT section, band, rate, min_charge FROM general_prices').all();
  assert.equal(gp.length, 7);
  assert.equal(gp.find((g) => g.section === 'laser').min_charge, 150000);
  assert.equal(gp.find((g) => g.section === 'punch').min_charge, 150000);
  assert.ok(gp.every((g) => g.rate === null));
  const seq = d.prepare('SELECT prefix FROM sequences').all().map((r) => r.prefix);
  for (const p of ['تش', 'أم', 'قب', 'صر', 'شك', 'تس', 'قي']) assert.ok(seq.includes(p), p);
});

test('CHECK constraints guard the shapes', () => {
  const d = getDb();
  assert.throws(() => d.prepare("INSERT INTO parties (kind, name) VALUES ('boss', 'x')").run());
  d.prepare("INSERT INTO parties (kind, name) VALUES ('client', 'عميل فحص')").run();
  assert.throws(() => d.prepare("INSERT INTO parties (kind, name) VALUES ('client', 'عميل فحص')").run()); // unique per kind
  d.prepare("INSERT INTO parties (kind, name) VALUES ('supplier', 'عميل فحص')").run();                // other kind is fine
  assert.throws(() => d.prepare("INSERT INTO op_sheets (serial, machine, sheet_date) VALUES ('x', 'drill', '2026-10-01')").run());
  assert.throws(() => d.prepare("INSERT INTO price_items (client_id, section, billing) VALUES (1, 'press', 'hour')").run());
  assert.throws(() => d.prepare("INSERT INTO cheques (serial, direction, amount, status) VALUES ('c', 'in', 5, 'issued')").run());
  assert.throws(() => d.prepare("INSERT INTO transfers (serial, date, from_account, to_account, amount) VALUES ('t', '2026-10-01', 'cash', 'cash', 5)").run());
});

test('migrations are merged from src/migrations/*.js, sorted, in their id ranges', () => {
  assert.ok(MIGRATIONS.length >= 1);
  assert.deepEqual(MIGRATIONS.map((m) => m.id), [...MIGRATIONS.map((m) => m.id)].sort((a, b) => a - b));
  for (const m of MIGRATIONS.filter((x) => x.file === 'foundation.js')) assert.ok(m.id >= 1 && m.id <= 99);
  migrate(getDb()); // running again changes nothing
  assert.equal(getDb().prepare('SELECT COUNT(*) n FROM schema_migrations').get().n, MIGRATIONS.length);
});

test('a database from a newer build is refused', () => {
  const f = path.join(dir, 'newer.sqlite');
  const d = new Database(f);
  d.exec("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT, applied_at TEXT); INSERT INTO schema_migrations VALUES (9999, 'x', 'now');");
  assert.throws(() => migrate(d), /newer/);
  d.close();
});

test('the old app database is recognised; check-db leaves it alone and passes ours', () => {
  const old = path.join(dir, 'sheet-metal.sqlite');
  const d = new Database(old);
  d.exec("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT, applied_at TEXT); INSERT INTO schema_migrations VALUES (25, 'old', 'now'); CREATE TABLE users (id INTEGER PRIMARY KEY); CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);");
  assert.equal(isLegacyDatabase(d), true);
  d.close();
  assert.equal(isLegacyDatabase(getDb()), false);
  const cli = path.join(process.cwd(), 'src', 'cli.js');
  let r = spawnSync(process.execPath, [cli, 'check-db', old], { encoding: 'utf8', env: { ...process.env, SHEETMETAL_DATA: dir } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /old database/);
  const copy = path.join(dir, 'copy.sqlite');
  getDb().pragma('wal_checkpoint(TRUNCATE)');
  fs.copyFileSync(dbPath(), copy);
  r = spawnSync(process.execPath, [cli, 'check-db', copy], { encoding: 'utf8', env: { ...process.env, SHEETMETAL_DATA: dir } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ok/);
  // The old file is untouched (still schema 25, no new tables).
  const again = new Database(old, { readonly: true });
  assert.equal(again.prepare('SELECT MAX(id) v FROM schema_migrations').get().v, 25);
  assert.equal(again.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name = 'txns'").get().n, 0);
  again.close();
});
