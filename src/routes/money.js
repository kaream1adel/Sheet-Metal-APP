// Everything with money in it. Every route here requires money.view (admin).
import { Router } from 'express';
import { getDb, audit } from '../db.js';
import { requirePerm } from '../auth.js';
import { httpError, cleanText, parseDate, parseNumber, todayISO } from '../util.js';
import { toPiastres } from '../money.js';
import { UNITS, unitsFor, lineQty, amountOf, defaultUnits } from '../units.js';
import { LINE_SELECT, workText, statement, balanceOf, openDebts } from '../ledger.js';
import { getSettings, setSettings, publicSettings, DEFAULT_SETTINGS } from '../settings.js';
import { MACHINE_FIELDS } from '../sheets.js';

export const money = Router();
const admin = requirePerm('money.view');

const UNPRICED = `
  s.status = 'confirmed'
  AND NOT EXISTS (SELECT 1 FROM line_prices p WHERE p.line_id = l.id AND p.status = 'active')
  AND NOT EXISTS (SELECT 1 FROM billing_item_lines bl JOIN billing_items b ON b.id = bl.item_id
                  WHERE bl.line_id = l.id AND b.status = 'active')`;

const rateOrThrow = (v, what) => {
  const p = toPiastres(v);
  if (Number.isNaN(p) || p < 0) throw httpError(400, `${what}: السعر رقم غلط`);
  return p;
};
const clientOrThrow = (id) => {
  const c = getDb().prepare('SELECT * FROM clients WHERE id = ?').get(id);
  if (!c) throw httpError(404, 'العميل مش موجود');
  return c;
};
const dateOr = (v, fallback, what) => {
  if (!v) return fallback;
  const d = parseDate(v);
  if (!d) throw httpError(400, `${what}: التاريخ غلط`);
  return d;
};

// ---------- price memory ----------
function suggest(clientId, code, unit, materialId, thickness) {
  const db = getDb();
  const m = materialId || 0;
  const t = Number(thickness) || 0;
  const exact = db.prepare('SELECT rate FROM price_memory WHERE client_id=? AND machine_code=? AND unit=? AND material_id=? AND thickness=?')
    .get(clientId, code, unit, m, t);
  if (exact) return { rate: exact.rate, source: 'exact', note: 'آخر سعر لنفس العميل' };
  const near = db.prepare(`SELECT rate, thickness FROM price_memory WHERE client_id=? AND machine_code=? AND unit=?
    ORDER BY (material_id = ?) DESC, ABS(thickness - ?) ASC, updated_at DESC LIMIT 1`).get(clientId, code, unit, m, t);
  if (near) return { rate: near.rate, source: 'near', note: `من سعر نفس العميل لسمك ${near.thickness || '—'}` };
  const other = db.prepare(`SELECT p.rate, c.name FROM price_memory p JOIN clients c ON c.id = p.client_id
    WHERE p.machine_code=? AND p.unit=? AND p.material_id=? AND p.thickness=? ORDER BY p.updated_at DESC LIMIT 1`).get(code, unit, m, t);
  if (other) return { rate: other.rate, source: 'near', note: `من سعر ${other.name}` };
  return { rate: null, source: 'none', note: 'أول مرة — اكتب السعر' };
}

function rememberPrice(clientId, code, unit, materialId, thickness, rate) {
  getDb().prepare(`INSERT INTO price_memory (client_id, machine_code, unit, material_id, thickness, rate) VALUES (?,?,?,?,?,?)
    ON CONFLICT(client_id, machine_code, unit, material_id, thickness) DO UPDATE SET rate = excluded.rate, updated_at = datetime('now')`)
    .run(clientId, code, unit, materialId || 0, Number(thickness) || 0, rate);
  getDb().prepare(`INSERT INTO client_unit_prefs (client_id, machine_code, unit) VALUES (?,?,?)
    ON CONFLICT(client_id, machine_code) DO UPDATE SET unit = excluded.unit`).run(clientId, code, unit);
}

