// الشيكات: أوراق القبض (client cheques we hold) and أوراق الدفع (cheques we wrote), by the week
// they fall due, with week totals, alerts (due within 3 days / overdue), and the actions of each
// state: إيداع، تحصيل، تظهير لمورد، ارتداد (in) · صرف، ارتداد (out). The cheque page shows its history.
import { h, fill, button, pageHead, backLink, emptyState, skeleton, notice, toast, formModal, dataTable, money,
  fmtDate, fmtDateTime, todayISO, loadInto, field, tabs } from '../ui.js';
import { get, post } from '../api.js';
import { useStyles, seg, kv, moneyText, chequePill, duePill, partiesOf } from './treasury-common.js';

const STATUS_FILTER = {
  in: [['open', 'اللي في إيدنا'], ['collected', 'اتحصّلت'], ['endorsed', 'اتظهّرت'], ['bounced', 'مرتدة'], ['all', 'الكل']],
  out: [['open', 'لسه متصرفتش'], ['cleared', 'اتصرفت'], ['bounced', 'مرتدة'], ['all', 'الكل']],
};

// The actions a cheque in this state offers.
export function chequeActions(c, onDone) {
  const act = (label, opts, fn) => button(label, { size: 'sm', ...opts, onClick: (e) => { e.stopPropagation(); return fn(); } });
  const run = async (action, title, intro, fields, submitLabel, danger = false) => {
    const r = await formModal({
      title, intro, fields, submitLabel, danger,
      onSubmit: (v) => post(`/api/treasury/cheques/${c.id}/${action}`, v),
    });
    if (r) { toast(`${submitLabel} — تمام`); onDone?.(r.cheque); }
  };
  const dateF = (label) => ({ name: 'date', label, type: 'date', value: todayISO() });
  const out = [];
  const name = `شيك ${c.number || c.serial} — ${money(c.amount)}`;
  if (c.direction === 'in') {
    if (c.status === 'in_portfolio') out.push(act('إيداع', { icon: 'bank' }, () => run('deposit', `إيداع ${name}`, 'الشيك اتودع في البنك ومستني التحصيل. مفيش قيد لحد ما يتحصّل.', [dateF('تاريخ الإيداع')], 'سجّل الإيداع')));
    if (['in_portfolio', 'deposited'].includes(c.status)) out.push(act('تحصيل', { kind: 'primary', icon: 'check' }, () => run('collect', `تحصيل ${name}`, 'المبلغ هيدخل البنك وينزل من رصيد العميل.', [dateF('تاريخ التحصيل')], 'سجّل التحصيل')));
    if (c.status === 'in_portfolio') {
      out.push(act('تظهير لمورد', { icon: 'share-fat' }, async () => {
        const suppliers = await partiesOf('supplier');
        if (!suppliers.length) { toast('لسه مفيش موردين متسجلين — ضيف المورد الأول', true); return; }
        await run('endorse', `تظهير ${name}`, 'الشيك بيروح للمورد: بينزل من اللي علينا للمورد ومن رصيد العميل.',
          [{ name: 'supplier_id', label: 'المورد', type: 'select', options: [['', 'اختار المورد…'], ...suppliers.map((s) => [s.id, s.name])] }, dateF('تاريخ التظهير')], 'سجّل التظهير');
      }));
    }
    if (['in_portfolio', 'deposited', 'collected', 'endorsed'].includes(c.status)) {
      out.push(act('ارتداد', { kind: 'danger', icon: 'arrow-u-up-left' }, () => run('bounce', `ارتداد ${name}`,
        c.status === 'collected' ? 'الشيك اترد بعد التحصيل: هيتعمل قيد عكسي، والمبلغ يرجع على العميل ويطلع من البنك.'
          : c.status === 'endorsed' ? 'المورد رجّع الشيك: التظهير هيتلغي بقيد عكسي.' : 'الشيك اترد قبل ما يتحصّل: مفيش قيد، بس الشيك يطلع من الحافظة.',
        [dateF('تاريخ الارتداد'), { name: 'reason', label: 'سبب الارتداد', type: 'textarea', wide: true }], 'سجّل الارتداد', true)));
    }
  } else {
    if (c.status === 'issued') out.push(act('صرف', { kind: 'primary', icon: 'check' }, () => run('clear', `صرف ${name}`, 'الشيك اتصرف من البنك: المبلغ هينزل من رصيد البنك.', [dateF('تاريخ الصرف')], 'سجّل الصرف')));
    if (['issued', 'cleared'].includes(c.status) && c.party_id) {
      out.push(act('ارتداد', { kind: 'danger', icon: 'arrow-u-up-left' }, () => run('bounce', `ارتداد ${name}`, 'الشيك اترد: المبلغ بيرجع دين علينا للمستفيد.',
        [dateF('تاريخ الارتداد'), { name: 'reason', label: 'السبب', type: 'textarea', wide: true }], 'سجّل الارتداد', true)));
    }
  }
  return out;
}

