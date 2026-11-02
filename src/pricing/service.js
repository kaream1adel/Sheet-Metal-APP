// التسعير: price items from approved operation sheets, suggested rates, the posting to the
// client's account (one transaction per client per sheet), «تصحيح سعر», manual client entries,
// the general prices and the client's «شيت التسعير». The routes (src/routes/pricing.js) are a
// thin layer over these functions; other modules may call them too.
//
// Every posting goes through ledger.post / ledger.reverse (balanced, audited, month lock);
// posted items are never edited: a correction cancels them and posts corrected copies.
import { getDb, audit } from '../db.js';
import { post, reverse, nextSerial, isMonthLocked, SECTIONS, SECTION_NAMES, MACHINE_NAMES } from '../ledger.js';
import { httpError, cleanText, parseNumber, todayISO, parseDate } from '../util.js';
import { parseMoney } from '../money.js';
import { computeItem, sectionBand, parseThickness, BILLINGS, SECTION_BILLING, UNIT_NAMES, BILLING_NAMES, materialGroup } from './formulas.js';

// The «شيت التسعير» sections in the Excel template's order (A, N, W, AF, AN, AV).
export const SHEET_ORDER = ['press', 'laser', 'punch', 'louver', 'shear', 'material'];
export const MANUAL_KINDS = { debit: 'قيد مدين', discount: 'خصم', addition: 'إضافة' };

// ---------- small helpers ----------
// A real calendar date ('2026-02-30' is refused). null = blank, undefined = invalid.
export const realDate = parseDate; // src/util.js: null blank, undefined invalid
export const dmy = (iso) => { const [y, m, d] = String(iso).split('-'); return `${Number(d)}/${Number(m)}/${y}`; };

const bad = (msg, field) => httpError(400, msg, field ? { field } : undefined);

// A rate typed in pounds (millimes accepted up to 3 decimals). '' / null → null.
function rateInput(v, field = 'rate') {
  if (v === '' || v === null || v === undefined) return null;
  const r = parseMoney(v);
  if (Number.isNaN(r)) throw bad('سعر الوحدة لازم يكون رقم (مثال 2.5)', field);
  if (r < 0) throw bad('السعر مينفعش يكون بالسالب', field);
  if (r > 1e12) throw bad('السعر كبير قوي', field);
  return r;
}
function amountInput(v, label, field) {
  if (v === '' || v === null || v === undefined) return 0;
  const a = parseMoney(v);
  if (Number.isNaN(a)) throw bad(`${label} لازم يكون رقم`, field);
  if (a < 0) throw bad(`${label} مينفعش يكون بالسالب`, field);
  if (a > 1e12) throw bad(`${label} كبير قوي`, field);
  return a;
}
function positiveNumber(v, label, field) {
  if (v === '' || v === null || v === undefined) return null;
  const x = parseNumber(v);
  if (x === null) return null;
  if (Number.isNaN(x) || x <= 0) throw bad(`${label} لازم يكون رقم أكبر من صفر`, field);
  return x;
}

const materialsById = () => new Map(getDb().prepare('SELECT * FROM materials').all().map((m) => [m.id, m]));
const generalPrice = (section, band) => getDb().prepare('SELECT rate, min_charge FROM general_prices WHERE section = ? AND band = ?').get(section, band) || {};
const minChargeOf = (section) => (section === 'laser' || section === 'punch' ? generalPrice(section, '').min_charge ?? null : null);

function getSheet(id) {
  const s = getDb().prepare(`SELECT s.*, t.name AS technician_name FROM op_sheets s
    LEFT JOIN technicians t ON t.id = s.technician_id WHERE s.id = ?`).get(id);
  if (!s) throw httpError(404, 'ورقة التشغيل مش موجودة');
  return s;
}
function getClient(id) {
  const p = getDb().prepare('SELECT * FROM parties WHERE id = ?').get(id);
  if (!p || p.kind !== 'client') throw bad('العميل مش موجود', 'client_id');
  return p;
}

// ---------- the suggested rate ----------
// last posted rate for the same client + section + material + thickness (+ billing) → last for
// client + section (+ press band), or the client's known rate (Excel row 4) → the general price
// (+ band) → none («محتاج سعر»). Returns { rate, source }.
export function suggestRate({ client_id, section, material_id = null, thickness = null, billing = null }) {
  const db = getDb();
  const bill = billing || SECTION_BILLING[section];
  const band = sectionBand(section, thickness);
  const same = db.prepare(`SELECT rate FROM price_items WHERE status = 'posted' AND rate IS NOT NULL
      AND client_id = ? AND section = ? AND billing = ? AND material_id IS ? AND thickness IS ?
    ORDER BY COALESCE(work_date, '') DESC, id DESC LIMIT 1`).get(client_id, section, bill, material_id ?? null, thickness ?? null);
  if (same) return { rate: same.rate, source: 'last_same' };
  const bandSql = section === 'press' ? "AND (CASE WHEN thickness >= 3 THEN '>=3' ELSE '<3' END) = @band" : '';
  const last = db.prepare(`SELECT rate FROM price_items WHERE status = 'posted' AND rate IS NOT NULL
      AND client_id = @client AND section = @section AND billing = @bill ${bandSql}
    ORDER BY COALESCE(work_date, '') DESC, id DESC LIMIT 1`).get({ client: client_id, section, bill, band });
  if (last) return { rate: last.rate, source: 'last_section' };
  if (bill !== SECTION_BILLING[section]) return { rate: null, source: null }; // no general price per piece / lump
  const known = db.prepare(`SELECT rate FROM client_rates WHERE client_id = ? AND section = ? AND band IN (?, '')
    ORDER BY band = ? DESC LIMIT 1`).get(client_id, section, band, band);
  if (known) return { rate: known.rate, source: 'last_section' };
  const g = generalPrice(section, band);
  if (g.rate !== null && g.rate !== undefined) return { rate: g.rate, source: 'general' };
  return { rate: null, source: null };
}

// ---------- items from an approved sheet ----------
// The candidate items of one line: { section, ...quantities }. A punch line can give a punch
// item and a louver item; a factory-material line also gives a material item.
export function lineCandidates(sheet, line) {
  const out = [];
  const thickness = line.thickness ?? parseThickness(line.material_text);
  const base = {
    op_line_id: line.id, sheet_id: sheet.id, client_id: line.client_id, work_date: line.work_date || sheet.sheet_date,
    part_name: line.part_name || '', material_id: line.material_id ?? null, thickness: thickness ?? null,
    pieces: line.pieces ?? null, per_piece: null, sheets: null, minutes_per_sheet: null, single_piece: 0,
    length_cm: null, width_cm: null,
  };
  const m = sheet.machine;
  if (m === 'press' || m === 'shear') out.push({ ...base, section: m, per_piece: line.per_piece ?? null });
  if (m === 'laser' || m === 'punch') {
    const louver = Number(line.louvers_per_piece) > 0;
    const timed = line.sheets !== null || line.minutes_per_sheet !== null;
    if (m === 'laser' || timed || !louver) {
      out.push({ ...base, section: m, sheets: line.sheets ?? null, minutes_per_sheet: line.minutes_per_sheet ?? null, single_piece: line.single_piece ? 1 : 0 });
    }
    if (m === 'punch' && louver) out.push({ ...base, section: 'louver', per_piece: line.louvers_per_piece });
  }
  if (line.material_source === 'factory') {
    out.push({ ...base, section: 'material', sheets: m === 'laser' || m === 'punch' ? line.sheets ?? null : line.sheets ?? line.pieces ?? null,
      length_cm: line.length_cm ?? null, width_cm: line.width_cm ?? null });
  }
  return out;
}

