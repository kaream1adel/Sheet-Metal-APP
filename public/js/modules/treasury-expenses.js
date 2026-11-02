// المصروفات: إذن صرف جديد (expense with cost centers and «يتحمّل على العميل», salary, material
// purchase, supplier payment, partner withdrawal, worker advance), the voucher page and its print,
// the expenses list with filters and totals, and المصروفات المتكررة.
// The workshop manager (no treasury permission) records plain expenses only and never gets an
// amount back from the server; his own print uses what he just typed.
import { h, fill, icon, button, pageHead, backLink, emptyState, skeleton, notice, toast, confirmModal, formModal,
  dataTable, money, fmtDate, fmtDateTime, todayISO, loadInto, field, pill, selectInput, parseNum } from '../ui.js';
import { get, post, patch } from '../api.js';
import { createGrid } from '../grid.js';
import { amountWords } from './treasury-words.js';
import {
  useStyles, seg, partyPicker, partiesOf, dateField, amountField, textField, selectField, showError, revealError, balanceHint, kv,
  moneyText, chequePill, docPill, shrinkPhoto, monthStart, prevMonthRange, trForm,
} from './treasury-common.js';
import { printFrame } from './treasury-cash.js';

const MODES = [
  ['expense', 'مصروف', 'wallet'], ['salary', 'مرتب', 'hard-hat'], ['material_purchase', 'شراء خامات', 'cube'],
  ['supplier_payment', 'دفعة لمورد', 'truck'], ['partner_withdrawal', 'سحب شريك', 'handshake'], ['worker_advance', 'سلفة عامل', 'coins'],
];
const PARTY_OF = { material_purchase: ['supplier', 'المورد'], supplier_payment: ['supplier', 'المورد'], partner_withdrawal: ['partner', 'الشريك'], worker_advance: ['worker', 'العامل'] };
const SALARY_CATEGORY = 1;

// What the workshop manager just saved, so his print shows the amount he typed (the server
// never sends him one).
let lastSaved = null;

