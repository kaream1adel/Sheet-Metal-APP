// ملخص العملاء and أعمار الديون — both read the client control account (receivable) only.
//
// Columns follow the Excel «ملخص العملاء» and the كشف حساب: per transaction the net on the
// client's account is مدين (> 0), خصم (< 0 and the txn debits discount_given) or دائن (< 0).
// A reversed transaction and its reversal cancel out exactly, so both halves are left out of
// the column totals (the balance is the same either way, and «إجمالي الدائن» then means what
// the client really paid). With asOf, a pair whose reversal falls after asOf still counts.
import { getDb } from '../db.js';
import { balanceWords } from '../money.js';
import { daysBetween } from './dates.js';

// Every live (not cancelled) transaction on the receivable account up to asOf, per client.
function clientTxns(asOf = null, partyId = null) {
  return getDb().prepare(`
    SELECT p.party_id, t.id AS txn_id, t.date, t.kind,
      SUM(p.debit) - SUM(p.credit) AS net,
      EXISTS (SELECT 1 FROM postings x WHERE x.txn_id = t.id AND x.account = 'discount_given') AS is_discount
    FROM postings p
    JOIN txns t ON t.id = p.txn_id
    LEFT JOIN txns r ON r.id = t.reversed_by
    WHERE p.account = 'receivable'
      AND (? IS NULL OR p.party_id = ?)
      AND (? IS NULL OR t.date <= ?)
      AND t.reversal_of IS NULL
      AND (t.status = 'posted' OR (? IS NOT NULL AND r.date > ?))
    GROUP BY p.party_id, t.id
    ORDER BY p.party_id, t.date, t.id`).all(partyId, partyId, asOf, asOf, asOf, asOf);
}

const groupBy = (rows, key) => {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r[key])) m.set(r[key], []);
    m.get(r[key]).push(r);
  }
  return m;
};

// FIFO: payments and discounts settle the oldest work first. Returns the unpaid part of
// each debit (oldest first) and any unapplied credit (the client paid in advance).
export function fifoOpenDebits(txns) {
  let credit = txns.filter((t) => t.net < 0).reduce((s, t) => s - t.net, 0);
  const open = [];
  for (const t of txns) {
    if (t.net <= 0) continue;
    const used = Math.min(credit, t.net);
    credit -= used;
    if (t.net - used > 0) open.push({ txn_id: t.txn_id, date: t.date, open_amount: t.net - used });
  }
  return { open, advance_amount: credit };
}

export const BUCKETS = [
  { key: 'b0_amount', label: 'أقل من 30 يوم', min: 0, max: 29 },
  { key: 'b30_amount', label: '30 – 60 يوم', min: 30, max: 59 },
  { key: 'b60_amount', label: '60 – 90 يوم', min: 60, max: 89 },
  { key: 'b90_amount', label: 'أكتر من 90 يوم', min: 90, max: Infinity },
];

export const bucketOf = (ageDays) => BUCKETS.find((b) => ageDays >= b.min && ageDays <= b.max) || BUCKETS[0];

function clients(includeInactive = true) {
  return getDb().prepare(`SELECT id, name, phone, credit_limit, is_walk_in, active FROM parties
    WHERE kind = 'client' AND (? OR active = 1) ORDER BY name`).all(includeInactive ? 1 : 0);
}

// ملخص العملاء: every client (also those with no movement), Excel columns + آخر دفعة +
// عمر المديونية (days since the oldest unpaid work, FIFO).
export function clientsSummary({ asOf, includeInactive = true } = {}) {
  const byClient = groupBy(clientTxns(asOf), 'party_id');
  const rows = clients(includeInactive).map((c) => {
    const txns = byClient.get(c.id) || [];
    let debit = 0; let discount = 0; let credit = 0;
    let lastPay = null;
    for (const t of txns) {
      if (t.net > 0) debit += t.net;
      else if (t.net < 0 && t.is_discount) discount -= t.net;
      else if (t.net < 0) {
        credit -= t.net;
        if (!lastPay || t.date >= lastPay.date) lastPay = { date: t.date, amount: -t.net };
      }
    }
    const bal = debit - discount - credit;
    const { open } = fifoOpenDebits(txns);
    const oldest = open[0]?.date || null;
    return {
      id: c.id, name: c.name, phone: c.phone, active: !!c.active, is_walk_in: !!c.is_walk_in,
      debit_total: debit, discount_total: discount, credit_total: credit,
      balance: bal, balance_text: balanceWords(bal).text,
      last_payment_date: lastPay?.date ?? null, last_payment_amount: lastPay?.amount ?? null,
      oldest_open_date: oldest, debt_age_days: oldest && asOf ? daysBetween(oldest, asOf) : null,
      credit_limit: c.credit_limit,
      over_limit: c.credit_limit !== null && bal > c.credit_limit,
    };
  });
  const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
  const totals = {
    debit_total: sum('debit_total'), discount_total: sum('discount_total'), credit_total: sum('credit_total'),
    balance: sum('balance'),
    owes_us_total: rows.reduce((s, r) => s + Math.max(0, r.balance), 0),
    we_owe_total: rows.reduce((s, r) => s - Math.min(0, r.balance), 0),
  };
  totals.balance_text = balanceWords(totals.balance).text;
  return { as_of: asOf, rows, totals, count: rows.length };
}

// أعمار الديون: per client, the FIFO-unpaid work split by age (days from its date to asOf).
// Clients with nothing open are left out unless they paid in advance (shown as دفعة مقدمة).
export function aging({ asOf }) {
  const byClient = groupBy(clientTxns(asOf), 'party_id');
  const names = new Map(clients(true).map((c) => [c.id, c]));
  const rows = [];
  for (const [partyId, txns] of byClient) {
    const c = names.get(partyId);
    if (!c) continue;
    const { open, advance_amount } = fifoOpenDebits(txns);
    if (!open.length && !advance_amount) continue;
    const row = { id: c.id, name: c.name, b0_amount: 0, b30_amount: 0, b60_amount: 0, b90_amount: 0, advance_amount,
      oldest_open_date: open[0]?.date ?? null, debt_age_days: open[0] ? daysBetween(open[0].date, asOf) : null };
    for (const d of open) row[bucketOf(daysBetween(d.date, asOf)).key] += d.open_amount;
    row.open_total = row.b0_amount + row.b30_amount + row.b60_amount + row.b90_amount;
    row.balance = row.open_total - advance_amount;
    rows.push(row);
  }
  rows.sort((a, b) => b.b90_amount - a.b90_amount || b.open_total - a.open_total || a.name.localeCompare(b.name, 'ar'));
  const totals = Object.fromEntries(['b0_amount', 'b30_amount', 'b60_amount', 'b90_amount', 'advance_amount', 'open_total', 'balance']
    .map((k) => [k, rows.reduce((s, r) => s + r[k], 0)]));
  return { as_of: asOf, buckets: BUCKETS.map(({ key, label }) => ({ key, label })), rows, totals };
}

// The oldest unpaid work of one client (for the follow-up tab and the home list).
export function clientDebtAge(partyId, asOf) {
  const { open } = fifoOpenDebits(clientTxns(asOf, partyId));
  return open[0] ? { oldest_open_date: open[0].date, debt_age_days: daysBetween(open[0].date, asOf) } : { oldest_open_date: null, debt_age_days: null };
}

export function lastPayment(partyId, asOf = null) {
  const t = clientTxns(asOf, partyId).filter((x) => x.net < 0 && !x.is_discount).at(-1);
  return t ? { last_payment_date: t.date, last_payment_amount: -t.net } : { last_payment_date: null, last_payment_amount: null };
}