// qty / unit / weight / amount of an item row from its fields (and its material's density).
function recompute(item, mats = materialsById()) {
  const density = item.material_id ? mats.get(item.material_id)?.density ?? null : null;
  const c = computeItem({ ...item, density });
  return { qty: c.qty, unit: c.unit, weight_kg: c.weight_kg, amount: c.amount };
}

const QTY_KEYS = ['client_id', 'work_date', 'part_name', 'material_id', 'thickness', 'pieces', 'per_piece', 'sheets', 'minutes_per_sheet', 'single_piece'];

// Builds / refreshes the price items of an approved sheet. Idempotent: one live item per line
// per section; suggested items follow their line and (until confirmed) the current suggestion;
// posted items never change. Returns the number of items added.
export function syncSheetItems(sheetId, userId = null) {
  const db = getDb();
  return db.transaction(() => {
    const sheet = getSheet(sheetId);
    if (sheet.status !== 'approved') throw httpError(409, 'الورقة دي لسه متعتمدتش — اعتمدها من المراجعة الأول');
    if (sheet.source === 'import') return 0; // history from the Excel: priced there
    const mats = materialsById();
    const lines = db.prepare(`SELECT * FROM op_lines WHERE sheet_id = ? AND status = 'active' AND client_id IS NOT NULL ORDER BY row_no`).all(sheet.id);
    // live items, and items the admin excluded (they stay excluded: never generated again)
    const live = new Map();
    for (const it of db.prepare(`SELECT * FROM price_items WHERE sheet_id = ? AND op_line_id IS NOT NULL
        AND (status IN ('suggested','posted') OR cancel_kind = 'excluded') ORDER BY status = 'cancelled', id DESC`).all(sheet.id)) {
      const key = `${it.op_line_id}:${it.section}`;
      if (!live.has(key)) live.set(key, it);
    }
    const seen = new Set();
    let added = 0;
    const ins = db.prepare(`INSERT INTO price_items (op_line_id, sheet_id, client_id, section, work_date, part_name, material_id,
      thickness, pieces, per_piece, sheets, minutes_per_sheet, single_piece, length_cm, width_cm, weight_kg, qty, unit, rate,
      min_charge, amount, billing, rate_source, status, created_by)
      VALUES (@op_line_id, @sheet_id, @client_id, @section, @work_date, @part_name, @material_id, @thickness, @pieces, @per_piece,
      @sheets, @minutes_per_sheet, @single_piece, @length_cm, @width_cm, @weight_kg, @qty, @unit, @rate, @min_charge, @amount,
      @billing, @rate_source, 'suggested', @created_by)`);
    for (const line of lines) {
      for (const cand of lineCandidates(sheet, line)) {
        const key = `${line.id}:${cand.section}`;
        seen.add(key);
        const ex = live.get(key);
        if (!ex) {
          const billing = SECTION_BILLING[cand.section];
          const s = suggestRate({ ...cand, billing });
          const row = { ...cand, billing, rate: s.rate, rate_source: s.source, min_charge: minChargeOf(cand.section), created_by: userId };
          Object.assign(row, recompute(row, mats));
          ins.run(row);
          added++;
          continue;
        }
        if (ex.status !== 'suggested') continue; // posted: frozen
        const next = { ...ex };
        for (const k of QTY_KEYS) next[k] = cand[k];
        // dimensions typed on the item (pricing) stay unless the line has its own
        if (cand.section === 'material') {
          next.length_cm = cand.length_cm ?? ex.length_cm;
          next.width_cm = cand.width_cm ?? ex.width_cm;
          next.thickness = cand.thickness ?? ex.thickness;
        }
        next.min_charge = minChargeOf(cand.section);
        if (!ex.rate_confirmed) {
          const s = suggestRate(next);
          next.rate = s.rate;
          next.rate_source = s.source;
        }
        Object.assign(next, recompute(next, mats));
        const changed = ['client_id', 'work_date', 'part_name', 'material_id', 'thickness', 'pieces', 'per_piece', 'sheets',
          'minutes_per_sheet', 'single_piece', 'length_cm', 'width_cm', 'weight_kg', 'qty', 'unit', 'rate', 'rate_source', 'min_charge', 'amount']
          .some((k) => (next[k] ?? null) !== (ex[k] ?? null));
        if (changed) {
          db.prepare(`UPDATE price_items SET client_id=@client_id, work_date=@work_date, part_name=@part_name, material_id=@material_id,
            thickness=@thickness, pieces=@pieces, per_piece=@per_piece, sheets=@sheets, minutes_per_sheet=@minutes_per_sheet,
            single_piece=@single_piece, length_cm=@length_cm, width_cm=@width_cm, weight_kg=@weight_kg, qty=@qty, unit=@unit,
            rate=@rate, rate_source=@rate_source, min_charge=@min_charge, amount=@amount WHERE id=@id`).run(next);
        }
      }
    }
    // a suggested item whose line left the sheet (or stopped needing that section)
    for (const [key, it] of live) {
      if (!seen.has(key) && it.status === 'suggested') {
        db.prepare("UPDATE price_items SET status='cancelled', cancel_kind='line_removed', cancel_reason='السطر اتشال من الورقة' WHERE id=?").run(it.id);
      }
    }
    if (added) audit(userId, 'generate', 'price_items', sheet.id, undefined, { sheet: sheet.serial, added });
    updatePricedStatus(sheet.id);
    return added;
  })();
}

// none: nothing posted yet · partial: some clients posted, some items still waiting · posted: nothing waits.
export function updatePricedStatus(sheetId) {
  const db = getDb();
  const c = db.prepare(`SELECT SUM(status='suggested') AS waiting, SUM(status='posted') AS posted, COUNT(*) AS n
    FROM price_items WHERE sheet_id = ?`).get(sheetId);
  // a sheet with no items at all keeps its status (none, or closed as «posted» with nothing to bill)
  if (!c.n) return db.prepare('SELECT priced_status FROM op_sheets WHERE id = ?').get(sheetId)?.priced_status;
  let st = 'none';
  if ((c.waiting || 0) === 0) st = 'posted';
  else if ((c.posted || 0) > 0) st = 'partial';
  db.prepare('UPDATE op_sheets SET priced_status = ? WHERE id = ? AND priced_status <> ?').run(st, sheetId, st);
  return st;
}

