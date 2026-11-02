// الخزينة والبنك: balances + movements by day, إيصال استلام نقدية (new / view / print), تحويل,
// جرد الخزينة.
import { h, fill, icon, button, pageHead, backLink, emptyState, skeleton, notice, toast, confirmModal, formModal,
  dataTable, money, fmtDate, fmtDateTime, todayISO, loadInto, tabs, field, pill } from '../ui.js';
import { get, post } from '../api.js';
import { amountWords } from './treasury-words.js';
import {
  useStyles, seg, partyPicker, dateField, amountField, textField, areaField, selectField, showError, balanceHint, kv,
  moneyText, chequePill, docPill, duePill, setPrintSize, monthStart, trForm,
} from './treasury-common.js';

const KIND_LABEL = { client: 'عميل', partner: 'شريك', supplier: 'مورد', worker: 'عامل' };
const DOC_HREF = {
  receipt: (id) => `#/treasury/receipts/${id}`, voucher: (id) => `#/expenses/${id}`, cheque: (id) => `#/cheques/${id}`,
  transfer: (id) => `#/treasury/transfers/${id}`, cash_count: () => '#/treasury/count',
};
export const docHref = (type, id) => DOC_HREF[type]?.(id) || null;

// ---------- الخزينة والبنك ----------
export async function treasuryHome(main, _p, ctx) {
  useStyles();
  const account = ctx.query.account === 'bank' ? 'bank' : 'cash';
  const statsBox = h('div', {}, skeleton());
  const movBox = h('div', {}, skeleton('table'));
  const fromIn = h('input', { type: 'date', value: ctx.query.from || monthStart() });
  const toIn = h('input', { type: 'date', value: ctx.query.to || '' });
  const qIn = h('input', { type: 'search', placeholder: 'دوّر في البيان أو الرقم أو الاسم…', value: ctx.query.q || '' });

  fill(main,
    pageHead('الخزينة والبنك', 'الرصيد والحركة يوم بيوم، وكل حركة بمستندها.',
      button('إيصال استلام', { kind: 'primary', icon: 'receipt', href: '#/treasury/receipt' }),
      button('إذن صرف', { icon: 'hand-coins', href: '#/expenses/new' }),
      button('تحويل', { icon: 'arrows-left-right', href: '#/treasury/transfer' }),
      button('جرد', { icon: 'calculator', href: '#/treasury/count' })),
    statsBox,
    tabs([{ key: 'cash', label: 'حركة الخزينة', icon: 'vault', href: '#/treasury?account=cash' },
      { key: 'bank', label: 'حركة البنك', icon: 'bank', href: '#/treasury?account=bank' }], account),
    h('div', { class: 'tr-filters' }, field('من', fromIn), field('لحد', toIn), field('بحث', qIn),
      h('div', { class: 'row' }, button('الشهر ده', { size: 'sm', kind: 'ghost', onClick: () => { fromIn.value = monthStart(); toIn.value = ''; loadMov(); } }),
        button('من الأول', { size: 'sm', kind: 'ghost', onClick: () => { fromIn.value = ''; toIn.value = ''; loadMov(); } }))),
    movBox);

  const loadStats = () => loadInto(statsBox, async () => {
    const s = await get('/api/treasury/summary');
    const alerts = s.alerts.slice(0, 6);
    return [
      h('div', { class: 'stats', style: 'margin-bottom:14px' },
        h('a', { class: 'stat', href: '#/treasury?account=cash' }, h('span', {}, 'الخزينة'), h('b', { class: 'money' }, money(s.cash))),
        h('a', { class: 'stat', href: '#/treasury?account=bank' }, h('span', {}, 'البنك'), h('b', { class: 'money' }, money(s.bank))),
        h('a', { class: 'stat', href: '#/cheques/in' }, h('span', {}, `أوراق القبض في إيدنا (${s.cheques_in_count})`), h('b', { class: 'money' }, money(s.cheques_in_amount))),
        h('a', { class: 'stat', href: '#/cheques/out' }, h('span', {}, `أوراق الدفع لسه متصرفتش (${s.cheques_out_count})`), h('b', { class: 'money' }, money(s.cheques_out_amount)))),
      alerts.length || s.drafts_count ? h('div', { class: 'tr-alerts' },
        alerts.map((c) => notice(c.alert === 'overdue' ? 'danger' : 'warn',
          h('a', { href: `#/cheques/${c.id}` }, `${c.direction === 'in' ? 'شيك من' : 'شيك لـ'} ${c.party_name || c.payee_text || '—'} رقم ${c.number}`),
          ` — ${money(c.amount)} — يستحق ${fmtDate(c.due_date)} `, duePill(c))),
        s.drafts_count ? notice('info', h('a', { href: '#/expenses/recurring' }, `${s.drafts_count} مصروف متكرر مستني تأكيدك`)) : null) : null,
      s.last_count ? h('p', { class: 'small muted', style: 'margin:-4px 0 14px' }, `آخر جرد للخزينة ${fmtDate(s.last_count.date)}${s.last_count.difference ? ` — فرق ${money(s.last_count.difference)}` : ' — مظبوط'}`) : null,
    ];
  });

  const loadMov = () => loadInto(movBox, async () => {
    const m = await get('/api/treasury/movements', { account, from: fromIn.value, to: toIn.value, q: qIn.value.trim() });
    const name = account === 'cash' ? 'الخزينة' : 'البنك';
    if (!m.days.length) {
      return emptyState(account === 'cash' ? 'vault' : 'bank', qIn.value ? 'مفيش حركة بالبحث ده' : `مفيش حركة في ${name} في الفترة دي`,
        qIn.value ? 'جرب كلمة تانية أو شيل البحث.' : 'أي إيصال استلام أو إذن صرف أو تحويل هيظهر هنا بيومه.',
        h('div', { class: 'row' }, button('إيصال استلام', { kind: 'primary', icon: 'receipt', href: '#/treasury/receipt' }),
          ctx.can('money.post') ? button(`رصيد أول المدة لـ${name}`, { icon: 'plus', onClick: () => openingForm(account, () => { loadStats(); loadMov(); }) }) : null));
    }
    const cols = [
      { label: 'المستند', value: (r) => h('span', { class: 'num' }, r.ref || r.serial) },
      { label: 'البيان', value: (r) => h('div', {}, r.description, r.party_name ? h('div', { class: 'small muted' }, r.party_name) : null) },
      { label: 'وارد', n: true, value: (r) => (r.in_amount ? h('span', { class: 'money tr-in' }, money(r.in_amount)) : '') },
      { label: 'منصرف', n: true, value: (r) => (r.out_amount ? h('span', { class: 'money tr-out' }, money(r.out_amount)) : '') },
      { label: 'الرصيد', n: true, value: (r) => moneyText(r.running_balance) },
    ];
    return [
      h('p', { class: 'small muted' }, m.from ? `رصيد ${name} قبل ${fmtDate(m.from)}: ` : `رصيد ${name} في الآخر: `,
        moneyText(m.from ? m.opening_balance : m.closing_balance),
        ` — وارد الفترة ${money(m.totals.in_amount)} ومنصرفها ${money(m.totals.out_amount)}`),
      m.days.map((d) => h('div', { class: 'tr-day' },
        h('div', { class: 'tr-day-head' }, h('b', {}, fmtDate(d.date)),
          h('span', {}, 'وارد ', h('span', { class: 'money tr-in' }, money(d.in_amount))),
          h('span', {}, 'منصرف ', h('span', { class: 'money tr-out' }, money(d.out_amount))),
          h('span', {}, 'رصيد آخر اليوم ', moneyText(d.closing_balance))),
        dataTable(cols, d.rows, {
          onRow: (r) => { const href = docHref(r.doc_type, r.doc_id); if (href) ctx.go(href); },
          rowClass: (r) => (r.status === 'reversed' || r.reversal_of ? 'struck' : ''),
        }))),
    ];
  });

  for (const el of [fromIn, toIn]) el.addEventListener('change', loadMov);
  let t;
  qIn.addEventListener('input', () => { clearTimeout(t); t = setTimeout(loadMov, 300); });
  await Promise.all([loadStats(), loadMov()]);
}

