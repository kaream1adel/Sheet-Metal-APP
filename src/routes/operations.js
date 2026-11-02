// Module operations (التشغيل وأوامر الشغل) — mounted at /api/operations in src/app.js.
//   أوراق التشغيل · ورقة جديدة · المراجعة والاعتماد · صوّر ورقة (photo jobs) · أوامر الشغل ·
//   سجل الإنتاج · the staff home (المطلوب النهارده)
// Quantities only: nothing here is money, and every answer still goes through stripMoney().
// Operations posts nothing to the ledger; pricing reads approved lines (approvedLinesForSheet).
import { Router } from 'express';
import { getDb } from '../db.js';
import { requireUser, requirePerm, requireAny } from '../auth.js';
import { can } from '../permissions.js';
import { stripMoney } from '../money.js';
import { httpError, todayISO, requireDate } from '../util.js';
import * as P from '../../public/js/modules/ops-paper.js';
import {
  createSheet, updateSheet, submitSheet, loadSheet, getSheetRow, listSheets, ackIssues, approveSheet, cancelSheet,
  correctSheet, clientCandidates, matchClientExact,
} from '../operations/sheets.js';
import { listOrders, getOrder, orderProgress, createOrder, updateOrder, cancelOrder, deleteOrder } from '../operations/orders.js';
import {
  decodeJpeg, createJob, getJob, jobView, recentJobs, jobCounts, photoFileOf, pickMachine, retryJob, typeByHand, dismissJob, savePhotoFile,
} from '../photos.js';
import { aiStatus } from '../ai.js';
import { audit } from '../db.js';

export const operations = Router();

const record = requirePerm('operations.record');
const approve = requirePerm('operations.approve');
const seeSheets = requireAny('operations.record', 'operations.approve');
const orders = requirePerm('workorders');
const send = (req, res, data, status = 200) => res.status(status).json(stripMoney(req.user, data));
const dateParam = (v, what, field) => requireDate(v, { label: what, field, required: false });

// ---------- أوراق التشغيل ----------
operations.get('/sheets', seeSheets, (req, res) => {
  const q = req.query;
  if (q.machine && !P.MACHINES.includes(q.machine)) throw httpError(400, 'المكنة غلط');
  const sheets = listSheets({
    machine: q.machine || null, technician_id: q.technician_id || null, client_id: q.client_id || null,
    from: dateParam(q.from, 'تاريخ البداية', 'from'), to: dateParam(q.to, 'تاريخ النهاية', 'to'), status: q.status || null, q: q.q || null,
    mine: q.mine === '1' ? req.user.id : null, limit: q.limit,
  });
  send(req, res, { sheets });
});

operations.post('/sheets', record, (req, res) => {
  const b = req.body || {};
  const id = createSheet({ machine: b.machine, technician_id: b.technician_id, sheet_date: b.sheet_date, notes: b.notes,
    lines: b.lines, draft: b.submit ? false : true, userId: req.user.id });
  send(req, res, { sheet: loadSheet(id) }, 201);
});

operations.get('/sheets/:id', seeSheets, (req, res) => send(req, res, { sheet: loadSheet(req.params.id) }));

operations.put('/sheets/:id', seeSheets, (req, res) => {
  updateSheet(req.params.id, req.body || {}, req.user.id);
  send(req, res, { sheet: loadSheet(req.params.id) });
});

operations.post('/sheets/:id/submit', record, (req, res) => {
  submitSheet(req.params.id, req.user.id);
  send(req, res, { sheet: loadSheet(req.params.id) });
});

// A yellow cell was looked at. keys: issue.key values from the sheet.
operations.post('/sheets/:id/ack', seeSheets, (req, res) => {
  const keys = Array.isArray(req.body?.keys) ? req.body.keys.map(String).slice(0, 500) : [];
  if (!keys.length) throw httpError(400, 'مفيش خانات');
  const n = ackIssues(req.params.id, keys, req.user.id);
  send(req, res, { acked: n, sheet: loadSheet(req.params.id) });
});

operations.post('/sheets/:id/approve', approve, (req, res) => {
  approveSheet(req.params.id, req.user.id);
  send(req, res, { sheet: loadSheet(req.params.id) });
});

// Cancel: the manager (approve) for any sheet; whoever typed a draft may throw his own draft away.
operations.post('/sheets/:id/cancel', requireUser, (req, res) => {
  const s = getSheetRow(req.params.id);
  const ownDraft = s.status === 'review' && s.draft && s.created_by === req.user.id && can(req.user, 'operations.record');
  if (!ownDraft && !can(req.user, 'operations.approve')) throw httpError(403, 'مش مسموح لك بالحركة دي');
  cancelSheet(s.id, req.body?.reason, req.user.id);
  send(req, res, { sheet: loadSheet(s.id) });
});

operations.post('/sheets/:id/correct', approve, (req, res) => {
  const id = correctSheet(req.params.id, req.body?.reason, req.user.id);
  send(req, res, { sheet: loadSheet(id) }, 201);
});

