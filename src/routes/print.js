// Printable pages (statement, delivery note, receipt). The browser prints them or
// saves them as PDF, so Arabic shaping is always right and no PDF library is needed.
import { Router } from 'express';
import { getDb } from '../db.js';
import { can } from '../permissions.js';
import { getSettings, nextSerial } from '../settings.js';
import { statement } from '../ledger.js';
import { loadDelivery } from './deliveries.js';
import { parseDate, todayISO } from '../util.js';

export const print = Router();

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (p) => {
  if (p === null || p === undefined || p === '') return '';
  const v = Math.abs(p);
  return `${p < 0 ? '-' : ''}${Math.floor(v / 100).toLocaleString('en-US')}.${String(v % 100).padStart(2, '0')}`;
};
const d = (iso) => {
  if (!iso || iso.startsWith('0000')) return '';
  const [y, m, day] = iso.slice(0, 10).split('-');
  return `${Number(day)}/${Number(m)}/${y}`;
};

function page(title, body) {
  const s = getSettings();
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  @page { size: A4; margin: 14mm; }
  body { font-family: "Segoe UI", Tahoma, Arial, sans-serif; color: #111; font-size: 13px; margin: 0; padding: 20px; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #1f4e79; padding-bottom: 10px; margin-bottom: 12px; }
  .co b { font-size: 20px; color: #1f4e79; display: block; }
  .co span { color: #555; font-size: 12px; }
  .doc { text-align: left; }
  .doc b { font-size: 18px; display: block; }
  .doc span { color: #555; font-size: 12px; }
  .meta { display: flex; justify-content: space-between; margin: 8px 0 12px; flex-wrap: wrap; gap: 8px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border-bottom: 1px solid #ddd; padding: 6px 5px; text-align: right; vertical-align: top; }
  th { background: #f1f4f7; font-size: 12px; color: #444; }
  td.n, th.n { text-align: left; direction: ltr; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .sub { color: #666; font-size: 11.5px; }
  .tot { margin-top: 14px; padding: 10px 12px; background: #f1f4f7; display: flex; justify-content: space-between; font-size: 14px; }
  .tot b { font-size: 16px; }
  .sign { display: flex; justify-content: space-between; margin-top: 50px; }
  .sign div { border-top: 1px solid #333; width: 40%; padding-top: 6px; text-align: center; color: #444; }
  .bar { margin-bottom: 14px; display: flex; gap: 8px; }
  .bar button { font: inherit; padding: 8px 16px; border: 1px solid #1f4e79; background: #1f4e79; color: #fff; border-radius: 6px; cursor: pointer; }
  .bar button.alt { background: #fff; color: #1f4e79; }
  @media print { .bar { display: none; } body { padding: 0; } }
</style></head><body>
<div class="bar"><button onclick="window.print()">طباعة / حفظ PDF</button><button class="alt" onclick="history.length > 1 ? history.back() : window.close()">رجوع</button></div>
<div class="head"><div class="co"><b>${esc(s.company_name)}</b><span>${esc(s.company_address)}${s.company_address && s.company_phone ? ' · ' : ''}${s.company_phone ? 'ت: ' + esc(s.company_phone) : ''}</span></div>
${body}</body></html>`;
}

const deny = (res) => res.status(403).send(page('غير مسموح', '</div><p>مش مسموح لك تفتح الصفحة دي.</p>'));

// ---------- client statement ----------
print.get('/print/statement/:clientId', (req, res) => {
  if (!req.user) return res.redirect('/');
  if (!can(req.user, 'money.view')) return deny(res);
  const client = getDb().prepare('SELECT * FROM clients WHERE id = ?').get(req.params.clientId);
  if (!client) return res.status(404).send('not found');
  const from = parseDate(req.query.from) || null;
  const to = parseDate(req.query.to) || null;
  const full = req.query.detail === 'full';
  const st = statement(client.id, from, to);
  const serial = nextSerial('statement');
  const rows = st.rows.map((r) => `<tr>
      <td>${d(r.date)}</td>
      <td>${esc(r.text)}${r.kind === 'item' && r.summary ? `<div class="sub">${esc(r.summary)}</div>` : ''}${full && r.lines ? r.lines.map((l) => `<div class="sub">↳ ${esc(l.text)}</div>`).join('') : ''}</td>
      <td>${d(r.delivered)}</td><td>${d(r.due)}</td>
      <td class="n">${r.amount > 0 ? money(r.amount) : ''}</td>
      <td class="n">${r.amount < 0 ? money(-r.amount) : ''}</td>
      <td class="n">${money(r.balance)}</td></tr>`).join('');
  const pending = getDb().prepare(`SELECT * FROM payments WHERE client_id = ? AND is_cheque = 1 AND cheque_status = 'pending' AND cancelled_at IS NULL ORDER BY cheque_due`).all(client.id);
  const body = `<div class="doc"><b>كشف حساب</b><span>رقم ${String(serial).padStart(4, '0')} · طبع ${d(todayISO())}</span></div></div>
    <div class="meta"><span>العميل: <b>${esc(client.name)}</b>${client.phone ? ' · ' + esc(client.phone) : ''}</span>
      <span>الفترة: ${from ? d(from) : 'من البداية'} — ${to ? d(to) : d(todayISO())}</span></div>
    <table><thead><tr><th>التاريخ</th><th>البيان</th><th>التسليم</th><th>الاستحقاق</th><th class="n">عليه</th><th class="n">له</th><th class="n">الرصيد</th></tr></thead>
    <tbody>${from ? `<tr><td></td><td>رصيد سابق</td><td></td><td></td><td></td><td></td><td class="n">${money(st.carried)}</td></tr>` : ''}${rows}</tbody></table>
    <div class="tot"><span>إجمالي الشغل والإضافات ${money(st.debit)} · المدفوع والخصومات ${money(st.credit)}</span>
      <span>${st.closing >= 0 ? 'المطلوب' : 'رصيد للعميل'}: <b>${money(Math.abs(st.closing))} ج</b></span></div>
    ${pending.length ? `<p class="sub">شيكات تحت التحصيل (مش محسوبة في الرصيد): ${pending.map((p) => `${money(p.amount)} ج استحقاق ${d(p.cheque_due)}`).join(' · ')}</p>` : ''}`;
  res.send(page(`كشف حساب ${client.name}`, body));
});

// ---------- delivery note (no prices) ----------
print.get('/print/delivery/:id', (req, res) => {
  if (!req.user) return res.redirect('/');
  if (!can(req.user, 'deliveries.manage')) return deny(res);
  let dl;
  try { dl = loadDelivery(req.params.id); } catch { return res.status(404).send('not found'); }
  const rows = dl.lines.map((l, i) => `<tr><td class="n">${i + 1}</td><td>${d(l.date)}</td><td>${esc(l.text)}</td><td>${esc(l.qty)}</td></tr>`).join('');
  const body = `<div class="doc"><b>إذن تسليم</b><span>رقم ${String(dl.id).padStart(4, '0')} · ${d(dl.delivery_date)}</span></div></div>
    <div class="meta"><span>العميل: <b>${esc(dl.client_name)}</b></span>${dl.receiver ? `<span>المستلم: ${esc(dl.receiver)}</span>` : ''}</div>
    ${dl.cancelled_at ? '<p><b>⚠ إذن التسليم ده اتلغى</b></p>' : ''}
    <table><thead><tr><th class="n">#</th><th>تاريخ الشغل</th><th>الشغل</th><th>الكمية</th></tr></thead><tbody>${rows}</tbody></table>
    ${dl.notes ? `<p>ملاحظات: ${esc(dl.notes)}</p>` : ''}
    <div class="sign"><div>توقيع المستلم</div><div>توقيع الورشة</div></div>`;
  res.send(page(`إذن تسليم ${dl.id}`, body));
});

// ---------- payment receipt ----------
print.get('/print/receipt/:id', (req, res) => {
  if (!req.user) return res.redirect('/');
  if (!can(req.user, 'money.view')) return deny(res);
  const p = getDb().prepare('SELECT p.*, c.name AS client_name FROM payments p JOIN clients c ON c.id = p.client_id WHERE p.id = ?').get(req.params.id);
  if (!p) return res.status(404).send('not found');
  const bal = statement(p.client_id, null, null).closing;
  const body = `<div class="doc"><b>إيصال استلام</b><span>رقم ${String(p.id).padStart(4, '0')} · ${d(p.pay_date)}</span></div></div>
    ${p.cancelled_at ? '<p><b>⚠ الدفعة دي اتلغت</b></p>' : ''}
    <table><tbody>
      <tr><th>استلمنا من</th><td>${esc(p.client_name)}</td></tr>
      <tr><th>مبلغ</th><td class="n">${money(p.amount)} ج</td></tr>
      <tr><th>طريقة الدفع</th><td>${esc(p.method)}${p.reference ? ' — ' + esc(p.reference) : ''}</td></tr>
      ${p.is_cheque ? `<tr><th>الشيك</th><td>استحقاق ${d(p.cheque_due)} · ${p.cheque_status === 'cleared' ? 'اتصرف' : p.cheque_status === 'bounced' ? 'رجع' : 'تحت التحصيل'}</td></tr>` : ''}
      ${p.notes ? `<tr><th>ملاحظات</th><td>${esc(p.notes)}</td></tr>` : ''}
      <tr><th>الرصيد بعد الدفعة</th><td class="n">${money(bal)} ج</td></tr>
    </tbody></table>
    <div class="sign"><div>توقيع المستلم</div><div>توقيع العميل</div></div>`;
  res.send(page(`إيصال ${p.id}`, body));
});
