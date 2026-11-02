// The treasury's money documents and their postings (spec «Ledger» section):
//   createReceipt / cancelReceipt      إيصال استلام نقدية (قب-), from any party; a cheque is held, not posted
//   createVoucher / cancelVoucher      إذن صرف (صر-): expense, material purchase, supplier payment,
//                                      partner withdrawal, worker advance; salary = expense (مرتبات)
//   createTransfer / cancelTransfer    تحويل (تح-) between الخزينة and البنك
//   createCashCount                    جرد الخزينة (جر-): counted vs expected → cash_over_short
//   postTreasuryOpening                رصيد أول المدة of the cash box or the bank
// Every function runs in one DB transaction: the document, its ledger transaction (ledger.post
// asserts balance and the month lock) and the audit row, or nothing. Posted documents are never
// edited: cancel = ledger.reverse with a reason. ctx = { userId, importRunId?, limited? }.
import fs from 'fs';
import { join } from 'path';
import { getDb, audit } from '../db.js';
import { post, reverse, balance, nextSerial, assertMonthOpen, CONTROL_ACCOUNT } from '../ledger.js';
import { mulRound, formatMoney, parseMoney } from '../money.js';
import { httpError, parseNumber } from '../util.js';
import { dataDir, ensureDir } from '../paths.js';
import {
  METHODS, PAID_FROM, VOUCHER_KINDS, KIND_SOURCES, KIND_PARTY, LIMITED_SOURCES, bad, realDate, amountIn, partyOf, text,
} from './common.js';

const auditDoc = (ctx, action, entity, id, before, after) => {
  if (!ctx.importRunId) audit(ctx.userId, action, entity, id, before, after);
};
const reasonOf = (r) => {
  const s = text(r, 500);
  if (!s) throw bad('reason', 'اكتب السبب');
  return s;
};

