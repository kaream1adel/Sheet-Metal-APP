// الاستيراد من الإكسيل — the module's service, used by the routes and the command line.
//
//   createPreview({ fileName, buffer, userId })   saves the file under <data>/imports, reads it,
//                                                 builds the plan and SIMULATES the import (applied
//                                                 inside a transaction that is rolled back) so the
//                                                 preview already shows the reconciliation
//   saveDecisions(runId, decisions, userId)       the admin's choices → a fresh preview
//   applyRun(runId, { decisions, userId })        the real import, in ONE transaction; refused while
//                                                 another run is applied (roll it back first)
//   rollbackRun(runId, reason, userId)            reverses every transaction of the run (dated as
//                                                 the original), cancels its documents, restores
//                                                 what it changed; audited
//   getRun (an applied run is reconciled live) / listRuns
import fs from 'fs';
import { join } from 'path';
import crypto from 'crypto';
import { getDb, audit } from '../db.js';
import { reverse } from '../ledger.js';
import { dataDir, ensureDir } from '../paths.js';
import { httpError, todayISO } from '../util.js';
import { loadWorkbook } from './workbook.js';
import { readWorkbook } from './parse.js';
import { buildPlan } from './plan.js';
import { applyPlan, auditRun } from './apply.js';
import { reconcile } from './reconcile.js';

export { buildPlan } from './plan.js';
export { readWorkbook } from './parse.js';
export { loadWorkbook } from './workbook.js';

const MAX_BYTES = 20 * 1024 * 1024;
const importsDir = () => ensureDir(join(dataDir(), 'imports'));
const parseJson = (s, d) => { try { return JSON.parse(s || ''); } catch { return d; } };

// The parsed workbook of a file, kept in memory (reading 3 MB of Excel takes seconds).
const models = new Map();
async function modelOf(hash) {
  if (models.has(hash)) return models.get(hash);
  const file = join(importsDir(), `${hash}.xlsx`);
  if (!fs.existsSync(file)) throw httpError(410, 'ملف الإكسيل بتاع الاستيراد ده مش موجود — ارفعه تاني');
  const { wb } = await loadWorkbook(file);
  const model = readWorkbook(wb);
  models.clear();
  models.set(hash, model);
  return model;
}

function lookups() {
  const categories = getDb().prepare('SELECT id, name, keywords, active, sort FROM expense_categories ORDER BY sort, id').all()
    .map((c) => ({ ...c, keywords: parseJson(c.keywords, []) }));
  return { categories };
}

function getRunRow(id) {
  const r = getDb().prepare('SELECT * FROM import_runs WHERE id = ?').get(Number(id));
  if (!r) throw httpError(404, 'عملية الاستيراد دي مش موجودة');
  return r;
}

const ROLLBACK = Symbol('dry run');
// Applies the plan inside a transaction and rolls it back: what the import WOULD do.
function simulate(plan, runId, userId) {
  const db = getDb();
  let out = null;
  try {
    db.transaction(() => {
      const created = applyPlan(plan, { runId, userId });
      const partyOf = (g) => created.party_map[g] ?? null;
      out = { ok: true, reconciliation: reconcile(plan, created, partyOf), created_counts: countsOf(created) };
      throw ROLLBACK;
    })();
  } catch (e) {
    if (e !== ROLLBACK) out = { ok: false, error: e.message || String(e) };
  }
  return out;
}

const countsOf = (c) => ({
  parties: c.parties.length, parties_updated: c.parties_updated.length, materials: c.materials.length, client_rates: c.client_rates.length,
  sheets: c.sheets.length, lines: c.lines.length, items: c.items.length, batches: c.batches.length, manual_entries: c.manual_entries.length,
  receipts: c.receipts.length, vouchers: c.vouchers.length, cheques: c.cheques.length,
});

