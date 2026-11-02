// أوامر الشغل (optional): a client's request. Lines of any sheet may point at one; nothing
// requires it. Status: open → in_progress → done → delivered, or cancelled (with a reason).
// An order with work on it is never deleted: it is cancelled.
import { getDb, audit } from '../db.js';
import { httpError, cleanText, isRealDate } from '../util.js';
import { nextSerial } from '../ledger.js';
import * as P from '../../public/js/modules/ops-paper.js';

export const ORDER_STATUS = { open: 'مفتوح', in_progress: 'شغال', done: 'خلص', delivered: 'اتسلم', cancelled: 'ملغي' };
// Which status may follow which (a person can also step back one, e.g. done → in_progress).
const NEXT = {
  open: ['in_progress', 'done', 'cancelled'],
  in_progress: ['open', 'done', 'cancelled'],
  done: ['in_progress', 'delivered', 'cancelled'],
  delivered: ['done'],
  cancelled: [],
};

function clientOk(id) {
  const c = getDb().prepare("SELECT id, name FROM parties WHERE id = ? AND kind = 'client'").get(Number(id));
  if (!c) throw httpError(400, 'اختار العميل', { field: 'client_id' });
  return c;
}
function dateOk(v, field, what, optional = false) {
  if ((v === null || v === undefined || v === '') && optional) return null;
  if (!isRealDate(v)) throw httpError(400, `${what} غلط — لازم يكون تاريخ حقيقي`, { field });
  return P.toAscii(v).trim();
}

const SELECT = `SELECT o.*, c.name AS client_name, u.display_name AS created_by_name,
  (SELECT COUNT(*) FROM op_lines l JOIN op_sheets s ON s.id = l.sheet_id
     WHERE l.work_order_id = o.id AND s.status <> 'cancelled' AND l.row_no > 0) AS lines_count,
  (SELECT COUNT(*) FROM op_lines l JOIN op_sheets s ON s.id = l.sheet_id
     WHERE l.work_order_id = o.id AND s.status = 'approved' AND l.row_no > 0) AS approved_lines
  FROM work_orders o JOIN parties c ON c.id = o.client_id LEFT JOIN users u ON u.id = o.created_by`;

const view = (o) => ({
  id: o.id, serial: o.serial, client_id: o.client_id, client_name: o.client_name, date: o.date, description: o.description,
  due_date: o.due_date, status: o.status, status_name: ORDER_STATUS[o.status], notes: o.notes, cancel_reason: o.cancel_reason,
  created_by_name: o.created_by_name, created_at: o.created_at, updated_at: o.updated_at,
  lines_count: o.lines_count, approved_lines: o.approved_lines,
});

export function listOrders({ client_id, status, q, open } = {}) {
  const where = [];
  const args = [];
  if (client_id) { where.push('o.client_id = ?'); args.push(Number(client_id)); }
  if (status) {
    if (!(status in ORDER_STATUS)) throw httpError(400, 'الحالة غلط');
    where.push('o.status = ?'); args.push(status);
  }
  if (open) where.push("o.status IN ('open','in_progress')");
  const rows = getDb().prepare(`${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY CASE o.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'done' THEN 2 WHEN 'delivered' THEN 3 ELSE 4 END,
      COALESCE(o.due_date, '9999') , o.id DESC LIMIT 500`).all(...args).map(view);
  const f = P.foldName(q || '');
  return f ? rows.filter((o) => P.foldName(`${o.serial} ${o.client_name} ${o.description}`).includes(f) || o.serial.includes(String(q).trim())) : rows;
}

export function getOrder(id) {
  const o = getDb().prepare(`${SELECT} WHERE o.id = ?`).get(Number(id));
  if (!o) throw httpError(404, 'أمر الشغل ده مش موجود');
  return view(o);
}

// The order with its work so far: every line linked to it (sheets not cancelled) and the
// quantities per machine — progress, never money.
export function orderProgress(id) {
  const o = getOrder(id);
  const lines = getDb().prepare(`SELECT l.id, l.row_no, l.part_name, l.material_text, l.thickness, l.pieces, l.per_piece, l.sheets,
      l.minutes_per_sheet, l.louvers_per_piece, l.work_date, s.id AS sheet_id, s.serial AS sheet_serial, s.machine, s.sheet_date,
      s.status AS sheet_status, s.draft
    FROM op_lines l JOIN op_sheets s ON s.id = l.sheet_id
    WHERE l.work_order_id = ? AND s.status <> 'cancelled' AND l.row_no > 0 ORDER BY s.sheet_date, s.id, l.row_no`).all(o.id)
    .map((l) => ({ ...l, machine_name: P.MACHINE_NAMES[l.machine], sheet_status_name: P.STATUS_NAMES[l.sheet_status === 'review' && l.draft ? 'draft' : l.sheet_status], draft: !!l.draft }));
  const by = {};
  for (const l of lines) {
    const m = (by[l.machine] ||= { machine: l.machine, machine_name: l.machine_name, lines: 0, pieces: 0, sheets: 0, ops: 0, approved: 0 });
    m.lines += 1;
    m.pieces += l.pieces || 0;
    m.sheets += l.sheets || 0;
    m.ops += (l.pieces || 0) * (l.per_piece || 0);
    if (l.sheet_status === 'approved') m.approved += 1;
  }
  return { order: o, lines, by_machine: Object.values(by), next_statuses: NEXT[o.status] };
}