// ---------- إيصال استلام نقدية ----------
// input: { party_id, date, amount | amount_millimes, method, account?, notes,
//          cheque: { number, bank, due_date } (method cheque) }
export function createReceipt(input = {}, ctx = {}) {
  const db = getDb();
  const party = partyOf(input.party_id, null, 'party_id', 'الطرف اللي دفع');
  const date = realDate(input.date);
  const amount = amountIn(input.amount, 'amount', 'المبلغ', input.amount_millimes);
  const method = input.method || 'cash';
  if (!(method in METHODS)) throw bad('method', 'اختار طريقة الدفع');
  let account = null;
  if (method === 'cash') account = 'cash';
  else if (method === 'wallet') account = input.account === 'cash' ? 'cash' : 'bank';
  else if (method !== 'cheque') account = 'bank';
  const notes = text(input.notes, 500);
  let cheque = null;
  if (method === 'cheque') {
    const c = input.cheque || {};
    cheque = { number: text(c.number, 40), bank: text(c.bank, 80), due_date: realDate(c.due_date, 'cheque_due_date', 'تاريخ استحقاق الشيك') };
    if (!cheque.number) throw bad('cheque_number', 'اكتب رقم الشيك');
  }
  return db.transaction(() => {
    assertMonthOpen(date);
    const serial = nextSerial('قب');
    let chequeId = null;
    if (cheque) {
      const cs = nextSerial('شك');
      chequeId = Number(db.prepare(`INSERT INTO cheques (serial, direction, party_id, number, bank, amount, received_date, due_date,
          status, notes, import_run_id, created_by) VALUES (?, 'in', ?, ?, ?, ?, ?, ?, 'in_portfolio', ?, ?, ?)`)
        .run(cs, party.id, cheque.number, cheque.bank, amount, date, cheque.due_date, notes, ctx.importRunId ?? null, ctx.userId ?? null).lastInsertRowid);
      auditDoc(ctx, 'create', 'cheque', chequeId, undefined, { serial: cs, direction: 'in', party_id: party.id, amount, due_date: cheque.due_date });
    }
    const id = Number(db.prepare(`INSERT INTO receipts (serial, party_id, date, amount, method, account, cheque_id, notes,
        import_run_id, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(serial, party.id, date, amount, method, account, chequeId, notes, ctx.importRunId ?? null, ctx.userId ?? null).lastInsertRowid);
    let txnId = null;
    if (!cheque) {
      const t = post('receipt', date, `إيصال استلام ${serial} — ${METHODS[method]}${notes ? ` — ${notes}` : ''}`, [
        { account, debit: amount, memo: serial },
        { account: CONTROL_ACCOUNT[party.kind], party_id: party.id, credit: amount, memo: serial },
      ], { userId: ctx.userId, ref: serial, docType: 'receipt', docId: id, partyId: party.id, importRunId: ctx.importRunId });
      txnId = t.id;
      db.prepare('UPDATE receipts SET txn_id = ? WHERE id = ?').run(txnId, id);
    }
    auditDoc(ctx, 'create', 'receipt', id, undefined, { serial, party_id: party.id, date, amount, method, account, cheque_id: chequeId });
    return { id, serial, txn_id: txnId, cheque_id: chequeId };
  })();
}

export function cancelReceipt(id, reason, ctx = {}) {
  const db = getDb();
  const r = reasonOf(reason);
  return db.transaction(() => {
    const rc = db.prepare('SELECT * FROM receipts WHERE id = ?').get(id);
    if (!rc) throw httpError(404, 'الإيصال مش موجود');
    if (rc.status === 'cancelled') throw httpError(409, 'الإيصال ده ملغي بالفعل');
    if (rc.cheque_id) {
      const c = db.prepare('SELECT * FROM cheques WHERE id = ?').get(rc.cheque_id);
      if (!['in_portfolio', 'deposited'].includes(c.status)) {
        throw httpError(409, 'الشيك بتاع الإيصال ده اتحصّل أو اتظهّر — لو رجع سجّله «ارتداد» من صفحة الشيك');
      }
      db.prepare("UPDATE cheques SET status = 'cancelled', notes = trim(notes || ' ' || ?) WHERE id = ?").run(`إلغاء: ${r}`, c.id);
      auditDoc(ctx, 'cancel', 'cheque', c.id, { status: c.status }, { status: 'cancelled', reason: r });
    }
    if (rc.txn_id) reverse(rc.txn_id, r, { userId: ctx.userId });
    db.prepare("UPDATE receipts SET status = 'cancelled', cancel_reason = ? WHERE id = ?").run(r, rc.id);
    auditDoc(ctx, 'cancel', 'receipt', rc.id, { status: rc.status }, { status: 'cancelled', reason: r });
    return { id: rc.id, serial: rc.serial };
  })();
}

// ---------- إذن صرف ----------
function categoryOf(id, field) {
  const n = Number(id);
  const c = n ? getDb().prepare('SELECT * FROM expense_categories WHERE id = ?').get(n) : null;
  if (!c) throw bad(field, 'اختار بند المصروف');
  if (!c.active) throw bad(field, `بند «${c.name}» موقوف`);
  if (!getDb().prepare('SELECT 1 FROM accounts WHERE code = ?').get(`expense:${c.id}`)) throw bad(field, `بند «${c.name}» مالوش حساب`);
  return c;
}

function materialOf(id) {
  if (!id) return null;
  const m = getDb().prepare('SELECT * FROM materials WHERE id = ?').get(Number(id));
  if (!m) throw bad('items', 'الخامة مش موجودة');
  return m;
}

// input: {
//   kind: expense | material_purchase | supplier_payment | partner_withdrawal | worker_advance,
//   date, description, paid_from, paid_from_party_id (partner / supplier / client of the source),
//   party_id (supplier / partner / worker of the kind),
//   lines: [{ category_id, amount, cost_party_id?, recharge?, worker_id?, description? }]   (expense)
//   deduction: salary taken back from the worker's advance (expense with a worker line)
//   items: [{ material_id?, material_text, thickness?, qty, unit, unit_rate }]               (material_purchase)
//   amount: (supplier_payment / partner_withdrawal / worker_advance)
//   cheque: { number, bank, due_date, payee_party_id?, payee_text? }   (paid_from cheque)
//   recurring_id
// }
// ctx.limited (the workshop manager): expense only, from the cash box or on a supplier's
// account, no recharge to a client.
export function createVoucher(input = {}, ctx = {}) {
  const db = getDb();
  const kind = input.kind || 'expense';
  if (!(kind in VOUCHER_KINDS)) throw bad('kind', 'نوع إذن الصرف غلط');
  if (ctx.limited && kind !== 'expense') throw httpError(403, 'مسموح لك تسجل مصروفات بس');
  const date = realDate(input.date);
  const paidFrom = input.paid_from || 'cash';
  if (!(paidFrom in PAID_FROM)) throw bad('paid_from', 'اختار اتصرف منين');
  if (!KIND_SOURCES[kind].includes(paidFrom)) throw bad('paid_from', `${VOUCHER_KINDS[kind]} مينفعش يتصرف من «${PAID_FROM[paidFrom]}»`);
  if (ctx.limited && !LIMITED_SOURCES.includes(paidFrom)) throw httpError(403, 'مسموح لك تصرف من الخزينة أو على حساب مورد بس');
  const description = text(input.description, 300);

  // The party of the kind (supplier / partner / worker).
  const party = KIND_PARTY[kind] ? partyOf(input.party_id, KIND_PARTY[kind], 'party_id',
    { supplier: 'المورد', partner: 'الشريك', worker: 'العامل' }[KIND_PARTY[kind]]) : null;

  // Debit side.
  const debits = [];
  const extra = []; // recharge: Dr receivable / Cr revenue:recharge
  const lines = [];
  const items = [];
  let total = 0;
  let deduction = 0;
  let workerForDeduction = null;
  if (kind === 'expense') {
    const raw = Array.isArray(input.lines) ? input.lines : [];
    if (!raw.length) throw bad('lines', 'اكتب مبلغ المصروف');
    raw.forEach((l, i) => {
      const f = raw.length > 1 ? `lines.${i}` : 'amount';
      const cat = categoryOf(l.category_id ?? input.category_id, 'category_id');
      const amount = amountIn(l.amount, f, raw.length > 1 ? `مبلغ السطر ${i + 1}` : 'المبلغ', l.amount_millimes);
      const cost = l.cost_party_id ? partyOf(l.cost_party_id, 'client', 'cost_party_id', 'العميل (مركز التكلفة)') : null;
      const worker = l.worker_id ? partyOf(l.worker_id, 'worker', 'worker_id', 'العامل') : null;
      const recharge = !!l.recharge;
      if (recharge && !cost) throw bad('recharge', '«يتحمّل على العميل» محتاج تختار العميل في مركز التكلفة');
      if (recharge && ctx.limited) throw httpError(403, 'تحميل المصروف على العميل للأدمن بس');
      const ldesc = text(l.description, 200);
      lines.push({ category: cat, amount, cost, worker, recharge, description: ldesc });
      debits.push({ account: `expense:${cat.id}`, debit: amount, cost_party_id: cost?.id ?? null,
        memo: [cat.name, worker?.name, ldesc].filter(Boolean).join(' — ') });
      if (recharge) {
        extra.push({ account: 'receivable', party_id: cost.id, debit: amount, memo: `مصروف محمّل: ${cat.name}` });
        extra.push({ account: 'revenue:recharge', credit: amount, memo: cost.name });
      }
      total += amount;
    });
    if (input.deduction !== undefined && input.deduction !== null && String(input.deduction).trim() !== '' && String(input.deduction).trim() !== '0') {
      deduction = amountIn(input.deduction, 'deduction', 'الخصم من السلفة', input.deduction_millimes);
      const workers = [...new Set(lines.map((l) => l.worker?.id).filter(Boolean))];
      if (workers.length !== 1) throw bad('deduction', 'الخصم من السلفة محتاج عامل واحد على الإذن');
      if (deduction >= total) throw bad('deduction', 'الخصم من السلفة لازم يكون أقل من المرتب');
      workerForDeduction = workers[0];
    }
  } else if (kind === 'material_purchase') {
    const raw = Array.isArray(input.items) ? input.items : [];
    if (!raw.length) throw bad('items', 'اكتب الخامة والكمية والسعر');
    raw.forEach((it, i) => {
      const m = materialOf(it.material_id);
      const mtext = text(it.material_text, 120) || m?.name || '';
      if (!mtext) throw bad('items', `اكتب اسم الخامة في السطر ${i + 1}`);
      const qty = parseNumber(it.qty);
      if (qty === null || Number.isNaN(qty) || qty <= 0) throw bad('items', `الكمية في السطر ${i + 1} لازم تكون رقم أكبر من صفر`);
      const unitRate = amountIn(it.unit_rate, 'items', `سعر الوحدة في السطر ${i + 1}`, it.unit_rate_millimes);
      const thickness = it.thickness === undefined || it.thickness === '' || it.thickness === null ? null : parseNumber(it.thickness);
      if (thickness !== null && (Number.isNaN(thickness) || thickness <= 0)) throw bad('items', `السمك في السطر ${i + 1} غلط`);
      const lineAmount = mulRound(qty, unitRate);
      if (lineAmount <= 0) throw bad('items', `مبلغ السطر ${i + 1} صفر`);
      items.push({ material_id: m?.id ?? null, material_text: mtext, thickness, qty, unit: text(it.unit, 20), unit_rate: unitRate, line_amount: lineAmount });
      total += lineAmount;
    });
    debits.push({ account: 'materials_purchases', debit: total, memo: `${party.name}: ${items.map((x) => x.material_text).join('، ')}`.slice(0, 300) });
  } else {
    total = amountIn(input.amount, 'amount', 'المبلغ', input.amount_millimes);
    debits.push({ account: CONTROL_ACCOUNT[party.kind], party_id: party.id, debit: total, memo: VOUCHER_KINDS[kind] });
  }
  const paid = total - deduction;

  // Credit side (where the money came from).
  let source = null;
  let cheque = null;
  const credits = [];
  if (deduction) credits.push({ account: 'worker', party_id: workerForDeduction, credit: deduction, memo: 'خصم من السلفة' });
  if (paidFrom === 'cash' || paidFrom === 'bank') credits.push({ account: paidFrom, credit: paid });
  else if (paidFrom === 'partner') {
    source = partyOf(input.paid_from_party_id, 'partner', 'paid_from_party_id', 'الشريك اللي دفع');
    credits.push({ account: 'partner', party_id: source.id, credit: paid, memo: 'دفع من جيبه' });
  } else if (paidFrom === 'supplier_credit') {
    source = kind === 'material_purchase' && !input.paid_from_party_id ? party
      : partyOf(input.paid_from_party_id, 'supplier', 'paid_from_party_id', 'المورد');
    credits.push({ account: 'payable', party_id: source.id, credit: paid, memo: 'آجل' });
  } else if (paidFrom === 'client_offset') {
    source = partyOf(input.paid_from_party_id, 'client', 'paid_from_party_id', 'العميل (المقاصة)');
    credits.push({ account: 'receivable', party_id: source.id, credit: paid, memo: 'مقاصة' });
  } else if (paidFrom === 'cheque') {
    const c = input.cheque || {};
    cheque = { number: text(c.number, 40), bank: text(c.bank, 80), due_date: realDate(c.due_date, 'cheque_due_date', 'تاريخ استحقاق الشيك'),
      payee_text: text(c.payee_text, 120) };
    if (!cheque.number) throw bad('cheque_number', 'اكتب رقم الشيك');
    cheque.payee = party || (c.payee_party_id ? partyOf(c.payee_party_id, null, 'cheque_payee', 'المستفيد') : null);
    credits.push({ account: 'cheques_payable', credit: paid, memo: `شيك ${cheque.number}` });
  }

  return db.transaction(() => {
    assertMonthOpen(date);
    const serial = nextSerial('صر');
    const id = Number(db.prepare(`INSERT INTO vouchers (serial, date, kind, paid_from, paid_from_party_id, party_id, total, description,
        deduction_amount, recurring_id, import_run_id, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(serial, date, kind, paidFrom, source?.id ?? null, party?.id ?? null, total, description, deduction,
        input.recurring_id ?? null, ctx.importRunId ?? null, ctx.userId ?? null).lastInsertRowid);
    const insLine = db.prepare(`INSERT INTO voucher_lines (voucher_id, category_id, cost_party_id, worker_id, recharge, amount, description)
      VALUES (?,?,?,?,?,?,?)`);
    for (const l of lines) insLine.run(id, l.category.id, l.cost?.id ?? null, l.worker?.id ?? null, l.recharge ? 1 : 0, l.amount, l.description);
    const insItem = db.prepare(`INSERT INTO purchase_items (voucher_id, material_id, material_text, thickness, qty, unit, unit_rate, line_amount)
      VALUES (?,?,?,?,?,?,?,?)`);
    for (const it of items) insItem.run(id, it.material_id, it.material_text, it.thickness, it.qty, it.unit, it.unit_rate, it.line_amount);

    const what = kind === 'expense' ? [...new Set(lines.map((l) => l.category.name))].join('، ') : VOUCHER_KINDS[kind];
    const who = party?.name || '';
    const desc = [`إذن صرف ${serial}`, what, who, description].filter(Boolean).join(' — ');
    const t = post(kind, date, desc, [...debits, ...extra, ...credits], {
      userId: ctx.userId, ref: serial, docType: 'voucher', docId: id, importRunId: ctx.importRunId,
      partyId: party?.id ?? source?.id ?? lines.find((l) => l.cost)?.cost.id ?? null,
    });
    db.prepare('UPDATE vouchers SET txn_id = ? WHERE id = ?').run(t.id, id);
    let chequeId = null;
    if (cheque) {
      const cs = nextSerial('شك');
      chequeId = Number(db.prepare(`INSERT INTO cheques (serial, direction, party_id, number, bank, amount, issued_date, due_date, status,
          issue_txn_id, payee_text, notes, import_run_id, created_by) VALUES (?, 'out', ?, ?, ?, ?, ?, ?, 'issued', ?, ?, ?, ?, ?)`)
        .run(cs, cheque.payee?.id ?? null, cheque.number, cheque.bank, paid, date, cheque.due_date, t.id, cheque.payee_text,
          `إذن صرف ${serial}`, ctx.importRunId ?? null, ctx.userId ?? null).lastInsertRowid);
      db.prepare('UPDATE vouchers SET cheque_id = ? WHERE id = ?').run(chequeId, id);
      auditDoc(ctx, 'create', 'cheque', chequeId, undefined, { serial: cs, direction: 'out', amount: paid, due_date: cheque.due_date });
    }
    auditDoc(ctx, 'create', 'voucher', id, undefined, { serial, kind, date, paid_from: paidFrom, total, deduction, lines: lines.length, items: items.length });
    return { id, serial, txn_id: t.id, cheque_id: chequeId, total };
  })();
}

export function cancelVoucher(id, reason, ctx = {}) {
  const db = getDb();
  const r = reasonOf(reason);
  return db.transaction(() => {
    const v = db.prepare('SELECT * FROM vouchers WHERE id = ?').get(id);
    if (!v) throw httpError(404, 'إذن الصرف مش موجود');
    if (v.status === 'cancelled') throw httpError(409, 'إذن الصرف ده ملغي بالفعل');
    if (v.cheque_id) {
      const c = db.prepare('SELECT * FROM cheques WHERE id = ?').get(v.cheque_id);
      if (c.status !== 'issued') throw httpError(409, `الشيك بتاع الإذن ده ${c.status === 'cleared' ? 'اتصرف من البنك' : 'اترد'} — مينفعش تلغي الإذن`);
      db.prepare("UPDATE cheques SET status = 'cancelled', notes = trim(notes || ' ' || ?) WHERE id = ?").run(`إلغاء: ${r}`, c.id);
      auditDoc(ctx, 'cancel', 'cheque', c.id, { status: c.status }, { status: 'cancelled', reason: r });
    }
    reverse(v.txn_id, r, { userId: ctx.userId });
    db.prepare("UPDATE vouchers SET status = 'cancelled', cancel_reason = ? WHERE id = ?").run(r, v.id);
    // A cancelled recurring month goes back to the drafts.
    if (v.recurring_id) db.prepare("DELETE FROM recurring_runs WHERE voucher_id = ? AND status = 'confirmed'").run(v.id);
    auditDoc(ctx, 'cancel', 'voucher', v.id, { status: v.status }, { status: 'cancelled', reason: r });
    return { id: v.id, serial: v.serial };
  })();
}

// The bill photo (صورة الفاتورة): a data URL, kept in <data>/attachments/vouchers/.
const PHOTO_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
export function attachmentsDir() { return ensureDir(join(dataDir(), 'attachments', 'vouchers')); }

// The bytes must really be the image the data URL names (magic numbers), so nothing else is
// ever stored and served as a photo.
export function isImage(type, buf) {
  if (type === 'image/jpeg') return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (type === 'image/png') return buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (type === 'image/webp') return buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP';
  return false;
}

export function setVoucherPhoto(id, dataUrl, ctx = {}) {
  const db = getDb();
  const v = db.prepare('SELECT * FROM vouchers WHERE id = ?').get(id);
  if (!v) throw httpError(404, 'إذن الصرف مش موجود');
  const m = String(dataUrl || '').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/);
  if (!m) throw bad('photo', 'الصورة لازم تكون JPG أو PNG');
  if (v.status !== 'posted') throw httpError(409, 'إذن الصرف ده ملغي — مينفعش تغيّر صورته');
  // The photo is the evidence of the expense: the workshop manager attaches it once,
  // only the treasury can replace it.
  if (ctx.limited && v.photo_path) throw httpError(403, 'الإذن ده عليه صورة بالفعل — الأدمن بس يقدر يغيّرها');
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) throw bad('photo', 'الصورة فاضية');
  if (buf.length > MAX_PHOTO_BYTES) throw bad('photo', 'الصورة كبيرة قوي — صوّرها تاني');
  if (!isImage(m[1], buf)) throw bad('photo', 'الملف ده مش صورة — صوّر الفاتورة تاني');
  const name = `${v.id}-${Date.now()}.${PHOTO_TYPES[m[1]]}`;
  fs.writeFileSync(join(attachmentsDir(), name), buf);
  db.transaction(() => {
    db.prepare('UPDATE vouchers SET photo_path = ? WHERE id = ?').run(`attachments/vouchers/${name}`, v.id);
    audit(ctx.userId, 'attach', 'voucher', v.id, { photo_path: v.photo_path }, { photo_path: `attachments/vouchers/${name}` });
  })();
  return { photo: true };
}

