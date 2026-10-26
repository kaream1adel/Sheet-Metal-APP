// Sheets: manual entry, editing while in review, confirming and cancelling.
import { Router } from 'express';
import { getDb, audit } from '../db.js';
import { requirePerm, requireUser } from '../auth.js';
import { can } from '../permissions.js';
import { allBalances } from '../ledger.js';
import { backupStatus } from '../backup.js';
import { updateStatus } from '../update.js';
import { httpError, parseDate, cleanText, todayISO } from '../util.js';
import { normalizeLine, isEmptyLine, validateSheet, summarize, MACHINE_FIELDS, FIELD_LABELS } from '../sheets.js';

export const sheets = Router();

const STATUS_NAMES = { review: 'مستنية المراجعة', confirmed: 'اتأكدت', cancelled: 'اتلغت' };

const LINE_COLS = ['row_no', 'client_id', 'client_text', 'part_name', 'material_id', 'thickness', 'pieces',
  'ops_per_piece', 'total_written', 'sheets', 'minutes_per_sheet', 'sheet_size', 'pieces_per_sheet',
  'hits_per_piece', 'louvers_per_piece', 'minutes', 'work_date', 'material_source', 'notes'];

function loadSheet(id) {
  const db = getDb();
  const s = db.prepare(`
    SELECT s.*, m.code AS machine_code, m.name AS machine_name, t.name AS technician_name,
           cu.display_name AS created_by_name, fu.display_name AS confirmed_by_name
    FROM sheets s JOIN machines m ON m.id = s.machine_id
    LEFT JOIN technicians t ON t.id = s.technician_id
    LEFT JOIN users cu ON cu.id = s.created_by
    LEFT JOIN users fu ON fu.id = s.confirmed_by
    WHERE s.id = ?`).get(id);
  if (!s) throw httpError(404, 'الورقة مش موجودة');
  s.lines = db.prepare(`
    SELECT l.*, c.name AS client_name, mt.name AS material_name
    FROM lines l LEFT JOIN clients c ON c.id = l.client_id LEFT JOIN materials mt ON mt.id = l.material_id
    WHERE l.sheet_id = ? ORDER BY l.row_no`).all(id);
  s.acks = db.prepare('SELECT issue_key FROM sheet_acks WHERE sheet_id = ?').all(id).map((a) => a.issue_key);
  return s;
}

function withIssues(s) {
  const issues = s.status === 'review' ? validateSheet(s, s.lines, s.machine_code) : [];
  return { ...s, status_name: STATUS_NAMES[s.status], fields: MACHINE_FIELDS[s.machine_code], issues, counts: summarize(issues) };
}

// Header + lines from a request body, checked against the database.
function readInput(body, machine) {
  const db = getDb();
  const sheet_date = body.sheet_date ? parseDate(body.sheet_date) : null;
  if (sheet_date === undefined) throw httpError(400, 'تاريخ الورقة غلط');
  const technician_id = body.technician_id ? Number(body.technician_id) : null;
  if (technician_id && !db.prepare('SELECT 1 FROM technicians WHERE id = ?').get(technician_id)) {
    throw httpError(400, 'الفني مش موجود');
  }
  const raw = Array.isArray(body.lines) ? body.lines : [];
  if (raw.length > 60) throw httpError(400, 'السطور كتير قوي في ورقة واحدة');
  const lines = raw.map((r, i) => normalizeLine(r || {}, i + 1)).filter((l) => !isEmptyLine(l));
  lines.forEach((l, i) => { l.row_no = i + 1; });
  const clientOk = db.prepare('SELECT 1 FROM clients WHERE id = ?');
  const matOk = db.prepare('SELECT 1 FROM materials WHERE id = ?');
  for (const l of lines) {
    if (l.client_id && !clientOk.get(l.client_id)) throw httpError(400, `سطر ${l.row_no}: العميل مش موجود`);
    if (l.material_id && !matOk.get(l.material_id)) throw httpError(400, `سطر ${l.row_no}: الخامة مش موجودة`);
    // Store only the columns this machine uses (plus the common ones).
    for (const f of ['ops_per_piece', 'total_written', 'sheets', 'minutes_per_sheet', 'pieces_per_sheet',
      'hits_per_piece', 'louvers_per_piece', 'minutes', 'pieces']) {
      if (!MACHINE_FIELDS[machine.code].includes(f) && l[f] !== null && !Number.isNaN(l[f])) {
        throw httpError(400, `سطر ${l.row_no}: ${FIELD_LABELS[f]} مش من أعمدة ${machine.name}`);
      }
    }
    if (!MACHINE_FIELDS[machine.code].includes('sheet_size')) l.sheet_size = '';
  }
  return {
    header: { technician_id, sheet_date, notes: cleanText(body.notes, 1000), sheet_no: cleanText(body.sheet_no, 20) || null },
    lines,
  };
}

