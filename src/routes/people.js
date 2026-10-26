// Users, clients, technicians and the lookup lists the entry screens need.
import { Router } from 'express';
import { getDb, audit } from '../db.js';
import { requirePerm, requireUser, hashPassword, checkPasswordRule, publicUser } from '../auth.js';
import { PERMISSIONS, ROLE_NAMES, can } from '../permissions.js';
import { toPiastres, stripMoney, CLIENT_MONEY_FIELDS } from '../money.js';
import { httpError, cleanText, parseDate } from '../util.js';

export const people = Router();

// ---------- lookups (any signed-in user) ----------
people.get('/lookups', requireUser, (_req, res) => {
  const db = getDb();
  res.json({
    machines: db.prepare('SELECT id, code, name FROM machines WHERE active = 1 ORDER BY sort').all(),
    materials: db.prepare('SELECT id, name, aliases FROM materials WHERE active = 1 ORDER BY sort').all()
      .map((m) => ({ ...m, aliases: JSON.parse(m.aliases) })),
    technicians: db.prepare('SELECT id, name, digit_system FROM technicians WHERE active = 1 ORDER BY name').all(),
    clients: db.prepare('SELECT id, name FROM clients WHERE active = 1 ORDER BY name').all(),
  });
});

// ---------- users (admin) ----------
people.get('/users', requirePerm('users.manage'), (_req, res) => {
  const rows = getDb().prepare('SELECT * FROM users ORDER BY role, display_name').all();
  res.json({ users: rows.map(publicUser), roles: ROLE_NAMES, permissions: PERMISSIONS });
});

people.post('/users', requirePerm('users.manage'), (req, res) => {
  const { username, display_name, password, role } = req.body || {};
  const u = cleanText(username, 40);
  if (!u) throw httpError(400, 'اكتب اسم المستخدم');
  if (!(role in ROLE_NAMES)) throw httpError(400, 'اختار الدور');
  checkPasswordRule(password);
  const db = getDb();
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(u)) throw httpError(409, 'اسم المستخدم ده موجود');
  const id = db.transaction(() => {
    const r = db.prepare('INSERT INTO users (username, display_name, password_hash, role) VALUES (?,?,?,?)')
      .run(u, cleanText(display_name, 60) || u, hashPassword(password), role);
    audit(req.user.id, 'create', 'user', r.lastInsertRowid, undefined, { username: u, role });
    return r.lastInsertRowid;
  })();
  res.status(201).json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)) });
});

people.patch('/users/:id', requirePerm('users.manage'), (req, res) => {
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
    db.prepare(`UPDATE users SET display_name=?, role=?, active=?, password_hash=?, failed_attempts=?, locked_until=? WHERE id=?`)
      .run(next.display_name, next.role, next.active, next.password_hash, next.failed_attempts, next.locked_until, user.id);
    if (!next.active || b.password) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    audit(req.user.id, 'update', 'user', user.id,
      { display_name: user.display_name, role: user.role, active: user.active },
      { display_name: next.display_name, role: next.role, active: next.active, password_changed: !!b.password });
  })();
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) });
});

// ---------- clients ----------
// Balance becomes real in step 2 (pricing + payments); for now it is the opening balance.
const clientRow = (c) => ({ ...c, active: !!c.active, balance: c.opening_balance });

people.get('/clients', requireUser, (req, res) => {
  const rows = getDb().prepare('SELECT * FROM clients ORDER BY active DESC, name').all().map(clientRow);
  res.json({ clients: stripMoney(req.user, rows, CLIENT_MONEY_FIELDS) });
});

people.get('/clients/:id', requireUser, (req, res) => {
  const c = getDb().prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!c) throw httpError(404, 'العميل مش موجود');
  res.json({ client: stripMoney(req.user, clientRow(c), CLIENT_MONEY_FIELDS) });
});

function clientInput(req, current = {}) {
  const b = req.body || {};
  const out = {
    name: b.name !== undefined ? cleanText(b.name, 80) : current.name,
    phone: b.phone !== undefined ? cleanText(b.phone, 40) : current.phone ?? '',
    notes: b.notes !== undefined ? cleanText(b.notes, 500) : current.notes ?? '',
    active: b.active !== undefined ? (b.active ? 1 : 0) : current.active ?? 1,
    opening_balance: current.opening_balance ?? 0,
    opening_date: current.opening_date ?? null,
  };
  if (!out.name) throw httpError(400, 'اكتب اسم العميل');
  // Money fields are silently ignored for users who can't see money.
  if (can(req.user, 'money.view')) {
    if (b.opening_balance !== undefined) {
      const p = toPiastres(b.opening_balance);
      if (Number.isNaN(p)) throw httpError(400, 'رصيد أول المدة رقم غلط');
      out.opening_balance = p;
    }
    if (b.opening_date !== undefined) {
      const d = parseDate(b.opening_date);
      if (d === undefined) throw httpError(400, 'تاريخ أول المدة غلط');
      out.opening_date = d;
    }
  }
  return out;
}

