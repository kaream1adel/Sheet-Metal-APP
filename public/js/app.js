// Shell (right sidebar menu, phone bottom bar), hash router, login / first setup.
//
// Module screens register in their own file (public/js/modules/<module>.js → export routes):
//   { path: '#/ops/sheets/:id', screen: async (main, params, ctx) => {}, perm: 'x' | any: ['x', 'y'] }
// ctx = { state, can, canAny, go, refresh, loadLookups, query } — query: the ?a=b part of the hash.
// The menu below is fixed (the spec's screens); every entry points at a registered route.
import { h, fill, icon, toast, emptyState, skeleton, button } from './ui.js';
import { get, post } from './api.js';
import * as ops from './modules/operations.js';
import * as pricing from './modules/pricing.js';
import * as treasury from './modules/treasury.js';
import * as reports from './modules/reports.js';
import * as imp from './modules/import.js';
import { partyList, partyPage } from './parties.js';
import { settingsPage } from './settings.js';

export const state = { user: null, version: '', lookups: null };
export const can = (perm) => !!state.user?.permissions.includes(perm);
export const canAny = (...perms) => perms.some(can);
const app = document.getElementById('app');

export async function loadLookups() {
  state.lookups = await get('/api/lookups');
  return state.lookups;
}

// ---------- boot ----------
async function boot() {
  try {
    const s = await get('/api/session');
    state.version = s.version;
    if (s.needsSetup) return renderSetup();
    if (!s.user) return renderLogin();
    state.user = s.user;
    await loadLookups();
    route();
    const after = safeSession('get', 'after-restart');
    if (after) { safeSession('remove', 'after-restart'); toast(after); }
  } catch (ex) {
    fill(app, h('div', { class: 'boot' }, emptyState('warning', 'مقدرتش أوصل للبرنامج', ex.message, button('جرب تاني', { onClick: () => location.reload() }))));
  }
}
window.addEventListener('hashchange', () => state.user && route());
window.addEventListener('signed-out', () => { state.user = null; renderLogin(); });

function safeSession(op, k) {
  try {
    if (op === 'get') return sessionStorage.getItem(k);
    if (op === 'remove') sessionStorage.removeItem(k);
  } catch { /* storage blocked */ }
  return null;
}
function safeLocal(k, v) {
  try {
    if (v === undefined) return JSON.parse(localStorage.getItem(k) || 'null');
    localStorage.setItem(k, JSON.stringify(v));
  } catch { /* storage blocked */ }
  return null;
}

// ---------- auth screens ----------
function authCard(title, subtitle, fields, buttonLabel, onSubmit) {
  const err = h('div', { class: 'err', role: 'alert' });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, buttonLabel);
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      if (submit.disabled) return;
      err.textContent = '';
      const values = Object.fromEntries(new FormData(form));
      submit.disabled = true;
      try { await onSubmit(values); } catch (ex) { err.textContent = ex.message; } finally { submit.disabled = false; }
    },
  }, fields, err, submit);
  fill(app, h('div', { class: 'auth' },
    h('div', { class: 'pane' }, h('div', { class: 'box' },
      h('div', { class: 'brand', style: 'padding:0 0 22px' }, h('div', { class: 'logo' }, icon('factory', 'lg')),
        h('div', {}, h('b', {}, 'Sheet Metal Management'), h('span', {}, 'شركة الصفا — تشغيل وحسابات الورشة'))),
      h('h1', {}, title), h('div', { class: 'muted' }, subtitle), form)),
    h('div', { class: 'art' },
      h('b', {}, 'من ورقة الفني لكشف الحساب.'),
      h('p', {}, 'الفني بيكتب ورقته، تتصور أو تتكتب، تتراجع وتتعتمد، تتسعر وتترحّل على العميل. كل رقم ليه أصل، وكل تعديل متسجل.'))));
  form.querySelector('input')?.focus();
}
const authField = (name, label, type = 'text', extra = {}) =>
  h('div', { class: 'field' }, h('label', { for: `a-${name}` }, label), h('input', { id: `a-${name}`, name, type, required: true, ...extra }));

