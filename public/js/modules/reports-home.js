// الرئيسية للأدمن: المركز المالي. Every figure is a link to the screen it comes from.
import { h, fill, button, pageHead, skeleton, emptyState, notice, pill, money, fmtDate, balanceCell } from '../ui.js';
import { get } from '../api.js';
import { linkStat, line, cardHead, daysText } from './reports-common.js';

export async function homeAdmin(main, _params, ctx) {
  fill(main, pageHead('المركز المالي', 'لينا وعلينا والخزينة والبنك النهارده. كل رقم بيفتح أصله.'), skeleton(), skeleton('table'));
  const d = await get('/api/reports/home');
  const p = d.position;
  const can = ctx.can;

  const actions = [
    can('treasury') ? button('إيصال استلام', { href: '#/treasury/receipt', icon: 'receipt' }) : null,
    can('expenses.record') ? button('إذن صرف', { href: '#/expenses/new', icon: 'hand-coins' }) : null,
  ];

  const stats = h('div', { class: 'stats' },
    linkStat('لينا', p.ours_total, '#/reports/clients', { sub: 'عملاء وسلف' }),
    linkStat('علينا', p.theirs_total, '#/reports/partners', { sub: 'شركاء وموردين وشيكات' }),
    linkStat('الخزينة', p.cash_balance, '#/treasury', { kind: p.cash_balance < 0 ? 'bad' : '' }),
    linkStat('البنك', p.bank_balance, '#/treasury', { kind: p.bank_balance < 0 ? 'bad' : '' }),
    linkStat('صافي المركز', p.net_total, '#/reports/profit', { kind: p.net_total < 0 ? 'bad' : 'accent', sub: 'لينا + الخزينة + البنك − علينا' }));

  const breakdown = (title, lines, total) => h('div', { class: 'card' }, cardHead(title),
    h('div', { class: 'rp-lines' },
      // memo lines (cheques in the portfolio) are already inside another line: shown muted, not summed
      lines.map((l) => line(l.label, l.amount, l.href, { kind: l.memo ? 'muted' : '',
        extra: l.count || l.memo ? h('span', { class: 'small muted' }, l.count ? `(${l.count})` : '', l.memo ? ' — للعلم، مش داخلة في الإجمالي' : '') : null })),
      line('الإجمالي', total, null, { kind: 'total' })));

  const chequeRow = (c) => line(c.party_name || '—', c.amount, c.direction === 'in' ? '#/cheques/in' : '#/cheques/out', {
    extra: h('span', { class: 'small muted' }, `شيك ${c.number || c.serial} · ${fmtDate(c.due_date)} `,
      c.overdue ? pill('danger', `متأخر ${daysText(-c.days_left)}`) : c.days_left === 0 ? pill('warn', 'النهارده') : null),
  });
  const due = d.cheques_due;
  const cheques = h('div', { class: 'card' }, cardHead('شيكات الأسبوع ده',
    can('cheques') ? button('الشيكات', { href: '#/cheques/in', size: 'sm', kind: 'ghost', icon: 'bank' }) : null),
  !due.in.length && !due.out.length
    ? emptyState('bank', 'مفيش شيكات مستحقة الأسبوع ده', 'الشيكات اللي ميعادها في السبع أيام الجاية هتظهر هنا.', null, true)
    : [
      due.in.length ? [h('div', { class: 'small muted', style: 'margin-top:6px' }, 'أوراق القبض (هتدخل)'), h('div', { class: 'rp-lines' }, due.in.map(chequeRow))] : null,
      due.out.length ? [h('div', { class: 'small muted', style: 'margin-top:10px' }, 'أوراق الدفع (هتطلع)'), h('div', { class: 'rp-lines' }, due.out.map(chequeRow))] : null,
    ]);

  const c = d.counters;
  const work = h('div', { class: 'card' }, cardHead('الشغل المستني'),
    h('div', { class: 'rp-lines' },
      line('أوراق مستنية تسعير', null, '#/pricing', { ic: 'tag', raw: String(c.sheets_waiting_pricing) }),
      line('أوراق في المراجعة', null, '#/ops/review', { ic: 'seal-check', raw: String(c.sheets_in_review) }),
      line('متابعات تحصيل النهارده', null, '#/reports/followups', { ic: 'phone', raw: String(c.follow_ups_due), kind: c.follow_ups_due ? 'warn' : '' })));

  const att = d.attention;
  const attention = h('div', { class: 'card' }, cardHead('محتاج نظرة', att.count > att.items.length ? h('span', { class: 'small muted' }, `${att.items.length} من ${att.count}`) : null),
    att.items.length
      ? h('div', { class: 'rp-lines' }, att.items.map((i) => line(i.title, null, i.href, {
        ic: i.level === 'danger' ? 'warning-circle' : 'warning', kind: i.level,
        extra: h('span', { class: 'small muted' }, i.detail),
        raw: i.cheque_amount ? money(i.cheque_amount) : i.over_amount ? `+${money(i.over_amount)}` : '',
      })))
      : notice('ok', 'كله تمام: مفيش شيكات متأخرة ولا عملاء عدّوا حد الائتمان ولا أوراق مستنية مراجعة.'));

  const fu = d.follow_ups_due;
  const follow = can('reports') ? h('div', { class: 'card' }, cardHead('متابعات التحصيل المستحقة', button('كل المتابعات', { href: '#/reports/followups', size: 'sm', kind: 'ghost', icon: 'phone' })),
    fu.length ? h('div', { class: 'rp-lines' }, fu.map((f) => h('a', { class: 'rp-line', href: `#/clients/${f.party_id}/followup` },
      h('span', { class: 'what' }, h('span', {}, h('b', {}, f.party_name), h('div', { class: 'small muted' }, f.note))),
      h('span', { class: 'row', style: 'gap:6px' }, f.overdue ? pill('danger', `من ${fmtDate(f.next_date)}`) : pill('warn', 'النهارده'), 'balance' in f ? balanceCell(f.balance) : null))))
      : emptyState('phone', 'مفيش متابعات النهارده', 'سجّل متابعة من ملف العميل ← المتابعة، وحدد ميعاد المكالمة الجاية.', null, true)) : null;

  fill(main,
    pageHead('المركز المالي', `لينا وعلينا والخزينة والبنك — ${fmtDate(d.as_of)}. كل رقم بيفتح أصله.`, actions),
    stats,
    h('div', { class: 'rp-two', style: 'margin-top:14px' },
      breakdown('لينا', p.ours, p.ours_total),
      breakdown('علينا', p.theirs, p.theirs_total)),
    h('div', { class: 'rp-two', style: 'margin-top:14px' }, attention, cheques),
    h('div', { class: 'rp-two', style: 'margin-top:14px' }, work, follow));
}