export function voucherPhotoFile(v) {
  if (!v?.photo_path) return null;
  const f = join(dataDir(), ...v.photo_path.split('/'));
  return fs.existsSync(f) ? f : null;
}

// ---------- تحويل ----------
export function createTransfer(input = {}, ctx = {}) {
  const db = getDb();
  const date = realDate(input.date);
  const from = input.from_account;
  const to = input.to_account || (from === 'cash' ? 'bank' : 'cash');
  if (!['cash', 'bank'].includes(from)) throw bad('from_account', 'اختار التحويل من فين');
  if (!['cash', 'bank'].includes(to) || to === from) throw bad('to_account', 'التحويل لازم يكون بين الخزينة والبنك');
  const amount = amountIn(input.amount, 'amount', 'المبلغ', input.amount_millimes);
  const notes = text(input.notes, 300);
  const names = { cash: 'الخزينة', bank: 'البنك' };
  return db.transaction(() => {
    assertMonthOpen(date);
    const serial = nextSerial('تح');
    const id = Number(db.prepare(`INSERT INTO transfers (serial, date, from_account, to_account, amount, notes, created_by)
      VALUES (?,?,?,?,?,?,?)`).run(serial, date, from, to, amount, notes, ctx.userId ?? null).lastInsertRowid);
    const t = post('transfer', date, `تحويل ${serial} من ${names[from]} لـ${names[to]}${notes ? ` — ${notes}` : ''}`, [
      { account: to, debit: amount }, { account: from, credit: amount },
    ], { userId: ctx.userId, ref: serial, docType: 'transfer', docId: id, importRunId: ctx.importRunId });
    db.prepare('UPDATE transfers SET txn_id = ? WHERE id = ?').run(t.id, id);
    auditDoc(ctx, 'create', 'transfer', id, undefined, { serial, date, from, to, amount });
    return { id, serial, txn_id: t.id };
  })();
}

