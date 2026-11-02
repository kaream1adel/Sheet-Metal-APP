// Reading the treasury: balances, movements by day with a running balance, documents with
// their details, the expenses list with totals, cheques by due week with alerts.
// Every money field is named so stripMoney() recognises it (amount, *_amount, *_balance, *_total).
import { getDb } from '../db.js';
import { balance, getTxn } from '../ledger.js';
import { httpError, foldName } from '../util.js';
import {
  METHODS, PAID_FROM, VOUCHER_KINDS, CHEQUE_STATUS, OPEN_IN, OPEN_OUT, KIND_NAMES, bad, isRealDate, today, addDays, weekStart, daysBetween,
} from './common.js';
import { recurringDrafts } from './recurring.js';

const optDate = (v, field) => {
  if (!v) return null;
  const d = isRealDate(v);
  if (!d) throw bad(field, 'التاريخ غلط');
  return d;
};
const prevDay = (iso) => addDays(iso, -1);

// ---------- balances ----------
export function treasurySummary(asOf = today()) {
  const db = getDb();
  const sum = (sql, ...a) => db.prepare(sql).get(...a).s || 0;
  const alerts = chequeAlerts(asOf);
  return {
    as_of: asOf,
    cash: balance('cash'),
    bank: balance('bank'),
    cheques_in_amount: sum(`SELECT SUM(amount) s FROM cheques WHERE direction='in' AND status IN ('in_portfolio','deposited')`),
    cheques_in_count: db.prepare(`SELECT COUNT(*) n FROM cheques WHERE direction='in' AND status IN ('in_portfolio','deposited')`).get().n,
    cheques_out_amount: sum(`SELECT SUM(amount) s FROM cheques WHERE direction='out' AND status = 'issued'`),
    cheques_out_count: db.prepare(`SELECT COUNT(*) n FROM cheques WHERE direction='out' AND status = 'issued'`).get().n,
    today_in_amount: sum(`SELECT SUM(p.debit) s FROM postings p JOIN txns t ON t.id = p.txn_id
      WHERE p.account IN ('cash','bank') AND t.date = ? AND t.kind NOT IN ('transfer')`, asOf),
    today_out_amount: sum(`SELECT SUM(p.credit) s FROM postings p JOIN txns t ON t.id = p.txn_id
      WHERE p.account IN ('cash','bank') AND t.date = ? AND t.kind NOT IN ('transfer')`, asOf),
    alerts,
    drafts_count: recurringDrafts(asOf).length,
    last_count: db.prepare("SELECT serial, date, difference FROM cash_counts WHERE account = 'cash' ORDER BY date DESC, id DESC LIMIT 1").get() || null,
  };
}

// حركة الخزينة / البنك: one row per transaction touching the account, grouped by day, with the
// running balance after each row and the day's in / out / closing.
export function movements({ account = 'cash', from = null, to = null, q = '' } = {}) {
  if (!['cash', 'bank'].includes(account)) throw bad('account', 'اختار الخزينة أو البنك');
  const f = optDate(from, 'from');
  const t = optDate(to, 'to');
  const db = getDb();
  const opening = f ? balance(account, null, { asOf: prevDay(f) }) : 0;
  const rows = db.prepare(`
    SELECT t.id AS txn_id, t.serial, t.ref, t.kind, t.date, t.description, t.doc_type, t.doc_id, t.status, t.reversal_of,
      t.party_id, pa.name AS party_name, SUM(p.debit) AS dr, SUM(p.credit) AS cr
    FROM postings p JOIN txns t ON t.id = p.txn_id LEFT JOIN parties pa ON pa.id = t.party_id
    WHERE p.account = ? AND (? IS NULL OR t.date >= ?) AND (? IS NULL OR t.date <= ?)
    GROUP BY t.id ORDER BY t.date, t.id`).all(account, f, f, t, t);
  let running = opening;
  const days = [];
  const fq = foldName(q || '');
  const totals = { in_amount: 0, out_amount: 0 };
  for (const r of rows) {
    const net = r.dr - r.cr;
    running += net;
    const row = {
      txn_id: r.txn_id, serial: r.serial, ref: r.ref, kind: r.kind, date: r.date, description: r.description,
      doc_type: r.doc_type, doc_id: r.doc_id, status: r.status, reversal_of: r.reversal_of, party_name: r.party_name || '',
      in_amount: net > 0 ? net : 0, out_amount: net < 0 ? -net : 0, running_balance: running,
    };
    let day = days[days.length - 1];
    if (!day || day.date !== r.date) {
      day = { date: r.date, in_amount: 0, out_amount: 0, closing_balance: 0, rows: [] };
      days.push(day);
    }
    day.in_amount += row.in_amount;
    day.out_amount += row.out_amount;
    day.closing_balance = running;
    totals.in_amount += row.in_amount;
    totals.out_amount += row.out_amount;
    if (!fq || foldName(`${r.description} ${r.ref} ${r.serial} ${r.party_name || ''}`).includes(fq)) day.rows.push(row);
  }
  return {
    account, from: f, to: t, opening_balance: opening, closing_balance: running, totals,
    days: days.filter((d) => d.rows.length).reverse(), // newest day first
  };
}