function previewOf(plan) {
  return {
    counts: plan.counts, fallback: plan.fallback, today: plan.today,
    clients: plan.clients.map((c) => ({ id: c.id, name: c.name, aliases: c.aliases, walk_in: c.walk_in, only_log: c.onlyLog })),
    suppliers: plan.suppliers.map((s) => ({ id: s.id, name: s.name, aliases: s.aliases })),
    partners: plan.partners.map((p) => ({ id: p.id, name: p.name })),
    ...plan.preview,
  };
}

async function planFor(run, decisions) {
  const model = await modelOf(run.file_hash);
  return buildPlan(model, decisions, { lookups: lookups(), today: todayISO(), fileName: run.file_name, hash: run.file_hash });
}

export async function createPreview({ fileName = '', buffer, userId = null }) {
  if (!buffer || !buffer.length) throw httpError(400, 'اختار ملف الإكسيل', { field: 'file' });
  if (buffer.length > MAX_BYTES) throw httpError(400, 'الملف كبير قوي', { field: 'file' });
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) throw httpError(400, 'الملف ده مش ملف إكسيل (xlsx)', { field: 'file' });
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const file = join(importsDir(), `${hash}.xlsx`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, buffer);
  let model;
  try {
    models.delete(hash);
    model = await modelOf(hash);
  } catch (e) {
    if (e.status) throw e;
    throw httpError(400, 'الملف مش بيتقري كإكسيل — اتأكد إنه ملف .xlsx سليم', { field: 'file' });
  }
  if (!model.work.length && !model.statements.length && !model.summary) {
    throw httpError(400, 'الملف ده مش شبه ملف الحسابات (مفيش شيتات عملاء ولا كشوف)', { field: 'file' });
  }
  const db = getDb();
  const name = String(fileName || 'workbook.xlsx').slice(0, 200);
  const runId = Number(db.prepare(`INSERT INTO import_runs (file_name, file_hash, status, created_by) VALUES (?, ?, 'preview', ?)`)
    .run(name, hash, userId).lastInsertRowid);
  audit(userId, 'upload', 'import_run', runId, undefined, { file_name: name, hash: hash.slice(0, 16) });
  return refreshPreview(runId, {}, userId);
}

async function refreshPreview(runId, decisions, userId) {
  const run = getRunRow(runId);
  const plan = await planFor(run, decisions);
  const simulation = simulate(plan, run.id, userId);
  getDb().prepare('UPDATE import_runs SET summary_json = ?, decisions_json = ?, reconciliation_json = ?, error = ? WHERE id = ?')
    .run(JSON.stringify({ preview: previewOf(plan), simulated: simulation.ok ? simulation.created_counts : null }), JSON.stringify(decisions || {}),
      JSON.stringify(simulation.ok ? simulation.reconciliation : {}), simulation.ok ? null : simulation.error, run.id);
  return getRun(run.id);
}

export async function saveDecisions(runId, decisions, userId) {
  const run = getRunRow(runId);
  if (run.status !== 'preview') throw httpError(409, 'العملية دي اتنفذت خلاص — التعديل قبل التأكيد بس');
  return refreshPreview(run.id, cleanDecisions(decisions), userId);
}