function renderLogin() {
  authCard('تسجيل الدخول', 'ادخل باسم المستخدم وكلمة السر.', [
    authField('username', 'اسم المستخدم', 'text', { autocomplete: 'username' }),
    authField('password', 'كلمة السر', 'password', { autocomplete: 'current-password' }),
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
    authField('display_name', 'الاسم'),
    authField('username', 'اسم المستخدم', 'text', { autocomplete: 'username' }),
    authField('password', 'كلمة السر (6 على الأقل)', 'password', { autocomplete: 'new-password', minlength: 6 }),
  ], 'ابدأ', async (v) => {
    const r = await post('/api/setup', v);
    state.user = r.user;
    await loadLookups();
    location.hash = '#/';
    route();
  });
}

// ---------- the menu (grouped exactly as the spec's screens) ----------
// perm: one permission; any: several (one is enough). No perm = everyone signed in.
const NAV = [
  { href: '#/', label: 'الرئيسية', icon: 'house' },
  { group: 'التشغيل', items: [
    { href: '#/ops/sheets', label: 'أوراق التشغيل', icon: 'files', any: ['operations.record', 'operations.approve'] },
    { href: '#/ops/sheets/new', label: 'ورقة جديدة', icon: 'file-plus', perm: 'operations.record' },
    { href: '#/ops/photos', label: 'صوّر ورقة', icon: 'camera', perm: 'operations.record' },
    { href: '#/ops/review', label: 'المراجعة والاعتماد', icon: 'seal-check', perm: 'operations.approve' },
    { href: '#/ops/orders', label: 'أوامر الشغل', icon: 'clipboard-text', perm: 'workorders' },
    { href: '#/ops/production', label: 'سجل الإنتاج', icon: 'factory', any: ['operations.record', 'reports'] },
  ] },
  { group: 'العملاء', items: [
    { href: '#/clients', label: 'العملاء', icon: 'users-three' },
  ] },
  { group: 'التسعير', items: [
    { href: '#/pricing', label: 'أوراق مستنية تسعير', icon: 'tag', perm: 'pricing' },
    { href: '#/pricing/general', label: 'الأسعار العامة', icon: 'table', perm: 'pricing' },
  ] },
  { group: 'الخزينة والبنك', items: [
    { href: '#/treasury', label: 'الخزينة والبنك', icon: 'vault', perm: 'treasury' },
    { href: '#/treasury/receipt', label: 'إيصال استلام', icon: 'receipt', perm: 'treasury' },
    { href: '#/expenses/new', label: 'إذن صرف', icon: 'hand-coins', perm: 'expenses.record' },
    { href: '#/treasury/transfer', label: 'تحويل', icon: 'arrows-left-right', perm: 'treasury' },
    { href: '#/treasury/count', label: 'جرد الخزينة', icon: 'calculator', perm: 'treasury' },
  ] },
  { group: 'المصروفات', items: [
    { href: '#/expenses', label: 'المصروفات', icon: 'wallet', perm: 'expenses.record' },
    { href: '#/expenses/new', label: 'إذن صرف جديد', icon: 'plus', perm: 'expenses.record' },
    { href: '#/expenses/recurring', label: 'المصروفات المتكررة', icon: 'repeat', perm: 'treasury' },
  ] },
  { group: 'الشيكات', items: [
    { href: '#/cheques/in', label: 'أوراق القبض', icon: 'bank', perm: 'cheques' },
    { href: '#/cheques/out', label: 'أوراق الدفع', icon: 'signature', perm: 'cheques' },
  ] },
  { group: 'الأطراف', items: [
    { href: '#/suppliers', label: 'الموردين', icon: 'truck', any: ['money.view', 'expenses.record'] },
    { href: '#/partners', label: 'الشركاء', icon: 'handshake', perm: 'money.view' },
    { href: '#/workers', label: 'العمال', icon: 'hard-hat', any: ['money.view', 'expenses.record'] },
  ] },
  { group: 'التقارير', items: [
    { href: '#/reports/clients', label: 'ملخص العملاء', icon: 'users-three', perm: 'reports', any: ['money.view'] },
    { href: '#/reports/aging', label: 'أعمار الديون', icon: 'hourglass-medium', perm: 'reports', any: ['money.view'] },
    { href: '#/reports/profit', label: 'مكسب الشهر', icon: 'trend-up', perm: 'reports', any: ['money.view'] },
    { href: '#/reports/cashflow', label: 'التدفق المتوقع', icon: 'calendar-blank', perm: 'reports', any: ['money.view'] },
    { href: '#/reports/partners', label: 'جاري الشركاء', icon: 'handshake', perm: 'reports', any: ['money.view'] },
    { href: '#/reports/production', label: 'الإنتاج', icon: 'factory', any: ['reports', 'operations.record', 'operations.approve'] },
    { href: '#/reports/followups', label: 'متابعة التحصيل', icon: 'phone', perm: 'reports' },
    { href: '#/reports/audit', label: 'سجل التعديلات', icon: 'clock-counter-clockwise', perm: 'reports' },
  ] },
  { group: 'الإعدادات', items: [
    { href: '#/settings', label: 'الإعدادات', icon: 'gear-six', any: ['settings', 'users', 'import'] },
  ] },
];