export async function voucherNew(main, _p, ctx) {
  useStyles();
  const opts = await get('/api/treasury/options');
  // Label maps arrive as [key, label] pairs (see the /options route).
  for (const k of ['methods', 'paid_from', 'kinds', 'cheque_status']) opts[k] = Object.fromEntries(opts[k] || []);
  const limited = opts.limited;
  const cats = (ctx.state.lookups?.expense_categories || []).map((c) => [c.id, c.name]);
  let mode = !limited && MODES.some(([m]) => m === ctx.query.kind) ? ctx.query.kind : 'expense';
  const body = h('div');
  const done = h('div');
  const modeSeg = limited ? null : seg(MODES, mode, (m) => { mode = m; render(); }, { label: 'نوع إذن الصرف' });

  const render = () => {
    fill(done, '');
    const apiKind = mode === 'salary' ? 'expense' : mode;
    const date = dateField('التاريخ');
    const desc = textField('البيان', '', { help: mode === 'expense' ? 'زي: فاتورة كهرباء أكتوبر، صيانة المقص' : null });
    const err = h('div', { class: 'err', role: 'alert' });
    const fields = { date, description: desc };
    const parts = [];
    let collect = () => ({});

    // ---------- what was paid ----------
    if (mode === 'expense') {
      const cat = selectField('بند المصروف', [['', 'اختار البند…'], ...cats], ctx.query.category || '');
      fields.category_id = cat;
      let center = 'general';
      const centerSeg = seg([['general', 'عام', 'factory'], ['client', 'على عميل', 'users-three'], ['split', 'موزّع على أكتر من عميل', 'table']], center,
        (c) => { center = c; drawCenter(); }, { label: 'مركز التكلفة' });
      const centerBox = h('div', { class: 'form-grid' });
      const amount = amountField('المبلغ');
      const client = partyPicker({ label: 'العميل', kind: 'client' });
      const recharge = h('input', { type: 'checkbox' });
      const rechargeRow = limited ? null : h('label', { class: 'check-row wide' }, recharge,
        h('span', {}, 'يتحمّل على العميل', h('span', { class: 'small muted' }, ' — المبلغ ينزل على كشف حسابه كمان (من غير كده بيتحسب تكلفة علينا بس)')));
      let grid = null;
      fields.amount = amount;
      fields.cost_party_id = client;
      fields.recharge = { setError: (m) => toast(m, true) };
      const drawCenter = async () => {
        if (center === 'split') {
          const clients = await partiesOf('client');
          const options = [[0, 'عام (مش على عميل)'], ...clients.map((c) => [c.id, c.name])];
          grid = createGrid({
            columns: [
              { key: 'cost_party_id', label: 'العميل', type: 'select', options, width: 220 },
              { key: 'amount', label: 'المبلغ', type: 'number', width: 120, total: 'sum', totalFormat: (v) => money(Math.round((v || 0) * 1000)) },
              ...(limited ? [] : [{ key: 'recharge', label: 'يتحمّل على العميل', type: 'check' }]),
            ],
            rows: [{}, {}], newRow: () => ({}), totals: 'bottom', maxHeight: 'none', emptyText: 'ضيف سطر لكل عميل',
            rowTitle: (_r, i) => `سطر ${i + 1}`,
          });
          fill(centerBox, h('div', { class: 'wide' }, grid.el), h('div', { class: 'wide tr-hint' }, 'سطر لكل عميل بمبلغه. سيب العميل فاضي للجزء العام. Enter ينزل لتحت ويزوّد سطر.'));
        } else {
          grid = null;
          fill(centerBox, center === 'client' ? client : null, amount, center === 'client' ? rechargeRow : null);
        }
      };
      drawCenter();
      parts.push(h('div', { class: 'form-grid' }, cat, date, h('div', { class: 'wide field' }, h('label', {}, 'مركز التكلفة'), centerSeg), h('div', { class: 'wide' }, centerBox), h('div', { class: 'wide' }, desc)));
      collect = () => {
        const category = cat.input.value;
        if (!category) { cat.setError('اختار بند المصروف'); throw new Error(''); }
        if (center === 'split') {
          const rows = grid.getRows().filter((r) => r.amount !== null && r.amount !== undefined && r.amount !== '');
          if (!rows.length) throw new Error('اكتب مبلغ سطر واحد على الأقل');
          return { lines: rows.map((r) => ({ category_id: category, amount: String(r.amount), cost_party_id: r.cost_party_id || null, recharge: !!r.recharge && !!r.cost_party_id })) };
        }
        const line = { category_id: category, amount: amount.input.value };
        if (center === 'client') {
          const id = client.require('اختار العميل');
          if (!id) throw new Error('');
          line.cost_party_id = id;
          line.recharge = recharge.checked;
        }
        return { lines: [line] };
      };
    } else if (mode === 'salary') {
      const hint = h('div', { class: 'tr-hint' });
      const worker = partyPicker({ label: 'العامل', kind: 'worker', onPick: (p) => balanceHint(hint, p, ctx) });
      worker.append(hint);
      const amount = amountField('المرتب');
      const deduction = amountField('خصم من السلفة (اختياري)', { big: false, words: false, help: 'جزء من سلفته بيترد من المرتب. الخزينة بتدفع الباقي بس.' });
      Object.assign(fields, { worker_id: worker, amount, deduction });
      parts.push(h('div', { class: 'form-grid' }, worker, date, amount, deduction, h('div', { class: 'wide' }, desc)));
      collect = () => {
        const id = worker.require('اختار العامل');
        if (!id) throw new Error('');
        return { lines: [{ category_id: SALARY_CATEGORY, amount: amount.input.value, worker_id: id }], deduction: deduction.input.value };
      };
    } else if (mode === 'material_purchase') {
      const supplier = partyPicker({ label: 'المورد', kind: 'supplier' });
      fields.party_id = supplier;
      const mats = (ctx.state.lookups?.materials || []).map((m) => m.name);
      const grid = createGrid({
        columns: [
          { key: 'material_text', label: 'الخامة', type: 'text', width: 160, suggest: mats },
          { key: 'thickness', label: 'السمك', type: 'number', width: 70 },
          { key: 'qty', label: 'الكمية', type: 'number', width: 80 },
          { key: 'unit', label: 'الوحدة', type: 'text', width: 80, suggest: ['كجم', 'طن', 'لوح', 'متر', 'قطعة'] },
          { key: 'unit_rate', label: 'سعر الوحدة', type: 'number', width: 100 },
          { key: 'line', label: 'المبلغ', type: 'computed', compute: (r) => (r.qty > 0 && r.unit_rate > 0 ? Math.round(r.qty * r.unit_rate * 1000) : null),
            format: (v) => (v ? money(v) : ''), total: (rows) => rows.reduce((s, r) => s + (r.qty > 0 && r.unit_rate > 0 ? Math.round(r.qty * r.unit_rate * 1000) : 0), 0), totalFormat: (v) => money(v) },
        ],
        rows: [{}, {}], newRow: () => ({}), totals: 'bottom', maxHeight: 'none', rowTitle: (_r, i) => `خامة ${i + 1}`,
      });
      parts.push(h('div', { class: 'form-grid' }, supplier, date, h('div', { class: 'wide' }, grid.el),
        h('div', { class: 'wide tr-hint' }, 'سطر لكل خامة على فاتورة المورد. المبلغ = الكمية × سعر الوحدة. ~ يعني زي اللي فوقه.'), h('div', { class: 'wide' }, desc)));
      collect = () => {
        const id = supplier.require('اختار المورد');
        if (!id) throw new Error('');
        const items = grid.getRows().filter((r) => r.material_text || r.qty || r.unit_rate)
          .map((r) => {
            const m = (ctx.state.lookups?.materials || []).find((x) => x.name === r.material_text);
            return { material_id: m?.id || null, material_text: r.material_text || '', thickness: r.thickness ?? '', qty: r.qty ?? '', unit: r.unit || '', unit_rate: r.unit_rate === null || r.unit_rate === undefined ? '' : String(r.unit_rate) };
          });
        if (!items.length) throw new Error('اكتب الخامة والكمية والسعر');
        return { party_id: id, items };
      };
    } else {
      const [kind, label] = PARTY_OF[mode];
      const hint = h('div', { class: 'tr-hint' });
      const who = partyPicker({ label, kind, value: ctx.query.party || null, onPick: (p) => balanceHint(hint, p, ctx) });
      who.append(hint);
      const amount = amountField('المبلغ');
      Object.assign(fields, { party_id: who, amount });
      parts.push(h('div', { class: 'form-grid' }, who, date, amount, h('div', { class: 'wide' }, desc)));
      collect = () => {
        const id = who.require(`اختار ${label}`);
        if (!id) throw new Error('');
        return { party_id: id, amount: amount.input.value };
      };
    }

    // ---------- where it was paid from ----------
    const sources = opts.kind_sources[apiKind] || ['cash'];
    let source = sources[0];
    const srcBox = h('div', { class: 'form-grid' });
    const srcSeg = seg(sources.map((s) => [s, opts.paid_from[s]]), source, (s) => { source = s; drawSource(); }, { label: 'اتصرف من' });
    const partner = partyPicker({ label: 'الشريك اللي دفع', kind: 'partner' });
    const supplierSrc = partyPicker({ label: 'المورد (آجل على حسابه)', kind: 'supplier' });
    const clientSrc = partyPicker({ label: 'العميل (مقاصة من حسابه)', kind: 'client' });
    const chNum = textField('رقم الشيك');
    const chBank = textField('البنك');
    const chDue = dateField('تاريخ الاستحقاق', '');
    const chPayee = textField('المستفيد', '', { help: 'لو مش مورد أو شريك متسجل، زي شركة الكهرباء' });
    Object.assign(fields, { paid_from_party_id: source === 'partner' ? partner : source === 'client_offset' ? clientSrc : supplierSrc, cheque_number: chNum, cheque_due_date: chDue });
    const drawSource = () => {
      fields.paid_from_party_id = source === 'partner' ? partner : source === 'client_offset' ? clientSrc : supplierSrc;
      fill(srcBox,
        source === 'partner' ? partner : null,
        source === 'supplier_credit' && mode !== 'material_purchase' ? supplierSrc : null,
        source === 'supplier_credit' && mode === 'material_purchase' ? h('div', { class: 'wide tr-hint' }, 'المبلغ هيتسجل على حساب المورد (آجل).') : null,
        source === 'client_offset' ? clientSrc : null,
        source === 'client_offset' ? h('div', { class: 'wide tr-hint' }, 'العميل دفع المصروف ده عننا: المبلغ بينزل من اللي عليه.') : null,
        source === 'cheque' ? [chNum, chBank, chDue, mode === 'expense' || mode === 'salary' ? chPayee : null,
          h('div', { class: 'wide tr-hint' }, 'الشيك بيتسجل في أوراق الدفع «لسه متصرفش»، وبينزل من البنك لما تسجل صرفه.')] : null);
    };
    drawSource();
    const sourceOf = () => {
      const out = { paid_from: source };
      if (source === 'partner') { const id = partner.require('اختار الشريك'); if (!id) throw new Error(''); out.paid_from_party_id = id; }
      if (source === 'supplier_credit' && mode !== 'material_purchase') { const id = supplierSrc.require('اختار المورد'); if (!id) throw new Error(''); out.paid_from_party_id = id; }
      if (source === 'client_offset') { const id = clientSrc.require('اختار العميل'); if (!id) throw new Error(''); out.paid_from_party_id = id; }
      if (source === 'cheque') out.cheque = { number: chNum.input.value, bank: chBank.input.value, due_date: chDue.input.value, payee_text: chPayee.input.value };
      return out;
    };

    // ---------- the bill photo ----------
    let photo = null;
    const thumb = h('span');
    const fileIn = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
    fileIn.addEventListener('change', async () => {
      const f = fileIn.files?.[0];
      if (!f) return;
      try {
        photo = await shrinkPhoto(f);
        fill(thumb, h('img', { class: 'tr-thumb', src: photo, alt: 'صورة الفاتورة' }), ' ', button('شيل الصورة', { size: 'sm', kind: 'ghost', icon: 'x', onClick: () => { photo = null; fill(thumb, ''); fileIn.value = ''; } }));
      } catch (ex) { toast(ex.message, true); }
    });
    const photoRow = h('div', { class: 'row' }, button('صوّر الفاتورة أو اختار صورة', { icon: 'camera', onClick: () => fileIn.click() }), fileIn, thumb);

    const save = async () => {
      fill(err, '');
      let data;
      try { data = { kind: apiKind, date: date.input.value, description: desc.input.value, ...collect(), ...sourceOf() }; } catch (ex) { if (ex.message) fill(err, ex.message); revealError(body, err); return; }
      try {
        const { voucher } = await post('/api/treasury/vouchers', data);
        if (photo) {
          try { await post(`/api/treasury/vouchers/${voucher.id}/photo`, { photo }); } catch (ex) { toast(`الإذن اتسجل بس الصورة ماترفعتش: ${ex.message}`, true); }
        }
        if (limited) {
          lastSaved = { id: voucher.id, data };
          return showDone(voucher, data);
        }
        toast(`اتسجل إذن الصرف ${voucher.serial}`, false, { action: { label: 'اطبع', onClick: () => ctx.go(`#/print/voucher/${voucher.id}`) } });
        ctx.go(`#/expenses/${voucher.id}`);
      } catch (ex) { showError(ex, fields, err); }
    };

    fill(body, trForm(save,
      h('div', { class: 'card' }, h('h3', {}, mode === 'salary' ? 'المرتب' : mode === 'material_purchase' ? 'الفاتورة' : 'المصروف'), parts),
      h('div', { class: 'card' }, h('h3', {}, 'اتصرف من'), srcSeg, h('div', { style: 'margin-top:12px' }, srcBox)),
      h('div', { class: 'card' }, h('h3', {}, 'صورة الفاتورة (اختياري)'), photoRow),
      err,
      h('div', { class: 'tr-actions' }, button('سجّل إذن الصرف', { kind: 'primary', size: 'big', icon: 'check', type: 'submit' }),
        button('رجوع', { href: '#/expenses' }))));
  };

  const showDone = (voucher, data) => {
    const total = (data.lines || []).reduce((s, l) => s + (parseNum(l.amount) || 0), 0) * 1000;
    fill(body, '');
    fill(done, h('div', { class: 'card empty' },
      h('div', { class: 'ic' }, icon('check-circle', 'lg')), h('b', {}, `اتسجل إذن الصرف ${voucher.serial}`),
      h('div', { class: 'small' }, `${voucher.lines?.[0]?.category_name || ''} — ${money(Math.round(total))}`),
      h('div', { class: 'row', style: 'justify-content:center;margin-top:8px' },
        button('اطبع الإذن', { icon: 'printer', href: `#/print/voucher/${voucher.id}` }),
        button('إذن صرف جديد', { kind: 'primary', icon: 'plus', onClick: render }),
        button('المصروفات', { href: '#/expenses' }))));
  };

  fill(main,
    backLink('#/expenses', 'المصروفات'),
    pageHead('إذن صرف', limited ? 'سجّل المصروف اللي اتدفع من الخزينة، وصوّر الفاتورة.' : 'مصروف، مرتب، شراء خامات، دفعة لمورد، سحب شريك، أو سلفة عامل.',
      limited ? null : button('إيداع شريك', { icon: 'handshake', href: '#/treasury/receipt?kind=partner', title: 'فلوس داخلة من شريك: إيصال استلام' })),
    modeSeg ? h('div', { style: 'margin-bottom:14px' }, modeSeg) : null,
    done, body);
  render();
}

