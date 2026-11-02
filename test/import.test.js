// الاستيراد من الإكسيل over HTTP on a synthetic workbook (invented names): the preview writes
// nothing, the import posts exactly like the app (txn kinds, doc types, statement rows, cheque
// statuses, price items, import sheets, aliases), everything reconciles with the workbook,
// a second import is refused, a failure leaves nothing behind, the rollback reverses all of it
// (audited), the admin's decisions change the result, staff never gets in, and the CLI works.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { startApp, client } from './helpers.js';
import { workbookBuffer, EXPECT } from './import-fixture.js';

let app;
let admin;
let staff;
let db;
let L;
let P;
let buf;
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.data).slice(0, 600)); return r.data; };
const M = (pounds) => Math.round(pounds * 1000);
const count = (sql, ...a) => db().prepare(sql).get(...a).n;
const upload = async () => ok(await admin.post('/api/import/upload', { file_name: 'حسابات تجريبية.xlsx', data: `data:application/octet-stream;base64,${buf.toString('base64')}` }), 201).run;
const party = (kind, name) => db().prepare('SELECT * FROM parties WHERE kind = ? AND name = ?').get(kind, name);

before(async () => {
  app = await startApp();
  ({ getDb: db } = await import('../src/db.js'));
  L = await import('../src/ledger.js');
  P = await import('../src/pricing/service.js');
  admin = client(app.base);
  staff = client(app.base);
  await admin.post('/api/setup', { username: 'owner', display_name: 'المالك التجريبي', password: 'secret1' });
  ok(await admin.post('/api/users', { username: 'manager', display_name: 'مدير تجريبي', password: 'secret2', role: 'staff' }), 201);
  ok(await staff.post('/api/login', { username: 'manager', password: 'secret2' }));
  buf = await workbookBuffer();
});
after(() => app.stop());

test('staff cannot reach the import; a file that is not a workbook is refused', async () => {
  assert.equal((await staff.get('/api/import')).status, 403);
  assert.equal((await staff.post('/api/import/upload', { data: buf.toString('base64') })).status, 403);
  const r = await admin.post('/api/import/upload', { file_name: 'x.xlsx', data: Buffer.from('not excel').toString('base64') });
  assert.equal(r.status, 400);
  assert.equal(r.data.field, 'file');
});

let runId;
test('preview: simulated import reconciles to the piastre, and nothing is written', async () => {
  const before = count('SELECT COUNT(*) n FROM txns');
  const run = await upload();
  runId = run.id;
  assert.equal(run.status, 'preview');
  assert.equal(run.error, null);
  assert.equal(run.reconciliation.ok, true, JSON.stringify(run.reconciliation.rows.filter((r) => !r.ok)));
  assert.ok(run.simulated.batches > 0 && run.simulated.receipts === 7, JSON.stringify(run.simulated));
  assert.equal(count('SELECT COUNT(*) n FROM txns'), before);
  assert.equal(count('SELECT COUNT(*) n FROM parties'), 0);
  assert.equal(count('SELECT COUNT(*) n FROM sequences WHERE next > 1'), 0);
  // what the admin is asked about
  const p = run.preview;
  assert.ok(p.names.some((n) => n.spellings.includes('م/ النجمة')));
  assert.ok(p.dates.some((d) => d.kind === 'swapped'));
  assert.ok(p.partners.length === 5 && p.partners.every((x) => x.options.length));
  assert.equal(p.duplicates.length, 1);
  assert.ok(p.formula.some((f) => f.excel_amount === 500000));
  // the store figure is shown with its explanation, and the cash box warning
  const store = run.reconciliation.rows.find((r) => r.group === 'store');
  assert.equal(store.excel_amount, M(EXPECT.store));
  assert.equal(store.app_amount - store.excel_amount, M(6000 - 150));
  assert.equal(store.explained_ok, true);
  assert.ok(run.reconciliation.warnings.some((w) => /بالسالب/.test(w)));
});

test('decisions: skipping the duplicate shows in the reconciliation; a bad date is refused', async () => {
  let r = ok(await admin.put(`/api/import/runs/${runId}/decisions`, { decisions: { skip: { 'المصروفات اليومية!C6': true } } })).run;
  const line = r.reconciliation.rows.find((x) => x.label === 'إجمالي المصروفات اليومية');
  assert.equal(line.ok, false);
  assert.equal(line.diff_amount, -120000);
  assert.equal((await admin.put(`/api/import/runs/${runId}/decisions`, { decisions: { dates: { 'x!A1': '2025-02-31x' } } })).status, 400);
  r = ok(await admin.put(`/api/import/runs/${runId}/decisions`, { decisions: { dates: { 'المصروفات اليومية!A4': '2025-10-01' } } })).run;
  assert.equal(r.reconciliation.ok, true);
  assert.deepEqual(r.decisions.dates, { 'المصروفات اليومية!A4': '2025-10-01' });
});

