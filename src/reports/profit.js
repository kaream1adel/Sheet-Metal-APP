// مكسب الشهر: revenue by section − discounts − expenses by category − material purchases
// (− cash count differences), for one month, plus the same figure for the months before it.
// Everything is read from the ledger by transaction date; a reversal inside the month cancels
// its original, a reversal dated in a later month reduces that later month (locked months
// never change).
import { getDb } from '../db.js';
import { SECTIONS, SECTION_NAMES } from '../ledger.js';
import { monthRange, prevMonth, monthName } from './dates.js';

const REVENUE_NAMES = { ...SECTION_NAMES, manual: 'إيرادات أخرى (قيود يدوية)', recharge: 'مصروفات محملة على العملاء' };
const REVENUE_ORDER = [...SECTIONS, 'manual', 'recharge'];

function accountTotals(from, to) {
  return getDb().prepare(`
    SELECT a.code, a.name, a.type, a.expense_category_id, a.sort,
      COALESCE(SUM(p.debit), 0) AS dr, COALESCE(SUM(p.credit), 0) AS cr
    FROM postings p JOIN txns t ON t.id = p.txn_id JOIN accounts a ON a.code = p.account
    WHERE t.date >= ? AND t.date <= ? AND a.type IN ('revenue','expense')
    GROUP BY a.code ORDER BY a.sort, a.code`).all(from, to);
}

export function monthProfit(month) {
  const { from, to } = monthRange(month);
  const rows = accountTotals(from, to);
  const by = new Map(rows.map((r) => [r.code, r]));
  const revenue = REVENUE_ORDER.map((k) => {
    const r = by.get(`revenue:${k}`);
    return { key: k, label: REVENUE_NAMES[k], line_amount: r ? r.cr - r.dr : 0, account: `revenue:${k}` };
  });
  const net = (code) => { const r = by.get(code); return r ? r.dr - r.cr : 0; };
  const expenses = rows.filter((r) => r.code.startsWith('expense:'))
    .map((r) => ({ key: r.code, category_id: r.expense_category_id, label: r.name.replace(/^مصروف: /, ''), line_amount: r.dr - r.cr }))
    .filter((e) => e.line_amount !== 0);
  const revenue_total = revenue.reduce((s, r) => s + r.line_amount, 0);
  const discount_total = net('discount_given');
  const expenses_total = expenses.reduce((s, e) => s + e.line_amount, 0);
  const materials_total = net('materials_purchases');
  const over_short_total = net('cash_over_short');
  const profit_amount = revenue_total - discount_total - expenses_total - materials_total - over_short_total;
  return {
    month, month_name: monthName(month), from, to,
    revenue, revenue_total, discount_total, expenses, expenses_total, materials_total, over_short_total,
    profit_amount,
  };
}

// The chosen month and the n − 1 months before it, oldest first (for the bars).
export function profitSeries(month, n = 6) {
  const out = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const m = prevMonth(month, i);
    const p = monthProfit(m);
    out.push({ month: m, month_name: p.month_name, revenue_total: p.revenue_total,
      costs_total: p.discount_total + p.expenses_total + p.materials_total + p.over_short_total, profit_amount: p.profit_amount });
  }
  return out;
}
