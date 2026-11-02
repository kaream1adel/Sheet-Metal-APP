// المركز المالي (the admin home): لينا / علينا / الخزينة / البنك / صافي المركز, the cheques
// due this week, sheets waiting pricing, follow-ups due and a short needs-attention list.
// Every figure carries the screen it comes from (href), so the home is a set of doors.
//
// Balances come from the ledger. Client cheques we hold are not in the ledger until they are
// collected (spec: «تحت التحصيل», memo only): the client's receivable still holds the amount,
// so «شيكات في الحافظة» is an information line (memo: true) read from the cheques table and
// is never added to the totals — adding it would count every uncollected cheque twice.
import { getDb } from '../db.js';
import { balance, partyBalances } from '../ledger.js';
import { balanceWords } from '../money.js';
import { addDays, daysBetween } from './dates.js';
import { waitingSheetsCount } from '../pricing/service.js';

const sumPositive = (obj) => Object.values(obj).reduce((s, b) => s + Math.max(0, b), 0);
const sumNegative = (obj) => Object.values(obj).reduce((s, b) => s - Math.min(0, b), 0);

const dmy = (iso) => (iso ? iso.split('-').reverse().map(Number).join('/') : '');

const PORTFOLIO = "('in_portfolio','deposited')";

export function chequesDue(asOf, days = 7) {
  const db = getDb();
  const to = addDays(asOf, days - 1);
  const q = (direction, statuses) => db.prepare(`
    SELECT c.id, c.serial, c.number, c.bank, c.amount, c.due_date, c.status, c.direction, p.name AS party_name, c.party_id
    FROM cheques c LEFT JOIN parties p ON p.id = c.party_id
    WHERE c.direction = ? AND c.status IN ${statuses} AND c.due_date IS NOT NULL AND c.due_date <= ?
    ORDER BY c.due_date, c.id`).all(direction, to)
    .map((c) => ({ ...c, overdue: c.due_date < asOf, days_left: daysBetween(asOf, c.due_date) }));
  return { from: asOf, to, in: q('in', PORTFOLIO), out: q('out', "('issued')") };
}

// Client cheques we held at the end of asOf: received by then and not yet collected,
// endorsed or bounced by then. A cancelled cheque never counts. No asOf = held now.
export function chequesInPortfolio(asOf = null) {
  const db = getDb();
  if (!asOf) {
    return db.prepare(`SELECT COALESCE(SUM(amount), 0) AS s, COUNT(*) AS n FROM cheques
      WHERE direction = 'in' AND status IN ${PORTFOLIO}`).get();
  }
  return db.prepare(`SELECT COALESCE(SUM(amount), 0) AS s, COUNT(*) AS n FROM cheques
    WHERE direction = 'in' AND (received_date IS NULL OR received_date <= ?)
      AND (status IN ${PORTFOLIO}
        OR (status IN ('collected','endorsed') AND cleared_date > ?)
        OR (status = 'bounced' AND bounced_date > ?))`).get(asOf, asOf, asOf);
}

// The position at the end of asOf: every ledger figure is filtered on txn date <= asOf.
export function financialPosition(asOf = null) {
  const opts = { asOf: asOf || null };
  const clients = partyBalances('client', opts);
  const suppliers = partyBalances('supplier', opts);
  const partners = partyBalances('partner', opts);
  const workers = partyBalances('worker', opts);
  const chequesIn = chequesInPortfolio(asOf);
  const cashBal = balance('cash', null, opts);
  const bankBal = balance('bank', null, opts);
  // Cheques we wrote and that are not cleared yet: the ledger's أوراق الدفع.
  const chequesPayable = -balance('cheques_payable', null, opts);

  const line = (key, label, amount, href, extra = {}) => ({ key, label, amount, href, ...extra });
  const ours = [
    line('receivables', 'مستحقات على العملاء', sumPositive(clients), '#/reports/clients'),
    // memo: already inside «مستحقات على العملاء» until collected — shown, never summed
    line('cheques_in', 'شيكات في الحافظة (من ضمن المستحقات)', chequesIn.s, '#/cheques/in', { count: chequesIn.n, memo: true }),
    line('worker_advances', 'سلف العمال', sumPositive(workers), '#/workers'),
  ];
  // Rare but real: a supplier we paid in advance, a partner who took more than he put in.
  if (sumPositive(suppliers)) ours.push(line('supplier_advances', 'دفعات مقدمة للموردين', sumPositive(suppliers), '#/suppliers'));
  if (sumPositive(partners)) ours.push(line('partners_owe', 'مسحوبات شركاء زيادة', sumPositive(partners), '#/reports/partners'));

  const theirs = [
    line('partners', 'جاري الشركاء', sumNegative(partners), '#/reports/partners'),
    line('suppliers', 'الموردين', sumNegative(suppliers), '#/suppliers'),
    line('cheques_payable', 'شيكات علينا لسه ما اتصرفتش', chequesPayable, '#/cheques/out'),
  ];
  if (sumNegative(clients)) theirs.push(line('client_advances', 'دفعات مقدمة من عملاء', sumNegative(clients), '#/reports/clients'));
  if (sumNegative(workers)) theirs.push(line('workers_due', 'مستحقات للعمال', sumNegative(workers), '#/workers'));

  const total = (lines) => lines.reduce((s, l) => s + (l.memo ? 0 : l.amount), 0);
  const ours_total = total(ours);
  const theirs_total = total(theirs);
  const net_total = ours_total + cashBal + bankBal - theirs_total;
  return {
    as_of: asOf,
    ours, ours_total, theirs, theirs_total,
    cash_balance: cashBal, bank_balance: bankBal,
    net_total, net_text: net_total >= 0 ? 'المركز موجب' : 'المركز سالب',
  };
}

