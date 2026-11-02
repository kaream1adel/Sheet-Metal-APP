// الإنتاج: quantities only (no money, so staff may see it) from the lines of approved
// operation sheets, grouped by machine, technician, client or month.
//   bends    التنيات  = pieces × per_piece          (press)
//   cuts     القصات   = pieces × per_piece          (shear)
//   minutes  الدقايق  = sheets × minutes_per_sheet + sheets (laser / punch: one extra minute per sheet)
//   louvers  اللوفر   = pieces × louvers_per_piece  (punch sheet lines with louvers)
//   kg       الوزن    = thickness/10 × length × width × (sheets or pieces) × density / 1000 (factory material)
// When the per-piece number is missing the technician's own total is used.
import { getDb } from '../db.js';
import { MACHINE_NAMES } from '../ledger.js';
import { monthName } from './dates.js';

export const GROUPS = { machine: 'المكنة', technician: 'الفني', client: 'العميل', month: 'الشهر' };

const n = (v) => (v === null || v === undefined ? 0 : Number(v));

export function lineMetrics(l) {
  const m = { lines: 1, pieces: n(l.pieces), bends: 0, cuts: 0, minutes: 0, louvers: 0, kg: 0, sheets: 0 };
  const perPieceTotal = l.per_piece !== null && l.per_piece !== undefined && l.pieces !== null && l.pieces !== undefined
    ? n(l.pieces) * n(l.per_piece) : n(l.total_written);
  if (l.machine === 'press') m.bends = perPieceTotal;
  if (l.machine === 'shear') m.cuts = perPieceTotal;
  if (l.machine === 'laser' || l.machine === 'punch') {
    m.sheets = n(l.sheets);
    if (l.sheets !== null && l.minutes_per_sheet !== null) m.minutes = n(l.sheets) * n(l.minutes_per_sheet) + n(l.sheets);
  }
  if (l.louvers_per_piece) m.louvers = n(l.pieces) * n(l.louvers_per_piece);
  if (l.material_source === 'factory' && l.thickness && l.length_cm && l.width_cm && l.density) {
    const count = l.sheets ?? l.pieces;
    if (count) m.kg = (l.thickness / 10) * l.length_cm * l.width_cm * count * l.density / 1000;
  }
  return m;
}

const round = (x, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

export function productionReport({ from = null, to = null, group = 'machine', machine = null, technicianId = null, clientId = null } = {}) {
  const lines = getDb().prepare(`
    SELECT l.*, s.machine, s.technician_id, s.sheet_date, s.serial AS sheet_serial,
      COALESCE(l.work_date, s.sheet_date) AS day, t.name AS technician_name, p.name AS client_name, m.density
    FROM op_lines l
    JOIN op_sheets s ON s.id = l.sheet_id
    LEFT JOIN technicians t ON t.id = s.technician_id
    LEFT JOIN parties p ON p.id = l.client_id
    LEFT JOIN materials m ON m.id = l.material_id
    WHERE s.status = 'approved' AND l.status <> 'cancelled'
      AND (? IS NULL OR COALESCE(l.work_date, s.sheet_date) >= ?)
      AND (? IS NULL OR COALESCE(l.work_date, s.sheet_date) <= ?)
      AND (? IS NULL OR s.machine = ?)
      AND (? IS NULL OR s.technician_id = ?)
      AND (? IS NULL OR l.client_id = ?)`).all(from, from, to, to, machine, machine, technicianId, technicianId, clientId, clientId);

  const keyOf = {
    machine: (l) => [l.machine, MACHINE_NAMES[l.machine]],
    technician: (l) => [l.technician_id ?? 0, l.technician_name || 'من غير فني'],
    client: (l) => [l.client_id ?? 0, l.client_name || l.client_text || 'من غير عميل'],
    month: (l) => [l.day.slice(0, 7), monthName(l.day.slice(0, 7))],
  }[group];
  const groups = new Map();
  const total = { lines: 0, pieces: 0, bends: 0, cuts: 0, minutes: 0, louvers: 0, kg: 0, sheets: 0 };
  const sheetsSeen = new Map();
  for (const l of lines) {
    const [k, label] = keyOf(l);
    if (!groups.has(k)) {
      groups.set(k, { key: k, label, lines: 0, pieces: 0, bends: 0, cuts: 0, minutes: 0, louvers: 0, kg: 0, sheets: 0, op_sheets: 0 });
      sheetsSeen.set(k, new Set());
    }
    const g = groups.get(k);
    const m = lineMetrics(l);
    for (const f of Object.keys(total)) { g[f] += m[f]; total[f] += m[f]; }
    sheetsSeen.get(k).add(l.sheet_id);
  }
  const rows = [...groups.values()].map((g) => {
    g.op_sheets = sheetsSeen.get(g.key).size;
    for (const f of ['pieces', 'bends', 'cuts', 'minutes', 'louvers', 'sheets']) g[f] = round(g[f]);
    g.kg = round(g.kg, 2);
    return g;
  });
  const order = { press: 1, shear: 2, laser: 3, punch: 4 };
  if (group === 'machine') rows.sort((a, b) => order[a.key] - order[b.key]);
  else if (group === 'month') rows.sort((a, b) => String(a.key).localeCompare(String(b.key)));
  else rows.sort((a, b) => b.lines - a.lines || String(a.label).localeCompare(String(b.label), 'ar'));
  for (const f of ['pieces', 'bends', 'cuts', 'minutes', 'louvers', 'sheets']) total[f] = round(total[f]);
  total.kg = round(total.kg, 2);
  total.op_sheets = new Set(lines.map((l) => l.sheet_id)).size;
  return { from, to, group, group_label: GROUPS[group], rows, sum: total };
}
