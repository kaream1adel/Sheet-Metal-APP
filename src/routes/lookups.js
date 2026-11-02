// The lists every screen needs: technicians, materials (density, group, aliases), expense
// categories, machines and pricing sections, general prices (read; pricing module writes).
import { Router } from 'express';
import { getDb, audit } from '../db.js';
import { requireUser, requirePerm, requireAny } from '../auth.js';
import { stripMoney } from '../money.js';
import { getSettings } from '../settings.js';
import { httpError, cleanText, parseNumber } from '../util.js';
import { MACHINES, MACHINE_NAMES, SECTIONS, SECTION_NAMES, ensureExpenseAccount } from '../ledger.js';

export const lookups = Router();

const json = (s) => { try { return JSON.parse(s || '[]'); } catch { return []; } };
const aliasList = (v) => {
  const list = typeof v === 'string' ? v.split(/[،,\n]/) : Array.isArray(v) ? v : [];
  return [...new Set(list.map((a) => cleanText(a, 60)).filter(Boolean))].slice(0, 30);
};

const technicians = () => getDb().prepare('SELECT * FROM technicians ORDER BY active DESC, name').all()
  .map((t) => ({ ...t, active: !!t.active }));
const materials = () => getDb().prepare('SELECT * FROM materials ORDER BY active DESC, sort, name').all()
  .map((m) => ({ id: m.id, name: m.name, aliases: json(m.aliases), density: m.density, grp: m.grp, sort: m.sort, active: !!m.active }));
const categories = () => getDb().prepare('SELECT * FROM expense_categories ORDER BY active DESC, sort, name').all()
  .map((c) => ({ id: c.id, name: c.name, keywords: json(c.keywords), sort: c.sort, active: !!c.active }));
const generalPrices = () => getDb().prepare('SELECT section, band, rate, min_charge, updated_at FROM general_prices ORDER BY id').all();

// Everything at once, for the entry screens (any signed-in user; prices stripped for staff).
lookups.get('/lookups', requireUser, (req, res) => {
  res.json(stripMoney(req.user, {
    machines: MACHINES.map((code) => ({ code, name: MACHINE_NAMES[code] })),
    sections: SECTIONS.map((code) => ({ code, name: SECTION_NAMES[code] })),
    technicians: technicians().filter((t) => t.active),
    materials: materials().filter((m) => m.active),
    expense_categories: categories().filter((c) => c.active),
    general_prices: generalPrices(),
    ai_enabled: !!getSettings().ai_enabled && !!getSettings().ai_api_key, // never the key
  }));
});

lookups.get('/general-prices', requireUser, (req, res) => {
  res.json(stripMoney(req.user, { general_prices: generalPrices() }));
});

// ---------- technicians ----------
lookups.get('/technicians', requireUser, (_req, res) => res.json({ technicians: technicians() }));

function techInput(b, cur = {}) {
  const t = {
    name: b.name !== undefined ? cleanText(b.name, 60) : cur.name,
    machine: b.machine !== undefined ? (b.machine || null) : cur.machine ?? null,
    active: b.active !== undefined ? (b.active ? 1 : 0) : cur.active ?? 1,
  };
  if (!t.name) throw httpError(400, 'اكتب اسم الفني');
  if (t.machine && !MACHINES.includes(t.machine)) throw httpError(400, 'المكنة غلط');
  return t;
}

const techPerm = requireAny('settings', 'operations.record');
lookups.post('/technicians', techPerm, (req, res) => {
  const db = getDb();
  const t = techInput(req.body || {});
  if (db.prepare('SELECT 1 FROM technicians WHERE name = ?').get(t.name)) throw httpError(409, 'الفني ده موجود');
  const id = db.transaction(() => {
    const r = db.prepare('INSERT INTO technicians (name, machine, active) VALUES (?,?,?)').run(t.name, t.machine, t.active);
    audit(req.user.id, 'create', 'technician', r.lastInsertRowid, undefined, t);
    return r.lastInsertRowid;
  })();
  res.status(201).json({ technician: db.prepare('SELECT * FROM technicians WHERE id = ?').get(id) });
});

lookups.patch('/technicians/:id', techPerm, (req, res) => {
  const db = getDb();
  const cur = db.prepare('SELECT * FROM technicians WHERE id = ?').get(req.params.id);
  if (!cur) throw httpError(404, 'الفني مش موجود');
  const t = techInput(req.body || {}, cur);
  if (t.name !== cur.name && db.prepare('SELECT 1 FROM technicians WHERE name = ? AND id <> ?').get(t.name, cur.id)) {
    throw httpError(409, 'فيه فني تاني بنفس الاسم');
  }
  db.transaction(() => {
    db.prepare('UPDATE technicians SET name=?, machine=?, active=? WHERE id=?').run(t.name, t.machine, t.active, cur.id);
    audit(req.user.id, 'update', 'technician', cur.id, cur, t);
  })();
  res.json({ technician: db.prepare('SELECT * FROM technicians WHERE id = ?').get(cur.id) });
});

// ---------- materials ----------
lookups.get('/materials', requireUser, (_req, res) => res.json({ materials: materials() }));