export function createOrder(b, userId) {
  const c = clientOk(b.client_id);
  const date = dateOk(b.date, 'date', 'تاريخ الأمر');
  const due = dateOk(b.due_date, 'due_date', 'ميعاد التسليم', true);
  if (due && due < date) throw httpError(400, 'ميعاد التسليم قبل تاريخ الأمر', { field: 'due_date' });
  const description = cleanText(b.description, 500);
  if (!description) throw httpError(400, 'اكتب الشغل المطلوب', { field: 'description' });
  const db = getDb();
  return db.transaction(() => {
    const serial = nextSerial('أم');
    const id = Number(db.prepare(`INSERT INTO work_orders (serial, client_id, date, description, due_date, notes, created_by)
      VALUES (?,?,?,?,?,?,?)`).run(serial, c.id, date, description, due, cleanText(b.notes, 1000), userId ?? null).lastInsertRowid);
    audit(userId, 'create', 'work_order', id, undefined, { serial, client_id: c.id, date, due_date: due, description });
    return id;
  })();
}

export function updateOrder(id, b, userId) {
  const db = getDb();
  const cur = db.prepare('SELECT * FROM work_orders WHERE id = ?').get(Number(id));
  if (!cur) throw httpError(404, 'أمر الشغل ده مش موجود');
  if (cur.status === 'cancelled') throw httpError(409, 'أمر الشغل ده ملغي');
  const next = { ...cur };
  if (b.client_id !== undefined && Number(b.client_id) !== cur.client_id) {
    const linked = db.prepare('SELECT COUNT(*) n FROM op_lines WHERE work_order_id = ?').get(cur.id).n;
    if (linked) throw httpError(409, 'مينفعش تغير العميل — فيه سطور تشغيل مربوطة بالأمر ده');
    next.client_id = clientOk(b.client_id).id;
  }
  if (b.date !== undefined) next.date = dateOk(b.date, 'date', 'تاريخ الأمر');
  if (b.due_date !== undefined) next.due_date = dateOk(b.due_date, 'due_date', 'ميعاد التسليم', true);
  if (next.due_date && next.due_date < next.date) throw httpError(400, 'ميعاد التسليم قبل تاريخ الأمر', { field: 'due_date' });
  if (b.description !== undefined) {
    next.description = cleanText(b.description, 500);
    if (!next.description) throw httpError(400, 'اكتب الشغل المطلوب', { field: 'description' });
  }
  if (b.notes !== undefined) next.notes = cleanText(b.notes, 1000);
  if (b.status !== undefined && b.status !== cur.status) {
    if (b.status === 'cancelled') throw httpError(400, 'الإلغاء بيكون من «إلغاء الأمر» مع السبب');
    if (!(b.status in ORDER_STATUS) || !NEXT[cur.status].includes(b.status)) {
      throw httpError(409, `مينفعش الأمر يتنقل من «${ORDER_STATUS[cur.status]}» لـ «${ORDER_STATUS[b.status] || b.status}»`, { field: 'status' });
    }
    next.status = b.status;
  }
  db.transaction(() => {
    db.prepare(`UPDATE work_orders SET client_id=?, date=?, due_date=?, description=?, notes=?, status=?, updated_at=datetime('now') WHERE id=?`)
      .run(next.client_id, next.date, next.due_date, next.description, next.notes, next.status, cur.id);
    audit(userId, next.status !== cur.status ? 'status' : 'update', 'work_order', cur.id,
      { client_id: cur.client_id, date: cur.date, due_date: cur.due_date, description: cur.description, status: cur.status },
      { client_id: next.client_id, date: next.date, due_date: next.due_date, description: next.description, status: next.status });
  })();
  return cur.id;
}

export function cancelOrder(id, reason, userId) {
  const r = cleanText(reason, 300);
  if (!r) throw httpError(400, 'اكتب سبب الإلغاء', { field: 'reason' });
  const db = getDb();
  const cur = db.prepare('SELECT * FROM work_orders WHERE id = ?').get(Number(id));
  if (!cur) throw httpError(404, 'أمر الشغل ده مش موجود');
  if (cur.status === 'cancelled') throw httpError(409, 'أمر الشغل ده ملغي بالفعل');
  if (cur.status === 'delivered') throw httpError(409, 'أمر الشغل ده اتسلم — مينفعش يتلغى');
  db.transaction(() => {
    db.prepare("UPDATE work_orders SET status = 'cancelled', cancel_reason = ?, updated_at = datetime('now') WHERE id = ?").run(r, cur.id);
    audit(userId, 'cancel', 'work_order', cur.id, { status: cur.status }, { status: 'cancelled', reason: r });
  })();
  return cur.id;
}

// Only an order nobody used (no line ever pointed at it) can be removed; else cancel it.
export function deleteOrder(id, userId) {
  const db = getDb();
  const cur = db.prepare('SELECT * FROM work_orders WHERE id = ?').get(Number(id));
  if (!cur) throw httpError(404, 'أمر الشغل ده مش موجود');
  if (db.prepare('SELECT COUNT(*) n FROM op_lines WHERE work_order_id = ?').get(cur.id).n) {
    throw httpError(409, 'فيه سطور تشغيل مربوطة بالأمر ده — الغيه بدل ما تمسحه');
  }
  db.transaction(() => {
    db.prepare('DELETE FROM work_orders WHERE id = ?').run(cur.id);
    audit(userId, 'delete', 'work_order', cur.id, { serial: cur.serial, client_id: cur.client_id, description: cur.description, status: cur.status });
  })();
}
