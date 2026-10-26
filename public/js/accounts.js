// Admin money screens: client page, payments, follow-up, settings.
import { h, toast, money, fmtDate, fmtNum, todayISO, formModal, confirmModal } from './ui.js';
import { get, post, put, api } from './api.js';
import { state } from './app.js';
import { backupsCard, updateCard, autostartCard } from './system.js';
import { machinesCard, auditCard } from './reports.js';

const pill = (cls, text) => h('span', { class: `pill ${cls}` }, text);
const chequeName = { pending: 'تحت التحصيل', cleared: 'اتصرف', bounced: 'رجع' };

// Egyptian mobile 01xxxxxxxxx → wa.me/201xxxxxxxxx
const waLink = (phone, text) => {
  let p = String(phone || '').replace(/\D/g, '');
  if (p.startsWith('0')) p = '2' + p;
  return p ? `https://wa.me/${p}?text=${encodeURIComponent(text)}` : null;
};

export async function addPaymentModal(clientId) {
  const { settings } = await get('/api/settings');
  const clients = state.lookups.clients;
  const r = await formModal({
    title: 'دفعة جديدة',
    fields: [
      ...(clientId ? [] : [{ name: 'client_id', label: 'العميل', type: 'select', options: clients.map((c) => [c.id, c.name]) }]),
      { name: 'amount', label: 'المبلغ (جنيه)' },
      { name: 'pay_date', label: 'التاريخ', type: 'date', value: todayISO() },
      { name: 'method', label: 'طريقة الدفع', type: 'select', value: settings.payment_methods[0], options: settings.payment_methods.map((m) => [m, m]) },
      { name: 'cheque_due', label: 'تاريخ استحقاق الشيك (للشيكات بس)', type: 'date' },
      { name: 'reference', label: 'رقم مرجع / رقم الشيك (اختياري)' },
      { name: 'notes', label: 'ملاحظة', type: 'textarea' },
    ],
    submitLabel: 'سجّل الدفعة',
    onSubmit: (v) => post('/api/payments', { ...v, client_id: clientId || v.client_id }),
  });
  if (r && r.payment) {
    toast(`اتسجلت الدفعة — الرصيد ${money(r.balance)}`);
    return r;
  }
  return null;
}

async function chequeAction(p, status) {
  const label = status === 'cleared' ? 'الشيك اتصرف' : 'الشيك رجع';
  const r = status === 'cleared'
    ? await formModal({ title: label, fields: [{ name: 'date', label: 'تاريخ الصرف', type: 'date', value: todayISO() }],
      onSubmit: (v) => post(`/api/payments/${p.id}/cheque`, { status, date: v.date }) })
    : (await confirmModal(label, `شيك ${money(p.amount)} — هيتشال من المدفوعات ويرجع على العميل.`, 'تمام')) &&
      (await post(`/api/payments/${p.id}/cheque`, { status }));
  if (r) toast(`${label} — الرصيد ${money(r.balance)}`);
  return !!r;
}

const cancelWithReason = (title, url) => formModal({ title, fields: [{ name: 'reason', label: 'السبب (هيتسجل)' }], submitLabel: 'إلغاء',
  onSubmit: (v) => post(url, v) });

