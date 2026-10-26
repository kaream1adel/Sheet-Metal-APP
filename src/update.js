// The تحديث button and رجوع للنسخة السابقة.
//
// Every push to main that passes the tests publishes a GitHub release with
// manifest.json + sheet-metal-win-x64.tar.gz (.github/workflows/release.yml).
// Updating = back up, download, check the checksum, unpack into versions\<build>,
// try the migrations on a copy of the data, point current.txt at it and restart.
// The launcher restarts the app when it exits with RESTART_CODE, and goes back to
// previous.txt by itself if the new version fails to start (update-trial.txt).
// Code is never overwritten in place, so a running app can't be half-updated.
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { join } from 'path';
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import { getDb, closeDb, dbPath, schemaVersion, LATEST_SCHEMA, audit } from './db.js';
import { homeDir, ensureDir, dataDir } from './paths.js';
import { VERSION } from './version.js';
import { getMeta, setMeta } from './settings.js';
import { makeBackup, backupFile } from './backup.js';
import { httpError } from './util.js';

export const RESTART_CODE = 42;
export const UPDATE_REPO = 'kaream1adel/Sheet-Metal-APP';
export const PACKAGE_ASSET = 'sheet-metal-win-x64.tar.gz';
const api = () => process.env.SHEETMETAL_UPDATE_API || 'https://api.github.com';
const HEADERS = { 'user-agent': 'sheet-metal-updater', accept: 'application/vnd.github+json' };

// Tests replace this; in the app it ends the process so the launcher starts the new code.
let restart = () => setTimeout(() => { closeDb(); process.exit(RESTART_CODE); }, 400);
export function setRestartHandler(fn) { restart = fn; }

let busy = false;

// ---------- the install folder ----------
const file = (name) => join(homeDir(), name);
const readText = (name) => {
  try { return fs.readFileSync(file(name), 'utf8').trim() || null; } catch { return null; }
};
// "." means the code that sits next to the launcher (the first install).
const codeDir = (label) => (label === '.' ? homeDir() : join(homeDir(), 'versions', label));
const stateFile = () => join(dataDir(), 'update-state.json');
const readState = () => {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return null; }
};

function requireInstalled() {
  if (!homeDir()) throw httpError(409, 'التحديث بيشتغل بس من البرنامج المتثبت (Start Sheet Metal.bat)');
}

