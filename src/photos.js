// صوّر ورقة: every uploaded sheet photo becomes a job that is read on the server.
// The photo is saved first; then the reader (Claude, src/ai.js) reads it, two at a time,
// works out the machine when nobody said, and the sheet lands in review with its lines.
// Jobs live in the database, so a closed phone, a dropped connection or a restart never
// loses a photo. Without a reader (no API key) the photo becomes a draft sheet to type by
// hand with the photo beside it. Ported from the first version (git show fd5faa1:src/photos.js).
//
//   job status: queued → reading → done | failed (retry) | needs_machine (pick it) | dismissed
import fs from 'fs';
import crypto from 'crypto';
import { join, resolve, sep } from 'path';
import { getDb, audit } from './db.js';
import { dataDir, ensureDir } from './paths.js';
import { aiStatus, readSheetPhoto, toLines, settleReads, matchTechnician } from './ai.js';
import { HttpError, httpError, todayISO, isRealDate } from './util.js';
import { createSheet, loadSheet, normalizeLines } from './operations/sheets.js';
import * as P from '../public/js/modules/ops-paper.js';

const CONCURRENCY = 2;
const MAX_ATTEMPTS = 3;            // a busy service or a dropped connection is retried
const RETRY_AFTER_SEC = [0, 30, 120];
export const MAX_PHOTO = 6 * 1024 * 1024;
let running = 0;
let timer = null;
const waiters = [];

const parse = (v, fallback) => { try { return JSON.parse(v); } catch { return fallback; } };
const sqlTime = (afterSec) => new Date(Date.now() + afterSec * 1000).toISOString().replace('T', ' ').slice(0, 19);
export const getJob = (id) => getDb().prepare('SELECT * FROM photo_jobs WHERE id = ?').get(Number(id));

