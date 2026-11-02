// التدفق المتوقع: the next 4 weeks, starting from today's cash + bank.
//   in : client cheques we hold (في الحافظة / مودع) by due date
//   out: our cheques not cleared yet (أوراق الدفع) by due date, and the recurring expenses
//        paid from the cash or the bank (a partner paying from his pocket moves no cash)
// Cheques already past their date and still open land in week 1 (marked late).
// running_balance after each week; a week that ends below zero is flagged.
import { getDb } from '../db.js';
import { balance } from '../ledger.js';
import { addDays } from './dates.js';

export function expectedCashflow(asOf, weeks = 4) {
  const db = getDb();
  const cash_balance = balance('cash');
  const bank_balance = balance('bank');
  const end = addDays(asOf, weeks * 7 - 1);
  const chequesIn = db.prepare(`SELECT c.id, c.serial, c.number, c.amount, c.due_date, p.name AS party_name FROM cheques c
    LEFT JOIN parties p ON p.id = c.party_id
    WHERE c.direction = 'in' AND c.status IN ('in_portfolio','deposited') AND c.due_date IS NOT NULL AND c.due_date <= ?
    ORDER BY c.due_date, c.id`).all(end);
  const chequesOut = db.prepare(`SELECT c.id, c.serial, c.number, c.amount, c.due_date, p.name AS party_name FROM cheques c
    LEFT JOIN parties p ON p.id = c.party_id
    WHERE c.direction = 'out' AND c.status = 'issued' AND c.due_date IS NOT NULL AND c.due_date <= ?
    ORDER BY c.due_date, c.id`).all(end);
  const recurring = db.prepare(`SELECT r.*, c.name AS category_name FROM recurring_expenses r
    JOIN expense_categories c ON c.id = r.category_id WHERE r.active = 1 AND r.paid_from IN ('cash','bank')`).all();

  const list = [];
  for (let i = 0; i < weeks; i += 1) {
    const from = addDays(asOf, i * 7);
    list.push({ index: i + 1, from, to: addDays(from, 6), items: [], in_amount: 0, out_amount: 0 });
  }
  const weekOf = (date) => list[Math.max(0, Math.min(weeks - 1, Math.floor((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${asOf}T12:00:00Z`)) / (7 * 86400000))))];
  for (const c of chequesIn) {
    const w = weekOf(c.due_date < asOf ? asOf : c.due_date);
    w.items.push({ kind: 'cheque_in', date: c.due_date, label: `شيك من ${c.party_name || 'عميل'} رقم ${c.number || c.serial}`, in_amount: c.amount, late: c.due_date < asOf, href: '#/cheques/in' });
    w.in_amount += c.amount;
  }
  for (const c of chequesOut) {
    const w = weekOf(c.due_date < asOf ? asOf : c.due_date);
    w.items.push({ kind: 'cheque_out', date: c.due_date, label: `شيك لـ ${c.party_name || 'طرف'} رقم ${c.number || c.serial}`, out_amount: c.amount, late: c.due_date < asOf, href: '#/cheques/out' });
    w.out_amount += c.amount;
  }
  // Every day of the window whose day-of-month matches, unless that month is already paid.
  for (let d = asOf; d <= end; d = addDays(d, 1)) {
    const day = Number(d.slice(8, 10));
    for (const r of recurring) {
      if (r.day_of_month !== day) continue;
      if (r.last_month && r.last_month >= d.slice(0, 7)) continue;
      const w = weekOf(d);
      w.items.push({ kind: 'recurring', date: d, label: `${r.category_name}${r.description ? ` — ${r.description}` : ''} (متكرر)`, out_amount: r.amount, late: false, href: '#/expenses/recurring' });
      w.out_amount += r.amount;
    }
  }
  let running = cash_balance + bank_balance;
  for (const w of list) {
    w.items.sort((a, b) => a.date.localeCompare(b.date));
    w.net_amount = w.in_amount - w.out_amount;
    running += w.net_amount;
    w.running_balance = running;
    w.negative = running < 0;
  }
  return {
    as_of: asOf, to: end,
    cash_balance, bank_balance, opening_balance: cash_balance + bank_balance,
    weeks: list,
    in_total: list.reduce((s, w) => s + w.in_amount, 0),
    out_total: list.reduce((s, w) => s + w.out_amount, 0),
    closing_balance: running,
    first_negative_week: list.find((w) => w.negative)?.index ?? null,
  };
}
