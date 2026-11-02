// متابعة التحصيل: notes on a party with the next date to call / visit. Not money: nothing
// here posts to the ledger. Every change is audited inside the same DB transaction.
// A follow-up that is done stays in the history (done_at); deleting is for a mistaken entry.
import { getDb, audit } from '../db.js';
import { can } from '../permissions.js';
import { httpError, cleanText } from '../util.js';
import { partyBalance } from '../ledger.js';
import { balanceWords } from '../money.js';
import { dateParam } from './dates.js';

const KIND_OK = new Set(['client', 'supplier', 'worker', 'partner']);

function partyFor(user, id) {
  const p = getDb().prepare('SELECT id, kind, name FROM parties WHERE id = ?').get(Number(id) || 0);
  if (!p || !KIND_OK.has(p.kind)) throw httpError(400, 'اختار العميل', { field: 'party_id' });
  if (p.kind === 'partner' && !can(user, 'money.view')) throw httpError(403, 'مش مسموح لك بالحركة دي');
  return p;
}

function cleanNote(v) {
  const s = cleanText(v, 500);
  if (!s) throw httpError(400, 'اكتب المتابعة: اتكلمت مع مين وقال إيه', { field: 'note' });
  return s;
}

export function getFollowUp(id) {
  const f = getDb().prepare('SELECT * FROM follow_ups WHERE id = ?').get(Number(id) || 0);
  if (!f) throw httpError(404, 'المتابعة مش موجودة');
  return f;
}

// status: due (open and next_date ≤ asOf) · open · done · all
export function listFollowUps(user, { status = 'open', partyId = null, asOf }) {
  const money = can(user, 'money.view');
  const where = [];
  const args = [];
  if (status === 'due') { where.push('f.done = 0 AND f.next_date IS NOT NULL AND f.next_date <= ?'); args.push(asOf); }
  else if (status === 'open') where.push('f.done = 0');
  else if (status === 'done') where.push('f.done = 1');
  if (partyId) { where.push('f.party_id = ?'); args.push(partyId); }
  if (!money) where.push("p.kind <> 'partner'");
  const rows = getDb().prepare(`
    SELECT f.*, p.name AS party_name, p.kind AS party_kind, p.phone AS party_phone, u.display_name AS created_by_name
    FROM follow_ups f JOIN parties p ON p.id = f.party_id LEFT JOIN users u ON u.id = f.created_by
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY f.done, CASE WHEN f.next_date IS NULL THEN 1 ELSE 0 END, f.next_date, f.id DESC`).all(...args);
  const balances = new Map();
  return rows.map((f) => {
    const row = {
      id: f.id, party_id: f.party_id, party_name: f.party_name, party_kind: f.party_kind, party_phone: f.party_phone,
      note: f.note, next_date: f.next_date, done: !!f.done, done_at: f.done_at,
      created_by_name: f.created_by_name, created_at: f.created_at,
      overdue: !f.done && !!f.next_date && f.next_date < asOf,
      due_today: !f.done && f.next_date === asOf,
    };
    if (money) {
      if (!balances.has(f.party_id)) balances.set(f.party_id, partyBalance(f.party_id));
      row.balance = balances.get(f.party_id);
      row.balance_text = balanceWords(row.balance).text;
    }
    return row;
  });
}

export function createFollowUp(user, body) {
  const db = getDb();
  const p = partyFor(user, body.party_id);
  const note = cleanNote(body.note);
  const next = dateParam(body.next_date, 'ميعاد المتابعة الجاية', null, 'next_date');
  return db.transaction(() => {
    const r = db.prepare('INSERT INTO follow_ups (party_id, note, next_date, created_by) VALUES (?, ?, ?, ?)').run(p.id, note, next, user.id);
    const id = Number(r.lastInsertRowid);
    audit(user.id, 'create', 'follow_up', id, undefined, { party_id: p.id, note, next_date: next });
    return getFollowUp(id);
  })();
}

export function updateFollowUp(user, id, body) {
  const db = getDb();
  const cur = getFollowUp(id);
  partyFor(user, cur.party_id);
  const next = {
    note: body.note !== undefined ? cleanNote(body.note) : cur.note,
    next_date: body.next_date !== undefined ? dateParam(body.next_date, 'ميعاد المتابعة الجاية', null, 'next_date') : cur.next_date,
    done: body.done !== undefined ? (body.done ? 1 : 0) : cur.done,
  };
  return db.transaction(() => {
    const doneAt = next.done && !cur.done ? new Date().toISOString().slice(0, 19).replace('T', ' ') : next.done ? cur.done_at : null;
    db.prepare('UPDATE follow_ups SET note = ?, next_date = ?, done = ?, done_at = ? WHERE id = ?').run(next.note, next.next_date, next.done, doneAt, cur.id);
    const action = next.done && !cur.done ? 'done' : !next.done && cur.done ? 'reopen' : 'update';
    audit(user.id, action, 'follow_up', cur.id, { note: cur.note, next_date: cur.next_date, done: cur.done }, next);
    return getFollowUp(cur.id);
  })();
}

// خلصت — and, optionally, the next follow-up in the same step.
export function completeFollowUp(user, id, body = {}) {
  const db = getDb();
  const cur = getFollowUp(id);
  if (cur.done) throw httpError(409, 'المتابعة دي متقفلة بالفعل');
  const wantsNext = !!(body.next_date || (body.next_note && String(body.next_note).trim()));
  const nextDate = wantsNext ? dateParam(body.next_date, 'ميعاد المتابعة الجاية', null, 'next_date') : null;
  if (wantsNext && !nextDate) throw httpError(400, 'حدد ميعاد المتابعة الجاية', { field: 'next_date' });
  return db.transaction(() => {
    const done = updateFollowUp(user, cur.id, { done: true, note: body.note !== undefined && String(body.note).trim() ? body.note : cur.note });
    const created = wantsNext ? createFollowUp(user, { party_id: cur.party_id, note: body.next_note || cur.note, next_date: nextDate }) : null;
    return { done, next: created };
  })();
}

export function deleteFollowUp(user, id) {
  const db = getDb();
  const cur = getFollowUp(id);
  partyFor(user, cur.party_id);
  db.transaction(() => {
    db.prepare('DELETE FROM follow_ups WHERE id = ?').run(cur.id);
    audit(user.id, 'delete', 'follow_up', cur.id, cur, undefined);
  })();
  return cur;
}
