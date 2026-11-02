// سجل التعديلات: who did what and when, from audit_log, with filters.
// A user who sees money gets every entry with its before / after.
// Anyone else (the reports permission without money.view) gets only the operations side
// (sheets, lines, work orders, technicians, materials, follow-ups, non-partner parties),
// with every money field AND every free-text field removed (a description or a reason can
// carry an amount), and text search limited to the entry kind.
import { getDb } from '../db.js';
import { can } from '../permissions.js';
import { stripMoney } from '../money.js';

export const ENTITY_NAMES = {
  txn: 'قيد', month: 'إقفال الشهر', user: 'مستخدم', party: 'طرف', technician: 'فني', material: 'خامة',
  expense_category: 'بند مصروف', settings: 'الإعدادات', backup: 'نسخة احتياطية', app: 'تحديث البرنامج',
  op_sheet: 'ورقة تشغيل', op_line: 'بند تشغيل', work_order: 'أمر شغل', photo_job: 'صورة ورقة',
  pricing_batch: 'تسعير وترحيل', price_item: 'بند تسعير', general_price: 'الأسعار العامة', client_rate: 'سعر عميل',
  receipt: 'إيصال استلام', voucher: 'إذن صرف', cheque: 'شيك', transfer: 'تحويل', cash_count: 'جرد الخزينة',
  recurring_expense: 'مصروف متكرر', follow_up: 'متابعة تحصيل', import_run: 'استيراد من الإكسيل',
};
export const ACTION_NAMES = {
  create: 'إضافة', update: 'تعديل', delete: 'حذف', post: 'ترحيل', reverse: 'إلغاء بقيد عكسي', cancel: 'إلغاء',
  approve: 'اعتماد', lock: 'إقفال', unlock: 'فتح', setup: 'تجهيز البرنامج', lockout: 'قفل الدخول', backup: 'نسخة احتياطية',
  restore: 'استرجاع نسخة', done: 'خلصت', reopen: 'رجعت مفتوحة',
};

// What a user without money.view may see at all.
export const OPS_ENTITIES = new Set(['op_sheet', 'op_line', 'sheet', 'work_order', 'photo_job', 'technician', 'material', 'follow_up', 'party']);
const TEXT_KEYS = new Set(['description', 'reason', 'note', 'notes', 'memo', 'detail', 'cancel_reason', 'bounce_reason', 'summary', 'error']);

function stripText(v) {
  if (Array.isArray(v)) return v.map(stripText);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) if (!TEXT_KEYS.has(k)) out[k] = stripText(x);
    return out;
  }
  return v;
}

const parse = (s) => { if (s === null || s === undefined) return null; try { return JSON.parse(s); } catch { return null; } };

// filters: { from, to, userId, entity, action, entityId, q, beforeId, limit }
export function auditEntries(user, f = {}) {
  const money = can(user, 'money.view');
  const limit = Math.min(Math.max(Number(f.limit) || 100, 1), 500);
  const where = ['1 = 1'];
  const args = [];
  if (f.from) { where.push('a.at >= ?'); args.push(`${f.from} 00:00:00`); }
  if (f.to) { where.push('a.at <= ?'); args.push(`${f.to} 23:59:59`); }
  if (f.userId) { where.push('a.user_id = ?'); args.push(f.userId); }
  if (f.entity) { where.push('a.entity = ?'); args.push(f.entity); }
  if (f.action) { where.push('a.action = ?'); args.push(f.action); }
  if (f.entityId) { where.push('a.entity_id = ?'); args.push(f.entityId); }
  if (f.beforeId) { where.push('a.id < ?'); args.push(f.beforeId); }
  if (!money) {
    where.push(`a.entity IN (${[...OPS_ENTITIES].map(() => '?').join(',')})`);
    args.push(...OPS_ENTITIES);
    // Partners are money only: their audit entries are too.
    where.push("NOT (a.entity = 'party' AND EXISTS (SELECT 1 FROM parties px WHERE px.id = a.entity_id AND px.kind = 'partner'))");
  }
  if (f.q) {
    const like = `%${String(f.q).replace(/[%_]/g, '')}%`;
    if (money) { where.push('(a.before_json LIKE ? OR a.after_json LIKE ? OR a.entity LIKE ? OR a.action LIKE ?)'); args.push(like, like, like, like); }
    else { where.push('(a.entity LIKE ? OR a.action LIKE ?)'); args.push(like, like); }
  }
  const rows = getDb().prepare(`
    SELECT a.id, a.at, a.user_id, a.action, a.entity, a.entity_id, a.before_json, a.after_json, u.display_name AS user_name
    FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
    WHERE ${where.join(' AND ')} ORDER BY a.id DESC LIMIT ?`).all(...args, limit + 1);
  const more = rows.length > limit;
  const entries = rows.slice(0, limit).map((r) => {
    let before = parse(r.before_json);
    let after = parse(r.after_json);
    if (!money) { before = stripText(stripMoney(user, before)); after = stripText(stripMoney(user, after)); }
    return {
      id: r.id, at: r.at, user_id: r.user_id, user_name: r.user_name || 'النظام',
      action: r.action, action_name: ACTION_NAMES[r.action] || r.action,
      entity: r.entity, entity_name: ENTITY_NAMES[r.entity] || r.entity, entity_id: r.entity_id,
      before, after,
    };
  });
  return { entries, more, next_before_id: more ? entries.at(-1).id : null, money_hidden: !money };
}

export function auditFilters(user) {
  const money = can(user, 'money.view');
  const db = getDb();
  const entities = db.prepare('SELECT DISTINCT entity FROM audit_log ORDER BY entity').all().map((r) => r.entity)
    .filter((e) => money || OPS_ENTITIES.has(e));
  const actions = db.prepare('SELECT DISTINCT action FROM audit_log ORDER BY action').all().map((r) => r.action);
  const users = db.prepare('SELECT id, display_name FROM users ORDER BY display_name').all();
  return {
    entities: entities.map((e) => ({ code: e, name: ENTITY_NAMES[e] || e })),
    actions: actions.map((a) => ({ code: a, name: ACTION_NAMES[a] || a })),
    users,
  };
}
