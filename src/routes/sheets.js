// Sheets: manual entry, photos of printed forms, editing while in review, confirming and cancelling.
import { Router } from 'express';
import fs from 'fs';
import { join, resolve, sep } from 'path';
import { getDb, audit } from '../db.js';
import { requirePerm, requireUser } from '../auth.js';
import { can } from '../permissions.js';
import { allBalances } from '../ledger.js';
import { backupStatus } from '../backup.js';
import { updateStatus } from '../update.js';
import { httpError, parseDate, cleanText, todayISO } from '../util.js';
import { normalizeLine, isEmptyLine, validateSheet, summarize, MACHINE_FIELDS, FIELD_LABELS } from '../sheets.js';
import { dataDir, ensureDir } from '../paths.js';
import { formLayout, parseQr } from '../../public/js/forms.js';
import { missingSheets } from './forms.js';
import { NUMBER_FIELDS, NAME_FIELDS } from '../../public/js/ocr.js';

export const sheets = Router();

const STATUS_NAMES = { review: 'مستنية المراجعة', confirmed: 'اتأكدت', cancelled: 'اتلغت' };

const LINE_COLS = ['row_no', 'client_id', 'client_text', 'part_name', 'material_id', 'thickness', 'pieces',
  'ops_per_piece', 'total_written', 'sheets', 'minutes_per_sheet', 'sheet_size', 'pieces_per_sheet',
  'hits_per_piece', 'louvers_per_piece', 'minutes', 'work_date', 'material_source', 'notes', 'ditto_fields'];

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
  for (const l of s.lines) l.ditto_fields = parseList(l.ditto_fields);
  s.acks = db.prepare('SELECT issue_key FROM sheet_acks WHERE sheet_id = ?').all(id).map((a) => a.issue_key);
  s.reads = db.prepare('SELECT row_no, field, kind, value, confidence, candidates FROM cell_reads WHERE sheet_id = ? ORDER BY row_no').all(id)
    .map((r) => ({ ...r, candidates: parseList(r.candidates) }));
  return s;
}

const parseList = (v) => {
  try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
};

function withIssues(s) {
  const issues = s.status === 'review' ? validateSheet(s, s.lines, s.machine_code) : [];
  let photo = null;
  if (s.photo_path) {
    let meta = {};
    try { meta = JSON.parse(s.photo_meta || '{}'); } catch { /* keep {} */ }
    // The file name changes with every new photo, so the URL does too (no stale cache).
    photo = { url: `/api/sheets/${s.id}/photo?f=${encodeURIComponent(s.photo_path.split('/').pop())}`, form_version: meta.form_version || 1, quality: meta.quality, forced: !!meta.forced };
  }
  if (s.status === 'review') logIssues(s.id, issues);
  return { ...s, status_name: STATUS_NAMES[s.status], fields: MACHINE_FIELDS[s.machine_code], issues, counts: summarize(issues), photo };
}

// Problems that say something about how the paper was filled (not about what the
// reviewer still has to type, nor about the reader): kept for the technician profile.
export const MISTAKE_CODES = ['mismatch', 'high', 'future', 'foreign', 'zero', 'neg', 'nan', 'invalid'];
function logIssues(sheetId, issues) {
  const ins = getDb().prepare('INSERT OR IGNORE INTO sheet_issue_log (sheet_id, issue_key, code, field, level) VALUES (?,?,?,?,?)');
  for (const i of issues) {
    const code = i.key.split(':').pop();
    if (MISTAKE_CODES.includes(code)) ins.run(sheetId, i.key, code, i.field, i.level);
  }
}