function unpricedLines(clientId) {
  return getDb().prepare(`SELECT x.* FROM (${LINE_SELECT}) x JOIN lines l ON l.id = x.id JOIN sheets s ON s.id = l.sheet_id
    WHERE l.client_id = ? AND ${UNPRICED} ORDER BY x.date, x.machine_code, x.id`).all(clientId);
}

// ---------- pricing ----------
money.get('/pricing/clients', admin, (_req, res) => {
  const rows = getDb().prepare(`
    SELECT c.id, c.name, COUNT(l.id) AS lines, MIN(COALESCE(l.work_date, s.sheet_date)) AS oldest
    FROM lines l JOIN sheets s ON s.id = l.sheet_id JOIN clients c ON c.id = l.client_id
    WHERE ${UNPRICED} GROUP BY c.id ORDER BY oldest`).all();
  res.json({ clients: rows });
});

money.get('/pricing/clients/:id', admin, (req, res) => {
  const client = clientOrThrow(req.params.id);
  const db = getDb();
  const prefs = Object.fromEntries(db.prepare('SELECT machine_code, unit FROM client_unit_prefs WHERE client_id = ?').all(client.id)
    .map((p) => [p.machine_code, p.unit]));
  const lines = unpricedLines(client.id).map((l) => ({
    id: l.id, sheet_id: l.sheet_id, date: l.date, machine_code: l.machine_code, machine_name: l.machine_name,
    text: workText(l), part_name: l.part_name, material_id: l.material_id, thickness: l.thickness,
    facts: Object.fromEntries((MACHINE_FIELDS[l.machine_code] || []).map((f) => [f, l[f]])),
    delivered: l.delivery_date || null,
    units: unitsFor(l.machine_code).map((u) => ({ unit: u, label: UNITS[u].label, qty: lineQty(l, l.machine_code, u) })),
    charges: defaultUnits(l, l.machine_code, prefs[l.machine_code]).map((u) => ({
      unit: u, qty: lineQty(l, l.machine_code, u), ...suggest(client.id, l.machine_code, u, l.material_id, l.thickness),
    })),
  }));
  // Suggested groups: the same part name on two or more machines.
  const byPart = {};
  for (const l of lines) if (l.part_name) (byPart[l.part_name] ||= []).push(l);
  const groups = Object.entries(byPart)
    .filter(([, ls]) => new Set(ls.map((l) => l.machine_code)).size > 1)
    .map(([part, ls]) => ({ part_name: part, line_ids: ls.map((l) => l.id) }));
  res.json({ client: { id: client.id, name: client.name }, balance: balanceOf(client.id), lines, groups,
    units: Object.fromEntries(Object.entries(UNITS).map(([k, u]) => [k, u.label])) });
});

