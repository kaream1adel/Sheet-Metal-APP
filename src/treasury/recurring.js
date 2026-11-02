// المصروفات المتكررة: monthly templates (rent, salaries, electricity...). From the first of each
// month every active template has a draft for that month (and for any earlier month since it
// started that nobody handled). The admin confirms a draft with one click (it becomes a إذن صرف
// through createVoucher) or skips it with a reason. Each handled month is a row in
// recurring_runs, so a month is never prepared or posted twice.
import { getDb, audit } from '../db.js';
import { httpError } from '../util.js';
import { createVoucher } from './documents.js';
import { bad, realDate, amountIn, partyOf, text, today, isRealMonth } from './common.js';

const SOURCES = ['cash', 'bank', 'partner'];
const MAX_BACK = 12; // months of unhandled drafts shown at most

function input(b, cur = null) {
  const db = getDb();
  const out = {
    category_id: b.category_id !== undefined ? Number(b.category_id) : cur?.category_id,
    description: b.description !== undefined ? text(b.description, 200) : cur?.description ?? '',
    amount: b.amount !== undefined ? amountIn(b.amount) : cur?.amount,
    day_of_month: b.day_of_month !== undefined ? Number(b.day_of_month) : cur?.day_of_month ?? 1,
    paid_from: b.paid_from !== undefined ? b.paid_from : cur?.paid_from ?? 'cash',
    paid_from_party_id: b.paid_from_party_id !== undefined ? (b.paid_from_party_id ? Number(b.paid_from_party_id) : null) : cur?.paid_from_party_id ?? null,
    cost_party_id: b.cost_party_id !== undefined ? (b.cost_party_id ? Number(b.cost_party_id) : null) : cur?.cost_party_id ?? null,
    active: b.active !== undefined ? (b.active ? 1 : 0) : cur?.active ?? 1,
    start_month: b.start_month !== undefined ? isRealMonth(b.start_month) : cur?.start_month ?? today().slice(0, 7),
  };
  const cat = out.category_id ? db.prepare('SELECT * FROM expense_categories WHERE id = ?').get(out.category_id) : null;
  if (!cat) throw bad('category_id', 'اختار بند المصروف');
  if (out.amount === undefined) throw bad('amount', 'اكتب المبلغ');
  if (!Number.isInteger(out.day_of_month) || out.day_of_month < 1 || out.day_of_month > 28) throw bad('day_of_month', 'يوم الشهر من 1 لـ 28');
  if (!SOURCES.includes(out.paid_from)) throw bad('paid_from', 'اختار بيتصرف منين');
  if (out.paid_from === 'partner') partyOf(out.paid_from_party_id, 'partner', 'paid_from_party_id', 'الشريك');
  else out.paid_from_party_id = null;
  if (out.cost_party_id) partyOf(out.cost_party_id, 'client', 'cost_party_id', 'العميل');
  if (!out.start_month) throw bad('start_month', 'شهر البداية غلط');
  if (!out.description) out.description = cat.name;
  return out;
}

