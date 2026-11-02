// Writing an import plan into the database, inside ONE transaction, through the same code and
// with the same shapes as the app's own documents:
//   parties (aliases, «عميل خارجي» = walk-in), materials (density table), client_rates (row 4)
//   op_sheets (source 'import', approved, one per machine per date) + op_lines
//   price_items: posted (one pricing batch تس- and one 'import_work' transaction per client per
//     section per date: Dr receivable / Cr revenue:<section>) or settled_in_excel (no money)
//   statement rows: manual debit / discount (قي-), receipts (قب-), client cheques collected (شك-)
//   partners: receipts (deposits), expense vouchers paid by the partner, withdrawals, our cheques
//   «المصروفات اليومية»: expense vouchers from the cash box; «الخامات»: material purchases
// Everything carries import_run_id; ledger.post skips its per-row audit for imports, the run
// itself is audited. Returns what was created (for the reconciliation and the rollback).
import { getDb, audit } from '../db.js';
import { post, nextSerial, SECTION_NAMES, MACHINE_NAMES } from '../ledger.js';
import { createReceipt, createVoucher, collectCheque, clearCheque } from '../treasury/index.js';
import { parseMaterialText, foldName as paperFold } from '../../public/js/modules/ops-paper.js';
import { foldName, toAsciiDigits } from '../util.js';
import { mulRound } from '../money.js';
import { rateMillimes } from './parse.js';
import { materialGroup } from '../pricing/formulas.js';