money.post('/pricing/approve', admin, (req, res) => {
  const db = getDb();
  const b = req.body || {};
  const client = clientOrThrow(b.client_id);
  const charges = Array.isArray(b.charges) ? b.charges : [];
  const bundles = Array.isArray(b.bundles) ? b.bundles : [];
  if (!charges.length && !bundles.length) throw httpError(400, 'مفيش سطور متحددة للتسعير');
  const due = dateOr(b.due_date, null, 'موعد الاستحقاق');

  const open = new Map(unpricedLines(client.id).map((l) => [l.id, l]));
  const used = new Set(); // line+unit for charges, line for bundles
  const inBundle = new Set();

  const priced = charges.map((c, i) => {
    const line = open.get(Number(c.line_id));
    if (!line) throw httpError(409, `سطر ${i + 1}: مش من شغل العميل اللي مستني تسعير`);
    if (!UNITS[c.unit] || !UNITS[c.unit].machines.includes(line.machine_code)) throw httpError(400, `${line.machine_name}: وحدة المحاسبة غلط`);
    const key = `${line.id}:${c.unit}`;
    if (used.has(key)) throw httpError(400, `${workText(line)}: نفس الوحدة اتكررت`);
    used.add(key);
    let qty = lineQty(line, line.machine_code, c.unit);
    if (qty === null) {
      qty = parseNumber(c.qty);
      if (!(qty > 0)) throw httpError(400, `${workText(line)}: اكتب الكمية (${UNITS[c.unit].label})`);
    }
    if (!(qty > 0)) throw httpError(400, `${workText(line)}: الكمية صفر بوحدة ${UNITS[c.unit].label}`);
    const rate = rateOrThrow(c.rate, workText(line));
    return { line, unit: c.unit, qty, rate, amount: amountOf(qty, rate) };
  });

  const items = bundles.map((g, i) => {
    const ids = (Array.isArray(g.line_ids) ? g.line_ids : []).map(Number);
    if (!ids.length) throw httpError(400, `بند ${i + 1}: اختار السطور اللي فيه`);
    const lines = ids.map((id) => {
      const l = open.get(id);
      if (!l) throw httpError(409, `بند ${i + 1}: فيه سطر مش مستني تسعير`);
      if (inBundle.has(id)) throw httpError(400, `بند ${i + 1}: سطر موجود في بندين`);
      inBundle.add(id);
      return l;
    });
    const description = cleanText(g.description, 200);
    if (!description) throw httpError(400, `بند ${i + 1}: اكتب وصف البند`);
    if (!UNITS[g.unit]) throw httpError(400, `بند ${i + 1}: وحدة غلط`);
    const qty = g.unit === 'fixed' ? 1 : parseNumber(g.qty);
    if (!(qty > 0)) throw httpError(400, `بند ${i + 1}: اكتب الكمية`);
    const rate = rateOrThrow(g.rate, `بند ${i + 1}`);
    const item_date = dateOr(g.item_date, lines.map((l) => l.date).sort().at(-1), `بند ${i + 1}`);
    return { lines, description, unit: g.unit, qty, rate, amount: amountOf(qty, rate), item_date };
  });

  for (const p of priced) if (inBundle.has(p.line.id)) throw httpError(400, `${workText(p.line)}: السطر في بند مجمّع ومتسعر لوحده كمان`);

  let discount = null;
  if (b.discount && toPiastres(b.discount.amount) > 0) {
    discount = { amount: -rateOrThrow(b.discount.amount, 'الخصم'), reason: cleanText(b.discount.reason, 200) || 'خصم' };
  }

  const batchId = db.transaction(() => {
    const batch = db.prepare('INSERT INTO pricing_batches (client_id, due_date, created_by) VALUES (?,?,?)').run(client.id, due, req.user.id).lastInsertRowid;
    const insP = db.prepare('INSERT INTO line_prices (batch_id, line_id, unit, qty, rate, amount) VALUES (?,?,?,?,?,?)');
    for (const p of priced) {
      insP.run(batch, p.line.id, p.unit, p.qty, p.rate, p.amount);
      rememberPrice(client.id, p.line.machine_code, p.unit, p.line.material_id, p.line.thickness, p.rate);
    }
    const insI = db.prepare('INSERT INTO billing_items (batch_id, client_id, description, unit, qty, rate, amount, item_date) VALUES (?,?,?,?,?,?,?,?)');
    const insIL = db.prepare('INSERT INTO billing_item_lines (item_id, line_id) VALUES (?,?)');
    for (const it of items) {
      const id = insI.run(batch, client.id, it.description, it.unit, it.qty, it.rate, it.amount, it.item_date).lastInsertRowid;
      for (const l of it.lines) insIL.run(id, l.id);
    }
    if (discount) {
      db.prepare('INSERT INTO adjustments (client_id, adj_date, amount, reason, batch_id, created_by) VALUES (?,?,?,?,?,?)')
        .run(client.id, todayISO(), discount.amount, discount.reason, batch, req.user.id);
    }
    audit(req.user.id, 'approve', 'pricing', batch, undefined, {
      client_id: client.id,
      charges: priced.map((p) => ({ line_id: p.line.id, unit: p.unit, qty: p.qty, rate: p.rate, amount: p.amount })),
      items: items.map((it) => ({ description: it.description, unit: it.unit, qty: it.qty, rate: it.rate, lines: it.lines.map((l) => l.id) })),
      discount,
    });
    return batch;
  })();
  const total = priced.reduce((s, p) => s + p.amount, 0) + items.reduce((s, i) => s + i.amount, 0) + (discount?.amount || 0);
  res.status(201).json({ batch_id: batchId, total, balance: balanceOf(client.id) });
});