people.post('/clients', requirePerm('clients.edit'), (req, res) => {
  const db = getDb();
  const c = clientInput(req);
  if (db.prepare('SELECT 1 FROM clients WHERE name = ?').get(c.name)) throw httpError(409, 'العميل ده موجود بنفس الاسم');
  const id = db.transaction(() => {
    const r = db.prepare('INSERT INTO clients (name, phone, notes, active, opening_balance, opening_date) VALUES (?,?,?,?,?,?)')
      .run(c.name, c.phone, c.notes, c.active, c.opening_balance, c.opening_date);
    audit(req.user.id, 'create', 'client', r.lastInsertRowid, undefined, c);
    return r.lastInsertRowid;
  })();
  const row = clientRow(db.prepare('SELECT * FROM clients WHERE id = ?').get(id));
  res.status(201).json({ client: stripMoney(req.user, row, CLIENT_MONEY_FIELDS) });
});

people.patch('/clients/:id', requirePerm('clients.edit'), (req, res) => {
  const db = getDb();
  const cur = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!cur) throw httpError(404, 'العميل مش موجود');
  const c = clientInput(req, cur);
  if (c.name !== cur.name && db.prepare('SELECT 1 FROM clients WHERE name = ? AND id <> ?').get(c.name, cur.id)) {
    throw httpError(409, 'فيه عميل تاني بنفس الاسم');
  }
  db.transaction(() => {
    db.prepare('UPDATE clients SET name=?, phone=?, notes=?, active=?, opening_balance=?, opening_date=? WHERE id=?')
      .run(c.name, c.phone, c.notes, c.active, c.opening_balance, c.opening_date, cur.id);
    audit(req.user.id, 'update', 'client', cur.id, cur, c);
  })();
  const row = clientRow(db.prepare('SELECT * FROM clients WHERE id = ?').get(cur.id));
  res.json({ client: stripMoney(req.user, row, CLIENT_MONEY_FIELDS) });
});

// ---------- technicians ----------
people.get('/technicians', requireUser, (_req, res) => {
  const rows = getDb().prepare('SELECT * FROM technicians ORDER BY active DESC, name').all();
  res.json({ technicians: rows.map((t) => ({ ...t, active: !!t.active })) });
});

function techInput(b, cur = {}) {
  const t = {
    name: b.name !== undefined ? cleanText(b.name, 60) : cur.name,
    digit_system: b.digit_system !== undefined ? b.digit_system : cur.digit_system ?? 'arabic',
    active: b.active !== undefined ? (b.active ? 1 : 0) : cur.active ?? 1,
  };
  if (!t.name) throw httpError(400, 'اكتب اسم الفني');
  if (!['arabic', 'western'].includes(t.digit_system)) throw httpError(400, 'نوع الأرقام غلط');
  return t;
}

people.post('/technicians', requirePerm('technicians.edit'), (req, res) => {
  const db = getDb();
  const t = techInput(req.body || {});
  if (db.prepare('SELECT 1 FROM technicians WHERE name = ?').get(t.name)) throw httpError(409, 'الفني ده موجود');
  const id = db.transaction(() => {
    const r = db.prepare('INSERT INTO technicians (name, digit_system, active) VALUES (?,?,?)').run(t.name, t.digit_system, t.active);
    audit(req.user.id, 'create', 'technician', r.lastInsertRowid, undefined, t);
    return r.lastInsertRowid;
  })();
  res.status(201).json({ technician: db.prepare('SELECT * FROM technicians WHERE id = ?').get(id) });
});

people.patch('/technicians/:id', requirePerm('technicians.edit'), (req, res) => {
  const db = getDb();
  const cur = db.prepare('SELECT * FROM technicians WHERE id = ?').get(req.params.id);
  if (!cur) throw httpError(404, 'الفني مش موجود');
  const t = techInput(req.body || {}, cur);
  if (t.name !== cur.name && db.prepare('SELECT 1 FROM technicians WHERE name = ? AND id <> ?').get(t.name, cur.id)) {
    throw httpError(409, 'فيه فني تاني بنفس الاسم');
  }
  db.transaction(() => {
    db.prepare('UPDATE technicians SET name=?, digit_system=?, active=? WHERE id=?').run(t.name, t.digit_system, t.active, cur.id);
    audit(req.user.id, 'update', 'technician', cur.id, cur, t);
  })();
  res.json({ technician: db.prepare('SELECT * FROM technicians WHERE id = ?').get(cur.id) });
});