// ---------- reading items ----------
export function itemView(it, mats = materialsById()) {
  const mat = it.material_id ? mats.get(it.material_id) : null;
  const c = computeItem({ ...it, density: mat?.density ?? null });
  const needs = [];
  if (it.status === 'suggested') {
    if (c.missing.length) needs.push(it.section === 'material' && c.missing.some((k) => k === 'length_cm' || k === 'width_cm' || k === 'thickness') ? 'dims' : 'qty');
    if (it.rate === null || it.rate === undefined) needs.push('rate');
  }
  return {
    id: it.id, op_line_id: it.op_line_id, sheet_id: it.sheet_id, batch_id: it.batch_id, client_id: it.client_id,
    section: it.section, section_name: SECTION_NAMES[it.section], work_date: it.work_date, part_name: it.part_name,
    material_id: it.material_id, material_name: mat?.name || '', material_group: mat ? materialGroup(mat.grp) : 'black',
    thickness: it.thickness, band: sectionBand(it.section, it.thickness),
    pieces: it.pieces, per_piece: it.per_piece, sheets: it.sheets, minutes_per_sheet: it.minutes_per_sheet,
    single_piece: !!it.single_piece, length_cm: it.length_cm, width_cm: it.width_cm, weight_kg: it.weight_kg,
    qty: it.qty, unit: it.unit, unit_name: UNIT_NAMES[it.unit] || '', billing: it.billing, billing_name: BILLING_NAMES[it.billing],
    billings: BILLINGS[it.section], rate: it.rate, rate_confirmed: !!it.rate_confirmed, rate_source: it.rate_source,
    min_charge: it.min_charge, min_applied: c.min_applied, amount: it.amount, status: it.status, txn_id: it.txn_id,
    cancel_kind: it.cancel_kind, cancel_reason: it.cancel_reason, corrected_from: it.corrected_from, needs,
  };
}

// تسعير ورقة: the sheet with its items grouped by client.
export function sheetForPricing(sheetId, userId = null) {
  syncSheetItems(sheetId, userId);
  const db = getDb();
  const sheet = getSheet(sheetId);
  const mats = materialsById();
  const items = db.prepare(`SELECT pi.* FROM price_items pi JOIN op_lines l ON l.id = pi.op_line_id
    WHERE pi.sheet_id = ? AND (pi.status IN ('suggested','posted') OR pi.cancel_kind = 'excluded')
    ORDER BY l.row_no, CASE pi.section WHEN 'louver' THEN 1 WHEN 'material' THEN 2 ELSE 0 END, pi.id`).all(sheet.id);
  const clientIds = [...new Set(items.map((i) => i.client_id))];
  const clients = clientIds.map((cid) => {
    const p = db.prepare('SELECT id, name FROM parties WHERE id = ?').get(cid);
    const mine = items.filter((i) => i.client_id === cid);
    const liveItems = mine.filter((i) => i.status !== 'cancelled').map((i) => itemView(i, mats));
    const excluded = mine.filter((i) => i.status === 'cancelled').map((i) => itemView(i, mats));
    const batches = db.prepare(`SELECT b.*, a.discount_amount, a.addition_amount, a.note FROM pricing_batches b
      LEFT JOIN pricing_adjustments a ON a.batch_id = b.id WHERE b.sheet_id = ? AND b.client_id = ? ORDER BY b.id`).all(sheet.id, cid);
    const draft = db.prepare('SELECT * FROM pricing_adjustments WHERE sheet_id = ? AND client_id = ? AND batch_id IS NULL').get(sheet.id, cid);
    const waiting = liveItems.filter((i) => i.status === 'suggested');
    const work = waiting.reduce((s, i) => s + (i.amount || 0), 0);
    const discount = draft?.discount_amount || 0;
    const addition = draft?.addition_amount || 0;
    return {
      client: p, items: liveItems, excluded,
      batches: batches.map((b) => ({ id: b.id, serial: b.serial, date: b.date, total: b.total, status: b.status, reason: b.reason,
        discount_amount: b.discount_amount || 0, addition_amount: b.addition_amount || 0, note: b.note || '' })),
      adjustment: { discount_amount: discount, addition_amount: addition, note: draft?.note || '' },
      waiting_count: waiting.length,
      needs_rate_count: waiting.filter((i) => i.needs.includes('rate')).length,
      needs_qty_count: waiting.filter((i) => i.needs.some((n) => n !== 'rate')).length,
      work_amount: work, net_amount: work + addition - discount,
      posted: waiting.length === 0 && liveItems.length > 0,
    };
  });
  const waitingAll = clients.flatMap((c) => c.items.filter((i) => i.status === 'suggested'));
  return {
    sheet: {
      id: sheet.id, serial: sheet.serial, machine: sheet.machine, machine_name: MACHINE_NAMES[sheet.machine],
      technician_name: sheet.technician_name || '', sheet_date: sheet.sheet_date, status: sheet.status,
      priced_status: sheet.priced_status, has_photo: !!sheet.photo_path, notes: sheet.notes, source: sheet.source,
      month_locked: isMonthLocked(sheet.sheet_date),
    },
    clients,
    totals: {
      waiting_count: waitingAll.length,
      needs_rate_count: waitingAll.filter((i) => i.needs.includes('rate')).length,
      needs_qty_count: waitingAll.filter((i) => i.needs.some((n) => n !== 'rate')).length,
      net_amount: clients.reduce((s, c) => s + (c.waiting_count ? c.net_amount : 0), 0),
    },
  };
}

// ---------- the queue: أوراق مستنية تسعير ----------
export function pricingQueue(userId = null) {
  const db = getDb();
  const sheets = db.prepare(`SELECT s.id FROM op_sheets s WHERE s.status = 'approved' AND s.source <> 'import'
    AND s.priced_status <> 'posted' ORDER BY s.sheet_date DESC, s.id DESC`).all();
  for (const s of sheets) syncSheetItems(s.id, userId);
  const rows = db.prepare(`SELECT s.*, t.name AS technician_name FROM op_sheets s LEFT JOIN technicians t ON t.id = s.technician_id
    WHERE s.status = 'approved' AND s.source <> 'import' AND s.priced_status <> 'posted' ORDER BY s.sheet_date DESC, s.id DESC`).all();
  const out = rows.map((s) => {
    const its = db.prepare(`SELECT pi.*, p.name AS client_name FROM price_items pi JOIN parties p ON p.id = pi.client_id
      WHERE pi.sheet_id = ? AND pi.status IN ('suggested','posted')`).all(s.id);
    const waiting = its.filter((i) => i.status === 'suggested');
    const clientMap = new Map();
    for (const i of its) {
      const c = clientMap.get(i.client_id) || { id: i.client_id, name: i.client_name, waiting: 0, posted: 0 };
      if (i.status === 'suggested') c.waiting++; else c.posted++;
      clientMap.set(i.client_id, c);
    }
    const lineCount = db.prepare("SELECT COUNT(*) n FROM op_lines WHERE sheet_id = ? AND status = 'active'").get(s.id).n;
    return {
      id: s.id, serial: s.serial, machine: s.machine, machine_name: MACHINE_NAMES[s.machine], technician_name: s.technician_name || '',
      sheet_date: s.sheet_date, priced_status: s.priced_status, has_photo: !!s.photo_path, lines_count: lineCount,
      clients: [...clientMap.values()], waiting_count: waiting.length,
      needs_rate_count: waiting.filter((i) => i.rate === null).length,
      waiting_amount: waiting.reduce((sum, i) => sum + (i.amount || 0), 0),
    };
  });
  const groups = [];
  for (const s of out) {
    let g = groups.find((x) => x.date === s.sheet_date);
    if (!g) { g = { date: s.sheet_date, sheets: [] }; groups.push(g); }
    g.sheets.push(s);
  }
  const byClient = new Map();
  for (const s of out) for (const c of s.clients) {
    if (!c.waiting) continue;
    const x = byClient.get(c.id) || { id: c.id, name: c.name, sheets: 0, items: 0 };
    x.sheets++;
    x.items += c.waiting;
    byClient.set(c.id, x);
  }
  return {
    groups,
    clients: [...byClient.values()].sort((a, b) => b.sheets - a.sheets || a.name.localeCompare(b.name, 'ar')),
    totals: {
      sheets: out.length,
      needs_rate_count: out.reduce((s, x) => s + x.needs_rate_count, 0),
      waiting_amount: out.reduce((s, x) => s + x.waiting_amount, 0),
    },
  };
}