// ---------- checking ----------
async function fetchJson(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

export async function checkForUpdate() {
  let release;
  let manifest;
  try {
    release = await fetchJson(`${api()}/repos/${UPDATE_REPO}/releases/latest`);
    const m = release.assets?.find((a) => a.name === 'manifest.json');
    if (!m) throw new Error('release has no manifest.json');
    manifest = await fetchJson(m.browser_download_url);
  } catch (err) {
    setMeta('update_check_error', err.message);
    throw httpError(502, 'مقدرتش أوصل لسيرفر التحديثات. اتأكد إن النت شغال وجرب تاني.');
  }
  const pkg = release.assets.find((a) => a.name === PACKAGE_ASSET);
  const latest = {
    version: String(manifest.version || ''),
    build: Number(manifest.build) || 0,
    commit: String(manifest.commit || '').slice(0, 12),
    notes: String(manifest.notes || '').slice(0, 2000),
    published_at: release.published_at || null,
    sha256: String(manifest.sha256 || ''),
    size: Number(manifest.size) || 0,
    node_abi: String(manifest.node_abi || ''),
    url: pkg?.browser_download_url || null,
  };
  const available = latest.build > VERSION.build && !!latest.url;
  setMeta('update_checked_at', new Date().toISOString());
  setMeta('update_check_error', null);
  setMeta('update_latest', JSON.stringify(latest));
  return { available, latest };
}

// ---------- status for the settings screen ----------
export function updateStatus() {
  const installed = !!homeDir();
  const previous = installed ? readText('previous.txt') : null;
  const state = readState();
  let latest = null;
  try { latest = JSON.parse(getMeta('update_latest') || 'null'); } catch { /* ignore */ }
  return {
    installed,
    current: VERSION,
    latest,
    available: !!latest && latest.build > VERSION.build,
    checked_at: getMeta('update_checked_at'),
    check_error: getMeta('update_check_error'),
    busy,
    can_rollback: !!previous && fs.existsSync(codeDir(previous)),
    previous,
    // Rolling back after a schema change means going back to the pre-update backup.
    rollback_loses_data: !!state?.backup && state.to === String(VERSION.build) && schemaVersion() !== state.schema_before,
    last_update: state,
  };
}

// ---------- applying ----------
async function download(url, dest, { sha256, size }) {
  const res = await fetch(url, { headers: { 'user-agent': HEADERS['user-agent'] }, signal: AbortSignal.timeout(10 * 60000) });
  if (!res.ok) throw httpError(502, 'التحميل وقف في النص. جرب تاني.');
  const buf = Buffer.from(await res.arrayBuffer());
  if ((size && buf.length !== size) || crypto.createHash('sha256').update(buf).digest('hex') !== sha256.toLowerCase()) {
    throw httpError(502, 'الملف اللي اتحمل مش سليم. جرب تاني.');
  }
  fs.writeFileSync(dest, buf);
}

// Runs the new code's migrations on a copy of the data, in its own process.
function trialMigration(dir, backupName) {
  const tmp = join(os.tmpdir(), `sheetmetal-trial-${process.pid}-${Date.now()}.sqlite`);
  try {
    fs.copyFileSync(backupFile(backupName), tmp);
    const r = spawnSync(process.execPath, [join(dir, 'src', 'cli.js'), 'check-db', tmp], {
      encoding: 'utf8', timeout: 120000, windowsHide: true, env: { ...process.env, SHEETMETAL_DATA: os.tmpdir() },
    });
    if (r.status !== 0) {
      console.error('trial migration failed:', r.stderr || r.error?.message);
      throw httpError(500, 'النسخة الجديدة فيها مشكلة مع البيانات بتاعتك — التحديث اتلغى ومفيش حاجة اتغيرت.');
    }
  } finally {
    for (const ext of ['', '-wal', '-shm']) fs.rmSync(tmp + ext, { force: true });
  }
}

export async function applyUpdate(userId) {
  requireInstalled();
  if (busy) throw httpError(409, 'في تحديث شغال دلوقتي');
  busy = true;
  const versions = ensureDir(join(homeDir(), 'versions'));
  const build = () => String(latest.build);
  let latest;
  let tarball;
  let staging;
  try {
    ({ latest } = await checkForUpdate());
    if (!(latest.build > VERSION.build) || !latest.url) throw httpError(409, 'إنت على آخر نسخة بالفعل');
    if (!/^[a-f0-9]{64}$/i.test(latest.sha256)) throw httpError(502, 'بيانات التحديث ناقصة. جرب بعدين.');
    if (latest.node_abi && latest.node_abi !== process.versions.modules) {
      throw httpError(409, 'النسخة الجديدة محتاجة إصدار Node مختلف عن اللي في فولدر node. بلغ الأدمن.');
    }

    tarball = join(versions, `.download-${build()}.tar.gz`);
    staging = join(versions, `.staging-${build()}`);
    await download(latest.url, tarball, latest);
    fs.rmSync(staging, { recursive: true, force: true });
    ensureDir(staging);
    // tar.exe ships with Windows 10 and later.
    const t = spawnSync('tar', ['-xzf', tarball, '-C', staging], { encoding: 'utf8', windowsHide: true });
    if (t.status !== 0) throw httpError(500, 'مقدرتش أفك ملف التحديث.');
    let unpacked;
    try { unpacked = JSON.parse(fs.readFileSync(join(staging, 'version.json'), 'utf8')); } catch { /* checked below */ }
    if (Number(unpacked?.build) !== latest.build || !fs.existsSync(join(staging, 'src', 'server.js'))) {
      throw httpError(500, 'ملف التحديث ناقص.');
    }

    const backup = await makeBackup('update');
    trialMigration(staging, backup);

    const target = join(versions, build());
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(staging, target);
    staging = null;

    const current = readText('current.txt') || '.';
    // Keep only the version we leave and the one we go to.
    for (const d of fs.readdirSync(versions)) {
      if (d !== build() && d !== current && !d.startsWith('.')) fs.rmSync(join(versions, d), { recursive: true, force: true });
    }
    const state = { from: current, to: build(), backup, schema_before: schemaVersion(), at: new Date().toISOString() };
    fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2));
    fs.writeFileSync(file('previous.txt'), current);
    fs.writeFileSync(file('update-trial.txt'), build());
    fs.writeFileSync(file('current.txt'), build());
    audit(userId, 'update', 'app', null, { build: VERSION.build, version: VERSION.version }, { build: latest.build, version: latest.version, backup });
    restart();
    return { to: latest, backup };
  } finally {
    if (tarball) fs.rmSync(tarball, { force: true });
    if (staging) fs.rmSync(staging, { recursive: true, force: true });
    busy = false;
  }
}