money.get('/pricing/batches', admin, (req, res) => {
  const rows = getDb().prepare(`
    SELECT b.*, c.name AS client_name, u.display_name AS created_by_name,
      (SELECT COALESCE(SUM(amount),0) FROM line_prices WHERE batch_id = b.id) +
      (SELECT COALESCE(SUM(amount),0) FROM billing_items WHERE batch_id = b.id) +
      (SELECT COALESCE(SUM(amount),0) FROM adjustments WHERE batch_id = b.id) AS total
    FROM pricing_batches b JOIN clients c ON c.id = b.client_id LEFT JOIN users u ON u.id = b.created_by
    WHERE (? IS NULL OR b.client_id = ?) ORDER BY b.id DESC LIMIT 100`).all(req.query.client_id ?? null, req.query.client_id ?? null);
  res.json({ batches: rows });
});

money.post('/pricing/batches/:id/cancel', admin, (req, res) => {
  const db = getDb();
  const batch = db.prepare('SELECT * FROM pricing_batches WHERE id = ?').get(req.params.id);
  if (!batch) throw httpError(404, 'التسعير ده مش موجود');
  if (batch.cancelled_at) throw httpError(409, 'التسعير ده اتلغى قبل كده');
  const reason = cleanText(req.body?.reason, 300);
  if (!reason) throw httpError(400, 'اكتب سبب إلغاء التسعير');
  db.transaction(() => {
    db.prepare("UPDATE line_prices SET status = 'cancelled' WHERE batch_id = ?").run(batch.id);
    db.prepare("UPDATE billing_items SET status = 'cancelled' WHERE batch_id = ?").run(batch.id);
    db.prepare("UPDATE adjustments SET cancelled_by = ?, cancelled_at = datetime('now'), cancel_reason = ? WHERE batch_id = ? AND cancelled_at IS NULL")
      .run(req.user.id, reason, batch.id);
    db.prepare("UPDATE pricing_batches SET cancelled_by = ?, cancelled_at = datetime('now'), cancel_reason = ? WHERE id = ?")
      .run(req.user.id, reason, batch.id);
    audit(req.user.id, 'cancel', 'pricing', batch.id, undefined, { reason });
  })();
  res.json({ ok: true, balance: balanceOf(batch.client_id) });
});