// Header + lines from a request body, checked against the database.
// paperRows: a photo sheet keeps each line on its printed row (so it stays under its
// strip of the photo); a typed sheet is renumbered 1..n.
function readInput(body, machine, { paperRows = false } = {}) {
  const db = getDb();
  const sheet_date = body.sheet_date ? parseDate(body.sheet_date) : null;
  if (sheet_date === undefined) throw httpError(400, 'تاريخ الورقة غلط');
  const technician_id = body.technician_id ? Number(body.technician_id) : null;
  if (technician_id && !db.prepare('SELECT 1 FROM technicians WHERE id = ?').get(technician_id)) {
    throw httpError(400, 'الفني مش موجود');
  }
  const raw = Array.isArray(body.lines) ? body.lines : [];
  if (raw.length > 60) throw httpError(400, 'السطور كتير قوي في ورقة واحدة');
  let lines;
  if (paperRows) {
    lines = raw.map((r, i) => normalizeLine(r || {}, Number(r?.row_no) || i + 1)).filter((l) => !isEmptyLine(l));
    const seen = new Set();
    for (const l of lines) {
      if (!Number.isInteger(l.row_no) || l.row_no < 1 || l.row_no > 60 || seen.has(l.row_no)) throw httpError(400, 'أرقام السطور متلخبطة');
      seen.add(l.row_no);
    }
    lines.sort((a, b) => a.row_no - b.row_no);
  } else {
    lines = raw.map((r, i) => normalizeLine(r || {}, i + 1)).filter((l) => !isEmptyLine(l));
    lines.forEach((l, i) => { l.row_no = i + 1; });
  }
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
    ins.run(sheetId, ...LINE_COLS.map((c) => (c === 'ditto_fields' ? JSON.stringify(l[c] || [])
      : Number.isNaN(l[c]) ? null : l[c] === 'invalid' ? null : l[c])));
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

// ---------- photos of printed forms ----------
// The browser straightens the photo (public/js/vision.js) and sends the page image
// plus what its QR code says. Body: { qr, image: "data:image/jpeg;base64,...", quality, forced }.
const MAX_PHOTO = 8 * 1024 * 1024;

function readPhoto(body) {
  const qr = parseQr(body?.qr);
  if (!qr) throw httpError(400, 'الكود اللي على الورقة مش مفهوم');
  const layout = formLayout(qr.machine, qr.version);
  if (!layout) throw httpError(400, 'نموذج الورقة دي مش معروف — حدّث البرنامج');
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(body?.image || ''));
  const buf = m ? Buffer.from(m[1], 'base64') : null;
  if (!buf || buf.length < 1000 || buf[0] !== 0xff || buf[1] !== 0xd8) throw httpError(400, 'الصورة مش واصلة سليمة. جرب تاني.');
  if (buf.length > MAX_PHOTO) throw httpError(413, 'الصورة كبيرة قوي');
  const machine = getDb().prepare('SELECT * FROM machines WHERE code = ? AND active = 1').get(qr.machine);
  if (!machine) throw httpError(400, 'المكنة دي مش موجودة في البرنامج');
  const q = body?.quality || {};
  const meta = {
    form_version: qr.version,
    quality: { sharpness: Number(q.sharpness) || 0, brightness: Number(q.brightness) || 0, coverage: Number(q.coverage) || 0 },
    forced: !!body?.forced, // uploaded although the quality check complained
    uploaded_at: new Date().toISOString(),
  };
  return { qr, machine, buf, meta };
}

function savePhoto(machine, sheetNo, buf) {
  const rel = `photos/${machine.code}/${sheetNo}_${Date.now()}.jpg`;
  ensureDir(join(dataDir(), 'photos', machine.code));
  fs.writeFileSync(join(dataDir(), rel), buf);
  return rel;
}