function writeLines(sheetId, lines) {
  const db = getDb();
  db.prepare('DELETE FROM lines WHERE sheet_id = ?').run(sheetId);
  const ins = db.prepare(`INSERT INTO lines (sheet_id, ${LINE_COLS.join(', ')}) VALUES (?, ${LINE_COLS.map(() => '?').join(', ')})`);
  for (const l of lines) {
    // NaN can't be stored; keep the row but as blank so the reviewer re-types it.
    ins.run(sheetId, ...LINE_COLS.map((c) => (Number.isNaN(l[c]) ? null : l[c] === 'invalid' ? null : l[c])));
  }
}

const reject = (lines) => {
  const bad = lines.find((l) => Object.values(l).some((v) => Number.isNaN(v)) || l.work_date === 'invalid');
  if (bad) throw httpError(400, `سطر ${bad.row_no}: فيه رقم أو تاريخ مش مفهوم`);
};

// ---------- list ----------
sheets.get('/sheets', requireUser, (req, res) => {
  const db = getDb();
  const where = [];
  const args = [];
  if (req.query.status) { where.push('s.status = ?'); args.push(req.query.status); }
  if (req.query.machine) { where.push('s.machine_id = ?'); args.push(req.query.machine); }
  if (req.query.technician) { where.push('s.technician_id = ?'); args.push(req.query.technician); }
  if (req.query.from) { where.push('COALESCE(s.sheet_date, date(s.created_at)) >= ?'); args.push(req.query.from); }
  if (req.query.to) { where.push('COALESCE(s.sheet_date, date(s.created_at)) <= ?'); args.push(req.query.to); }
  if (req.query.client) { where.push('EXISTS (SELECT 1 FROM lines l WHERE l.sheet_id = s.id AND l.client_id = ?)'); args.push(req.query.client); }
  const rows = db.prepare(`
    SELECT s.id, s.sheet_no, s.sheet_date, s.status, s.source, s.created_at, s.confirmed_at,
           m.name AS machine_name, m.code AS machine_code, t.name AS technician_name,
           (SELECT COUNT(*) FROM lines l WHERE l.sheet_id = s.id) AS line_count,
           (SELECT GROUP_CONCAT(DISTINCT c.name) FROM lines l JOIN clients c ON c.id = l.client_id WHERE l.sheet_id = s.id) AS clients
    FROM sheets s JOIN machines m ON m.id = s.machine_id LEFT JOIN technicians t ON t.id = s.technician_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE s.status WHEN 'review' THEN 0 ELSE 1 END, s.id DESC
    LIMIT 300`).all(...args);
  res.json({ sheets: rows.map((r) => ({ ...r, status_name: STATUS_NAMES[r.status] })) });
});

sheets.get('/sheets/:id', requireUser, (req, res) => {
  res.json({ sheet: withIssues(loadSheet(req.params.id)) });
});

// ---------- create (manual entry) ----------
sheets.post('/sheets', requirePerm('sheets.create'), (req, res) => {
  const db = getDb();
  const body = req.body || {};
  const machine = db.prepare('SELECT * FROM machines WHERE id = ? AND active = 1').get(body.machine_id);
  if (!machine) throw httpError(400, 'اختار المكنة');
  const { header, lines } = readInput(body, machine);
  reject(lines);
  if (header.sheet_no && db.prepare("SELECT 1 FROM sheets WHERE machine_id = ? AND sheet_no = ? AND status <> 'cancelled'").get(machine.id, header.sheet_no)) {
    throw httpError(409, `ورقة ${machine.name} رقم ${header.sheet_no} اتسجلت قبل كده`);
  }
  const id = db.transaction(() => {
    const r = db.prepare('INSERT INTO sheets (machine_id, sheet_no, technician_id, sheet_date, source, notes, created_by) VALUES (?,?,?,?,?,?,?)')
      .run(machine.id, header.sheet_no, header.technician_id, header.sheet_date, 'manual', header.notes, req.user.id);
    writeLines(r.lastInsertRowid, lines);
    audit(req.user.id, 'create', 'sheet', r.lastInsertRowid, undefined, { header, lines });
    return r.lastInsertRowid;
  })();
  res.status(201).json({ sheet: withIssues(loadSheet(id)) });
});