export function createRecurring(b = {}, ctx = {}) {
  const db = getDb();
  const r = input(b);
  return db.transaction(() => {
    const id = Number(db.prepare(`INSERT INTO recurring_expenses (category_id, description, amount, day_of_month, paid_from,
        paid_from_party_id, cost_party_id, active, start_month, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(r.category_id, r.description, r.amount, r.day_of_month, r.paid_from, r.paid_from_party_id, r.cost_party_id, r.active,
        r.start_month, ctx.userId ?? null).lastInsertRowid);
    audit(ctx.userId, 'create', 'recurring_expense', id, undefined, r);
    return getRecurring(id);
  })();
}

// A template is not a posted document: it may be changed (audited). Months already
// confirmed keep their own voucher.
export function updateRecurring(id, b = {}, ctx = {}) {
  const db = getDb();
  const cur = db.prepare('SELECT * FROM recurring_expenses WHERE id = ?').get(Number(id));
  if (!cur) throw httpError(404, 'المصروف المتكرر مش موجود');
  const r = input(b, cur);
  return db.transaction(() => {
    db.prepare(`UPDATE recurring_expenses SET category_id=?, description=?, amount=?, day_of_month=?, paid_from=?, paid_from_party_id=?,
      cost_party_id=?, active=?, start_month=? WHERE id=?`).run(r.category_id, r.description, r.amount, r.day_of_month, r.paid_from,
      r.paid_from_party_id, r.cost_party_id, r.active, r.start_month, cur.id);
    audit(ctx.userId, 'update', 'recurring_expense', cur.id, cur, r);
    return getRecurring(cur.id);
  })();
}

const SELECT = `SELECT r.*, c.name AS category_name, pp.name AS paid_from_party_name, cp.name AS cost_party_name
  FROM recurring_expenses r JOIN expense_categories c ON c.id = r.category_id
  LEFT JOIN parties pp ON pp.id = r.paid_from_party_id LEFT JOIN parties cp ON cp.id = r.cost_party_id`;

export function getRecurring(id) {
  const r = getDb().prepare(`${SELECT} WHERE r.id = ?`).get(Number(id));
  if (!r) throw httpError(404, 'المصروف المتكرر مش موجود');
  return { ...r, active: !!r.active };
}

export function listRecurring() {
  const db = getDb();
  return db.prepare(`${SELECT} ORDER BY r.active DESC, r.day_of_month, c.sort`).all().map((r) => ({
    ...r, active: !!r.active,
    last_run: db.prepare('SELECT month, status, voucher_id FROM recurring_runs WHERE recurring_id = ? ORDER BY month DESC LIMIT 1').get(r.id) || null,
  }));
}

function monthsBetween(from, to) {
  const out = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

// Drafts waiting for the admin, up to the month of `asOf` (today by default).
export function recurringDrafts(asOf = today()) {
  const db = getDb();
  const month = asOf.slice(0, 7);
  const done = db.prepare('SELECT month FROM recurring_runs WHERE recurring_id = ?');
  const drafts = [];
  for (const r of listRecurring().filter((x) => x.active)) {
    const start = r.start_month || r.created_at.slice(0, 7);
    if (start > month) continue;
    const handled = new Set(done.all(r.id).map((x) => x.month));
    for (const m of monthsBetween(start, month).slice(-MAX_BACK)) {
      if (handled.has(m)) continue;
      const due = `${m}-${String(r.day_of_month).padStart(2, '0')}`;
      drafts.push({
        recurring_id: r.id, month: m, due_date: due,
        // Confirming this month's draft today posts it today; an older month keeps its own day.
        date: m === month ? (asOf < due ? asOf : due) : due,
        amount: r.amount, category_id: r.category_id, category_name: r.category_name, description: r.description,
        paid_from: r.paid_from, paid_from_party_id: r.paid_from_party_id, paid_from_party_name: r.paid_from_party_name,
        cost_party_id: r.cost_party_id, cost_party_name: r.cost_party_name, overdue: m < month,
      });
    }
  }
  return drafts.sort((a, b) => a.due_date.localeCompare(b.due_date));
}

// One click: the draft becomes a إذن صرف. input may change { amount, date } for this month only.
export function confirmDraft(recurringId, month, b = {}, ctx = {}) {
  const db = getDb();
  if (!isRealMonth(month)) throw bad('month', 'الشهر غلط');
  return db.transaction(() => {
    const d = recurringDrafts(b.as_of || today()).find((x) => x.recurring_id === Number(recurringId) && x.month === month);
    if (!d) throw httpError(409, 'الشهر ده اتسجل أو اتخطى قبل كده');
    const date = b.date ? realDate(b.date) : d.date;
    if (date.slice(0, 7) !== month) throw bad('date', `التاريخ لازم يكون جوه شهر ${month}`);
    const v = createVoucher({
      kind: 'expense', date, paid_from: d.paid_from, paid_from_party_id: d.paid_from_party_id,
      description: `${d.description} — شهر ${month}`, recurring_id: d.recurring_id,
      lines: [{ category_id: d.category_id, cost_party_id: d.cost_party_id, ...(b.amount !== undefined && b.amount !== '' ? { amount: b.amount } : { amount_millimes: d.amount }) }],
    }, ctx);
    db.prepare(`INSERT INTO recurring_runs (recurring_id, month, status, voucher_id, created_by) VALUES (?, ?, 'confirmed', ?, ?)`)
      .run(d.recurring_id, month, v.id, ctx.userId ?? null);
    audit(ctx.userId, 'confirm', 'recurring_expense', d.recurring_id, undefined, { month, voucher_id: v.id });
    return v;
  })();
}

export function confirmAllDrafts(asOf = today(), ctx = {}) {
  const db = getDb();
  return db.transaction(() => recurringDrafts(asOf).map((d) => confirmDraft(d.recurring_id, d.month, { as_of: asOf }, ctx)))();
}

export function skipDraft(recurringId, month, reason, ctx = {}) {
  const db = getDb();
  const r = text(reason, 300);
  if (!r) throw bad('reason', 'اكتب سبب التخطي');
  if (!isRealMonth(month)) throw bad('month', 'الشهر غلط');
  return db.transaction(() => {
    const d = recurringDrafts(ctx.asOf || today()).find((x) => x.recurring_id === Number(recurringId) && x.month === month);
    if (!d) throw httpError(409, 'الشهر ده اتسجل أو اتخطى قبل كده');
    db.prepare(`INSERT INTO recurring_runs (recurring_id, month, status, reason, created_by) VALUES (?, ?, 'skipped', ?, ?)`)
      .run(d.recurring_id, month, r, ctx.userId ?? null);
    audit(ctx.userId, 'skip', 'recurring_expense', d.recurring_id, undefined, { month, reason: r });
    return { recurring_id: d.recurring_id, month };
  })();
}