// ---------- the voucher page ----------
export async function voucherView(main, p, ctx) {
  useStyles();
  const { voucher: v } = await get(`/api/treasury/vouchers/${p.id}`);
  const hasMoney = 'total' in v;
  const cancel = async () => {
    const reason = await confirmModal(`إلغاء إذن الصرف ${v.serial}`, 'الإذن مش هيتمسح: هيتعمل قيد عكسي بنفس المبلغ والإذن يفضل ظاهر «ملغي».', 'ألغِ الإذن', { danger: true, withReason: true, reasonLabel: 'سبب الإلغاء' });
    if (!reason) return;
    try { await post(`/api/treasury/vouchers/${v.id}/cancel`, { reason }); toast('اتلغى إذن الصرف'); ctx.refresh(); } catch (ex) { toast(ex.message, true); }
  };
  const fileIn = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files?.[0];
    if (!f) return;
    try { await post(`/api/treasury/vouchers/${v.id}/photo`, { photo: await shrinkPhoto(f) }); toast('اتحفظت صورة الفاتورة'); ctx.refresh(); } catch (ex) { toast(ex.message, true); }
  });
  const linesTable = v.lines.length ? dataTable([
    { label: 'البند', value: (l) => l.category_name },
    { label: 'مركز التكلفة', value: (l) => [l.cost_party_name || 'عام', l.recharge ? [' ', pill('accent', 'يتحمّل على العميل')] : null] },
    { label: 'العامل', value: (l) => l.worker_name || '' },
    hasMoney ? { label: 'المبلغ', n: true, value: (l) => moneyText(l.amount) } : null,
  ].filter(Boolean), v.lines) : null;
  const itemsTable = v.items.length ? dataTable([
    { label: 'الخامة', value: (i) => i.material_text },
    { label: 'السمك', n: true, value: (i) => i.thickness ?? '' },
    { label: 'الكمية', n: true, value: (i) => `${i.qty} ${i.unit}` },
    hasMoney ? { label: 'سعر الوحدة', n: true, value: (i) => moneyText(i.unit_rate) } : null,
    hasMoney ? { label: 'المبلغ', n: true, value: (i) => moneyText(i.line_amount) } : null,
  ].filter(Boolean), v.items) : null;
  fill(main,
    backLink('#/expenses', 'المصروفات'),
    pageHead(`إذن صرف ${v.serial}`, h('span', { class: 'row' }, v.kind_name, '—', fmtDate(v.date), docPill(v.status)),
      button('اطبع', { icon: 'printer', href: `#/print/voucher/${v.id}` }),
      v.status !== 'cancelled' && ctx.can('treasury') ? button('ألغِ الإذن', { kind: 'danger', icon: 'prohibit', onClick: cancel }) : null),
    v.status === 'cancelled' ? notice('danger', v.cancel_reason ? `إذن الصرف ده ملغي. السبب: ${v.cancel_reason}` : 'إذن الصرف ده ملغي.') : null,
    !hasMoney ? notice('info', 'المبالغ بتظهر للأدمن بس.') : null,
    h('div', { class: 'grid', style: 'margin-top:12px' },
      h('div', { class: 'card' }, kv([
        ['النوع', v.kind_name], [v.party_kind === 'supplier' ? 'المورد' : v.party_kind === 'partner' ? 'الشريك' : 'العامل', v.party_name || null],
        ['البيان', v.description],
        ['المبلغ', hasMoney ? h('b', { class: 'money' }, money(v.total)) : null],
        ['بالحروف', hasMoney ? amountWords(v.total) : null],
        ['خصم من السلفة', hasMoney && v.deduction_amount ? moneyText(v.deduction_amount) : null],
        ['اتدفع فعلاً', hasMoney && v.deduction_amount ? moneyText(v.paid_amount) : null],
        ['اتصرف من', `${v.paid_from_name}${v.paid_from_party_name ? ` — ${v.paid_from_party_name}` : ''}`],
        ['الشيك', v.cheque ? h('a', { href: `#/cheques/${v.cheque.id}` }, `رقم ${v.cheque.number} — يستحق ${fmtDate(v.cheque.due_date)} `, chequePill(v.cheque)) : null],
        ['رقم القيد', v.txn_serial], ['سجّله', `${v.created_by_name || '—'} — ${fmtDateTime(v.created_at)}`],
      ])),
      linesTable, itemsTable,
      h('div', { class: 'card' }, h('h3', {}, 'صورة الفاتورة'),
        v.has_photo ? h('a', { href: `/api/treasury/vouchers/${v.id}/photo`, target: '_blank', rel: 'noopener' }, h('img', { class: 'tr-photo', src: `/api/treasury/vouchers/${v.id}/photo`, alt: 'صورة الفاتورة' }))
          : emptyState('image', 'مفيش صورة للفاتورة', 'صوّر الفاتورة عشان تفضل محفوظة مع الإذن.', null, true),
        // a cancelled voucher is frozen; the workshop manager attaches the bill once, the treasury may replace it
        v.status !== 'cancelled' && (!v.has_photo || ctx.can('treasury')) ? h('div', { class: 'row', style: 'margin-top:10px' }, fileIn,
          button(v.has_photo ? 'غيّر الصورة' : 'صوّر الفاتورة', { icon: 'camera', onClick: () => fileIn.click() })) : null)));
}