// ---------- documents ----------
const userName = (id) => (id ? getDb().prepare('SELECT display_name FROM users WHERE id = ?').get(id)?.display_name : '') || '';

export function getReceipt(id) {
  const db = getDb();
  const r = db.prepare(`SELECT r.*, p.name AS party_name, p.kind AS party_kind FROM receipts r JOIN parties p ON p.id = r.party_id
    WHERE r.id = ?`).get(Number(id));
  if (!r) throw httpError(404, 'الإيصال مش موجود');
  r.method_name = METHODS[r.method];
  r.party_kind_name = KIND_NAMES[r.party_kind];
  r.account_name = r.account === 'cash' ? 'الخزينة' : r.account === 'bank' ? 'البنك' : '';
  r.cheque = r.cheque_id ? db.prepare('SELECT id, serial, number, bank, due_date, status FROM cheques WHERE id = ?').get(r.cheque_id) : null;
  if (r.cheque) r.cheque.status_name = CHEQUE_STATUS[r.cheque.status];
  r.txn_serial = r.txn_id ? getTxn(r.txn_id)?.serial : null;
  r.created_by_name = userName(r.created_by);
  return r;
}

export function listReceipts({ from, to, party_id, method } = {}) {
  const f = optDate(from, 'from');
  const t = optDate(to, 'to');
  return getDb().prepare(`SELECT r.id, r.serial, r.date, r.amount, r.method, r.status, r.party_id, p.name AS party_name, p.kind AS party_kind,
      c.status AS cheque_status FROM receipts r JOIN parties p ON p.id = r.party_id LEFT JOIN cheques c ON c.id = r.cheque_id
    WHERE (? IS NULL OR r.date >= ?) AND (? IS NULL OR r.date <= ?) AND (? IS NULL OR r.party_id = ?) AND (? IS NULL OR r.method = ?)
    ORDER BY r.date DESC, r.id DESC LIMIT 500`).all(f, f, t, t, party_id || null, party_id || null, method || null, method || null)
    .map((r) => ({ ...r, method_name: METHODS[r.method], cheque_status_name: r.cheque_status ? CHEQUE_STATUS[r.cheque_status] : null }));
}

export function getVoucher(id) {
  const db = getDb();
  const v = db.prepare(`SELECT v.*, p.name AS party_name, p.kind AS party_kind, s.name AS paid_from_party_name
    FROM vouchers v LEFT JOIN parties p ON p.id = v.party_id LEFT JOIN parties s ON s.id = v.paid_from_party_id WHERE v.id = ?`).get(Number(id));
  if (!v) throw httpError(404, 'إذن الصرف مش موجود');
  v.kind_name = VOUCHER_KINDS[v.kind] || v.kind;
  v.paid_from_name = PAID_FROM[v.paid_from];
  v.lines = db.prepare(`SELECT l.*, c.name AS category_name, cp.name AS cost_party_name, w.name AS worker_name FROM voucher_lines l
    LEFT JOIN expense_categories c ON c.id = l.category_id LEFT JOIN parties cp ON cp.id = l.cost_party_id
    LEFT JOIN parties w ON w.id = l.worker_id WHERE l.voucher_id = ? ORDER BY l.id`).all(v.id).map((l) => ({ ...l, recharge: !!l.recharge }));
  v.items = db.prepare('SELECT * FROM purchase_items WHERE voucher_id = ? ORDER BY id').all(v.id);
  v.cheque = v.cheque_id ? db.prepare('SELECT id, serial, number, bank, due_date, status, payee_text FROM cheques WHERE id = ?').get(v.cheque_id) : null;
  if (v.cheque) v.cheque.status_name = CHEQUE_STATUS[v.cheque.status];
  v.paid_amount = v.total - (v.deduction_amount || 0);
  v.has_photo = !!v.photo_path;
  delete v.photo_path;
  v.txn_serial = v.txn_id ? getTxn(v.txn_id)?.serial : null;
  v.created_by_name = userName(v.created_by);
  return v;
}