function openingForm(account, done) {
  return formModal({
    title: `رصيد أول المدة — ${account === 'cash' ? 'الخزينة' : 'البنك'}`,
    intro: 'الرصيد اللي كان موجود قبل ما تبدأ تسجل على البرنامج. بيتسجل مرة واحدة.',
    fields: [{ name: 'amount', label: 'الرصيد', type: 'money', help: account === 'bank' ? 'لو البنك مسحوب على المكشوف اكتبه بالسالب' : null },
      { name: 'date', label: 'التاريخ', type: 'date', value: todayISO() }],
    submitLabel: 'سجّل الرصيد',
    onSubmit: async (v) => { await post('/api/treasury/opening', { account, ...v }); toast('اتسجل رصيد أول المدة'); done?.(); },
  });
}

// ---------- إيصال استلام نقدية ----------
export async function receiptNew(main, _p, ctx) {
  useStyles();
  const q = ctx.query;
  let kind = KIND_LABEL[q.kind] ? q.kind : 'client';
  const hint = h('div', { class: 'tr-hint' });
  const party = partyPicker({ label: 'استلمنا من', kind, value: q.party || null, onPick: (p) => balanceHint(hint, p, ctx) });
  party.append(hint);
  const kindSeg = seg(Object.entries(KIND_LABEL), kind, async (k) => { kind = k; fill(hint, ''); await party.setKind(k); }, { label: 'نوع الطرف' });
  const date = dateField('التاريخ');
  const amount = amountField('المبلغ', { value: q.amount || '' });
  let method = 'cash';
  const methodSeg = seg([['cash', 'نقدي', 'money'], ['transfer', 'تحويل بنكي', 'bank'], ['instapay', 'إنستاباي'], ['wallet', 'محفظة'], ['cheque', 'شيك', 'signature']],
    method, (m) => { method = m; sync(); }, { label: 'طريقة الدفع' });
  const walletAcc = selectField('الفلوس دخلت', [['bank', 'البنك'], ['cash', 'الخزينة']], 'bank');
  const chNum = textField('رقم الشيك');
  const chBank = textField('البنك');
  const chDue = dateField('تاريخ الاستحقاق', '');
  const chequeBox = h('div', { class: 'form-grid' }, chNum, chBank, chDue,
    h('div', { class: 'wide' }, notice('info', 'الشيك بيتحفظ في أوراق القبض «في الحافظة» ومش بينزل من رصيد العميل غير لما يتحصّل. لحد كده بيظهر في كشفه «تحت التحصيل».')));
  const notes = textField('وذلك عن (اختياري)', '', { help: 'زي: دفعة من الحساب، حساب شغل الشهر' });
  const err = h('div', { class: 'err', role: 'alert' });
  const fields = { party_id: party, date, amount, method: methodSeg, cheque_number: chNum, cheque_due_date: chDue, notes };
  const sync = () => { walletAcc.hidden = method !== 'wallet'; chequeBox.hidden = method !== 'cheque'; };
  sync();

  const save = async () => {
    fill(err, '');
    const pid = party.require('اختار اللي دفع');
    if (!pid) return;
    const body = {
      party_id: pid, date: date.input.value, amount: amount.input.value, method, notes: notes.input.value,
      account: method === 'wallet' ? walletAcc.input.value : undefined,
      cheque: method === 'cheque' ? { number: chNum.input.value, bank: chBank.input.value, due_date: chDue.input.value } : undefined,
    };
    try {
      const { receipt } = await post('/api/treasury/receipts', body);
      toast(`اتسجل الإيصال ${receipt.serial}`, false, { action: { label: 'اطبع', onClick: () => ctx.go(`#/print/receipt/${receipt.id}`) } });
      ctx.go(`#/treasury/receipts/${receipt.id}`);
    } catch (ex) { showError(ex, fields, err); }
  };

  const recent = h('div', {}, skeleton('table'));
  fill(main,
    backLink('#/treasury', 'الخزينة والبنك'),
    pageHead('إيصال استلام نقدية', 'فلوس جاية من عميل أو شريك أو مورد أو عامل: نقدي، تحويل، إنستاباي، محفظة، أو شيك.'),
    trForm(save,
      h('div', { class: 'card' },
        h('div', { class: 'form-grid' },
          h('div', { class: 'wide' }, kindSeg), party, date, amount,
          h('div', { class: 'wide field' }, h('label', {}, 'طريقة الدفع'), methodSeg), walletAcc,
          h('div', { class: 'wide' }, chequeBox), h('div', { class: 'wide' }, notes)),
        err,
        h('div', { class: 'tr-actions' }, button('سجّل الإيصال', { kind: 'primary', size: 'big', icon: 'check', type: 'submit' }),
          button('رجوع', { href: '#/treasury' })))),
    h('h2', { style: 'margin-top:22px' }, 'آخر الإيصالات'),
    recent);
  loadInto(recent, async () => {
    const { receipts } = await get('/api/treasury/receipts');
    if (!receipts.length) return emptyState('receipt', 'لسه مفيش إيصالات', 'أول إيصال هتسجله هيظهر هنا.', null, true);
    return dataTable([
      { label: 'رقم', value: (r) => h('span', { class: 'num' }, r.serial) },
      { label: 'التاريخ', value: (r) => h('span', { class: 'num' }, fmtDate(r.date)) },
      { label: 'من', value: (r) => r.party_name },
      { label: 'الطريقة', value: (r) => [r.method_name, r.cheque_status_name ? [' ', pill('neutral', r.cheque_status_name)] : null] },
      { label: 'المبلغ', n: true, value: (r) => moneyText(r.amount) },
      { label: '', value: (r) => docPill(r.status) },
    ], receipts.slice(0, 15), { onRow: (r) => ctx.go(`#/treasury/receipts/${r.id}`), rowClass: (r) => (r.status === 'cancelled' ? 'struck' : '') });
  });
  await party.ready;
}

