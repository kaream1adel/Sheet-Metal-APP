// The double-entry ledger: the single source of truth for every balance.
//
//   post(kind, date, description, lines, refs)   one balanced transaction (atomic, audited)
//   reverse(txnId, reason, opts)                 cancel = a reversing transaction
//   balance(account, partyId?, opts)             debit − credit
//   partyBalance(partyId) / partyBalances(kind)  on the party's control account
//   statement(partyId, from?, to?)               كشف حساب: مدين / خصم / دائن / الرصيد
//   accountBalances(opts)                        every account with its balance
//   nextSerial(prefix)                           "تش-0001" from the sequences table
//   isMonthLocked / assertMonthOpen / lockMonth / unlockMonth
//
// Posted transactions are never edited or deleted. Only their status moves to 'reversed'
// (with reversed_by) when a reversing transaction is posted for them.
import { getDb, audit } from './db.js';
import { httpError, parseDate } from './util.js';
import { balanceWords, formatMoney } from './money.js';

// The control account of each kind of party.
export const CONTROL_ACCOUNT = { client: 'receivable', supplier: 'payable', partner: 'partner', worker: 'worker' };

export const SECTIONS = ['press', 'shear', 'laser', 'punch', 'louver', 'material'];
export const SECTION_NAMES = { press: 'التناية', shear: 'المقص', laser: 'الليزر', punch: 'البنش', louver: 'اللوفر', material: 'خامة من عندنا' };
export const MACHINES = ['press', 'shear', 'laser', 'punch'];
export const MACHINE_NAMES = { press: 'التناية', shear: 'المقص', laser: 'الليزر', punch: 'البنش' };

// ---------- serial numbers ----------
export function nextSerial(prefix) {
  const db = getDb();
  return db.transaction(() => {
    const row = db.prepare('SELECT next FROM sequences WHERE prefix = ?').get(prefix);
    if (!row) throw new Error(`unknown serial prefix ${prefix}`);
    db.prepare('UPDATE sequences SET next = next + 1 WHERE prefix = ?').run(prefix);
    return `${prefix}-${String(row.next).padStart(4, '0')}`;
  })();
}

// ---------- month lock ----------
const monthOf = (date) => String(date).slice(0, 7);

export function isMonthLocked(date) {
  return !!getDb().prepare('SELECT 1 FROM month_locks WHERE month = ?').get(monthOf(date));
}

export function assertMonthOpen(date) {
  if (isMonthLocked(date)) {
    throw httpError(409, `شهر ${monthOf(date)} مقفول. الأدمن يقدر يفتحه من الإعدادات ← إقفال الشهر مع ذكر السبب.`);
  }
}

export function listMonthLocks() {
  return getDb().prepare(`SELECT m.*, u.display_name AS locked_by_name FROM month_locks m
    LEFT JOIN users u ON u.id = m.locked_by ORDER BY m.month DESC`).all();
}

export function lockMonth(month, userId, note = '') {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month))) throw httpError(400, 'الشهر لازم يكون بالشكل 2026-10');
  const db = getDb();
  db.transaction(() => {
    if (db.prepare('SELECT 1 FROM month_locks WHERE month = ?').get(month)) throw httpError(409, 'الشهر ده مقفول بالفعل');
    db.prepare('INSERT INTO month_locks (month, locked_by, note) VALUES (?, ?, ?)').run(month, userId ?? null, String(note || '').slice(0, 300));
    audit(userId, 'lock', 'month', null, undefined, { month, note });
  })();
}

export function unlockMonth(month, userId, reason) {
  const r = String(reason || '').trim();
  if (!r) throw httpError(400, 'اكتب سبب فتح الشهر');
  const db = getDb();
  db.transaction(() => {
    const cur = db.prepare('SELECT * FROM month_locks WHERE month = ?').get(month);
    if (!cur) throw httpError(404, 'الشهر ده مش مقفول');
    db.prepare('DELETE FROM month_locks WHERE month = ?').run(month);
    audit(userId, 'unlock', 'month', null, cur, { month, reason: r });
  })();
}

// ---------- posting ----------
const accountCache = new Map();
function accountOf(code) {
  // Accounts are added (expense categories) but never change kind, so a cache is safe;
  // a miss always re-reads.
  let a = accountCache.get(code);
  if (!a) {
    a = getDb().prepare('SELECT * FROM accounts WHERE code = ?').get(code);
    if (a) accountCache.set(code, a);
  }
  return a;
}
export const clearAccountCache = () => accountCache.clear();