// How many approved sheets wait for pricing (for the admin home).
export function waitingSheetsCount() {
  return getDb().prepare(`SELECT COUNT(*) n FROM op_sheets WHERE status = 'approved' AND source <> 'import' AND priced_status <> 'posted'`).get().n;
}

// ---------- changing a suggested item ----------
function getItem(id) {
  const it = getDb().prepare('SELECT * FROM price_items WHERE id = ?').get(id);
  if (!it) throw httpError(404, 'البند مش موجود');
  return it;
}
const assertWaiting = (it) => {
  if (it.status === 'posted') throw httpError(409, 'البند ده اترحّل — التعديل بيبقى «تصحيح سعر» من بيان الأعمال');
  if (it.status !== 'suggested') throw httpError(409, 'البند ده مش مستني تسعير');
};

// body: { rate, confirm, billing, length_cm, width_cm, thickness }
export function updateItem(id, body, userId) {
  const db = getDb();
  return db.transaction(() => {
    const it = getItem(id);
    assertWaiting(it);
    const next = { ...it };
    if (body.billing !== undefined && body.billing !== it.billing) {
      if (!BILLINGS[it.section].includes(body.billing)) throw bad('طريقة الحساب دي مش مناسبة للقسم ده', 'billing');
      next.billing = body.billing;
      if (body.rate === undefined) {
        // a rate per bend means nothing per piece: suggest again for the new way of billing
        const s = suggestRate(next);
        next.rate = s.rate;
        next.rate_source = s.source;
        next.rate_confirmed = 0;
      }
    }
    if (it.section === 'material') {
      if (body.length_cm !== undefined) next.length_cm = positiveNumber(body.length_cm, 'الطول', 'length_cm');
      if (body.width_cm !== undefined) next.width_cm = positiveNumber(body.width_cm, 'العرض', 'width_cm');
      if (body.thickness !== undefined) next.thickness = positiveNumber(body.thickness, 'السمك', 'thickness');
    } else if (body.length_cm !== undefined || body.width_cm !== undefined) {
      throw bad('الطول والعرض للخامة من عندنا بس');
    }
    if (body.rate !== undefined) {
      const r = rateInput(body.rate);
      if (r === null) {
        const s = suggestRate(next);
        next.rate = s.rate;
        next.rate_source = s.source;
        next.rate_confirmed = 0;
      } else {
        if (r !== it.rate || !it.rate_source) next.rate_source = 'manual';
        next.rate = r;
        next.rate_confirmed = 1;
      }
    } else if (body.confirm) {
      if (next.rate === null) throw bad('مفيش سعر مقترح للبند ده — اكتب السعر', 'rate');
      next.rate_confirmed = 1;
    }
    Object.assign(next, recompute(next));
    db.prepare(`UPDATE price_items SET billing=@billing, rate=@rate, rate_source=@rate_source, rate_confirmed=@rate_confirmed,
      length_cm=@length_cm, width_cm=@width_cm, thickness=@thickness, weight_kg=@weight_kg, qty=@qty, unit=@unit, amount=@amount
      WHERE id=@id`).run(next);
    audit(userId, 'update', 'price_item', it.id,
      { billing: it.billing, rate: it.rate, rate_confirmed: it.rate_confirmed, length_cm: it.length_cm, width_cm: it.width_cm, thickness: it.thickness },
      { billing: next.billing, rate: next.rate, rate_confirmed: next.rate_confirmed, length_cm: next.length_cm, width_cm: next.width_cm, thickness: next.thickness });
    return itemView(getItem(it.id));
  })();
}

// «طبّق على باقي بنود الورقة» (scope 'sheet': same section, billing and press band on the sheet)
// or «على البنود المشابهة» (scope 'similar': also the same client, material and thickness).
export function applyRate(sheetId, itemId, scope, userId) {
  const db = getDb();
  return db.transaction(() => {
    const src = getItem(itemId);
    if (src.sheet_id !== Number(sheetId)) throw bad('البند مش من الورقة دي');
    if (src.rate === null) throw bad('اكتب سعر البند الأول');
    if (!['sheet', 'similar'].includes(scope)) throw bad('اختار تطبّق على إيه');
    const targets = db.prepare(`SELECT * FROM price_items WHERE sheet_id = ? AND status = 'suggested' AND id <> ?
      AND section = ? AND billing = ?`).all(src.sheet_id, src.id, src.section, src.billing)
      .filter((t) => sectionBand(t.section, t.thickness) === sectionBand(src.section, src.thickness))
      .filter((t) => scope === 'sheet' || (t.client_id === src.client_id && (t.material_id ?? null) === (src.material_id ?? null)
        && (t.thickness ?? null) === (src.thickness ?? null)));
    const mats = materialsById();
    for (const t of targets) {
      const next = { ...t, rate: src.rate, rate_source: 'manual', rate_confirmed: 1 };
      Object.assign(next, recompute(next, mats));
      db.prepare('UPDATE price_items SET rate=@rate, rate_source=@rate_source, rate_confirmed=1, amount=@amount, qty=@qty WHERE id=@id').run(next);
    }
    if (targets.length) audit(userId, 'apply_rate', 'price_items', src.sheet_id, undefined, { from_item: src.id, scope, rate: src.rate, items: targets.map((t) => t.id) });
    return targets.length;
  })();
}

// Confirms every suggested rate of the sheet (or of one client on it).
export function confirmSuggested(sheetId, clientId, userId) {
  const db = getDb();
  return db.transaction(() => {
    const r = db.prepare(`UPDATE price_items SET rate_confirmed = 1 WHERE sheet_id = ? AND status = 'suggested' AND rate IS NOT NULL
      AND rate_confirmed = 0 AND (? IS NULL OR client_id = ?)`).run(sheetId, clientId ?? null, clientId ?? null);
    if (r.changes) audit(userId, 'confirm_rates', 'price_items', Number(sheetId), undefined, { client_id: clientId ?? null, items: r.changes });
    return r.changes;
  })();
}