export async function receiptView(main, p, ctx) {
  useStyles();
  const { receipt: r } = await get(`/api/treasury/receipts/${p.id}`);
  const cancel = async () => {
    const reason = await confirmModal(`إلغاء الإيصال ${r.serial}`, 'الإيصال مش هيتمسح: هيتعمل قيد عكسي بنفس المبلغ والإيصال يفضل ظاهر «ملغي».', 'ألغِ الإيصال', { danger: true, withReason: true, reasonLabel: 'سبب الإلغاء' });
    if (!reason) return;
    try { await post(`/api/treasury/receipts/${r.id}/cancel`, { reason }); toast('اتلغى الإيصال'); ctx.refresh(); } catch (ex) { toast(ex.message, true); }
  };
  fill(main,
    backLink('#/treasury/receipt', 'الإيصالات'),
    pageHead(`إيصال استلام ${r.serial}`, h('span', { class: 'row' }, fmtDate(r.date), docPill(r.status)),
      button('اطبع', { icon: 'printer', href: `#/print/receipt/${r.id}` }),
      r.status !== 'cancelled' && ctx.can('treasury') ? button('ألغِ الإيصال', { kind: 'danger', icon: 'prohibit', onClick: cancel }) : null),
    r.status === 'cancelled' ? notice('danger', `الإيصال ده ملغي. السبب: ${r.cancel_reason}`) : null,
    h('div', { class: 'card', style: 'margin-top:12px' }, kv([
      ['استلمنا من', h('a', { href: r.party_kind === 'client' ? `#/clients/${r.party_id}` : `#/parties/${r.party_id}` }, `${r.party_name} (${r.party_kind_name})`)],
      ['المبلغ', 'amount' in r ? h('b', { class: 'money' }, money(r.amount)) : null],
      ['بالحروف', 'amount' in r ? amountWords(r.amount) : null],
      ['طريقة الدفع', r.method_name + (r.account_name ? ` — دخلت ${r.account_name}` : '')],
      ['الشيك', r.cheque ? h('a', { href: `#/cheques/${r.cheque.id}` }, `رقم ${r.cheque.number}${r.cheque.bank ? ` — ${r.cheque.bank}` : ''} — يستحق ${fmtDate(r.cheque.due_date)} `, chequePill(r.cheque)) : null],
      ['وذلك عن', r.notes],
      ['رقم القيد', r.txn_serial ? h('span', { class: 'num' }, r.txn_serial) : (r.cheque ? 'لسه — بيتقيد لما الشيك يتحصّل' : null)],
      ['سجّله', `${r.created_by_name || '—'} — ${fmtDateTime(r.created_at)}`],
    ])));
}

