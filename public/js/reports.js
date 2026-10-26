// الإنتاج, التقارير (balances + income), the technician profile, and the settings
// cards for machines/materials and the audit log.
import { h, toast, money, fmtDate, fmtNum, todayISO, formModal, fill } from './ui.js';
import { get, post, patch } from './api.js';
import { can, state, loadLookups } from './app.js';

const daysAgo = (n) => todayISO(new Date(Date.now() - n * 86400000));
const FIELD = {
  thickness: 'السمك', pieces: 'عدد القطع', ops_per_piece: 'العمليات للقطعة', total_written: 'الإجمالي', sheets: 'عدد الألواح',
  minutes_per_sheet: 'دقائق للوح', pieces_per_sheet: 'قطع من اللوح', hits_per_piece: 'ضربات للقطعة', louvers_per_piece: 'لوفر للقطعة',
  minutes: 'دقائق', work_date: 'التاريخ', sheet_size: 'مقاس اللوح', client_id: 'العميل', material_id: 'الخامة',
};
// What each machine's work is counted in.
const MEASURES = {
  press: [['pieces', 'قطعة'], ['ops', 'تنية']],
  shear: [['pieces', 'قطعة'], ['ops', 'قصة']],
  laser: [['sheets', 'لوح'], ['minutes', 'دقيقة']],
  punch: [['sheets', 'لوح'], ['pieces', 'قطعة'], ['hits', 'ضربة'], ['louvers', 'لوفر'], ['minutes', 'دقيقة']],
};
const periodName = (p, group) => (group === 'month' ? p : group === 'week' ? `أسبوع ${fmtDate(p)}` : fmtDate(p));

function productionTables(rows, group, { byTech = true } = {}) {
  const machines = [...new Map(rows.map((r) => [r.machine_code, r.machine_name])).entries()];
  if (!machines.length) return h('div', { class: 'card muted' }, 'مفيش شغل متأكد في الفترة دي.');
  return machines.map(([code, name]) => {
    const ms = MEASURES[code] || [['pieces', 'قطعة']];
    const mine = rows.filter((r) => r.machine_code === code);
    const total = Object.fromEntries(ms.map(([k]) => [k, mine.reduce((s, r) => s + (r[k] || 0), 0)]));
    return h('div', { style: 'margin-bottom:16px' },
      h('h2', {}, name, h('span', { class: 'small muted' }, `  —  ${ms.map(([k, u]) => `${fmtNum(total[k])} ${u}`).join(' · ')}`)),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, group === 'month' ? 'الشهر' : group === 'week' ? 'الأسبوع' : 'اليوم'),
          byTech ? h('th', {}, 'الفني') : null, h('th', {}, 'سطور'), ms.map(([, u]) => h('th', { class: 'num' }, u)))),
        h('tbody', {}, mine.map((r) => h('tr', {},
          h('td', {}, periodName(r.period, group)),
          byTech ? h('td', {}, r.technician_id ? h('a', { href: `#/technicians/${r.technician_id}` }, r.technician_name) : '—') : null,
          h('td', { class: 'num' }, r.lines), ms.map(([k]) => h('td', { class: 'num' }, fmtNum(r[k])))))))));
  });
}

// ---------- الإنتاج ----------
export async function renderProduction(main) {
  const f = { from: daysAgo(6), to: todayISO(), group: 'day', technician: '', machine: '' };
  const box = h('div');
  const load = async () => {
    const q = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
    const { rows } = await get(`/api/production?${q}`);
    fill(box, productionTables(rows, f.group));
  };
  const input = (k, type = 'date') => h('input', { type, value: f[k], onchange: (e) => { f[k] = e.target.value; load(); } });
  const sel = (k, opts) => h('select', { onchange: (e) => { f[k] = e.target.value; load(); } }, opts.map(([v, l]) => h('option', { value: v, selected: f[k] === v }, l)));
  main.replaceChildren(
    h('div', { class: 'top' }, h('h1', {}, 'الإنتاج')),
    h('div', { class: 'row', style: 'margin-bottom:12px' },
      h('label', {}, 'من'), input('from'), h('label', {}, 'لـ'), input('to'),
      sel('group', [['day', 'باليوم'], ['week', 'بالأسبوع'], ['month', 'بالشهر']]),
      sel('technician', [['', 'كل الفنيين'], ...state.lookups.technicians.map((t) => [String(t.id), t.name])]),
      sel('machine', [['', 'كل المكن'], ...state.lookups.machines.map((m) => [String(m.id), m.name])])),
    h('div', { class: 'small muted', style: 'margin-bottom:12px' }, 'الورق المتأكد بس. الأسبوع بيبدأ يوم السبت.'),
    box);
  await load();
}

