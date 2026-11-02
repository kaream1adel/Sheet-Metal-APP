// جاري الشركاء: per partner دائن (ما دفعه) / مدين (ما أخذه) / صافي المستحق, and the total.
// Like ملخص العملاء, a cancelled transaction and its reversal are left out of the columns
// (they cancel exactly), so «ما دفعه» is what he really put in.
import { getDb } from '../db.js';
import { balanceWords } from '../money.js';

export function partnersReport() {
  const db = getDb();
  const sums = db.prepare(`
    SELECT p.party_id, COALESCE(SUM(p.credit), 0) AS cr, COALESCE(SUM(p.debit), 0) AS dr, MAX(t.date) AS last_date
    FROM postings p JOIN txns t ON t.id = p.txn_id
    WHERE p.account = 'partner' AND t.status = 'posted' AND t.reversal_of IS NULL
    GROUP BY p.party_id`).all();
  const by = new Map(sums.map((s) => [s.party_id, s]));
  const rows = db.prepare("SELECT id, name, active FROM parties WHERE kind = 'partner' ORDER BY name").all().map((p) => {
    const s = by.get(p.id) || { cr: 0, dr: 0, last_date: null };
    // balance = debit − credit (the ledger's sign): negative = له عندنا.
    const bal = s.dr - s.cr;
    return {
      id: p.id, name: p.name, active: !!p.active,
      paid_total: s.cr, taken_total: s.dr, net_amount: s.cr - s.dr,
      balance: bal, balance_text: balanceWords(bal).text, last_date: s.last_date,
    };
  });
  const totals = {
    paid_total: rows.reduce((s, r) => s + r.paid_total, 0),
    taken_total: rows.reduce((s, r) => s + r.taken_total, 0),
  };
  totals.net_amount = totals.paid_total - totals.taken_total;
  totals.balance = -totals.net_amount;
  totals.balance_text = balanceWords(totals.balance).text;
  return { rows, totals };
}
