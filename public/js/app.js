// Shell, router and the simple screens. The sheet screen lives in sheet.js.
import { h, toast, money, fmtDate, formModal, confirmModal, fill, icon, pageHead, emptyState, skeleton } from './ui.js';
import { get, post, patch } from './api.js';
import { renderSheet } from './sheet.js';
import { renderPricing } from './pricing.js';
import { renderClientPage, renderPayments, renderFollowup, renderSettings } from './accounts.js';
import { renderDeliveries } from './delivery.js';
import { renderShare } from './system.js';
import { renderScan, renderPrintForms, renderReader } from './scan.js';
import { renderProduction, renderReports, renderTechnicianProfile } from './reports.js';
import { renderAccounts } from './books.js';
import { teachPending } from './reader.js';

export const state = { user: null, version: '', lookups: null, homeCounts: null };
export const can = (perm) => !!state.user?.permissions.includes(perm);
const app = document.getElementById('app');

export async function loadLookups() {
  state.lookups = await get('/api/lookups');
  return state.lookups;
}

// ---------- boot ----------
async function boot() {
  const s = await get('/api/session');
  state.version = s.version;
  if (s.needsSetup) return renderSetup();
  if (!s.user) return renderLogin();
  state.user = s.user;
  await loadLookups();
  route();
  // Reviewed photo sheets the reader hasn't learned from yet: learn them quietly.
  if (can('sheets.review')) setTimeout(() => teachPending().catch(() => {}), 4000);
  const after = sessionStorage.getItem('after-restart');
  if (after) { sessionStorage.removeItem('after-restart'); toast(after); }
}
window.addEventListener('hashchange', () => state.user && route());
window.addEventListener('signed-out', () => { state.user = null; renderLogin(); });

// ---------- auth screens ----------
function authCard(title, subtitle, fields, button, onSubmit) {
  const err = h('div', { class: 'err' });
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      const values = Object.fromEntries(new FormData(form));
      try { await onSubmit(values); } catch (ex) { err.textContent = ex.message; }
    },
  }, fields, err, h('button', { class: 'btn primary', type: 'submit' }, button));
  app.replaceChildren(h('div', { class: 'auth' },
    h('div', { class: 'pane' }, h('div', { class: 'card' },
      h('div', { class: 'brand', style: 'padding:0 0 22px' }, h('div', { class: 'logo' }, icon('factory', 'lg')),
        h('div', {}, h('b', {}, 'Sheet Metal'), h('span', {}, 'شركة الصفا'))),
      h('h1', {}, title), h('div', { class: 'muted' }, subtitle), form)),
    h('div', { class: 'art' },
      h('b', {}, 'ورق الورشة، من الصورة للحساب.'),
      h('p', {}, 'صوّر ورقة الفني، راجعها، وهي تروح لوحدها لعملائها ومنها للتسعير والحسابات. كل رقم ليه أصل، وكل تعديل متسجل.'))));
  form.querySelector('input')?.focus();
}
const inputField = (name, label, type = 'text', extra = {}) =>
  h('div', { class: 'field' }, h('label', { for: name }, label), h('input', { id: name, name, type, required: true, ...extra }));

function renderLogin() {
  authCard('تسجيل الدخول', 'ادخل باسم المستخدم وكلمة السر.', [
    inputField('username', 'اسم المستخدم', 'text', { autocomplete: 'username' }),
    inputField('password', 'كلمة السر', 'password', { autocomplete: 'current-password' }),
  ], 'دخول', async (v) => {
    const r = await post('/api/login', v);
    state.user = r.user;
    await loadLookups();
    if (!location.hash) location.hash = '#/';
    route();
  });
}

function renderSetup() {
  authCard('أهلاً بيك', 'أول مرة: اعمل حساب الأدمن (صاحب الصلاحيات كلها).', [
    inputField('display_name', 'الاسم'),
    inputField('username', 'اسم المستخدم', 'text', { autocomplete: 'username' }),
    inputField('password', 'كلمة السر (6 على الأقل)', 'password', { autocomplete: 'new-password', minlength: 6 }),
  ], 'ابدأ', async (v) => {
    const r = await post('/api/setup', v);
    state.user = r.user;
    await loadLookups();
    location.hash = '#/';
    route();
  });
}