// ---------- الفني ----------
export async function renderTechnicianProfile(main, id) {
  const p = await get(`/api/technicians/${id}/profile`);
  const t = p.technician;
  const MISTAKE = { mismatch: 'الإجمالي مش مظبوط', high: 'رقم كبير مش عادي', future: 'تاريخ في المستقبل', foreign: 'كتب في عمود غلط',
    zero: 'كتب صفر', neg: 'رقم بالسالب', nan: 'رقم مش مفهوم', invalid: 'تاريخ غلط' };
  const list = (items, empty) => (items.length ? h('div', { class: 'grid', style: 'gap:4px' }, items.map((x) => h('div', { class: 'row', style: 'justify-content:space-between' },
    h('span', {}, x.name), h('span', { class: 'muted small num' }, `${x.lines} سطر`)))) : h('div', { class: 'muted' }, empty));
  fill(main,
    h('div', { class: 'top' }, h('h1', {}, t.name), h('a', { class: 'btn', href: '#/technicians' }, 'رجوع للفنيين')),
    h('div', { class: 'small muted', style: 'margin-bottom:12px' },
      `آخر 6 شهور (من ${fmtDate(p.since)}) · ${p.sheets} ورقة · ${p.lines} سطر · بيكتب الأرقام ${t.digit_system === 'arabic' ? 'عربي ١٢٣' : 'إنجليزي 123'}`),
    h('div', { class: 'grid stats' },
      h('div', { class: 'stat' }, h('b', {}, `${Math.round(p.ditto_share * 100)}%`), h('span', {}, 'من سطوره فيها ~ أو //')),
      h('div', { class: 'stat' }, h('b', {}, p.reading.reads ? `${Math.round((p.reading.correct / p.reading.reads) * 100)}%` : '—'),
        h('span', {}, `البرنامج بيقرا خطه صح (${p.reading.reads} خانة)`)),
      h('div', { class: 'stat' }, h('b', {}, p.reading.samples), h('span', {}, 'مثال من خطه اتعلمه البرنامج'))),
    h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(260px,1fr));margin-top:12px' },
      h('div', { class: 'card grid' }, h('h2', {}, 'عملاؤه المعتادين'), list(p.clients, 'لسه مفيش')),
      h('div', { class: 'card grid' }, h('h2', {}, 'الخامات'), list(p.materials, 'لسه مفيش')),
      h('div', { class: 'card grid' }, h('h2', {}, 'أكتر حاجات بتتصلح في ورقه'),
        p.mistakes.length ? p.mistakes.map((m) => h('div', { class: 'row', style: 'justify-content:space-between' },
          h('span', {}, `${MISTAKE[m.code] || m.code} — ${FIELD[m.field] || m.field}`), h('b', { class: 'num' }, m.n)))
          : h('div', { class: 'muted' }, 'مفيش غلطات اتسجلت. 👍'),
        h('div', { class: 'small muted' }, 'اللي لقاه البرنامج في الورق قبل ما يتصلح في المراجعة. مفيد عشان تكلم الفني أو تعدل الورقة.'))),
    h('h2', { style: 'margin-top:16px' }, 'أرقامه المعتادة'),
    Object.keys(p.ranges).length === 0 ? h('div', { class: 'card muted' }, 'محتاج 3 سطور على الأقل.') :
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['الخانة', 'أقل عادي', 'الغالب', 'أكبر عادي', 'من كام سطر'].map((x) => h('th', {}, x)))),
        h('tbody', {}, Object.entries(p.ranges).map(([f, r]) => h('tr', {}, h('td', {}, FIELD[f] || f),
          h('td', { class: 'num' }, fmtNum(r.low)), h('td', { class: 'num' }, fmtNum(r.usual)), h('td', { class: 'num' }, fmtNum(r.high)), h('td', { class: 'num' }, r.count)))))),
    h('h2', { style: 'margin-top:16px' }, 'إنتاجه آخر 30 يوم'),
    productionTables(p.production, 'month', { byTech: false }));
}