// The printed receipt (A4 or half a page), شركة الصفا header, amount in words.
export async function printReceipt(main, p) {
  useStyles();
  const { receipt: r } = await get(`/api/treasury/receipts/${p.id}`);
  const paper = h('div', { class: 'tr-paper' },
    r.status === 'cancelled' ? h('div', { class: 'void' }, 'ملغي') : null,
    h('div', { class: 'ph' },
      h('div', { class: 'co' }, h('b', {}, 'شركة الصفا')),
      h('div', { class: 'doc' }, h('b', {}, 'إيصال استلام نقدية'), h('div', { class: 'num' }, `رقم ${r.serial}`), h('div', { class: 'num' }, `التاريخ ${fmtDate(r.date)}`))),
    line('استلمنا من السيد / السادة', r.party_name),
    h('div', { class: 'line' }, h('span', { class: 'k' }, 'مبلغ وقدره'), h('span', { class: 'big' }, money(r.amount)), h('span', {}, 'جنيه مصري')),
    line('فقط', amountWords(r.amount).replace(/^فقط /, '')),
    line('وذلك', r.method === 'cheque' && r.cheque
      ? `بشيك رقم ${r.cheque.number}${r.cheque.bank ? ` على ${r.cheque.bank}` : ''} يستحق ${fmtDate(r.cheque.due_date)}` : r.method_name),
    line('عن', r.notes || 'دفعة من الحساب'),
    h('div', { class: 'sign' }, h('div', {}, 'المستلم'), h('div', {}, 'المحاسب'), h('div', {}, 'الختم')));
  printFrame(main, `#/treasury/receipts/${r.id}`, paper);
}