function materialInput(b, cur = {}) {
  const m = {
    name: b.name !== undefined ? cleanText(b.name, 60) : cur.name,
    aliases: b.aliases !== undefined ? aliasList(b.aliases) : json(cur.aliases),
    density: b.density !== undefined ? parseNumber(b.density) : cur.density ?? null,
    grp: b.grp !== undefined ? cleanText(b.grp, 40) : cur.grp ?? '',
    sort: b.sort !== undefined ? Number(b.sort) || 0 : cur.sort ?? 0,
    active: b.active !== undefined ? (b.active ? 1 : 0) : cur.active ?? 1,
  };
  if (!m.name) throw httpError(400, 'اكتب اسم الخامة');
  if (m.density !== null && !(m.density > 0 && m.density < 30)) throw httpError(400, 'الكثافة رقم غلط (مثال 7.85)');
  m.aliases = m.aliases.filter((a) => a !== m.name);
  return m;
}

const setPerm = requirePerm('settings');
lookups.post('/materials', setPerm, (req, res) => {
  const db = getDb();
  const m = materialInput(req.body || {});
  if (db.prepare('SELECT 1 FROM materials WHERE name = ?').get(m.name)) throw httpError(409, 'الخامة دي موجودة');
  const id = db.transaction(() => {
    const r = db.prepare('INSERT INTO materials (name, aliases, density, grp, sort, active) VALUES (?,?,?,?,?,?)')
      .run(m.name, JSON.stringify(m.aliases), m.density, m.grp, m.sort, m.active);
    audit(req.user.id, 'create', 'material', r.lastInsertRowid, undefined, m);
    return r.lastInsertRowid;
  })();
  res.status(201).json({ material: materials().find((x) => x.id === Number(id)) });
});

lookups.patch('/materials/:id', setPerm, (req, res) => {
  const db = getDb();
  const cur = db.prepare('SELECT * FROM materials WHERE id = ?').get(req.params.id);
  if (!cur) throw httpError(404, 'الخامة مش موجودة');
  const m = materialInput(req.body || {}, cur);
  if (m.name !== cur.name && db.prepare('SELECT 1 FROM materials WHERE name = ? AND id <> ?').get(m.name, cur.id)) {
    throw httpError(409, 'فيه خامة تانية بنفس الاسم');
  }
  db.transaction(() => {
    db.prepare('UPDATE materials SET name=?, aliases=?, density=?, grp=?, sort=?, active=? WHERE id=?')
      .run(m.name, JSON.stringify(m.aliases), m.density, m.grp, m.sort, m.active, cur.id);
    audit(req.user.id, 'update', 'material', cur.id, cur, m);
  })();
  res.json({ material: materials().find((x) => x.id === cur.id) });
});

// ---------- expense categories (بنود المصروفات) ----------
lookups.get('/expense-categories', requireUser, (_req, res) => res.json({ expense_categories: categories() }));

function categoryInput(b, cur = {}) {
  const c = {
    name: b.name !== undefined ? cleanText(b.name, 60) : cur.name,
    keywords: b.keywords !== undefined ? aliasList(b.keywords) : json(cur.keywords),
    sort: b.sort !== undefined ? Number(b.sort) || 0 : cur.sort ?? 0,
    active: b.active !== undefined ? (b.active ? 1 : 0) : cur.active ?? 1,
  };
  if (!c.name) throw httpError(400, 'اكتب اسم البند');
  return c;
}

lookups.post('/expense-categories', setPerm, (req, res) => {
  const db = getDb();
  const c = categoryInput(req.body || {});
  if (db.prepare('SELECT 1 FROM expense_categories WHERE name = ?').get(c.name)) throw httpError(409, 'البند ده موجود');
  if (!req.body?.sort) c.sort = (db.prepare('SELECT COALESCE(MAX(sort), 0) m FROM expense_categories').get().m || 0) + 1;
  const id = db.transaction(() => {
    const r = db.prepare('INSERT INTO expense_categories (name, keywords, sort, active) VALUES (?,?,?,?)')
      .run(c.name, JSON.stringify(c.keywords), c.sort, c.active);
    const cid = Number(r.lastInsertRowid);
    ensureExpenseAccount({ id: cid, name: c.name, sort: c.sort });
    audit(req.user.id, 'create', 'expense_category', cid, undefined, c);
    return cid;
  })();
  res.status(201).json({ expense_category: categories().find((x) => x.id === id) });
});

lookups.patch('/expense-categories/:id', setPerm, (req, res) => {
  const db = getDb();
  const cur = db.prepare('SELECT * FROM expense_categories WHERE id = ?').get(req.params.id);
  if (!cur) throw httpError(404, 'البند مش موجود');
  const c = categoryInput(req.body || {}, cur);
  if (c.name !== cur.name && db.prepare('SELECT 1 FROM expense_categories WHERE name = ? AND id <> ?').get(c.name, cur.id)) {
    throw httpError(409, 'فيه بند تاني بنفس الاسم');
  }
  db.transaction(() => {
    db.prepare('UPDATE expense_categories SET name=?, keywords=?, sort=?, active=? WHERE id=?')
      .run(c.name, JSON.stringify(c.keywords), c.sort, c.active, cur.id);
    ensureExpenseAccount({ id: cur.id, name: c.name, sort: c.sort });
    audit(req.user.id, 'update', 'expense_category', cur.id, cur, c);
  })();
  res.json({ expense_category: categories().find((x) => x.id === cur.id) });
});