// Back to the version before the last update. If that update changed the database,
// the data goes back to the backup taken just before it (after a safety backup).
export async function rollback(userId) {
  requireInstalled();
  if (busy) throw httpError(409, 'في تحديث شغال دلوقتي');
  const status = updateStatus();
  if (!status.can_rollback) throw httpError(409, 'مفيش نسخة سابقة أرجع لها');
  const current = readText('current.txt') || '.';
  const state = readState();
  let restored = null;
  const entry = (action, entity, before, after) => [userId, action, entity, before, after];
  const entries = [];
  if (status.rollback_loses_data) {
    const safety = await makeBackup('restore');
    restored = state.backup;
    entries.push(entry('restore', 'backup', null, { restored, safety_backup: safety, reason: 'rollback' }));
  }
  entries.push(entry('rollback', 'app', { code: current }, { code: status.previous, restored }));
  if (restored) {
    // The old code must find the old schema, so the restored file is not reopened (and
    // migrated) here: the audit rows go straight into it.
    replaceDatabase(backupFile(restored));
    const d = new Database(dbPath());
    try { for (const e of entries) insertAudit(d, ...e); } finally { d.close(); }
  } else {
    for (const e of entries) insertAudit(getDb(), ...e);
  }
  fs.writeFileSync(file('current.txt'), status.previous);
  fs.writeFileSync(file('previous.txt'), current);
  fs.rmSync(file('update-trial.txt'), { force: true });
  fs.writeFileSync(stateFile(), JSON.stringify({ rolled_back_from: current, to: status.previous, at: new Date().toISOString() }, null, 2));
  restart();
  return { to: status.previous, restored };
}

function insertAudit(d, userId, action, entity, before, after) {
  d.prepare('INSERT INTO audit_log (user_id, action, entity, entity_id, before_json, after_json) VALUES (?,?,?,?,?,?)')
    .run(userId ?? null, action, entity, null, before === null ? null : JSON.stringify(before), JSON.stringify(after));
}

// Swaps the database file under a closed connection. The caller audits afterwards.
function replaceDatabase(source) {
  const live = dbPath();
  closeDb();
  for (const ext of ['-wal', '-shm']) fs.rmSync(live + ext, { force: true });
  fs.copyFileSync(source, live);
}

// ---------- at startup ----------

// After the launcher went back to the old code because the new one crashed, the data
// may already carry the new schema. Put back the pre-update backup before opening it.
export function recoverAfterFailedUpdate() {
  const live = dbPath();
  if (!fs.existsSync(live)) return;
  let schema;
  const d = new Database(live, { readonly: true });
  try { schema = d.prepare('SELECT COALESCE(MAX(id), 0) v FROM schema_migrations').get().v; } catch { schema = 0; } finally { d.close(); }
  if (schema <= LATEST_SCHEMA) return;
  const state = readState();
  if (!state?.backup) return; // nothing safe to do; openDb will refuse with a clear message
  const keep = `${live}.newer-${Date.now()}`;
  for (const ext of ['', '-wal']) if (fs.existsSync(live + ext)) fs.copyFileSync(live + ext, keep + ext); // never lose data silently
  replaceDatabase(backupFile(state.backup));
  console.error(`The database was newer than this version: restored ${state.backup} (the newer copy is kept as ${keep}).`);
}

// The new version started fine: stop the launcher from rolling it back.
export function markStarted() {
  if (homeDir()) fs.rmSync(file('update-trial.txt'), { force: true });
}

// Ask GitHub once a day so the home page can say an update is waiting. Never fails loudly.
export function startUpdateChecks() {
  if (!homeDir()) return;
  const tick = () => {
    const last = getMeta('update_checked_at');
    if (!last || Date.now() - Date.parse(last) > 86400000) checkForUpdate().catch(() => {});
  };
  setTimeout(tick, 60000).unref();
  setInterval(tick, 6 * 3600000).unref();
}
