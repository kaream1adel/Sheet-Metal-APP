// أوراق التشغيل: one technician's daily paper for one machine, with the paper's own columns.
//
//   draft (status review + draft=1) → review (draft=0) → approved (locked) → cancelled
//
// The review gate is computed from the lines every time (public/js/modules/ops-paper.js
// lineIssues, the same code the browser uses): red must be fixed, yellow must be visited.
// A visit (ack) is stored in sheet_issues under the issue's message, so a changed value brings
// the yellow back. An approved sheet is never edited: «إلغاء الورقة» (with a reason, only if
// nothing of it is posted) or «تصحيح» (a new version in review, the old one cancelled).
// Operations never posts to the ledger; the month lock still applies to its dates.
import { getDb, audit } from '../db.js';
import { httpError, cleanText, todayISO, isRealDate } from '../util.js';
import { assertMonthOpen, nextSerial } from '../ledger.js';
import * as P from '../../public/js/modules/ops-paper.js';

export const LINE_COLS = ['row_no', 'client_id', 'client_text', 'work_order_id', 'part_name', 'material_id', 'material_text',
  'thickness', 'pieces', 'per_piece', 'total_written', 'sheets', 'minutes_per_sheet', 'start_time', 'end_time', 'single_piece',
  'louvers_per_piece', 'hits_per_piece', 'sheet_size', 'pieces_per_sheet', 'material_source', 'length_cm', 'width_cm',
  'work_date', 'ditto_fields', 'read_json', 'notes'];
const TEXT_MAX = { client_text: 80, part_name: 120, material_text: 60, start_time: 20, end_time: 20, sheet_size: 40, notes: 300 };
const MAX_LINES = 200;

const parse = (s, d) => { if (s === null || s === undefined) return d; try { return JSON.parse(s); } catch { return d; } };
const nowSql = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// ---------- lists the paper is matched against ----------
export function materialsList() {
  return getDb().prepare('SELECT id, name, aliases, density, grp FROM materials WHERE active = 1 ORDER BY sort, id').all()
    .map((m) => ({ ...m, aliases: parse(m.aliases, []) }));
}
function clientsList() {
  return getDb().prepare("SELECT id, name, aliases FROM parties WHERE kind = 'client' AND active = 1").all()
    .map((c) => ({ id: c.id, name: c.name, aliases: parse(c.aliases, []) }));
}

// The client whose name or alias folds to exactly this text.
export function matchClientExact(text, list = clientsList()) {
  const f = P.foldName(text);
  if (!f) return null;
  return list.find((c) => [c.name, ...c.aliases].some((n) => P.foldName(n) === f))?.id ?? null;
}

function lev(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m || !n) return m + n;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

// Clients a written name probably means: same fold, one inside the other, or a typo or two.
export function clientCandidates(text, limit = 5) {
  const f = P.foldName(text);
  if (!f) return [];
  const out = [];
  for (const c of clientsList()) {
    let best = Infinity;
    for (const n of [c.name, ...c.aliases]) {
      const g = P.foldName(n);
      if (!g) continue;
      let score;
      if (g === f) score = 0;
      else if (Math.min(g.length, f.length) >= 3 && (g.includes(f) || f.includes(g))) score = 1;
      else {
        const d = lev(g, f);
        const allowed = Math.max(1, Math.floor(Math.max(g.length, f.length) / 4));
        score = d <= allowed ? 1 + d : Infinity;
        // one word in common, or nearly («الزيتونه» ↔ «مصنع الزيتون التجريبي»)
        if (score === Infinity) {
          const fw = f.split(' ').filter((w) => w.length >= 3);
          const gw = g.split(' ').filter((w) => w.length >= 3);
          if (fw.some((a) => gw.includes(a))) score = 6;
          else if (fw.some((a) => gw.some((b) => lev(a, b) <= 1 || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)))))) score = 7;
        }
      }
      best = Math.min(best, score);
    }
    if (best < Infinity) out.push({ id: c.id, name: c.name, score: best });
  }
  return out.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name, 'ar')).slice(0, limit).map(({ id, name }) => ({ id, name }));
}

// ---------- validation ----------
export function assertDate(v, what = 'التاريخ') {
  if (!isRealDate(v)) throw httpError(400, `${what} غلط — لازم يكون تاريخ حقيقي`, { field: 'sheet_date' });
  return P.toAscii(v).trim();
}

const SOURCE_WORDS = { client: 'client', factory: 'factory', 'خامة العميل': 'client', 'عميل': 'client', 'العميل': 'client',
  'خامة المصنع': 'factory', 'مصنع': 'factory', 'المصنع': 'factory', 'من عندنا': 'factory' };