function setJob(id, fields) {
  const keys = Object.keys(fields);
  getDb().prepare(`UPDATE photo_jobs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
}

// "data:image/jpeg;base64,..." from the browser → the JPEG bytes, checked.
export function decodeJpeg(image) {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(image || ''));
  const buf = m ? Buffer.from(m[1], 'base64') : null;
  if (!buf || buf.length < 1000 || buf[0] !== 0xff || buf[1] !== 0xd8) throw httpError(400, 'الصورة مش واصلة سليمة. جرب تاني.');
  if (buf.length > MAX_PHOTO) throw httpError(413, 'الصورة كبيرة قوي — صوّرها تاني من غير زوم');
  return buf;
}

export function savePhotoFile(buf) {
  const month = todayISO().slice(0, 7);
  ensureDir(join(dataDir(), 'photos', month));
  const rel = `photos/${month}/${Date.now()}_${crypto.randomBytes(4).toString('hex')}.jpg`;
  fs.writeFileSync(join(dataDir(), rel), buf);
  return rel;
}

// The file of a stored photo path, only inside data/photos.
export function photoFileOf(rel) {
  if (!rel) return null;
  const root = resolve(dataDir(), 'photos');
  const file = resolve(dataDir(), rel);
  return file.startsWith(root + sep) && fs.existsSync(file) ? file : null;
}

const MACHINE_OK = (m) => (m && P.MACHINES.includes(m) ? m : null);

// A sheet without reading (no reader, or the person chose to type it): a draft with the photo.
function sheetWithoutReading(job, machine, userId) {
  const sheetId = createSheet({ machine, technician_id: job.technician_id, sheet_date: todayISO(), source: 'photo',
    photo_path: job.photo_path, photo_job_id: job.id, draft: true, userId });
  setJob(job.id, { status: 'done', sheet_id: sheetId, machine, error: null, finished_at: sqlTime(0) });
  return sheetId;
}

// The reader's answer → a sheet in review with its lines. An answer that can't be applied
// still leaves the sheet (with its photo) for typing: the photo is never lost.
function sheetFromResult(job, machine, result, userId, usageId = null) {
  const date = result.sheet_date && isRealDate(result.sheet_date) ? result.sheet_date : todayISO();
  const tech = job.technician_id || matchTechnician(result.technician_name);
  let sheetId;
  let note = null;
  try {
    const raw = toLines(result, machine);
    // normalizeLines resolves ditto and names first, so the reads can be settled on the real values.
    const lines = settleReads(normalizeLines(machine, date, raw, { trusted: true }));
    sheetId = createSheet({ machine, technician_id: tech, sheet_date: date, source: 'photo', photo_path: job.photo_path,
      photo_job_id: job.id, draft: false, lines, userId, trusted: true,
      notes: result.notes ? `من القراءة: ${String(result.notes).slice(0, 400)}` : '' });
  } catch (err) {
    if (err instanceof HttpError && err.status === 409) throw err; // a locked month: the job fails with the reason
    console.error(`photo job ${job.id}: reading not applied:`, err.message);
    note = 'الورقة اتعملت بس القراءة ما اتطبقتش — اكتب السطور والصورة جنبك.';
    sheetId = createSheet({ machine, technician_id: tech, sheet_date: date, source: 'photo', photo_path: job.photo_path,
      photo_job_id: job.id, draft: true, userId });
  }
  if (usageId) getDb().prepare('UPDATE ai_usage SET sheet_id = ? WHERE id = ?').run(sheetId, usageId);
  setJob(job.id, { status: 'done', sheet_id: sheetId, machine, error: note, result_json: null, finished_at: sqlTime(0) });
  return sheetId;
}

// photoBuf → a job. The same photo twice (same bytes) is refused while the first one lives.
export function createJob({ buf, machine = null, technicianId = null, userId }) {
  const db = getDb();
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  const dup = db.prepare("SELECT id, sheet_id, status FROM photo_jobs WHERE photo_hash = ? AND status <> 'dismissed' ORDER BY id DESC LIMIT 1").get(hash);
  if (dup) {
    const alive = !dup.sheet_id || db.prepare("SELECT 1 FROM op_sheets WHERE id = ? AND status <> 'cancelled'").get(dup.sheet_id);
    if (alive) throw httpError(409, 'الصورة دي اترفعت قبل كده', { existing_job: dup.id, existing_sheet: dup.sheet_id || null });
  }
  const m = MACHINE_OK(machine);
  const ai = aiStatus().enabled;
  const status = ai ? 'queued' : m ? 'reading' : 'needs_machine';
  const photoPath = savePhotoFile(buf);
  const id = Number(db.prepare(`INSERT INTO photo_jobs (status, photo_path, photo_meta, machine, technician_id, photo_hash, created_by)
    VALUES (?,?,?,?,?,?,?)`).run(status, photoPath, JSON.stringify({ bytes: buf.length, uploaded_at: new Date().toISOString() }),
    m, technicianId, hash, userId ?? null).lastInsertRowid);
  audit(userId, 'upload', 'photo_job', id, undefined, { machine: m, reader: ai ? 'ai' : 'none' });
  if (ai) kick();
  else if (m) {
    try { sheetWithoutReading(getJob(id), m, userId); } catch (err) { fail(id, err); }
  }
  return id;
}

function fail(id, err) {
  setJob(id, { status: 'failed', error: err instanceof HttpError ? err.message : 'حصلت مشكلة وإحنا بنقرا الصورة', finished_at: sqlTime(0) });
  if (!(err instanceof HttpError)) console.error(`photo job ${id}:`, err);
}

async function run(job) {
  let result;
  let usage;
  try {
    ({ result, usage } = await readSheetPhoto(job.photo_path, { machine: job.machine, jobId: job.id }));
  } catch (err) {
    if (err?.retry && job.attempts < MAX_ATTEMPTS) {
      const wait = RETRY_AFTER_SEC[job.attempts] ?? 120;
      setJob(job.id, { status: 'queued', error: `${err.message} — هنجرب تاني لوحدنا`, ready_at: sqlTime(wait) });
      return;
    }
    return fail(job.id, err);
  }
  try {
    const m = MACHINE_OK(job.machine) || MACHINE_OK(result.machine);
    if (!m) {
      setJob(job.id, { status: 'needs_machine', result_json: JSON.stringify(result), error: null, finished_at: sqlTime(0) });
      if (usage?.id) getDb().prepare('UPDATE ai_usage SET job_id = ? WHERE id = ?').run(job.id, usage.id);
      return;
    }
    sheetFromResult(job, m, result, job.created_by, usage?.id);
  } catch (err) {
    fail(job.id, err);
  }
}

// Takes queued jobs while there is room. Safe to call any time.
export function kick() {
  const db = getDb();
  while (running < CONCURRENCY) {
    const job = db.prepare("SELECT * FROM photo_jobs WHERE status = 'queued' AND ready_at <= datetime('now') ORDER BY id LIMIT 1").get();
    if (!job) break;
    const took = db.prepare("UPDATE photo_jobs SET status = 'reading', started_at = datetime('now'), attempts = attempts + 1 WHERE id = ? AND status = 'queued'").run(job.id).changes;
    if (!took) continue;
    running += 1;
    run({ ...job, attempts: job.attempts + 1 })
      .catch((err) => fail(job.id, err))
      .finally(() => { running -= 1; setImmediate(kick); settle(); });
  }
  settle();
}

function settle() {
  if (running > 0) return;
  let ready = null;
  try { ready = getDb().prepare("SELECT 1 FROM photo_jobs WHERE status = 'queued' AND ready_at <= datetime('now')").get(); } catch { /* db closed */ }
  if (ready) return;
  while (waiters.length) waiters.shift()();
}

// Resolves when nothing is being read and nothing is ready to read (tests).
export const idle = () => new Promise((r) => { waiters.push(r); settle(); });

export function startPhotoJobs() {
  // A job that was being read when the app stopped is read again.
  getDb().prepare("UPDATE photo_jobs SET status = 'queued', ready_at = datetime('now') WHERE status = 'reading' AND sheet_id IS NULL").run();
  kick();
  timer ||= setInterval(kick, 10000);
  timer.unref?.();
}

export function stopPhotoJobs() {
  if (timer) clearInterval(timer);
  timer = null;
}

// ---------- what the screens get ----------
export function jobView(job) {
  let sheet = null;
  if (job.sheet_id) {
    try {
      const s = loadSheet(job.sheet_id);
      const by = new Map();
      for (const l of s.lines) {
        const name = l.client_name || (l.client_text ? `${l.client_text} (مش في القايمة)` : 'من غير عميل');
        by.set(name, (by.get(name) || 0) + 1);
      }
      sheet = { id: s.id, serial: s.serial, machine_name: s.machine_name, status: s.view_status, status_name: s.status_name,
        lines: s.lines.length, red: s.counts.red, yellow: s.counts.yellow, clients: [...by].map(([name, n]) => ({ name, n })) };
    } catch { /* gone */ }
  }
  const result = job.status === 'needs_machine' ? parse(job.result_json, null) : null;
  return {
    id: job.id, kind: job.kind, status: job.status, error: job.error, attempts: job.attempts,
    created_at: job.created_at, started_at: job.started_at, finished_at: job.finished_at,
    machine: job.machine, machine_name: job.machine ? P.MACHINE_NAMES[job.machine] : null,
    rows_read: result ? (result.rows || []).length : null,
    photo_url: `/api/operations/photos/${job.id}/photo`,
    sheet,
  };
}

// The صوّر ورقة list: everything still moving, plus the last two days' finished ones.
export function recentJobs({ userId = null } = {}) {
  return getDb().prepare(`SELECT * FROM photo_jobs
    WHERE (status IN ('queued','reading','needs_machine','failed')
       OR (status = 'done' AND created_at >= datetime('now', '-2 days')))
      AND kind = 'upload' AND (? IS NULL OR created_by = ?)
    ORDER BY id DESC LIMIT 80`).all(userId, userId);
}

export function jobCounts() {
  const rows = getDb().prepare("SELECT status, COUNT(*) n FROM photo_jobs WHERE kind = 'upload' AND status IN ('queued','reading','needs_machine','failed') GROUP BY status").all();
  const c = Object.fromEntries(rows.map((r) => [r.status, r.n]));
  return { reading: (c.queued || 0) + (c.reading || 0), needs_machine: c.needs_machine || 0, failed: c.failed || 0 };
}

// ---------- actions on a job ----------
function jobOr404(id) {
  const job = getJob(id);
  if (!job) throw httpError(404, 'الصورة دي مش موجودة');
  return job;
}

export function pickMachine(jobId, machine, userId) {
  const job = jobOr404(jobId);
  if (job.status !== 'needs_machine') throw httpError(409, 'الصورة دي مش مستنية المكنة');
  const m = MACHINE_OK(machine);
  if (!m) throw httpError(400, 'اختار المكنة', { field: 'machine' });
  audit(userId, 'machine', 'photo_job', job.id, { machine: job.machine }, { machine: m });
  const result = parse(job.result_json, null);
  if (result) return sheetFromResult({ ...job, machine: m }, m, { ...result, machine: m }, userId);
  if (aiStatus().enabled) {
    setJob(job.id, { machine: m, status: 'queued', error: null, attempts: 0, ready_at: sqlTime(0) });
    kick();
    return null;
  }
  return sheetWithoutReading({ ...job, machine: m }, m, userId);
}

export function retryJob(jobId, userId) {
  const job = jobOr404(jobId);
  if (job.status !== 'failed') throw httpError(409, 'الصورة دي مش واقفة على مشكلة');
  if (!aiStatus().enabled) throw httpError(409, 'القراءة الآلية مش متفعلة — اكتب الورقة بإيدك أو فعّلها من الإعدادات');
  setJob(job.id, { status: 'queued', error: null, attempts: 0, ready_at: sqlTime(0) });
  audit(userId, 'retry', 'photo_job', job.id);
  kick();
}

export function typeByHand(jobId, machine, userId) {
  const job = jobOr404(jobId);
  if (!['failed', 'needs_machine'].includes(job.status)) throw httpError(409, 'الصورة دي اتعمل منها ورقة خلاص');
  const m = MACHINE_OK(machine) || MACHINE_OK(job.machine);
  if (!m) throw httpError(400, 'اختار المكنة', { field: 'machine' });
  return sheetWithoutReading({ ...job, machine: m }, m, userId);
}

export function dismissJob(jobId, userId) {
  const job = jobOr404(jobId);
  if (['queued', 'reading'].includes(job.status)) throw httpError(409, 'الصورة لسه بتتقري — استنى لما تخلص');
  setJob(job.id, { status: 'dismissed' });
  audit(userId, 'dismiss', 'photo_job', job.id, { status: job.status }, { status: 'dismissed' });
}