export async function printVoucher(main, p) {
  useStyles();
  const { voucher: v } = await get(`/api/treasury/vouchers/${p.id}`);
  // The workshop manager's own just-saved voucher: the amounts he typed.
  if (!('total' in v) && lastSaved?.id === v.id) {
    const ls = lastSaved.data.lines || [];
    v.total = Math.round(ls.reduce((s, l) => s + (parseNum(l.amount) || 0), 0) * 1000);
    v.lines.forEach((l, i) => { l.amount = Math.round((parseNum(ls[i]?.amount) || 0) * 1000); });
    v.paid_amount = v.total;
  }
  const has = 'total' in v;
  const to = v.party_name || v.cheque?.payee_text || v.lines.map((l) => l.worker_name).filter(Boolean)[0] || '';
  const paper = h('div', { class: 'tr-paper' },
    v.status === 'cancelled' ? h('div', { class: 'void' }, 'ملغي') : null,
    h('div', { class: 'ph' },
      h('div', { class: 'co' }, h('b', {}, 'شركة الصفا')),
      h('div', { class: 'doc' }, h('b', {}, 'إذن صرف'), h('div', { class: 'num' }, `رقم ${v.serial}`), h('div', { class: 'num' }, `التاريخ ${fmtDate(v.date)}`))),
    line('صرفنا إلى', to),
    h('div', { class: 'line' }, h('span', { class: 'k' }, 'مبلغ وقدره'), has ? [h('span', { class: 'big' }, money(v.paid_amount ?? v.total)), h('span', {}, 'جنيه مصري')] : h('span', { class: 'v' })),
    line('فقط', has ? amountWords(v.paid_amount ?? v.total).replace(/^فقط /, '') : ''),
    line('وذلك عن', [v.kind === 'expense' ? [...new Set(v.lines.map((l) => l.category_name))].join('، ') : v.kind_name, v.description].filter(Boolean).join(' — ')),
    line('اتصرف من', `${v.paid_from_name}${v.paid_from_party_name ? ` — ${v.paid_from_party_name}` : ''}${v.cheque ? ` — شيك رقم ${v.cheque.number} يستحق ${fmtDate(v.cheque.due_date)}` : ''}`),
    v.lines.length > 1 || v.lines.some((l) => l.cost_party_name) ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'البند'), h('th', {}, 'مركز التكلفة'), has ? h('th', {}, 'المبلغ') : null)),
      h('tbody', {}, v.lines.map((l) => h('tr', {}, h('td', {}, l.category_name), h('td', {}, l.cost_party_name || 'عام'), has ? h('td', { class: 'num' }, money(l.amount)) : null)))) : null,
    v.items.length ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'الخامة'), h('th', {}, 'الكمية'), has ? [h('th', {}, 'سعر الوحدة'), h('th', {}, 'المبلغ')] : null)),
      h('tbody', {}, v.items.map((i) => h('tr', {}, h('td', {}, `${i.material_text}${i.thickness ? ` ${i.thickness} مم` : ''}`), h('td', { class: 'num' }, `${i.qty} ${i.unit}`),
        has ? [h('td', { class: 'num' }, money(i.unit_rate)), h('td', { class: 'num' }, money(i.line_amount))] : null)))) : null,
    v.deduction_amount && has ? line('خصم من السلفة', money(v.deduction_amount)) : null,
    h('div', { class: 'sign' }, h('div', {}, 'المستلم'), h('div', {}, 'المحاسب'), h('div', {}, 'المدير')));
  printFrame(main, `#/expenses/${v.id}`, paper);
}
const line = (k, v) => h('div', { class: 'line' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v || ''));

