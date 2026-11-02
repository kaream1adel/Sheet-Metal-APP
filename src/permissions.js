// Every screen and action checks a permission, never a role name (requirePerm in auth.js),
// so per-user privileges can be added without touching the routes.

export const PERMISSIONS = {
  'money.view': 'يشوف الفلوس (الأسعار والأرصدة والخزينة)',
  'money.post': 'يسجل حركات فلوس (قيود وأرصدة أول المدة)',
  pricing: 'التسعير والترحيل',
  treasury: 'الخزينة والبنك',
  'expenses.record': 'يسجل أذونات صرف',
  cheques: 'الشيكات',
  reports: 'التقارير',
  settings: 'الإعدادات والنسخ الاحتياطي والتحديث',
  users: 'المستخدمين والصلاحيات',
  import: 'الاستيراد من الإكسيل',
  'operations.record': 'يسجل أوراق التشغيل ويصورها',
  'operations.approve': 'يراجع ويعتمد أوراق التشغيل',
  workorders: 'أوامر الشغل',
};

export const ROLE_PERMISSIONS = {
  admin: Object.keys(PERMISSIONS),
  // The workshop manager: the whole operations side, never money.
  staff: ['operations.record', 'operations.approve', 'workorders', 'expenses.record'],
};

export const ROLE_NAMES = { admin: 'أدمن', staff: 'مدير الورشة' };

export function permissionsOf(user) {
  if (!user) return new Set();
  let extra = [];
  try { extra = JSON.parse(user.extra_permissions || '[]'); } catch { /* ignore bad json */ }
  return new Set([...(ROLE_PERMISSIONS[user.role] || []), ...extra.filter((p) => p in PERMISSIONS)]);
}

export const can = (user, perm) => permissionsOf(user).has(perm);
export const canAny = (user, ...perms) => perms.some((p) => can(user, p));