const dmy = (iso) => { const [y, m, d] = String(iso).split('-'); return `${Number(d)}/${Number(m)}/${y}`; };
const pos = (x) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : null);
const nonNeg = (x) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null);
const parseAliases = (s) => { try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
const chequeNo = (text) => (toAsciiDigits(text || '').match(/\d{3,}/) || [])[0] || 'غير مسجل';
const FROM_EXCEL = 'من الإكسيل';

export function applyPlan(plan, { runId, userId = null } = {}) {
  const db = getDb();
  const ctx = { userId, importRunId: runId };
  const created = {
    parties: [], parties_updated: [], materials: [], materials_updated: [], client_rates: [],
    sheets: [], lines: [], items: [], batches: [], manual_entries: [], receipts: [], vouchers: [], cheques: [],
    by_source: { daily: [], materials: [], partners: [], other_cheques: [] }, out_cheques: [],
    work_refs: {},
  };

  // ---------- parties ----------
  const partyIds = new Map();
  const ensureParty = (kind, group, extra = {}) => {
    const spellings = [group.name, ...(group.aliases || [])];
    const wanted = new Set(spellings.map(foldName));
    const rows = db.prepare('SELECT * FROM parties WHERE kind = ?').all(kind);
    const ex = rows.find((p) => wanted.has(foldName(p.name)) || parseAliases(p.aliases).some((a) => wanted.has(foldName(a))));
    if (ex) {
      const before = { aliases: ex.aliases, active: ex.active, is_walk_in: ex.is_walk_in };
      const aliases = parseAliases(ex.aliases);
      const add = spellings.filter((n) => n !== ex.name && !aliases.some((a) => foldName(a) === foldName(n)) && foldName(n) !== foldName(ex.name));
      const next = [...aliases, ...add].slice(0, 20);
      const walk = extra.walk_in ? 1 : ex.is_walk_in;
      if (add.length || !ex.active || walk !== ex.is_walk_in) {
        db.prepare('UPDATE parties SET aliases = ?, active = 1, is_walk_in = ? WHERE id = ?').run(JSON.stringify(next), walk, ex.id);
        created.parties_updated.push({ id: ex.id, before });
      }
      partyIds.set(group.id, ex.id);
      return ex.id;
    }
    const aliases = [...new Set((group.aliases || []).filter((a) => a && a !== group.name))].slice(0, 20);
    const id = Number(db.prepare(`INSERT INTO parties (kind, name, aliases, is_walk_in, import_run_id, created_by, notes)
      VALUES (?,?,?,?,?,?,?)`).run(kind, group.name.slice(0, 80), JSON.stringify(aliases), extra.walk_in ? 1 : 0, runId, userId, FROM_EXCEL).lastInsertRowid);
    created.parties.push(id);
    partyIds.set(group.id, id);
    return id;
  };
  for (const c of plan.clients) ensureParty('client', c, { walk_in: c.walk_in });
  for (const s of plan.suppliers) ensureParty('supplier', s);
  for (const p of plan.partners) ensureParty('partner', { id: p.id, name: p.name, aliases: p.spellings.filter((n) => n !== p.name) });
  const pid = (groupId) => (groupId ? partyIds.get(groupId) ?? null : null);
  let unknownSupplier = null;
  const supplierFor = (groupId) => {
    if (groupId && pid(groupId)) return pid(groupId);
    if (!unknownSupplier) unknownSupplier = ensureParty('supplier', { id: 's:?', name: 'مورد غير محدد (من الإكسيل)', aliases: [] });
    return unknownSupplier;
  };

  // ---------- materials (the density table) ----------
  const loadMaterials = () => db.prepare('SELECT id, name, aliases, density, grp FROM materials').all().map((m) => ({ ...m, aliases: parseAliases(m.aliases) }));
  let materials = loadMaterials();
  // the material of a group: same spelling, else the same known group (أسود / مجلفن / ستانلس / ألومنيوم)
  const knownGroup = (g) => (/اسود|أسود|حديد|بلاك|مجلفن|جلفن|ستانل|استانل|الومن|المون|ألمن|المنيوم|ألومن/.test(String(g || '')) ? materialGroup(g) : null);
  const groupMat = (grp) => {
    const g = paperFold(grp);
    const same = materials.find((m) => [m.name, m.grp, ...m.aliases].some((n) => paperFold(n) === g));
    if (same) return same;
    const k = knownGroup(grp);
    return k ? [...materials].sort((x, y) => x.id - y.id).find((m) => knownGroup(m.grp || m.name) === k) : null;
  };
  for (const d of plan.densities) {
    const f = paperFold(d.name);
    let m = materials.find((x) => [x.name, ...x.aliases].some((n) => paperFold(n) === f));
    if (!m) {
      const g = groupMat(d.group || d.name);
      if (g && (!pos(g.density) || Math.abs(g.density - d.density) < 1e-9)) {
        // another spelling of a known material: an alias
        const before = { aliases: JSON.stringify(g.aliases), density: g.density };
        db.prepare('UPDATE materials SET aliases = ? WHERE id = ?').run(JSON.stringify([...g.aliases, d.name].slice(0, 30)), g.id);
        created.materials_updated.push({ id: g.id, before });
      } else {
        const id = Number(db.prepare('INSERT INTO materials (name, aliases, density, grp, sort, import_run_id) VALUES (?,?,?,?,?,?)')
          .run(d.name.slice(0, 60), '[]', pos(d.density), d.group || '', 50, runId).lastInsertRowid);
        created.materials.push(id);
      }
      materials = loadMaterials();
      continue;
    }
    if (pos(d.density) && Math.abs((m.density || 0) - d.density) > 1e-9 && paperFold(m.name) === f) {
      created.materials_updated.push({ id: m.id, before: { aliases: JSON.stringify(m.aliases), density: m.density } });
      db.prepare('UPDATE materials SET density = ? WHERE id = ?').run(d.density, m.id);
      materials = loadMaterials();
    }
  }
  const materialOf = (text) => (text ? parseMaterialText(text, materials).material_id ?? null : null);

  // ---------- the client's rates (row 4) → a suggested-rate source ----------
  for (const r of plan.clientRates) {
    const cid = pid(r.client);
    if (!cid) continue;
    const ex = db.prepare('SELECT id FROM client_rates WHERE client_id = ? AND section = ? AND band = ?').get(cid, r.section, r.band);
    if (ex) continue; // the admin's own rate stays
    created.client_rates.push(Number(db.prepare(`INSERT INTO client_rates (client_id, section, band, rate, source, import_run_id)
      VALUES (?,?,?,?, 'import', ?)`).run(cid, r.section, r.band, r.rate, runId).lastInsertRowid));
  }

  // ---------- operation sheets and lines ----------
  const sheets = new Map();
  const sheetFor = (machine, date) => {
    if (!machine) return null;
    const k = `${machine}|${date}`;
    if (!sheets.has(k)) {
      const serial = nextSerial('تش');
      const id = Number(db.prepare(`INSERT INTO op_sheets (serial, base_serial, machine, sheet_date, source, status, approved_by, approved_at,
          priced_status, notes, import_run_id, created_by, draft, submitted_at)
        VALUES (?,?,?,?, 'import', 'approved', ?, datetime('now'), 'posted', ?, ?, ?, 0, datetime('now'))`)
        .run(serial, serial, machine, date, userId, `ورقة ${MACHINE_NAMES[machine]} ${FROM_EXCEL}`, runId, userId).lastInsertRowid);
      sheets.set(k, { id, serial, rows: 0 });
      created.sheets.push(id);
    }
    return sheets.get(k);
  };
  const insLine = db.prepare(`INSERT INTO op_lines (sheet_id, row_no, client_id, client_text, part_name, material_id, material_text, thickness,
      pieces, per_piece, total_written, sheets, minutes_per_sheet, single_piece, louvers_per_piece, material_source, length_cm, width_cm,
      work_date, notes, status, import_run_id)
    VALUES (@sheet_id, @row_no, @client_id, @client_text, @part_name, @material_id, @material_text, @thickness, @pieces, @per_piece,
      @total_written, @sheets, @minutes_per_sheet, @single_piece, @louvers_per_piece, @material_source, @length_cm, @width_cm,
      @work_date, @notes, @status, @import_run_id)`);
  const addLine = (it, clientId, status) => {
    const sh = sheetFor(it.machine, it.date);
    if (!sh) return { sheet: null, line: null };
    sh.rows++;
    const louver = it.section === 'louver';
    const id = Number(insLine.run({
      sheet_id: sh.id, row_no: sh.rows, client_id: clientId, client_text: (it.client_text || '').slice(0, 80), part_name: (it.part_name || '').slice(0, 120),
      material_id: it.material_id ?? null, material_text: (it.material_text || '').slice(0, 60), thickness: pos(it.thickness),
      pieces: nonNeg(it.pieces), per_piece: louver ? null : nonNeg(it.per_piece), total_written: typeof it.qty === 'number' ? it.qty : null,
      sheets: nonNeg(it.sheets), minutes_per_sheet: nonNeg(it.minutes_per_sheet), single_piece: it.single_piece ? 1 : 0,
      louvers_per_piece: louver ? nonNeg(it.per_piece) : null, material_source: null, length_cm: pos(it.length_cm), width_cm: pos(it.width_cm),
      work_date: it.date, notes: `${FROM_EXCEL}: ${it.ref}`.slice(0, 300), status, import_run_id: runId,
    }).lastInsertRowid);
    created.lines.push(id);
    return { sheet: sh, line: id };
  };
  const insItem = db.prepare(`INSERT INTO price_items (op_line_id, sheet_id, batch_id, client_id, section, work_date, part_name, material_id,
      thickness, pieces, per_piece, sheets, minutes_per_sheet, single_piece, length_cm, width_cm, weight_kg, qty, unit, rate, min_charge, amount,
      billing, rate_source, status, txn_id, import_ref, import_run_id, notes, created_by, rate_confirmed)
    VALUES (@op_line_id, @sheet_id, @batch_id, @client_id, @section, @work_date, @part_name, @material_id, @thickness, @pieces, @per_piece,
      @sheets, @minutes_per_sheet, @single_piece, @length_cm, @width_cm, @weight_kg, @qty, @unit, @rate, @min_charge, @amount, @billing,
      'import', @status, @txn_id, @import_ref, @import_run_id, @notes, @created_by, @rate_confirmed)`);
  const addItem = (it, clientId, line, sheet, status, batch = null) => {
    const lump = status === 'posted' && it.billing === 'lump';
    const row = {
      op_line_id: line, sheet_id: sheet?.id ?? null, batch_id: batch?.id ?? null, client_id: clientId, section: it.section, work_date: it.date,
      part_name: (it.part_name || '').slice(0, 120), material_id: it.material_id ?? null, thickness: pos(it.thickness), pieces: nonNeg(it.pieces),
      per_piece: nonNeg(it.per_piece), sheets: nonNeg(it.sheets), minutes_per_sheet: nonNeg(it.minutes_per_sheet), single_piece: it.single_piece ? 1 : 0,
      length_cm: pos(it.length_cm), width_cm: pos(it.width_cm), weight_kg: nonNeg(it.weight_kg),
      qty: lump ? 1 : (typeof it.qty === 'number' ? it.qty : null), unit: lump ? 'lump' : it.billing,
      rate: lump ? it.amount : it.rate ?? null, min_charge: it.min_charge ?? null, amount: status === 'posted' ? it.amount : null,
      billing: lump ? 'lump' : it.billing, status: status === 'posted' ? 'posted' : 'settled_in_excel', txn_id: batch?.txn_id ?? null,
      import_ref: it.ref, import_run_id: runId, created_by: userId, rate_confirmed: status === 'posted' ? 1 : 0,
      notes: [FROM_EXCEL, ...(it.notes || []), lump && it.formula_amount !== null && it.formula_amount !== undefined ? `المعادلة: ${(it.formula_amount / 1000).toFixed(3)}` : null].filter(Boolean).join(' — ').slice(0, 300),
    };
    const id = Number(insItem.run(row).lastInsertRowid);
    created.items.push(id);
    return id;
  };

  // work items: lines on the sheets, then one batch per client per section per date
  const work = [...plan.work].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const batches = new Map();
  for (const it of work) {
    const clientId = pid(it.client);
    it.material_id = materialOf(it.material_text);
    const { sheet, line } = addLine(it, clientId, it.status === 'posted' ? 'active' : 'settled_in_excel');
    it._sheet = sheet;
    it._line = line;
    if (it.status !== 'posted') { addItem(it, clientId, line, sheet, 'settled'); continue; }
    const k = `${clientId}|${it.section}|${it.date}`;
    if (!batches.has(k)) batches.set(k, { clientId, section: it.section, date: it.date, sheet, items: [] });
    batches.get(k).items.push(it);
  }
  const insBatch = db.prepare(`INSERT INTO pricing_batches (serial, sheet_id, client_id, date, total, import_run_id, created_by) VALUES (?,?,?,?,?,?,?)`);
  for (const b of [...batches.values()].sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0))) {
    const total = b.items.reduce((s, i) => s + i.amount, 0);
    const serial = nextSerial('تس');
    const id = Number(insBatch.run(serial, b.sheet?.id ?? null, b.clientId, b.date, total, runId, userId).lastInsertRowid);
    const desc = b.sheet
      ? `بيان أعمال ${SECTION_NAMES[b.section]} — ورقة ${b.sheet.serial} — ${dmy(b.date)} — ${FROM_EXCEL}`
      : `بيان أعمال ${SECTION_NAMES[b.section]} — ${dmy(b.date)} — ${FROM_EXCEL}`;
    const txn = post('import_work', b.date, desc, [
      { account: 'receivable', party_id: b.clientId, debit: total, memo: serial },
      { account: `revenue:${b.section}`, credit: total, section: b.section, memo: SECTION_NAMES[b.section] },
    ], { userId, ref: serial, docType: 'pricing_batch', docId: id, partyId: b.clientId, importRunId: runId });
    db.prepare('UPDATE pricing_batches SET txn_id = ? WHERE id = ?').run(txn.id, id);
    created.batches.push(id);
    for (const it of b.items) {
      addItem(it, b.clientId, it._line, it._sheet, 'posted', { id, txn_id: txn.id });
      const sheetName = it.ref.split('!')[0];
      created.work_refs[sheetName] = (created.work_refs[sheetName] || 0) + it.amount;
    }
  }
  // log rows that never reached a client sheet: history only (no money)
  for (const r of plan.logLines) {
    const clientId = pid(r.client);
    const it = { ...r, part_name: '', material_id: materialOf(r.material_text), billing: r.section === 'material' ? 'kg' : { press: 'bend', laser: 'minute', punch: 'minute', louver: 'louver', shear: 'cut' }[r.section], notes: ['من سجل العملاء'] };
    const { sheet, line } = addLine(it, clientId, 'settled_in_excel');
    addItem(it, clientId, line, sheet, 'settled');
  }

  // ---------- money documents, in date order (serials follow the calendar) ----------
  const docs = [];
  for (const m of plan.manual) docs.push({ date: m.date, order: 1, run: () => manualEntry(m) });
  for (const r of plan.receipts) docs.push({ date: r.date, order: 2, run: () => clientReceipt(r) });
  for (const p of plan.partnerOps) docs.push({ date: p.date, order: 3, run: () => partnerOp(p) });
  for (const c of plan.otherCheques) docs.push({ date: c.date, order: 4, run: () => otherCheque(c) });
  for (const e of plan.expenses) docs.push({ date: e.date, order: 5, run: () => expense(e) });
  for (const m of plan.purchases) docs.push({ date: m.date, order: 6, run: () => purchase(m) });
  docs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order));

  const MANUAL_TXN = { debit: 'manual_debit', discount: 'manual_discount' };
  function manualEntry(m) {
    const clientId = pid(m.client);
    const serial = nextSerial('قي');
    const description = (m.desc || (m.kind === 'debit' ? 'مدين من كشف الإكسيل' : 'خصم من كشف الإكسيل')).replace(/\s+/g, ' ').slice(0, 300);
    const id = Number(db.prepare(`INSERT INTO manual_entries (serial, client_id, kind, date, amount, description, import_run_id, created_by)
      VALUES (?,?,?,?,?,?,?,?)`).run(serial, clientId, m.kind, m.date, m.amount, description, runId, userId).lastInsertRowid);
    const lines = m.kind === 'discount'
      ? [{ account: 'discount_given', debit: m.amount, memo: serial }, { account: 'receivable', party_id: clientId, credit: m.amount, memo: description }]
      : [{ account: 'receivable', party_id: clientId, debit: m.amount, memo: description }, { account: 'revenue:manual', credit: m.amount, memo: serial }];
    const txn = post(MANUAL_TXN[m.kind], m.date, description, lines, { userId, ref: serial, docType: 'manual_entry', docId: id, partyId: clientId, importRunId: runId });
    db.prepare('UPDATE manual_entries SET txn_id = ? WHERE id = ?').run(txn.id, id);
    created.manual_entries.push(id);
  }
  function clientReceipt(r) {
    const party = pid(r.client);
    if (r.cheque) {
      const rc = createReceipt({ party_id: party, date: r.date, amount_millimes: r.amount, method: 'cheque', notes: r.desc,
        cheque: { number: chequeNo(r.desc), bank: '', due_date: r.date } }, ctx);
      collectCheque(rc.cheque_id, { date: r.date }, ctx);
      created.receipts.push(rc.id);
      created.cheques.push(rc.cheque_id);
      return;
    }
    const rc = createReceipt({ party_id: party, date: r.date, amount_millimes: r.amount, method: 'cash', notes: r.desc }, ctx);
    created.receipts.push(rc.id);
  }
  function ourCheque(voucherInput, date) {
    const v = createVoucher(voucherInput, ctx);
    created.vouchers.push(v.id);
    created.cheques.push(v.cheque_id);
    created.out_cheques.push(v.cheque_id);
    clearCheque(v.cheque_id, { date }, ctx);
    return v;
  }
  function partnerOp(p) {
    const partner = pid(p.partner);
    if (p.class === 'deposit') {
      const rc = createReceipt({ party_id: partner, date: p.date, amount_millimes: p.amount, method: p.account === 'cash' ? 'cash' : 'transfer', notes: p.desc }, ctx);
      created.receipts.push(rc.id);
      created.by_source.partners.push({ type: 'receipt', id: rc.id });
    } else if (p.class === 'expense') {
      const v = createVoucher({ kind: 'expense', date: p.date, paid_from: 'partner', paid_from_party_id: partner, description: p.desc,
        lines: [{ category_id: p.category?.id, amount_millimes: p.amount, description: '' }] }, ctx);
      created.vouchers.push(v.id);
      created.by_source.partners.push({ type: 'voucher', id: v.id });
    } else if (p.class === 'withdrawal') {
      const v = createVoucher({ kind: 'partner_withdrawal', date: p.date, party_id: partner, paid_from: p.account === 'bank' ? 'bank' : 'cash',
        amount_millimes: p.amount, description: p.desc }, ctx);
      created.vouchers.push(v.id);
      created.by_source.partners.push({ type: 'voucher', id: v.id });
    } else if (p.class === 'cheque') {
      const v = ourCheque({ kind: 'partner_withdrawal', date: p.date, party_id: partner, paid_from: 'cheque', amount_millimes: p.amount, description: p.desc,
        cheque: { number: p.cheque?.number || chequeNo(p.desc), bank: '', due_date: p.date } }, p.date);
      created.by_source.partners.push({ type: 'voucher', id: v.id, cheque: true });
    }
  }
  function otherCheque(c) {
    const cheque = { number: c.number || 'غير مسجل', bank: '', due_date: c.date, payee_text: c.payee };
    const v = c.supplier
      ? ourCheque({ kind: 'supplier_payment', date: c.date, party_id: supplierFor(c.supplier), paid_from: 'cheque', amount_millimes: c.amount, description: c.desc, cheque }, c.date)
      : ourCheque({ kind: 'expense', date: c.date, paid_from: 'cheque', description: [c.payee, c.desc].filter(Boolean).join(' — '),
        lines: [{ category_id: c.category?.id, amount_millimes: c.amount }], cheque }, c.date);
    created.by_source.other_cheques.push(v.id);
  }
  function expense(e) {
    const v = createVoucher({ kind: 'expense', date: e.date, paid_from: 'cash', description: e.desc,
      lines: [{ category_id: e.category?.id, amount_millimes: e.amount, cost_party_id: pid(e.cost_client), description: e.notes || '' }] }, ctx);
    created.vouchers.push(v.id);
    created.by_source.daily.push(v.id);
  }
  function purchase(m) {
    const supplier = supplierFor(m.supplier);
    const parsed = parseMaterialText(m.material_text || '', materials);
    const unit = rateMillimes(m.unit_rate);
    const exact = m.qty > 0 && unit > 0 && mulRound(m.qty, unit) === m.amount;
    const item = exact
      ? { material_id: parsed.material_id, material_text: m.material_text || 'خامات', thickness: pos(parsed.thickness), qty: m.qty, unit: '', unit_rate_millimes: unit }
      : { material_id: parsed.material_id, material_text: m.material_text || 'خامات', thickness: pos(parsed.thickness), qty: 1, unit: 'مقطوعية', unit_rate_millimes: m.amount };
    const input = { kind: 'material_purchase', date: m.date, party_id: supplier, description: m.notes || '', items: [item] };
    let v;
    if (m.method === 'cheque') v = ourCheque({ ...input, paid_from: 'cheque', cheque: { number: m.cheque_number || 'غير مسجل', bank: '', due_date: m.date } }, m.date);
    else { v = createVoucher({ ...input, paid_from: 'cash' }, ctx); created.vouchers.push(v.id); }
    created.by_source.materials.push(v.id);
  }

  for (const d of docs) d.run();
  created.party_map = Object.fromEntries(partyIds);
  return created;
}

// The run's own audit row (the documents of an import are not audited one by one).
export function auditRun(userId, runId, action, after) {
  audit(userId, action, 'import_run', runId, undefined, after);
}
