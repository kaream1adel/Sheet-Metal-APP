// The money reports: ملخص العملاء, أعمار الديون, مكسب الشهر, التدفق المتوقع, جاري الشركاء.
// Admin only (money.view): the server refuses them to anyone else.
import { h, fill, button, pageHead, skeleton, emptyState, notice, pill, money, fmtDate, balanceCell, balanceText, dataTable,
  loadInto, todayISO, fold, textInput, field } from '../ui.js';
import { get, qs } from '../api.js';
import { linkStat, line, cardHead, bars, filters, dateFilter, daysText } from './reports-common.js';

const moneyCell = (m) => h('span', { class: 'money' }, m ? money(m) : '—');
const statementHref = (id) => `#/clients/${id}/statement`;

// ---------- ملخص العملاء ----------
export async function clientsSummary(main, _p, ctx) {
  let asOf = ctx.query.as_of || todayISO();
  let all = [];
  let totals = null;
  const q = textInput({ type: 'search', placeholder: 'دوّر على عميل…', 'aria-label': 'بحث', value: ctx.query.q || '' });
  const activeOnly = h('input', { type: 'checkbox' });
  const box = h('div', {}, skeleton('table'));
  const exportBtn = h('a', { class: 'btn', download: '', href: '#' }, 'تصدير Excel');
  const setExport = () => { exportBtn.href = `/api/reports/clients.xlsx${qs({ as_of: asOf, active_only: activeOnly.checked ? '1' : '' })}`; };

  const draw = () => {
    if (!all.length) {
      return fill(box, emptyState('users-three', 'لسه مفيش عملاء', 'أول ما تضيف عميل وتترحّل عليه شغل هيظهر هنا بإجمالياته.',
        button('العملاء', { kind: 'primary', href: '#/clients', icon: 'users-three' })));
    }
    const f = fold(q.value);
    const rows = f ? all.filter((r) => fold(r.name).includes(f)) : all;
    const cols = [
      { label: 'العميل', value: (r) => h('div', {}, h('b', {}, r.name), !r.active ? [' ', pill('neutral', 'موقوف')] : null, r.over_limit ? [' ', pill('danger', 'عدّى حد الائتمان')] : null) },
      { label: 'إجمالي المدين', n: true, value: (r) => moneyCell(r.debit_total) },
      { label: 'إجمالي الخصم', n: true, value: (r) => moneyCell(r.discount_total) },
      { label: 'إجمالي الدائن', n: true, value: (r) => moneyCell(r.credit_total) },
      { label: 'الرصيد النهائي', value: (r) => balanceCell(r.balance) },
      { label: 'آخر دفعة', value: (r) => (r.last_payment_date ? h('span', {}, h('span', { class: 'num' }, fmtDate(r.last_payment_date)), ' ', h('span', { class: 'small muted money' }, money(r.last_payment_amount))) : h('span', { class: 'muted' }, 'مفيش')) },
      { label: 'عمر المديونية', value: (r) => (r.debt_age_days === null ? '—' : h('span', { class: r.debt_age_days >= 90 ? 'hot' : '' }, daysText(r.debt_age_days))) },
    ];
    const t = totals;
    fill(box, rows.length ? dataTable(cols, rows, {
      onRow: (r) => ctx.go(statementHref(r.id)),
      rowClass: (r) => (r.active ? '' : 'muted-row'),
      foot: f ? null : [{ value: `الإجمالي (${rows.length} عميل)` }, { n: true, value: money(t.debit_total) }, { n: true, value: money(t.discount_total) },
        { n: true, value: money(t.credit_total) }, { value: balanceCell(t.balance) }, '', ''],
    }) : emptyState('magnifying-glass', 'مفيش عميل بالاسم ده', 'جرب جزء من الاسم.', null, true));
  };
  const stats = h('div', { class: 'stats', style: 'margin-bottom:14px' });
  const load = () => loadInto(box, async () => {
    const r = await get('/api/reports/clients', { as_of: asOf, active_only: activeOnly.checked ? '1' : '' });
    all = r.rows;
    totals = r.totals;
    fill(stats,
      linkStat('لينا عند العملاء', r.totals.owes_us_total, null),
      linkStat('علينا للعملاء (دفعات مقدمة)', r.totals.we_owe_total, null),
      linkStat('الصافي', null, null, { raw: balanceText(r.totals.balance), words: true }),
      linkStat('عدد العملاء', null, null, { raw: String(r.count) }));
    setExport();
    draw();
  });
  q.addEventListener('input', draw);
  activeOnly.addEventListener('change', load);
  fill(main,
    pageHead('ملخص العملاء', 'نفس أعمدة شيت الإكسيل: المدين والخصم والدائن والرصيد، مع آخر دفعة وعمر المديونية.', exportBtn),
    filters(
      field('بحث', q),
      dateFilter('الرصيد لحد', asOf, (v) => { asOf = v || todayISO(); load(); }),
      h('label', { class: 'check-row', style: 'min-height:44px' }, activeOnly, 'العملاء الشغالين بس')),
    stats, box);
  setExport();
  await load();
}