// ---------- the automatic reader's suggestions (public/js/ocr.js runs in the browser) ----------
function cleanReads(raw, machine) {
  if (!Array.isArray(raw)) return [];
  if (raw.length > 500) throw httpError(400, 'القراءات كتير قوي');
  const db = getDb();
  const allowed = new Set(['thickness', 'client_id', 'material_id', 'material_source', ...MACHINE_FIELDS[machine.code]]
    .filter((f) => NUMBER_FIELDS.includes(f) || NAME_FIELDS.includes(f)));
  const exists = {
    client_id: db.prepare('SELECT 1 FROM clients WHERE id = ?'),
    material_id: db.prepare('SELECT 1 FROM materials WHERE id = ?'),
  };
  const valueOk = (field, v) => {
    if (NUMBER_FIELDS.includes(field)) return /^\d+(\.\d+)?$/.test(v);
    if (field === 'material_source') return v === 'client' || v === 'factory';
    return /^\d+$/.test(v) && !!exists[field].get(Number(v));
  };
  const seen = new Set();
  const out = [];
  for (const r of raw) {
    const row = Number(r?.row);
    const field = String(r?.field || '');
    const kind = ['value', 'ditto', 'ink'].includes(r?.kind) ? r.kind : null;
    if (!Number.isInteger(row) || row < 1 || row > 60 || !allowed.has(field) || !kind || seen.has(`${row}:${field}`)) continue;
    seen.add(`${row}:${field}`);
    let value = kind === 'value' && r.value !== null && r.value !== undefined ? cleanText(String(r.value), 40) : null;
    if (value !== null && !valueOk(field, value)) value = null;
    const confidence = Math.max(0, Math.min(1, Number(r.confidence) || 0));
    const candidates = (Array.isArray(r.candidates) ? r.candidates : []).slice(0, 3)
      .map((c) => ({ value: cleanText(String(c?.value ?? ''), 40), score: Math.max(0, Math.min(1, Number(c?.score) || 0)) }))
      .filter((c) => valueOk(field, c.value));
    out.push({ row_no: row, field, kind: kind === 'value' && value === null ? 'ink' : kind, value, confidence: kind === 'value' && value === null ? 0 : confidence, candidates });
  }
  return out.sort((a, b) => a.row_no - b.row_no);
}

// Puts the reads into empty cells (never over what a person typed) and keeps them for
// the yellow "look at this" issues and the accuracy numbers.
function applyReads(sheetId, rawReads, userId) {
  const db = getDb();
  const cur = loadSheet(sheetId);
  const machine = db.prepare('SELECT * FROM machines WHERE id = ?').get(cur.machine_id);
  const reads = cleanReads(rawReads, machine);
  const lines = new Map(cur.lines.map((l) => [l.row_no, { ...pickLine(l), ditto_fields: [...l.ditto_fields] }]));
  const blank = (v) => v === null || v === undefined || v === '';
  for (const r of reads) {
    const l = lines.get(r.row_no) || { row_no: r.row_no, ditto_fields: [] };
    if (r.kind === 'ditto') {
      // Rows are in order, so the row above already has its own reads.
      const above = lines.get(r.row_no - 1)?.[r.field];
      r.value = blank(above) ? null : String(above);
      if (blank(l[r.field]) && r.value !== null) {
        l[r.field] = r.value;
        if (!l.ditto_fields.includes(r.field)) l.ditto_fields.push(r.field);
      }
    } else if (r.kind === 'value' && blank(l[r.field])) {
      l[r.field] = r.value;
    }
    if (r.kind !== 'ink' || lines.has(r.row_no)) lines.set(r.row_no, l);
  }
  const { lines: clean } = readInput({ lines: [...lines.values()] }, machine, { paperRows: true });
  db.transaction(() => {
    // A cell read again gets the new read; cells not in this reading keep theirs.
    const ins = db.prepare(`INSERT INTO cell_reads (sheet_id, row_no, field, kind, value, confidence, candidates) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT (sheet_id, row_no, field) DO UPDATE SET kind = excluded.kind, value = excluded.value,
        confidence = excluded.confidence, candidates = excluded.candidates, read_at = datetime('now')`);
    for (const r of reads) ins.run(sheetId, r.row_no, r.field, r.kind, r.value, r.confidence, JSON.stringify(r.candidates));
    writeLines(sheetId, clean);
    db.prepare("UPDATE sheets SET updated_at = datetime('now') WHERE id = ?").run(sheetId);
    audit(userId, 'read', 'sheet', sheetId, { lines: cur.lines.map(pickLine) },
      { reads: reads.length, sure: reads.filter((r) => r.confidence >= 0.9).length, lines: clean.map(pickLine) });
  })();
}

