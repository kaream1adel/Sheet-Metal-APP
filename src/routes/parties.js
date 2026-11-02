// الأطراف: clients, suppliers, partners and workers — one name per kind (other spellings are
// aliases), balances from the ledger for users who may see money, and the كشف حساب.
import { Router } from 'express';
import { getDb, audit } from '../db.js';
import { requireUser } from '../auth.js';
import { can, canAny } from '../permissions.js';
import { parseMoney, stripMoney, balanceWords } from '../money.js';
import { httpError, cleanText, parseDate, foldName, todayISO } from '../util.js';
import { statement, partyBalances, partyBalance, post, CONTROL_ACCOUNT } from '../ledger.js';

export const parties = Router();

export const KINDS = { client: 'عميل', supplier: 'مورد', partner: 'شريك', worker: 'عامل' };

// Who may add or change a party of each kind.
const EDIT_PERMS = {
  client: ['operations.record', 'workorders', 'money.post', 'pricing'],
  supplier: ['money.post', 'treasury', 'expenses.record'],
  worker: ['money.post', 'treasury', 'expenses.record'],
  partner: ['money.post'],
};
const mayEdit = (user, kind) => canAny(user, ...(EDIT_PERMS[kind] || []));

// Partners are money only: without money.view they do not exist (list, one, similar, statement).
const MONEY_ONLY_KINDS = new Set(['partner']);
const maySee = (user, kind) => !MONEY_ONLY_KINDS.has(kind) || can(user, 'money.view');
const assertMaySee = (user, kind) => { if (!maySee(user, kind)) throw httpError(403, 'مش مسموح لك بالحركة دي'); };

const parseAliases = (s) => { try { return JSON.parse(s || '[]'); } catch { return []; } };

export function partyRow(p, user, bal) {
  const row = {
    id: p.id, kind: p.kind, kind_name: KINDS[p.kind], name: p.name, aliases: parseAliases(p.aliases),
    phone: p.phone, notes: p.notes, credit_limit: p.credit_limit, is_walk_in: !!p.is_walk_in, active: !!p.active,
    created_at: p.created_at,
  };
  if (can(user, 'money.view')) {
    row.balance = bal ?? partyBalance(p.id);
    row.balance_text = balanceWords(row.balance).text;
  }
  return stripMoney(user, row);
}

// A name that folds to (or contains) an existing name or alias of the same kind is very
// likely the same party written differently. Asked once; { force: true } adds it anyway.
export function similarParties(kind, names, exceptId = null) {
  const wanted = names.map(foldName).filter(Boolean);
  if (!wanted.length) return [];
  const rows = getDb().prepare('SELECT id, name, aliases FROM parties WHERE kind = ? AND id IS NOT ?').all(kind, exceptId);
  return rows.filter((p) => [p.name, ...parseAliases(p.aliases)].map(foldName).some((g) => wanted.some((f) =>
    g === f || (Math.min(g.length, f.length) >= 3 && (g.includes(f) || f.includes(g))))))
    .map((p) => ({ id: p.id, name: p.name })).slice(0, 5);
}

// Exact taken names (name or alias) of the same kind.
function takenBy(kind, names, exceptId = null) {
  const wanted = new Set(names.map(foldName));
  const rows = getDb().prepare('SELECT id, name, aliases FROM parties WHERE kind = ? AND id IS NOT ?').all(kind, exceptId);
  return rows.find((p) => [p.name, ...parseAliases(p.aliases)].some((n) => wanted.has(foldName(n))));
}

function input(req, cur = null) {
  const b = req.body || {};
  const kind = cur ? cur.kind : b.kind;
  if (!(kind in KINDS)) throw httpError(400, 'اختار نوع الطرف');
  const out = {
    kind,
    name: b.name !== undefined ? cleanText(b.name, 80).replace(/\s+/g, ' ') : cur.name,
    aliases: b.aliases !== undefined ? b.aliases : parseAliases(cur?.aliases),
    phone: b.phone !== undefined ? cleanText(b.phone, 40) : cur?.phone ?? '',
    notes: b.notes !== undefined ? cleanText(b.notes, 1000) : cur?.notes ?? '',
    is_walk_in: b.is_walk_in !== undefined ? (b.is_walk_in ? 1 : 0) : cur?.is_walk_in ?? 0,
    active: b.active !== undefined ? (b.active ? 1 : 0) : cur?.active ?? 1,
    credit_limit: cur?.credit_limit ?? null,
  };
  if (!out.name) throw httpError(400, `اكتب اسم ال${KINDS[kind]}`);
  if (typeof out.aliases === 'string') out.aliases = out.aliases.split(/[،,\n]/);
  if (!Array.isArray(out.aliases)) throw httpError(400, 'الأسماء التانية لازم تكون قايمة');
  out.aliases = [...new Set(out.aliases.map((a) => cleanText(a, 80).replace(/\s+/g, ' ')).filter((a) => a && a !== out.name))].slice(0, 20);
  if (out.is_walk_in && kind !== 'client') throw httpError(400, 'العميل الخارجي للعملاء بس');
  // Money fields are silently ignored for users who can't see money.
  if (b.credit_limit !== undefined && can(req.user, 'money.view') && can(req.user, 'money.post')) {
    const v = parseMoney(b.credit_limit);
    if (Number.isNaN(v) || (v !== null && v < 0)) throw httpError(400, 'حد الائتمان رقم غلط');
    out.credit_limit = v;
  }
  return out;
}