export function excludeItem(id, reason, userId) {
  const r = cleanText(reason, 300);
  if (!r) throw bad('اكتب سبب استبعاد البند', 'reason');
  const db = getDb();
  return db.transaction(() => {
    const it = getItem(id);
    assertWaiting(it);
    db.prepare("UPDATE price_items SET status='cancelled', cancel_kind='excluded', cancel_reason=? WHERE id=?").run(r, it.id);
    audit(userId, 'exclude', 'price_item', it.id, { status: 'suggested' }, { status: 'cancelled', reason: r });
    updatePricedStatus(it.sheet_id);
    return itemView(getItem(it.id));
  })();
}

export function restoreItem(id, userId) {
  const db = getDb();
  return db.transaction(() => {
    const it = getItem(id);
    if (it.status !== 'cancelled' || it.cancel_kind !== 'excluded') throw httpError(409, 'البند ده مش مستبعد');
    const taken = db.prepare(`SELECT 1 FROM price_items WHERE op_line_id = ? AND section = ? AND status IN ('suggested','posted')`).get(it.op_line_id, it.section);
    if (taken) throw httpError(409, 'السطر ده ليه بند تاني شغال بالفعل');
    db.prepare("UPDATE price_items SET status='suggested', cancel_kind=NULL, cancel_reason='' WHERE id=?").run(it.id);
    audit(userId, 'restore', 'price_item', it.id, { status: 'cancelled' }, { status: 'suggested' });
    updatePricedStatus(it.sheet_id);
    return itemView(getItem(it.id));
  })();
}

// خصم / إضافة on one client's part of a sheet, before the posting.
export function setAdjustment(sheetId, body, userId) {
  const db = getDb();
  return db.transaction(() => {
    const sheet = getSheet(sheetId);
    const client = getClient(Number(body.client_id));
    const waiting = db.prepare("SELECT COUNT(*) n FROM price_items WHERE sheet_id = ? AND client_id = ? AND status = 'suggested'").get(sheet.id, client.id).n;
    if (!waiting) throw httpError(409, 'بنود العميل ده اترحّلت — الخصم أو الإضافة بعد الترحيل بيبقى «تصحيح سعر» أو قيد يدوي');
    const discount = amountInput(body.discount, 'الخصم', 'discount');
    const addition = amountInput(body.addition, 'الإضافة', 'addition');
    const note = cleanText(body.note, 300);
    const cur = db.prepare('SELECT * FROM pricing_adjustments WHERE sheet_id = ? AND client_id = ? AND batch_id IS NULL').get(sheet.id, client.id);
    if (!discount && !addition && !note) {
      if (cur) db.prepare('DELETE FROM pricing_adjustments WHERE id = ?').run(cur.id); // a draft, never posted
    } else if (cur) {
      db.prepare("UPDATE pricing_adjustments SET discount_amount=?, addition_amount=?, note=?, updated_by=?, updated_at=datetime('now') WHERE id=?")
        .run(discount, addition, note, userId, cur.id);
    } else {
      db.prepare('INSERT INTO pricing_adjustments (sheet_id, client_id, discount_amount, addition_amount, note, updated_by) VALUES (?,?,?,?,?,?)')
        .run(sheet.id, client.id, discount, addition, note, userId);
    }
    audit(userId, 'adjust', 'pricing_sheet', sheet.id, cur ? { discount: cur.discount_amount, addition: cur.addition_amount, note: cur.note } : undefined,
      { client_id: client.id, discount, addition, note });
    return { discount_amount: discount, addition_amount: addition, note };
  })();
}

// ---------- posting ----------
// One batch (serial تس) and one transaction per client: Dr receivable(client) / Cr revenue:<section>
// per section (+ Cr revenue:manual for an addition). A discount is its own transaction
// (Dr discount_given / Cr receivable) so it shows in the statement's خصم column.
function createBatch({ sheet, client, items, adjustment, date, userId, descriptionPrefix = '' }) {
  const db = getDb();
  const serial = nextSerial('تس');
  const work = items.reduce((s, i) => s + i.amount, 0);
  const addition = adjustment?.addition_amount || 0;
  const discount = adjustment?.discount_amount || 0;
  const total = work + addition;
  if (total <= 0) throw bad(`بنود ${client.name} إجماليها صفر — اكتب سعر أو استبعد البنود`);
  if (discount > total) throw bad(`الخصم على ${client.name} أكبر من قيمة الشغل`, 'discount');
  const r = db.prepare('INSERT INTO pricing_batches (serial, sheet_id, client_id, date, total, created_by) VALUES (?,?,?,?,?,?)')
    .run(serial, sheet?.id ?? null, client.id, date, total, userId);
  const batchId = Number(r.lastInsertRowid);
  const bySection = new Map();
  for (const i of items) bySection.set(i.section, (bySection.get(i.section) || 0) + i.amount);
  const lines = [{ account: 'receivable', party_id: client.id, debit: total, memo: serial }];
  for (const s of SECTIONS) {
    const a = bySection.get(s);
    if (a > 0) lines.push({ account: `revenue:${s}`, credit: a, section: s, memo: SECTION_NAMES[s] });
  }
  if (addition > 0) lines.push({ account: 'revenue:manual', credit: addition, memo: adjustment.note || 'إضافة على الورقة' });
  const desc = sheet
    ? `${descriptionPrefix}بيان أعمال ${MACHINE_NAMES[sheet.machine]} — ورقة ${sheet.serial} — ${dmy(sheet.sheet_date)}`
    : `${descriptionPrefix}بيان أعمال — ${dmy(date)}`;
  const refs = { userId, ref: serial, docType: 'pricing_batch', docId: batchId, partyId: client.id };
  const txn = post('pricing', date, desc, lines, refs);
  let discountTxn = null;
  if (discount > 0) {
    discountTxn = post('pricing_discount', date, `خصم على ${desc}${adjustment.note ? ` — ${adjustment.note}` : ''}`.slice(0, 500), [
      { account: 'discount_given', debit: discount, memo: serial },
      { account: 'receivable', party_id: client.id, credit: discount, memo: adjustment.note || 'خصم' },
    ], refs);
  }
  db.prepare('UPDATE pricing_batches SET txn_id = ? WHERE id = ?').run(txn.id, batchId);
  const upd = db.prepare("UPDATE price_items SET status='posted', txn_id=?, batch_id=?, rate_confirmed=1 WHERE id=? AND status='suggested'");
  for (const i of items) if (upd.run(txn.id, batchId, i.id).changes !== 1) throw httpError(409, 'البنود اتغيرت — حدّث الصفحة وجرب تاني');
  if (adjustment && (discount || addition || adjustment.note)) {
    if (adjustment.id && !adjustment.batch_id) {
      db.prepare('UPDATE pricing_adjustments SET batch_id = ?, discount_txn_id = ? WHERE id = ?').run(batchId, discountTxn?.id ?? null, adjustment.id);
    } else {
      db.prepare(`INSERT INTO pricing_adjustments (sheet_id, client_id, batch_id, discount_amount, addition_amount, note, discount_txn_id, updated_by)
        VALUES (?,?,?,?,?,?,?,?)`).run(sheet?.id ?? null, client.id, batchId, discount, addition, adjustment.note || '', discountTxn?.id ?? null, userId);
    }
  }
  audit(userId, 'post', 'pricing_batch', batchId, undefined, {
    serial, sheet: sheet?.serial ?? null, client_id: client.id, total, discount, addition, txn: txn.serial, items: items.map((i) => i.id),
  });
  return { id: batchId, serial, total, discount_amount: discount, txn_id: txn.id, client_id: client.id, client_name: client.name };
}