export function cleanDecisions(d = {}) {
  const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
  const out = { names: {}, merges: [], dates: {}, partners: {}, expenses: {}, skip: {} };
  for (const [k, v] of Object.entries(obj(d.names))) if (typeof v === 'string' && v.trim()) out.names[k] = v.trim();
  for (const pair of Array.isArray(d.merges) ? d.merges : []) if (Array.isArray(pair) && pair.length === 2) out.merges.push(pair.map(String));
  for (const [k, v] of Object.entries(obj(d.dates))) {
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T12:00:00Z`))) out.dates[k] = v;
    else if (v) throw httpError(400, `التاريخ ${v} مش مظبوط`, { field: `dates.${k}` });
  }
  for (const [k, v] of Object.entries(obj(d.partners))) {
    const x = obj(v);
    out.partners[k] = {};
    if (['deposit', 'expense', 'withdrawal', 'cheque', 'skip'].includes(x.class)) out.partners[k].class = x.class;
    if (['cash', 'bank'].includes(x.account)) out.partners[k].account = x.account;
    if (Number.isInteger(Number(x.category_id)) && Number(x.category_id) > 0) out.partners[k].category_id = Number(x.category_id);
  }
  for (const [k, v] of Object.entries(obj(d.expenses))) {
    const x = obj(v);
    out.expenses[k] = {};
    if (Number.isInteger(Number(x.category_id)) && Number(x.category_id) > 0) out.expenses[k].category_id = Number(x.category_id);
    if (x.cost_client !== undefined) out.expenses[k].cost_client = typeof x.cost_client === 'string' ? x.cost_client : '';
  }
  for (const [k, v] of Object.entries(obj(d.skip))) if (v) out.skip[k] = true;
  return out;
}

export async function applyRun(runId, { decisions = null, userId = null } = {}) {
  const db = getDb();
  const run = getRunRow(runId);
  if (run.status !== 'preview') throw httpError(409, run.status === 'applied' ? 'العملية دي اتنفذت قبل كده' : 'العملية دي مش في المعاينة — ارفع الملف تاني');
  const live = db.prepare("SELECT id FROM import_runs WHERE status = 'applied'").get();
  if (live) throw httpError(409, `فيه استيراد متنفذ بالفعل (رقم ${live.id}) — لازم تلغيه الأول قبل ما تستورد تاني`);
  const dec = decisions ? cleanDecisions(decisions) : parseJson(run.decisions_json, {});
  const plan = await planFor(run, dec);
  try {
    return db.transaction(() => {
      const again = db.prepare("SELECT id FROM import_runs WHERE status = 'applied'").get();
      if (again) throw httpError(409, `فيه استيراد متنفذ بالفعل (رقم ${again.id})`);
      const created = applyPlan(plan, { runId: run.id, userId });
      const partyOf = (g) => created.party_map[g] ?? null;
      const rec = reconcile(plan, created, partyOf);
      const summary = { preview: previewOf(plan), created, counts: countsOf(created), targets: plan.targets };
      db.prepare(`UPDATE import_runs SET status = 'applied', applied_at = datetime('now'), summary_json = ?, decisions_json = ?,
          reconciliation_json = ?, error = NULL WHERE id = ?`).run(JSON.stringify(summary), JSON.stringify(dec), JSON.stringify(rec), run.id);
      auditRun(userId, run.id, 'apply', { file_name: run.file_name, ...countsOf(created), reconciled: rec.ok, mismatches: rec.mismatches });
      return getRun(run.id);
    })();
  } catch (e) {
    if (!e.status) db.prepare('UPDATE import_runs SET error = ? WHERE id = ?').run(String(e.message || e).slice(0, 500), run.id);
    throw e.status ? e : httpError(400, `الاستيراد وقف ومحصلش أي تسجيل: ${e.message}`);
  }
}

export function rollbackRun(runId, reason, userId = null) {
  const r = String(reason || '').trim();
  if (!r) throw httpError(400, 'اكتب سبب إلغاء الاستيراد', { field: 'reason' });
  const db = getDb();
  return db.transaction(() => {
    const run = getRunRow(runId);
    if (run.status !== 'applied') throw httpError(409, 'العملية دي مش متنفذة — مفيش حاجة تتلغي');
    const summary = parseJson(run.summary_json, {});
    const created = summary.created || {};
    const why = `إلغاء استيراد الإكسيل رقم ${run.id}: ${r}`.slice(0, 500);
    const txns = db.prepare(`SELECT id, date FROM txns WHERE import_run_id = ? AND status = 'posted' AND reversal_of IS NULL ORDER BY id DESC`).all(run.id);
    for (const t of txns) reverse(t.id, why, { userId, importRunId: run.id, date: t.date });
    const now = "datetime('now')";
    db.prepare("UPDATE receipts SET status = 'cancelled', cancel_reason = ? WHERE import_run_id = ? AND status = 'posted'").run(why, run.id);
    db.prepare("UPDATE vouchers SET status = 'cancelled', cancel_reason = ? WHERE import_run_id = ? AND status = 'posted'").run(why, run.id);
    db.prepare(`UPDATE manual_entries SET status = 'cancelled', cancel_reason = ?, cancelled_by = ?, cancelled_at = ${now} WHERE import_run_id = ? AND status = 'posted'`).run(why, userId, run.id);
    db.prepare("UPDATE cheques SET status = 'cancelled', notes = trim(notes || ' ' || ?) WHERE import_run_id = ? AND status <> 'cancelled'").run(why, run.id);
    db.prepare("UPDATE pricing_batches SET status = 'reversed', reason = ? WHERE import_run_id = ? AND status = 'posted'").run(why, run.id);
    db.prepare("UPDATE price_items SET status = 'cancelled', cancel_reason = ? WHERE import_run_id = ? AND status IN ('posted','settled_in_excel','suggested')").run(why, run.id);
    db.prepare(`UPDATE op_sheets SET status = 'cancelled', cancel_reason = ?, cancelled_by = ?, cancelled_at = ${now} WHERE import_run_id = ? AND status <> 'cancelled'`).run(why, userId, run.id);
    db.prepare("UPDATE op_lines SET status = 'cancelled' WHERE import_run_id = ? AND status <> 'cancelled'").run(run.id);
    const rates = db.prepare('DELETE FROM client_rates WHERE import_run_id = ?').run(run.id).changes;
    // parties the run created leave the lists, unless something outside the run uses them
    const parties = db.prepare(`UPDATE parties SET active = 0 WHERE import_run_id = ? AND NOT EXISTS (
        SELECT 1 FROM postings p JOIN txns t ON t.id = p.txn_id WHERE (p.party_id = parties.id OR p.cost_party_id = parties.id)
          AND (t.import_run_id IS NULL OR t.import_run_id <> ?))`).run(run.id, run.id).changes;
    for (const u of created.parties_updated || []) {
      db.prepare('UPDATE parties SET aliases = ?, active = ?, is_walk_in = ? WHERE id = ?').run(u.before.aliases, u.before.active, u.before.is_walk_in, u.id);
    }
    db.prepare('UPDATE materials SET active = 0 WHERE import_run_id = ?').run(run.id);
    for (const u of [...(created.materials_updated || [])].reverse()) {
      db.prepare('UPDATE materials SET aliases = ?, density = ? WHERE id = ?').run(u.before.aliases, u.before.density, u.id);
    }
    db.prepare("UPDATE import_runs SET status = 'rolled_back', rolled_back_at = datetime('now') WHERE id = ?").run(run.id);
    audit(userId, 'rollback', 'import_run', run.id, { status: 'applied' }, { status: 'rolled_back', reason: r, reversed_txns: txns.length, client_rates: rates, parties_deactivated: parties });
    return getRun(run.id);
  })();
}

export function getRun(id) {
  const run = getRunRow(id);
  const summary = parseJson(run.summary_json, {});
  let reconciliation = parseJson(run.reconciliation_json, {});
  // an applied (or rolled back) run is reconciled live: the app figures as they are now
  if ((run.status === 'applied' || run.status === 'rolled_back') && summary.created && summary.targets) {
    reconciliation = reconcile({ targets: summary.targets }, summary.created, (g) => summary.created.party_map?.[g] ?? null);
  }
  const user = run.created_by ? getDb().prepare('SELECT display_name FROM users WHERE id = ?').get(run.created_by)?.display_name : '';
  return {
    id: run.id, file_name: run.file_name, status: run.status, created_at: run.created_at, applied_at: run.applied_at,
    rolled_back_at: run.rolled_back_at, error: run.error, created_by_name: user || '',
    preview: summary.preview || null, simulated: summary.simulated || null, counts: summary.counts || null,
    decisions: parseJson(run.decisions_json, {}), reconciliation,
  };
}

export function listRuns() {
  return getDb().prepare(`SELECT r.id, r.file_name, r.status, r.created_at, r.applied_at, r.rolled_back_at, r.error, u.display_name AS created_by_name
    FROM import_runs r LEFT JOIN users u ON u.id = r.created_by ORDER BY r.id DESC LIMIT 50`).all();
}