// The phone's bottom bar. "المزيد" opens the full menu.
const PHONE_BAR = [
  { href: '#/', label: 'الرئيسية', icon: 'house' },
  { href: '#/ops/photos', label: 'صوّر ورقة', icon: 'camera', perm: 'operations.record' },
  { href: '#/ops/review', label: 'المراجعة', icon: 'seal-check', perm: 'operations.approve' },
  { href: '#/clients', label: 'العملاء', icon: 'users-three' },
];

const allowed = (n) => (!n.perm || can(n.perm)) && (!n.any || canAny(...n.any));
const basePath = () => (location.hash || '#/').split('?')[0];
function isOn(href) {
  const base = basePath();
  if (href === '#/') return base === '#/' || base === '';
  if (base === href) return true;
  // A detail page lights its list, unless a more specific menu entry matches.
  const all = NAV.flatMap((n) => n.items || [n]).map((n) => n.href);
  const better = all.some((x) => x !== href && x.startsWith(href) && (base === x || base.startsWith(`${x}/`)));
  return !better && base.startsWith(`${href}/`);
}

function shell(content) {
  const closed = new Set(safeLocal('nav-closed') || []);
  const link = (n) => h('a', { href: n.href, class: isOn(n.href) ? 'on' : null, 'aria-current': isOn(n.href) ? 'page' : null },
    icon(n.icon), h('span', {}, n.label));
  const items = NAV.map((n) => {
    if (!n.group) return allowed(n) ? link(n) : null;
    const visible = n.items.filter(allowed);
    if (!visible.length) return null;
    const isClosed = closed.has(n.group) && !visible.some((x) => isOn(x.href));
    const list = h('div', { class: 'nav-items', hidden: isClosed }, visible.map(link));
    const head = h('button', { class: `nav-group${isClosed ? ' closed' : ''}`, type: 'button', 'aria-expanded': isClosed ? 'false' : 'true',
      onclick: () => {
        list.hidden = !list.hidden;
        head.classList.toggle('closed', list.hidden);
        head.setAttribute('aria-expanded', list.hidden ? 'false' : 'true');
        if (list.hidden) closed.add(n.group); else closed.delete(n.group);
        safeLocal('nav-closed', [...closed]);
      } }, n.group, icon('caret-down'));
    return [head, list];
  });
  const side = h('nav', { class: 'side', 'aria-label': 'القايمة' },
    h('div', { class: 'brand' }, h('div', { class: 'logo' }, icon('factory')), h('div', {}, h('b', {}, 'Sheet Metal Management'), h('span', {}, 'شركة الصفا'))),
    items,
    h('div', { class: 'foot' },
      h('div', { class: 'who' }, h('b', {}, state.user.display_name), h('span', {}, `نسخة ${state.version}`)),
      h('button', { class: 'icon-btn danger', type: 'button', title: 'خروج', 'aria-label': 'خروج', onclick: async () => { await post('/api/logout'); state.user = null; renderLogin(); } }, icon('sign-out'))));
  side.addEventListener('click', (e) => { if (e.target.closest('a')) side.classList.remove('open'); });
  const bar = h('nav', { class: 'bottom-bar', 'aria-label': 'القايمة السريعة' },
    PHONE_BAR.filter(allowed).map((n) => h('a', { href: n.href, class: isOn(n.href) ? 'on' : null }, icon(n.icon, 'lg'), h('span', {}, n.label))),
    h('button', { type: 'button', 'aria-expanded': 'false', onclick: (e) => {
      const open = side.classList.toggle('open');
      e.currentTarget.setAttribute('aria-expanded', open ? 'true' : 'false');
    } }, icon('dots-three-outline', 'lg'), h('span', {}, 'المزيد')));
  fill(app, h('div', { class: 'shell' }, side, h('main', { id: 'main' }, content)), bar);
}