// The lines as typed (or read): numbers parsed (Arabic digits, "١٫٥م"), empty rows dropped,
// "~" resolved, the client and material matched, the minutes worked out. Throws 400 (with
// field and row) on a value that is not a number; a missing value is left for the gate (red).
export function normalizeLines(machine, sheetDate, input, { existing = new Map(), trusted = false } = {}) {
  if (input === undefined || input === null) input = [];
  if (!Array.isArray(input)) throw httpError(400, 'السطور لازم تكون قايمة');
  if (input.length > MAX_LINES) throw httpError(400, `الورقة فيها سطور كتير قوي (الحد ${MAX_LINES})`);
  const db = getDb();
  const mats = materialsList();
  const clients = clientsList();
  const clientIds = new Set(clients.map((c) => c.id));
  const matIds = new Set(mats.map((m) => m.id));
  let lines = input.map((raw, idx) => {
    if (!raw || typeof raw !== 'object') throw httpError(400, `السطر ${idx + 1} مش مفهوم`);
    const l = { id: Number(raw.id) || null };
    // A ditto mark sent as the value itself ("~") is the same as listing the key in ditto_fields.
    const marked = P.DITTO_FIELDS.filter((k) => P.isDitto(raw[k]));
    if (marked.length) raw = { ...raw, ...Object.fromEntries(marked.map((k) => [k, null])) };
    for (const [k, max] of Object.entries(TEXT_MAX)) l[k] = cleanText(raw[k], max);
    // Western digits in what the app shows (the paper may use Arabic ones).
    for (const k of ['material_text', 'start_time', 'end_time', 'sheet_size']) l[k] = P.toAscii(l[k]);
    for (const k of P.NUMBER_FIELDS) {
      const v = P.parseNum(raw[k] === '' ? null : raw[k]);
      if (Number.isNaN(v) || (v !== null && v < 0)) {
        throw httpError(400, `السطر ${idx + 1}: ${P.fieldLabel(machine, k)} رقم غلط`, { field: k, row: idx });
      }
      if (v === 0 && ['thickness', 'length_cm', 'width_cm'].includes(k)) {
        throw httpError(400, `السطر ${idx + 1}: ${P.fieldLabel(machine, k)} لازم يكون أكبر من صفر`, { field: k, row: idx });
      }
      l[k] = v;
    }
    const cid = Number(raw.client_id) || null;
    l.client_id = cid && clientIds.has(cid) ? cid : null;
    const mid = Number(raw.material_id) || null;
    l.material_id = mid && matIds.has(mid) ? mid : null;
    const wo = Number(raw.work_order_id) || null;
    if (wo && !db.prepare('SELECT 1 FROM work_orders WHERE id = ?').get(wo)) {
      throw httpError(400, `السطر ${idx + 1}: أمر الشغل مش موجود`, { field: 'work_order_id', row: idx });
    }
    l.work_order_id = wo;
    const src = raw.material_source == null || raw.material_source === '' ? null : SOURCE_WORDS[String(raw.material_source).trim()];
    if (src === undefined) throw httpError(400, `السطر ${idx + 1}: المراجعة لازم تكون خامة العميل أو خامة المصنع`, { field: 'material_source', row: idx });
    l.material_source = src;
    l.work_date = P.parseWorkDate(raw.work_date, sheetDate).value;
    l.single_piece = raw.single_piece ? 1 : 0;
    l.ditto_fields = [...new Set([...(Array.isArray(raw.ditto_fields) ? raw.ditto_fields.map(String) : []), ...marked])].filter((k) => P.DITTO_FIELDS.includes(k));
    // What the reader saw is the server's own record: a browser can't send or change it.
    l.read_json = trusted ? (raw.read_json ?? null) : (l.id && existing.has(l.id) ? parse(existing.get(l.id).read_json, null) : null);
    l.seen = Array.isArray(raw.seen) ? raw.seen.map((s) => String(s).slice(0, 400)).slice(0, 40) : [];
    return l;
  });
  lines = lines.filter((l) => !(P.isEmptyLine(l) && !l.ditto_fields.length));
  P.resolveDitto(lines);
  lines.forEach((l, i) => {
    l.row_no = i + 1;
    // The written client name is the truth: a text that matches a client exactly wins over a stale id.
    if (l.client_text) {
      const exact = matchClientExact(l.client_text, clients);
      if (exact) l.client_id = exact;
    }
    if (l.client_id && !l.client_text) l.client_text = clients.find((c) => c.id === l.client_id)?.name || '';
    if (l.material_text) {
      const m = P.parseMaterialText(l.material_text, mats);
      if (m.material_id) l.material_id = m.material_id;
      if (!isNum(l.thickness) && m.thickness) l.thickness = m.thickness;
    }
    if (machine === 'laser' || machine === 'punch') {
      if (l.start_time || l.end_time) l.minutes_per_sheet = P.parseMinutes(l.start_time, l.end_time, l.sheets).minutes_per_sheet;
    } else {
      l.minutes_per_sheet = null;
    }
  });
  return lines;
}