function chequesScreen(direction) {
  return async (main, _p, ctx) => {
    useStyles();
    const q = ctx.query;
    let status = STATUS_FILTER[direction].some(([s]) => s === q.status) ? q.status : 'open';
    const statusSeg = seg(STATUS_FILTER[direction], status, (s) => { status = s; load(); }, { label: 'الحالة' });
    const fromIn = h('input', { type: 'date', value: q.from || '' });
    const toIn = h('input', { type: 'date', value: q.to || '' });
    const searchIn = h('input', { type: 'search', placeholder: 'رقم الشيك أو البنك أو الاسم…', value: q.q || '' });
    const alertsBox = h('div');
    const box = h('div', {}, skeleton('table'));
    const title = direction === 'in' ? 'أوراق القبض' : 'أوراق الدفع';

    const load = () => loadInto(box, async () => {
      const r = await get('/api/treasury/cheques', { direction, status, from: fromIn.value, to: toIn.value, q: searchIn.value.trim() });
      const overdue = r.alerts.filter((a) => a.alert === 'overdue');
      const soon = r.alerts.filter((a) => a.alert === 'due_soon');
      fill(alertsBox, overdue.length || soon.length ? h('div', { class: 'tr-alerts' },
        overdue.length ? notice('danger', `${overdue.length} شيك ميعاده عدّى ولسه ${direction === 'in' ? 'متحصّلش' : 'متصرفش'} — إجمالي ${money(overdue.reduce((s, c) => s + c.amount, 0))}`) : null,
        soon.length ? notice('warn', `${soon.length} شيك ميعاده خلال 3 أيام — إجمالي ${money(soon.reduce((s, c) => s + c.amount, 0))}`) : null) : null);
      if (!r.weeks.length) {
        return emptyState(direction === 'in' ? 'bank' : 'signature', status === 'open' ? (direction === 'in' ? 'مفيش شيكات في الحافظة' : 'مفيش شيكات لسه متصرفتش') : 'مفيش شيكات بالفلتر ده',
          direction === 'in' ? 'شيك العميل بيتسجل من إيصال استلام بطريقة «شيك».' : 'الشيك اللي بنكتبه بيتسجل من إذن صرف «اتصرف من: شيك من عندنا».',
          button(direction === 'in' ? 'إيصال استلام بشيك' : 'إذن صرف بشيك', { kind: 'primary', icon: 'plus', href: direction === 'in' ? '#/treasury/receipt' : '#/expenses/new' }));
      }
      const cols = [
        { label: 'رقم الشيك', value: (c) => h('div', {}, h('b', { class: 'num' }, c.number || '—'), h('div', { class: 'small muted num' }, c.serial)) },
        { label: direction === 'in' ? 'من' : 'لـ', value: (c) => h('div', {}, c.party_name || c.payee_text || '—', c.endorsed_to_name ? h('div', { class: 'small muted' }, `اتظهّر لـ${c.endorsed_to_name}`) : null) },
        { label: 'البنك', value: (c) => c.bank || '' },
        { label: 'الاستحقاق', value: (c) => h('span', { class: 'row', style: 'gap:6px' }, h('span', { class: 'num' }, fmtDate(c.due_date)), duePill(c)) },
        { label: 'المبلغ', n: true, value: (c) => moneyText(c.amount) },
        { label: 'الحالة', value: (c) => chequePill(c) },
        { label: '', value: (c) => h('div', { class: 'tr-row-actions' }, chequeActions(c, () => load())) },
      ];
      return [
        h('p', { class: 'small muted' }, `${r.count} شيك — الإجمالي `, moneyText(r.grand_total)),
        r.weeks.map((w) => h('div', { class: `tr-week tr-day${w.this_week ? ' now' : ''}` },
          h('div', { class: 'tr-day-head' },
            h('b', {}, w.week_start ? `أسبوع ${fmtDate(w.week_start)} — ${fmtDate(w.week_end)}${w.this_week ? ' (الأسبوع ده)' : ''}` : 'من غير تاريخ استحقاق'),
            h('span', {}, `${w.count} شيك`), h('span', {}, 'الإجمالي ', moneyText(w.week_total))),
          dataTable(cols, w.rows, { onRow: (c) => ctx.go(`#/cheques/${c.id}`), rowClass: (c) => (c.alert === 'overdue' ? 'tr-overdue' : '') }))),
      ];
    });
    for (const el of [fromIn, toIn]) el.addEventListener('change', load);
    let t;
    searchIn.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 300); });

    fill(main,
      pageHead(title, direction === 'in' ? 'شيكات العملاء اللي معانا، متقسمة بأسبوع الاستحقاق.' : 'الشيكات اللي كتبناها، متقسمة بأسبوع الاستحقاق.',
        button(direction === 'in' ? 'إيصال استلام بشيك' : 'إذن صرف بشيك', { icon: 'plus', href: direction === 'in' ? '#/treasury/receipt' : '#/expenses/new' })),
      tabs([{ key: 'in', label: 'أوراق القبض', icon: 'bank', href: '#/cheques/in' }, { key: 'out', label: 'أوراق الدفع', icon: 'signature', href: '#/cheques/out' }], direction),
      alertsBox,
      h('div', { style: 'margin-bottom:12px' }, statusSeg),
      h('div', { class: 'tr-filters' }, field('استحقاق من', fromIn), field('لحد', toIn), field('بحث', searchIn)),
      box);
    await load();
  };
}