// ---------- client page ----------
export async function renderClientPage(main, id, tab = 'statement') {
  const acc = await get(`/api/clients/${id}/account`);
  const c = acc.client;
  const reload = (t = tab) => renderClientPage(main, id, t);
  const tabs = [['statement', 'كشف الحساب'], ['payments', 'المدفوعات'], ['adjustments', 'التسويات'], ['promises', 'وعود الدفع'], ['prices', 'ذاكرة الأسعار'], ['batches', 'التسعيرات']];
  const body = h('div');
  main.replaceChildren(
    h('div', { class: 'top' },
      h('div', {}, h('h1', {}, c.name), h('div', { class: 'small muted' }, c.phone || 'مفيش تليفون', c.notes ? ` · ${c.notes}` : '')),
      h('div', { class: 'row' },
        h('div', { class: `stat ${acc.balance > 0 ? 'owe' : 'credit'}`, style: 'padding:8px 16px' },
          h('span', {}, acc.balance > 0 ? 'عليه' : acc.balance < 0 ? 'له' : 'الرصيد'), h('b', { class: 'num' }, money(Math.abs(acc.balance)))),
        h('button', { class: 'btn primary', onclick: async () => { if (await addPaymentModal(c.id)) reload('payments'); } }, '+ دفعة'),
        h('a', { class: 'btn', href: `#/pricing/${c.id}` }, 'تسعير شغله'))),
    h('div', { class: 'tabs' }, tabs.map(([k, l]) => h('button', { class: 'tab' + (k === tab ? ' on' : ''), onclick: () => reload(k) }, l))),
    body);

  if (tab === 'statement') {
    const fromIn = h('input', { type: 'date' });
    const toIn = h('input', { type: 'date' });
    const detail = h('select', {}, h('option', { value: '' }, 'مختصر'), h('option', { value: 'full' }, 'تفصيلي'));
    const box = h('div');
    const load = async () => {
      const q = new URLSearchParams(Object.entries({ from: fromIn.value, to: toIn.value }).filter(([, v]) => v));
      const st = await get(`/api/clients/${id}/statement?${q}`);
      box.replaceChildren(h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['التاريخ', 'البيان', 'التسليم', 'الاستحقاق', 'عليه', 'له', 'الرصيد'].map((t) => h('th', {}, t)))),
        h('tbody', {},
          st.from ? h('tr', {}, h('td'), h('td', {}, 'رصيد سابق'), h('td'), h('td'), h('td'), h('td'), h('td', { class: 'num' }, money(st.carried))) : null,
          st.rows.map((r) => h('tr', {},
            h('td', {}, r.date.startsWith('0000') ? '' : fmtDate(r.date)),
            h('td', {}, r.text, r.summary ? h('div', { class: 'small muted' }, r.summary) : null,
              detail.value === 'full' && r.lines ? r.lines.map((l) => h('div', { class: 'small muted' }, `↳ ${l.text}`)) : null),
            h('td', { class: 'small' }, r.delivered ? fmtDate(r.delivered) : ''),
            h('td', { class: 'small' }, r.due ? fmtDate(r.due) : ''),
            h('td', { class: 'num' }, r.amount > 0 ? money(r.amount) : ''),
            h('td', { class: 'num' }, r.amount < 0 ? money(-r.amount) : ''),
            h('td', { class: 'num' }, money(r.balance))))))),
      h('div', { class: 'row', style: 'justify-content:space-between;margin-top:10px' },
        h('span', { class: 'muted' }, `الشغل والإضافات ${money(st.debit)} · المدفوع والخصومات ${money(st.credit)}`),
        h('b', {}, `${st.closing >= 0 ? 'المطلوب' : 'رصيد للعميل'}: ${money(Math.abs(st.closing))}`)),
      st.pending_cheques.length ? h('p', { class: 'small muted' }, 'شيكات تحت التحصيل (مش محسوبة): ',
        st.pending_cheques.map((p) => `${money(p.amount)} استحقاق ${fmtDate(p.cheque_due)}`).join(' · ')) : '');
    };
    const printUrl = () => `/print/statement/${id}?${new URLSearchParams(Object.entries({ from: fromIn.value, to: toIn.value, detail: detail.value }).filter(([, v]) => v))}`;
    const { settings } = await get('/api/settings');
    const wa = waLink(c.phone, `السلام عليكم، رصيد حسابكم لدى ${settings.company_name}: ${money(Math.abs(acc.balance))} ${acc.balance >= 0 ? 'مطلوب' : 'لكم'}. كشف الحساب مرفق.`);
    body.append(h('div', { class: 'row', style: 'margin-bottom:10px' },
      h('span', { class: 'muted small' }, 'من'), fromIn, h('span', { class: 'muted small' }, 'إلى'), toIn, detail,
      h('button', { class: 'btn', onclick: load }, 'عرض'),
      h('button', { class: 'btn primary', onclick: () => window.open(printUrl(), '_blank') }, 'طباعة / PDF'),
      wa ? h('a', { class: 'btn', href: wa, target: '_blank', rel: 'noopener' }, 'واتساب') : h('span', { class: 'small muted' }, 'ضيف تليفون العميل عشان واتساب')),
    h('p', { class: 'small muted' }, 'واتساب: افتح PDF من "طباعة / PDF" واحفظه، وبعدين ابعته في المحادثة اللي هتفتح.'), box);
    await load();
  }

  if (tab === 'payments') {
    body.append(acc.payments.length === 0 ? h('div', { class: 'card muted' }, 'مفيش مدفوعات.') :
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['التاريخ', 'المبلغ', 'الطريقة', 'مرجع', 'الحالة', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, acc.payments.map((p) => h('tr', { class: p.cancelled_at ? 'cancelled-row' : '' },
          h('td', {}, fmtDate(p.pay_date)), h('td', { class: 'num' }, money(p.amount)), h('td', {}, p.method),
          h('td', { class: 'small' }, p.reference || ''),
          h('td', {}, p.cancelled_at ? pill('cancelled', 'ملغية') : p.is_cheque
            ? pill(p.cheque_status === 'cleared' ? 'confirmed' : p.cheque_status === 'bounced' ? 'cancelled' : 'review', `شيك ${chequeName[p.cheque_status]} · ${fmtDate(p.cheque_due)}`)
            : pill('confirmed', 'اتدفعت')),
          h('td', {}, h('div', { class: 'row', style: 'flex-wrap:nowrap' },
            h('button', { class: 'btn sm', onclick: () => window.open(`/print/receipt/${p.id}`, '_blank') }, 'إيصال'),
            !p.cancelled_at && p.is_cheque && p.cheque_status === 'pending' ? [
              h('button', { class: 'btn sm', onclick: async () => { if (await chequeAction(p, 'cleared')) reload(); } }, 'اتصرف'),
              h('button', { class: 'btn sm danger', onclick: async () => { if (await chequeAction(p, 'bounced')) reload(); } }, 'رجع')] : null,
            !p.cancelled_at ? h('button', { class: 'btn sm danger', onclick: async () => { if (await cancelWithReason('إلغاء الدفعة', `/api/payments/${p.id}/cancel`)) reload(); } }, 'إلغاء') : null))))))));
  }

  if (tab === 'adjustments') {
    body.append(h('div', { class: 'row', style: 'margin-bottom:10px' },
      h('button', { class: 'btn', onclick: () => adj('discount') }, '+ خصم'),
      h('button', { class: 'btn', onclick: () => adj('charge') }, '+ مبلغ إضافي')),
    acc.adjustments.length === 0 ? h('div', { class: 'card muted' }, 'مفيش تسويات.') :
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['التاريخ', 'البيان', 'المبلغ', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, acc.adjustments.map((a) => h('tr', { class: a.cancelled_at ? 'cancelled-row' : '' },
          h('td', {}, fmtDate(a.adj_date)), h('td', {}, a.reason, a.batch_id ? h('span', { class: 'small muted' }, ' (مع تسعير)') : null),
          h('td', { class: 'num' }, money(a.amount)),
          h('td', {}, !a.cancelled_at && !a.batch_id ? h('button', { class: 'btn sm danger', onclick: async () => { if (await cancelWithReason('إلغاء التسوية', `/api/adjustments/${a.id}/cancel`)) reload(); } }, 'إلغاء') : null)))))));
    async function adj(kind) {
      const ok = await formModal({ title: kind === 'discount' ? 'خصم للعميل' : 'مبلغ إضافي على العميل',
        fields: [{ name: 'amount', label: 'المبلغ' }, { name: 'reason', label: 'السبب' }, { name: 'adj_date', label: 'التاريخ', type: 'date', value: todayISO() }],
        onSubmit: (v) => post('/api/adjustments', { ...v, kind, client_id: id }) });
      if (ok) { toast('اتسجل'); reload(); }
    }
  }

  if (tab === 'promises') {
    body.append(h('div', { class: 'row', style: 'margin-bottom:10px' }, h('button', { class: 'btn', onclick: async () => {
      const ok = await formModal({ title: 'العميل وعد يدفع', fields: [
        { name: 'promised_date', label: 'إمتى', type: 'date' }, { name: 'amount', label: 'كام (اختياري)' }, { name: 'notes', label: 'ملاحظة' }],
      onSubmit: (v) => post('/api/promises', { ...v, client_id: id }) });
      if (ok) { toast('اتسجل — هيظهر في المتابعة يومها'); reload(); }
    } }, '+ وعد بالدفع')),
    acc.promises.length === 0 ? h('div', { class: 'card muted' }, 'مفيش وعود.') :
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['الموعد', 'المبلغ', 'ملاحظة', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, acc.promises.map((p) => h('tr', { class: p.done_at ? 'cancelled-row' : '' },
          h('td', {}, fmtDate(p.promised_date)), h('td', { class: 'num' }, p.amount ? money(p.amount) : ''), h('td', {}, p.notes),
          h('td', {}, p.done_at ? 'خلص' : h('button', { class: 'btn sm', onclick: async () => { await post(`/api/promises/${p.id}/done`); reload(); } }, 'خلص'))))))));
  }

  if (tab === 'prices') {
    body.append(acc.prices.length === 0 ? h('div', { class: 'card muted' }, 'لسه مفيش أسعار محفوظة — بتتحفظ أوتوماتيك مع كل اعتماد تسعير.') :
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['المكنة', 'الوحدة', 'الخامة', 'السمك', 'السعر', 'آخر تحديث', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, acc.prices.map((p) => h('tr', {},
          h('td', {}, p.machine_name), h('td', {}, p.unit_label), h('td', {}, p.material_name || '—'), h('td', { class: 'num' }, p.thickness ? fmtNum(p.thickness) : '—'),
          h('td', { class: 'num' }, money(p.rate)), h('td', { class: 'small' }, fmtDate(p.updated_at)),
          h('td', {}, h('div', { class: 'row', style: 'flex-wrap:nowrap' },
            h('button', { class: 'btn sm', onclick: async () => {
              const ok = await formModal({ title: 'تعديل السعر', fields: [{ name: 'rate', label: 'السعر', value: (p.rate / 100).toFixed(2) }],
                onSubmit: (v) => put(`/api/clients/${id}/prices`, { ...p, rate: v.rate }) });
              if (ok) reload();
            } }, 'تعديل'),
            h('button', { class: 'btn sm danger', onclick: async () => { await api('DELETE', `/api/clients/${id}/prices`, p); reload(); } }, 'امسح')))))))));
  }

  if (tab === 'batches') {
    body.append(acc.batches.length === 0 ? h('div', { class: 'card muted' }, 'مفيش تسعيرات.') :
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['#', 'التاريخ', 'الإجمالي', 'الحالة', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, acc.batches.map((b) => h('tr', { class: b.cancelled_at ? 'cancelled-row' : '' },
          h('td', { class: 'num' }, b.id), h('td', {}, fmtDate(b.created_at)), h('td', { class: 'num' }, money(b.total)),
          h('td', {}, b.cancelled_at ? pill('cancelled', `اتلغى: ${b.cancel_reason}`) : pill('confirmed', 'معتمد')),
          h('td', {}, !b.cancelled_at ? h('button', { class: 'btn sm danger', onclick: async () => {
            if (await cancelWithReason('إلغاء التسعير', `/api/pricing/batches/${b.id}/cancel`)) { toast('اتلغى — السطور رجعت للتسعير'); reload(); }
          } }, 'إلغاء التسعير') : null)))))));
  }
}