// ---------- أعمار الديون ----------
export async function aging(main, _p, ctx) {
  let asOf = ctx.query.as_of || todayISO();
  const box = h('div', {}, skeleton('table'));
  const load = () => loadInto(box, async () => {
    const r = await get('/api/reports/aging', { as_of: asOf });
    if (!r.rows.length) return emptyState('hourglass-medium', 'مفيش مديونيات مفتوحة', 'كل العملاء خالصين لحد التاريخ ده. أول ما يترحّل شغل من غير دفع هيظهر هنا.', null, true);
    const t = r.totals;
    const bucket = (k, hot = false) => ({ label: r.buckets.find((b) => b.key === k).label, n: true,
      value: (row) => h('span', { class: `money${hot && row[k] ? ' hot' : ''}` }, row[k] ? money(row[k]) : '—'), class: hot ? '' : '' });
    return [
      h('div', { class: 'stats', style: 'margin-bottom:14px' },
        linkStat('أقل من 30 يوم', t.b0_amount, null), linkStat('30 – 60 يوم', t.b30_amount, null),
        linkStat('60 – 90 يوم', t.b60_amount, null), linkStat('أكتر من 90 يوم', t.b90_amount, null, { kind: t.b90_amount ? 'bad' : '' })),
      dataTable([
        { label: 'العميل', value: (row) => h('b', {}, row.name) },
        bucket('b0_amount'), bucket('b30_amount'), bucket('b60_amount'), bucket('b90_amount', true),
        { label: 'دفعات مقدمة', n: true, value: (row) => moneyCell(row.advance_amount) },
        { label: 'الرصيد', value: (row) => balanceCell(row.balance) },
        { label: 'أقدم شغل مفتوح', value: (row) => (row.oldest_open_date ? h('span', { class: 'num' }, `${fmtDate(row.oldest_open_date)} (${daysText(row.debt_age_days)})`) : '—') },
      ], r.rows, {
        onRow: (row) => ctx.go(statementHref(row.id)),
        foot: [{ value: 'الإجمالي' }, { n: true, value: money(t.b0_amount) }, { n: true, value: money(t.b30_amount) }, { n: true, value: money(t.b60_amount) },
          { n: true, value: money(t.b90_amount) }, { n: true, value: money(t.advance_amount) }, { value: balanceCell(t.balance) }, ''],
      }),
      h('p', { class: 'small muted' }, 'الدفعات والخصومات بتتخصم من أقدم شغل الأول (الأقدم فالأحدث). العمر = الأيام من تاريخ الشغل لحد تاريخ التقرير.'),
    ];
  });
  fill(main,
    pageHead('أعمار الديون', 'المديونية المفتوحة على كل عميل متقسمة بعمرها.'),
    filters(dateFilter('لحد تاريخ', asOf, (v) => { asOf = v || todayISO(); load(); })),
    box);
  await load();
}

