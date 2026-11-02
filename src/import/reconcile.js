// المطابقة: every figure of the workbook next to the same figure read back from the app.
//   «ملخص العملاء»: each client's مدين / خصم / دائن / الرصيد and the total row
//   each work sheet's E1 (the posted items of that sheet)
//   «حسابات الشركاء»: each partner's دائن / مدين / الصافي and the total
//   totals of «المصروفات اليومية», «الشيكات», «الخامات» (cash / cheque)
//   «المخزن حاليا»: shown with the app's cash + bank and the explanation (the Excel figure
//     leaves out the partners' money), never forced to match
// App values come from the ledger and the run's documents (live, so a rollback shows zeros).
// A line matches when the difference is below half a piastre (it prints as 0.00).
import { getDb } from '../db.js';
import { balance } from '../ledger.js';
import { formatMoney } from '../money.js';
import { toMillimes } from './parse.js';

const m = (x) => (x === null || x === undefined ? 0 : toMillimes(x));
const okDiff = (d) => Math.abs(d) < 5;

function line(group, label, excel, app, extra = {}) {
  const diff = app - excel;
  return { group, label, excel_amount: excel, app_amount: app, diff_amount: diff, ok: okDiff(diff), ...extra };
}

// Per client on the receivable account: مدين / خصم / دائن like the كشف (live transactions only).
function clientFigures(partyId) {
  const rows = getDb().prepare(`
    SELECT SUM(p.debit) - SUM(p.credit) AS net,
      EXISTS (SELECT 1 FROM postings x WHERE x.txn_id = t.id AND x.account = 'discount_given') AS is_discount
    FROM postings p JOIN txns t ON t.id = p.txn_id
    WHERE p.account = 'receivable' AND p.party_id = ? AND t.status = 'posted' AND t.reversal_of IS NULL
    GROUP BY t.id`).all(partyId);
  const out = { debit: 0, discount: 0, credit: 0, balance: 0 };
  for (const r of rows) {
    if (r.net > 0) out.debit += r.net;
    else if (r.is_discount) out.discount -= r.net;
    else out.credit -= r.net;
    out.balance += r.net;
  }
  return out;
}

function partnerFigures(partyId) {
  const r = getDb().prepare(`SELECT COALESCE(SUM(p.credit), 0) AS credit, COALESCE(SUM(p.debit), 0) AS debit
    FROM postings p JOIN txns t ON t.id = p.txn_id
    WHERE p.account = 'partner' AND p.party_id = ? AND t.status = 'posted' AND t.reversal_of IS NULL`).get(partyId);
  return { credit: r.credit, debit: r.debit, net: r.credit - r.debit };
}

const inList = (ids) => (ids.length ? ids.map(Number).filter(Number.isInteger).join(',') : 'NULL');