operations.get('/sheets/:id/photo', seeSheets, (req, res) => {
  const s = getSheetRow(req.params.id);
  const file = photoFileOf(s.photo_path);
  if (!file) throw httpError(404, 'الورقة دي ملهاش صورة');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.sendFile(file);
});

// A photo for a sheet typed by hand (or a better photo), while it is not approved.
operations.post('/sheets/:id/photo', record, (req, res) => {
  const db = getDb();
  const s = getSheetRow(req.params.id);
  if (s.status !== 'review') throw httpError(409, 'الورقة دي مقفولة');
  const path = savePhotoFile(decodeJpeg(req.body?.image));
  db.transaction(() => {
    db.prepare("UPDATE op_sheets SET photo_path = ?, updated_at = datetime('now') WHERE id = ?").run(path, s.id);
    audit(req.user.id, 'photo', 'op_sheet', s.id, { photo: s.photo_path }, { photo: path });
  })();
  send(req, res, { sheet: loadSheet(s.id) });
});

// المراجعة: sheets sent to review (not drafts), oldest first.
operations.get('/review', approve, (req, res) => {
  const sheets = listSheets({ status: 'review' }).reverse();
  send(req, res, { sheets });
});

// ---------- clients as written on the paper ----------
operations.get('/clients/match', seeSheets, (req, res) => {
  const text = String(req.query.text || '').slice(0, 80);
  send(req, res, { exact: matchClientExact(text), candidates: clientCandidates(text) });
});

// ---------- صوّر ورقة ----------
// Body: { image: "data:image/jpeg;base64,..." } or { images: [...] } (up to 6), machine?, technician_id?
operations.post('/photos', record, (req, res) => {
  const b = req.body || {};
  const list = Array.isArray(b.images) ? b.images : [b.image];
  if (!list.length || list.length > 6) throw httpError(400, 'ابعت من صورة لـ 6 صور في المرة');
  if (b.machine && !P.MACHINES.includes(b.machine)) throw httpError(400, 'المكنة غلط', { field: 'machine' });
  let tech = null;
  if (b.technician_id) {
    tech = getDb().prepare('SELECT id FROM technicians WHERE id = ?').get(Number(b.technician_id))?.id;
    if (!tech) throw httpError(400, 'الفني مش موجود', { field: 'technician_id' });
  }
  const bufs = list.map(decodeJpeg); // all checked before any is saved
  const ids = bufs.map((buf) => createJob({ buf, machine: b.machine || null, technicianId: tech, userId: req.user.id }));
  send(req, res, { jobs: ids.map((id) => jobView(getJob(id))), job: jobView(getJob(ids[0])) }, 201);
});

operations.get('/photos', record, (req, res) => {
  send(req, res, { jobs: recentJobs().map(jobView), ai: aiStatus().enabled, counts: jobCounts() });
});

const job404 = (id) => { const j = getJob(id); if (!j) throw httpError(404, 'الصورة دي مش موجودة'); return j; };
operations.get('/photos/:id', record, (req, res) => send(req, res, { job: jobView(job404(req.params.id)) }));

operations.get('/photos/:id/photo', seeSheets, (req, res) => {
  const file = photoFileOf(job404(req.params.id).photo_path);
  if (!file) throw httpError(404, 'ملف الصورة مش موجود');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.sendFile(file);
});

operations.post('/photos/:id/machine', record, (req, res) => {
  pickMachine(Number(req.params.id), req.body?.machine, req.user.id);
  send(req, res, { job: jobView(getJob(req.params.id)) });
});
operations.post('/photos/:id/retry', record, (req, res) => {
  retryJob(Number(req.params.id), req.user.id);
  send(req, res, { job: jobView(getJob(req.params.id)) });
});
operations.post('/photos/:id/manual', record, (req, res) => {
  typeByHand(Number(req.params.id), req.body?.machine || null, req.user.id);
  send(req, res, { job: jobView(getJob(req.params.id)) });
});
operations.post('/photos/:id/dismiss', record, (req, res) => {
  dismissJob(Number(req.params.id), req.user.id);
  send(req, res, { ok: true });
});

// ---------- أوامر الشغل ----------
operations.get('/orders', orders, (req, res) => {
  send(req, res, { orders: listOrders({ client_id: req.query.client_id, status: req.query.status || null, q: req.query.q, open: req.query.open === '1' }) });
});
// The open orders for the entry grid's optional أمر الشغل column (anyone who types sheets).
operations.get('/orders-open', seeSheets, (req, res) => {
  send(req, res, { orders: listOrders({ open: true, client_id: req.query.client_id }).map((o) => ({ id: o.id, serial: o.serial, client_id: o.client_id, client_name: o.client_name, description: o.description, status: o.status })) });
});
operations.post('/orders', orders, (req, res) => send(req, res, { order: getOrder(createOrder(req.body || {}, req.user.id)) }, 201));
operations.get('/orders/:id', orders, (req, res) => send(req, res, orderProgress(req.params.id)));
operations.patch('/orders/:id', orders, (req, res) => {
  updateOrder(req.params.id, req.body || {}, req.user.id);
  send(req, res, orderProgress(req.params.id));
});
operations.post('/orders/:id/cancel', orders, (req, res) => {
  cancelOrder(req.params.id, req.body?.reason, req.user.id);
  send(req, res, orderProgress(req.params.id));
});
operations.delete('/orders/:id', orders, (req, res) => {
  deleteOrder(req.params.id, req.user.id);
  send(req, res, { ok: true });
});

