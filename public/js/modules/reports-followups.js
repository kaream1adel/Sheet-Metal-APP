// متابعة التحصيل: the due list (#/reports/followups) and the client file's «المتابعة» tab.
import { h, fill, button, pageHead, skeleton, emptyState, notice, pill, fmtDate, balanceCell, money, formModal,
  confirmModal, toast, toastUndo, toastError, tabs, todayISO, loadInto, balanceText } from '../ui.js';
import { get, post, patch, del } from '../api.js';
import { daysText } from './reports-common.js';

const plusDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return todayISO(d); };

function whenPill(f) {
  if (f.done) return pill('ok', `خلصت ${f.done_at ? fmtDate(f.done_at.slice(0, 10)) : ''}`.trim());
  if (!f.next_date) return pill('neutral', 'من غير ميعاد');
  if (f.overdue) return pill('danger', `متأخرة من ${fmtDate(f.next_date)}`);
  if (f.due_today) return pill('warn', 'النهارده');
  return pill('accent', fmtDate(f.next_date));
}

export async function newFollowUp(party = null) {
  let clients = null;
  if (!party) clients = (await get('/api/parties', { kind: 'client' })).parties;
  return formModal({
    title: party ? `متابعة جديدة — ${party.name}` : 'متابعة تحصيل جديدة',
    fields: [
      party ? null : { name: 'party_id', label: 'العميل', type: 'select', options: [['', 'اختار العميل'], ...clients.map((c) => [c.id, c.name])], wide: true },
      { name: 'note', label: 'المتابعة', type: 'textarea', wide: true, placeholder: 'اتكلمت مع مين وقال إيه' },
      { name: 'next_date', label: 'ميعاد المتابعة الجاية', type: 'date', value: plusDays(3) },
    ].filter(Boolean),
    submitLabel: 'سجّل المتابعة',
    onSubmit: async (v) => (await post('/api/reports/followups', { party_id: party ? party.id : v.party_id, note: v.note, next_date: v.next_date })).follow_up,
  });
}

async function complete(f) {
  return formModal({
    title: `خلصت المتابعة — ${f.party_name}`,
    intro: 'لو محتاج تتابع تاني حدد الميعاد الجاي، أو سيبه فاضي.',
    fields: [
      { name: 'note', label: 'حصل إيه', type: 'textarea', wide: true, value: f.note },
      { name: 'next_date', label: 'المتابعة الجاية (اختياري)', type: 'date' },
      { name: 'next_note', label: 'هتتابع على إيه', type: 'text', wide: true, showIf: (v) => !!v.next_date },
    ],
    submitLabel: 'خلصت',
    onSubmit: (v) => post(`/api/reports/followups/${f.id}/done`, v),
  });
}

async function edit(f) {
  return formModal({
    title: `تعديل المتابعة — ${f.party_name}`,
    fields: [
      { name: 'note', label: 'المتابعة', type: 'textarea', wide: true, value: f.note },
      { name: 'next_date', label: 'ميعاد المتابعة الجاية', type: 'date', value: f.next_date || '' },
    ],
    onSubmit: (v) => patch(`/api/reports/followups/${f.id}`, v),
  });
}

async function remove(f, reload) {
  if (!await confirmModal('امسح المتابعة؟', 'المسح للمتابعة اللي اتسجلت بالغلط. لو خلصت اضغط «خلصت» بدل المسح عشان تفضل في التاريخ.', 'امسحها', { danger: true })) return;
  try {
    await del(`/api/reports/followups/${f.id}`);
    reload();
    toastUndo('اتمسحت', async () => {
      try {
        await post('/api/reports/followups', { party_id: f.party_id, note: f.note, next_date: f.next_date });
        toast('رجعت');
        reload();
      } catch (ex) { toastError(ex); }
    });
  } catch (ex) { toastError(ex); }
}

// One follow-up as a row of actions (44px targets on the phone).
function item(f, reload, { showParty = true } = {}) {
  const act = (label, ic, fn, kind = 'ghost') => button(label, { size: 'sm', kind, icon: ic, onClick: async () => { if (await fn()) { toast('اتحفظ'); reload(); } } });
  return h('div', { class: `rp-fu${f.done ? ' done' : ''}` },
    h('div', { class: 'top' },
      h('div', { class: 'row', style: 'gap:8px' },
        showParty ? h('a', { href: `#/clients/${f.party_id}/followup` }, h('b', {}, f.party_name)) : null,
        whenPill(f),
        showParty && 'balance' in f ? balanceCell(f.balance) : null),
      f.done ? null : h('div', { class: 'row', style: 'gap:6px' },
        act('خلصت', 'check', () => complete(f), ''),
        act('تعديل', 'pencil-simple', () => edit(f)),
        button('', { size: 'sm', kind: 'ghost', icon: 'trash', title: 'امسح', onClick: () => remove(f, reload) }))),
    h('div', { class: 'note' }, f.note),
    h('div', { class: 'small muted' }, `${f.created_by_name || ''} · ${fmtDate(String(f.created_at).slice(0, 10))}`,
      f.party_phone && showParty ? [' · ', h('a', { href: `tel:${f.party_phone}`, class: 'num' }, f.party_phone)] : null));
}