// ---------- payments list ----------
export async function renderPayments(main) {
  let onlyCheques = false;
  const box = h('div');
  const load = async () => {
    const { payments } = await get('/api/payments' + (onlyCheques ? '?cheques=pending' : ''));
    box.replaceChildren(payments.length === 0 ? h('div', { class: 'card muted' }, 'مفيش مدفوعات.') :
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['التاريخ', 'العميل', 'المبلغ', 'الطريقة', 'الحالة', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, payments.map((p) => h('tr', { class: p.cancelled_at ? 'cancelled-row' : '' },
          h('td', {}, fmtDate(p.pay_date)), h('td', {}, h('a', { href: `#/clients/${p.client_id}` }, p.client_name)),
          h('td', { class: 'num' }, money(p.amount)), h('td', {}, p.method),
          h('td', {}, p.cancelled_at ? pill('cancelled', 'ملغية') : p.is_cheque ? pill(p.cheque_status === 'pending' ? 'review' : p.cheque_status === 'cleared' ? 'confirmed' : 'cancelled', `شيك ${chequeName[p.cheque_status]} · ${fmtDate(p.cheque_due)}`) : ''),
          h('td', {}, h('div', { class: 'row', style: 'flex-wrap:nowrap' },
            h('button', { class: 'btn sm', onclick: () => window.open(`/print/receipt/${p.id}`, '_blank') }, 'إيصال'),
            !p.cancelled_at && p.is_cheque && p.cheque_status === 'pending' ? [
              h('button', { class: 'btn sm', onclick: async () => { if (await chequeAction(p, 'cleared')) load(); } }, 'اتصرف'),
              h('button', { class: 'btn sm danger', onclick: async () => { if (await chequeAction(p, 'bounced')) load(); } }, 'رجع')] : null))))))));
  };
  main.replaceChildren(
    h('div', { class: 'top' }, h('h1', {}, 'المدفوعات'),
      h('div', { class: 'row' },
        h('label', { class: 'row small' }, h('input', { type: 'checkbox', onchange: (e) => { onlyCheques = e.target.checked; load(); } }), 'الشيكات تحت التحصيل بس'),
        h('button', { class: 'btn primary', onclick: async () => { if (await addPaymentModal(null)) load(); } }, '+ دفعة'))),
    box);
  await load();
}

