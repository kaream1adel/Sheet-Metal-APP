// الأطراف: العملاء، الموردين، الشركاء، العمال — lists (with balances for money users), create /
// edit (aliases, similar-name check), and the party file with its tabs. The client file's tabs
// come from the modules: شيت التسعير (pricing), أوامر الشغل (operations), المتابعة (reports).
import { h, fill, icon, button, pageHead, backLink, emptyState, skeleton, formModal, confirmModal, toast,
  dataTable, balanceCell, money, tabs, pill, fold, todayISO, notice } from './ui.js';
import { get, post, patch } from './api.js';
import { renderStatement } from './statement.js';
import { clientPricingSheetTab } from './modules/pricing.js';
import { clientWorkOrdersTab } from './modules/operations.js';
import { clientFollowUpsTab } from './modules/reports.js';

export const KIND = {
  client: { one: 'عميل', many: 'العملاء', list: '#/clients', icon: 'users-three', sub: 'كل عميل باسم واحد، والأسماء التانية اللي بيتكتب بيها.' },
  supplier: { one: 'مورد', many: 'الموردين', list: '#/suppliers', icon: 'truck', sub: 'موردين الخامات والخدمات وحساب كل واحد.' },
  partner: { one: 'شريك', many: 'الشركاء', list: '#/partners', icon: 'handshake', sub: 'جاري الشركاء: اللي دفعوه واللي أخدوه.' },
  worker: { one: 'عامل', many: 'العمال', list: '#/workers', icon: 'hard-hat', sub: 'العمال وسلفهم.' },
};
const EDIT = {
  client: ['operations.record', 'workorders', 'money.post', 'pricing'],
  supplier: ['money.post', 'treasury', 'expenses.record'],
  worker: ['money.post', 'treasury', 'expenses.record'],
  partner: ['money.post'],
};
export const partyHref = (p) => (p.kind === 'client' ? `#/clients/${p.id}` : `#/parties/${p.id}`);
const mayEdit = (ctx, kind) => ctx.canAny(...EDIT[kind]);

// ---------- list ----------
export async function partyList(main, kind, ctx) {
  const k = KIND[kind];
  const money_ = ctx.can('money.view');
  const q = h('input', { type: 'search', placeholder: `دوّر على ${k.one}…`, value: ctx.query.q || '', 'aria-label': 'بحث' });
  const inactive = h('input', { type: 'checkbox' });
  const box = h('div', {}, skeleton('table'));
  let all = [];

  const draw = () => {
    const f = fold(q.value);
    const rows = f ? all.filter((p) => [p.name, ...p.aliases].some((n) => fold(n).includes(f))) : all;
    if (!all.length) {
      return fill(box, emptyState(k.icon, `لسه مفيش ${k.many}`, kind === 'client'
        ? 'العملاء بيتضافوا من هنا أو وإنت بتكتب ورقة تشغيل.' : `ضيف أول ${k.one} عشان تسجل حسابه.`,
      mayEdit(ctx, kind) ? button(`${k.one} جديد`, { kind: 'primary', icon: 'user-plus', onClick: () => create() }) : null));
    }
    const cols = [
      { label: 'الاسم', value: (p) => h('div', {}, h('b', {}, p.name), p.is_walk_in ? [' ', pill('neutral', 'خارجي')] : null, !p.active ? [' ', pill('neutral', 'موقوف')] : null,
        p.aliases.length ? h('div', { class: 'small muted' }, p.aliases.join('، ')) : null) },
      { label: 'التليفون', value: (p) => h('span', { class: 'num' }, p.phone || '') },
    ];
    if (money_) cols.push({ label: 'الرصيد', value: (p) => balanceCell(p.balance) });
    fill(box, rows.length ? dataTable(cols, rows, { onRow: (p) => ctx.go(partyHref(p)), rowClass: (p) => (p.active ? '' : 'muted-row') })
      : emptyState('magnifying-glass', 'مفيش نتيجة', `مفيش ${k.one} بالاسم ده. جرب جزء من الاسم.`, null, true));
  };

  const load = async () => {
    const r = await get('/api/parties', { kind, include_inactive: inactive.checked ? '1' : '' });
    all = r.parties;
    totals.replaceChildren(...(money_ && r.totals ? [
      h('div', { class: 'stat' }, h('span', {}, kind === 'client' ? 'لينا عند العملاء' : 'لينا عندهم'), h('b', { class: 'money' }, money(r.totals.owes_us))),
      h('div', { class: 'stat' }, h('span', {}, kind === 'client' ? 'علينا للعملاء' : 'علينا ليهم'), h('b', { class: 'money' }, money(r.totals.we_owe))),
    ] : []));
    draw();
  };
  const totals = h('div', { class: 'stats', style: 'margin-bottom:14px' });
  q.addEventListener('input', draw);
  inactive.addEventListener('change', load);

  const create = async () => {
    const p = await partyForm(kind, null, ctx);
    if (p) { toast(`اتضاف ${p.name}`); ctx.go(partyHref(p)); }
  };

  fill(main,
    pageHead(k.many, k.sub, mayEdit(ctx, kind) ? button(`${k.one} جديد`, { kind: 'primary', icon: 'user-plus', onClick: create }) : null),
    totals,
    h('div', { class: 'row', style: 'margin-bottom:12px' }, h('div', { class: 'search' }, icon('magnifying-glass'), q),
      h('label', { class: 'check-row' }, inactive, 'وريني الموقوفين')),
    box);
  await load();
}