// «اعتماد التسعير والترحيل»: posts every waiting client of the sheet (or only clientIds).
// Refuses (and posts nothing) while an item has no rate or no quantity.
export function postSheet(sheetId, { clientIds = null, userId } = {}) {
  syncSheetItems(sheetId, userId);
  const db = getDb();
  return db.transaction(() => {
    const sheet = getSheet(sheetId);
    if (sheet.status !== 'approved') throw httpError(409, 'الورقة دي لسه متعتمدتش');
    const wanted = clientIds ? new Set(clientIds.map(Number)) : null;
    const items = db.prepare("SELECT * FROM price_items WHERE sheet_id = ? AND status = 'suggested' ORDER BY id").all(sheet.id)
      .filter((i) => !wanted || wanted.has(i.client_id));
    if (!items.length) {
      // a sheet with nothing to bill (no client lines): close it so it leaves the queue
      const any = db.prepare('SELECT COUNT(*) n FROM price_items WHERE sheet_id = ?').get(sheet.id).n;
      if (!any && !wanted && sheet.priced_status !== 'posted') {
        db.prepare("UPDATE op_sheets SET priced_status = 'posted' WHERE id = ?").run(sheet.id);
        audit(userId, 'close', 'pricing_sheet', sheet.id, { priced_status: sheet.priced_status }, { priced_status: 'posted', reason: 'مفيش بنود تتسعر' });
        return { batches: [], priced_status: 'posted' };
      }
      throw httpError(409, 'مفيش بنود مستنية ترحيل في الورقة دي');
    }
    const mats = materialsById();
    const problems = items.map((i) => itemView(i, mats)).filter((v) => v.needs.length).map((v) => ({
      item_id: v.id, client_id: v.client_id, part_name: v.part_name, section_name: v.section_name,
      problem: v.needs.includes('rate') ? 'محتاج سعر' : v.needs.includes('dims') ? 'ناقص الطول أو العرض أو السمك' : 'ناقص الكمية',
    }));
    if (problems.length) {
      throw httpError(400, `فيه ${problems.length} بند لسه ناقص — كمّلهم الأول (${problems.slice(0, 3).map((p) => `${p.part_name || p.section_name}: ${p.problem}`).join('، ')})`, { problems });
    }
    const groups = new Map();
    for (const i of items) { if (!groups.has(i.client_id)) groups.set(i.client_id, []); groups.get(i.client_id).push(i); }
    const batches = [];
    for (const [cid, its] of groups) {
      const client = getClient(cid);
      const adjustment = db.prepare('SELECT * FROM pricing_adjustments WHERE sheet_id = ? AND client_id = ? AND batch_id IS NULL').get(sheet.id, cid);
      batches.push(createBatch({ sheet, client, items: its, adjustment, date: sheet.sheet_date, userId }));
    }
    const status = updatePricedStatus(sheet.id);
    return { batches, priced_status: status };
  })();
}

// ---------- the posted batch ----------
function getBatch(id) {
  const b = getDb().prepare('SELECT * FROM pricing_batches WHERE id = ?').get(id);
  if (!b) throw httpError(404, 'بيان الأعمال مش موجود');
  return b;
}

export function batchView(id) {
  const db = getDb();
  const b = getBatch(id);
  const mats = materialsById();
  const client = db.prepare('SELECT id, name FROM parties WHERE id = ?').get(b.client_id);
  const sheet = b.sheet_id ? getSheet(b.sheet_id) : null;
  const items = db.prepare('SELECT * FROM price_items WHERE batch_id = ? ORDER BY id').all(b.id).map((i) => itemView(i, mats));
  const adj = db.prepare('SELECT * FROM pricing_adjustments WHERE batch_id = ?').get(b.id);
  const txnIds = [b.txn_id, adj?.discount_txn_id].filter(Boolean);
  const txns = txnIds.map((t) => db.prepare('SELECT id, serial, kind, date, description, status, reversed_by, reason FROM txns WHERE id = ?').get(t));
  for (const t of [...txns]) if (t.reversed_by) txns.push(db.prepare('SELECT id, serial, kind, date, description, status, reversal_of, reason FROM txns WHERE id = ?').get(t.reversed_by));
  // the batch this one corrected / the batch that corrected this one
  const from = db.prepare(`SELECT DISTINCT o.batch_id AS id, ob.serial FROM price_items n JOIN price_items o ON o.id = n.corrected_from
    JOIN pricing_batches ob ON ob.id = o.batch_id WHERE n.batch_id = ?`).get(b.id) || null;
  const to = db.prepare(`SELECT DISTINCT n.batch_id AS id, nb.serial FROM price_items o JOIN price_items n ON n.corrected_from = o.id
    JOIN pricing_batches nb ON nb.id = n.batch_id WHERE o.batch_id = ?`).get(b.id) || null;
  const creator = b.created_by ? db.prepare('SELECT display_name FROM users WHERE id = ?').get(b.created_by)?.display_name : '';
  const work = items.reduce((s, i) => s + (i.amount || 0), 0);
  return {
    batch: {
      id: b.id, serial: b.serial, date: b.date, total: b.total, status: b.status, reason: b.reason, created_at: b.created_at,
      created_by_name: creator || '', work_amount: work, discount_amount: adj?.discount_amount || 0,
      addition_amount: adj?.addition_amount || 0, note: adj?.note || '',
      net_amount: b.total - (adj?.discount_amount || 0),
    },
    client,
    sheet: sheet ? { id: sheet.id, serial: sheet.serial, machine: sheet.machine, machine_name: MACHINE_NAMES[sheet.machine],
      technician_name: sheet.technician_name || '', sheet_date: sheet.sheet_date, has_photo: !!sheet.photo_path } : null,
    items, txns, corrected_from: from, corrected_by: to,
    month_locked: isMonthLocked(b.date),
  };
}