export function cancelTransfer(id, reason, ctx = {}) {
  const db = getDb();
  const r = reasonOf(reason);
  return db.transaction(() => {
    const tr = db.prepare('SELECT * FROM transfers WHERE id = ?').get(id);
    if (!tr) throw httpError(404, 'التحويل مش موجود');
    if (tr.status === 'cancelled') throw httpError(409, 'التحويل ده ملغي بالفعل');
    reverse(tr.txn_id, r, { userId: ctx.userId });
    db.prepare("UPDATE transfers SET status = 'cancelled', cancel_reason = ? WHERE id = ?").run(r, tr.id);
    auditDoc(ctx, 'cancel', 'transfer', tr.id, { status: tr.status }, { status: 'cancelled', reason: r });
    return { id: tr.id, serial: tr.serial };
  })();
}

// ---------- جرد الخزينة ----------
export const expectedBalance = (account, date) => balance(account, null, { asOf: date });

// input: { account: cash|bank, date, counted (pounds), notes (the reason, required when it differs) }
export function createCashCount(input = {}, ctx = {}) {
  const db = getDb();
  const account = input.account || 'cash';
  if (!['cash', 'bank'].includes(account)) throw bad('account', 'اختار الخزينة أو البنك');
  const date = realDate(input.date);
  if (input.counted === undefined || input.counted === null || String(input.counted).trim() === '') throw bad('counted', 'اكتب المبلغ اللي اتعد');
  const counted = Number.isSafeInteger(input.counted_millimes) ? input.counted_millimes : parseMoney(input.counted);
  if (counted === null || Number.isNaN(counted)) throw bad('counted', 'المبلغ اللي اتعد رقم غلط');
  if (counted < 0) throw bad('counted', 'المبلغ اللي اتعد مينفعش يكون بالسالب');
  const notes = text(input.notes, 300);
  return db.transaction(() => {
    assertMonthOpen(date);
    const expected = expectedBalance(account, date);
    const difference = counted - expected;
    if (difference !== 0 && !notes) throw bad('notes', `فيه فرق ${formatMoney(Math.abs(difference))} — اكتب سببه`);
    const serial = nextSerial('جر');
    const id = Number(db.prepare(`INSERT INTO cash_counts (serial, date, account, expected, counted, difference, notes, created_by)
      VALUES (?,?,?,?,?,?,?,?)`).run(serial, date, account, expected, counted, difference, notes, ctx.userId ?? null).lastInsertRowid);
    let txnId = null;
    if (difference !== 0) {
      const a = Math.abs(difference);
      const lines = difference > 0
        ? [{ account, debit: a, memo: 'زيادة في الجرد' }, { account: 'cash_over_short', credit: a }]
        : [{ account: 'cash_over_short', debit: a }, { account, credit: a, memo: 'عجز في الجرد' }];
      const t = post('cash_count', date, `جرد ${account === 'cash' ? 'الخزينة' : 'البنك'} ${serial} — ${difference > 0 ? 'زيادة' : 'عجز'} — ${notes}`, lines,
        { userId: ctx.userId, ref: serial, docType: 'cash_count', docId: id, reason: notes });
      txnId = t.id;
      db.prepare('UPDATE cash_counts SET txn_id = ? WHERE id = ?').run(txnId, id);
    }
    auditDoc(ctx, 'create', 'cash_count', id, undefined, { serial, account, date, expected, counted, difference, notes });
    return { id, serial, expected, counted, difference, txn_id: txnId };
  })();
}