sheets.post('/sheets/:id/reads', requirePerm('sheets.review'), (req, res) => {
  const cur = loadSheet(req.params.id);
  if (cur.status !== 'review') throw httpError(409, 'الورقة دي مش مستنية مراجعة');
  if (!cur.photo_path) throw httpError(409, 'الورقة دي مالهاش صورة');
  applyReads(cur.id, req.body?.reads, req.user.id);
  res.json({ sheet: withIssues(loadSheet(cur.id)) });
});

export const LESSON = 'درس لتعليم البرنامج';

// تعليم البرنامج: a practice sheet that only teaches the reader — kept, but cancelled, so it
// never counts as work, and its printed number stops being "missing".
sheets.post('/sheets/:id/lesson', requirePerm('sheets.review'), (req, res) => {
  const db = getDb();
  const cur = loadSheet(req.params.id);
  if (cur.status !== 'review') throw httpError(409, 'الورقة دي مش مستنية مراجعة');
  if (!cur.photo_path) throw httpError(409, 'الورقة دي مالهاش صورة');
  if (!cur.lines.length) throw httpError(400, 'اكتب اللي في الورقة الأول، عشان البرنامج يتعلم منه');
  db.transaction(() => {
    db.prepare("UPDATE sheets SET status = 'cancelled', cancelled_by = ?, cancelled_at = datetime('now'), cancel_reason = ?, updated_at = datetime('now') WHERE id = ?")
      .run(req.user.id, LESSON, cur.id);
    db.prepare("UPDATE printed_sheets SET voided_at = datetime('now'), voided_by = ?, void_reason = ? WHERE machine_id = ? AND sheet_no = ? AND voided_at IS NULL")
      .run(req.user.id, LESSON, cur.machine_id, Number(cur.sheet_no) || -1);
    audit(req.user.id, 'lesson', 'sheet', cur.id, { status: 'review' }, { status: 'cancelled', reason: LESSON });
  })();
  res.json({ sheet: withIssues(loadSheet(cur.id)) });
});

sheets.post('/sheets/photo', requirePerm('sheets.create'), (req, res) => {
  const db = getDb();
  const { qr, machine, buf, meta } = readPhoto(req.body);
  const dup = db.prepare("SELECT id FROM sheets WHERE machine_id = ? AND sheet_no = ? AND status <> 'cancelled'").get(machine.id, String(qr.sheetNo));
  if (dup) throw httpError(409, `ورقة ${machine.name} رقم ${qr.sheetNo} اترفعت قبل كده`, { existing_id: dup.id });
  const photo = savePhoto(machine, qr.sheetNo, buf);
  const id = db.transaction(() => {
    const r = db.prepare("INSERT INTO sheets (machine_id, sheet_no, source, photo_path, photo_meta, created_by) VALUES (?,?,'photo',?,?,?)")
      .run(machine.id, String(qr.sheetNo), photo, JSON.stringify(meta), req.user.id);
    audit(req.user.id, 'create', 'sheet', r.lastInsertRowid, undefined, { source: 'photo', machine: machine.code, sheet_no: qr.sheetNo, photo, quality: meta.quality, forced: meta.forced });
    return r.lastInsertRowid;
  })();
  if (Array.isArray(req.body?.reads) && req.body.reads.length) {
    // Reads are only suggestions: if they can't be used, the photo still counts.
    try { applyReads(id, req.body.reads, req.user.id); } catch (err) { console.error('reads not applied:', err.message); }
  }
  res.status(201).json({ sheet: withIssues(loadSheet(id)) });
});

