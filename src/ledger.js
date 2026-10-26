// The client account, always calculated from the records (never stored):
// balance = opening + priced lines + grouped items + adjustments − cleared payments.
// Positive = the client owes us (عليه).
import { getDb } from './db.js';
import { UNITS } from './units.js';
import { todayISO } from './util.js';

const fmtN = (v) => (v === null || v === undefined ? '' : String(Number(Number(v).toFixed(3))));

// Short description of a line's work, no money.
export function workText(l) {
  const parts = [l.machine_name];
  if (l.material_name || l.thickness) parts.push(`${l.material_name || ''} ${l.thickness ? fmtN(l.thickness) + 'م' : ''}`.trim());
  if (l.part_name) parts.push(l.part_name);
  return parts.join(' · ');
}

export const LINE_SELECT = `
  SELECT l.*, COALESCE(l.work_date, s.sheet_date, date(s.created_at)) AS date, m.code AS machine_code, m.name AS machine_name,
         mt.name AS material_name, d.delivery_date
  FROM lines l JOIN sheets s ON s.id = l.sheet_id JOIN machines m ON m.id = s.machine_id
  LEFT JOIN materials mt ON mt.id = l.material_id
  LEFT JOIN deliveries d ON d.id = l.delivery_id AND d.cancelled_at IS NULL`;

// Every money movement for one client, oldest first.
export function entries(clientId) {
  const db = getDb();
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
  if (!client) return [];
  const out = [];
  if (client.opening_balance) {
    out.push({ kind: 'opening', date: client.opening_date || '0000-00-00', amount: client.opening_balance,
      text: 'رصيد أول المدة', order: 0, id: 0 });
  }
  const charges = db.prepare(`
    SELECT p.*, b.due_date, x.* , p.id AS price_id, p.amount AS amount, p.qty AS qty
    FROM line_prices p JOIN pricing_batches b ON b.id = p.batch_id
    JOIN (${LINE_SELECT}) x ON x.id = p.line_id
    WHERE p.status = 'active' AND b.client_id = ?`).all(clientId);
  for (const c of charges) {
    out.push({ kind: 'charge', id: c.price_id, line_id: c.line_id, date: c.date, amount: c.amount, order: 1,
      text: `${workText(c)} — ${fmtN(c.qty)} ${UNITS[c.unit]?.label || c.unit} × ${(c.rate / 100).toFixed(2)}`,
      delivered: c.delivery_date || null, due: c.due_date || null });
  }
  const items = db.prepare(`
    SELECT i.*, b.due_date FROM billing_items i JOIN pricing_batches b ON b.id = i.batch_id
    WHERE i.status = 'active' AND i.client_id = ?`).all(clientId);
  const itemLines = db.prepare(`SELECT x.* FROM billing_item_lines bl JOIN (${LINE_SELECT}) x ON x.id = bl.line_id WHERE bl.item_id = ?`);
  for (const i of items) {
    const lines = itemLines.all(i.id);
    const delivered = lines.length && lines.every((l) => l.delivery_date)
      ? lines.map((l) => l.delivery_date).sort().at(-1) : null;
    out.push({ kind: 'item', id: i.id, date: i.item_date, amount: i.amount, order: 1,
      text: `${i.description} — ${fmtN(i.qty)} ${UNITS[i.unit]?.label || i.unit} × ${(i.rate / 100).toFixed(2)}`,
      summary: summarizeLines(lines), lines: lines.map((l) => ({ id: l.id, text: workText(l) })),
      delivered, due: i.due_date || null });
  }
  for (const a of db.prepare('SELECT * FROM adjustments WHERE client_id = ? AND cancelled_at IS NULL').all(clientId)) {
    out.push({ kind: 'adjustment', id: a.id, date: a.adj_date, amount: a.amount, order: 2,
      text: a.amount < 0 ? `خصم — ${a.reason}` : `إضافة — ${a.reason}` });
  }
  for (const p of db.prepare('SELECT * FROM payments WHERE client_id = ? AND cancelled_at IS NULL').all(clientId)) {
    if (p.is_cheque && p.cheque_status !== 'cleared') continue; // pending/bounced cheques don't count
    out.push({ kind: 'payment', id: p.id, date: p.is_cheque ? (p.cheque_cleared_at || p.pay_date) : p.pay_date,
      amount: -p.amount, order: 3, text: `دفعة ${p.method}${p.reference ? ' — ' + p.reference : ''}` });
  }
  const kindOrder = { opening: 0, charge: 1, item: 1, adjustment: 2, payment: 3 };
  return out.sort((a, b) => a.date.localeCompare(b.date) || kindOrder[a.kind] - kindOrder[b.kind] || a.id - b.id);
}

function summarizeLines(lines) {
  const by = {};
  for (const l of lines) {
    const k = l.machine_name;
    by[k] = (by[k] || 0) + (Number(l.pieces) || Number(l.sheets) || 0);
  }
  return Object.entries(by).map(([m, q]) => `${m} ${fmtN(q)}`).join(' · ');
}

export const balanceOf = (clientId) => entries(clientId).reduce((s, e) => s + e.amount, 0);

export function allBalances() {
  const out = {};
  for (const { id } of getDb().prepare('SELECT id FROM clients').all()) out[id] = balanceOf(id);
  return out;
}

// Statement for a period: everything before `from` folds into one "رصيد سابق" row.
export function statement(clientId, from, to) {
  const all = entries(clientId);
  let carried = 0;
  const rows = [];
  for (const e of all) {
    if (from && e.date < from) { carried += e.amount; continue; }
    if (to && e.date > to) continue;
    rows.push(e);
  }
  let running = carried;
  for (const r of rows) { running += r.amount; r.balance = running; }
  const debit = rows.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0);
  const credit = rows.filter((r) => r.amount < 0).reduce((s, r) => s - r.amount, 0);
  return { carried, rows, debit, credit, closing: running };
}

// Payments settle the oldest debts first (FIFO). Returns what is still open,
// with days since delivery (null when not delivered yet).
export function openDebts(clientId, today = todayISO()) {
  const all = entries(clientId);
  const debits = all.filter((e) => e.amount > 0).map((e) => ({ ...e, open: e.amount }));
  let credit = -all.filter((e) => e.amount < 0).reduce((s, e) => s + e.amount, 0);
  for (const d of debits) {
    const used = Math.min(credit, d.open);
    d.open -= used;
    credit -= used;
  }
  const days = (iso) => (iso ? Math.floor((Date.parse(today) - Date.parse(iso.slice(0, 10))) / 86400000) : null);
  return debits.filter((d) => d.open > 0).map((d) => {
    const since = d.kind === 'charge' || d.kind === 'item' ? d.delivered : d.date;
    return { ...d, since, days: since && since !== '0000-00-00' ? days(since) : null };
  });
}