// ---------- رصيد أول المدة (الخزينة / البنك) ----------
// amount may be negative for the bank (an overdraft).
export function postTreasuryOpening(input = {}, ctx = {}) {
  const account = input.account;
  if (!['cash', 'bank'].includes(account)) throw bad('account', 'اختار الخزينة أو البنك');
  const date = realDate(input.date);
  const v = Number.isSafeInteger(input.amount_millimes) ? input.amount_millimes : parseMoney(input.amount);
  if (v === null || Number.isNaN(v)) throw bad('amount', 'اكتب الرصيد رقم صحيح');
  if (v === 0) throw bad('amount', 'الرصيد صفر — مفيش حاجة تتسجل');
  const negative = v < 0;
  const a = Math.abs(v);
  if (negative && account === 'cash') throw bad('amount', 'رصيد الخزينة مينفعش يكون بالسالب');
  const lines = negative
    ? [{ account: 'opening_equity', debit: a }, { account, credit: a }]
    : [{ account, debit: a }, { account: 'opening_equity', credit: a }];
  const t = post('opening', date, `رصيد أول المدة — ${account === 'cash' ? 'الخزينة' : 'البنك'}`, lines,
    { userId: ctx.userId, docType: 'treasury_opening', importRunId: ctx.importRunId });
  return { txn_id: t.id, serial: t.serial };
}
