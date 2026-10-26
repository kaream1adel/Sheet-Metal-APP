// Every screen and action checks a permission, never a role name, so new roles or
// per-user privileges can be added later without touching the routes.

export const PERMISSIONS = {
  'sheets.create': 'إدخال وتصوير الورق',
  'sheets.review': 'مراجعة الورق',
  'sheets.confirm': 'تأكيد الورق',
  'sheets.cancel': 'إلغاء ورقة متأكدة',
  'production.view': 'عرض الإنتاج',
  'clients.edit': 'إضافة وتعديل العملاء',
  'technicians.edit': 'إضافة وتعديل الفنيين',
  'machines.edit': 'تعديل المكن والخامات',
  'money.view': 'الأسعار والحسابات والمدفوعات',
  'users.manage': 'المستخدمين والصلاحيات',
  'settings.manage': 'الإعدادات والتحديثات والنسخ الاحتياطي',
};

export const ROLE_PERMISSIONS = {
  admin: Object.keys(PERMISSIONS),
  staff: ['sheets.create', 'sheets.review', 'sheets.confirm', 'production.view', 'clients.edit', 'technicians.edit'],
};

export const ROLE_NAMES = { admin: 'أدمن', staff: 'مدير الورشة' };

export function permissionsOf(user) {
  if (!user) return new Set();
  let extra = [];
  try { extra = JSON.parse(user.extra_permissions || '[]'); } catch { /* ignore bad json */ }
  return new Set([...(ROLE_PERMISSIONS[user.role] || []), ...extra.filter((p) => p in PERMISSIONS)]);
}

export const can = (user, perm) => permissionsOf(user).has(perm);