// Admin fixes a quantity on a confirmed, not-yet-priced line (audited).
money.patch('/lines/:id', admin, (req, res) => {
  const db = getDb();
  const line = db.prepare(`SELECT l.*, m.code AS machine_code, s.status AS sheet_status FROM lines l
    JOIN sheets s ON s.id = l.sheet_id JOIN machines m ON m.id = s.machine_id WHERE l.id = ?`).get(req.params.id);
  if (!line) throw httpError(404, 'السطر مش موجود');
  if (line.sheet_status !== 'confirmed') throw httpError(409, 'السطر ده في ورقة مش متأكدة — عدّله من الورقة');
  const priced = db.prepare(`SELECT 1 FROM line_prices WHERE line_id = ? AND status = 'active'
    UNION SELECT 1 FROM billing_item_lines bl JOIN billing_items b ON b.id = bl.item_id WHERE bl.line_id = ? AND b.status = 'active'`).get(line.id, line.id);
  if (priced) throw httpError(409, 'السطر متسعر — ألغي التسعير الأول');
  const allowed = ['thickness', ...(MACHINE_FIELDS[line.machine_code] || []).filter((f) => f !== 'sheet_size')];
  const changes = {};
  for (const [k, v] of Object.entries(req.body || {})) {
    if (!allowed.includes(k)) throw httpError(400, `الخانة ${k} مش من أعمدة المكنة دي`);
    const n = parseNumber(v);
    if (Number.isNaN(n) || (n !== null && n < 0)) throw httpError(400, 'رقم غلط');
    changes[k] = n;
  }
  if (!Object.keys(changes).length) throw httpError(400, 'مفيش تعديل');
  db.transaction(() => {
    db.prepare(`UPDATE lines SET ${Object.keys(changes).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(changes), line.id);
    audit(req.user.id, 'fix', 'line', line.id, Object.fromEntries(Object.keys(changes).map((k) => [k, line[k]])), changes);
    // The reader learned this sheet with the old value: it learns it again (القراءة الآلية).
    db.prepare('DELETE FROM ocr_samples WHERE sheet_id = ?').run(line.sheet_id);
  })();
  res.json({ ok: true });
});

// ---------- client account ----------
money.get('/clients/:id/account', admin, (req, res) => {
  const db = getDb();
  const client = clientOrThrow(req.params.id);
  res.json({
    client,
    balance: balanceOf(client.id),
    open: openDebts(client.id),
    payments: db.prepare('SELECT p.*, u.display_name AS created_by_name FROM payments p LEFT JOIN users u ON u.id = p.created_by WHERE p.client_id = ? ORDER BY p.pay_date DESC, p.id DESC').all(client.id),
    adjustments: db.prepare('SELECT * FROM adjustments WHERE client_id = ? ORDER BY adj_date DESC, id DESC').all(client.id),
    promises: db.prepare('SELECT * FROM promises WHERE client_id = ? ORDER BY done_at IS NOT NULL, promised_date').all(client.id),
    prices: db.prepare(`SELECT p.*, m.name AS machine_name, mt.name AS material_name FROM price_memory p
      LEFT JOIN machines m ON m.code = p.machine_code LEFT JOIN materials mt ON mt.id = p.material_id
      WHERE p.client_id = ? ORDER BY p.machine_code, p.unit, mt.name, p.thickness`).all(client.id)
      .map((p) => ({ ...p, unit_label: UNITS[p.unit]?.label || p.unit })),
    batches: db.prepare(`SELECT b.*, (SELECT COALESCE(SUM(amount),0) FROM line_prices WHERE batch_id = b.id)
      + (SELECT COALESCE(SUM(amount),0) FROM billing_items WHERE batch_id = b.id)
      + (SELECT COALESCE(SUM(amount),0) FROM adjustments WHERE batch_id = b.id) AS total
      FROM pricing_batches b WHERE b.client_id = ? ORDER BY b.id DESC`).all(client.id),
  });
});

money.get('/clients/:id/statement', admin, (req, res) => {
  const client = clientOrThrow(req.params.id);
  const from = req.query.from ? dateOr(req.query.from, null, 'من') : null;
  const to = req.query.to ? dateOr(req.query.to, null, 'إلى') : null;
  const pending = getDb().prepare(`SELECT * FROM payments WHERE client_id = ? AND is_cheque = 1 AND cheque_status = 'pending' AND cancelled_at IS NULL ORDER BY cheque_due`).all(client.id);
  res.json({ client: { id: client.id, name: client.name, phone: client.phone }, from, to, ...statement(client.id, from, to), pending_cheques: pending });
});

money.put('/clients/:id/prices', admin, (req, res) => {
  const client = clientOrThrow(req.params.id);
  const b = req.body || {};
  if (!UNITS[b.unit]) throw httpError(400, 'وحدة غلط');
  const rate = rateOrThrow(b.rate, 'السعر');
  getDb().prepare(`UPDATE price_memory SET rate = ?, updated_at = datetime('now')
    WHERE client_id = ? AND machine_code = ? AND unit = ? AND material_id = ? AND thickness = ?`)
    .run(rate, client.id, b.machine_code, b.unit, Number(b.material_id) || 0, Number(b.thickness) || 0);
  audit(req.user.id, 'update', 'price_memory', client.id, undefined, { ...b, rate });
  res.json({ ok: true });
});

money.delete('/clients/:id/prices', admin, (req, res) => {
  const client = clientOrThrow(req.params.id);
  const b = req.body || {};
  getDb().prepare('DELETE FROM price_memory WHERE client_id = ? AND machine_code = ? AND unit = ? AND material_id = ? AND thickness = ?')
    .run(client.id, b.machine_code, b.unit, Number(b.material_id) || 0, Number(b.thickness) || 0);
  audit(req.user.id, 'delete', 'price_memory', client.id, b);
  res.json({ ok: true });
});

// ---------- payments ----------
money.get('/payments', admin, (req, res) => {
  const db = getDb();
  const where = ['1=1'];
  const args = [];
  if (req.query.client_id) { where.push('p.client_id = ?'); args.push(req.query.client_id); }
  if (req.query.cheques === 'pending') where.push("p.is_cheque = 1 AND p.cheque_status = 'pending' AND p.cancelled_at IS NULL");
  const rows = db.prepare(`SELECT p.*, c.name AS client_name FROM payments p JOIN clients c ON c.id = p.client_id
    WHERE ${where.join(' AND ')} ORDER BY p.pay_date DESC, p.id DESC LIMIT 300`).all(...args);
  res.json({ payments: rows, methods: getSettings().payment_methods });
});

money.post('/payments', admin, (req, res) => {
  const db = getDb();
  const b = req.body || {};
  const client = clientOrThrow(b.client_id);
  const amount = toPiastres(b.amount);
  if (!(amount > 0)) throw httpError(400, 'اكتب المبلغ');
  const method = cleanText(b.method, 40) || 'نقدي';
  const isCheque = b.is_cheque === true || method === 'شيك';
  const pay_date = dateOr(b.pay_date, todayISO(), 'تاريخ الدفع');
  const cheque_due = isCheque ? dateOr(b.cheque_due, null, 'تاريخ استحقاق الشيك') : null;
  if (isCheque && !cheque_due) throw httpError(400, 'اكتب تاريخ استحقاق الشيك');
  const id = db.transaction(() => {
    const r = db.prepare(`INSERT INTO payments (client_id, pay_date, amount, method, reference, notes, is_cheque, cheque_due, cheque_status, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(client.id, pay_date, amount, method, cleanText(b.reference, 80), cleanText(b.notes, 300),
      isCheque ? 1 : 0, cheque_due, isCheque ? 'pending' : null, req.user.id);
    audit(req.user.id, 'create', 'payment', r.lastInsertRowid, undefined, { client_id: client.id, amount, method, pay_date, cheque_due });
    return r.lastInsertRowid;
  })();
  res.status(201).json({ payment: db.prepare('SELECT * FROM payments WHERE id = ?').get(id), balance: balanceOf(client.id) });
});

money.post('/payments/:id/cheque', admin, (req, res) => {
  const db = getDb();
  const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
  if (!p || !p.is_cheque) throw httpError(404, 'الشيك مش موجود');
  if (p.cancelled_at) throw httpError(409, 'الدفعة دي ملغية');
  const status = req.body?.status;
  if (!['cleared', 'bounced', 'pending'].includes(status)) throw httpError(400, 'حالة الشيك غلط');
  const date = status === 'cleared' ? dateOr(req.body?.date, todayISO(), 'تاريخ الصرف') : null;
  db.transaction(() => {
    db.prepare('UPDATE payments SET cheque_status = ?, cheque_cleared_at = ? WHERE id = ?').run(status, date, p.id);
    audit(req.user.id, 'cheque', 'payment', p.id, { cheque_status: p.cheque_status }, { cheque_status: status, date });
  })();
  res.json({ ok: true, balance: balanceOf(p.client_id) });
});

money.post('/payments/:id/cancel', admin, (req, res) => {
  const db = getDb();
  const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
  if (!p) throw httpError(404, 'الدفعة مش موجودة');
  if (p.cancelled_at) throw httpError(409, 'الدفعة اتلغت قبل كده');
  const reason = cleanText(req.body?.reason, 300);
  if (!reason) throw httpError(400, 'اكتب سبب الإلغاء');
  db.transaction(() => {
    db.prepare("UPDATE payments SET cancelled_by = ?, cancelled_at = datetime('now'), cancel_reason = ? WHERE id = ?").run(req.user.id, reason, p.id);
    audit(req.user.id, 'cancel', 'payment', p.id, undefined, { reason });
  })();
  res.json({ ok: true, balance: balanceOf(p.client_id) });
});

// ---------- adjustments ----------
money.post('/adjustments', admin, (req, res) => {
  const db = getDb();
  const b = req.body || {};
  const client = clientOrThrow(b.client_id);
  const value = toPiastres(b.amount);
  if (!(value > 0)) throw httpError(400, 'اكتب المبلغ');
  const reason = cleanText(b.reason, 200);
  if (!reason) throw httpError(400, 'اكتب السبب');
  const amount = b.kind === 'charge' ? value : -value;
  const id = db.transaction(() => {
    const r = db.prepare('INSERT INTO adjustments (client_id, adj_date, amount, reason, created_by) VALUES (?,?,?,?,?)')
      .run(client.id, dateOr(b.adj_date, todayISO(), 'التاريخ'), amount, reason, req.user.id);
    audit(req.user.id, 'create', 'adjustment', r.lastInsertRowid, undefined, { client_id: client.id, amount, reason });
    return r.lastInsertRowid;
  })();
  res.status(201).json({ id, balance: balanceOf(client.id) });
});

money.post('/adjustments/:id/cancel', admin, (req, res) => {
  const db = getDb();
  const a = db.prepare('SELECT * FROM adjustments WHERE id = ?').get(req.params.id);
  if (!a) throw httpError(404, 'مش موجود');
  if (a.cancelled_at) throw httpError(409, 'اتلغى قبل كده');
  if (a.batch_id) throw httpError(409, 'الخصم ده جزء من تسعير — ألغي التسعير نفسه');
  const reason = cleanText(req.body?.reason, 300);
  if (!reason) throw httpError(400, 'اكتب سبب الإلغاء');
  db.prepare("UPDATE adjustments SET cancelled_by = ?, cancelled_at = datetime('now'), cancel_reason = ? WHERE id = ?").run(req.user.id, reason, a.id);
  audit(req.user.id, 'cancel', 'adjustment', a.id, undefined, { reason });
  res.json({ ok: true, balance: balanceOf(a.client_id) });
});

// ---------- promises ----------
money.post('/promises', admin, (req, res) => {
  const b = req.body || {};
  const client = clientOrThrow(b.client_id);
  const date = dateOr(b.promised_date, null, 'موعد الدفع');
  if (!date) throw httpError(400, 'اكتب العميل وعد يدفع إمتى');
  const amount = b.amount ? toPiastres(b.amount) : 0;
  if (Number.isNaN(amount) || amount < 0) throw httpError(400, 'المبلغ غلط');
  const r = getDb().prepare('INSERT INTO promises (client_id, promised_date, amount, notes, created_by) VALUES (?,?,?,?,?)')
    .run(client.id, date, amount, cleanText(b.notes, 300), req.user.id);
  audit(req.user.id, 'create', 'promise', r.lastInsertRowid, undefined, { client_id: client.id, date, amount });
  res.status(201).json({ id: r.lastInsertRowid });
});

money.post('/promises/:id/done', admin, (req, res) => {
  const r = getDb().prepare("UPDATE promises SET done_at = datetime('now') WHERE id = ? AND done_at IS NULL").run(req.params.id);
  if (!r.changes) throw httpError(404, 'مش موجود');
  audit(req.user.id, 'done', 'promise', Number(req.params.id));
  res.json({ ok: true });
});

// ---------- reports ----------
money.get('/reports/balances', admin, (_req, res) => {
  const db = getDb();
  const lastPay = db.prepare(`SELECT pay_date, amount FROM payments WHERE client_id = ? AND cancelled_at IS NULL
    AND (is_cheque = 0 OR cheque_status = 'cleared') ORDER BY pay_date DESC, id DESC LIMIT 1`);
  const rows = db.prepare('SELECT id, name, phone, active FROM clients ORDER BY name').all().map((c) => {
    const balance = balanceOf(c.id);
    const open = openDebts(c.id);
    const days = open.map((o) => o.days).filter((d) => d !== null);
    const lp = lastPay.get(c.id);
    return { ...c, balance, last_payment_date: lp?.pay_date || null, last_payment_amount: lp?.amount || null,
      oldest_days: days.length ? Math.max(...days) : null };
  });
  res.json({ clients: rows, outstanding: rows.filter((r) => r.balance > 0).reduce((s, r) => s + r.balance, 0) });
});

money.get('/followup', admin, (_req, res) => {
  const db = getDb();
  const s = getSettings();
  const today = todayISO();
  const week = todayISO(new Date(Date.now() + 7 * 86400000));
  const tomorrow = todayISO(new Date(Date.now() + 86400000));
  const overdue = [];
  const dueSoon = [];
  for (const c of db.prepare('SELECT id, name, phone FROM clients').all()) {
    for (const d of openDebts(c.id, today)) {
      const row = { client_id: c.id, client_name: c.name, phone: c.phone, text: d.text, open: d.open, days: d.days, since: d.since, due: d.due };
      if ((d.due && d.due < today) || (d.days !== null && d.days >= s.alert_days)) overdue.push(row);
      else if (d.due && d.due <= week) dueSoon.push(row);
    }
  }
  overdue.sort((a, b) => (b.days ?? 0) - (a.days ?? 0));
  dueSoon.sort((a, b) => a.due.localeCompare(b.due));
  res.json({
    alert_days: s.alert_days,
    overdue,
    due_soon: dueSoon,
    cheques: db.prepare(`SELECT p.*, c.name AS client_name FROM payments p JOIN clients c ON c.id = p.client_id
      WHERE p.is_cheque = 1 AND p.cheque_status = 'pending' AND p.cancelled_at IS NULL AND p.cheque_due <= ? ORDER BY p.cheque_due`).all(week),
    promises: db.prepare(`SELECT pr.*, c.name AS client_name FROM promises pr JOIN clients c ON c.id = pr.client_id
      WHERE pr.done_at IS NULL AND pr.promised_date <= ? ORDER BY pr.promised_date`).all(tomorrow),
    delivered_unpriced: db.prepare(`SELECT x.*, c.name AS client_name FROM (${LINE_SELECT}) x JOIN lines l ON l.id = x.id
      JOIN sheets s ON s.id = l.sheet_id JOIN clients c ON c.id = l.client_id
      WHERE x.delivery_date IS NOT NULL AND ${UNPRICED} ORDER BY x.delivery_date`).all()
      .map((l) => ({ id: l.id, client_id: l.client_id, client_name: l.client_name, text: workText(l), delivered: l.delivery_date })),
    undelivered: db.prepare(`SELECT c.id AS client_id, c.name AS client_name, COUNT(*) AS lines, MIN(COALESCE(l.work_date, s.sheet_date)) AS oldest
      FROM lines l JOIN sheets s ON s.id = l.sheet_id JOIN clients c ON c.id = l.client_id
      LEFT JOIN deliveries d ON d.id = l.delivery_id AND d.cancelled_at IS NULL
      WHERE s.status = 'confirmed' AND d.id IS NULL GROUP BY c.id ORDER BY oldest`).all(),
  });
});

// ---------- settings ----------
money.get('/settings', admin, (_req, res) => res.json({ settings: publicSettings() }));

money.put('/settings', requirePerm('settings.manage'), (req, res) => {
  const b = req.body || {};
  const v = {};
  for (const k of ['company_name', 'company_phone', 'company_address']) if (b[k] !== undefined) v[k] = cleanText(b[k], 200);
  if (b.alert_days !== undefined) {
    const n = parseNumber(b.alert_days);
    if (!(n >= 1 && n <= 365)) throw httpError(400, 'عدد الأيام لازم يكون من 1 لـ 365');
    v.alert_days = Math.round(n);
  }
  if (b.payment_methods !== undefined) {
    const list = (Array.isArray(b.payment_methods) ? b.payment_methods : String(b.payment_methods).split(/[\n,،]/))
      .map((x) => cleanText(x, 40)).filter(Boolean);
    v.payment_methods = list.length ? [...new Set(list)] : DEFAULT_SETTINGS.payment_methods;
  }
  const pick = (o) => Object.fromEntries(Object.keys(v).map((k) => [k, o[k]]));
  const before = pick(getSettings());
  setSettings(v);
  audit(req.user.id, 'update', 'settings', null, before, pick(getSettings()));
  res.json({ settings: publicSettings() });
});
