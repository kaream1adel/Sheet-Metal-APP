// SQLite access. One connection for the whole process (Express is single-threaded,
// so writes are naturally serialized). WAL mode gives safe incremental writes.
import Database from 'better-sqlite3';
import { join } from 'path';
import { dataDir, ensureDir } from './paths.js';
import { MIGRATIONS } from './migrations.js';
import { seedDefaults } from './seed.js';

let db = null;

export function openDb(file = join(ensureDir(dataDir()), 'sheet-metal.sqlite')) {
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  seedDefaults(db);
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

export function migrate(d) {
  const current = schemaVersion(d);
  for (const m of MIGRATIONS) {
    if (m.id <= current) continue;
    d.transaction(() => {
      d.exec(m.sql);
      d.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, datetime('now'))").run(m.id, m.name);
    })();
  }
}

// Who changed what. Called inside the same transaction as the change itself.
export function audit(userId, action, entity, entityId, before, after) {
  getDb()
    .prepare('INSERT INTO audit_log (user_id, action, entity, entity_id, before_json, after_json) VALUES (?,?,?,?,?,?)')
    .run(userId ?? null, action, entity, entityId ?? null,
      before === undefined ? null : JSON.stringify(before),
      after === undefined ? null : JSON.stringify(after));
}