// المصروفات: filters date / category / cost center (general | client id) / paid from / kind.
// opts.ownerId limits the list to one user's vouchers (the workshop manager sees only his own).
export function listVouchers(filters = {}, { ownerId = null } = {}) {
  const db = getDb();
  const f = optDate(filters.from, 'from');
  const t = optDate(filters.to, 'to');
  const cat = filters.category_id ? Number(filters.category_id) : null;
  const cost = filters.cost || '';  // '' all · 'general' · 'client' (any client) · <client id>
  const costId = /^\d+$/.test(String(cost)) ? Number(cost) : null;
  const kind = filters.kind && filters.kind in VOUCHER_KINDS ? filters.kind : null;
  const paidFrom = filters.paid_from && filters.paid_from in PAID_FROM ? filters.paid_from : null;
  const status = filters.status === 'all' ? null : filters.status === 'cancelled' ? 'cancelled' : 'posted';
  const vs = db.prepare(`SELECT v.*, p.name AS party_name, s.name AS paid_from_party_name, u.display_name AS created_by_name
    FROM vouchers v LEFT JOIN parties p ON p.id = v.party_id LEFT JOIN parties s ON s.id = v.paid_from_party_id
    LEFT JOIN users u ON u.id = v.created_by
    WHERE (? IS NULL OR v.date >= ?) AND (? IS NULL OR v.date <= ?) AND (? IS NULL OR v.kind = ?) AND (? IS NULL OR v.paid_from = ?)
      AND (? IS NULL OR v.status = ?) AND (? IS NULL OR v.created_by = ?)
    ORDER BY v.date DESC, v.id DESC LIMIT 2000`).all(f, f, t, t, kind, kind, paidFrom, paidFrom, status, status, ownerId, ownerId);
  const lineQ = db.prepare(`SELECT l.*, c.name AS category_name, cp.name AS cost_party_name, w.name AS worker_name FROM voucher_lines l
    LEFT JOIN expense_categories c ON c.id = l.category_id LEFT JOIN parties cp ON cp.id = l.cost_party_id
    LEFT JOIN parties w ON w.id = l.worker_id WHERE l.voucher_id = ? ORDER BY l.id`);
  const fq = foldName(filters.q || '');
  const out = [];
  const byCategory = new Map();
  let grand = 0;
  for (const v of vs) {
    const lines = lineQ.all(v.id).map((l) => ({ ...l, recharge: !!l.recharge }));
    // Lines that match the category / cost-center filter; a voucher with none is left out.
    const match = lines.filter((l) => (!cat || l.category_id === cat)
      && (!cost || (cost === 'general' ? !l.cost_party_id : cost === 'client' ? !!l.cost_party_id : l.cost_party_id === costId)));
    if ((cat || cost) && !match.length) continue;
    const text = `${v.serial} ${v.description} ${v.party_name || ''} ${lines.map((l) => `${l.category_name} ${l.cost_party_name || ''} ${l.worker_name || ''} ${l.description}`).join(' ')}`;
    if (fq && !foldName(text).includes(fq)) continue;
    const shown = cat || cost ? match.reduce((s, l) => s + l.amount, 0) : v.total;
    const row = {
      id: v.id, serial: v.serial, date: v.date, kind: v.kind, kind_name: VOUCHER_KINDS[v.kind], paid_from: v.paid_from,
      paid_from_name: PAID_FROM[v.paid_from], paid_from_party_name: v.paid_from_party_name || '', party_name: v.party_name || '',
      description: v.description, status: v.status, cancel_reason: v.cancel_reason, has_photo: !!v.photo_path,
      created_by_name: v.created_by_name || '', recurring_id: v.recurring_id,
      categories: [...new Set((match.length ? match : lines).map((l) => l.category_name))].join('، ') || VOUCHER_KINDS[v.kind],
      cost_centers: [...new Set((match.length ? match : lines).map((l) => l.cost_party_name || 'عام'))].join('، ') || '',
      recharge: lines.some((l) => l.recharge),
      amount: shown,
      lines: (cat || cost ? match : lines).map((l) => ({ category_name: l.category_name, cost_party_name: l.cost_party_name || '', worker_name: l.worker_name || '', recharge: l.recharge, amount: l.amount })),
    };
    out.push(row);
    if (v.status === 'posted') {
      grand += shown;
      const groups = (cat || cost ? match : lines).length
        ? (cat || cost ? match : lines).map((l) => [l.category_name, l.amount])
        : [[VOUCHER_KINDS[v.kind], v.total]];
      for (const [k, a] of groups) byCategory.set(k, (byCategory.get(k) || 0) + a);
    }
  }
  return {
    vouchers: out,
    totals: { grand_total: grand, count: out.filter((v) => v.status === 'posted').length,
      by_category: [...byCategory.entries()].map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount) },
  };
}