// ---------- edit while in review ----------
sheets.put('/sheets/:id', requirePerm('sheets.review'), (req, res) => {
  const db = getDb();
  const cur = loadSheet(req.params.id);
  if (cur.status !== 'review') throw httpError(409, 'الورقة دي اتأكدت — مينفعش تتعدل. ألغيها وسجلها تاني.');
  const machine = db.prepare('SELECT * FROM machines WHERE id = ?').get(cur.machine_id);
  const { header, lines } = readInput(req.body || {}, machine);
  reject(lines);
  db.transaction(() => {
    db.prepare("UPDATE sheets SET technician_id=?, sheet_date=?, notes=?, updated_at=datetime('now') WHERE id=?")
      .run(header.technician_id, header.sheet_date, header.notes, cur.id);
    writeLines(cur.id, lines);
    audit(req.user.id, 'update', 'sheet', cur.id,
      { technician_id: cur.technician_id, sheet_date: cur.sheet_date, lines: cur.lines.map(pickLine) },
      { technician_id: header.technician_id, sheet_date: header.sheet_date, lines: lines.map(pickLine) });
  })();
  res.json({ sheet: withIssues(loadSheet(cur.id)) });
});

const pickLine = (l) => Object.fromEntries(LINE_COLS.map((c) => [c, l[c] ?? null]));

// ---------- confirm ----------
// Body: { acks: [issue keys the reviewer looked at] }. Every red must be gone,
// every yellow acknowledged — enforced here, not only in the screen.
sheets.post('/sheets/:id/confirm', requirePerm('sheets.confirm'), (req, res) => {
  const db = getDb();
  const s = withIssues(loadSheet(req.params.id));
  if (s.status !== 'review') throw httpError(409, 'الورقة دي مش مستنية مراجعة');
  const red = s.issues.filter((i) => i.level === 'red');
  if (red.length) throw httpError(409, `فاضل ${red.length} خانة حمرا لازم تتصلح`, { issues: s.issues });
  const acks = new Set([...(Array.isArray(req.body?.acks) ? req.body.acks : []), ...s.acks]);
  const unseen = s.issues.filter((i) => i.level === 'yellow' && !acks.has(i.key));
  if (unseen.length) throw httpError(409, `فاضل ${unseen.length} خانة صفرا لازم تعدي عليها`, { issues: s.issues, unseen: unseen.map((i) => i.key) });
  db.transaction(() => {
    const ack = db.prepare('INSERT OR IGNORE INTO sheet_acks (sheet_id, issue_key, user_id) VALUES (?,?,?)');
    for (const i of s.issues) ack.run(s.id, i.key, req.user.id);
    db.prepare("UPDATE sheets SET status='confirmed', confirmed_by=?, confirmed_at=datetime('now'), updated_at=datetime('now') WHERE id=?")
      .run(req.user.id, s.id);
    audit(req.user.id, 'confirm', 'sheet', s.id, undefined, { warnings_seen: s.issues.map((i) => i.key) });
  })();
  res.json({ sheet: withIssues(loadSheet(s.id)) });
});