// «تصحيح سعر»: reverses the batch (with a reason) and posts corrected copies of its items.
// changes: [{ id, rate, billing }] for the items to change; discount / addition / note optional.
// The reversal and the new posting keep the sheet's date, or today when that month is locked,
// so a correction inside an open month never bills the client twice in it.
export function correctBatch(batchId, { reason, items: changes = [], discount, addition, note, userId }) {
  const r = cleanText(reason, 300);
  if (!r) throw bad('اكتب سبب التصحيح', 'reason');
  const db = getDb();
  return db.transaction(() => {
    const b = getBatch(batchId);
    if (b.status !== 'posted') throw httpError(409, 'بيان الأعمال ده اتصحح أو اتلغى قبل كده');
    const old = db.prepare("SELECT * FROM price_items WHERE batch_id = ? AND status = 'posted' ORDER BY id").all(b.id);
    const byId = new Map(old.map((i) => [i.id, i]));
    const want = new Map();
    for (const c of Array.isArray(changes) ? changes : []) {
      const id = Number(c.id);
      if (!byId.has(id)) throw bad('بند مش من بيان الأعمال ده');
      want.set(id, c);
    }
    const adj = db.prepare('SELECT * FROM pricing_adjustments WHERE batch_id = ?').get(b.id);
    const newAdj = {
      discount_amount: discount !== undefined ? amountInput(discount, 'الخصم', 'discount') : adj?.discount_amount || 0,
      addition_amount: addition !== undefined ? amountInput(addition, 'الإضافة', 'addition') : adj?.addition_amount || 0,
      note: note !== undefined ? cleanText(note, 300) : adj?.note || '',
    };
    // the corrected copies (validated before anything is reversed)
    const mats = materialsById();
    const copies = old.map((o) => {
      const c = want.get(o.id) || {};
      const n = { ...o };
      if (c.billing !== undefined && c.billing !== o.billing) {
        if (!BILLINGS[o.section].includes(c.billing)) throw bad('طريقة الحساب دي مش مناسبة للقسم ده', 'billing');
        n.billing = c.billing;
      }
      if (c.rate !== undefined) {
        const rate = rateInput(c.rate);
        if (rate === null) throw bad('اكتب سعر كل بند', 'rate');
        if (rate !== o.rate || n.billing !== o.billing) n.rate_source = 'manual';
        n.rate = rate;
      }
      Object.assign(n, recompute(n, mats));
      if (n.amount === null) throw bad(`البند «${o.part_name || SECTION_NAMES[o.section]}» ناقص كمية بالطريقة دي`);
      return n;
    });
    const unchanged = copies.every((n, i) => n.rate === old[i].rate && n.billing === old[i].billing)
      && newAdj.discount_amount === (adj?.discount_amount || 0) && newAdj.addition_amount === (adj?.addition_amount || 0);
    if (unchanged) throw bad('مفيش تغيير — غيّر سعر بند أو الخصم أو الإضافة');

    reverse(b.txn_id, r, { userId, atOriginalDate: true });
    if (adj?.discount_txn_id) reverse(adj.discount_txn_id, r, { userId, atOriginalDate: true });
    db.prepare("UPDATE pricing_batches SET status='reversed', reason=? WHERE id=?").run(r, b.id);
    db.prepare("UPDATE price_items SET status='cancelled', cancel_kind='corrected', cancel_reason=? WHERE batch_id=? AND status='posted'").run(r, b.id);
    const ins = db.prepare(`INSERT INTO price_items (op_line_id, sheet_id, client_id, section, work_date, part_name, material_id,
      thickness, pieces, per_piece, sheets, minutes_per_sheet, single_piece, length_cm, width_cm, weight_kg, qty, unit, rate,
      min_charge, amount, billing, rate_source, rate_confirmed, status, corrected_from, notes, created_by)
      VALUES (@op_line_id, @sheet_id, @client_id, @section, @work_date, @part_name, @material_id, @thickness, @pieces, @per_piece,
      @sheets, @minutes_per_sheet, @single_piece, @length_cm, @width_cm, @weight_kg, @qty, @unit, @rate, @min_charge, @amount,
      @billing, @rate_source, 1, 'suggested', @corrected_from, @notes, @created_by)`);
    const fresh = copies.map((n) => {
      const res = ins.run({ ...n, corrected_from: n.id, created_by: userId });
      return { ...n, id: Number(res.lastInsertRowid) };
    });
    const sheet = b.sheet_id ? getSheet(b.sheet_id) : null;
    const date = isMonthLocked(b.date) ? todayISO() : b.date;
    const client = getClient(b.client_id);
    const nb = createBatch({ sheet, client, items: fresh, adjustment: newAdj, date, userId, descriptionPrefix: 'تصحيح: ' });
    audit(userId, 'correct', 'pricing_batch', b.id, { status: 'posted', total: b.total }, { status: 'reversed', reason: r, new_batch: nb.serial, total: nb.total });
    if (b.sheet_id) updatePricedStatus(b.sheet_id);
    return nb;
  })();
}

// ---------- قيد يدوي على عميل ----------
const MANUAL_TXN = { debit: 'manual_debit', discount: 'manual_discount', addition: 'manual_addition' };

export function createManualEntry(body, userId) {
  const db = getDb();
  const client = getClient(Number(body.client_id));
  const kind = body.kind;
  if (!(kind in MANUAL_KINDS)) throw bad('اختار نوع القيد', 'kind');
  const date = realDate(body.date);
  if (!date) throw bad(date === null ? 'اكتب تاريخ القيد' : 'التاريخ ده مش موجود في النتيجة', 'date');
  const amount = parseMoney(body.amount);
  if (amount === null || Number.isNaN(amount) || amount <= 0) throw bad('المبلغ لازم يكون رقم أكبر من صفر', 'amount');
  if (amount > 1e12) throw bad('المبلغ كبير قوي', 'amount');
  const description = cleanText(body.description, 300).replace(/\s+/g, ' ');
  if (!description) throw bad('اكتب البيان (هيظهر في كشف الحساب)', 'description');
  return db.transaction(() => {
    const serial = nextSerial('قي');
    const r = db.prepare('INSERT INTO manual_entries (serial, client_id, kind, date, amount, description, created_by) VALUES (?,?,?,?,?,?,?)')
      .run(serial, client.id, kind, date, amount, description, userId);
    const id = Number(r.lastInsertRowid);
    const lines = kind === 'discount'
      ? [{ account: 'discount_given', debit: amount, memo: serial }, { account: 'receivable', party_id: client.id, credit: amount, memo: description }]
      : [{ account: 'receivable', party_id: client.id, debit: amount, memo: description }, { account: 'revenue:manual', credit: amount, memo: serial }];
    const txn = post(MANUAL_TXN[kind], date, description, lines, { userId, ref: serial, docType: 'manual_entry', docId: id, partyId: client.id });
    db.prepare('UPDATE manual_entries SET txn_id = ? WHERE id = ?').run(txn.id, id);
    audit(userId, 'create', 'manual_entry', id, undefined, { serial, client_id: client.id, kind, date, amount, description, txn: txn.serial });
    return manualEntryView(id);
  })();
}

export function manualEntryView(id) {
  const db = getDb();
  const e = db.prepare(`SELECT m.*, p.name AS client_name, t.serial AS txn_serial, u.display_name AS created_by_name
    FROM manual_entries m JOIN parties p ON p.id = m.client_id LEFT JOIN txns t ON t.id = m.txn_id
    LEFT JOIN users u ON u.id = m.created_by WHERE m.id = ?`).get(id);
  if (!e) throw httpError(404, 'القيد مش موجود');
  return { ...e, kind_name: MANUAL_KINDS[e.kind], month_locked: isMonthLocked(e.date) };
}

export function listManualEntries(clientId = null) {
  return getDb().prepare(`SELECT m.*, p.name AS client_name FROM manual_entries m JOIN parties p ON p.id = m.client_id
    WHERE (? IS NULL OR m.client_id = ?) ORDER BY m.date DESC, m.id DESC LIMIT 500`).all(clientId, clientId)
    .map((e) => ({ ...e, kind_name: MANUAL_KINDS[e.kind] }));
}

