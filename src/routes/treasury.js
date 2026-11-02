// Module treasury (الخزينة والبنك، المصروفات، الشيكات) — mounted at /api/treasury in src/app.js.
// Rules: a permission on every route, stripMoney() on every response, postings only through
// src/ledger.js (via src/treasury/*), audit() inside the same transaction.
// The workshop manager (expenses.record without treasury) records expense vouchers and sees
// only his own, without any amount: the server strips them.
import { Router } from 'express';
import { requireUser, requirePerm, requireAny } from '../auth.js';
import { can } from '../permissions.js';
import { stripMoney } from '../money.js';
import { httpError } from '../util.js';
import { getDb } from '../db.js';
import * as T from '../treasury/index.js';

export const treasury = Router();

const money = requirePerm('money.view');
const tre = requirePerm('treasury');
const cheq = requirePerm('cheques');
const exp = requireAny('expenses.record', 'treasury');
const ctxOf = (req) => ({ userId: req.user.id, limited: !can(req.user, 'treasury') });
// Free text the admin writes on a staff document (the reason he cancelled it) can carry an
// amount: users without money.view never get it, only the status.
const ADMIN_TEXT = new Set(['cancel_reason', 'bounce_reason']);
const stripAdminText = (v) => {
  if (Array.isArray(v)) return v.map(stripAdminText);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !ADMIN_TEXT.has(k)).map(([k, x]) => [k, stripAdminText(x)]));
  return v;
};
const send = (req, res, data, status = 200) => {
  const out = stripMoney(req.user, data);
  res.status(status).json(can(req.user, 'money.view') ? out : stripAdminText(out));
};
const reasonOf = (req) => req.body?.reason;

treasury.use(requireUser);

// What the forms offer (labels and which sources each kind may use). Label maps go out as
// [key, label] pairs: keys like `cash` / `bank` are money names to stripMoney, and staff
// must still get the labels of the sources he may use.
treasury.get('/options', exp, (req, res) => {
  const limited = !can(req.user, 'treasury');
  const pairs = (o) => Object.entries(o);
  send(req, res, {
    limited,
    methods: pairs(T.METHODS),
    paid_from: pairs(limited ? Object.fromEntries(T.LIMITED_SOURCES.map((k) => [k, T.PAID_FROM[k]])) : T.PAID_FROM),
    kinds: pairs(limited ? { expense: T.VOUCHER_KINDS.expense } : T.VOUCHER_KINDS),
    kind_sources: limited ? { expense: T.LIMITED_SOURCES } : T.KIND_SOURCES, kind_party: T.KIND_PARTY,
    cheque_status: pairs(T.CHEQUE_STATUS),
  });
});

// ---------- balances & movements ----------
treasury.get('/summary', tre, money, (req, res) => send(req, res, T.treasurySummary()));
treasury.get('/movements', tre, money, (req, res) => send(req, res, T.movements(req.query)));
treasury.post('/opening', requirePerm('money.post'), tre, (req, res) => send(req, res, T.postTreasuryOpening(req.body, ctxOf(req)), 201));

// ---------- إيصال استلام نقدية ----------
treasury.get('/receipts', tre, (req, res) => send(req, res, { receipts: T.listReceipts(req.query) }));
treasury.post('/receipts', tre, (req, res) => {
  const r = T.createReceipt(req.body, ctxOf(req));
  send(req, res, { receipt: T.getReceipt(r.id) }, 201);
});
treasury.get('/receipts/:id', tre, (req, res) => send(req, res, { receipt: T.getReceipt(req.params.id) }));
treasury.post('/receipts/:id/cancel', tre, (req, res) => {
  T.cancelReceipt(Number(req.params.id), reasonOf(req), ctxOf(req));
  send(req, res, { receipt: T.getReceipt(req.params.id) });
});

// ---------- إذن صرف / المصروفات ----------
function voucherFor(req) {
  const v = T.getVoucher(req.params.id);
  if (!can(req.user, 'treasury') && v.created_by !== req.user.id) throw httpError(403, 'إذن الصرف ده مش بتاعك');
  return v;
}
treasury.get('/vouchers', exp, (req, res) => {
  const own = can(req.user, 'treasury') ? null : req.user.id;
  send(req, res, { ...T.listVouchers(req.query, { ownerId: own }), own_only: own !== null });
});
treasury.post('/vouchers', exp, (req, res) => {
  const v = T.createVoucher(req.body, ctxOf(req));
  send(req, res, { voucher: T.getVoucher(v.id) }, 201);
});
treasury.get('/vouchers/:id', exp, (req, res) => send(req, res, { voucher: voucherFor(req) }));
treasury.post('/vouchers/:id/cancel', tre, (req, res) => {
  T.cancelVoucher(Number(req.params.id), reasonOf(req), ctxOf(req));
  send(req, res, { voucher: T.getVoucher(req.params.id) });
});
treasury.post('/vouchers/:id/photo', exp, (req, res) => {
  const v = voucherFor(req);
  T.setVoucherPhoto(v.id, req.body?.photo, ctxOf(req));
  send(req, res, { voucher: T.getVoucher(v.id) });
});
treasury.get('/vouchers/:id/photo', exp, (req, res) => {
  const v = voucherFor(req);
  const row = getDb().prepare('SELECT photo_path FROM vouchers WHERE id = ?').get(v.id);
  const file = T.voucherPhotoFile(row);
  if (!file) throw httpError(404, 'مفيش صورة للإذن ده');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.sendFile(file);
});

