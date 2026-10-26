// الإنتاج (work done, no money), the technician profile, income by month (admin),
// and the machines / materials lists. Only confirmed sheets count as work.
import { Router } from 'express';
import { getDb, audit } from '../db.js';
import { requirePerm } from '../auth.js';
import { entries } from '../ledger.js';
import { httpError, cleanText, parseDate, parseNumber, todayISO } from '../util.js';
import { MACHINE_FIELDS } from '../sheets.js';
import { MISTAKE_CODES } from './sheets.js';

export const reports = Router();

const DATE = 'COALESCE(l.work_date, s.sheet_date, date(s.created_at))';
// Day / ISO-ish week (starting Saturday, as the workshop counts) / month.
const PERIOD = {
  day: DATE,
  week: `date(${DATE}, '-' || ((strftime('%w', ${DATE}) + 1) % 7) || ' days')`,
  month: `strftime('%Y-%m', ${DATE})`,
};

function range(q) {
  const to = parseDate(q.to) || todayISO();
  const from = parseDate(q.from) || todayISO(new Date(Date.parse(to) - 29 * 86400000));
  if (from > to) throw httpError(400, 'تاريخ البداية بعد تاريخ النهاية');
  return { from, to };
}

// Quantities per period × technician × machine, in each machine's own units.
export function production({ from, to, group = 'day', technicianId = null, machineId = null }) {
  return getDb().prepare(`
    SELECT ${PERIOD[group] || PERIOD.day} AS period, s.technician_id, t.name AS technician_name, m.id AS machine_id, m.code AS machine_code, m.name AS machine_name,
      COUNT(*) AS lines, COUNT(DISTINCT s.id) AS sheets_count,
      SUM(COALESCE(l.pieces, 0)) AS pieces,
      SUM(COALESCE(l.pieces, 0) * COALESCE(l.ops_per_piece, 0)) AS ops,
      SUM(COALESCE(l.sheets, 0)) AS sheets,
      SUM(CASE WHEN m.code = 'laser' THEN COALESCE(l.sheets, 0) * COALESCE(l.minutes_per_sheet, 0) ELSE COALESCE(l.minutes, 0) END) AS minutes,
      SUM(COALESCE(l.pieces, 0) * COALESCE(l.hits_per_piece, 0)) AS hits,
      SUM(COALESCE(l.pieces, 0) * COALESCE(l.louvers_per_piece, 0)) AS louvers
    FROM lines l JOIN sheets s ON s.id = l.sheet_id JOIN machines m ON m.id = s.machine_id
    LEFT JOIN technicians t ON t.id = s.technician_id
    WHERE s.status = 'confirmed' AND ${DATE} BETWEEN ? AND ?
      AND (? IS NULL OR s.technician_id = ?) AND (? IS NULL OR m.id = ?)
    GROUP BY period, s.technician_id, m.id
    ORDER BY period DESC, m.sort, technician_name`).all(from, to, technicianId, technicianId, machineId, machineId);
}

reports.get('/production', requirePerm('production.view'), (req, res) => {
  const { from, to } = range(req.query);
  const group = ['day', 'week', 'month'].includes(req.query.group) ? req.query.group : 'day';
  res.json({ from, to, group, rows: production({ from, to, group,
    technicianId: req.query.technician ? Number(req.query.technician) : null, machineId: req.query.machine ? Number(req.query.machine) : null }) });
});

// ---------- technician profile ----------
const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null);