export function getTransfer(id) {
  const t = getDb().prepare('SELECT * FROM transfers WHERE id = ?').get(Number(id));
  if (!t) throw httpError(404, 'التحويل مش موجود');
  t.txn_serial = t.txn_id ? getTxn(t.txn_id)?.serial : null;
  t.created_by_name = userName(t.created_by);
  return t;
}
export const listTransfers = () => getDb().prepare('SELECT * FROM transfers ORDER BY date DESC, id DESC LIMIT 200').all();
export const listCashCounts = () => getDb().prepare(`SELECT c.*, u.display_name AS created_by_name FROM cash_counts c
  LEFT JOIN users u ON u.id = c.created_by ORDER BY c.date DESC, c.id DESC LIMIT 200`).all();
export function getCashCount(id) {
  const c = getDb().prepare('SELECT * FROM cash_counts WHERE id = ?').get(Number(id));
  if (!c) throw httpError(404, 'الجرد مش موجود');
  return c;
}

// ---------- cheques ----------
function alertOf(c, asOf) {
  const open = c.direction === 'in' ? OPEN_IN.includes(c.status) : OPEN_OUT.includes(c.status);
  if (!open || !c.due_date) return null;
  const days = daysBetween(asOf, c.due_date);
  if (days < 0) return 'overdue';
  if (days <= 3) return 'due_soon';
  return null;
}

// أوراق القبض / أوراق الدفع grouped by the week they fall due (Saturday to Friday).
// status: 'open' (default: still to act on) · 'all' · one status.
export function listCheques({ direction = 'in', status = 'open', from = null, to = null, party_id = null, q = '' } = {}, asOf = today()) {
  if (!['in', 'out'].includes(direction)) throw bad('direction', 'نوع الشيكات غلط');
  const f = optDate(from, 'from');
  const t = optDate(to, 'to');
  const open = direction === 'in' ? OPEN_IN : OPEN_OUT;
  const statuses = status === 'all' ? null : status === 'open' ? open : status in CHEQUE_STATUS ? [status] : open;
  const rows = getDb().prepare(`SELECT c.*, p.name AS party_name, e.name AS endorsed_to_name FROM cheques c
    LEFT JOIN parties p ON p.id = c.party_id LEFT JOIN parties e ON e.id = c.endorsed_to_party_id
    WHERE c.direction = ? AND (? IS NULL OR c.due_date >= ?) AND (? IS NULL OR c.due_date <= ?) AND (? IS NULL OR c.party_id = ?)
    ORDER BY c.due_date, c.id`).all(direction, f, f, t, t, party_id || null, party_id || null)
    .filter((c) => !statuses || statuses.includes(c.status));
  const fq = foldName(q || '');
  const weeks = [];
  let total = 0;
  for (const c of rows) {
    if (fq && !foldName(`${c.number} ${c.bank} ${c.party_name || ''} ${c.payee_text} ${c.serial}`).includes(fq)) continue;
    const row = { ...c, status_name: CHEQUE_STATUS[c.status], alert: alertOf(c, asOf), days_to_due: c.due_date ? daysBetween(asOf, c.due_date) : null };
    const ws = c.due_date ? weekStart(c.due_date) : '';
    let w = weeks[weeks.length - 1];
    if (!w || w.week_start !== ws) {
      w = { week_start: ws, week_end: ws ? addDays(ws, 6) : '', week_total: 0, count: 0, rows: [], this_week: ws === weekStart(asOf), past: !!ws && addDays(ws, 6) < asOf };
      weeks.push(w);
    }
    w.rows.push(row);
    w.count += 1;
    w.week_total += c.amount;
    total += c.amount;
  }
  return { direction, status, weeks, grand_total: total, count: weeks.reduce((s, w) => s + w.count, 0), alerts: chequeAlerts(asOf, direction) };
}

// Due in the next 3 days, and overdue (still in hand / not cleared).
export function chequeAlerts(asOf = today(), direction = null) {
  const db = getDb();
  const rows = db.prepare(`SELECT c.id, c.serial, c.direction, c.number, c.bank, c.amount, c.due_date, c.status, p.name AS party_name, c.payee_text
    FROM cheques c LEFT JOIN parties p ON p.id = c.party_id
    WHERE ((c.direction = 'in' AND c.status IN ('in_portfolio','deposited')) OR (c.direction = 'out' AND c.status = 'issued'))
      AND c.due_date IS NOT NULL AND c.due_date <= ? AND (? IS NULL OR c.direction = ?) ORDER BY c.due_date`).all(addDays(asOf, 3), direction, direction);
  return rows.map((c) => ({ ...c, alert: c.due_date < asOf ? 'overdue' : 'due_soon', days_to_due: daysBetween(asOf, c.due_date), status_name: CHEQUE_STATUS[c.status] }));
}