// ---------- مكسب الشهر ----------
export async function monthProfit(main, _p, ctx) {
  let month = ctx.query.month || todayISO().slice(0, 7);
  const box = h('div', {}, skeleton('table'));
  const load = () => loadInto(box, async () => {
    const r = await get('/api/reports/profit', { month, months: 6 });
    const nothing = !r.revenue_total && !r.expenses_total && !r.materials_total && !r.discount_total && !r.over_short_total;
    const revenue = h('div', { class: 'card' }, cardHead('الإيرادات'),
      h('div', { class: 'rp-lines' }, r.revenue.filter((x) => x.line_amount).map((x) => line(x.label, x.line_amount, null)),
        !r.revenue.some((x) => x.line_amount) ? h('div', { class: 'small muted', style: 'padding:8px 0' }, 'مفيش شغل مترحّل الشهر ده.') : null,
        line('إجمالي الإيرادات', r.revenue_total, null, { kind: 'total' })));
    const costs = h('div', { class: 'card' }, cardHead('الخصومات والمصروفات'),
      h('div', { class: 'rp-lines' },
        r.discount_total ? line('خصم مسموح به', r.discount_total, null) : null,
        r.expenses.map((e) => line(e.label, e.line_amount, ctx.can('expenses.record') ? `#/expenses${qs({ category_id: e.category_id, month })}` : null)),
        r.materials_total ? line('مشتريات خامات', r.materials_total, null) : null,
        r.over_short_total ? line('فروق جرد الخزينة', r.over_short_total, '#/treasury/count') : null,
        line('الإجمالي', r.discount_total + r.expenses_total + r.materials_total + r.over_short_total, null, { kind: 'total' })));
    const series = r.series;
    return [
      h('div', { class: 'stats', style: 'margin-bottom:14px' },
        linkStat('الإيرادات', r.revenue_total, null),
        linkStat('الخصومات والمصروفات', r.discount_total + r.expenses_total + r.materials_total + r.over_short_total, null),
        linkStat(r.profit_amount >= 0 ? 'المكسب' : 'الخسارة', Math.abs(r.profit_amount), null, { kind: r.profit_amount >= 0 ? 'accent' : 'bad' })),
      nothing ? notice('info', `مفيش حركات في ${r.month_name}. اختار شهر تاني من فوق.`) : h('div', { class: 'rp-two' }, revenue, costs),
      h('div', { class: 'card', style: 'margin-top:14px' }, cardHead('مقارنة بالشهور اللي فاتت'),
        bars(series.map((s) => ({ label: s.month_name, value: s.profit_amount, on: s.month === r.month,
          text: `${s.profit_amount < 0 ? 'خسارة ' : ''}${money(Math.abs(s.profit_amount))}` })), { label: 'المكسب في آخر 6 شهور' }),
        h('p', { class: 'small muted', style: 'margin:10px 0 0' }, 'المكسب = الإيرادات − الخصومات − المصروفات − مشتريات الخامات. الأحمر خسارة.')),
    ];
  });
  fill(main,
    pageHead('مكسب الشهر', 'الإيرادات بالقسم ناقص الخصومات والمصروفات بالبند ومشتريات الخامات.'),
    filters(dateFilter('الشهر', month, (v) => { if (v) { month = v; load(); } }, { type: 'month' })),
    box);
  await load();
}