reports.get('/technicians/:id/profile', requirePerm('production.view'), (req, res) => {
  const db = getDb();
  const t = db.prepare('SELECT * FROM technicians WHERE id = ?').get(req.params.id);
  if (!t) throw httpError(404, 'الفني مش موجود');
  const since = todayISO(new Date(Date.now() - 180 * 86400000));
  const lines = db.prepare(`SELECT l.*, m.code AS machine_code FROM lines l JOIN sheets s ON s.id = l.sheet_id JOIN machines m ON m.id = s.machine_id
    WHERE s.status = 'confirmed' AND s.technician_id = ? AND ${DATE} >= ?`).all(t.id, since);
  const top = (key, table) => {
    const counts = {};
    for (const l of lines) if (l[key]) counts[l[key]] = (counts[l[key]] || 0) + 1;
    const name = db.prepare(`SELECT name FROM ${table} WHERE id = ?`);
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([id, n]) => ({ id: Number(id), name: name.get(id)?.name || '—', lines: n }));
  };
  // The normal range of each value he writes (10%–90%): outside it is worth a second look.
  const ranges = {};
  for (const f of ['thickness', 'pieces', 'ops_per_piece', 'sheets', 'minutes_per_sheet', 'pieces_per_sheet', 'hits_per_piece', 'minutes']) {
    const v = lines.map((l) => l[f]).filter((x) => x !== null && x !== undefined).sort((a, b) => a - b);
    if (v.length >= 3) ranges[f] = { low: pct(v, 0.1), usual: pct(v, 0.5), high: pct(v, 0.9), count: v.length };
  }
  const withDitto = lines.filter((l) => { try { return JSON.parse(l.ditto_fields || '[]').length > 0; } catch { return false; } }).length;
  const mistakes = db.prepare(`SELECT g.code, g.field, COUNT(*) n FROM sheet_issue_log g JOIN sheets s ON s.id = g.sheet_id
    WHERE s.technician_id = ? AND s.status = 'confirmed' AND g.first_seen >= ? AND g.code IN (${MISTAKE_CODES.map(() => '?').join(',')})
    GROUP BY g.code, g.field ORDER BY n DESC`).all(t.id, since, ...MISTAKE_CODES);
  const sheets = db.prepare(`SELECT COUNT(*) n FROM sheets s WHERE s.technician_id = ? AND s.status = 'confirmed' AND COALESCE(s.sheet_date, date(s.created_at)) >= ?`).get(t.id, since).n;
  const reading = db.prepare(`SELECT COUNT(*) reads, SUM(r.correct) correct FROM cell_reads r JOIN sheets s ON s.id = r.sheet_id
    WHERE s.technician_id = ? AND r.correct IS NOT NULL`).get(t.id);
  const samples = db.prepare('SELECT COUNT(*) n FROM ocr_samples WHERE technician_id = ?').get(t.id).n;
  const to = todayISO();
  const from = todayISO(new Date(Date.now() - 29 * 86400000));
  res.json({
    technician: { ...t, active: !!t.active },
    since, sheets, lines: lines.length,
    clients: top('client_id', 'clients'), materials: top('material_id', 'materials'),
    ranges, ditto_share: lines.length ? withDitto / lines.length : 0,
    mistakes, reading: { reads: reading.reads || 0, correct: reading.correct || 0, samples },
    production: production({ from, to, group: 'month', technicianId: t.id }),
  });
});

// ---------- income by month (admin) ----------
reports.get('/reports/income', requirePerm('money.view'), (req, res) => {
  const db = getDb();
  const { from, to } = range({ from: req.query.from || `${todayISO().slice(0, 4)}-01-01`, to: req.query.to });
  const months = {};
  const row = (m) => (months[m] ||= { month: m, work: 0, additions: 0, discounts: 0, received: 0 });
  for (const { id } of db.prepare('SELECT id FROM clients').all()) {
    for (const e of entries(id)) {
      if (e.kind === 'opening' || e.date < from || e.date > to) continue;
      const r = row(e.date.slice(0, 7));
      if (e.kind === 'charge' || e.kind === 'item') r.work += e.amount;
      else if (e.kind === 'adjustment') { if (e.amount > 0) r.additions += e.amount; else r.discounts -= e.amount; }
      else if (e.kind === 'payment') r.received -= e.amount;
    }
  }
  const rows = Object.values(months).sort((a, b) => b.month.localeCompare(a.month));
  const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
  const pending = db.prepare(`SELECT COALESCE(SUM(amount), 0) n FROM payments WHERE is_cheque = 1 AND cheque_status = 'pending' AND cancelled_at IS NULL`).get().n;
  res.json({ from, to, rows, totals: { work: sum('work'), additions: sum('additions'), discounts: sum('discounts'), received: sum('received') }, cheques_pending: pending });
});