// ---------- list / one ----------
parties.get('/parties', requireUser, (req, res) => {
  const kind = req.query.kind;
  if (kind && !(kind in KINDS)) throw httpError(400, 'نوع غلط');
  if (kind) assertMaySee(req.user, kind);
  const all = req.query.include_inactive === '1';
  const rows = getDb().prepare(`SELECT * FROM parties WHERE (? IS NULL OR kind = ?) AND (? OR active = 1)
    ORDER BY active DESC, name`).all(kind ?? null, kind ?? null, all ? 1 : 0);
  const q = foldName(req.query.q || '');
  const filtered = (q ? rows.filter((p) => [p.name, ...parseAliases(p.aliases)].some((n) => foldName(n).includes(q))) : rows)
    .filter((p) => maySee(req.user, p.kind));
  const money = can(req.user, 'money.view');
  const balances = {};
  if (money) for (const k of kind ? [kind] : Object.keys(KINDS)) Object.assign(balances, partyBalances(k));
  const list = filtered.map((p) => partyRow(p, req.user, balances[p.id] ?? 0));
  const out = { parties: list };
  if (money) {
    out.totals = {
      owes_us: list.reduce((s, p) => s + Math.max(0, p.balance), 0),
      we_owe: list.reduce((s, p) => s + Math.max(0, -p.balance), 0),
    };
  }
  res.json(stripMoney(req.user, out));
});

parties.get('/parties/similar', requireUser, (req, res) => {
  const kind = req.query.kind;
  if (!(kind in KINDS)) throw httpError(400, 'نوع غلط');
  assertMaySee(req.user, kind);
  res.json({ similar: similarParties(kind, [String(req.query.name || '')], req.query.except ? Number(req.query.except) : null) });
});

function getParty(id) {
  const p = getDb().prepare('SELECT * FROM parties WHERE id = ?').get(id);
  if (!p) throw httpError(404, 'الطرف مش موجود');
  return p;
}

parties.get('/parties/:id', requireUser, (req, res) => {
  const p = getParty(req.params.id);
  assertMaySee(req.user, p.kind);
  res.json({ party: partyRow(p, req.user) });
});