const line = (k, v) => h('div', { class: 'line' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v || ''));

export function printFrame(main, back, paper) {
  let size = 'a4';
  setPrintSize(size);
  const sizeSeg = seg([['a4', 'صفحة A4'], ['half', 'نص صفحة']], size, (s) => { size = s; setPrintSize(s); paper.classList.toggle('half', s === 'half'); }, { label: 'المقاس' });
  fill(main,
    h('div', { class: 'tr-toolbar no-print tr-noprint' }, backLink(back, 'رجوع'), h('span', { class: 'spacer' }), sizeSeg,
      button('اطبع', { kind: 'primary', icon: 'printer', onClick: () => window.print() })),
    paper);
}

// ---------- تحويل ----------
export async function transferNew(main, _p, ctx) {
  useStyles();
  let from = ctx.query.from === 'bank' ? 'bank' : 'cash';
  const dir = seg([['cash', 'من الخزينة للبنك', 'arrow-up-right'], ['bank', 'من البنك للخزينة', 'arrow-down-left']], from, (v) => { from = v; }, { label: 'اتجاه التحويل' });
  const date = dateField('التاريخ');
  const amount = amountField('المبلغ');
  const notes = textField('ملاحظات (اختياري)', '', { help: 'زي: إيداع إيراد الأسبوع' });
  const err = h('div', { class: 'err', role: 'alert' });
  const list = h('div', {}, skeleton('table'));
  const fields = { date, amount, notes };
  const save = async () => {
    fill(err, '');
    try {
      const { transfer } = await post('/api/treasury/transfers', { date: date.input.value, from_account: from, amount: amount.input.value, notes: notes.input.value });
      toast(`اتسجل التحويل ${transfer.serial}`);
      amount.input.value = '';
      notes.input.value = '';
      loadList();
    } catch (ex) { showError(ex, fields, err); }
  };
  const loadList = () => loadInto(list, async () => {
    const { transfers } = await get('/api/treasury/transfers');
    if (!transfers.length) return emptyState('arrows-left-right', 'لسه مفيش تحويلات', 'لما تودّع فلوس الخزينة في البنك أو تسحب منه سجلها هنا.', null, true);
    return dataTable([
      { label: 'رقم', value: (t) => h('span', { class: 'num' }, t.serial) },
      { label: 'التاريخ', value: (t) => h('span', { class: 'num' }, fmtDate(t.date)) },
      { label: 'الاتجاه', value: (t) => (t.from_account === 'cash' ? 'من الخزينة للبنك' : 'من البنك للخزينة') },
      { label: 'المبلغ', n: true, value: (t) => moneyText(t.amount) },
      { label: 'ملاحظات', value: (t) => [t.notes, t.status === 'cancelled' ? [' ', docPill(t.status)] : null] },
    ], transfers, { onRow: (t) => ctx.go(`#/treasury/transfers/${t.id}`), rowClass: (t) => (t.status === 'cancelled' ? 'struck' : '') });
  });
  fill(main,
    backLink('#/treasury', 'الخزينة والبنك'),
    pageHead('تحويل', 'من الخزينة للبنك أو العكس. الرصيدين بيتعدلوا مع بعض.'),
    trForm(save,
      h('div', { class: 'card' },
        h('div', { class: 'form-grid' }, h('div', { class: 'wide' }, dir), date, amount, h('div', { class: 'wide' }, notes)),
        err, h('div', { class: 'tr-actions' }, button('سجّل التحويل', { kind: 'primary', size: 'big', icon: 'check', type: 'submit' })))),
    h('h2', { style: 'margin-top:22px' }, 'التحويلات'), list);
  await loadList();
}