// ---------- create / edit ----------
// Resolves to the saved party, or null. A similar existing name asks once ("ده نفس العميل؟").
export async function partyForm(kind, party, ctx) {
  const k = KIND[kind];
  const moneyPost = ctx.can('money.post');
  const fields = [
    { name: 'name', label: 'الاسم', value: party?.name || '', wide: true },
    { name: 'aliases', label: 'أسماء تانية بيتكتب بيها (افصل بفاصلة)', value: (party?.aliases || []).join('، '), wide: true,
      help: 'زي ما الفني بيكتبه على الورق. البرنامج هيعرفه بيها.' },
    { name: 'phone', label: 'التليفون', value: party?.phone || '' },
  ];
  if (kind === 'client') fields.push({ name: 'is_walk_in', label: 'عميل خارجي (مش بيتعامل على حساب)', type: 'checkbox', value: party?.is_walk_in });
  if (moneyPost && ctx.can('money.view') && kind === 'client') fields.push({ name: 'credit_limit', label: 'حد الائتمان (اختياري)', type: 'money', value: party?.credit_limit != null ? party.credit_limit / 1000 : '' });
  if (!party && moneyPost) {
    fields.push({ name: 'opening_balance', label: 'رصيد أول المدة (اختياري)', type: 'money', help: 'موجب = لنا عنده، سالب = له عندنا' });
    fields.push({ name: 'opening_date', label: 'تاريخ رصيد أول المدة', type: 'date', value: todayISO() });
  }
  fields.push({ name: 'notes', label: 'ملاحظات', type: 'textarea', value: party?.notes || '', wide: true });
  if (party) fields.push({ name: 'active', label: 'شغال (شيل العلامة عشان توقفه)', type: 'checkbox', value: party.active });

  return formModal({
    title: party ? `تعديل ${party.name}` : `${k.one} جديد`, fields, submitLabel: party ? 'حفظ التعديل' : `ضيف ال${k.one}`,
    onSubmit: async (v) => {
      const body = { ...v, kind };
      if (!body.opening_balance) { delete body.opening_balance; delete body.opening_date; }
      const send = (force) => (party ? patch(`/api/parties/${party.id}`, { ...body, force }) : post('/api/parties', { ...body, force }));
      try {
        return (await send(false)).party;
      } catch (ex) {
        if (ex.status === 409 && ex.data.similar?.length) {
          const names = ex.data.similar.map((s) => s.name).join('، ');
          const ok = await confirmModal('في اسم قريب', `في ${k.one} متسجل باسم قريب: ${names}. لو ده نفس ال${k.one} ضيف الاسم ده كاسم تاني ليه بدل ما تعمل واحد جديد. تكمل وتعمله ${k.one} جديد؟`, 'أيوه، واحد جديد');
          if (ok) return (await send(true)).party;
          throw new Error('اتلغى — ضيف الاسم كاسم تاني للموجود');
        }
        if (ex.status === 409 && ex.data.existing) ex.data.field = 'name';
        throw ex;
      }
    },
  });
}