// ---------- shell ----------
// phone: shown in the phone's bottom bar (the rest sit behind "المزيد").
const NAV = [
  { group: 'الشغل' },
  { href: '#/', label: 'الرئيسية', icon: 'house', phone: true },
  { href: '#/sheets', label: 'الورق', icon: 'files', badge: () => state.homeCounts?.review, phone: true },
  { href: '#/forms', label: 'طباعة الورق', icon: 'printer', perm: 'sheets.create', badge: () => state.homeCounts?.missing_printed, warn: true },
  { href: '#/deliveries', label: 'التسليم', icon: 'truck', perm: 'deliveries.manage', phone: () => !can('money.view') },
  { href: '#/production', label: 'الإنتاج', icon: 'factory', perm: 'production.view' },
  { group: 'الفلوس', perm: 'money.view' },
  { href: '#/pricing', label: 'التسعير', icon: 'tag', perm: 'money.view', badge: () => state.homeCounts?.unpriced, phone: true },
  { href: '#/payments', label: 'المدفوعات', icon: 'hand-coins', perm: 'money.view' },
  { href: '#/accounts', label: 'الحسابات', icon: 'chart-line-up', perm: 'money.view' },
  { href: '#/followup', label: 'المتابعة', icon: 'clock', perm: 'money.view' },
  { group: 'البيانات' },
  { href: '#/clients', label: 'العملاء', icon: 'users-three' },
  { href: '#/technicians', label: 'الفنيين', icon: 'hard-hat' },
  { group: 'النظام', perm: 'settings.manage' },
  { href: '#/users', label: 'المستخدمين', icon: 'user-gear', perm: 'users.manage' },
  { href: '#/ocr', label: 'القراءة الآلية', icon: 'scan', perm: 'settings.manage' },
  { href: '#/share', label: 'مشاركة', icon: 'share-network', perm: 'settings.manage' },
  { href: '#/settings', label: 'الإعدادات', icon: 'gear-six', perm: 'settings.manage' },
];

function shell(content) {
  const base = (location.hash || '#/').split('?')[0];
  const isOn = (href) => (href === '#/' ? base === '#/' : base === href || base.startsWith(href + '/'));
  const visible = NAV.filter((n) => !n.perm || can(n.perm));
  const items = [];
  visible.forEach((n, i) => {
    if (n.group) {
      if (visible[i + 1] && !visible[i + 1].group) items.push(h('div', { class: 'nav-group' }, n.group));
      return;
    }
    const b = n.badge?.();
    const phone = typeof n.phone === 'function' ? n.phone() : n.phone;
    items.push(h('a', { href: n.href, class: [isOn(n.href) ? 'on' : '', phone ? 'ph' : ''].join(' ').trim() },
      icon(n.icon), h('span', {}, n.label), b ? h('span', { class: `badge${n.warn ? ' warn' : ''}` }, b) : null));
    // The one action everything starts from: right under الرئيسية / الورق on the phone bar.
    if (n.href === '#/sheets' && can('sheets.create')) {
      items.push(h('a', { href: '#/add', class: `add ph${isOn('#/add') ? ' on' : ''}` }, icon('plus'), h('span', {}, 'أضف ورقة')));
    }
  });
  const side = h('nav', { class: 'side' },
    h('div', { class: 'brand' }, h('div', { class: 'logo' }, icon('factory')), h('div', {}, h('b', {}, 'Sheet Metal'), h('span', {}, 'شركة الصفا'))),
    items,
    h('button', { class: 'more', type: 'button', onclick: () => side.classList.toggle('open') }, icon('dots-three-outline'), h('span', {}, 'المزيد')),
    h('div', { class: 'foot' },
      h('div', { class: 'who' }, h('b', {}, state.user.display_name), h('span', {}, `نسخة ${state.version}`)),
      h('button', { title: 'خروج', 'aria-label': 'خروج', onclick: async () => { await post('/api/logout'); state.user = null; renderLogin(); } }, icon('sign-out'))));
  side.addEventListener('click', (e) => { if (e.target.closest('a')) side.classList.remove('open'); });
  app.replaceChildren(h('div', { class: 'shell' }, side, h('main', {}, content)));
}

