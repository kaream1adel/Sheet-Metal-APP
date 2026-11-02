// Users and their permissions (admin: permission "users").
import { Router } from 'express';
import { getDb, audit } from '../db.js';
import { requirePerm, hashPassword, checkPasswordRule, publicUser } from '../auth.js';
import { PERMISSIONS, ROLE_NAMES, ROLE_PERMISSIONS } from '../permissions.js';
import { httpError, cleanText } from '../util.js';

export const users = Router();
const perm = requirePerm('users');

users.get('/users', perm, (_req, res) => {
  const rows = getDb().prepare('SELECT * FROM users ORDER BY role, display_name').all();
  res.json({ users: rows.map(publicUser), roles: ROLE_NAMES, permissions: PERMISSIONS, role_permissions: ROLE_PERMISSIONS });
});

function extraPermissions(list, role) {
  if (list === undefined) return undefined;
  if (!Array.isArray(list)) throw httpError(400, 'الصلاحيات لازم تكون قايمة');
  const base = new Set(ROLE_PERMISSIONS[role] || []);
  return [...new Set(list.filter((p) => p in PERMISSIONS && !base.has(p)))];
}

users.post('/users', perm, (req, res) => {
  const { username, display_name, password, role, extra_permissions } = req.body || {};
  const u = cleanText(username, 40);
  if (!u) throw httpError(400, 'اكتب اسم المستخدم');
  if (!(role in ROLE_NAMES)) throw httpError(400, 'اختار الدور');
  checkPasswordRule(password);
  const db = getDb();
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(u)) throw httpError(409, 'اسم المستخدم ده موجود');
  const extra = extraPermissions(extra_permissions, role) || [];
  const id = db.transaction(() => {
    const r = db.prepare('INSERT INTO users (username, display_name, password_hash, role, extra_permissions) VALUES (?,?,?,?,?)')
      .run(u, cleanText(display_name, 60) || u, hashPassword(password), role, JSON.stringify(extra));
    audit(req.user.id, 'create', 'user', r.lastInsertRowid, undefined, { username: u, role, extra_permissions: extra });
    return r.lastInsertRowid;
  })();
  res.status(201).json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)) });
});

users.patch('/users/:id', perm, (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) throw httpError(404, 'المستخدم مش موجود');
  const b = req.body || {};
  const next = { ...user };
  if (b.display_name !== undefined) next.display_name = cleanText(b.display_name, 60) || user.display_name;
  if (b.role !== undefined) {
    if (!(b.role in ROLE_NAMES)) throw httpError(400, 'دور غلط');
    next.role = b.role;
  }
  const extra = extraPermissions(b.extra_permissions, next.role);
  if (extra !== undefined) next.extra_permissions = JSON.stringify(extra);
  if (b.active !== undefined) next.active = b.active ? 1 : 0;
  if (b.password) {
    checkPasswordRule(b.password);
    next.password_hash = hashPassword(b.password);
    next.failed_attempts = 0;
    next.locked_until = null;
  }
  // Never leave the app without an active admin.
  if (user.role === 'admin' && (next.role !== 'admin' || !next.active)) {
    const admins = db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND active = 1 AND id <> ?").get(user.id).n;
    if (!admins) throw httpError(400, 'لازم يفضل فيه أدمن واحد على الأقل');
  }
  db.transaction(() => {
    db.prepare(`UPDATE users SET display_name=?, role=?, extra_permissions=?, active=?, password_hash=?, failed_attempts=?, locked_until=? WHERE id=?`)
      .run(next.display_name, next.role, next.extra_permissions, next.active, next.password_hash, next.failed_attempts, next.locked_until, user.id);
    if (!next.active || b.password) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    audit(req.user.id, 'update', 'user', user.id,
      { display_name: user.display_name, role: user.role, active: user.active, extra_permissions: user.extra_permissions },
      { display_name: next.display_name, role: next.role, active: next.active, extra_permissions: next.extra_permissions, password_changed: !!b.password });
  })();
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) });
});
