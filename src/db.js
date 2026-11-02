// SQLite access. One connection for the whole process (Express is single-threaded,
// so writes are naturally serialized). WAL mode gives safe incremental writes.
//
// Migrations live in src/migrations/*.js. Each file exports `MIGRATIONS`, an array of
// { id, name, sql }. All files are merged and run in id order. Each module owns an id range:
//   foundation 1-99 · operations 100-199 · pricing 200-299 · treasury 300-399
//   reports 400-499 · import 500-599
// NEVER edit a migration that has shipped: add a new one in your range.
import Database from 'better-sqlite3';
import fs from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { dataDir, ensureDir, ROOT } from './paths.js';

let db = null;

export const DB_FILE = 'safa.sqlite';
// The database the cancelled first version used. Never opened or changed by this version.
export const LEGACY_DB_FILE = 'sheet-metal.sqlite';
// Written by the foundation migration: tells this version's database from the old one.
export const PRODUCT = 'safa-v2';

export const dbPath = () => join(ensureDir(dataDir()), DB_FILE);

const RANGES = {
  'foundation.js': [1, 99], 'operations.js': [100, 199], 'pricing.js': [200, 299],
  'treasury.js': [300, 399], 'reports.js': [400, 499], 'import.js': [500, 599],
};

async function loadMigrations() {
  const dir = join(ROOT, 'src', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
  const all = [];
  for (const f of files) {
    const mod = await import(pathToFileURL(join(dir, f)).href);
    for (const m of mod.MIGRATIONS || []) {
      if (!Number.isInteger(m.id) || !m.name || typeof m.sql !== 'string') throw new Error(`bad migration in ${f}`);
      const range = RANGES[f];
      if (range && (m.id < range[0] || m.id > range[1])) throw new Error(`migration ${m.id} in ${f} is outside ${range.join('-')}`);
      all.push({ ...m, file: f });
    }
  }
  all.sort((a, b) => a.id - b.id);
  for (let i = 1; i < all.length; i++) {
    if (all[i].id === all[i - 1].id) throw new Error(`duplicate migration id ${all[i].id} (${all[i - 1].file}, ${all[i].file})`);
  }
  return all;
}

// Top-level await: the list is ready before anything can open the database.
export const MIGRATIONS = await loadMigrations();
export const LATEST_SCHEMA = Math.max(0, ...MIGRATIONS.map((m) => m.id));

export function openDb(file = dbPath()) {
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

export function getDb() {
  if (!db) throw new Error('database not open');
  return db;
}

export function closeDb() {
  if (db) db.close();
  db = null;
}

export function schemaVersion(d = getDb()) {
  d.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)');
  return d.prepare('SELECT COALESCE(MAX(id), 0) AS v FROM schema_migrations').get().v;
}

// Runs every migration this database has not seen yet. Ids are not contiguous (each module
// has its own range), so "applied" is per id, not "everything up to the max".
export function migrate(d) {
  const current = schemaVersion(d);
  // Data written by a newer build (e.g. after a rollback without restoring): refuse, don't guess.
  if (current > LATEST_SCHEMA) {
    throw new Error(`database schema ${current} is newer than this version of the app (${LATEST_SCHEMA})`);
  }
  const applied = new Set(d.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id));
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    d.transaction(() => {
      d.exec(m.sql);
      d.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, datetime('now'))").run(m.id, m.name);
    })();
  }
}

// True when the file at `file` is the old (cancelled) app's database, not ours.
export function isLegacyDatabase(d) {
  const has = (t) => !!d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  if (!has('users')) return false; // empty / brand new
  if (!has('meta')) return true;
  return d.prepare("SELECT v FROM meta WHERE k = 'product'").get()?.v !== PRODUCT;
}

// Who changed what. Called inside the same transaction as the change itself.
export function audit(userId, action, entity, entityId, before, after) {
  getDb()
    .prepare('INSERT INTO audit_log (user_id, action, entity, entity_id, before_json, after_json) VALUES (?,?,?,?,?,?)')
    .run(userId ?? null, action, entity, entityId ?? null,
      before === undefined ? null : JSON.stringify(before),
      after === undefined ? null : JSON.stringify(after));
}