// ---------- follow-up ----------
export async function renderFollowup(main) {
  const f = await get('/api/followup');
  const section = (title, items, render, empty) => h('div', { class: 'card', style: 'margin-bottom:12px' },
    h('h2', {}, title, ' ', h('span', { class: 'muted small' }, `(${items.length})`)),
    items.length ? h('div', { class: 'table-wrap', style: 'border:0' }, h('table', {}, h('tbody', {}, items.map(render)))) : h('div', { class: 'muted small' }, empty));
  const cl = (id, name) => h('a', { href: `#/clients/${id}` }, name);
  main.replaceChildren(
    h('div', { class: 'top' }, h('h1', {}, 'المتابعة'), h('span', { class: 'muted small' }, `متأخر = عدى ${f.alert_days} يوم من التسليم ومتدفعش (تتغير من الإعدادات)`)),
    section('🔴 فلوس متأخرة', f.overdue, (o) => h('tr', {}, h('td', {}, cl(o.client_id, o.client_name)), h('td', {}, o.text),
      h('td', { class: 'num' }, money(o.open)), h('td', {}, o.days !== null ? `${o.days} يوم من التسليم` : o.due ? `استحقاق ${fmtDate(o.due)}` : '')), 'مفيش متأخرات.'),
    section('🟡 مستحق قريب', f.due_soon, (o) => h('tr', {}, h('td', {}, cl(o.client_id, o.client_name)), h('td', {}, o.text),
      h('td', { class: 'num' }, money(o.open)), h('td', {}, `استحقاق ${fmtDate(o.due)}`)), 'مفيش.'),
    section('📄 شيكات للصرف', f.cheques, (p) => h('tr', {}, h('td', {}, cl(p.client_id, p.client_name)), h('td', { class: 'num' }, money(p.amount)),
      h('td', {}, `استحقاق ${fmtDate(p.cheque_due)}`), h('td', {}, p.reference || '')), 'مفيش شيكات مستحقة الأسبوع ده.'),
    section('🤝 وعود بالدفع', f.promises, (p) => h('tr', {}, h('td', {}, cl(p.client_id, p.client_name)), h('td', {}, fmtDate(p.promised_date)),
      h('td', { class: 'num' }, p.amount ? money(p.amount) : ''), h('td', {}, p.notes)), 'مفيش وعود النهارده أو بكرة.'),
    section('📦 اتسلم ولسه ما اتسعرش', f.delivered_unpriced, (l) => h('tr', {}, h('td', {}, cl(l.client_id, l.client_name)), h('td', {}, l.text),
      h('td', {}, `اتسلم ${fmtDate(l.delivered)}`), h('td', {}, h('a', { href: `#/pricing/${l.client_id}` }, 'سعّر'))), 'كل الشغل المتسلم متسعر.'),
    section('🏭 خلص ولسه ما اتسلمش', f.undelivered, (u) => h('tr', {}, h('td', {}, cl(u.client_id, u.client_name)), h('td', {}, `${u.lines} سطر`),
      h('td', {}, `من ${fmtDate(u.oldest)}`), h('td', {}, h('a', { href: `#/deliveries?client=${u.client_id}` }, 'سلّم'))), 'مفيش.'),
  );
}

