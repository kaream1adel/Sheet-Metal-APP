// Backups of the database: at startup, once a day, before every update and on demand.
// Each one is a complete SQLite file in data\backups, optionally copied to a USB stick
// or OneDrive folder. A restore always takes a backup of the current data first.
import fs from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';
import { getDb, openDb, closeDb, dbPath, LATEST_SCHEMA, audit } from './db.js';
import { dataDir, ensureDir } from './paths.js';
import { getSettings, getMeta, setMeta } from './settings.js';
import { httpError } from './util.js';

export const REASONS = { startup: 'تشغيل البرنامج', daily: 'يومي', update: 'قبل التحديث', manual: 'يدوي', restore: 'قبل الاسترجاع' };
// How many of each kind to keep. Startup and daily share one pool.
const KEEP = { auto: 30, update: 10, manual: 30, restore: 10 };
const NAME_RE = /^sheet-metal_(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})_(startup|daily|update|manual|restore)(?:-\d+)?\.sqlite$/;
const DAY_MS = 86400000;

export const backupsDir = () => ensureDir(join(dataDir(), 'backups'));

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

const pool = (reason) => (reason === 'startup' || reason === 'daily' ? 'auto' : reason);

export function listBackups() {
  const dir = backupsDir();
  return fs.readdirSync(dir)
    .map((name) => {
      const m = name.match(NAME_RE);
      if (!m) return null;
      const st = fs.statSync(join(dir, name));
      return { name, reason: m[5], reason_name: REASONS[m[5]], at: `${m[1]} ${m[2]}:${m[3]}:${m[4]}`, size: st.size };
    })
    .filter(Boolean)
    .sort((a, b) => (a.name < b.name ? 1 : -1)); // newest first
}

// Safe even while the app is in use: SQLite's online backup copies a consistent snapshot.
export async function makeBackup(reason) {
  if (!REASONS[reason]) throw new Error(`unknown backup reason ${reason}`);
  const dir = backupsDir();
  let name = `sheet-metal_${stamp()}_${reason}.sqlite`;
  for (let i = 2; fs.existsSync(join(dir, name)); i++) name = `sheet-metal_${stamp()}_${reason}-${i}.sqlite`;
  const tmp = join(dir, `.${name}.part`);
  try {
    await getDb().backup(tmp);
    fs.renameSync(tmp, join(dir, name)); // a half-written file never looks like a backup
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    setMeta('backup_error', `${new Date().toISOString()} ${err.message}`);
    throw err;
  }
  setMeta('backup_last_at', new Date().toISOString());
  setMeta('backup_error', null);
  copyOut(name);
  prune();
  return name;
}

// The optional second copy. Its failure is reported but never fails the backup itself.
function copyOut(name) {
  const target = getSettings().backup_copy_dir;
  if (!target) return setMeta('backup_copy_error', null);
  try {
    if (!fs.existsSync(target)) throw new Error('الفولدر مش موجود (الفلاشة مش متركبة؟)');
    const sub = ensureDir(join(target, 'Sheet Metal backups'));
    fs.copyFileSync(join(backupsDir(), name), join(sub, name));
    copyNewPhotos(join(sub, 'photos'));
    setMeta('backup_copy_error', null);
  } catch (err) {
    setMeta('backup_copy_error', `${new Date().toISOString()} ${err.message}`);
  }
}

// Sheet photos are files next to the database: copy the ones the target doesn't have yet.
function copyNewPhotos(targetRoot) {
  const walk = (rel) => {
    const src = join(dataDir(), 'photos', rel);
    if (!fs.existsSync(src)) return;
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      const r = join(rel, e.name);
      if (e.isDirectory()) walk(r);
      else if (!fs.existsSync(join(targetRoot, r))) {
        ensureDir(join(targetRoot, rel));
        fs.copyFileSync(join(src, e.name), join(targetRoot, r));
      }
    }
  };
  walk('');
}

function prune() {
  const groups = {};
  for (const b of listBackups()) (groups[pool(b.reason)] ||= []).push(b);
  for (const [g, list] of Object.entries(groups)) {
    for (const b of list.slice(KEEP[g])) fs.rmSync(join(backupsDir(), b.name), { force: true });
  }
}

export function backupFile(name) {
  if (!NAME_RE.test(String(name))) throw httpError(400, 'اسم النسخة غلط');
  const file = join(backupsDir(), name);
  if (!fs.existsSync(file)) throw httpError(404, 'النسخة دي مش موجودة');
  return file;
}

// Opens a backup read-only and makes sure it is a healthy database this version can use.
export function inspectBackup(file) {
  let d;
  try {
    d = new Database(file, { readonly: true, fileMustExist: true });
    if (d.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('bad');
    const schema = d.prepare('SELECT COALESCE(MAX(id), 0) v FROM schema_migrations').get().v;
    const users = d.prepare('SELECT COUNT(*) n FROM users').get().n;
    return { schema, users };
  } catch {
    throw httpError(400, 'ملف النسخة بايظ أو مش نسخة من البرنامج ده');
  } finally {
    d?.close();
  }
}

// Replaces the live database with a backup. Takes a backup of the current data first.
export async function restoreBackup(name, userId) {
  const file = backupFile(name);
  const info = inspectBackup(file);
  if (info.schema > LATEST_SCHEMA) throw httpError(409, 'النسخة دي من إصدار أحدث من البرنامج — حدّث البرنامج الأول');
  const safety = await makeBackup('restore');
  // From here on everything is synchronous, so no request can slip in between.
  const live = dbPath();
  closeDb();
  for (const ext of ['-wal', '-shm']) fs.rmSync(live + ext, { force: true });
  fs.copyFileSync(file, live);
  openDb(live); // migrates an older backup up to the current schema
  audit(userId, 'restore', 'backup', null, null, { restored: name, safety_backup: safety });
  setMeta('backup_restored_at', new Date().toISOString());
  return { safety };
}

export function backupStatus() {
  const last = getMeta('backup_last_at');
  return {
    last_at: last,
    error: getMeta('backup_error'),
    copy_error: getMeta('backup_copy_error'),
    copy_dir: getSettings().backup_copy_dir,
    // Nothing for two days = something is wrong (or the PC was off): show it on the home page.
    stale: !last || Date.now() - Date.parse(last) > 2 * DAY_MS,
  };
}

// Startup backup now, then a daily one. Timers are unref'd so they never keep the process alive.
export function startBackupSchedule() {
  const run = (reason) => makeBackup(reason).catch((err) => console.error(`backup failed: ${err.message}`));
  run('startup');
  setInterval(() => {
    const last = getMeta('backup_last_at');
    if (!last || Date.now() - Date.parse(last) >= DAY_MS) run('daily');
  }, 60 * 60 * 1000).unref();
}