// ---------- #/reports/followups ----------
const VIEWS = [
  { key: 'due', label: 'المستحقة النهارده', icon: 'phone' },
  { key: 'open', label: 'كل المفتوحة', icon: 'list-bullets' },
  { key: 'done', label: 'اللي خلصت', icon: 'check-circle' },
];

export async function followUps(main, _p, ctx) {
  let view = VIEWS.some((v) => v.key === ctx.query.view) ? ctx.query.view : 'due';
  const tabBox = h('div');
  const box = h('div', { class: 'card' }, skeleton());
  const add = async () => { if (await newFollowUp()) { toast('اتسجلت المتابعة'); load(); } };
  const load = () => loadInto(box, async () => {
    const r = await get('/api/reports/followups', { status: view });
    if (!r.follow_ups.length) {
      const text = { due: ['مفيش متابعات النهارده', 'كل المتابعات المستحقة خلصت. سجّل متابعة جديدة لما تكلم عميل.'],
        open: ['مفيش متابعات مفتوحة', 'سجّل متابعة لكل عميل عليه فلوس، وحدد ميعاد المكالمة الجاية.'],
        done: ['لسه مفيش متابعات خلصت', 'لما تقفل متابعة هتلاقيها هنا.'] }[view];
      return emptyState('phone', text[0], text[1], view === 'done' ? null : button('متابعة جديدة', { kind: 'primary', icon: 'plus', onClick: add }), true);
    }
    return r.follow_ups.map((f) => item(f, load));
  });
  const drawTabs = () => fill(tabBox, tabs(VIEWS, view, (k) => { view = k; drawTabs(); load(); }));
  fill(main, pageHead('متابعة التحصيل', 'مين محتاج تكلمه النهارده، وإيه اللي اتقال المرة اللي فاتت.',
    button('متابعة جديدة', { kind: 'primary', icon: 'plus', onClick: add })), tabBox, box);
  drawTabs();
  await load();
}

// ---------- the client file's «المتابعة» tab ----------
export async function clientFollowUpsTab(box, party) {
  fill(box, skeleton());
  const list = h('div', { class: 'card' });
  const head = h('div');
  const load = async () => {
    const r = await get('/api/reports/followups', { party_id: party.id, status: 'all' });
    const s = r.summary;
    fill(head, s ? h('div', { class: 'stats', style: 'margin-bottom:14px' },
      h('a', { class: 'stat', href: `#/clients/${party.id}/statement` }, h('span', {}, 'الرصيد'), h('b', {}, balanceText(party.balance ?? 0))),
      h('a', { class: 'stat', href: `#/clients/${party.id}/statement` }, h('span', {}, 'آخر دفعة'),
        h('b', { class: 'money' }, s.last_payment_date ? money(s.last_payment_amount) : 'مفيش'), s.last_payment_date ? h('small', {}, fmtDate(s.last_payment_date)) : null),
      h('a', { class: 'stat', href: '#/reports/aging' }, h('span', {}, 'عمر المديونية'), h('b', {}, daysText(s.debt_age_days)),
        s.oldest_open_date ? h('small', {}, `أقدم شغل مفتوح ${fmtDate(s.oldest_open_date)}`) : null)) : null);
    const open = r.follow_ups.filter((f) => !f.done);
    const done = r.follow_ups.filter((f) => f.done);
    fill(list,
      h('div', { class: 'rp-card-head' }, h('h3', {}, 'المتابعات'), button('متابعة جديدة', { kind: 'primary', size: 'sm', icon: 'plus',
        onClick: async () => { if (await newFollowUp(party)) { toast('اتسجلت المتابعة'); load(); } } })),
      !r.follow_ups.length ? emptyState('phone', 'لسه مفيش متابعة للعميل ده', 'سجّل كل مكالمة أو زيارة تحصيل مع ميعاد المتابعة الجاية، وهتظهر في الرئيسية يوم ميعادها.', null, true) : null,
      open.map((f) => item(f, load, { showParty: false })),
      done.length ? [h('div', { class: 'small muted', style: 'margin-top:14px' }, 'اللي خلصت'), done.map((f) => item(f, load, { showParty: false }))] : null);
  };
  fill(box, head, list);
  try { await load(); } catch (ex) { fill(box, notice('danger', ex.message)); }
}