test('a failure inside the import leaves nothing behind (one transaction): a locked month', async () => {
  ok(await admin.post('/api/month-locks', { month: '2025-10' }), 201);
  const before = count('SELECT COUNT(*) n FROM txns');
  const r = await admin.post(`/api/import/runs/${runId}/apply`, {});
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.equal(count('SELECT COUNT(*) n FROM txns'), before);
  assert.equal(count('SELECT COUNT(*) n FROM parties'), 0);
  assert.equal(count('SELECT COUNT(*) n FROM op_sheets'), 0);
  assert.equal(ok(await admin.get(`/api/import/runs/${runId}`)).run.status, 'preview');
  L.unlockMonth('2025-10', null, 'تجربة الاستيراد');
});

test('apply: posts like the app does and reconciles with every figure of the workbook', async () => {
  const run = ok(await admin.post(`/api/import/runs/${runId}/apply`, {})).run;
  assert.equal(run.status, 'applied');
  assert.equal(run.reconciliation.ok, true, JSON.stringify(run.reconciliation.rows.filter((r) => !r.ok)));
  // parties, aliases, walk-in
  const star = party('client', 'مصنع النجمة');
  assert.deepEqual(JSON.parse(star.aliases).sort(), ['النجمة', 'م/ النجمة'].sort());
  assert.equal(party('client', 'عميل خارجي').is_walk_in, 1);
  assert.ok(party('partner', 'شريك تجريبي') && party('supplier', 'مورد الحديد التجريبي'));
  // client balances = the summary
  for (const [name, x] of Object.entries(EXPECT.clients)) {
    assert.equal(L.partyBalance(party('client', name).id), M(x.debit) - M(x.discount) - M(x.credit), name);
  }
  const nasim = party('client', 'ورشة النسيم');
  const st = L.statement(nasim.id);
  const kinds = new Set(st.rows.map((r) => r.kind));
  for (const k of ['import_work', 'manual_debit', 'manual_discount', 'receipt', 'cheque_collect']) assert.ok(kinds.has(k), k);
  assert.equal(st.totals.discount, M(6.8));
  const work = st.rows.filter((r) => r.kind === 'import_work');
  assert.ok(work.every((r) => r.doc_type === 'pricing_batch' && /^بيان أعمال/.test(r.description)));
  // the batch opens like any other (pricing's بيان أعمال)
  const b = P.batchView(work[0].doc_id);
  assert.ok(b.items.length > 0 && b.items.every((i) => i.status === 'posted' && i.rate_source === 'import'));
  // import sheets: approved, never in the pricing queue; settled rows are history without money
  assert.equal(count("SELECT COUNT(*) n FROM op_sheets WHERE source <> 'import' OR status <> 'approved'"), 0);
  assert.equal(P.pricingQueue().groups.length, 0);
  assert.ok(count("SELECT COUNT(*) n FROM price_items WHERE status = 'settled_in_excel' AND amount IS NULL") >= 3);
  assert.ok(count("SELECT COUNT(*) n FROM op_lines WHERE status = 'settled_in_excel'") >= 3);
  const lump = db().prepare("SELECT * FROM price_items WHERE billing = 'lump'").get();
  assert.equal(lump.amount, 500000);
  assert.equal(lump.rate, 500000);
  // every posted item is qty × rate, rounded once (or a lump)
  const { mulRound } = await import('../src/money.js');
  for (const i of db().prepare("SELECT * FROM price_items WHERE status = 'posted' AND billing NOT IN ('lump','minute')").all()) assert.equal(i.amount, mulRound(i.qty, i.rate), `item ${i.id}`);
  // the client's شيت التسعير = E1; its history feeds the suggested rate
  assert.equal(P.clientPricingSheet(nasim.id).total, M(EXPECT.e1['ورشة النسيم']));
  assert.deepEqual(P.suggestRate({ client_id: nasim.id, section: 'shear' }), { rate: 500, source: 'last_section' });
  assert.equal(count("SELECT COUNT(*) n FROM client_rates WHERE source = 'import'") > 0, true);
  // cheques: the client's collected, ours issued and cleared once (the partner's is not doubled)
  assert.deepEqual(db().prepare("SELECT direction, status, COUNT(*) n, SUM(amount) s FROM cheques GROUP BY 1, 2 ORDER BY 1").all(),
    [{ direction: 'in', status: 'collected', n: 1, s: M(300) }, { direction: 'out', status: 'cleared', n: 3, s: M(2000 + 400 + 700) }]);
  // partner account
  const partner = party('partner', 'شريك تجريبي');
  assert.equal(L.partyBalance(partner.id), -M(EXPECT.partner.credit - EXPECT.partner.debit));
  // cost centre on the welding expense
  assert.equal(count('SELECT COUNT(*) n FROM voucher_lines WHERE cost_party_id = ?', nasim.id), 1);
  // every transaction balanced
  assert.equal(count('SELECT COUNT(*) n FROM (SELECT txn_id FROM postings GROUP BY txn_id HAVING SUM(debit) <> SUM(credit))'), 0);
  // one audit row for the run, not one per document
  assert.equal(count("SELECT COUNT(*) n FROM audit_log WHERE entity = 'import_run' AND action = 'apply'"), 1);
  assert.equal(count("SELECT COUNT(*) n FROM audit_log WHERE action = 'post' AND entity = 'txn'"), 0);
});