// ---------- create / edit ----------
parties.post('/parties', requireUser, (req, res) => {
  const db = getDb();
  const p = input(req);
  if (!mayEdit(req.user, p.kind)) throw httpError(403, 'مش مسموح لك بالحركة دي');
  const names = [p.name, ...p.aliases];
  const taken = takenBy(p.kind, names);
  if (taken) throw httpError(409, `الاسم ده متسجل بالفعل لـ «${taken.name}»`, { existing: { id: taken.id, name: taken.name } });
  const similar = req.body?.force ? [] : similarParties(p.kind, names);
  if (similar.length) throw httpError(409, `في ${KINDS[p.kind]} اسمه قريب: ${similar.map((s) => s.name).join('، ')}`, { similar });

  // Opening balance (رصيد أول المدة): positive = لنا عنده, negative = له عندنا.
  let opening = null;
  let openingDate = todayISO();
  if (req.body?.opening_balance !== undefined && req.body.opening_balance !== '' && req.body.opening_balance !== null) {
    if (!can(req.user, 'money.post')) throw httpError(403, 'رصيد أول المدة محتاج صلاحية تسجيل حركات الفلوس');
    opening = parseMoney(req.body.opening_balance);
    if (Number.isNaN(opening)) throw httpError(400, 'رصيد أول المدة رقم غلط');
    if (req.body.opening_date) {
      openingDate = parseDate(req.body.opening_date);
      if (!openingDate) throw httpError(400, 'تاريخ رصيد أول المدة غلط');
    }
  }
  const id = db.transaction(() => {
    const r = db.prepare(`INSERT INTO parties (kind, name, aliases, phone, notes, credit_limit, is_walk_in, active, created_by)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(p.kind, p.name, JSON.stringify(p.aliases), p.phone, p.notes, p.credit_limit,
      p.is_walk_in, p.active, req.user.id);
    const pid = Number(r.lastInsertRowid);
    audit(req.user.id, 'create', 'party', pid, undefined, { ...p, credit_limit: undefined });
    if (opening) postOpening(pid, p.kind, opening, openingDate, req.user.id);
    return pid;
  })();
  res.status(201).json({ party: partyRow(getParty(id), req.user) });
});

export function postOpening(partyId, kind, amount, date, userId, importRunId = null) {
  const acc = CONTROL_ACCOUNT[kind];
  const a = Math.abs(amount);
  const lines = amount > 0
    ? [{ account: acc, party_id: partyId, debit: a }, { account: 'opening_equity', credit: a }]
    : [{ account: 'opening_equity', debit: a }, { account: acc, party_id: partyId, credit: a }];
  return post('opening', date, 'رصيد أول المدة', lines, { userId, partyId, docType: 'party', docId: partyId, importRunId });
}

parties.patch('/parties/:id', requireUser, (req, res) => {
  const db = getDb();
  const cur = getParty(req.params.id);
  if (!mayEdit(req.user, cur.kind)) throw httpError(403, 'مش مسموح لك بالحركة دي');
  const p = input(req, cur);
  const before = parseAliases(cur.aliases);
  const newNames = [p.name, ...p.aliases].filter((n) => n !== cur.name && !before.includes(n));
  if (newNames.length) {
    const taken = takenBy(p.kind, newNames, cur.id);
    if (taken) throw httpError(409, `الاسم ده متسجل بالفعل لـ «${taken.name}»`, { existing: { id: taken.id, name: taken.name } });
    if (!req.body?.force) {
      const similar = similarParties(p.kind, newNames, cur.id);
      if (similar.length) throw httpError(409, `في ${KINDS[p.kind]} اسمه قريب: ${similar.map((s) => s.name).join('، ')}`, { similar });
    }
  }
  db.transaction(() => {
    db.prepare('UPDATE parties SET name=?, aliases=?, phone=?, notes=?, credit_limit=?, is_walk_in=?, active=? WHERE id=?')
      .run(p.name, JSON.stringify(p.aliases), p.phone, p.notes, p.credit_limit, p.is_walk_in, p.active, cur.id);
    audit(req.user.id, 'update', 'party', cur.id, { ...cur, aliases: before }, p);
  })();
  res.json({ party: partyRow(getParty(cur.id), req.user) });
});

// ---------- كشف حساب ----------
// What each kind of transaction is called on a staff statement (no description there).
export const STAFF_KIND_NAMES = {
  pricing: 'بيان أعمال', pricing_discount: 'خصم', manual_debit: 'قيد مدين', manual_discount: 'خصم',
  manual_addition: 'إضافة', receipt: 'إيصال استلام نقدية', cheque_collect: 'تحصيل شيك', cheque_clear: 'صرف شيك',
  cheque_endorse: 'تظهير شيك', cheque_bounce: 'شيك مرتد', transfer: 'تحويل', cash_count: 'جرد الخزينة',
  opening: 'رصيد أول المدة', reversal: 'إلغاء', expense: 'مصروف', material_purchase: 'شراء خامات',
  supplier_payment: 'دفعة لمورد', partner_withdrawal: 'سحب شريك', worker_advance: 'سلفة عامل',
};
// Without money.view: only a client's statement (staff follow the client's work), and with
// no free text — descriptions and reasons of imported or typed rows can carry amounts
// («تغذية 50000»). Supplier, worker and partner statements are all money: money.view only.
parties.get('/parties/:id/statement', requireUser, (req, res) => {
  const p = getParty(Number(req.params.id));
  const money = can(req.user, 'money.view');
  if (!money && p.kind !== 'client') throw httpError(403, 'كشف الحساب ده بيظهر للأدمن بس');
  const s = statement(p.id, req.query.from || null, req.query.to || null,
    { hideReversed: req.query.hide_reversed === '1' });
  if (!money) {
    // no free text, so the kind names the row; a priced sheet opens its operation sheet
    // (the بيان أعمال itself is money.view only)
    const sheetOf = getDb().prepare('SELECT sheet_id FROM pricing_batches WHERE id = ?');
    s.rows = s.rows.map(({ description, reason, ...r }) => ({ ...r,
      kind_name: STAFF_KIND_NAMES[r.kind] || 'حركة',
      ...(r.doc_type === 'pricing_batch' && r.doc_id ? { sheet_id: sheetOf.get(r.doc_id)?.sheet_id || null } : {}) }));
  }
  res.json(stripMoney(req.user, s));
});
