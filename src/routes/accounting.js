// الحسابات (admin): sales, expenses, profit and cash, by month, from the same records
// the client accounts use (never stored totals), plus المصروفات (money going out).
import { Router } from 'express';
import { getDb, audit } from '../db.js';
import { requirePerm } from '../auth.js';
import { entries } from '../ledger.js';
import { toPiastres } from '../money.js';
import { httpError, cleanText, parseDate, todayISO } from '../util.js';
import { getSettings } from '../settings.js';

export const accounting = Router();
const admin = requirePerm('money.view');

// Month-by-month totals between two dates (inclusive), in piastres.
//   sales      = priced work + grouped items (what clients were charged)
//   additions  = positive adjustments, discounts = negative ones
//   collected  = cleared payments, expenses = non-cancelled expenses
//   profit     = sales + additions − discounts − expenses   (work earned, not cash)
//   cash       = collected − expenses                        (money in hand)
export function monthly(from, to) {
  const db = getDb();
  const months = {};
  const row = (m) => (months[m] ||= { month: m, sales: 0, additions: 0, discounts: 0, collected: 0, expenses: 0 });
  for (const { id } of db.prepare('SELECT id FROM clients').all()) {
    for (const e of entries(id)) {
      if (e.kind === 'opening' || e.date < from || e.date > to) continue;
      const r = row(e.date.slice(0, 7));
      if (e.kind === 'charge' || e.kind === 'item') r.sales += e.amount;
      else if (e.kind === 'adjustment') { if (e.amount > 0) r.additions += e.amount; else r.discounts -= e.amount; }
      else if (e.kind === 'payment') r.collected -= e.amount;
    }
  }
  for (const x of db.prepare(`SELECT substr(exp_date, 1, 7) m, SUM(amount) s FROM expenses
    WHERE cancelled_at IS NULL AND exp_date BETWEEN ? AND ? GROUP BY m`).all(from, to)) row(x.m).expenses += x.s;
  const rows = Object.values(months).sort((a, b) => b.month.localeCompare(a.month))
    .map((r) => ({ ...r, profit: r.sales + r.additions - r.discounts - r.expenses, cash: r.collected - r.expenses }));
  const totals = rows.reduce((t, r) => { for (const k of Object.keys(t)) t[k] += r[k]; return t; },
    { sales: 0, additions: 0, discounts: 0, collected: 0, expenses: 0, profit: 0, cash: 0 });
  return { rows, totals };
}

const monthStart = (d = todayISO()) => `${d.slice(0, 7)}-01`;

accounting.get('/accounts/summary', admin, (req, res) => {
  const db = getDb();
  const to = parseDate(req.query.to) || todayISO();
  const from = parseDate(req.query.from) || `${String(Number(to.slice(0, 4)) - 1)}${to.slice(4, 7)}-01`;
  const { rows, totals } = monthly(from, to);
  const thisMonth = monthly(monthStart(to), to).totals;
  const byCategory = db.prepare(`SELECT c.name, SUM(e.amount) amount FROM expenses e JOIN expense_categories c ON c.id = e.category_id
    WHERE e.cancelled_at IS NULL AND e.exp_date BETWEEN ? AND ? GROUP BY c.id ORDER BY amount DESC`).all(monthStart(to), to);
  res.json({ from, to, rows, totals, this_month: thisMonth, by_category: byCategory });
});

// ---------- المصروفات ----------
accounting.get('/expenses', admin, (req, res) => {
  const db = getDb();
  const from = parseDate(req.query.from) || monthStart();
  const to = parseDate(req.query.to) || todayISO();
  const rows = db.prepare(`SELECT e.*, c.name AS category_name, u.display_name AS created_by_name FROM expenses e
    JOIN expense_categories c ON c.id = e.category_id LEFT JOIN users u ON u.id = e.created_by
    WHERE e.exp_date BETWEEN ? AND ? AND (? IS NULL OR e.category_id = ?)
    ORDER BY e.exp_date DESC, e.id DESC LIMIT 500`).all(from, to, req.query.category ?? null, req.query.category ?? null);
  const categories = db.prepare('SELECT * FROM expense_categories ORDER BY active DESC, sort, name').all().map((c) => ({ ...c, active: !!c.active }));
  res.json({ from, to, expenses: rows, categories, methods: getSettings().payment_methods });
});

accounting.post('/expenses', admin, (req, res) => {
  const db = getDb();
  const b = req.body || {};
  const amount = toPiastres(b.amount);
  if (!(amount > 0)) throw httpError(400, 'اكتب المبلغ (أكبر من صفر)');
  const date = b.exp_date ? parseDate(b.exp_date) : todayISO();
  if (!date) throw httpError(400, 'التاريخ غلط');
  const cat = db.prepare('SELECT * FROM expense_categories WHERE id = ? AND active = 1').get(b.category_id);
  if (!cat) throw httpError(400, 'اختار نوع المصروف');
  const e = { exp_date: date, category_id: cat.id, amount, method: cleanText(b.method, 40), payee: cleanText(b.payee, 80), notes: cleanText(b.notes, 300) };
  const id = db.transaction(() => {
    const r = db.prepare('INSERT INTO expenses (exp_date, category_id, amount, method, payee, notes, created_by) VALUES (?,?,?,?,?,?,?)')
      .run(e.exp_date, e.category_id, e.amount, e.method, e.payee, e.notes, req.user.id);
    audit(req.user.id, 'create', 'expense', r.lastInsertRowid, undefined, e);
    return r.lastInsertRowid;
  })();
  res.status(201).json({ expense: db.prepare('SELECT * FROM expenses WHERE id = ?').get(id) });
});

accounting.post('/expenses/:id/cancel', admin, (req, res) => {
  const db = getDb();
  const e = db.prepare('SELECT * FROM expenses WHERE id = ?').get(req.params.id);
  if (!e) throw httpError(404, 'المصروف مش موجود');
  if (e.cancelled_at) throw httpError(409, 'المصروف ده متلغي بالفعل');
  const reason = cleanText(req.body?.reason, 200);
  if (!reason) throw httpError(400, 'اكتب سبب الإلغاء');
  db.transaction(() => {
    db.prepare("UPDATE expenses SET cancelled_at = datetime('now'), cancelled_by = ?, cancel_reason = ? WHERE id = ?").run(req.user.id, reason, e.id);
    audit(req.user.id, 'cancel', 'expense', e.id, { amount: e.amount }, { reason });
  })();
  res.json({ ok: true });
});

accounting.post('/expense-categories', admin, (req, res) => {
  const db = getDb();
  const name = cleanText(req.body?.name, 40);
  if (!name) throw httpError(400, 'اكتب اسم النوع');
  if (db.prepare('SELECT 1 FROM expense_categories WHERE name = ?').get(name)) throw httpError(409, 'النوع ده موجود');
  const sort = db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 n FROM expense_categories').get().n;
  const r = db.prepare('INSERT INTO expense_categories (name, sort) VALUES (?, ?)').run(name, sort);
  audit(req.user.id, 'create', 'expense_category', r.lastInsertRowid, undefined, { name });
  res.status(201).json({ category: { id: r.lastInsertRowid, name, active: true } });
});