export const chequesIn = chequesScreen('in');
export const chequesOut = chequesScreen('out');

const KIND_WORDS = { reversal: 'إلغاء', cheque_collect: 'تحصيل', cheque_endorse: 'تظهير', cheque_clear: 'صرف', cheque_bounce: 'ارتداد' };

export async function chequeView(main, p, ctx) {
  useStyles();
  const { cheque: c } = await get(`/api/treasury/cheques/${p.id}`);
  const back = c.direction === 'in' ? '#/cheques/in' : '#/cheques/out';
  const actions = chequeActions(c, () => ctx.refresh());
  fill(main,
    backLink(back, c.direction === 'in' ? 'أوراق القبض' : 'أوراق الدفع'),
    pageHead(`شيك رقم ${c.number || '—'}`, h('span', { class: 'row' }, h('span', { class: 'num' }, c.serial), chequePill(c), duePill({ ...c, ...alertOf(c) }))),
    actions.length ? h('div', { class: 'tr-toolbar' }, actions) : null,
    c.status === 'bounced' ? notice('danger', `الشيك ده مرتد${c.bounced_date ? ` من ${fmtDate(c.bounced_date)}` : ''}. السبب: ${c.bounce_reason || '—'}`) : null,
    h('div', { class: 'grid', style: 'margin-top:12px' },
      h('div', { class: 'card' }, kv([
        [c.direction === 'in' ? 'من' : 'المستفيد', c.party_name ? h('a', { href: c.party_kind === 'client' ? `#/clients/${c.party_id}` : `#/parties/${c.party_id}` }, c.party_name) : c.payee_text || '—'],
        ['المبلغ', 'amount' in c ? h('b', { class: 'money' }, money(c.amount)) : null],
        ['البنك', c.bank],
        [c.direction === 'in' ? 'تاريخ الاستلام' : 'تاريخ الكتابة', fmtDate(c.received_date || c.issued_date)],
        ['تاريخ الاستحقاق', fmtDate(c.due_date)],
        ['تاريخ الإيداع', c.deposit_date ? fmtDate(c.deposit_date) : null],
        [c.direction === 'in' ? 'تاريخ التحصيل' : 'تاريخ الصرف', c.cleared_date && c.status !== 'endorsed' ? fmtDate(c.cleared_date) : null],
        ['اتظهّر لـ', c.endorsed_to_name ? `${c.endorsed_to_name} — ${fmtDate(c.cleared_date)}` : null],
        ['المستند', c.receipt ? h('a', { href: `#/treasury/receipts/${c.receipt.id}` }, `إيصال ${c.receipt.serial}`) : c.voucher ? h('a', { href: `#/expenses/${c.voucher.id}` }, `إذن صرف ${c.voucher.serial}`) : null],
        ['ملاحظات', c.notes],
        ['سجّله', fmtDateTime(c.created_at)],
      ])),
      h('div', {}, h('h2', {}, 'حركة الشيك'),
        c.history.length ? dataTable([
          { label: 'التاريخ', value: (t) => h('span', { class: 'num' }, fmtDate(t.date)) },
          { label: 'الحركة', value: (t) => KIND_WORDS[t.kind] || 'إصدار' },
          { label: 'البيان', value: (t) => t.description },
          { label: 'القيد', value: (t) => h('span', { class: 'num' }, t.serial) },
        ], c.history, { rowClass: (t) => (t.status === 'reversed' || t.reversal_of ? 'struck' : '') })
          : emptyState('hourglass-medium', 'لسه مفيش قيود', c.direction === 'in' ? 'الشيك في الحافظة: القيد بيتعمل لما يتحصّل أو يتظهّر.' : '', null, true))));
}

function alertOf(c) {
  const open = c.direction === 'in' ? ['in_portfolio', 'deposited'].includes(c.status) : c.status === 'issued';
  if (!open || !c.due_date) return { alert: null };
  const days = Math.round((Date.parse(`${c.due_date}T12:00:00Z`) - Date.parse(`${todayISO()}T12:00:00Z`)) / 86400000);
  return { alert: days < 0 ? 'overdue' : days <= 3 ? 'due_soon' : null, days_to_due: days };
}