function assertDatesOpen(sheetDate, lines) {
  assertMonthOpen(sheetDate);
  for (const m of new Set(lines.map((l) => l.work_date).filter((d) => d && isRealDate(d)).map((d) => d.slice(0, 7)))) {
    assertMonthOpen(`${m}-01`);
  }
}

function technicianOk(id) {
  if (id === null || id === undefined || id === '') return null;
  const t = getDb().prepare('SELECT id FROM technicians WHERE id = ?').get(Number(id));
  if (!t) throw httpError(400, 'الفني مش موجود', { field: 'technician_id' });
  return t.id;
}

// ---------- writing ----------
function lineValues(l) {
  return LINE_COLS.map((k) => {
    if (k === 'ditto_fields') return JSON.stringify(l.ditto_fields || []);
    if (k === 'read_json') return l.read_json ? JSON.stringify(l.read_json) : null;
    if (k === 'single_piece') return l.single_piece ? 1 : 0;
    const v = l[k];
    return v === undefined ? null : v;
  });
}
const TEXT_NOT_NULL = new Set(['client_text', 'part_name', 'material_text', 'start_time', 'end_time', 'sheet_size', 'notes']);

function writeLines(sheetId, lines) {
  const db = getDb();
  const cur = new Set(db.prepare('SELECT id FROM op_lines WHERE sheet_id = ?').all(sheetId).map((r) => r.id));
  db.prepare('UPDATE op_lines SET row_no = -id WHERE sheet_id = ?').run(sheetId); // out of the way of UNIQUE(sheet_id,row_no)
  const ins = db.prepare(`INSERT INTO op_lines (sheet_id, ${LINE_COLS.join(', ')}) VALUES (?, ${LINE_COLS.map(() => '?').join(', ')})`);
  const upd = db.prepare(`UPDATE op_lines SET ${LINE_COLS.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND sheet_id = ?`);
  const kept = new Set();
  for (const l of lines) {
    const vals = lineValues(l).map((v, i) => (v === null && TEXT_NOT_NULL.has(LINE_COLS[i]) ? '' : v));
    if (l.id && cur.has(l.id) && !kept.has(l.id)) {
      upd.run(...vals, l.id, sheetId);
      kept.add(l.id);
    } else {
      l.id = Number(ins.run(sheetId, ...vals).lastInsertRowid);
    }
  }
  const gone = [...cur].filter((id) => !kept.has(id));
  for (const id of gone) {
    db.prepare('DELETE FROM sheet_issues WHERE line_id = ?').run(id);
    db.prepare('DELETE FROM op_lines WHERE id = ?').run(id);
  }
}

// Yellow issues the person visited while typing (line.seen = issue keys) are acknowledged.
function ackSeen(sheetId, lines, userId) {
  if (!lines.some((l) => l.seen?.length)) return;
  const sheet = loadSheet(sheetId);
  const byRow = new Map(sheet.lines.map((l) => [l.row_no, l]));
  const keys = [];
  for (const l of lines) {
    const saved = byRow.get(l.row_no);
    if (!saved) continue;
    for (const s of l.seen) keys.push(`${saved.id}|${s}`);
  }
  ackIssues(sheetId, keys, userId, { quiet: true });
}

export function createSheet({ machine, technician_id = null, sheet_date, notes = '', lines = [], draft = true, source = 'manual',
  photo_path = null, photo_job_id = null, userId, trusted = false }) {
  if (!P.MACHINES.includes(machine)) throw httpError(400, 'اختار المكنة', { field: 'machine' });
  const date = assertDate(sheet_date, 'تاريخ الورقة');
  const techId = technicianOk(technician_id);
  const norm = normalizeLines(machine, date, lines, { trusted });
  const db = getDb();
  return db.transaction(() => {
    assertDatesOpen(date, norm);
    const serial = nextSerial('تش');
    const r = db.prepare(`INSERT INTO op_sheets (serial, base_serial, machine, technician_id, sheet_date, source, photo_path, photo_job_id,
        status, draft, submitted_at, notes, created_by) VALUES (?,?,?,?,?,?,?,?, 'review', ?, ?, ?, ?)`)
      .run(serial, serial, machine, techId, date, source, photo_path, photo_job_id, draft ? 1 : 0, draft ? null : nowSql(), cleanText(notes, 500), userId ?? null);
    const id = Number(r.lastInsertRowid);
    writeLines(id, norm);
    audit(userId, 'create', 'op_sheet', id, undefined, { serial, machine, sheet_date: date, technician_id: techId, source, draft: !!draft, lines: norm.length });
    ackSeen(id, norm, userId);
    return id;
  })();
}