// partyOf(groupId) → party id (from the run's parties). created: applyPlan's result.
export function reconcile(plan, created, partyOf) {
  const db = getDb();
  const rows = [];
  const t = plan.targets;

  // clients
  const PARTS = [['debit', 'المدين'], ['discount', 'الخصم'], ['credit', 'الدائن'], ['balance', 'الرصيد']];
  const total = { debit: 0, discount: 0, credit: 0, balance: 0 };
  for (const c of t.clients) {
    const id = partyOf(c.client);
    const app = id ? clientFigures(id) : { debit: 0, discount: 0, credit: 0, balance: 0 };
    const parts = PARTS.map(([k, label]) => ({ key: k, label, ...line('client', label, m(c[k]), app[k]) }));
    rows.push({ ...line('clients', c.name, m(c.balance), app.balance), parts, ok: parts.every((p) => p.ok) });
  }
  if (t.clients_total) {
    const all = db.prepare("SELECT id FROM parties WHERE kind = 'client'").all();
    for (const p of all) { const f = clientFigures(p.id); for (const k of Object.keys(total)) total[k] += f[k]; }
    const tt = { ...t.clients_total, balance: t.clients_total.balance ?? ((t.clients_total.debit ?? 0) - (t.clients_total.discount ?? 0) - (t.clients_total.credit ?? 0)) };
    const parts = PARTS.map(([k, label]) => ({ key: k, label, ...line('client', label, m(tt[k]), total[k]) }));
    rows.push({ ...line('clients', 'إجمالي العملاء', m(tt.balance), total.balance), parts, ok: parts.every((p) => p.ok), total: true });
  }

  // work sheets (E1)
  for (const w of t.work) {
    const app = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS s FROM price_items WHERE status = 'posted' AND id IN (${inList(created.items)})
      AND substr(import_ref, 1, ?) = ?`).get(w.sheet.length + 1, `${w.sheet}!`).s;
    rows.push(line('work', w.sheet, m(w.e1), app));
  }

  // partners
  const pt = { credit: 0, debit: 0, net: 0 };
  const PP = [['credit', 'دائن (دفعه)'], ['debit', 'مدين (أخده)'], ['net', 'الصافي له']];
  for (const p of t.partners) {
    const id = partyOf(p.partner);
    const app = id ? partnerFigures(id) : { credit: 0, debit: 0, net: 0 };
    for (const k of Object.keys(pt)) pt[k] += app[k];
    const parts = PP.map(([k, label]) => ({ key: k, label, ...line('partner', label, m(p[k]), app[k]) }));
    rows.push({ ...line('partners', p.name, m(p.net), app.net), parts, ok: parts.every((x) => x.ok) });
  }
  if (t.partners_total) {
    const tt = { ...t.partners_total, net: t.partners_total.net ?? ((t.partners_total.credit ?? 0) - (t.partners_total.debit ?? 0)) };
    const parts = PP.map(([k, label]) => ({ key: k, label, ...line('partner', label, m(tt[k]), pt[k]) }));
    rows.push({ ...line('partners', 'إجمالي الشركاء', m(tt.net), pt.net), parts, ok: parts.every((x) => x.ok), total: true });
  }

  // ledgers
  const vouchersTotal = (ids, where = '1=1') => db.prepare(`SELECT COALESCE(SUM(total), 0) AS s FROM vouchers
    WHERE status = 'posted' AND id IN (${inList(ids)}) AND ${where}`).get().s;
  if (t.expenses !== null) rows.push(line('ledgers', 'إجمالي المصروفات اليومية', m(t.expenses), vouchersTotal(created.by_source.daily)));
  if (t.cheques !== null) {
    const vids = [...created.by_source.partners.filter((x) => x.cheque).map((x) => x.id), ...created.by_source.other_cheques];
    const app = db.prepare(`SELECT COALESCE(SUM(c.amount), 0) AS s FROM cheques c JOIN vouchers v ON v.cheque_id = c.id
      WHERE v.id IN (${inList(vids)}) AND c.status IN ('issued','cleared')`).get().s;
    rows.push(line('ledgers', 'إجمالي الشيكات المصروفة', m(t.cheques), app));
  }
  if (t.materials_cash !== null) rows.push(line('ledgers', 'الخامات المدفوعة كاش', m(t.materials_cash), vouchersTotal(created.by_source.materials, "paid_from = 'cash'")));
  if (t.materials_cheque !== null) rows.push(line('ledgers', 'الخامات المدفوعة بشيك', m(t.materials_cheque), vouchersTotal(created.by_source.materials, "paid_from = 'cheque'")));

  // the cash figure of «المخزن حاليا»: shown, explained, not forced
  if (t.store !== null) {
    const cash = balance('cash');
    const bank = balance('bank');
    const rIds = created.by_source.partners.filter((x) => x.type === 'receipt').map((x) => x.id);
    const vIds = created.by_source.partners.filter((x) => x.type === 'voucher' && !x.cheque).map((x) => x.id);
    const deposits = db.prepare(`SELECT COALESCE(SUM(amount), 0) s FROM receipts WHERE status = 'posted' AND id IN (${inList(rIds)})`).get().s;
    const withdrawals = db.prepare(`SELECT COALESCE(SUM(total), 0) s FROM vouchers WHERE status = 'posted' AND kind = 'partner_withdrawal'
      AND paid_from IN ('cash','bank') AND id IN (${inList(vIds)})`).get().s;
    const excel = m(t.store);
    const app = cash + bank;
    const partnerNet = deposits - withdrawals;
    const explained = app - excel - partnerNet;
    rows.push({
      ...line('store', 'المخزن حاليا (الخزينة + البنك)', excel, app), ok: true, known: true, explained_ok: okDiff(explained),
      cash_balance: cash, bank_balance: bank, partner_deposits_amount: deposits, partner_withdrawals_amount: withdrawals,
      note: `رقم الإكسيل غلط معروف: بيحسب المحصّل من العملاء ناقص المصروفات والشيكات والخامات، ومش بيحسب فلوس الشركاء. إيداعات الشركاء ${formatMoney(deposits)} ناقص سحبهم النقدي ${formatMoney(withdrawals)} = ${formatMoney(partnerNet)}${okDiff(explained) ? '، وده بالظبط الفرق.' : `، والباقي من الفرق ${formatMoney(explained)} محتاج مراجعة.`}`,
    });
  }

  const warnings = [];
  const cashNow = balance('cash');
  if (cashNow < 0) {
    warnings.push(`رصيد الخزينة بالسالب (${formatMoney(cashNow)}): المصروفات اتصرفت من الخزينة وإيداعات الشركاء اتسجلت في البنك. لو فلوس الشريك دخلت الخزينة غيّر حساب الإيداع في تبويب الشركاء، أو سجّل تحويل من البنك للخزينة بعد الاستيراد.`);
  }
  const checked = rows.filter((r) => !r.known);
  return { rows, warnings, ok: checked.every((r) => r.ok), mismatches: checked.filter((r) => !r.ok).length, at: new Date().toISOString() };
}