// ---------- cancel a confirmed sheet (kept, never deleted) ----------
sheets.post('/sheets/:id/cancel', requirePerm('sheets.cancel'), (req, res) => {
  const db = getDb();
  const s = loadSheet(req.params.id);
  if (s.status !== 'confirmed') throw httpError(409, 'بس الورق المتأكد هو اللي يتلغي');
  const reason = cleanText(req.body?.reason, 300);
  if (!reason) throw httpError(400, 'اكتب سبب الإلغاء');
  const priced = db.prepare(`SELECT 1 FROM lines l WHERE l.sheet_id = ? AND (
      EXISTS (SELECT 1 FROM line_prices p WHERE p.line_id = l.id AND p.status = 'active')
      OR EXISTS (SELECT 1 FROM billing_item_lines bl JOIN billing_items b ON b.id = bl.item_id WHERE bl.line_id = l.id AND b.status = 'active'))`).get(s.id);
  if (priced) throw httpError(409, 'فيه سطور في الورقة دي متسعرة — ألغي التسعير الأول');
  if (db.prepare('SELECT 1 FROM lines WHERE sheet_id = ? AND delivery_id IS NOT NULL').get(s.id)) {
    throw httpError(409, 'فيه شغل من الورقة دي اتسلم — ألغي إذن التسليم الأول');
  }
  db.transaction(() => {
    db.prepare("UPDATE sheets SET status='cancelled', cancelled_by=?, cancelled_at=datetime('now'), cancel_reason=?, updated_at=datetime('now') WHERE id=?")
      .run(req.user.id, reason, s.id);
    audit(req.user.id, 'cancel', 'sheet', s.id, { status: 'confirmed' }, { status: 'cancelled', reason });
  })();
  res.json({ sheet: withIssues(loadSheet(s.id)) });
});

// ---------- discard a sheet that was never confirmed ----------
sheets.delete('/sheets/:id', requirePerm('sheets.create'), (req, res) => {
  const db = getDb();
  const s = loadSheet(req.params.id);
  if (s.status !== 'review') throw httpError(409, 'الورقة دي اتأكدت — مينفعش تتمسح، ممكن تتلغي بس');
  db.transaction(() => {
    audit(req.user.id, 'discard', 'sheet', s.id, { header: { machine_id: s.machine_id, sheet_date: s.sheet_date }, lines: s.lines.map(pickLine) });
    db.prepare('DELETE FROM sheets WHERE id = ?').run(s.id);
  })();
  res.json({ ok: true });
});

// ---------- home counters (money parts only for money.view) ----------
sheets.get('/home', requireUser, (req, res) => {
  const db = getDb();
  const today = todayISO();
  const extra = {};
  if (can(req.user, 'money.view')) {
    extra.unpriced = db.prepare(`SELECT COUNT(*) n FROM lines l JOIN sheets s ON s.id = l.sheet_id WHERE s.status = 'confirmed'
      AND NOT EXISTS (SELECT 1 FROM line_prices p WHERE p.line_id = l.id AND p.status = 'active')
      AND NOT EXISTS (SELECT 1 FROM billing_item_lines bl JOIN billing_items b ON b.id = bl.item_id WHERE bl.line_id = l.id AND b.status = 'active')`).get().n;
    const balances = Object.values(allBalances());
    extra.outstanding = balances.filter((b) => b > 0).reduce((s, b) => s + b, 0);
    extra.cheques_due = db.prepare(`SELECT COUNT(*) n FROM payments WHERE is_cheque = 1 AND cheque_status = 'pending' AND cancelled_at IS NULL AND cheque_due <= ?`)
      .get(todayISO(new Date(Date.now() + 7 * 86400000))).n;
  }
  if (can(req.user, 'settings.manage')) {
    const b = backupStatus();
    const u = updateStatus();
    extra.system = { backup_stale: b.stale, backup_error: !!b.error, backup_copy_error: !!b.copy_error, update_available: u.available && u.installed };
  }
  if (can(req.user, 'deliveries.manage')) {
    extra.undelivered = db.prepare(`SELECT COUNT(*) n FROM lines l JOIN sheets s ON s.id = l.sheet_id WHERE s.status = 'confirmed' AND l.delivery_id IS NULL`).get().n;
  }
  res.json({
    ...extra,
    review: db.prepare("SELECT COUNT(*) n FROM sheets WHERE status = 'review'").get().n,
    confirmed_today: db.prepare("SELECT COUNT(*) n FROM sheets WHERE status = 'confirmed' AND date(confirmed_at, 'localtime') = ?").get(today).n,
    lines_today: db.prepare(`SELECT COUNT(*) n FROM lines l JOIN sheets s ON s.id = l.sheet_id
      WHERE s.status = 'confirmed' AND COALESCE(l.work_date, s.sheet_date) = ?`).get(today).n,
    clients: db.prepare('SELECT COUNT(*) n FROM clients WHERE active = 1').get().n,
    technicians: db.prepare('SELECT COUNT(*) n FROM technicians WHERE active = 1').get().n,
  });
});
