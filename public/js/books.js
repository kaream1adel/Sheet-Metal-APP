// الحسابات (admin): where the money stands — sales, expenses, profit, cash — and
// المصروفات. All figures are computed on the server from the records themselves.
import { h, toast, money, fmtDate, todayISO, formModal, fill, icon, pageHead, emptyState, skeleton } from './ui.js';
import { get, post } from './api.js';

const TABS = [['overview', 'نظرة عامة', 'chart-line-up'], ['expenses', 'المصروفات', 'receipt'], ['balances', 'أرصدة العملاء', 'users-three']];
const MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const monthName = (ym) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;

export async function renderAccounts(main) {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  let tab = TABS.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'overview';
  const body = h('div');
  const tabs = h('div', { class: 'tabs' });
  const drawTabs = () => fill(tabs, TABS.map(([k, label, ic]) => h('button', { class: `tab${k === tab ? ' on' : ''}`, onclick: () => { tab = k; history.replaceState(null, '', `#/accounts?tab=${k}`); drawTabs(); show(); } }, icon(ic), ' ', label)));
  async function show() {
    fill(body, skeleton());
    try {
      if (tab === 'overview') await overview(body);
      else if (tab === 'expenses') await expenses(body);
      else await balances(body);
    } catch (ex) { fill(body, emptyState('warning', 'حصلت مشكلة', ex.message)); }
  }
  fill(main,
    pageHead('الحسابات', 'المبيعات والمصروفات والربح والفلوس اللي في إيدك — من الورق والتسعير والدفعات نفسها.',
      h('button', { class: 'btn primary', onclick: () => addExpense().then((ok) => ok && show()) }, icon('plus'), 'مصروف جديد')),
    tabs, body);
  drawTabs();
  await show();
}

async function overview(box) {
  const s = await get('/api/accounts/summary');
  const m = s.this_month;
  const max = Math.max(1, ...s.rows.map((r) => Math.max(r.sales + r.additions, r.expenses)));
  const catMax = Math.max(1, ...s.by_category.map((c) => c.amount));
  fill(box,
    h('div', { class: 'grid stats' },
      kpi('المبيعات الشهر ده', m.sales + m.additions - m.discounts, 'شغل اتسعر (بعد الخصومات)'),
      kpi('المصروفات', m.expenses, 'كل اللي اتصرف'),
      kpi('صافي الربح', m.profit, 'المبيعات ناقص المصروفات', m.profit < 0 ? 'owe' : 'credit'),
      kpi('اتحصل', m.collected, 'دفعات اتقبضت فعلاً'),
      kpi('الكاش', m.cash, 'اللي اتحصل ناقص اللي اتصرف', m.cash < 0 ? 'owe' : '')),
    h('div', { class: 'section-title' }, h('h2', {}, 'آخر 12 شهر')),
    s.rows.length === 0 ? emptyState('chart-line-up', 'لسه مفيش حسابات', 'لما تسعّر شغل أو تسجل دفعة أو مصروف، هيظهر هنا.') :
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['الشهر', 'المبيعات', 'المصروفات', '', 'صافي الربح', 'اتحصل'].map((x) => h('th', {}, x)))),
        h('tbody', {}, s.rows.map((r) => h('tr', {},
          h('td', {}, monthName(r.month)),
          h('td', { class: 'num' }, money(r.sales + r.additions - r.discounts)),
          h('td', { class: 'num' }, money(r.expenses)),
          h('td', { style: 'width:22%' }, h('div', { class: 'bar-chart' },
            h('i', { title: 'مبيعات', style: `display:block;height:7px;border-radius:4px;background:var(--accent);width:${((r.sales + r.additions) / max) * 100}%` }),
            h('i', { title: 'مصروفات', style: `display:block;height:7px;border-radius:4px;background:#f79009;width:${(r.expenses / max) * 100}%` }))),
          h('td', { class: `num${r.profit < 0 ? ' owe-t' : ''}` }, money(r.profit)),
          h('td', { class: 'num' }, money(r.collected))))),
        h('tfoot', {}, h('tr', {}, h('th', {}, 'الإجمالي'), h('th', { class: 'num' }, money(s.totals.sales + s.totals.additions - s.totals.discounts)),
          h('th', { class: 'num' }, money(s.totals.expenses)), h('th', {}), h('th', { class: 'num' }, money(s.totals.profit)), h('th', { class: 'num' }, money(s.totals.collected)))))),
    h('div', { class: 'section-title' }, h('h2', {}, 'المصروفات الشهر ده حسب النوع')),
    s.by_category.length === 0 ? h('div', { class: 'card muted small' }, 'مفيش مصروفات الشهر ده.') :
      h('div', { class: 'card bar-chart' }, s.by_category.map((c) => h('div', { class: 'b' },
        h('span', {}, c.name), h('i', { class: 'out', style: `width:${(c.amount / catMax) * 100}%` }), h('span', { class: 'num' }, money(c.amount))))),
    h('p', { class: 'small muted' }, 'المبيعات = الشغل اللي اتسعر واتعتمد (مش لازم يكون اتدفع). الكاش = اللي اتقبض فعلاً ناقص المصروفات. الشيكات تحت التحصيل مش محسوبة لحد ما تتصرف.'));
}

const kpi = (label, value, hint, cls = '') => h('div', { class: `stat ${cls}`.trim(), title: hint },
  h('b', { class: 'num' }, money(value)), h('span', {}, label));