// ---------- settings ----------
export async function renderSettings(main) {
  const { settings: s } = await get('/api/settings');
  main.replaceChildren(h('div', { class: 'top' }, h('h1', {}, 'الإعدادات')));
  const ok = h('span', { class: 'small muted' });
  const f = (name, label, value, type = 'text') => h('div', { class: 'field' }, h('label', {}, label),
    type === 'textarea' ? h('textarea', { name, rows: 6 }, value) : h('input', { name, type, value }));
  const form = h('form', { class: 'card grid', style: 'align-content:start', onsubmit: async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(form));
    try { await put('/api/settings', v); ok.textContent = 'اتحفظ ✓'; toast('اتحفظ'); } catch (ex) { toast(ex.message, true); }
  } },
  h('h2', {}, 'بيانات الشركة (تظهر في كشف الحساب والإيصالات)'),
  f('company_name', 'اسم الشركة', s.company_name), f('company_phone', 'التليفون', s.company_phone), f('company_address', 'العنوان', s.company_address),
  h('h2', {}, 'المتابعة والمدفوعات'),
  f('alert_days', 'نبهني لو عدى كام يوم من التسليم ومتدفعش', s.alert_days),
  f('payment_methods', 'طرق الدفع (كل طريقة في سطر — "شيك" بيتعامل كشيك)', s.payment_methods.join('\n'), 'textarea'),
  h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'حفظ'), ok));
  const side = h('div', { class: 'grid', style: 'align-content:start' });
  main.append(h('div', { class: 'settings-grid' }, form, side));
  for (const make of [updateCard, backupsCard, autostartCard, machinesCard]) {
    try { const card = await make(); if (card) side.append(card); } catch (ex) { side.append(h('div', { class: 'card muted' }, ex.message)); }
  }
  try { main.append(h('div', { style: 'margin-top:14px' }, await auditCard())); } catch { /* not critical */ }
}
