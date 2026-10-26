// Deliveries: the manager records what left the workshop. Quantities only, no money.
import { Router } from 'express';
import { getDb, audit } from '../db.js';
import { requirePerm } from '../auth.js';
import { httpError, cleanText, parseDate, todayISO } from '../util.js';
import { LINE_SELECT, workText } from '../ledger.js';
import { MACHINE_FIELDS, FIELD_LABELS } from '../sheets.js';

export const deliveries = Router();
const perm = requirePerm('deliveries.manage');

const fmtN = (v) => String(Number(Number(v).toFixed(3)));

// "3 قطعة × 4 تنيات" — the facts of a line in words.
export function qtyText(l) {
  const f = MACHINE_FIELDS[l.machine_code] || [];
  return f.filter((k) => l[k] !== null && l[k] !== undefined && l[k] !== '' && k !== 'total_written')
    .map((k) => `${FIELD_LABELS[k]} ${k === 'sheet_size' ? l[k] : fmtN(l[k])}`).join(' · ');
}

const pendingSql = `SELECT x.* FROM (${LINE_SELECT}) x JOIN lines l ON l.id = x.id JOIN sheets s ON s.id = l.sheet_id
  WHERE s.status = 'confirmed' AND x.delivery_date IS NULL`;

deliveries.get('/deliveries/pending', perm, (_req, res) => {
  const rows = getDb().prepare(`SELECT c.id, c.name, COUNT(*) AS lines, MIN(p.date) AS oldest
    FROM (${pendingSql}) p JOIN clients c ON c.id = p.client_id GROUP BY c.id ORDER BY oldest`).all();
  res.json({ clients: rows });
});

deliveries.get('/deliveries/pending/:clientId', perm, (req, res) => {
  const lines = getDb().prepare(`${pendingSql} AND x.client_id = ? ORDER BY x.date, x.id`).all(req.params.clientId)
    .map((l) => ({ id: l.id, date: l.date, machine_name: l.machine_name, text: workText(l), qty: qtyText(l) }));
  res.json({ lines });
});

deliveries.get('/deliveries', perm, (req, res) => {
  const rows = getDb().prepare(`SELECT d.*, c.name AS client_name, u.display_name AS created_by_name,
      (SELECT COUNT(*) FROM lines WHERE delivery_id = d.id) AS lines
    FROM deliveries d JOIN clients c ON c.id = d.client_id LEFT JOIN users u ON u.id = d.created_by
    WHERE (? IS NULL OR d.client_id = ?) ORDER BY d.id DESC LIMIT 200`).all(req.query.client_id ?? null, req.query.client_id ?? null);
  res.json({ deliveries: rows });
});

export function loadDelivery(id) {
  const db = getDb();
  const d = db.prepare(`SELECT d.*, c.name AS client_name, c.phone AS client_phone FROM deliveries d
    JOIN clients c ON c.id = d.client_id WHERE d.id = ?`).get(id);
  if (!d) throw httpError(404, 'إذن التسليم مش موجود');
  d.lines = db.prepare(`SELECT x.* FROM (${LINE_SELECT}) x WHERE x.id IN (SELECT id FROM lines WHERE delivery_id = ?) ORDER BY x.date, x.id`)
    .all(d.id).map((l) => ({ id: l.id, date: l.date, machine_name: l.machine_name, text: workText(l), qty: qtyText(l) }));
  return d;
}

deliveries.get('/deliveries/:id', perm, (req, res) => res.json({ delivery: loadDelivery(req.params.id) }));

deliveries.post('/deliveries', perm, (req, res) => {
  const db = getDb();
  const b = req.body || {};
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(b.client_id);
  if (!client) throw httpError(400, 'اختار العميل');
  const ids = (Array.isArray(b.line_ids) ? b.line_ids : []).map(Number);
  if (!ids.length) throw httpError(400, 'علّم على الشغل اللي اتسلم');
  const pending = new Set(db.prepare(`${pendingSql} AND x.client_id = ?`).all(client.id).map((l) => l.id));
  for (const id of ids) if (!pending.has(id)) throw httpError(409, 'فيه سطر اتسلم قبل كده أو مش للعميل ده');
  const date = b.delivery_date ? parseDate(b.delivery_date) : todayISO();
  if (!date) throw httpError(400, 'تاريخ التسليم غلط');
  const id = db.transaction(() => {
    const r = db.prepare('INSERT INTO deliveries (client_id, delivery_date, receiver, notes, created_by) VALUES (?,?,?,?,?)')
      .run(client.id, date, cleanText(b.receiver, 80), cleanText(b.notes, 300), req.user.id);
    const upd = db.prepare('UPDATE lines SET delivery_id = ?, delivered_at = ? WHERE id = ?');
    for (const lid of ids) upd.run(r.lastInsertRowid, date, lid);
    audit(req.user.id, 'create', 'delivery', r.lastInsertRowid, undefined, { client_id: client.id, lines: ids, date });
    return r.lastInsertRowid;
  })();
  res.status(201).json({ delivery: loadDelivery(id) });
});

deliveries.post('/deliveries/:id/cancel', perm, (req, res) => {
  const db = getDb();
  const d = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(req.params.id);
  if (!d) throw httpError(404, 'إذن التسليم مش موجود');
  if (d.cancelled_at) throw httpError(409, 'اتلغى قبل كده');
  const reason = cleanText(req.body?.reason, 300);
  if (!reason) throw httpError(400, 'اكتب سبب الإلغاء');
  db.transaction(() => {
    const lines = db.prepare('SELECT id FROM lines WHERE delivery_id = ?').all(d.id).map((l) => l.id);
    db.prepare('UPDATE lines SET delivery_id = NULL, delivered_at = NULL WHERE delivery_id = ?').run(d.id);
    db.prepare("UPDATE deliveries SET cancelled_by = ?, cancelled_at = datetime('now'), cancel_reason = ? WHERE id = ?").run(req.user.id, reason, d.id);
    audit(req.user.id, 'cancel', 'delivery', d.id, { lines }, { reason });
  })();
  res.json({ ok: true });
});
