// Module import (الاستيراد من الإكسيل) — mounted at /api/import in src/app.js.
//
//   GET  /                         the runs (newest first) and the applied one, if any
//   POST /upload                   { file_name, data: base64 or data URL of the .xlsx } → a preview run
//                                  (the import simulated and reconciled, nothing kept)
//   GET  /runs/:id                 the run: preview, decisions, reconciliation (live once applied)
//   PUT  /runs/:id/decisions       { decisions } → a fresh preview
//   POST /runs/:id/apply           { decisions? } the import, in one transaction
//   POST /runs/:id/rollback        { reason } reverses everything the run posted (audited)
//
// The whole module needs the 'import' permission (admin); every response goes through
// stripMoney() as well. Postings only through src/ledger.js (inside src/import/apply.js).
import { Router } from 'express';
import { requireUser, requirePerm } from '../auth.js';
import { stripMoney } from '../money.js';
import { httpError, asyncRoute } from '../util.js';
import * as I from '../import/index.js';

export const importer = Router();

const allowed = requirePerm('import');
const id = (req) => {
  const n = Number(req.params.id);
  if (!Number.isSafeInteger(n) || n <= 0) throw httpError(404, 'مش موجود');
  return n;
};
const send = (req, res, data, status = 200) => res.status(status).json(stripMoney(req.user, data));

importer.get('/', allowed, (req, res) => {
  const runs = I.listRuns();
  send(req, res, { runs, applied_id: runs.find((r) => r.status === 'applied')?.id ?? null });
});

importer.post('/upload', allowed, asyncRoute(async (req, res) => {
  const b = req.body || {};
  const raw = String(b.data || '');
  const base64 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
  if (!base64 || !/^[A-Za-z0-9+/=\s]+$/.test(base64)) throw httpError(400, 'اختار ملف الإكسيل', { field: 'file' });
  const buffer = Buffer.from(base64, 'base64');
  const run = await I.createPreview({ fileName: String(b.file_name || '').slice(0, 200), buffer, userId: req.user.id });
  send(req, res, { run }, 201);
}));

importer.get('/runs/:id', allowed, (req, res) => send(req, res, { run: I.getRun(id(req)) }));

importer.put('/runs/:id/decisions', allowed, asyncRoute(async (req, res) => {
  send(req, res, { run: await I.saveDecisions(id(req), req.body?.decisions || {}, req.user.id) });
}));

importer.post('/runs/:id/apply', allowed, asyncRoute(async (req, res) => {
  send(req, res, { run: await I.applyRun(id(req), { decisions: req.body?.decisions || null, userId: req.user.id }) });
}));

importer.post('/runs/:id/rollback', allowed, (req, res) => {
  send(req, res, { run: I.rollbackRun(id(req), req.body?.reason, req.user.id) });
});

// Anything else under /api/import is an unknown path.
importer.use(requireUser, (_req, res) => res.status(404).json({ error: 'مش موجود' }));
