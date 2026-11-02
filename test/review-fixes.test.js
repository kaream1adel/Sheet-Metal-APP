// Regression tests for the review of the rebuild (findings 1, 2, 3): المركز المالي with a
// cheque still in the portfolio, a price correction inside an open month, and the position
// as of a past date. Every name and amount is invented. Amounts are millimes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';
import { getDb } from '../src/db.js';
import * as L from '../src/ledger.js';
import * as T from '../src/treasury/index.js';
import * as P from '../src/pricing/service.js';
import { financialPosition } from '../src/reports/position.js';
import { monthProfit } from '../src/reports/profit.js';

let app; let uid;
const addParty = (kind, name) => Number(getDb().prepare('INSERT INTO parties (kind, name) VALUES (?, ?)').run(kind, name).lastInsertRowid);

before(async () => {
  app = await startApp();
  uid = Number(getDb().prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('rf','rf','x','admin')").run().lastInsertRowid);
});
after(() => app.stop());

test('finding 1: a cheque in the portfolio is not counted twice in صافي المركز', () => {
  const A = addParty('client', 'عميل تجربة شيك');
  L.post('pricing', '2026-10-05', 'شغل', [{ account: 'receivable', party_id: A, debit: 1000000 }, { account: 'revenue:press', credit: 1000000, section: 'press' }], { userId: uid });
  T.createReceipt({ party_id: A, date: '2026-10-06', amount: '1000', method: 'cheque', cheque: { number: '77', bank: 'بنك', due_date: '2026-11-20' } }, { userId: uid });
  assert.equal(L.partyBalance(A), 1000000, 'the receivable still holds the uncollected cheque');
  const fp = financialPosition();
  const chq = fp.ours.find((l) => l.key === 'cheques_in');
  assert.equal(chq.amount, 1000000);
  assert.equal(chq.memo, true);
  // net = what the ledger says, the cheque counted once (inside the receivable)
  const ledgerNet = L.balance('cash') + L.balance('bank') + L.balance('receivable') + L.balance('worker')
    + L.balance('partner') + L.balance('payable') + L.balance('cheques_payable');
  assert.equal(fp.net_total, ledgerNet);
  assert.equal(fp.ours_total, fp.ours.filter((l) => !l.memo).reduce((s, l) => s + l.amount, 0));
});

test('finding 2: «تصحيح سعر» in an open month replaces the work in the sheet month', () => {
  const db = getDb();
  const A = addParty('client', 'عميل تجربة تصحيح');
  const tech = Number(db.prepare("INSERT INTO technicians (name) VALUES ('فني تجربة')").run().lastInsertRowid);
  const sid = Number(db.prepare(`INSERT INTO op_sheets (serial, machine, technician_id, sheet_date, status, source)
    VALUES ('تش-9901','press',?,'2026-09-15','approved','manual')`).run(tech).lastInsertRowid);
  db.prepare(`INSERT INTO op_lines (sheet_id,row_no,client_id,part_name,pieces,per_piece,status) VALUES (?,1,?,'قطعة',10,4,'active')`).run(sid, A);
  const sp = P.sheetForPricing(sid, uid);
  const item = sp.clients[0].items[0];
  P.updateItem(item.id, { rate: '5' }, uid);
  const posted = P.postSheet(sid, { userId: uid });
  const sepBefore = monthProfit('2026-09').revenue_total;
  const thisMonth = new Date().toISOString().slice(0, 7);
  const nowBefore = monthProfit(thisMonth).revenue_total;
  P.correctBatch(posted.batches[0].id, { reason: 'سعر غلط', items: [{ id: item.id, rate: '4' }], userId: uid });
  assert.equal(monthProfit('2026-09').revenue_total, sepBefore - 40000, 'September carries only the corrected 160');
  assert.equal(monthProfit(thisMonth).revenue_total, nowBefore, 'the month of the correction is untouched');
  const st = L.statement(A, '2026-09-01', '2026-09-30', { hideReversed: true });
  assert.deepEqual(st.rows.map((r) => r.debit), [160000]);
  assert.equal(st.closing, 160000);

  // a locked sheet month: the reversal and the new batch both land today
  const sid2 = Number(db.prepare(`INSERT INTO op_sheets (serial, machine, technician_id, sheet_date, status, source)
    VALUES ('تش-9902','press',?,'2026-08-15','approved','manual')`).run(tech).lastInsertRowid);
  db.prepare(`INSERT INTO op_lines (sheet_id,row_no,client_id,part_name,pieces,per_piece,status) VALUES (?,1,?,'قطعة',10,4,'active')`).run(sid2, A);
  const it2 = P.sheetForPricing(sid2, uid).clients[0].items[0];
  P.updateItem(it2.id, { rate: '5' }, uid);
  const p2 = P.postSheet(sid2, { userId: uid });
  L.lockMonth('2026-08', uid);
  const augBefore = monthProfit('2026-08').revenue_total;
  P.correctBatch(p2.batches[0].id, { reason: 'سعر غلط', items: [{ id: it2.id, rate: '4' }], userId: uid });
  assert.equal(monthProfit('2026-08').revenue_total, augBefore, 'a locked month never changes');
  assert.equal(monthProfit(thisMonth).revenue_total, nowBefore - 40000);
});

test('finding 3: the position as of a past date leaves out later postings', () => {
  const A = addParty('client', 'عميل تجربة تاريخ');
  const before = financialPosition('2026-10-31');
  T.createReceipt({ party_id: A, date: '2026-12-20', amount: '500', method: 'cash' }, { userId: uid });
  const fp = financialPosition('2026-10-31');
  assert.equal(fp.cash_balance, before.cash_balance);
  assert.equal(fp.net_total, before.net_total);
  assert.equal(financialPosition('2026-12-31').cash_balance, before.cash_balance + 500000);
  // a cheque received after the date is not in that day's portfolio
  const chqBefore = fp.ours.find((l) => l.key === 'cheques_in').amount;
  T.createReceipt({ party_id: A, date: '2026-12-21', amount: '300', method: 'cheque', cheque: { number: '88', bank: 'بنك', due_date: '2027-01-10' } }, { userId: uid });
  assert.equal(financialPosition('2026-10-31').ours.find((l) => l.key === 'cheques_in').amount, chqBefore);
  assert.equal(financialPosition('2026-12-31').ours.find((l) => l.key === 'cheques_in').amount, chqBefore + 300000);
});

test('security finding: check-repo refuses a listed real amount in any form, passes an unlisted one', async () => {
  const { execFileSync, spawnSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const script = path.resolve('scripts/check-repo.js');
  // The real figures must never appear in the repo, not even in this test, so the test lists an
  // invented figure in the shop-PC file data/real-amounts.txt (never committed) and checks that.
  const run = (body) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safa-check-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    fs.mkdirSync(path.join(dir, 'data'));
    fs.writeFileSync(path.join(dir, 'data', 'real-amounts.txt'), '54321.09\n');
    fs.writeFileSync(path.join(dir, 'a.test.js'), body);
    execFileSync('git', ['add', 'a.test.js'], { cwd: dir });
    const r = spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' });
    fs.rmSync(dir, { recursive: true, force: true });
    return r.status;
  };
  // a listed figure as pounds, with a comma, as millimes and with Excel's long tail
  for (const form of ['54321.09', '54,321.09', '54321090', '54321.091718075']) assert.equal(run(`x(${form});\n`), 1, form);
  assert.equal(run('x(12345670);\n'), 0);
});