async function refreshCounts() {
  try { state.homeCounts = await get('/api/home'); } catch { /* not critical */ }
}

// ---------- router ----------
async function route() {
  const hash = location.hash || '#/';
  await refreshCounts();
  const main = h('div', {}, skeleton());
  shell(main);
  window.scrollTo(0, 0);
  try {
    let m;
    const path = hash.split('?')[0];
    if (hash === '#/') await renderHome(main);
    else if (path === '#/sheets') await renderSheets(main);
    else if (hash.startsWith('#/sheets/new')) await renderSheet(main, null);
    else if ((m = hash.match(/^#\/sheets\/(\d+)$/))) await renderSheet(main, Number(m[1]));
    else if ((path === '#/add' || path === '#/scan') && can('sheets.create')) await renderScan(main);
    else if (hash === '#/clients') await renderClients(main);
    else if ((m = hash.match(/^#\/clients\/(\d+)$/)) && can('money.view')) await renderClientPage(main, Number(m[1]));
    else if ((m = hash.match(/^#\/pricing(?:\/(\d+))?$/)) && can('money.view')) await renderPricing(main, m[1] ? Number(m[1]) : null);
    else if (path === '#/deliveries' && can('deliveries.manage')) await renderDeliveries(main);
    else if (hash === '#/payments' && can('money.view')) await renderPayments(main);
    else if (path === '#/accounts' && can('money.view')) await renderAccounts(main);
    else if (hash === '#/followup' && can('money.view')) await renderFollowup(main);
    else if (hash === '#/settings' && can('settings.manage')) await renderSettings(main);
    else if (hash === '#/share' && can('settings.manage')) await renderShare(main);
    else if (hash === '#/forms' && can('sheets.create')) await renderPrintForms(main);
    else if (hash === '#/ocr' && can('settings.manage')) await renderReader(main);
    else if (hash === '#/technicians') await renderTechnicians(main);
    else if ((m = hash.match(/^#\/technicians\/(\d+)$/)) && can('production.view')) await renderTechnicianProfile(main, Number(m[1]));
    else if (hash === '#/production' && can('production.view')) await renderProduction(main);
    else if (hash === '#/reports' && can('money.view')) await renderReports(main);
    else if (hash === '#/users' && can('users.manage')) await renderUsers(main);
    else fill(main, emptyState('warning-circle', 'الصفحة دي مش موجودة', 'ارجع للرئيسية من القايمة.'));
  } catch (ex) {
    fill(main, emptyState('warning', 'حصلت مشكلة', ex.message, h('button', { class: 'btn', onclick: route }, icon('arrows-clockwise'), 'جرب تاني')));
  }
}
export const go = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };

// ---------- home: where the work is, and what needs you now ----------
const DAYS = ['الحد', 'الاتنين', 'التلات', 'الأربع', 'الخميس', 'الجمعة', 'السبت'];

function flowStep(n, label, value, desc, href, cls = '') {
  return h(href ? 'a' : 'div', { class: `step ${cls}`.trim(), href },
    h('div', { class: 'k' }, h('span', { class: 'n' }, n), label), h('b', { class: typeof value === 'string' ? 'num' : '' }, value), h('div', { class: 'd' }, desc));
}
const todo = (iconName, title, sub, href, cls = '') => h('a', { href, class: cls },
  h('div', { class: 'ic' }, icon(iconName)), h('div', { class: 't' }, h('b', {}, title), sub ? h('span', {}, sub) : null), icon('caret-left'));

async function renderHome(main) {
  const c = state.homeCounts || {};
  const sys = c.system || {};
  const money_ = can('money.view');
  const now = new Date();
  const steps = money_
    ? [
      flowStep(1, 'مستني المراجعة', c.review ?? 0, 'ورق اتصور ومحتاج يتراجع', '#/sheets?status=review', c.review ? 'hot' : ''),
      flowStep(2, 'جاهز للتسعير', c.unpriced ?? 0, `سطر شغل عند ${c.ready_clients?.length ?? 0} عميل`, '#/pricing', c.unpriced ? 'hot' : ''),
      flowStep(3, 'مستحق على العملاء', money(c.outstanding ?? 0), 'متسعر ولسه ما اتدفعش', '#/accounts?tab=balances'),
      flowStep(4, 'اتحصل الشهر ده', money(c.month?.collected ?? 0), 'دفعات اتقبضت فعلاً', '#/payments'),
    ]
    : [
      flowStep(1, 'مستني المراجعة', c.review ?? 0, 'ورق اتصور ومحتاج يتراجع', '#/sheets?status=review', c.review ? 'hot' : ''),
      flowStep(2, 'اتأكد النهارده', c.confirmed_today ?? 0, 'ورق راح لعملاؤه', '#/sheets?status=confirmed'),
      flowStep(3, 'خلص ومستني التسليم', c.undelivered ?? 0, 'سطر شغل', '#/deliveries', c.undelivered ? 'hot' : ''),
      flowStep(4, 'شغل النهارده', c.lines_today ?? 0, 'سطر متأكد', '#/production'),
    ];
  const todos = [
    sys.backup_error ? todo('warning', 'آخر نسخة احتياطية فشلت', 'افتح الإعدادات وشوف السبب', '#/settings', 'bad') : null,
    !sys.backup_error && sys.backup_stale ? todo('warning', 'مفيش نسخة احتياطية من أكتر من يومين', 'اعمل نسخة من الإعدادات', '#/settings', 'warn') : null,
    sys.backup_copy_error ? todo('warning', 'النسخة متنسختش على الفلاشة / OneDrive', 'اتأكد إنها متركبة', '#/settings', 'warn') : null,
    c.review ? todo('list-checks', `راجع ${c.review} ورقة`, 'الخانات الصفرا والحمرا محتاجة عين', '#/sheets?status=review') : null,
    ...(money_ ? (c.ready_clients || []).slice(0, 4).map((x) => todo('tag', `سعّر شغل ${x.name}`, `${x.lines} سطر جاهز`, `#/pricing/${x.id}`)) : []),
    money_ && c.cheques_due ? todo('bank', `${c.cheques_due} شيك مستحق الأسبوع ده`, 'تابعهم في المتابعة', '#/followup', 'warn') : null,
    c.missing_printed ? todo('printer', `${c.missing_printed} ورقة اتطبعت ولسه ما اترفعتش`, 'يمكن فيها شغل ضايع', '#/forms', 'warn') : null,
    sys.update_available ? todo('cloud-arrow-up', 'في نسخة جديدة من البرنامج', 'حدّث من الإعدادات', '#/settings') : null,
  ].filter(Boolean);
  const m = c.month || {};
  fill(main,
    pageHead(`أهلاً ${state.user.display_name}`, `${DAYS[now.getDay()]} ${fmtDate(now.toISOString())}`,
      can('sheets.create') ? h('a', { class: 'btn primary big', href: '#/add' }, icon('plus'), 'أضف ورقة فني') : null),
    h('div', { class: 'section-title', style: 'margin-top:0' }, h('h2', {}, 'مسار الشغل')),
    h('div', { class: 'flow', style: `--n:${steps.length}` }, steps),
    h('div', { class: 'section-title' }, h('h2', {}, 'محتاج منك دلوقتي')),
    todos.length ? h('div', { class: 'todo' }, todos) : emptyState('check-circle', 'مفيش حاجة مستنياك', 'كل الورق اتراجع وكل الشغل الجاهز اتسعر.'),
    money_ ? [
      h('div', { class: 'section-title' }, h('h2', {}, 'الشهر ده'), h('a', { href: '#/accounts', class: 'small' }, 'الحسابات كاملة')),
      h('div', { class: 'grid stats' },
        h('a', { class: 'stat', href: '#/accounts' }, h('b', { class: 'num' }, money(m.sales ?? 0)), h('span', {}, 'المبيعات (شغل اتسعر)')),
        h('a', { class: 'stat', href: '#/accounts?tab=expenses' }, h('b', { class: 'num' }, money(m.expenses ?? 0)), h('span', {}, 'المصروفات')),
        h('a', { class: `stat ${(m.profit ?? 0) < 0 ? 'owe' : 'credit'}`, href: '#/accounts' }, h('b', { class: 'num' }, money(m.profit ?? 0)), h('span', {}, 'صافي الربح')),
        h('a', { class: 'stat', href: '#/payments' }, h('b', { class: 'num' }, money(m.collected ?? 0)), h('span', {}, 'اتحصل'))),
    ] : [
      h('div', { class: 'section-title' }, h('h2', {}, 'النهارده')),
      h('div', { class: 'grid stats' },
        h('div', { class: 'stat' }, h('b', {}, c.lines_today ?? 0), h('span', {}, 'سطور شغل')),
        h('div', { class: 'stat' }, h('b', {}, c.clients ?? 0), h('span', {}, 'عميل')),
        h('div', { class: 'stat' }, h('b', {}, c.technicians ?? 0), h('span', {}, 'فني'))),
    ],
  );
}

// ---------- sheets list ----------
async function renderSheets(main) {
  const L = state.lookups;
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const filters = { status: params.get('status') || '', machine: '', technician: '', client: '', from: '', to: '' };
  const tableBox = h('div');
  const sel = (key, label, opts) => h('select', { onchange: (e) => { filters[key] = e.target.value; load(); } },
    h('option', { value: '' }, label), opts.map(([v, l]) => h('option', { value: v, selected: String(filters[key]) === String(v) }, l)));
  const date = (key) => h('input', { type: 'date', onchange: (e) => { filters[key] = e.target.value; load(); } });

  async function load() {
    const q = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();
    const { sheets } = await get('/api/sheets' + (q ? '?' + q : ''));
    fill(tableBox, sheets.length === 0
      ? emptyState('files', filters.status === 'review' ? 'مفيش ورق مستني مراجعة' : 'مفيش ورق بالفلتر ده',
        'صوّر ورقة فني وهي هتظهر هنا للمراجعة.', can('sheets.create') ? h('a', { class: 'btn primary', href: '#/add' }, icon('plus'), 'أضف ورقة') : null)
      : h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['رقم', 'المكنة', 'التاريخ', 'الفني', 'العملاء', 'سطور', 'الحالة'].map((t) => h('th', {}, t)))),
        h('tbody', {}, sheets.map((s) => h('tr', { class: 'click', onclick: () => go(`#/sheets/${s.id}`) },
          h('td', { class: 'num' }, s.sheet_no || '—'),
          h('td', {}, s.machine_name, s.source === 'photo' ? h('span', { class: 'muted', title: 'من صورة' }, ' ', icon('image')) : null),
          h('td', {}, fmtDate(s.sheet_date || s.created_at)),
          h('td', {}, s.technician_name || '—'),
          h('td', {}, s.clients || '—'),
          h('td', { class: 'num' }, s.line_count),
          h('td', {}, h('span', { class: `pill ${s.status}` }, s.status_name))))))));
  }

  fill(main,
    pageHead('الورق', 'كل ورقة فني: اتصورت، اتراجعت، واتأكدت.',
      can('sheets.create') ? h('a', { class: 'btn primary', href: '#/add' }, icon('plus'), 'أضف ورقة') : null),
    h('div', { class: 'row', style: 'margin-bottom:14px' },
      sel('status', 'كل الحالات', [['review', 'مستنية المراجعة'], ['confirmed', 'اتأكدت'], ['cancelled', 'اتلغت']]),
      sel('machine', 'كل المكن', L.machines.map((m) => [m.id, m.name])),
      sel('technician', 'كل الفنيين', L.technicians.map((t) => [t.id, t.name])),
      sel('client', 'كل العملاء', L.clients.map((c) => [c.id, c.name])),
      h('span', { class: 'muted small' }, 'من'), date('from'), h('span', { class: 'muted small' }, 'إلى'), date('to')),
    tableBox);
  await load();
}

// A client name close to one we already have is probably the same client: ask before adding.
export async function saveClient(body, id = null) {
  try {
    return id ? await patch(`/api/clients/${id}`, body) : await post('/api/clients', body);
  } catch (ex) {
    const similar = ex.data?.similar;
    if (!similar?.length) throw ex;
    const ok = await confirmModal('في عميل اسمه قريب',
      `عندك: ${similar.map((s) => s.name).join('، ')}. لو ده نفس العميل ارجع واختاره بدل ما تضيف واحد جديد. "${body.name}" عميل تاني فعلاً؟`, 'أيوه، عميل جديد');
    if (!ok) throw new Error('اختار العميل الموجود');
    return id ? patch(`/api/clients/${id}`, { ...body, force: true }) : post('/api/clients', { ...body, force: true });
  }
}

// ---------- clients ----------
async function renderClients(main) {
  const { clients } = await get('/api/clients');
  const showMoney = can('money.view');
  const edit = async (c) => {
    const fields = [
      { name: 'name', label: 'اسم العميل', value: c?.name },
      { name: 'phone', label: 'التليفون', type: 'tel', value: c?.phone },
      { name: 'notes', label: 'ملاحظات', type: 'textarea', value: c?.notes },
    ];
    if (showMoney) {
      fields.push({ name: 'opening_balance', label: 'رصيد أول المدة (عليه بالموجب، له بالسالب)', value: c ? (c.opening_balance / 100).toFixed(2) : '0' });
      fields.push({ name: 'opening_date', label: 'تاريخ رصيد أول المدة', type: 'date', value: c?.opening_date || '' });
    }
    if (c) fields.push({ name: 'active', label: 'العميل نشط', type: 'checkbox', value: c.active });
    const ok = await formModal({ title: c ? `تعديل ${c.name}` : 'عميل جديد', fields, onSubmit: (v) => saveClient(v, c?.id) });
    if (ok) { toast('اتحفظ'); await loadLookups(); route(); }
  };
  const outstanding = showMoney ? clients.filter((c) => c.balance > 0).reduce((s, c) => s + c.balance, 0) : 0;
  const open = (c) => (showMoney ? go(`#/clients/${c.id}`) : can('clients.edit') && edit(c));
  fill(main,
    pageHead('العملاء', showMoney ? `${clients.length} عميل · برة عندهم ${money(outstanding)}` : `${clients.length} عميل`,
      can('clients.edit') ? h('button', { class: 'btn primary', onclick: () => edit(null) }, icon('plus'), 'عميل جديد') : null),
    clients.length === 0 ? emptyState('users-three', 'لسه مفيش عملاء', 'ضيف العملاء هنا، أو من جوه الورقة وانت بتراجعها.') :
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['الاسم', 'التليفون', showMoney ? 'الرصيد' : null, 'الحالة', ''].filter((x) => x !== null).map((t) => h('th', {}, t)))),
        h('tbody', {}, clients.map((c) => h('tr', { class: showMoney || can('clients.edit') ? 'click' : '', onclick: () => open(c) },
          h('td', {}, h('b', { style: 'font-weight:500' }, c.name)), h('td', { class: 'num' }, c.phone || '—'),
          showMoney ? h('td', { class: 'num' + (c.balance > 0 ? ' owe-t' : '') }, `${money(Math.abs(c.balance))} ${c.balance > 0 ? 'عليه' : c.balance < 0 ? 'له' : ''}`) : null,
          h('td', {}, c.active ? h('span', { class: 'pill green' }, 'نشط') : h('span', { class: 'pill cancelled' }, 'موقوف')),
          h('td', {}, can('clients.edit') ? h('button', { class: 'btn sm ghost', onclick: (e) => { e.stopPropagation(); edit(c); } }, icon('pencil-simple'), 'تعديل') : null)))))));
}

// ---------- technicians ----------
async function renderTechnicians(main) {
  const { technicians } = await get('/api/technicians');
  const DIG = [['arabic', 'عربي ١٢٣'], ['western', 'إنجليزي 123']];
  const edit = async (t) => {
    const ok = await formModal({
      title: t ? `تعديل ${t.name}` : 'فني جديد',
      fields: [
        { name: 'name', label: 'الاسم', value: t?.name },
        { name: 'digit_system', label: 'بيكتب الأرقام', type: 'select', options: DIG, value: t?.digit_system || 'arabic' },
        ...(t ? [{ name: 'active', label: 'الفني شغال', type: 'checkbox', value: t.active }] : []),
      ],
      onSubmit: (v) => (t ? patch(`/api/technicians/${t.id}`, v) : post('/api/technicians', v)),
    });
    if (ok) { toast('اتحفظ'); await loadLookups(); route(); }
  };
  fill(main,
    pageHead('الفنيين', 'دوس على الفني تشوف إنتاجه وعملاؤه وأكتر أخطاؤه.',
      can('technicians.edit') ? h('button', { class: 'btn primary', onclick: () => edit(null) }, icon('plus'), 'فني جديد') : null),
    technicians.length === 0 ? emptyState('hard-hat', 'لسه مفيش فنيين', 'ضيف الفنيين عشان تعرف كل ورقة بتاعة مين.') :
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['الاسم', 'الأرقام', 'الحالة', ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, technicians.map((t) => h('tr', { class: can('production.view') ? 'click' : '', onclick: () => can('production.view') && go(`#/technicians/${t.id}`) },
          h('td', {}, h('b', { style: 'font-weight:500' }, t.name)), h('td', {}, t.digit_system === 'arabic' ? 'عربي ١٢٣' : 'إنجليزي 123'),
          h('td', {}, t.active ? h('span', { class: 'pill green' }, 'شغال') : h('span', { class: 'pill cancelled' }, 'موقوف')),
          h('td', {}, can('technicians.edit') ? h('button', { class: 'btn sm ghost', onclick: (e) => { e.stopPropagation(); edit(t); } }, icon('pencil-simple'), 'تعديل') : null)))))));
}

// ---------- users ----------
async function renderUsers(main) {
  const { users, roles } = await get('/api/users');
  const roleOpts = Object.entries(roles);
  const edit = async (u) => {
    const ok = await formModal({
      title: u ? `تعديل ${u.display_name}` : 'مستخدم جديد',
      fields: [
        ...(u ? [] : [{ name: 'username', label: 'اسم المستخدم (للدخول)' }]),
        { name: 'display_name', label: 'الاسم', value: u?.display_name },
        { name: 'role', label: 'الدور', type: 'select', options: roleOpts, value: u?.role || 'staff' },
        { name: 'password', label: u ? 'كلمة سر جديدة (سيبها فاضية لو مش هتغيرها)' : 'كلمة السر (6 على الأقل)', type: 'password' },
        ...(u ? [{ name: 'active', label: 'الحساب شغال', type: 'checkbox', value: u.active }] : []),
      ],
      onSubmit: (v) => {
        if (u && !v.password) delete v.password;
        return u ? patch(`/api/users/${u.id}`, v) : post('/api/users', v);
      },
    });
    if (ok) { toast('اتحفظ'); route(); }
  };
  fill(main,
    pageHead('المستخدمين', 'مدير الورشة بيدخل ويراجع ويأكد الورق ويضيف عملاء وفنيين، ومش بيشوف أي أسعار أو حسابات.',
      h('button', { class: 'btn primary', onclick: () => edit(null) }, icon('plus'), 'مستخدم جديد')),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['الاسم', 'اسم المستخدم', 'الدور', 'الحالة'].map((x) => h('th', {}, x)))),
      h('tbody', {}, users.map((u) => h('tr', { class: 'click', onclick: () => edit(u) },
        h('td', {}, h('b', { style: 'font-weight:500' }, u.display_name)), h('td', { class: 'num' }, u.username), h('td', {}, roles[u.role]),
        h('td', {}, u.active ? h('span', { class: 'pill green' }, 'شغال') : h('span', { class: 'pill cancelled' }, 'موقوف'))))))));
}

boot().catch((ex) => { app.replaceChildren(h('div', { class: 'boot' }, ex.message)); });