export async function transferView(main, p, ctx) {
  useStyles();
  const { transfer: t } = await get(`/api/treasury/transfers/${p.id}`);
  const cancel = async () => {
    const reason = await confirmModal(`إلغاء التحويل ${t.serial}`, 'هيتعمل قيد عكسي يرجّع الرصيدين زي ما كانوا.', 'ألغِ التحويل', { danger: true, withReason: true });
    if (!reason) return;
    try { await post(`/api/treasury/transfers/${t.id}/cancel`, { reason }); toast('اتلغى التحويل'); ctx.refresh(); } catch (ex) { toast(ex.message, true); }
  };
  fill(main,
    backLink('#/treasury/transfer', 'التحويلات'),
    pageHead(`تحويل ${t.serial}`, h('span', { class: 'row' }, fmtDate(t.date), docPill(t.status)),
      t.status !== 'cancelled' ? button('ألغِ التحويل', { kind: 'danger', icon: 'prohibit', onClick: cancel }) : null),
    t.status === 'cancelled' ? notice('danger', `التحويل ده ملغي. السبب: ${t.cancel_reason}`) : null,
    h('div', { class: 'card', style: 'margin-top:12px' }, kv([
      ['الاتجاه', t.from_account === 'cash' ? 'من الخزينة للبنك' : 'من البنك للخزينة'],
      ['المبلغ', 'amount' in t ? h('b', { class: 'money' }, money(t.amount)) : null],
      ['ملاحظات', t.notes], ['رقم القيد', t.txn_serial], ['سجّله', `${t.created_by_name || '—'} — ${fmtDateTime(t.created_at)}`],
    ])));
}