// ---------- المصروفات ----------
export async function expensesList(main, _p, ctx) {
  useStyles();
  const q = ctx.query;
  const full = ctx.can('treasury');
  const showMoney = ctx.can('money.view');
  const cats = ctx.state.lookups?.expense_categories || [];
  const fromIn = h('input', { type: 'date', value: q.from ?? monthStart() });
  const toIn = h('input', { type: 'date', value: q.to || '' });
  const catIn = selectInput([['', 'كل البنود'], ...cats.map((c) => [c.id, c.name])], q.category_id || '');
  const costIn = selectInput([['', 'كل المراكز'], ['general', 'عام'], ['client', 'على عملاء']], q.cost || '');
  const paidIn = selectInput([['', 'من أي مكان'], ['cash', 'الخزينة'], ['bank', 'البنك'], ['cheque', 'شيك'], ['partner', 'جيب شريك'], ['supplier_credit', 'آجل على مورد'], ['client_offset', 'مقاصة عميل']], q.paid_from || '');
  const kindIn = selectInput([['', 'كل الأنواع'], ['expense', 'مصروفات'], ['material_purchase', 'شراء خامات'], ['supplier_payment', 'دفعات موردين'], ['partner_withdrawal', 'سحب شركاء'], ['worker_advance', 'سلف عمال']], q.kind || '');
  const statusIn = selectInput([['', 'المتسجل'], ['cancelled', 'الملغي'], ['all', 'الكل']], q.status || '');
  const searchIn = h('input', { type: 'search', placeholder: 'دوّر في البيان…', value: q.q || '' });
  const totalsBox = h('div');
  const box = h('div', {}, skeleton('table'));

  // Clients join the cost-center filter when the list arrives.
  partiesOf('client').then((cl) => {
    for (const c of cl) costIn.append(h('option', { value: c.id, selected: String(q.cost) === String(c.id) }, c.name));
  }).catch(() => {});

  const load = () => loadInto(box, async () => {
    const r = await get('/api/treasury/vouchers', {
      from: fromIn.value, to: toIn.value, category_id: catIn.value, cost: costIn.value, paid_from: paidIn.value,
      kind: kindIn.value, status: statusIn.value, q: searchIn.value.trim(),
    });
    fill(totalsBox, showMoney && r.totals ? h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(260px,1fr));margin-bottom:14px' },
      h('div', { class: 'stat' }, h('span', {}, `إجمالي ${r.totals.count} إذن`), h('b', { class: 'money' }, money(r.totals.grand_total))),
      r.totals.by_category.length ? h('div', { class: 'card' }, h('div', { class: 'tr-cats' },
        r.totals.by_category.slice(0, 8).map((c) => h('div', {}, h('span', {}, c.name), moneyText(c.amount))))) : null) : null);
    if (!r.vouchers.length) {
      return emptyState('wallet', 'مفيش أذونات صرف بالفلتر ده', r.own_only ? 'الأذونات اللي إنت سجلتها بتظهر هنا.' : 'غيّر الفترة أو الفلتر، أو سجّل إذن صرف.',
        button('إذن صرف جديد', { kind: 'primary', icon: 'plus', href: '#/expenses/new' }));
    }
    return [
      r.own_only ? notice('info', 'دي الأذونات اللي إنت سجلتها. المبالغ والإجماليات بتظهر للأدمن بس.') : null,
      dataTable([
        { label: 'رقم', value: (v) => h('span', { class: 'num' }, v.serial) },
        { label: 'التاريخ', value: (v) => h('span', { class: 'num' }, fmtDate(v.date)) },
        { label: 'البند', value: (v) => h('div', {}, v.categories, v.party_name ? h('div', { class: 'small muted' }, v.party_name) : null) },
        { label: 'البيان', value: (v) => [v.description, v.has_photo ? [' ', icon('paperclip', 'sm')] : null] },
        { label: 'مركز التكلفة', value: (v) => [v.cost_centers, v.recharge ? [' ', pill('accent', 'يتحمّل')] : null] },
        { label: 'اتصرف من', value: (v) => v.paid_from_name + (v.paid_from_party_name ? ` — ${v.paid_from_party_name}` : '') },
        showMoney ? { label: 'المبلغ', n: true, value: (v) => moneyText(v.amount) } : null,
        { label: '', value: (v) => docPill(v.status) },
      ].filter(Boolean), r.vouchers, { onRow: (v) => ctx.go(`#/expenses/${v.id}`), rowClass: (v) => (v.status === 'cancelled' ? 'struck' : '') }),
    ];
  });
  for (const el of [fromIn, toIn, catIn, costIn, paidIn, kindIn, statusIn]) el.addEventListener('change', load);
  let t;
  searchIn.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 300); });

  fill(main,
    pageHead('المصروفات', full ? 'كل أذونات الصرف بفلتر التاريخ والبند ومركز التكلفة.' : 'أذونات الصرف اللي سجلتها.',
      button('إذن صرف جديد', { kind: 'primary', icon: 'plus', href: '#/expenses/new' }),
      full ? button('المصروفات المتكررة', { icon: 'repeat', href: '#/expenses/recurring' }) : null),
    h('div', { class: 'tr-filters' }, field('من', fromIn), field('لحد', toIn),
      full ? [field('البند', catIn), field('مركز التكلفة', costIn), field('اتصرف من', paidIn), field('النوع', kindIn), field('الحالة', statusIn)] : null,
      field('بحث', searchIn)),
    h('div', { class: 'row', style: 'margin:-6px 0 14px' },
      button('الشهر ده', { size: 'sm', kind: 'ghost', onClick: () => { fromIn.value = monthStart(); toIn.value = ''; load(); } }),
      button('الشهر اللي فات', { size: 'sm', kind: 'ghost', onClick: () => { [fromIn.value, toIn.value] = prevMonthRange(); load(); } }),
      button('من الأول', { size: 'sm', kind: 'ghost', onClick: () => { fromIn.value = ''; toIn.value = ''; load(); } })),
    totalsBox, box);
  await load();
}