export async function addExpense() {
  const { categories, methods } = await get('/api/expenses');
  return formModal({
    title: 'مصروف جديد',
    submitLabel: 'سجّل المصروف',
    fields: [
      { name: 'amount', label: 'المبلغ (جنيه)', placeholder: 'مثلاً 1250 أو ١٢٥٠٫٥٠' },
      { name: 'category_id', label: 'النوع', type: 'select', options: categories.filter((c) => c.active).map((c) => [c.id, c.name]) },
      { name: 'exp_date', label: 'التاريخ', type: 'date', value: todayISO() },
      { name: 'payee', label: 'اتدفع لمين (اختياري)' },
      { name: 'method', label: 'طريقة الدفع', type: 'select', options: methods.map((m) => [m, m]), value: methods[0] },
      { name: 'notes', label: 'ملاحظات', type: 'textarea' },
    ],
    onSubmit: async (v) => { await post('/api/expenses', v); toast('اتسجل المصروف'); return true; },
  });
}

async function expenses(box) {
  const f = { from: `${todayISO().slice(0, 7)}-01`, to: todayISO(), category: '' };
  const list = h('div');
  const load = async () => {
    const q = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
    const { expenses: rows, categories } = await get(`/api/expenses?${q}`);
    const total = rows.filter((e) => !e.cancelled_at).reduce((s, e) => s + e.amount, 0);
    if (!catSel.options.length) {
      catSel.append(h('option', { value: '' }, 'كل الأنواع'), ...categories.map((c) => h('option', { value: c.id }, c.name)));
    }
    fill(list, rows.length === 0
      ? emptyState('receipt', 'مفيش مصروفات في الفترة دي', 'سجّل أي فلوس بتطلع: خامات، مرتبات، كهربا، إيجار…',
        h('button', { class: 'btn primary', onclick: () => addExpense().then((ok) => ok && load()) }, icon('plus'), 'مصروف جديد'))
      : [h('div', { class: 'small muted', style: 'margin-bottom:8px' }, `${rows.length} مصروف · الإجمالي `, h('b', { class: 'num' }, money(total))),
        h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, ['التاريخ', 'النوع', 'لمين', 'المبلغ', 'الطريقة', 'ملاحظات', ''].map((x) => h('th', {}, x)))),
          h('tbody', {}, rows.map((e) => h('tr', { class: e.cancelled_at ? 'cancelled-row' : '' },
            h('td', {}, fmtDate(e.exp_date)), h('td', {}, e.category_name), h('td', {}, e.payee || '—'),
            h('td', { class: 'num' }, money(e.amount)), h('td', { class: 'small' }, e.method || '—'),
            h('td', { class: 'small muted' }, e.cancelled_at ? `اتلغى: ${e.cancel_reason}` : e.notes || ''),
            h('td', {}, e.cancelled_at ? null : h('button', { class: 'btn sm ghost', onclick: async () => {
              const ok = await formModal({ title: 'إلغاء المصروف', submitLabel: 'إلغاء المصروف', fields: [{ name: 'reason', label: 'السبب (هيتسجل)' }],
                onSubmit: (v) => post(`/api/expenses/${e.id}/cancel`, v) });
              if (ok) { toast('اتلغى'); load(); }
            } }, 'إلغاء')))))))]);
  };
  const catSel = h('select', { onchange: (e) => { f.category = e.target.value; load(); } });
  fill(box,
    h('div', { class: 'row', style: 'margin-bottom:12px' },
      h('span', { class: 'muted small' }, 'من'), h('input', { type: 'date', value: f.from, onchange: (e) => { f.from = e.target.value; load(); } }),
      h('span', { class: 'muted small' }, 'إلى'), h('input', { type: 'date', value: f.to, onchange: (e) => { f.to = e.target.value; load(); } }),
      catSel,
      h('button', { class: 'btn ghost sm', onclick: async () => {
        const ok = await formModal({ title: 'نوع مصروف جديد', fields: [{ name: 'name', label: 'الاسم' }], onSubmit: (v) => post('/api/expense-categories', v) });
        if (ok) { catSel.replaceChildren(); load(); }
      } }, icon('plus'), 'نوع جديد')),
    list);
  await load();
}

async function balances(box) {
  const { clients, outstanding } = await get('/api/reports/balances');
  const owing = clients.filter((c) => c.balance !== 0).sort((a, b) => b.balance - a.balance);
  fill(box,
    h('div', { class: 'small muted', style: 'margin-bottom:10px' }, 'برة عند العملاء: ', h('b', { class: 'num owe-t' }, money(outstanding))),
    owing.length === 0 ? emptyState('check-circle', 'كل الأرصدة صفر', 'مفيش عميل عليه أو ليه فلوس.') : h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['العميل', 'الرصيد', 'آخر دفعة', 'أقدم شغل مش مدفوع'].map((x) => h('th', {}, x)))),
      h('tbody', {}, owing.map((c) => h('tr', { class: 'click', onclick: () => { location.hash = `#/clients/${c.id}`; } },
        h('td', {}, c.name),
        h('td', { class: `num ${c.balance > 0 ? 'owe-t' : ''}` }, `${money(Math.abs(c.balance))} ${c.balance > 0 ? 'عليه' : 'له'}`),
        h('td', {}, c.last_payment_date ? `${fmtDate(c.last_payment_date)} (${money(c.last_payment_amount)})` : '—'),
        h('td', {}, c.oldest_days !== null ? `${c.oldest_days} يوم` : '—')))))));
}