test('idempotent: a second apply is refused, and so is another file while this one is applied', async () => {
  assert.equal((await admin.post(`/api/import/runs/${runId}/apply`, {})).status, 409);
  const other = await upload();
  const r = await admin.post(`/api/import/runs/${other.id}/apply`, {});
  assert.equal(r.status, 409);
  assert.match(r.data.error, /لازم تلغيه الأول/);
  const list = ok(await admin.get('/api/import'));
  assert.equal(list.applied_id, runId);
});

test('rollback: every posting reversed (audited), documents cancelled, parties closed; then a fresh import works', async () => {
  assert.equal((await admin.post(`/api/import/runs/${runId}/rollback`, {})).status, 400);
  const run = ok(await admin.post(`/api/import/runs/${runId}/rollback`, { reason: 'تجربة' })).run;
  assert.equal(run.status, 'rolled_back');
  assert.equal(count("SELECT COUNT(*) n FROM txns WHERE import_run_id = ? AND status = 'posted' AND reversal_of IS NULL", runId), 0);
  for (const a of ['receivable', 'partner', 'cash', 'bank', 'payable']) assert.equal(L.balance(a), 0, a);
  assert.equal(count("SELECT COUNT(*) n FROM receipts WHERE status <> 'cancelled'"), 0);
  assert.equal(count("SELECT COUNT(*) n FROM vouchers WHERE status <> 'cancelled'"), 0);
  assert.equal(count("SELECT COUNT(*) n FROM cheques WHERE status <> 'cancelled'"), 0);
  assert.equal(count("SELECT COUNT(*) n FROM price_items WHERE status <> 'cancelled'"), 0);
  assert.equal(count("SELECT COUNT(*) n FROM op_sheets WHERE status <> 'cancelled'"), 0);
  assert.equal(count('SELECT COUNT(*) n FROM client_rates'), 0);
  assert.equal(count("SELECT COUNT(*) n FROM parties WHERE active = 1"), 0);
  assert.equal(count("SELECT COUNT(*) n FROM audit_log WHERE entity = 'import_run' AND action = 'rollback'"), 1);
  assert.equal(run.reconciliation.ok, false); // the app no longer holds the workbook
  assert.equal((await admin.post(`/api/import/runs/${runId}/rollback`, { reason: 'تاني' })).status, 409);
  // a new file can be imported now, and it reconciles again
  const fresh = await upload();
  const done = ok(await admin.post(`/api/import/runs/${fresh.id}/apply`, {})).run;
  assert.equal(done.reconciliation.ok, true);
  assert.equal(count("SELECT COUNT(*) n FROM parties WHERE active = 1 AND kind = 'client'"), 4);
});

test('CLI: import-excel <file> previews and reconciles; --apply imports (its own data folder)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sheetmetal-cli-'));
  try {
    const file = path.join(dir, 'book.xlsx');
    fs.writeFileSync(file, buf);
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const run = (...args) => spawnSync(process.execPath, [path.join(root, 'src', 'cli.js'), 'import-excel', file, '--json', ...args],
      { env: { ...process.env, SHEETMETAL_DATA: path.join(dir, 'data') }, encoding: 'utf8', timeout: 120000 });
    const pre = run();
    assert.equal(pre.status, 0, pre.stderr);
    const a = JSON.parse(pre.stdout.trim().split('\n').pop());
    assert.equal(a.status, 'preview');
    assert.equal(a.reconciliation.ok, true);
    const ap = run('--apply');
    assert.equal(ap.status, 0, ap.stderr);
    const b = JSON.parse(ap.stdout.trim().split('\n').pop());
    assert.equal(b.status, 'applied');
    assert.equal(b.reconciliation.ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
