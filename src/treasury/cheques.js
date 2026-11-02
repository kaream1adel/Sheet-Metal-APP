// الشيكات: the life of a cheque.
//   أوراق القبض (direction in, from a إيصال استلام with method cheque — no posting on receipt):
//     depositCheque   في الحافظة → متودع (status only)
//     collectCheque   → اتحصّل: Dr bank / Cr the party's account (the client's balance drops now)
//     endorseCheque   → اتظهّر لمورد: Dr payable(supplier) / Cr the party's account
//     bounceCheque    → مرتد: reverses the collection / endorsement if there was one
//   أوراق الدفع (direction out, from a إذن صرف paid by cheque: Dr target / Cr cheques_payable):
//     clearCheque     → اتصرف: Dr cheques_payable / Cr bank
//     bounceCheque    → مرتد: reverses the clearing if any, and moves what we owe back to the
//                       payee's account (Dr cheques_payable / Cr payee)
// Every action is one DB transaction with its audit row; dates are real and the month open.
import { getDb, audit } from '../db.js';
import { post, reverse, assertMonthOpen, CONTROL_ACCOUNT } from '../ledger.js';
import { httpError } from '../util.js';
import { bad, realDate, partyOf, text, CHEQUE_STATUS } from './common.js';

function load(id) {
  const c = getDb().prepare('SELECT * FROM cheques WHERE id = ?').get(Number(id));
  if (!c) throw httpError(404, 'الشيك مش موجود');
  return c;
}
const label = (c) => `شيك رقم ${c.number || c.serial}${c.bank ? ` — ${c.bank}` : ''}`;
const startOf = (c) => c.received_date || c.issued_date;
function notBefore(c, date, field = 'date') {
  if (startOf(c) && date < startOf(c)) throw bad(field, `التاريخ قبل تاريخ الشيك (${startOf(c)})`);
}
const wrongState = (c, action) => httpError(409, `مينفعش ${action} — الشيك ${CHEQUE_STATUS[c.status]}`);
const auditIt = (ctx, action, c, after) => { if (!ctx.importRunId) audit(ctx.userId, action, 'cheque', c.id, { status: c.status }, after); };
const partyName = (id) => (id ? getDb().prepare('SELECT name FROM parties WHERE id = ?').get(id)?.name : '') || '';

export function depositCheque(id, input = {}, ctx = {}) {
  const db = getDb();
  return db.transaction(() => {
    const c = load(id);
    if (c.direction !== 'in' || c.status !== 'in_portfolio') throw wrongState(c, 'تودعه');
    const date = realDate(input.date, 'date', 'تاريخ الإيداع');
    notBefore(c, date);
    assertMonthOpen(date);
    db.prepare("UPDATE cheques SET status = 'deposited', deposit_date = ? WHERE id = ?").run(date, c.id);
    auditIt(ctx, 'deposit', c, { status: 'deposited', deposit_date: date });
    return getCheque(c.id);
  })();
}

export function collectCheque(id, input = {}, ctx = {}) {
  const db = getDb();
  return db.transaction(() => {
    const c = load(id);
    if (c.direction !== 'in' || !['in_portfolio', 'deposited'].includes(c.status)) throw wrongState(c, 'تحصّله');
    const date = realDate(input.date, 'date', 'تاريخ التحصيل');
    notBefore(c, date);
    const party = db.prepare('SELECT * FROM parties WHERE id = ?').get(c.party_id);
    const t = post('cheque_collect', date, `تحصيل ${label(c)}`, [
      { account: 'bank', debit: c.amount, memo: c.serial },
      { account: CONTROL_ACCOUNT[party.kind], party_id: party.id, credit: c.amount, memo: c.serial },
    ], { userId: ctx.userId, ref: c.serial, docType: 'cheque', docId: c.id, partyId: party.id, importRunId: ctx.importRunId });
    db.prepare("UPDATE cheques SET status = 'collected', cleared_date = ?, collect_txn_id = ? WHERE id = ?").run(date, t.id, c.id);
    auditIt(ctx, 'collect', c, { status: 'collected', cleared_date: date, txn_id: t.id });
    return getCheque(c.id);
  })();
}

export function endorseCheque(id, input = {}, ctx = {}) {
  const db = getDb();
  return db.transaction(() => {
    const c = load(id);
    if (c.direction !== 'in' || c.status !== 'in_portfolio') throw wrongState(c, 'تظهّره');
    const date = realDate(input.date, 'date', 'تاريخ التظهير');
    notBefore(c, date);
    const supplier = partyOf(input.supplier_id, 'supplier', 'supplier_id', 'المورد');
    const party = db.prepare('SELECT * FROM parties WHERE id = ?').get(c.party_id);
    const t = post('cheque_endorse', date, `تظهير ${label(c)} لـ${supplier.name}`, [
      { account: 'payable', party_id: supplier.id, debit: c.amount, memo: `${c.serial} من ${party.name}` },
      { account: CONTROL_ACCOUNT[party.kind], party_id: party.id, credit: c.amount, memo: `${c.serial} لـ${supplier.name}` },
    ], { userId: ctx.userId, ref: c.serial, docType: 'cheque', docId: c.id, partyId: party.id, importRunId: ctx.importRunId });
    db.prepare("UPDATE cheques SET status = 'endorsed', endorsed_to_party_id = ?, cleared_date = ?, endorse_txn_id = ? WHERE id = ?")
      .run(supplier.id, date, t.id, c.id);
    auditIt(ctx, 'endorse', c, { status: 'endorsed', supplier_id: supplier.id, date, txn_id: t.id });
    return getCheque(c.id);
  })();
}