// ---------- the party file ----------
export async function partyPage(main, id, tab, ctx) {
  const { party } = await get(`/api/parties/${id}`);
  const k = KIND[party.kind];
  const isClient = party.kind === 'client';
  const href = (t) => `${partyHref(party)}/${t}`;
  const TABS = isClient ? [
    { key: 'pricing', label: 'شيت التسعير', icon: 'table' },
    { key: 'statement', label: 'كشف الحساب', icon: 'notebook' },
    { key: 'orders', label: 'أوامر الشغل', icon: 'clipboard-text' },
    { key: 'followup', label: 'المتابعة', icon: 'phone' },
    { key: 'info', label: 'البيانات', icon: 'identification-card' },
  ] : [
    { key: 'statement', label: 'كشف الحساب', icon: 'notebook' },
    { key: 'info', label: 'البيانات', icon: 'identification-card' },
  ];
  const visible = TABS.filter((t) => !(t.key === 'followup' && !ctx.can('reports')) && !(t.key === 'orders' && !ctx.can('workorders'))
    && !(t.key === 'statement' && !isClient && !ctx.can('money.view')));
  const current = visible.some((t) => t.key === tab) ? tab : visible[0].key;
  const box = h('div', {}, skeleton());

  const edit = async () => {
    const p = await partyForm(party.kind, party, ctx);
    if (p) { toast('اتحفظ'); ctx.refresh(); }
  };

  fill(main,
    backLink(k.list, k.many),
    pageHead(party.name,
      h('span', { class: 'row', style: 'gap:10px' }, pill('accent', k.one),
        party.aliases.length ? h('span', {}, `بيتكتب كمان: ${party.aliases.join('، ')}`) : null,
        'balance' in party ? h('span', {}, balanceCell(party.balance)) : null,
        !party.active ? pill('neutral', 'موقوف') : null),
      isClient && ctx.can('treasury') ? button('إيصال استلام', { icon: 'hand-coins', href: `#/treasury/receipt?party=${party.id}` }) : null,
      mayEdit(ctx, party.kind) ? button('تعديل', { icon: 'pencil-simple', onClick: edit }) : null),
    tabs(visible.map((t) => ({ ...t, href: href(t.key) })), current),
    box);

  if (current === 'statement') return renderStatement(box, party.id, { title: 'كشف حساب', can: ctx.can });
  if (current === 'pricing') return clientPricingSheetTab(box, party, ctx);
  if (current === 'orders') return clientWorkOrdersTab(box, party, ctx);
  if (current === 'followup') return clientFollowUpsTab(box, party, ctx);
  return fill(box, infoCard(party, ctx, edit));
}

function infoCard(party, ctx, edit) {
  const row = (label, value) => (value ? h('tr', {}, h('th', { style: 'width:180px' }, label), h('td', {}, value)) : null);
  return h('div', { class: 'grid' },
    h('div', { class: 'table-wrap' }, h('table', {}, h('tbody', {},
      row('الاسم', party.name),
      row('الأسماء التانية', party.aliases.join('، ') || '—'),
      row('التليفون', h('span', { class: 'num' }, party.phone || '—')),
      party.kind === 'client' ? row('النوع', party.is_walk_in ? 'عميل خارجي' : 'عميل على حساب') : null,
      'credit_limit' in party && party.credit_limit != null ? row('حد الائتمان', h('span', { class: 'money' }, money(party.credit_limit))) : null,
      row('ملاحظات', party.notes || '—'),
      row('الحالة', party.active ? 'شغال' : 'موقوف')))),
    !ctx.can('money.view') ? notice('info', 'الأرصدة والمبالغ بتظهر للأدمن بس.') : null,
    mayEdit(ctx, party.kind) ? h('div', {}, button('تعديل البيانات', { icon: 'pencil-simple', onClick: edit })) : null);
}