// ---------- التقارير (admin) ----------
export async function renderReports(main) {
  const f = { from: `${todayISO().slice(0, 4)}-01-01`, to: todayISO() };
  const incomeBox = h('div');
  const loadIncome = async () => {
    const r = await get(`/api/reports/income?from=${f.from}&to=${f.to}`);
    fill(incomeBox,
      h('div', { class: 'grid stats' },
        [['شغل اتحاسب', r.totals.work], ['إضافات', r.totals.additions], ['خصومات', r.totals.discounts], ['فلوس اتقبضت', r.totals.received], ['شيكات تحت التحصيل', r.cheques_pending]]
          .map(([l, v]) => h('div', { class: 'stat' }, h('b', { class: 'num' }, money(v)), h('span', {}, l)))),
      r.rows.length ? h('div', { class: 'table-wrap', style: 'margin-top:10px' }, h('table', {},
        h('thead', {}, h('tr', {}, ['الشهر', 'شغل', 'إضافات', 'خصومات', 'اتقبض'].map((x) => h('th', {}, x)))),
        h('tbody', {}, r.rows.map((m) => h('tr', {}, h('td', { class: 'num' }, m.month),
          ['work', 'additions', 'discounts', 'received'].map((k) => h('td', { class: 'num' }, money(m[k])))))))) : null);
  };
  const { clients, outstanding } = await get('/api/reports/balances');
  const owing = clients.filter((c) => c.balance !== 0).sort((a, b) => b.balance - a.balance);
  main.replaceChildren(
    h('div', { class: 'top' }, h('h1', {}, 'التقارير')),
    h('h2', {}, 'الدخل'),
    h('div', { class: 'row', style: 'margin-bottom:10px' },
      h('label', {}, 'من'), h('input', { type: 'date', value: f.from, onchange: (e) => { f.from = e.target.value; loadIncome(); } }),
      h('label', {}, 'لـ'), h('input', { type: 'date', value: f.to, onchange: (e) => { f.to = e.target.value; loadIncome(); } })),
    incomeBox,
    h('h2', { style: 'margin-top:20px' }, 'أرصدة العملاء ', h('span', { class: 'small muted' }, `— برة عند العملاء ${money(outstanding)}`)),
    owing.length === 0 ? h('div', { class: 'card muted' }, 'كل الأرصدة صفر.') : h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['العميل', 'الرصيد', 'آخر دفعة', 'أقدم شغل مش مدفوع'].map((x) => h('th', {}, x)))),
      h('tbody', {}, owing.map((c) => h('tr', { class: 'click', onclick: () => { location.hash = `#/clients/${c.id}`; } },
        h('td', {}, c.name),
        h('td', { class: `num ${c.balance > 0 ? 'owe-t' : ''}` }, `${money(Math.abs(c.balance))} ${c.balance > 0 ? 'عليه' : 'له'}`),
        h('td', {}, c.last_payment_date ? `${fmtDate(c.last_payment_date)} (${money(c.last_payment_amount)})` : '—'),
        h('td', {}, c.oldest_days !== null ? `${c.oldest_days} يوم` : '—')))))));
  await loadIncome();
}