export function cancelManualEntry(id, reason, userId) {
  const r = cleanText(reason, 300);
  if (!r) throw bad('اكتب سبب إلغاء القيد', 'reason');
  const db = getDb();
  return db.transaction(() => {
    const e = db.prepare('SELECT * FROM manual_entries WHERE id = ?').get(id);
    if (!e) throw httpError(404, 'القيد مش موجود');
    if (e.status !== 'posted') throw httpError(409, 'القيد ده اتلغى قبل كده');
    reverse(e.txn_id, r, { userId, atOriginalDate: true });
    db.prepare("UPDATE manual_entries SET status='cancelled', cancel_reason=?, cancelled_by=?, cancelled_at=datetime('now') WHERE id=?").run(r, userId, e.id);
    audit(userId, 'cancel', 'manual_entry', e.id, { status: 'posted' }, { status: 'cancelled', reason: r });
    return manualEntryView(e.id);
  })();
}

// ---------- الأسعار العامة ----------
export function generalPrices() {
  return getDb().prepare(`SELECT g.*, u.display_name AS updated_by_name FROM general_prices g
    LEFT JOIN users u ON u.id = g.updated_by ORDER BY g.id`).all().map((g) => ({
    section: g.section, section_name: SECTION_NAMES[g.section], band: g.band, rate: g.rate, min_charge: g.min_charge,
    unit: SECTION_BILLING[g.section], unit_name: UNIT_NAMES[SECTION_BILLING[g.section]],
    has_min: g.section === 'laser' || g.section === 'punch', updated_at: g.updated_at, updated_by_name: g.updated_by_name || '',
  }));
}

// prices: [{ section, band, rate, min_charge }] (pounds; '' = no general price).
export function saveGeneralPrices(prices, userId) {
  if (!Array.isArray(prices) || !prices.length) throw bad('مفيش أسعار تتحفظ');
  const db = getDb();
  return db.transaction(() => {
    let changed = 0;
    for (const p of prices) {
      const cur = db.prepare('SELECT * FROM general_prices WHERE section = ? AND band = ?').get(p.section, p.band ?? '');
      if (!cur) throw bad('قسم أو شريحة غلط');
      const key = `${p.section}${p.band ? `:${p.band}` : ''}`;
      const rate = p.rate !== undefined ? rateInput(p.rate, `rate:${key}`) : cur.rate;
      let min = cur.min_charge;
      if (p.min_charge !== undefined) {
        if (!(p.section === 'laser' || p.section === 'punch')) throw bad('الحد الأدنى لليزر والبنش بس');
        min = rateInput(p.min_charge, `min_charge:${key}`);
      }
      if (rate === cur.rate && min === cur.min_charge) continue;
      db.prepare("UPDATE general_prices SET rate=?, min_charge=?, updated_by=?, updated_at=datetime('now') WHERE id=?").run(rate, min, userId, cur.id);
      audit(userId, 'update', 'general_price', cur.id, { rate: cur.rate, min_charge: cur.min_charge }, { section: p.section, band: cur.band, rate, min_charge: min });
      changed++;
    }
    return changed;
  })();
}

// ---------- شيت التسعير of one client (Excel layout) ----------
// Sections in the template's order with the per-section totals (rows 3 / 5) and the grand
// total (E1). Money fields are named so stripMoney() removes them for staff.
export function clientPricingSheet(clientId, { from = null, to = null } = {}) {
  const db = getDb();
  const client = getClient(Number(clientId));
  const f = realDate(from);
  const t = realDate(to);
  if (f === undefined || t === undefined) throw bad('التاريخ ده مش موجود في النتيجة');
  const mats = materialsById();
  const rows = db.prepare(`SELECT pi.*, s.serial AS sheet_serial, tc.name AS technician_name, b.serial AS batch_serial
    FROM price_items pi LEFT JOIN op_sheets s ON s.id = pi.sheet_id LEFT JOIN technicians tc ON tc.id = s.technician_id
    LEFT JOIN pricing_batches b ON b.id = pi.batch_id
    WHERE pi.client_id = ? AND pi.status IN ('suggested','posted','settled_in_excel')
      AND (? IS NULL OR pi.work_date >= ?) AND (? IS NULL OR pi.work_date <= ?)
    ORDER BY pi.work_date, pi.id`).all(client.id, f, f, t, t);
  const sum = (list, fn) => Number(list.reduce((s, i) => s + (Number(fn(i)) || 0), 0).toFixed(6));
  const money = (list, fn = () => true) => list.filter((i) => i.amount !== null && fn(i)).reduce((s, i) => s + i.amount, 0);
  const sections = SHEET_ORDER.map((sec) => {
    const items = rows.filter((r) => r.section === sec).map((r) => ({
      ...itemView(r, mats), sheet_serial: r.sheet_serial || '', technician_name: r.technician_name || '', batch_serial: r.batch_serial || '',
    }));
    const posted = items.filter((i) => i.status !== 'suggested');
    const sums = { count: items.length };
    const amounts = { amount: money(posted) };
    if (sec === 'press') {
      const bend = (band) => (i) => i.billing === 'bend' && i.band === band;
      Object.assign(sums, { pieces: sum(items, (i) => i.pieces), thin_bends: sum(items.filter(bend('<3')), (i) => i.qty), thick_bends: sum(items.filter(bend('>=3')), (i) => i.qty) });
      Object.assign(amounts, { thin_amount: money(posted, bend('<3')), thick_amount: money(posted, bend('>=3')), fixed_amount: money(posted, (i) => i.billing === 'piece'), lump_amount: money(posted, (i) => i.billing === 'lump') });
    } else if (sec === 'laser' || sec === 'punch') {
      Object.assign(sums, { sheets: sum(items, (i) => i.sheets), minutes: sum(items.filter((i) => i.billing === 'minute'), (i) => i.qty) });
    } else if (sec === 'louver') {
      Object.assign(sums, { pieces: sum(items, (i) => i.pieces), louvers: sum(items.filter((i) => i.billing === 'louver'), (i) => i.qty) });
    } else if (sec === 'shear') {
      Object.assign(sums, { pieces: sum(items, (i) => i.pieces), cuts: sum(items.filter((i) => i.billing === 'cut'), (i) => i.qty) });
    } else {
      const g = (grp) => sum(items.filter((i) => i.material_group === grp), (i) => i.weight_kg);
      Object.assign(sums, { sheets: sum(items, (i) => i.sheets), weight_kg: sum(items, (i) => i.weight_kg),
        galvanized_kg: g('galvanized'), black_kg: g('black'), stainless_kg: g('stainless'), aluminium_kg: g('aluminium') });
    }
    return { section: sec, name: SECTION_NAMES[sec], items, sums, ...amounts, waiting_count: items.filter((i) => i.status === 'suggested').length };
  });
  return {
    client: { id: client.id, name: client.name }, from: f, to: t,
    sections,
    total: sections.reduce((s, x) => s + x.amount, 0),
    waiting_count: sections.reduce((s, x) => s + x.waiting_count, 0),
  };
}