// ---------- machines and materials ----------
reports.get('/materials', requirePerm('machines.edit'), (_req, res) => {
  const rows = getDb().prepare('SELECT * FROM materials ORDER BY active DESC, sort, name').all();
  res.json({ materials: rows.map((m) => ({ ...m, aliases: JSON.parse(m.aliases || '[]'), active: !!m.active })) });
});

function materialInput(b, cur = {}) {
  const m = {
    name: b.name !== undefined ? cleanText(b.name, 40) : cur.name,
    aliases: b.aliases !== undefined
      ? [...new Set((Array.isArray(b.aliases) ? b.aliases : String(b.aliases).split(/[\n,،]/)).map((x) => cleanText(x, 40)).filter(Boolean))]
      : JSON.parse(cur.aliases || '[]'),
    density: b.density !== undefined ? parseNumber(b.density) : cur.density,
    active: b.active !== undefined ? (b.active ? 1 : 0) : cur.active ?? 1,
  };
  if (!m.name) throw httpError(400, 'اكتب اسم الخامة');
  if (m.density === null || m.density === undefined) m.density = 0;
  if (Number.isNaN(m.density) || m.density < 0 || m.density >= 25) throw httpError(400, 'الكثافة غلط (الحديد 7.85)');
  return m;
}

reports.post('/materials', requirePerm('machines.edit'), (req, res) => {
  const db = getDb();
  const m = materialInput(req.body || {});
  if (db.prepare('SELECT 1 FROM materials WHERE name = ?').get(m.name)) throw httpError(409, 'الخامة دي موجودة');
  const id = db.transaction(() => {
    const sort = db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 n FROM materials').get().n;
    const r = db.prepare('INSERT INTO materials (name, aliases, density, sort, active) VALUES (?,?,?,?,?)').run(m.name, JSON.stringify(m.aliases), m.density, sort, m.active);
    audit(req.user.id, 'create', 'material', r.lastInsertRowid, undefined, m);
    return r.lastInsertRowid;
  })();
  res.status(201).json({ material: db.prepare('SELECT * FROM materials WHERE id = ?').get(id) });
});

reports.patch('/materials/:id', requirePerm('machines.edit'), (req, res) => {
  const db = getDb();
  const cur = db.prepare('SELECT * FROM materials WHERE id = ?').get(req.params.id);
  if (!cur) throw httpError(404, 'الخامة مش موجودة');
  const m = materialInput(req.body || {}, cur);
  if (m.name !== cur.name && db.prepare('SELECT 1 FROM materials WHERE name = ? AND id <> ?').get(m.name, cur.id)) throw httpError(409, 'فيه خامة بنفس الاسم');
  db.transaction(() => {
    db.prepare('UPDATE materials SET name = ?, aliases = ?, density = ?, active = ? WHERE id = ?').run(m.name, JSON.stringify(m.aliases), m.density, m.active, cur.id);
    audit(req.user.id, 'update', 'material', cur.id, cur, m);
  })();
  res.json({ ok: true });
});

reports.get('/machines', requirePerm('machines.edit'), (_req, res) => {
  const rows = getDb().prepare('SELECT * FROM machines ORDER BY sort').all();
  res.json({ machines: rows.map((m) => ({ ...m, active: !!m.active, fields: MACHINE_FIELDS[m.code] || [] })) });
});

// Only the name people see and whether it is in use: the code ties a machine to its paper form.
reports.patch('/machines/:id', requirePerm('machines.edit'), (req, res) => {
  const db = getDb();
  const cur = db.prepare('SELECT * FROM machines WHERE id = ?').get(req.params.id);
  if (!cur) throw httpError(404, 'المكنة مش موجودة');
  const name = req.body?.name !== undefined ? cleanText(req.body.name, 40) : cur.name;
  const active = req.body?.active !== undefined ? (req.body.active ? 1 : 0) : cur.active;
  if (!name) throw httpError(400, 'اكتب اسم المكنة');
  db.transaction(() => {
    db.prepare('UPDATE machines SET name = ?, active = ? WHERE id = ?').run(name, active, cur.id);
    audit(req.user.id, 'update', 'machine', cur.id, { name: cur.name, active: cur.active }, { name, active });
  })();
  res.json({ ok: true });
});