// صوّر تاني: a new photo of the same paper while the sheet is still in review.
sheets.post('/sheets/:id/photo', requirePerm('sheets.review'), (req, res) => {
  const db = getDb();
  const cur = loadSheet(req.params.id);
  if (cur.status !== 'review') throw httpError(409, 'الورقة دي اتأكدت — مينفعش تتغير صورتها');
  const { qr, machine, buf, meta } = readPhoto(req.body);
  if (machine.id !== cur.machine_id || (cur.sheet_no && cur.sheet_no !== String(qr.sheetNo))) {
    throw httpError(409, `دي صورة ورقة ${machine.name} رقم ${qr.sheetNo}، مش الورقة دي`);
  }
  if (!cur.sheet_no && db.prepare("SELECT 1 FROM sheets WHERE machine_id = ? AND sheet_no = ? AND status <> 'cancelled' AND id <> ?").get(machine.id, String(qr.sheetNo), cur.id)) {
    throw httpError(409, `ورقة ${machine.name} رقم ${qr.sheetNo} اترفعت قبل كده`);
  }
  const photo = savePhoto(machine, qr.sheetNo, buf);
  db.transaction(() => {
    // The old file stays on disk: nothing is ever silently thrown away.
    db.prepare("UPDATE sheets SET photo_path = ?, photo_meta = ?, sheet_no = ?, source = 'photo', updated_at = datetime('now') WHERE id = ?")
      .run(photo, JSON.stringify(meta), String(qr.sheetNo), cur.id);
    audit(req.user.id, 'photo', 'sheet', cur.id, { photo: cur.photo_path }, { photo, quality: meta.quality, forced: meta.forced });
  })();
  res.json({ sheet: withIssues(loadSheet(cur.id)) });
});

sheets.get('/sheets/:id/photo', requireUser, (req, res) => {
  const s = getDb().prepare('SELECT photo_path FROM sheets WHERE id = ?').get(req.params.id);
  if (!s?.photo_path) throw httpError(404, 'مفيش صورة للورقة دي');
  const root = resolve(dataDir(), 'photos');
  const file = resolve(dataDir(), s.photo_path);
  if (!file.startsWith(root + sep) || !fs.existsSync(file)) throw httpError(404, 'ملف الصورة مش موجود');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.sendFile(file);
});

// ---------- edit while in review ----------
sheets.put('/sheets/:id', requirePerm('sheets.review'), (req, res) => {
  const db = getDb();
  const cur = loadSheet(req.params.id);
  if (cur.status !== 'review') throw httpError(409, 'الورقة دي اتأكدت — مينفعش تتعدل. ألغيها وسجلها تاني.');
  const machine = db.prepare('SELECT * FROM machines WHERE id = ?').get(cur.machine_id);
  const { header, lines } = readInput(req.body || {}, machine, { paperRows: cur.source === 'photo' });
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
    finalizeReads(s);
    audit(req.user.id, 'confirm', 'sheet', s.id, undefined, { warnings_seen: s.issues.map((i) => i.key) });
  })();
  res.json({ sheet: withIssues(loadSheet(s.id)) });
});

// What each read turned out to be: the reader's accuracy over time.
function finalizeReads(s) {
  const up = getDb().prepare("UPDATE cell_reads SET final_value = ?, correct = ?, finalized_at = datetime('now') WHERE sheet_id = ? AND row_no = ? AND field = ?");
  for (const r of s.reads) {
    const l = s.lines.find((x) => x.row_no === r.row_no);
    const v = l ? l[r.field] : null;
    const final = v === null || v === undefined || v === '' ? null : String(v);
    const same = r.value !== null && final !== null && (NUMBER_FIELDS.includes(r.field) ? Number(r.value) === Number(final) : r.value === final);
    up.run(final, r.kind === 'ink' ? null : same ? 1 : 0, s.id, r.row_no, r.field);
  }
}

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
  if (can(req.user, 'sheets.create')) extra.missing_printed = missingSheets().length;
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