// ---------- settings cards ----------
export async function machinesCard() {
  if (!can('machines.edit')) return null;
  const card = h('div', { class: 'card grid' });
  const load = async () => {
    const [{ machines }, { materials }] = await Promise.all([get('/api/machines'), get('/api/materials')]);
    const editMaterial = async (m) => {
      const ok = await formModal({
        title: m ? `تعديل ${m.name}` : 'خامة جديدة',
        fields: [
          { name: 'name', label: 'الاسم', value: m?.name },
          { name: 'aliases', label: 'طرق تانية بيكتبوها بيها (افصل بفصلة)', value: m?.aliases.join('، ') || '' },
          { name: 'density', label: 'الكثافة (جم/سم³) — للوزن', value: m?.density ?? '' },
          ...(m ? [{ name: 'active', label: 'مستخدمة', type: 'checkbox', value: m.active }] : []),
        ],
        onSubmit: (v) => (m ? patch(`/api/materials/${m.id}`, v) : post('/api/materials', v)),
      });
      if (ok) { toast('اتحفظ'); await loadLookups(); load(); }
    };
    const editMachine = async (m) => {
      const ok = await formModal({
        title: `تعديل ${m.name}`,
        fields: [{ name: 'name', label: 'الاسم', value: m.name }, { name: 'active', label: 'شغالة', type: 'checkbox', value: m.active }],
        onSubmit: (v) => patch(`/api/machines/${m.id}`, v),
      });
      if (ok) { toast('اتحفظ'); await loadLookups(); load(); }
    };
    fill(card,
      h('h2', {}, 'المكن والخامات'),
      h('div', { class: 'row' }, machines.map((m) => h('button', { class: `btn sm${m.active ? '' : ' danger'}`, onclick: () => editMachine(m) }, m.name))),
      h('div', { class: 'row' }, materials.map((m) => h('button', { class: 'btn sm', style: m.active ? '' : 'opacity:.5', title: m.aliases.join('، '), onclick: () => editMaterial(m) }, m.name)),
        h('button', { class: 'btn sm primary', onclick: () => editMaterial(null) }, '+ خامة')));
  };
  await load();
  return card;
}

const ACTION = { create: 'إضافة', update: 'تعديل', confirm: 'تأكيد', cancel: 'إلغاء', discard: 'مسح', fix: 'تصحيح', read: 'قراءة آلية',
  photo: 'صورة جديدة', lesson: 'درس', teach: 'تعليم', forget: 'نسيان', backup: 'نسخة احتياطية', restore: 'استرجاع', update_app: 'تحديث',
  rollback: 'رجوع لنسخة', print: 'طباعة', void: 'إلغاء رقم', login: 'دخول', lockout: 'قفل حساب', setup: 'تجهيز' };
const ENTITY = { sheet: 'ورقة', line: 'سطر', client: 'عميل', technician: 'فني', user: 'مستخدم', payment: 'دفعة', settings: 'الإعدادات',
  backup: 'نسخة', app: 'البرنامج', material: 'خامة', machine: 'مكنة', printed_sheets: 'ورق مطبوع', delivery: 'تسليم', adjustment: 'تسوية', promise: 'وعد' };

export async function auditCard() {
  const { audit } = await get('/api/audit');
  const short = (j) => (j ? j.replace(/\bnull\b/g, '—').replace(/[{}"]/g, ' ').replace(/\s+/g, ' ').slice(0, 140) : '');
  return h('div', { class: 'card grid' },
    h('h2', {}, 'سجل التعديلات (آخر 200)'),
    h('div', { class: 'table-wrap', style: 'max-height:360px;overflow:auto' }, h('table', {},
      h('thead', {}, h('tr', {}, ['الوقت', 'مين', 'إيه', 'التفاصيل'].map((x) => h('th', {}, x)))),
      h('tbody', {}, audit.map((a) => h('tr', {},
        h('td', { class: 'num small' }, a.at.slice(0, 16).replace('T', ' ')),
        h('td', { class: 'small' }, a.user_name || '—'),
        h('td', { class: 'small' }, `${ACTION[a.action] || a.action} ${ENTITY[a.entity] || a.entity}${a.entity_id ? ' #' + a.entity_id : ''}`),
        h('td', { class: 'small muted', style: 'max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', title: `${a.before_json || ''}\n→ ${a.after_json || ''}` },
          short(a.after_json || a.before_json))))))));
}
