// Shell, router and the simple screens. The sheet screen lives in sheet.js.
import { h, toast, money, fmtDate, formModal, fill } from './ui.js';
import { get, post, patch } from './api.js';
import { renderSheet } from './sheet.js';
import { renderPricing } from './pricing.js';
import { renderClientPage, renderPayments, renderFollowup, renderSettings } from './accounts.js';
import { renderDeliveries } from './delivery.js';
import { renderShare } from './system.js';
import { renderScan, renderPrintForms, renderReader } from './scan.js';

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
  app.replaceChildren(h('div', { class: 'auth' }, h('div', { class: 'card' },
    h('h1', {}, title), h('div', { class: 'muted' }, subtitle), form)));
  form.querySelector('input')?.focus();
}
const inputField = (name, label, type = 'text', extra = {}) =>
  h('div', { class: 'field' }, h('label', { for: name }, label), h('input', { id: name, name, type, required: true, ...extra }));

function renderLogin() {
  authCard('Sheet Metal', 'شركة الصفا — تسجيل الدخول', [
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
  authCard('أهلاً بيك في Sheet Metal', 'أول مرة: اعمل حساب الأدمن (صاحب الصلاحيات كلها).', [
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
const NAV = [
  // phone: shown in the phone's bottom bar; the rest sit behind "المزيد".
  { href: '#/', label: 'الرئيسية', phone: true },
  { href: '#/sheets', label: 'الورق', badge: () => state.homeCounts?.review, phone: true },
  { href: '#/scan', label: 'صوّر ورقة', perm: 'sheets.create', phone: true },
  { href: '#/sheets/new', label: 'إدخال ورقة', perm: 'sheets.create' },
  { href: '#/forms', label: 'طباعة الورق', perm: 'sheets.create', badge: () => state.homeCounts?.missing_printed },
  { href: '#/pricing', label: 'التسعير', perm: 'money.view', badge: () => state.homeCounts?.unpriced },
  { href: '#/deliveries', label: 'التسليم', perm: 'deliveries.manage', phone: true },
  { href: '#/payments', label: 'المدفوعات', perm: 'money.view' },
  { href: '#/followup', label: 'المتابعة', perm: 'money.view' },
  { href: '#/clients', label: 'العملاء' },
  { href: '#/technicians', label: 'الفنيين' },
  { href: '#/users', label: 'المستخدمين', perm: 'users.manage' },
  { href: '#/ocr', label: 'القراءة الآلية', perm: 'settings.manage' },
  { href: '#/share', label: 'مشاركة', perm: 'settings.manage' },
  { href: '#/settings', label: 'الإعدادات', perm: 'settings.manage' },
];

function shell(content) {
  const hash = location.hash || '#/';
  const nav = NAV.filter((n) => !n.perm || can(n.perm)).map((n) => {
    const base = hash.split('?')[0];
    const on = n.href === '#/' ? base === '#/' : base === n.href || (n.href !== '#/sheets/new' && base.startsWith(n.href + '/') && !base.startsWith('#/sheets/new'));
    const b = n.badge?.();
    return h('a', { href: n.href, class: [on ? 'on' : '', n.phone ? 'ph' : ''].join(' ').trim() }, n.label, b ? h('span', { class: 'badge' }, b) : null);
  });
  const side = h('nav', { class: 'side' },
    h('div', { class: 'brand' }, h('b', {}, 'Sheet Metal'), h('span', {}, 'شركة الصفا')),
    nav,
    h('button', { class: 'more', type: 'button', onclick: () => side.classList.toggle('open') }, 'المزيد'),
    h('div', { class: 'foot' }, `${state.user.display_name}`, h('br'),
      h('button', { onclick: async () => { await post('/api/logout'); state.user = null; renderLogin(); } }, 'خروج'),
      h('div', { class: 'small', style: 'opacity:.7;margin-top:8px' }, `نسخة ${state.version}`)));
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
  const main = h('div', {}, h('div', { class: 'muted' }, 'جاري التحميل…'));
  shell(main);
  try {
    let m;
    if (hash === '#/') await renderHome(main);
    else if (hash === '#/sheets') await renderSheets(main);
    else if (hash.startsWith('#/sheets/new')) await renderSheet(main, null);
    else if ((m = hash.match(/^#\/sheets\/(\d+)$/))) await renderSheet(main, Number(m[1]));
    else if (hash === '#/clients') await renderClients(main);
    else if ((m = hash.match(/^#\/clients\/(\d+)$/)) && can('money.view')) await renderClientPage(main, Number(m[1]));
    else if ((m = hash.match(/^#\/pricing(?:\/(\d+))?$/)) && can('money.view')) await renderPricing(main, m[1] ? Number(m[1]) : null);
    else if (hash.split('?')[0] === '#/deliveries' && can('deliveries.manage')) await renderDeliveries(main);
    else if (hash === '#/payments' && can('money.view')) await renderPayments(main);
    else if (hash === '#/followup' && can('money.view')) await renderFollowup(main);
    else if (hash === '#/settings' && can('settings.manage')) await renderSettings(main);
    else if (hash === '#/share' && can('settings.manage')) await renderShare(main);
    else if (hash === '#/scan' && can('sheets.create')) renderScan(main);
    else if (hash === '#/forms' && can('sheets.create')) await renderPrintForms(main);
    else if (hash === '#/ocr' && can('settings.manage')) await renderReader(main);
    else if (hash === '#/technicians') await renderTechnicians(main);
    else if (hash === '#/users' && can('users.manage')) await renderUsers(main);
    else main.replaceChildren(h('h1', {}, 'الصفحة مش موجودة'));
  } catch (ex) {
    main.replaceChildren(h('div', { class: 'card' }, ex.message));
  }
}
export const go = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };

// ---------- home ----------
async function renderHome(main) {
  const c = state.homeCounts || {};
  const sys = c.system || {};
  const alerts = [
    sys.backup_error ? 'آخر نسخة احتياطية فشلت — افتح الإعدادات.' : sys.backup_stale ? 'مفيش نسخة احتياطية من أكتر من يومين — افتح الإعدادات.' : null,
    sys.backup_copy_error ? 'النسخة الاحتياطية متنسختش على الفلاشة/OneDrive — اتأكد إنها متركبة.' : null,
  ].filter(Boolean);
  fill(main,
    h('div', { class: 'top' }, h('h1', {}, `أهلاً ${state.user.display_name}`)),
    alerts.map((a) => h('a', { href: '#/settings', class: 'issue red', style: 'text-decoration:none;margin-bottom:8px' }, a)),
    sys.update_available ? h('a', { href: '#/settings', class: 'issue yellow', style: 'text-decoration:none;margin-bottom:8px' }, 'في نسخة جديدة من البرنامج — افتح الإعدادات ودوس تحديث.') : null,
    h('div', { class: 'grid stats' },
      h('a', { href: '#/sheets', class: 'stat' + (c.review ? ' alert' : ''), style: 'text-decoration:none;color:inherit' },
        h('b', {}, c.review ?? 0), h('span', {}, 'ورق مستني المراجعة')),
      h('div', { class: 'stat' }, h('b', {}, c.confirmed_today ?? 0), h('span', {}, 'ورق اتأكد النهارده')),
      h('div', { class: 'stat' }, h('b', {}, c.lines_today ?? 0), h('span', {}, 'سطور شغل النهارده')),
      can('deliveries.manage') ? h('a', { href: '#/deliveries', class: 'stat', style: 'text-decoration:none;color:inherit' },
        h('b', {}, c.undelivered ?? 0), h('span', {}, 'سطر خلص ولسه ما اتسلمش')) : null,
      can('money.view') ? [
        h('a', { href: '#/pricing', class: 'stat' + (c.unpriced ? ' alert' : ''), style: 'text-decoration:none;color:inherit' },
          h('b', {}, c.unpriced ?? 0), h('span', {}, 'سطر مستني تسعير')),
        h('a', { href: '#/clients', class: 'stat', style: 'text-decoration:none;color:inherit' },
          h('b', { class: 'num' }, money(c.outstanding ?? 0)), h('span', {}, 'فلوس برة عند العملاء')),
        h('a', { href: '#/followup', class: 'stat' + (c.cheques_due ? ' alert' : ''), style: 'text-decoration:none;color:inherit' },
          h('b', {}, c.cheques_due ?? 0), h('span', {}, 'شيكات مستحقة الأسبوع ده')),
      ] : null,
      c.missing_printed ? h('a', { href: '#/forms', class: 'stat alert', style: 'text-decoration:none;color:inherit' },
        h('b', {}, c.missing_printed), h('span', {}, 'ورقة اتطبعت ولسه ما اترفعتش')) : null,
      h('div', { class: 'stat' }, h('b', {}, c.clients ?? 0), h('span', {}, 'عميل')),
      h('div', { class: 'stat' }, h('b', {}, c.technicians ?? 0), h('span', {}, 'فني'))),
    can('sheets.create')
      ? h('div', { class: 'actions' }, h('a', { class: 'btn primary', href: '#/scan' }, '📷 صوّر ورقة'), state.lookups.machines.map((m) =>
        h('a', { class: 'btn', href: `#/sheets/new?machine=${m.id}` }, `+ ورقة ${m.name}`)))
      : '',
  );
}

// ---------- sheets list ----------
async function renderSheets(main) {
  const L = state.lookups;
  const filters = { status: '', machine: '', technician: '', client: '', from: '', to: '' };
  const tableBox = h('div');
  const sel = (key, label, opts) => h('select', { onchange: (e) => { filters[key] = e.target.value; load(); } },
    h('option', { value: '' }, label), opts.map(([v, l]) => h('option', { value: v }, l)));
  const date = (key) => h('input', { type: 'date', onchange: (e) => { filters[key] = e.target.value; load(); } });

  async function load() {
    const q = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();
    const { sheets } = await get('/api/sheets' + (q ? '?' + q : ''));
    tableBox.replaceChildren(sheets.length === 0
      ? h('div', { class: 'card muted' }, 'مفيش ورق بالفلتر ده.')
      : h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['#', 'المكنة', 'التاريخ', 'الفني', 'العملاء', 'سطور', 'الحالة'].map((t) => h('th', {}, t)))),
        h('tbody', {}, sheets.map((s) => h('tr', { class: 'click', onclick: () => go(`#/sheets/${s.id}`) },
          h('td', { class: 'num' }, s.sheet_no || s.id),
          h('td', {}, s.machine_name),
          h('td', {}, fmtDate(s.sheet_date || s.created_at)),
          h('td', {}, s.technician_name || '—'),
          h('td', {}, s.clients || '—'),
          h('td', { class: 'num' }, s.line_count),
          h('td', {}, h('span', { class: `pill ${s.status}` }, s.status_name))))))));
  }

  main.replaceChildren(
    h('div', { class: 'top' }, h('h1', {}, 'الورق'),
      can('sheets.create') ? h('a', { class: 'btn primary', href: '#/sheets/new' }, '+ إدخال ورقة') : null),
    h('div', { class: 'row', style: 'margin-bottom:12px' },
      sel('status', 'كل الحالات', [['review', 'مستنية المراجعة'], ['confirmed', 'اتأكدت'], ['cancelled', 'اتلغت']]),
      sel('machine', 'كل المكن', L.machines.map((m) => [m.id, m.name])),
      sel('technician', 'كل الفنيين', L.technicians.map((t) => [t.id, t.name])),
      sel('client', 'كل العملاء', L.clients.map((c) => [c.id, c.name])),
      h('span', { class: 'muted small' }, 'من'), date('from'), h('span', { class: 'muted small' }, 'إلى'), date('to')),
    tableBox);
  await load();
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
    const ok = await formModal({
      title: c ? `تعديل ${c.name}` : 'عميل جديد',
      fields,
      onSubmit: (v) => (c ? patch(`/api/clients/${c.id}`, v) : post('/api/clients', v)),
    });
    if (ok) { toast('اتحفظ'); await loadLookups(); route(); }
  };
  const outstanding = showMoney ? clients.filter((c) => c.balance > 0).reduce((s, c) => s + c.balance, 0) : 0;
  const open = (c) => (showMoney ? go(`#/clients/${c.id}`) : can('clients.edit') && edit(c));
  main.replaceChildren(
    h('div', { class: 'top' }, h('div', {}, h('h1', {}, 'العملاء'),
      showMoney ? h('div', { class: 'small muted' }, `إجمالي الفلوس برة: ${money(outstanding)}`) : null),
      can('clients.edit') ? h('button', { class: 'btn primary', onclick: () => edit(null) }, '+ عميل جديد') : null),
    clients.length === 0 ? h('div', { class: 'card muted' }, 'لسه مفيش عملاء.') :
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['الاسم', 'التليفون', showMoney ? 'الرصيد' : null, 'الحالة', ''].filter((x) => x !== null).map((t) => h('th', {}, t)))),
        h('tbody', {}, clients.map((c) => h('tr', { class: showMoney || can('clients.edit') ? 'click' : '', onclick: () => open(c) },
          h('td', {}, c.name), h('td', { class: 'num' }, c.phone || '—'),
          showMoney ? h('td', { class: 'num' + (c.balance > 0 ? ' owe-t' : '') }, `${money(Math.abs(c.balance))} ${c.balance > 0 ? 'عليه' : c.balance < 0 ? 'له' : ''}`) : null,
          h('td', {}, c.active ? 'نشط' : h('span', { class: 'muted' }, 'موقوف')),
          h('td', {}, can('clients.edit') ? h('button', { class: 'btn sm', onclick: (e) => { e.stopPropagation(); edit(c); } }, 'تعديل') : null)))))),
  );
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
  main.replaceChildren(
    h('div', { class: 'top' }, h('h1', {}, 'الفنيين'),
      can('technicians.edit') ? h('button', { class: 'btn primary', onclick: () => edit(null) }, '+ فني جديد') : null),
    technicians.length === 0 ? h('div', { class: 'card muted' }, 'لسه مفيش فنيين.') :
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['الاسم', 'الأرقام', 'الحالة'].map((x) => h('th', {}, x)))),
        h('tbody', {}, technicians.map((t) => h('tr', { class: can('technicians.edit') ? 'click' : '', onclick: () => can('technicians.edit') && edit(t) },
          h('td', {}, t.name), h('td', {}, t.digit_system === 'arabic' ? 'عربي ١٢٣' : 'إنجليزي 123'),
          h('td', {}, t.active ? 'شغال' : h('span', { class: 'muted' }, 'موقوف'))))))),
  );
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
  main.replaceChildren(
    h('div', { class: 'top' }, h('h1', {}, 'المستخدمين'), h('button', { class: 'btn primary', onclick: () => edit(null) }, '+ مستخدم جديد')),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['الاسم', 'اسم المستخدم', 'الدور', 'الحالة'].map((x) => h('th', {}, x)))),
      h('tbody', {}, users.map((u) => h('tr', { class: 'click', onclick: () => edit(u) },
        h('td', {}, u.display_name), h('td', { class: 'num' }, u.username), h('td', {}, roles[u.role]),
        h('td', {}, u.active ? 'شغال' : h('span', { class: 'muted' }, 'موقوف'))))))),
    h('p', { class: 'muted small' }, 'مدير الورشة: يدخل ويراجع ويأكد الورق ويضيف عملاء وفنيين، ومش بيشوف أي أسعار أو حسابات.'),
  );
}

boot().catch((ex) => { app.replaceChildren(h('div', { class: 'boot' }, ex.message)); });