// ---------- تحويل ----------
treasury.get('/transfers', tre, (req, res) => send(req, res, { transfers: T.listTransfers() }));
treasury.post('/transfers', tre, (req, res) => {
  const t = T.createTransfer(req.body, ctxOf(req));
  send(req, res, { transfer: T.getTransfer(t.id) }, 201);
});
treasury.get('/transfers/:id', tre, (req, res) => send(req, res, { transfer: T.getTransfer(req.params.id) }));
treasury.post('/transfers/:id/cancel', tre, (req, res) => {
  T.cancelTransfer(Number(req.params.id), reasonOf(req), ctxOf(req));
  send(req, res, { transfer: T.getTransfer(req.params.id) });
});

// ---------- جرد الخزينة ----------
treasury.get('/counts', tre, money, (req, res) => send(req, res, { counts: T.listCashCounts() }));
treasury.get('/counts/expected', tre, money, (req, res) => {
  const account = req.query.account === 'bank' ? 'bank' : 'cash';
  const date = T.realDate(req.query.date || T.today());
  send(req, res, { account, date, expected: T.expectedBalance(account, date) });
});
treasury.post('/counts', tre, money, (req, res) => {
  const c = T.createCashCount(req.body, ctxOf(req));
  send(req, res, { count: T.getCashCount(c.id) }, 201);
});
treasury.get('/counts/:id', tre, money, (req, res) => send(req, res, { count: T.getCashCount(req.params.id) }));

// ---------- الشيكات ----------
treasury.get('/cheques', cheq, (req, res) => send(req, res, T.listCheques(req.query)));
treasury.get('/cheques/alerts', cheq, (req, res) => send(req, res, { alerts: T.chequeAlerts(T.today(), req.query.direction || null) }));
treasury.get('/cheques/:id', cheq, (req, res) => send(req, res, { cheque: T.getCheque(req.params.id) }));
const ACTIONS = { deposit: T.depositCheque, collect: T.collectCheque, endorse: T.endorseCheque, clear: T.clearCheque, bounce: T.bounceCheque };
treasury.post('/cheques/:id/:action', cheq, (req, res) => {
  const fn = ACTIONS[req.params.action];
  if (!fn) throw httpError(404, 'مش موجود');
  send(req, res, { cheque: fn(Number(req.params.id), req.body || {}, ctxOf(req)) });
});

// ---------- المصروفات المتكررة ----------
treasury.get('/recurring', tre, (req, res) => send(req, res, { recurring: T.listRecurring(), drafts: T.recurringDrafts() }));
treasury.post('/recurring', tre, (req, res) => send(req, res, { recurring: T.createRecurring(req.body, ctxOf(req)) }, 201));
treasury.patch('/recurring/:id', tre, (req, res) => send(req, res, { recurring: T.updateRecurring(req.params.id, req.body, ctxOf(req)) }));
treasury.get('/recurring/drafts', tre, (req, res) => send(req, res, { drafts: T.recurringDrafts() }));
treasury.post('/recurring/drafts/confirm', tre, (req, res) => {
  const b = req.body || {};
  const v = T.confirmDraft(b.recurring_id, b.month, { amount: b.amount, date: b.date }, ctxOf(req));
  send(req, res, { voucher: T.getVoucher(v.id) }, 201);
});
treasury.post('/recurring/drafts/confirm-all', tre, (req, res) => {
  const list = T.confirmAllDrafts(T.today(), ctxOf(req));
  send(req, res, { confirmed: list.length, vouchers: list.map((v) => ({ id: v.id, serial: v.serial })) }, 201);
});
treasury.post('/recurring/drafts/skip', tre, (req, res) => {
  const b = req.body || {};
  send(req, res, T.skipDraft(b.recurring_id, b.month, b.reason, ctxOf(req)));
});

treasury.use((_req, _res, next) => next(httpError(404, 'مش موجود')));