// ---------- المصروفات المتكررة ----------
export async function recurringExpenses(main, _p, ctx) {
  useStyles();
  const cats = (ctx.state.lookups?.expense_categories || []).map((c) => [c.id, c.name]);
  const draftsBox = h('div', {}, skeleton());
  const listBox = h('div', {}, skeleton('table'));
  let partners = [];
  let clients = [];
  try { [partners, clients] = await Promise.all([partiesOf('partner'), partiesOf('client')]); } catch { /* lists stay empty */ }

  const form = (r = null) => formModal({
    title: r ? 'تعديل مصروف متكرر' : 'مصروف متكرر جديد',
    intro: 'كل أول شهر البرنامج بيجهّز إذن صرف بالمبلغ ده، وإنت بتأكده بضغطة.',
    fields: [
      { name: 'category_id', label: 'البند', type: 'select', options: [['', 'اختار…'], ...cats], value: r?.category_id ?? '' },
      { name: 'description', label: 'البيان', value: r?.description ?? '', placeholder: 'زي: إيجار الورشة' },
      { name: 'amount', label: 'المبلغ', type: 'money', value: r ? r.amount / 1000 : '' },
      { name: 'day_of_month', label: 'يوم الشهر', type: 'number', value: r?.day_of_month ?? 1, help: 'من 1 لـ 28' },
      { name: 'paid_from', label: 'بيتصرف من', type: 'select', options: [['cash', 'الخزينة'], ['bank', 'البنك'], ['partner', 'جيب شريك']], value: r?.paid_from ?? 'cash' },
      { name: 'paid_from_party_id', label: 'الشريك', type: 'select', options: [['', 'اختار…'], ...partners.map((p) => [p.id, p.name])], value: r?.paid_from_party_id ?? '', showIf: (v) => v.paid_from === 'partner' },
      { name: 'cost_party_id', label: 'مركز التكلفة', type: 'select', options: [['', 'عام'], ...clients.map((p) => [p.id, p.name])], value: r?.cost_party_id ?? '' },
      ...(r ? [{ name: 'active', label: 'شغال (شيل العلامة عشان توقفه)', type: 'checkbox', value: r.active }] : []),
    ],
    submitLabel: r ? 'حفظ التعديل' : 'ضيف المصروف',
    onSubmit: async (v) => {
      const b = { ...v, day_of_month: Number(v.day_of_month) };
      const res = r ? await patch(`/api/treasury/recurring/${r.id}`, b) : await post('/api/treasury/recurring', b);
      toast('اتحفظ');
      load();
      return res;
    },
  });

  const confirmOne = async (d, edit = false) => {
    let body = { recurring_id: d.recurring_id, month: d.month };
    if (edit) {
      const v = await formModal({
        title: `${d.description} — شهر ${d.month}`, intro: 'غيّر المبلغ أو التاريخ للشهر ده بس.',
        fields: [{ name: 'amount', label: 'المبلغ', type: 'money', value: d.amount / 1000 }, { name: 'date', label: 'التاريخ', type: 'date', value: d.date }],
        submitLabel: 'أكّد وسجّل الإذن', onSubmit: (x) => x,
      });
      if (!v) return;
      body = { ...body, ...v };
    }
    try {
      const { voucher } = await post('/api/treasury/recurring/drafts/confirm', body);
      toast(`اتسجل إذن الصرف ${voucher.serial}`, false, { action: { label: 'افتح', onClick: () => ctx.go(`#/expenses/${voucher.id}`) } });
      load();
    } catch (ex) { toast(ex.message, true); }
  };
  const skip = async (d) => {
    const reason = await confirmModal(`تخطي ${d.description} — شهر ${d.month}`, 'الشهر ده مش هيتسجل له إذن صرف.', 'تخطّى الشهر', { withReason: true, reasonLabel: 'سبب التخطي' });
    if (!reason) return;
    try { await post('/api/treasury/recurring/drafts/skip', { recurring_id: d.recurring_id, month: d.month, reason }); toast('اتخطى'); load(); } catch (ex) { toast(ex.message, true); }
  };

  const load = async () => {
    const { recurring, drafts } = await get('/api/treasury/recurring');
    fill(draftsBox, drafts.length ? h('div', { class: 'card', style: 'margin-bottom:16px' },
      h('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:10px' },
        h('h3', { style: 'margin:0' }, icon('calendar-check', 'sm'), ` مستني تأكيدك (${drafts.length})`),
        button('أكّد الكل', { kind: 'primary', icon: 'check', onClick: async () => {
          const ok = await confirmModal('تأكيد كل المسودات', `هيتسجل ${drafts.length} إذن صرف بالمبالغ والتواريخ اللي قدامك.`, 'أكّد الكل');
          if (!ok) return;
          try { const r = await post('/api/treasury/recurring/drafts/confirm-all', {}); toast(`اتسجل ${r.confirmed} إذن صرف`); load(); } catch (ex) { toast(ex.message, true); }
        } })),
      dataTable([
        { label: 'الشهر', value: (d) => [h('span', { class: 'num' }, d.month), d.overdue ? [' ', pill('danger', 'متأخر')] : null] },
        { label: 'البند', value: (d) => h('div', {}, d.category_name, h('div', { class: 'small muted' }, d.description)) },
        { label: 'من', value: (d) => ({ cash: 'الخزينة', bank: 'البنك', partner: `جيب ${d.paid_from_party_name || 'شريك'}` })[d.paid_from] },
        { label: 'التاريخ', value: (d) => h('span', { class: 'num' }, fmtDate(d.date)) },
        { label: 'المبلغ', n: true, value: (d) => moneyText(d.amount) },
        { label: '', value: (d) => h('div', { class: 'tr-row-actions' },
          button('أكّد', { size: 'sm', kind: 'primary', onClick: () => confirmOne(d) }),
          button('عدّل وأكّد', { size: 'sm', onClick: () => confirmOne(d, true) }),
          button('تخطّى', { size: 'sm', kind: 'ghost', onClick: () => skip(d) })) },
      ], drafts)) : (recurring.length ? notice('ok', 'مفيش مسودات مستنية — كل الشهور اتسجلت.') : null));
    fill(listBox, recurring.length ? dataTable([
      { label: 'البند', value: (r) => h('div', {}, h('b', {}, r.description), h('div', { class: 'small muted' }, r.category_name)) },
      { label: 'المبلغ', n: true, value: (r) => moneyText(r.amount) },
      { label: 'كل شهر يوم', value: (r) => h('span', { class: 'num' }, r.day_of_month) },
      { label: 'من', value: (r) => ({ cash: 'الخزينة', bank: 'البنك', partner: `جيب ${r.paid_from_party_name || 'شريك'}` })[r.paid_from] },
      { label: 'مركز التكلفة', value: (r) => r.cost_party_name || 'عام' },
      { label: 'آخر شهر', value: (r) => (r.last_run ? `${r.last_run.month} ${r.last_run.status === 'skipped' ? '(اتخطى)' : ''}` : '—') },
      { label: '', value: (r) => (r.active ? pill('ok', 'شغال') : pill('neutral', 'موقوف')) },
    ], recurring, { onRow: (r) => form(r), rowClass: (r) => (r.active ? '' : 'muted-row') })
      : emptyState('repeat', 'لسه مفيش مصروفات متكررة', 'ضيف الإيجار والمرتبات والكهرباء مرة واحدة، والبرنامج يجهزهم كل شهر.',
        button('مصروف متكرر جديد', { kind: 'primary', icon: 'plus', onClick: () => form() })));
  };

  fill(main,
    backLink('#/expenses', 'المصروفات'),
    pageHead('المصروفات المتكررة', 'كل أول شهر بتتجهز مسودة لكل مصروف، وإنت بتأكدها بضغطة.',
      button('مصروف متكرر جديد', { kind: 'primary', icon: 'plus', onClick: () => form() })),
    draftsBox, h('h2', {}, 'القوالب'), listBox);
  try { await load(); } catch (ex) { fill(draftsBox, notice('danger', ex.message)); fill(listBox, ''); }
}