export function getSheetRow(id) {
  const s = getDb().prepare('SELECT * FROM op_sheets WHERE id = ?').get(Number(id));
  if (!s) throw httpError(404, 'الورقة دي مش موجودة');
  return s;
}

const editable = (s) => {
  if (s.status === 'approved') throw httpError(409, 'الورقة دي معتمدة ومقفولة — لو فيها غلط اعمل «تصحيح» أو «إلغاء الورقة»');
  if (s.status === 'cancelled') throw httpError(409, 'الورقة دي ملغية');
};

// body: { technician_id?, sheet_date?, notes?, machine? (only while it has no lines), lines?, submit? }
export function updateSheet(id, body, userId) {
  const db = getDb();
  const s = getSheetRow(id);
  editable(s);
  const b = body || {};
  const date = b.sheet_date !== undefined ? assertDate(b.sheet_date, 'تاريخ الورقة') : s.sheet_date;
  const techId = b.technician_id !== undefined ? technicianOk(b.technician_id) : s.technician_id;
  let machine = s.machine;
  if (b.machine !== undefined && b.machine !== s.machine) {
    if (!P.MACHINES.includes(b.machine)) throw httpError(400, 'المكنة غلط', { field: 'machine' });
    machine = b.machine;
  }
  const existing = new Map(db.prepare('SELECT * FROM op_lines WHERE sheet_id = ?').all(s.id).map((l) => [l.id, l]));
  const norm = b.lines !== undefined ? normalizeLines(machine, date, b.lines, { existing }) : null;
  if (machine !== s.machine && (norm ? norm.length : existing.size)) {
    throw httpError(409, 'مينفعش تغير المكنة بعد ما الورقة فيها سطور — الأعمدة مختلفة');
  }
  db.transaction(() => {
    assertMonthOpen(s.sheet_date);
    assertDatesOpen(date, norm || [...existing.values()]);
    const submit = !!b.submit && s.draft;
    db.prepare(`UPDATE op_sheets SET machine = ?, technician_id = ?, sheet_date = ?, notes = ?, updated_at = datetime('now'),
        draft = ?, submitted_at = COALESCE(submitted_at, ?) WHERE id = ?`)
      .run(machine, techId, date, b.notes !== undefined ? cleanText(b.notes, 500) : s.notes, submit ? 0 : s.draft, submit ? nowSql() : null, s.id);
    if (norm) writeLines(s.id, norm);
    audit(userId, submit ? 'submit' : 'update', 'op_sheet', s.id,
      { machine: s.machine, sheet_date: s.sheet_date, technician_id: s.technician_id, lines: existing.size },
      { machine, sheet_date: date, technician_id: techId, lines: norm ? norm.length : existing.size });
    if (norm) ackSeen(s.id, norm, userId);
  })();
  return s.id;
}

export function submitSheet(id, userId) {
  const db = getDb();
  const s = getSheetRow(id);
  editable(s);
  if (!s.draft) return s.id;
  db.transaction(() => {
    db.prepare("UPDATE op_sheets SET draft = 0, submitted_at = datetime('now') WHERE id = ?").run(s.id);
    audit(userId, 'submit', 'op_sheet', s.id, { draft: 1 }, { draft: 0 });
  })();
  return s.id;
}