// ---------- التدفق المتوقع ----------
export async function cashflow(main, _p, ctx) {
  let asOf = ctx.query.as_of || todayISO();
  const box = h('div', {}, skeleton('table'));
  const load = () => loadInto(box, async () => {
    const r = await get('/api/reports/cashflow', { as_of: asOf });
    const week = (w) => h('div', { class: `card rp-week${w.negative ? ' negative' : ''}` },
      cardHead(`الأسبوع ${w.index}`, h('span', { class: 'small muted num' }, `${fmtDate(w.from)} – ${fmtDate(w.to)}`)),
      w.items.length
        ? h('div', { class: 'rp-lines' }, w.items.map((i) => line(i.label, i.in_amount ?? i.out_amount, i.href, {
          ic: i.in_amount ? 'arrow-left' : 'arrow-right',
          extra: h('span', { class: 'small muted' }, fmtDate(i.date), i.late ? [' ', pill('danger', 'ميعاده عدّى')] : null),
          raw: i.in_amount ? `+${money(i.in_amount)}` : `−${money(i.out_amount)}`,
        })))
        : h('div', { class: 'small muted', style: 'padding:8px 0' }, 'مفيش حركات متوقعة.'),
      h('div', { class: 'rp-lines' },
        line('داخل', w.in_amount, null, { kind: 'total' }), line('خارج', w.out_amount, null)),
      h('div', { class: 'run' }, h('span', {}, 'الرصيد المتوقع في آخر الأسبوع'),
        h('span', { class: `money${w.negative ? ' hot' : ''}` }, money(w.running_balance))));
    return [
      r.first_negative_week ? notice('danger', `الرصيد المتوقع هيبقى بالسالب في الأسبوع ${r.first_negative_week}. حصّل شيكات أو أجّل مصروفات قبل الميعاد ده.`) : null,
      h('div', { class: 'stats', style: 'margin:14px 0' },
        linkStat('الخزينة النهارده', r.cash_balance, '#/treasury'),
        linkStat('البنك النهارده', r.bank_balance, '#/treasury'),
        linkStat('داخل في 4 أسابيع', r.in_total, '#/cheques/in'),
        linkStat('خارج في 4 أسابيع', r.out_total, '#/cheques/out'),
        linkStat('الرصيد المتوقع في الآخر', r.closing_balance, null, { kind: r.closing_balance < 0 ? 'bad' : 'accent' })),
      h('div', { class: 'rp-two' }, r.weeks.map(week)),
      h('p', { class: 'small muted' }, 'الداخل: شيكات العملاء اللي في الحافظة بميعاد استحقاقها. الخارج: شيكاتنا اللي لسه ما اتصرفتش والمصروفات المتكررة من الخزينة أو البنك. الشيكات اللي ميعادها عدّى بتتحسب في الأسبوع الأول.'),
    ];
  });
  fill(main,
    pageHead('التدفق المتوقع', 'الفلوس الجاية والخارجة في الأربع أسابيع الجاية، والرصيد بعد كل أسبوع.'),
    filters(dateFilter('من يوم', asOf, (v) => { asOf = v || todayISO(); load(); })),
    box);
  await load();
}

// ---------- جاري الشركاء ----------
export async function partnersReport(main, _p, ctx) {
  const box = h('div', {}, skeleton('table'));
  fill(main, pageHead('جاري الشركاء', 'اللي دفعه كل شريك واللي أخده، والصافي المستحق ليه أو عليه.'), box);
  await loadInto(box, async () => {
    const r = await get('/api/reports/partners');
    if (!r.rows.length) {
      return emptyState('handshake', 'لسه مفيش شركاء', 'ضيف الشركاء من الأطراف ← الشركاء، وبعدين سجّل تغذية أو مسحوبات.',
        button('الشركاء', { kind: 'primary', href: '#/partners', icon: 'handshake' }));
    }
    const t = r.totals;
    return [
      h('div', { class: 'stats', style: 'margin-bottom:14px' },
        linkStat('دفعوه (دائن)', t.paid_total, null), linkStat('أخدوه (مدين)', t.taken_total, null),
        linkStat('الصافي', null, null, { raw: balanceText(t.balance), words: true })),
      dataTable([
        { label: 'الشريك', value: (row) => h('b', {}, row.name) },
        { label: 'دائن (ما دفعه)', n: true, value: (row) => moneyCell(row.paid_total) },
        { label: 'مدين (ما أخده)', n: true, value: (row) => moneyCell(row.taken_total) },
        { label: 'صافي المستحق', value: (row) => balanceCell(row.balance) },
        { label: 'آخر حركة', value: (row) => h('span', { class: 'num' }, row.last_date ? fmtDate(row.last_date) : '—') },
      ], r.rows, {
        onRow: (row) => ctx.go(`#/parties/${row.id}/statement`),
        foot: [{ value: 'الإجمالي' }, { n: true, value: money(t.paid_total) }, { n: true, value: money(t.taken_total) }, { value: balanceCell(t.balance) }, ''],
      }),
      h('p', { class: 'small muted' }, '«له عندنا» = الشريك دافع أكتر من اللي أخده. الحركات الملغية مش داخلة في الأعمدة.'),
    ];
  });
}