// ---------- سجل الإنتاج: approved lines, quantities only ----------
operations.get('/production', requireAny('operations.record', 'reports'), (req, res) => {
  const q = req.query;
  const today = todayISO();
  const from = dateParam(q.from, 'تاريخ البداية', 'from') || `${today.slice(0, 7)}-01`;
  const to = dateParam(q.to, 'تاريخ النهاية', 'to') || today;
  if (from > to) throw httpError(400, 'تاريخ البداية بعد تاريخ النهاية');
  if (q.machine && !P.MACHINES.includes(q.machine)) throw httpError(400, 'المكنة غلط');
  const rows = getDb().prepare(`SELECT l.id, l.row_no, l.part_name, l.client_id, COALESCE(c.name, l.client_text) AS client_name,
      l.material_text, m.name AS material_name, l.thickness, l.pieces, l.per_piece, l.total_written, l.sheets, l.minutes_per_sheet,
      l.louvers_per_piece, l.material_source, l.length_cm, l.width_cm, COALESCE(l.work_date, s.sheet_date) AS work_date,
      s.id AS sheet_id, s.serial AS sheet_serial, s.machine, s.technician_id, t.name AS technician_name, w.serial AS work_order_serial
    FROM op_lines l JOIN op_sheets s ON s.id = l.sheet_id
    LEFT JOIN parties c ON c.id = l.client_id LEFT JOIN materials m ON m.id = l.material_id
    LEFT JOIN technicians t ON t.id = s.technician_id LEFT JOIN work_orders w ON w.id = l.work_order_id
    WHERE s.status = 'approved' AND l.status = 'active' AND l.row_no > 0
      AND COALESCE(l.work_date, s.sheet_date) BETWEEN ? AND ?
      AND (? IS NULL OR s.machine = ?) AND (? IS NULL OR s.technician_id = ?) AND (? IS NULL OR l.client_id = ?)
    ORDER BY COALESCE(l.work_date, s.sheet_date) DESC, s.id DESC, l.row_no LIMIT 3000`)
    .all(from, to, q.machine || null, q.machine || null, q.technician_id ? Number(q.technician_id) : null, q.technician_id ? Number(q.technician_id) : null,
      q.client_id ? Number(q.client_id) : null, q.client_id ? Number(q.client_id) : null)
    .map((r) => ({ ...r, machine_name: P.MACHINE_NAMES[r.machine], ops: r.pieces != null && r.per_piece != null ? r.pieces * r.per_piece : null,
      minutes: r.sheets != null && r.minutes_per_sheet != null ? Math.round(r.sheets * r.minutes_per_sheet * 100) / 100 : null }));
  const by = {};
  for (const r of rows) {
    const m = (by[r.machine] ||= { machine: r.machine, machine_name: r.machine_name, lines: 0, pieces: 0, ops: 0, sheets: 0, minutes: 0 });
    m.lines += 1;
    m.pieces += r.pieces || 0;
    m.ops += r.ops || 0;
    m.sheets += r.sheets || 0;
    m.minutes += r.minutes || 0;
  }
  send(req, res, { from, to, rows, by_machine: P.MACHINES.filter((m) => by[m]).map((m) => by[m]) });
});

// ---------- الرئيسية for staff: المطلوب النهارده ----------
operations.get('/home', requireUser, (req, res) => {
  const db = getDb();
  const out = { today: todayISO() };
  if (can(req.user, 'operations.approve')) {
    const review = listSheets({ status: 'review' });
    out.review = { count: review.length, red: review.filter((s) => s.counts?.red).length, oldest: review.slice(-5).reverse() };
  }
  if (can(req.user, 'operations.record')) {
    out.photos = { ...jobCounts(), ai: aiStatus().enabled };
    out.drafts = listSheets({ status: 'draft', mine: req.user.id, limit: 10 });
  }
  if (can(req.user, 'workorders')) {
    const open = listOrders({ open: true });
    const soon = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
    out.orders = { count: open.length, due_soon: open.filter((o) => o.due_date && o.due_date <= soon).slice(0, 8) };
  }
  out.approved_today = db.prepare("SELECT COUNT(*) n FROM op_sheets WHERE status = 'approved' AND substr(approved_at, 1, 10) = ?").get(out.today).n;
  send(req, res, out);
});

operations.get('/ai-status', seeSheets, (req, res) => send(req, res, { enabled: aiStatus().enabled }));

// Anything else under /api/operations is not built.
operations.use(requireUser, (_req, res) => res.status(404).json({ error: 'مش موجود' }));