// ---------- reading ----------
function ordersFor(lines) {
  const ids = [...new Set(lines.map((l) => l.work_order_id).filter(Boolean))];
  if (!ids.length) return {};
  const rows = getDb().prepare(`SELECT id, serial, client_id, status FROM work_orders WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  return Object.fromEntries(rows.map((o) => [o.id, o]));
}

// Issues of a sheet with their ack state. Sheet-level issues have line_id null.
export function sheetIssues(sheet, lines) {
  const db = getDb();
  const acks = new Set(db.prepare('SELECT line_id, field, code, message FROM sheet_issues WHERE sheet_id = ? AND acked_at IS NOT NULL').all(sheet.id)
    .map((a) => `${a.line_id ?? ''}|${a.field}|${a.code}|${a.message}`));
  const ctx = { sheetDate: sheet.sheet_date, today: todayISO(), orders: ordersFor(lines) };
  const out = [];
  if (!lines.length) out.push({ line_id: null, row_no: null, field: '', level: 'red', code: 'no_lines', message: 'الورقة مفيهاش سطور — اكتب سطور الفني' });
  if (!sheet.technician_id) out.push({ line_id: null, row_no: null, field: 'technician_id', level: 'yellow', code: 'no_technician', message: 'الفني مش متحدد' });
  for (const l of lines) {
    for (const i of P.lineIssues(sheet.machine, l, ctx)) out.push({ line_id: l.id, row_no: l.row_no, ...i });
  }
  for (const i of out) {
    i.key = `${i.line_id ?? ''}|${P.issueKey(i)}`;
    i.acked = i.level === 'yellow' && acks.has(i.key);
  }
  return out;
}
export const issueCounts = (issues) => ({
  red: issues.filter((i) => i.level === 'red').length,
  yellow: issues.filter((i) => i.level === 'yellow').length,
  unseen: issues.filter((i) => i.level === 'yellow' && !i.acked).length,
});

function readLines(sheetId) {
  return getDb().prepare(`SELECT l.*, c.name AS client_name, m.name AS material_name, w.serial AS work_order_serial
    FROM op_lines l LEFT JOIN parties c ON c.id = l.client_id LEFT JOIN materials m ON m.id = l.material_id
    LEFT JOIN work_orders w ON w.id = l.work_order_id
    WHERE l.sheet_id = ? AND l.row_no > 0 ORDER BY l.row_no`).all(sheetId)
    .map((l) => ({ ...l, ditto_fields: parse(l.ditto_fields, []), read_json: parse(l.read_json, null), single_piece: !!l.single_piece }));
}

function decorate(machine, l) {
  if (machine === 'laser' || machine === 'punch') {
    const m = P.parseMinutes(l.start_time, l.end_time, l.sheets);
    l.minutes_from = m.from;
    l.minutes_error = m.error;
  }
  l.computed_ops = P.computedTotal(machine, l);
  l.sections = P.lineSections(machine, l);
  return l;
}

export const viewStatus = (s) => (s.status === 'review' && s.draft ? 'draft' : s.status);

export function loadSheet(id) {
  const db = getDb();
  const s = db.prepare(`SELECT s.*, t.name AS technician_name, cu.display_name AS created_by_name,
      au.display_name AS approved_by_name, xu.display_name AS cancelled_by_name
    FROM op_sheets s LEFT JOIN technicians t ON t.id = s.technician_id LEFT JOIN users cu ON cu.id = s.created_by
    LEFT JOIN users au ON au.id = s.approved_by LEFT JOIN users xu ON xu.id = s.cancelled_by WHERE s.id = ?`).get(Number(id));
  if (!s) throw httpError(404, 'الورقة دي مش موجودة');
  const lines = readLines(s.id).map((l) => decorate(s.machine, l));
  const issues = s.status === 'review' ? sheetIssues(s, lines) : [];
  const posted = db.prepare(`SELECT COUNT(*) n FROM price_items WHERE status = 'posted'
    AND (sheet_id = ? OR op_line_id IN (SELECT id FROM op_lines WHERE sheet_id = ?))`).get(s.id, s.id).n;
  const versions = db.prepare('SELECT id, serial, version, status FROM op_sheets WHERE base_serial = ? ORDER BY version').all(s.base_serial || s.serial);
  const job = s.photo_job_id ? db.prepare('SELECT id, status, error FROM photo_jobs WHERE id = ?').get(s.photo_job_id) : null;
  return {
    id: s.id, serial: s.serial, machine: s.machine, machine_name: P.MACHINE_NAMES[s.machine], technician_id: s.technician_id,
    technician_name: s.technician_name, sheet_date: s.sheet_date, source: s.source, status: s.status, view_status: viewStatus(s),
    status_name: P.STATUS_NAMES[viewStatus(s)], draft: !!s.draft, priced_status: s.priced_status, priced_name: P.PRICED_NAMES[s.priced_status],
    approved_by_name: s.approved_by_name, approved_at: s.approved_at, cancel_reason: s.cancel_reason, cancelled_by_name: s.cancelled_by_name,
    cancelled_at: s.cancelled_at, notes: s.notes, created_by: s.created_by, created_by_name: s.created_by_name, created_at: s.created_at,
    submitted_at: s.submitted_at, updated_at: s.updated_at, version: s.version, supersedes_id: s.supersedes_id, superseded_by: s.superseded_by,
    has_photo: !!s.photo_path, photo_url: s.photo_path ? `/api/operations/sheets/${s.id}/photo` : null,
    photo_job: job, posted_lines: posted, versions,
    lines, issues, counts: issueCounts(issues),
  };
}

// ---------- the gate ----------
// keys: `${line_id}|${field}|${code}|${message}` as loadSheet returns them (issue.key).
export function ackIssues(sheetId, keys, userId, { quiet = false } = {}) {
  const db = getDb();
  const s = getSheetRow(sheetId);
  if (s.status !== 'review') throw httpError(409, 'الورقة دي مش في المراجعة');
  const current = new Map(sheetIssues(s, readLines(s.id)).filter((i) => i.level === 'yellow').map((i) => [i.key, i]));
  let n = 0;
  db.transaction(() => {
    for (const k of new Set(keys || [])) {
      const i = current.get(k);
      if (!i) { if (!quiet) throw httpError(409, 'الخانة دي اتغيرت — بص عليها تاني'); continue; }
      if (i.acked) continue;
      db.prepare(`INSERT INTO sheet_issues (sheet_id, line_id, field, level, code, message, acked_by, acked_at)
        VALUES (?, ?, ?, 'yellow', ?, ?, ?, datetime('now'))`).run(s.id, i.line_id, i.field, i.code, i.message, userId ?? null);
      n += 1;
    }
    if (n && !quiet) audit(userId, 'ack', 'op_sheet', s.id, undefined, { acked: n });
  })();
  return n;
}

// اعتماد: the server-side gate, then the sheet is locked.
export function approveSheet(id, userId) {
  const db = getDb();
  return db.transaction(() => {
    const s = getSheetRow(id);
    if (s.status === 'approved') throw httpError(409, 'الورقة دي معتمدة بالفعل');
    if (s.status !== 'review') throw httpError(409, 'الورقة دي ملغية');
    const lines = readLines(s.id);
    assertDatesOpen(s.sheet_date, lines);
    const issues = sheetIssues(s, lines);
    const c = issueCounts(issues);
    if (c.red) throw httpError(409, `لسه فيه ${c.red} ${c.red === 1 ? 'غلطة' : 'غلطات'} بالأحمر لازم تتصلح قبل الاعتماد`, { issues, counts: c });
    if (c.unseen) throw httpError(409, `لسه فيه ${c.unseen} ${c.unseen === 1 ? 'خانة صفرا' : 'خانات صفرا'} محتاجة تتشاف قبل الاعتماد`, { issues, counts: c });
    db.prepare("UPDATE op_sheets SET status = 'approved', draft = 0, approved_by = ?, approved_at = datetime('now'), submitted_at = COALESCE(submitted_at, datetime('now')) WHERE id = ?")
      .run(userId ?? null, s.id);
    recordAiTrack(s.id, lines);
    // An open work order that got work on an approved sheet is now in progress.
    const orders = [...new Set(lines.map((l) => l.work_order_id).filter(Boolean))];
    for (const o of orders) {
      const r = db.prepare("UPDATE work_orders SET status = 'in_progress', updated_at = datetime('now') WHERE id = ? AND status = 'open'").run(o);
      if (r.changes) audit(userId, 'status', 'work_order', o, { status: 'open' }, { status: 'in_progress', by: 'approval' });
    }
    audit(userId, 'approve', 'op_sheet', s.id, { status: 'review' }, { status: 'approved', lines: lines.length, acked: c.yellow });
    return s.id;
  })();
}

// The reader's track record: was what it read the value that got approved?
function recordAiTrack(sheetId, lines) {
  const ins = getDb().prepare('INSERT INTO ai_reads (sheet_id, line_id, field, confidence, correct) VALUES (?,?,?,?,?)');
  for (const l of lines) {
    const fields = l.read_json?.fields;
    if (!fields) continue;
    for (const [k, r] of Object.entries(fields)) {
      if (!r || typeof r.c !== 'number') continue;
      const cur = k === 'client_text' ? l.client_id : k === 'material_text' ? l.material_id : l[k];
      const same = (cur === null || cur === undefined || cur === '' ? null : String(cur)) === (r.v === null || r.v === undefined || r.v === '' ? null : String(r.v));
      ins.run(sheetId, l.id, k, r.c, same ? 1 : 0);
    }
  }
}

function postedCount(sheetId) {
  return getDb().prepare(`SELECT COUNT(*) n FROM price_items WHERE status = 'posted'
    AND (sheet_id = ? OR op_line_id IN (SELECT id FROM op_lines WHERE sheet_id = ?))`).get(sheetId, sheetId).n;
}
// Suggested (unposted) price items of a sheet that is going away are cancelled with it.
function dropSuggested(sheetId) {
  getDb().prepare(`UPDATE price_items SET status = 'cancelled' WHERE status = 'suggested'
    AND (sheet_id = ? OR op_line_id IN (SELECT id FROM op_lines WHERE sheet_id = ?))`).run(sheetId, sheetId);
}
const POSTED_MSG = (n) => `الورقة دي فيها ${n} ${n === 1 ? 'بند اتسعر واترحّل' : 'بنود اتسعرت واترحّلت'} على العميل — لازم يتلغى الترحيل الأول من التسعير («تصحيح سعر»)`;

// إلغاء الورقة: with a reason; refused once any of its lines is posted.
export function cancelSheet(id, reason, userId) {
  const r = cleanText(reason, 300);
  if (!r) throw httpError(400, 'اكتب سبب الإلغاء', { field: 'reason' });
  const db = getDb();
  return db.transaction(() => {
    const s = getSheetRow(id);
    if (s.status === 'cancelled') throw httpError(409, 'الورقة دي ملغية بالفعل');
    assertMonthOpen(s.sheet_date);
    const n = postedCount(s.id);
    if (n) throw httpError(409, POSTED_MSG(n));
    dropSuggested(s.id);
    db.prepare("UPDATE op_sheets SET status = 'cancelled', cancel_reason = ?, cancelled_by = ?, cancelled_at = datetime('now') WHERE id = ?")
      .run(r, userId ?? null, s.id);
    audit(userId, 'cancel', 'op_sheet', s.id, { status: viewStatus(s) }, { status: 'cancelled', reason: r });
    return s.id;
  })();
}

// تصحيح: an approved sheet gets a new version (a copy, in review); the old one is cancelled
// and points to it. Audited with the reason. Not once anything of it is posted.
export function correctSheet(id, reason, userId) {
  const r = cleanText(reason, 300);
  if (!r) throw httpError(400, 'اكتب سبب التصحيح', { field: 'reason' });
  const db = getDb();
  return db.transaction(() => {
    const s = getSheetRow(id);
    if (s.status !== 'approved') throw httpError(409, 'التصحيح للورق المعتمد بس — الورقة اللي في المراجعة بتتعدل على طول');
    assertMonthOpen(s.sheet_date);
    const n = postedCount(s.id);
    if (n) throw httpError(409, POSTED_MSG(n));
    const base = s.base_serial || s.serial;
    const version = (db.prepare('SELECT MAX(version) v FROM op_sheets WHERE base_serial = ?').get(base).v || s.version) + 1;
    const serial = `${base}-${version}`;
    const nid = Number(db.prepare(`INSERT INTO op_sheets (serial, base_serial, version, supersedes_id, machine, technician_id, sheet_date,
        source, photo_path, photo_job_id, status, draft, submitted_at, notes, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?, 'review', 0, datetime('now'), ?, ?)`)
      .run(serial, base, version, s.id, s.machine, s.technician_id, s.sheet_date, s.source, s.photo_path, s.photo_job_id, s.notes, userId ?? null).lastInsertRowid);
    const cols = LINE_COLS.filter((k) => k !== 'read_json');
    db.prepare(`INSERT INTO op_lines (sheet_id, ${cols.join(', ')}) SELECT ?, ${cols.join(', ')} FROM op_lines WHERE sheet_id = ? AND status = 'active' ORDER BY row_no`)
      .run(nid, s.id);
    dropSuggested(s.id);
    db.prepare("UPDATE op_sheets SET status = 'cancelled', superseded_by = ?, cancel_reason = ?, cancelled_by = ?, cancelled_at = datetime('now') WHERE id = ?")
      .run(nid, `اتصححت بالنسخة ${serial}: ${r}`, userId ?? null, s.id);
    audit(userId, 'correct', 'op_sheet', s.id, { status: 'approved' }, { status: 'cancelled', new_version: nid, serial, reason: r });
    audit(userId, 'create', 'op_sheet', nid, undefined, { serial, version, supersedes_id: s.id, reason: r });
    return nid;
  })();
}

// ---------- lists ----------
// filters: machine, technician_id, client_id, from, to, status (draft|review|approved|cancelled|priced|open), q, mine (user id)
export function listSheets(f = {}) {
  const db = getDb();
  const where = [];
  const args = [];
  if (f.machine) { where.push('s.machine = ?'); args.push(f.machine); }
  if (f.technician_id) { where.push('s.technician_id = ?'); args.push(Number(f.technician_id)); }
  if (f.client_id) { where.push('EXISTS (SELECT 1 FROM op_lines x WHERE x.sheet_id = s.id AND x.client_id = ?)'); args.push(Number(f.client_id)); }
  if (f.from) { where.push('s.sheet_date >= ?'); args.push(f.from); }
  if (f.to) { where.push('s.sheet_date <= ?'); args.push(f.to); }
  if (f.q) { where.push('s.serial LIKE ?'); args.push(`%${P.toAscii(f.q).trim()}%`); }
  if (f.mine) { where.push('s.created_by = ?'); args.push(f.mine); }
  const st = {
    draft: "s.status = 'review' AND s.draft = 1", review: "s.status = 'review' AND s.draft = 0", approved: "s.status = 'approved'",
    cancelled: "s.status = 'cancelled'", priced: "s.priced_status = 'posted'", open: "s.status <> 'cancelled'",
  }[f.status];
  if (f.status && !st) throw httpError(400, 'الحالة غلط');
  if (st) where.push(st);
  const rows = db.prepare(`SELECT s.*, t.name AS technician_name,
      (SELECT COUNT(*) FROM op_lines l WHERE l.sheet_id = s.id AND l.row_no > 0) AS lines_count,
      (SELECT GROUP_CONCAT(name, '، ') FROM (SELECT DISTINCT COALESCE(c.name, NULLIF(l.client_text, '')) AS name FROM op_lines l
         LEFT JOIN parties c ON c.id = l.client_id WHERE l.sheet_id = s.id AND l.row_no > 0)) AS clients
    FROM op_sheets s LEFT JOIN technicians t ON t.id = s.technician_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY s.sheet_date DESC, s.id DESC LIMIT ?`).all(...args, Math.min(Number(f.limit) || 300, 1000));
  return rows.map((s) => {
    const out = {
      id: s.id, serial: s.serial, machine: s.machine, machine_name: P.MACHINE_NAMES[s.machine], technician_id: s.technician_id,
      technician_name: s.technician_name, sheet_date: s.sheet_date, source: s.source, status: s.status, view_status: viewStatus(s),
      status_name: P.STATUS_NAMES[viewStatus(s)], priced_status: s.priced_status, priced_name: P.PRICED_NAMES[s.priced_status],
      lines_count: s.lines_count, clients: s.clients || '', has_photo: !!s.photo_path, version: s.version, created_by: s.created_by,
      submitted_at: s.submitted_at, created_at: s.created_at,
    };
    if (s.status === 'review') {
      const lines = readLines(s.id).map((l) => decorate(s.machine, l));
      out.counts = issueCounts(sheetIssues(s, lines));
    }
    return out;
  });
}

// ---------- for module pricing ----------
// The lines of an APPROVED sheet, ready to price: the paper's numbers, the client and material
// (with density and group), the effective work date (the line's, else the sheet's), and the
// pricing sections the line feeds (press/shear/laser/punch, louver, material). [] otherwise.
export function approvedLinesForSheet(sheetId) {
  const db = getDb();
  const s = db.prepare(`SELECT s.*, t.name AS technician_name FROM op_sheets s LEFT JOIN technicians t ON t.id = s.technician_id
    WHERE s.id = ?`).get(Number(sheetId));
  if (!s || s.status !== 'approved') return [];
  return db.prepare(`SELECT l.*, c.name AS client_name, m.name AS material_name, m.density AS material_density, m.grp AS material_group
    FROM op_lines l LEFT JOIN parties c ON c.id = l.client_id LEFT JOIN materials m ON m.id = l.material_id
    WHERE l.sheet_id = ? AND l.status = 'active' AND l.row_no > 0 ORDER BY l.row_no`).all(s.id).map((l) => ({
    id: l.id, sheet_id: s.id, sheet_serial: s.serial, machine: s.machine, technician_name: s.technician_name, row_no: l.row_no,
    client_id: l.client_id, client_name: l.client_name, work_order_id: l.work_order_id, part_name: l.part_name,
    material_id: l.material_id, material_name: l.material_name, material_density: l.material_density, material_group: l.material_group,
    material_text: l.material_text, thickness: l.thickness, pieces: l.pieces, per_piece: l.per_piece, total_written: l.total_written,
    sheets: l.sheets, minutes_per_sheet: l.minutes_per_sheet, single_piece: !!l.single_piece, louvers_per_piece: l.louvers_per_piece,
    hits_per_piece: l.hits_per_piece, sheet_size: l.sheet_size, pieces_per_sheet: l.pieces_per_sheet,
    material_source: l.material_source || 'client', length_cm: l.length_cm, width_cm: l.width_cm,
    work_date: l.work_date && isRealDate(l.work_date) ? l.work_date : s.sheet_date, notes: l.notes,
    sections: P.lineSections(s.machine, l),
  }));
}