// ---------- router ----------
const partyRoutes = [
  { path: '#/clients', screen: (m, p, c) => partyList(m, 'client', c) },
  { path: '#/clients/:id', screen: (m, p, c) => partyPage(m, Number(p.id), null, c) },
  { path: '#/clients/:id/:tab', screen: (m, p, c) => partyPage(m, Number(p.id), p.tab, c) },
  { path: '#/suppliers', screen: (m, p, c) => partyList(m, 'supplier', c), any: ['money.view', 'expenses.record'] },
  { path: '#/partners', screen: (m, p, c) => partyList(m, 'partner', c), perm: 'money.view' },
  { path: '#/workers', screen: (m, p, c) => partyList(m, 'worker', c), any: ['money.view', 'expenses.record'] },
  { path: '#/parties/:id', screen: (m, p, c) => partyPage(m, Number(p.id), null, c) },
  { path: '#/parties/:id/:tab', screen: (m, p, c) => partyPage(m, Number(p.id), p.tab, c) },
  { path: '#/settings', screen: (m, p, c) => settingsPage(m, null, c), any: ['settings', 'users', 'import'] },
  { path: '#/settings/:tab', screen: (m, p, c) => settingsPage(m, p.tab, c), any: ['settings', 'users', 'import'] },
];

function compile(r) {
  const names = [];
  const re = new RegExp(`^${r.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; })}$`);
  return { ...r, re, names, literal: !names.length };
}
const ROUTES = [...partyRoutes, ...ops.routes, ...pricing.routes, ...treasury.routes, ...reports.routes, ...imp.routes].map(compile)
  .sort((a, b) => Number(b.literal) - Number(a.literal) || a.names.length - b.names.length);

function match(path) {
  for (const r of ROUTES) {
    const m = path.match(r.re);
    if (m) return { r, params: Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}

let routeSeq = 0;
export async function route() {
  const seq = ++routeSeq;
  const hash = location.hash || '#/';
  const [path, q = ''] = hash.split('?');
  const main = h('div', {}, skeleton());
  shell(main);
  window.scrollTo(0, 0);
  const ctx = { state, can, canAny, go, refresh: route, loadLookups, query: Object.fromEntries(new URLSearchParams(q)) };
  try {
    if (path === '#/' || path === '' || path === '#') {
      if (can('money.view')) await reports.homeAdmin(main, {}, ctx);
      else await ops.homeStaff(main, {}, ctx);
      return;
    }
    const found = match(path);
    if (!found) {
      fill(main, emptyState('warning-circle', 'الصفحة دي مش موجودة', 'ارجع للرئيسية من القايمة.', button('الرئيسية', { href: '#/', icon: 'house' })));
      return;
    }
    if (!allowed(found.r)) {
      fill(main, emptyState('lock-key', 'الصفحة دي مش ليك', 'لو محتاجها اطلب الصلاحية من الأدمن.', button('الرئيسية', { href: '#/', icon: 'house' })));
      return;
    }
    await found.r.screen(main, found.params, ctx);
  } catch (ex) {
    if (seq !== routeSeq) return; // the user already moved on
    fill(main, emptyState('warning', 'حصلت مشكلة', ex.message, button('جرب تاني', { icon: 'arrows-clockwise', onClick: route })));
  }
}
export const go = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };

boot();