const isAmount = (v) => Number.isSafeInteger(v) && v >= 0;

// lines: [{ account, party_id?, debit?, credit?, cost_party_id?, section?, memo? }]
// refs:  { userId, ref, docType, docId, partyId, importRunId, reversalOf, reason }
// Returns the transaction with its postings. Throws (and writes nothing) if anything is off.
export function post(kind, date, description, lines, refs = {}) {
  const db = getDb();
  const d = parseDate(date);
  if (!d) throw httpError(400, 'تاريخ القيد غلط');
  if (!kind || typeof kind !== 'string') throw new Error('post: kind is required');
  if (!Array.isArray(lines) || lines.length < 2) throw httpError(400, 'القيد لازم يكون فيه طرفين على الأقل');

  let debit = 0;
  let credit = 0;
  const clean = lines.map((l, i) => {
    const a = accountOf(l.account);
    if (!a) throw httpError(400, `حساب غير معروف: ${l.account}`);
    if (!a.active) throw httpError(400, `الحساب ${a.name} موقوف`);
    const dr = l.debit ?? 0;
    const cr = l.credit ?? 0;
    if (!isAmount(dr) || !isAmount(cr)) throw httpError(400, `مبلغ غلط في السطر ${i + 1} (لازم مليمات صحيحة)`);
    if ((dr > 0) === (cr > 0)) throw httpError(400, `السطر ${i + 1} لازم يكون مدين أو دائن بس`);
    let partyId = l.party_id ?? null;
    if (a.party_kind) {
      if (!partyId) throw httpError(400, `حساب ${a.name} محتاج اسم الطرف`);
      const p = db.prepare('SELECT kind FROM parties WHERE id = ?').get(partyId);
      if (!p) throw httpError(400, 'الطرف مش موجود');
      if (p.kind !== a.party_kind) throw httpError(400, `حساب ${a.name} مش لنوع الطرف ده`);
    } else if (partyId) {
      throw httpError(400, `حساب ${a.name} مش بيتسجل على طرف`);
    }
    if (l.cost_party_id && !db.prepare('SELECT 1 FROM parties WHERE id = ?').get(l.cost_party_id)) {
      throw httpError(400, 'مركز التكلفة مش موجود');
    }
    debit += dr;
    credit += cr;
    return { account: a.code, party_id: partyId, debit: dr, credit: cr, cost_party_id: l.cost_party_id ?? null,
      section: l.section ?? null, memo: String(l.memo ?? '').slice(0, 300) };
  });
  if (debit !== credit) {
    // Below a piastre formatMoney would show two equal numbers: show the millimes too.
    const fmt = Math.abs(debit - credit) < 10 ? (m) => (m / 1000).toFixed(3) : (m) => formatMoney(m);
    throw httpError(400, `القيد مش متوازن: مدين ${fmt(debit)} ودائن ${fmt(credit)}`);
  }
  if (debit <= 0) throw httpError(400, 'القيد لازم يكون بمبلغ أكبر من صفر');
  if (!Number.isSafeInteger(debit)) throw httpError(400, 'المبلغ كبير قوي');

  return db.transaction(() => {
    assertMonthOpen(d);
    const serial = nextSerial('قد');
    const r = db.prepare(`INSERT INTO txns (serial, ref, kind, date, description, doc_type, doc_id, party_id,
        reversal_of, reason, import_run_id, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(serial, String(refs.ref ?? ''), kind, d, String(description ?? '').slice(0, 500), refs.docType ?? null,
        refs.docId ?? null, refs.partyId ?? null, refs.reversalOf ?? null, String(refs.reason ?? '').slice(0, 500),
        refs.importRunId ?? null, refs.userId ?? null);
    const id = Number(r.lastInsertRowid);
    const ins = db.prepare(`INSERT INTO postings (txn_id, account, party_id, debit, credit, cost_party_id, section, memo)
      VALUES (?,?,?,?,?,?,?,?)`);
    for (const l of clean) ins.run(id, l.account, l.party_id, l.debit, l.credit, l.cost_party_id, l.section, l.memo);
    const txn = getTxn(id);
    // Imports write thousands of rows: their audit is the import run itself.
    if (!refs.importRunId) audit(refs.userId, 'post', 'txn', id, undefined, { serial, kind, date: d, total: debit, ref: refs.ref ?? '' });
    return txn;
  })();
}

export function getTxn(id) {
  const db = getDb();
  const t = db.prepare('SELECT * FROM txns WHERE id = ?').get(id);
  if (!t) return null;
  t.postings = db.prepare('SELECT * FROM postings WHERE txn_id = ? ORDER BY id').all(id);
  t.total = t.postings.reduce((s, p) => s + p.debit, 0);
  return t;
}

// Cancels a posted transaction by posting its mirror image. The reversal is dated today
// (or opts.date), so a locked month's figures never change. With opts.atOriginalDate the
// reversal takes the original's own date while that month is open, so cancelling or
// correcting a document never moves revenue/profit from one open month into another;
// once that month is locked it falls back to today.
export function reverse(txnId, reason, opts = {}) {
  const r = String(reason || '').trim();
  if (!r) throw httpError(400, 'اكتب سبب الإلغاء');
  const db = getDb();
  return db.transaction(() => {
    const t = getTxn(txnId);
    if (!t) throw httpError(404, 'القيد مش موجود');
    if (t.status === 'reversed') throw httpError(409, 'القيد ده اتلغى قبل كده');
    if (t.reversal_of) throw httpError(409, 'ده قيد إلغاء — لو محتاج ترجعه اعمل قيد جديد');
    const lines = t.postings.map((p) => ({ account: p.account, party_id: p.party_id, debit: p.credit, credit: p.debit,
      cost_party_id: p.cost_party_id, section: p.section, memo: p.memo }));
    const date = opts.date || (opts.atOriginalDate && !isMonthLocked(t.date) ? t.date : todayLocal());
    const rev = post(`reversal`, date, `إلغاء: ${t.description}`.slice(0, 500), lines, {
      userId: opts.userId, ref: t.ref, docType: t.doc_type, docId: t.doc_id, partyId: t.party_id,
      reversalOf: t.id, reason: r, importRunId: opts.importRunId,
    });
    db.prepare("UPDATE txns SET status = 'reversed', reversed_by = ? WHERE id = ?").run(rev.id, t.id);
    audit(opts.userId, 'reverse', 'txn', t.id, { status: 'posted' }, { status: 'reversed', reversed_by: rev.id, reason: r });
    return rev;
  })();
}

function todayLocal(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------- reading ----------
// debit − credit. Reversed transactions still count: their reversal cancels them out.
export function balance(account, partyId = null, { asOf = null, from = null } = {}) {
  const r = getDb().prepare(`
    SELECT COALESCE(SUM(p.debit), 0) - COALESCE(SUM(p.credit), 0) AS b
    FROM postings p JOIN txns t ON t.id = p.txn_id
    WHERE p.account = ? AND (? IS NULL OR p.party_id = ?)
      AND (? IS NULL OR t.date <= ?) AND (? IS NULL OR t.date >= ?)`)
    .get(account, partyId, partyId, asOf, asOf, from, from);
  return r.b;
}

export function partyAccount(party) {
  const acc = CONTROL_ACCOUNT[party.kind];
  if (!acc) throw new Error(`no control account for ${party.kind}`);
  return acc;
}

export function partyBalance(partyId, opts = {}) {
  const p = getDb().prepare('SELECT id, kind FROM parties WHERE id = ?').get(partyId);
  if (!p) return 0;
  return balance(partyAccount(p), p.id, opts);
}

// { partyId: balance } for every party of one kind that has postings (as of a date when given).
export function partyBalances(kind, { asOf = null } = {}) {
  const acc = CONTROL_ACCOUNT[kind];
  const rows = getDb().prepare(`SELECT p.party_id, SUM(p.debit) - SUM(p.credit) AS b
    FROM postings p JOIN txns t ON t.id = p.txn_id
    WHERE p.account = ? AND p.party_id IS NOT NULL AND (? IS NULL OR t.date <= ?)
    GROUP BY p.party_id`).all(acc, asOf, asOf);
  return Object.fromEntries(rows.map((r) => [r.party_id, r.b]));
}

export function accountBalances({ asOf = null } = {}) {
  return getDb().prepare(`
    SELECT a.code, a.name, a.type, a.party_kind,
      COALESCE(SUM(p.debit), 0) AS debit, COALESCE(SUM(p.credit), 0) AS credit,
      COALESCE(SUM(p.debit), 0) - COALESCE(SUM(p.credit), 0) AS balance
    FROM accounts a
    LEFT JOIN postings p ON p.account = a.code
      AND (? IS NULL OR p.txn_id IN (SELECT id FROM txns WHERE date <= ?))
    GROUP BY a.code ORDER BY a.sort, a.code`).all(asOf, asOf);
}

// كشف حساب. One row per transaction that touches the party's control account:
//   debit    مدين  — what he owes more (work, manual debits, recharges)
//   discount خصم   — credits that come from a discount (the txn debits discount_given)
//   credit   دائن  — other credits (payments, cheques collected)
//   balance  الرصيد — running debit − credit; words via balanceWords()
// Reversed transactions and their reversals both show (status / reversal_of), so the
// history is honest; pass { hideReversed: true } to leave out every pair whose two halves
// both fall inside the range (they cancel out). A pair that crosses the range boundary
// stays visible: the opening holds one half, so hiding the other would break the balance.
export function statement(partyId, from = null, to = null, { hideReversed = false } = {}) {
  const db = getDb();
  const party = db.prepare('SELECT * FROM parties WHERE id = ?').get(partyId);
  if (!party) throw httpError(404, 'الطرف مش موجود');
  const f = from ? parseDate(from) : null;
  const t = to ? parseDate(to) : null;
  if (f === undefined || t === undefined) throw httpError(400, 'التاريخ غلط');
  const account = partyAccount(party);
  const opening = f ? balance(account, party.id, { asOf: prevDay(f) }) : 0;
  const rows = db.prepare(`
    SELECT t.id AS txn_id, t.serial, t.ref, t.kind, t.date, t.description, t.doc_type, t.doc_id,
      t.status, t.reversal_of, t.reversed_by, t.reason,
      SUM(p.debit) AS dr, SUM(p.credit) AS cr,
      EXISTS (SELECT 1 FROM postings x WHERE x.txn_id = t.id AND x.account = 'discount_given') AS is_discount
    FROM postings p JOIN txns t ON t.id = p.txn_id
    WHERE p.account = ? AND p.party_id = ?
      AND (? IS NULL OR t.date >= ?) AND (? IS NULL OR t.date <= ?)
    GROUP BY t.id ORDER BY t.date, t.id`).all(account, party.id, f, f, t, t);

  let running = opening;
  const out = [];
  const totals = { debit: 0, discount: 0, credit: 0 };
  const inRange = new Set(rows.map((r) => r.txn_id));
  for (const r of rows) {
    if (hideReversed && ((r.status === 'reversed' && inRange.has(r.reversed_by)) || (r.reversal_of && inRange.has(r.reversal_of)))) continue;
    const net = r.dr - r.cr; // one txn may touch the account on both sides (rare): show the net
    const row = {
      txn_id: r.txn_id, serial: r.serial, ref: r.ref, kind: r.kind, date: r.date, description: r.description,
      doc_type: r.doc_type, doc_id: r.doc_id, status: r.status, reversal_of: r.reversal_of, reversed_by: r.reversed_by,
      reason: r.reason, debit: 0, discount: 0, credit: 0,
    };
    if (net > 0) row.debit = net;
    else if (net < 0 && r.is_discount) row.discount = -net;
    else if (net < 0) row.credit = -net;
    totals.debit += row.debit;
    totals.discount += row.discount;
    totals.credit += row.credit;
    running += net;
    row.balance = running;
    row.balance_text = balanceWords(running).text;
    out.push(row);
  }
  // Client cheques we hold but have not collected: «تحت التحصيل», memo only (no balance effect).
  const pending = party.kind === 'client'
    ? db.prepare(`SELECT id, serial, number, bank, amount, due_date, status, received_date FROM cheques
        WHERE direction = 'in' AND party_id = ? AND status IN ('in_portfolio','deposited') ORDER BY due_date`).all(party.id)
    : [];
  return {
    party: { id: party.id, kind: party.kind, name: party.name },
    account, from: f, to: t,
    opening, opening_text: balanceWords(opening).text,
    rows: out, totals,
    closing: running, closing_text: balanceWords(running).text,
    pending_cheques: pending,
    pending_cheques_amount: pending.reduce((s, c) => s + c.amount, 0),
  };
}

function prevDay(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// Account for a new expense category (expense:<id>). Called when a category is created.
export function ensureExpenseAccount(category) {
  getDb().prepare(`INSERT INTO accounts (code, name, type, expense_category_id, sort) VALUES (?, ?, 'expense', ?, ?)
    ON CONFLICT(code) DO UPDATE SET name = excluded.name`).run(`expense:${category.id}`, `مصروف: ${category.name}`, category.id, 100 + (category.sort || 0));
  accountCache.delete(`expense:${category.id}`);
}