export function clearCheque(id, input = {}, ctx = {}) {
  const db = getDb();
  return db.transaction(() => {
    const c = load(id);
    if (c.direction !== 'out' || c.status !== 'issued') throw wrongState(c, 'تسجّل صرفه');
    const date = realDate(input.date, 'date', 'تاريخ الصرف');
    notBefore(c, date);
    const t = post('cheque_clear', date, `صرف ${label(c)}${c.party_id ? ` لـ${partyName(c.party_id)}` : c.payee_text ? ` لـ${c.payee_text}` : ''}`, [
      { account: 'cheques_payable', debit: c.amount, memo: c.serial },
      { account: 'bank', credit: c.amount, memo: c.serial },
    ], { userId: ctx.userId, ref: c.serial, docType: 'cheque', docId: c.id, importRunId: ctx.importRunId });
    db.prepare("UPDATE cheques SET status = 'cleared', cleared_date = ?, clear_txn_id = ? WHERE id = ?").run(date, t.id, c.id);
    auditIt(ctx, 'clear', c, { status: 'cleared', cleared_date: date, txn_id: t.id });
    return getCheque(c.id);
  })();
}

export function bounceCheque(id, input = {}, ctx = {}) {
  const db = getDb();
  return db.transaction(() => {
    const c = load(id);
    const date = realDate(input.date, 'date', 'تاريخ الارتداد');
    notBefore(c, date);
    const reason = text(input.reason, 300);
    if (!reason) throw bad('reason', 'اكتب سبب الارتداد');
    assertMonthOpen(date);
    let txnId = null;
    if (c.direction === 'in') {
      if (!['in_portfolio', 'deposited', 'collected', 'endorsed'].includes(c.status)) throw wrongState(c, 'تسجّل ارتداده');
      // Collected / endorsed: the client owes the money again.
      const undo = c.status === 'collected' ? c.collect_txn_id : c.status === 'endorsed' ? c.endorse_txn_id : null;
      if (undo) txnId = reverse(undo, `ارتداد ${label(c)}: ${reason}`, { userId: ctx.userId, date, importRunId: ctx.importRunId }).id;
    } else {
      if (!['issued', 'cleared'].includes(c.status)) throw wrongState(c, 'تسجّل ارتداده');
      const payee = c.party_id ? db.prepare('SELECT * FROM parties WHERE id = ?').get(c.party_id) : null;
      if (!payee) throw httpError(409, 'الشيك ده مالوش مستفيد متسجل كطرف — ألغِ إذن الصرف بتاعه بدل كده');
      if (c.status === 'cleared') reverse(c.clear_txn_id, `ارتداد ${label(c)}: ${reason}`, { userId: ctx.userId, date, importRunId: ctx.importRunId });
      // We still owe the payee: the amount moves from أوراق الدفع back to his account.
      txnId = post('cheque_bounce', date, `ارتداد ${label(c)} — ${reason}`, [
        { account: 'cheques_payable', debit: c.amount, memo: c.serial },
        { account: CONTROL_ACCOUNT[payee.kind], party_id: payee.id, credit: c.amount, memo: `ارتداد ${c.serial}` },
      ], { userId: ctx.userId, ref: c.serial, docType: 'cheque', docId: c.id, partyId: payee.id, reason, importRunId: ctx.importRunId }).id;
    }
    db.prepare("UPDATE cheques SET status = 'bounced', bounced_date = ?, bounce_reason = ?, bounce_txn_id = ? WHERE id = ?")
      .run(date, reason, txnId, c.id);
    auditIt(ctx, 'bounce', c, { status: 'bounced', bounced_date: date, reason, txn_id: txnId });
    return getCheque(c.id);
  })();
}

// One cheque with its history (every transaction it made) and its document.
export function getCheque(id) {
  const db = getDb();
  const c = db.prepare(`SELECT c.*, p.name AS party_name, p.kind AS party_kind, e.name AS endorsed_to_name
    FROM cheques c LEFT JOIN parties p ON p.id = c.party_id LEFT JOIN parties e ON e.id = c.endorsed_to_party_id
    WHERE c.id = ?`).get(Number(id));
  if (!c) throw httpError(404, 'الشيك مش موجود');
  c.status_name = CHEQUE_STATUS[c.status];
  const ids = [c.issue_txn_id, c.collect_txn_id, c.clear_txn_id, c.endorse_txn_id, c.bounce_txn_id].filter(Boolean);
  c.history = ids.length ? db.prepare(`SELECT id, serial, kind, date, description, status, reversal_of FROM txns
    WHERE id IN (${ids.map(() => '?').join(',')}) OR reversal_of IN (${ids.map(() => '?').join(',')}) ORDER BY date, id`).all(...ids, ...ids) : [];
  c.receipt = c.direction === 'in' ? db.prepare('SELECT id, serial, status FROM receipts WHERE cheque_id = ?').get(c.id) || null : null;
  c.voucher = c.direction === 'out' ? db.prepare('SELECT id, serial, status, kind FROM vouchers WHERE cheque_id = ?').get(c.id) || null : null;
  return c;
}