// ---------- جرد الخزينة ----------
export async function cashCount(main, _p, ctx) {
  useStyles();
  let account = 'cash';
  let expected = null;
  const accSeg = seg([['cash', 'الخزينة', 'vault'], ['bank', 'البنك', 'bank']], account, (a) => { account = a; loadExpected(); }, { label: 'الحساب' });
  const date = dateField('تاريخ الجرد');
  const expBox = h('div', { class: 'tr-calc' }, '…');
  const counted = amountField('المبلغ اللي اتعد فعلاً', { words: false });
  const diffBox = h('div', { class: 'tr-calc' }, '—');
  const notes = areaField('سبب الفرق', '', { help: 'لازم تكتبه لو فيه فرق. الفرق بيتقيد في «فروق جرد الخزينة».' });
  const err = h('div', { class: 'err', role: 'alert' });
  const fields = { date, counted, notes };
  const history = h('div', {}, skeleton('table'));

  const drawDiff = () => {
    const c = counted.millimes();
    if (expected === null || c === null || Number.isNaN(c)) { diffBox.className = 'tr-calc'; fill(diffBox, '—'); return; }
    const d = c - expected;
    diffBox.className = `tr-calc ${d === 0 ? 'good' : d < 0 ? 'bad' : 'warn'}`;
    fill(diffBox, d === 0 ? 'مظبوط' : `${d < 0 ? 'عجز' : 'زيادة'} ${money(Math.abs(d))}`);
  };
  const loadExpected = async () => {
    fill(expBox, '…');
    try {
      const r = await get('/api/treasury/counts/expected', { account, date: date.input.value });
      expected = r.expected;
      fill(expBox, money(expected));
    } catch (ex) { expected = null; fill(expBox, ''); date.setError(ex.message); }
    drawDiff();
  };
  counted.input.addEventListener('input', drawDiff);
  date.input.addEventListener('change', loadExpected);

  const save = async () => {
    fill(err, '');
    try {
      const { count } = await post('/api/treasury/counts', { account, date: date.input.value, counted: counted.input.value, notes: notes.input.value });
      toast(count.difference ? `اتسجل الجرد ${count.serial} والفرق اتقيد` : `اتسجل الجرد ${count.serial} — مظبوط`);
      counted.input.value = '';
      notes.input.value = '';
      loadExpected();
      loadHistory();
    } catch (ex) { showError(ex, fields, err); }
  };
  const loadHistory = () => loadInto(history, async () => {
    const { counts } = await get('/api/treasury/counts');
    if (!counts.length) return emptyState('calculator', 'لسه مفيش جرد', 'اعمل أول جرد: عِد الفلوس اللي في الخزينة واكتبها فوق.', null, true);
    return dataTable([
      { label: 'رقم', value: (c) => h('span', { class: 'num' }, c.serial) },
      { label: 'التاريخ', value: (c) => h('span', { class: 'num' }, fmtDate(c.date)) },
      { label: 'الحساب', value: (c) => (c.account === 'cash' ? 'الخزينة' : 'البنك') },
      { label: 'المتوقع', n: true, value: (c) => moneyText(c.expected) },
      { label: 'الفعلي', n: true, value: (c) => moneyText(c.counted) },
      { label: 'الفرق', n: true, value: (c) => (c.difference ? h('span', { class: `money ${c.difference < 0 ? 'tr-out' : 'tr-in'}` }, money(c.difference)) : pill('ok', 'مظبوط')) },
      { label: 'السبب', value: (c) => c.notes },
    ], counts);
  });

  fill(main,
    backLink('#/treasury', 'الخزينة والبنك'),
    pageHead('جرد الخزينة', 'عِد الفلوس، وقارنها برصيد البرنامج. الفرق بيتسجل بسببه.'),
    trForm(save,
      h('div', { class: 'card' },
        h('div', { class: 'form-grid' }, h('div', { class: 'wide' }, accSeg), date,
          field('رصيد البرنامج في التاريخ ده', expBox, { help: 'محسوب من كل الحركات لحد آخر اليوم' }),
          counted, field('الفرق', diffBox), h('div', { class: 'wide' }, notes)),
        err, h('div', { class: 'tr-actions' }, button('سجّل الجرد', { kind: 'primary', size: 'big', icon: 'check', type: 'submit' })))),
    h('h2', { style: 'margin-top:22px' }, 'الجرد اللي فات'), history);
  await Promise.all([loadExpected(), loadHistory()]);
}