// What needs a look today. Each item: { kind, level: danger|warn, title, detail, href, count }.
export function needsAttention(asOf, { limit = 8 } = {}) {
  const db = getDb();
  const items = [];
  const overdueIn = db.prepare(`SELECT c.id, c.serial, c.number, c.amount, c.due_date, p.name AS party_name FROM cheques c
    LEFT JOIN parties p ON p.id = c.party_id WHERE c.direction = 'in' AND c.status IN ${PORTFOLIO} AND c.due_date < ? ORDER BY c.due_date`).all(asOf);
  for (const c of overdueIn) {
    items.push({ kind: 'cheque_in_overdue', level: 'danger', title: `شيك ${c.party_name || ''} عدّى ميعاده`,
      detail: `شيك ${c.number || c.serial} — كان يستحق من ${daysBetween(c.due_date, asOf)} يوم`, href: '#/cheques/in', cheque_amount: c.amount, date: c.due_date });
  }
  const overdueOut = db.prepare(`SELECT c.id, c.serial, c.number, c.amount, c.due_date, p.name AS party_name FROM cheques c
    LEFT JOIN parties p ON p.id = c.party_id WHERE c.direction = 'out' AND c.status = 'issued' AND c.due_date < ? ORDER BY c.due_date`).all(asOf);
  for (const c of overdueOut) {
    items.push({ kind: 'cheque_out_overdue', level: 'warn', title: `شيك لـ ${c.party_name || 'طرف'} ميعاده عدّى ولسه ما اتصرفش`,
      detail: `شيك ${c.number || c.serial} — اتأكد من رصيد البنك وسجّل الصرف`, href: '#/cheques/out', cheque_amount: c.amount, date: c.due_date });
  }
  const balances = partyBalances('client');
  const limited = db.prepare("SELECT id, name, credit_limit FROM parties WHERE kind = 'client' AND active = 1 AND credit_limit IS NOT NULL").all();
  for (const c of limited) {
    const b = balances[c.id] || 0;
    if (b > c.credit_limit) {
      items.push({ kind: 'over_credit_limit', level: 'danger', title: `${c.name} عدّى حد الائتمان`,
        detail: balanceWords(b).text, href: `#/clients/${c.id}/statement`, over_amount: b - c.credit_limit, party_id: c.id });
    }
  }
  const review = db.prepare("SELECT COUNT(*) AS n, MIN(sheet_date) AS oldest FROM op_sheets WHERE status = 'review' AND draft = 0").get();
  if (review.n) {
    items.push({ kind: 'sheets_in_review', level: 'warn', title: `${review.n} ورقة تشغيل مستنية المراجعة والاعتماد`,
      detail: `أقدمها بتاريخ ${dmy(review.oldest)}`, href: '#/ops/review', count: review.n });
  }
  const order = { danger: 0, warn: 1 };
  items.sort((a, b) => order[a.level] - order[b.level] || String(a.date || '').localeCompare(String(b.date || '')));
  return { items: items.slice(0, limit), count: items.length };
}

export function homeCounters(asOf) {
  const db = getDb();
  // the same counts as the pricing queue and the review queue (drafts are not in review yet,
  // sheets imported from the Excel were priced there)
  const waiting = waitingSheetsCount();
  const review = db.prepare("SELECT COUNT(*) AS n FROM op_sheets WHERE status = 'review' AND draft = 0").get().n;
  const follow = db.prepare('SELECT COUNT(*) AS n FROM follow_ups WHERE done = 0 AND next_date IS NOT NULL AND next_date <= ?').get(asOf).n;
  return { sheets_waiting_pricing: waiting, sheets_in_review: review, follow_ups_due: follow };
}
