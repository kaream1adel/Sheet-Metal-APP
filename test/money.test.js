import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, client } from './helpers.js';
import { todayISO } from '../src/util.js';

let app;
let admin;
let staff;
const ids = {};
const daysAgo = (n) => todayISO(new Date(Date.now() - n * 86400000));

// Create and confirm a sheet as the manager would.
async function confirmedSheet(code, lines, sheet_date = daysAgo(12)) {
  const L = (await staff.get('/api/lookups')).data;
  const machine = L.machines.find((m) => m.code === code);
  let r = await staff.post('/api/sheets', { machine_id: machine.id, technician_id: ids.tech, sheet_date, lines });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const acks = r.data.sheet.issues.map((i) => i.key);
  r = await staff.post(`/api/sheets/${r.data.sheet.id}/confirm`, { acks });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.sheet;
}

before(async () => {
  app = await startApp();
  admin = client(app.base);
  staff = client(app.base);
  await admin.post('/api/setup', { username: 'kaream', password: 'secret1' });
  await admin.post('/api/users', { username: 'manager', password: 'pass123', role: 'staff' });
  await staff.post('/api/login', { username: 'manager', password: 'pass123' });
  ids.client = (await admin.post('/api/clients', { name: 'م/حمدي', opening_balance: '1000' })).data.client.id;
  ids.client2 = (await admin.post('/api/clients', { name: 'عمر' })).data.client.id;
  ids.tech = (await staff.post('/api/technicians', { name: 'حسين' })).data.technician.id;
  const L = (await staff.get('/api/lookups')).data;
  ids.galv = L.materials.find((m) => m.name === 'مجلفن').id;
  const press = await confirmedSheet('press', [
    { client_id: ids.client, material_id: ids.galv, thickness: 1, pieces: 3, ops_per_piece: 2, total_written: 6, part_name: 'ترى' },
    { client_id: ids.client, material_id: ids.galv, thickness: 1, pieces: 10, ops_per_piece: 4, total_written: 40, part_name: 'ترى' },
  ]);
  const punch = await confirmedSheet('punch', [
    { client_id: ids.client, material_id: ids.galv, thickness: 1, sheets: 37, pieces_per_sheet: 4, pieces: 148, hits_per_piece: 12, louvers_per_piece: 2, part_name: 'ترى' },
  ]);
  ids.pressLines = press.lines.map((l) => l.id);
  ids.pressSheet = press.id;
  ids.punchLine = punch.lines[0].id;
});
after(async () => { await app.stop(); });

test('staff can never reach money', async () => {
  for (const url of ['/api/pricing/clients', `/api/clients/${ids.client}/account`, `/api/clients/${ids.client}/statement`, '/api/payments', '/api/followup', '/api/reports/balances']) {
    assert.equal((await staff.get(url)).status, 403, url);
  }
  assert.equal((await staff.post('/api/payments', { client_id: ids.client, amount: 10 })).status, 403);
  const c = (await staff.get('/api/clients')).data.clients[0];
  assert.ok(!('balance' in c) && !('opening_balance' in c));
  const page = await fetch(`${app.base}/print/statement/${ids.client}`, { redirect: 'manual' });
  assert.equal(page.status, 302, 'not signed in → login');
});

test('pricing screen suggests units and has no prices the first time', async () => {
  const r = await admin.get(`/api/pricing/clients/${ids.client}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.lines.length, 3);
  const punch = r.data.lines.find((l) => l.id === ids.punchLine);
  assert.deepEqual(punch.charges.map((c) => c.unit), ['hit', 'louver'], 'punch line gets hits + louvers');
  assert.equal(punch.charges[0].qty, 148 * 12);
  assert.equal(punch.charges[1].qty, 148 * 2);
  assert.ok(punch.charges.every((c) => c.source === 'none'));
  assert.deepEqual(r.data.groups.map((g) => g.part_name), ['ترى'], 'same part on two machines → suggested group');
});

test('approve: line prices, a grouped item and a discount; no double billing', async () => {
  let r = await admin.post('/api/pricing/approve', {
    client_id: ids.client,
    charges: [
      { line_id: ids.pressLines[0], unit: 'bend', rate: '2.50' },                // 6 × 2.50 = 15.00
      { line_id: ids.punchLine, unit: 'hit', rate: '0.10' },                     // 1776 × 0.10 = 177.60
      { line_id: ids.punchLine, unit: 'louver', rate: '0.5' },                   // 296 × 0.50 = 148.00
    ],
    bundles: [{ description: 'ترى ١٠×١٠', unit: 'meter', qty: '10', rate: '30', line_ids: [ids.pressLines[1]] }], // 300.00
    discount: { amount: '0.60', reason: 'كسور' },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.total, 1500 + 17760 + 14800 + 30000 - 60);
  ids.batch = r.data.batch_id;
  assert.equal(r.data.balance, 100000 + 64000); // 640.60 of work − 0.60 discount

  r = await admin.post('/api/pricing/approve', { client_id: ids.client, charges: [{ line_id: ids.pressLines[0], unit: 'bend', rate: '3' }] });
  assert.equal(r.status, 409, 'already priced');
  r = await admin.get(`/api/pricing/clients/${ids.client}`);
  assert.equal(r.data.lines.length, 0);
});

test('price memory fills the next similar line', async () => {
  const sheet = await confirmedSheet('press', [{ client_id: ids.client, material_id: ids.galv, thickness: 1, pieces: 5, ops_per_piece: 2 }], daysAgo(2));
  let r = await admin.get(`/api/pricing/clients/${ids.client}`);
  const line = r.data.lines.find((l) => l.id === sheet.lines[0].id);
  assert.equal(line.charges[0].unit, 'bend');
  assert.equal(line.charges[0].rate, 250);
  assert.equal(line.charges[0].source, 'exact');
  // another client gets it as a hint, not exact
  const other = await confirmedSheet('press', [{ client_id: ids.client2, material_id: ids.galv, thickness: 1, pieces: 1, ops_per_piece: 1 }], daysAgo(2));
  r = await admin.get(`/api/pricing/clients/${ids.client2}`);
  const ol = r.data.lines.find((l) => l.id === other.lines[0].id);
  assert.equal(ol.charges[0].source, 'near');
});

test('cash counts now; a cheque only once cleared', async () => {
  const before = (await admin.get(`/api/clients/${ids.client}/account`)).data.balance;
  let r = await admin.post('/api/payments', { client_id: ids.client, amount: '500', method: 'نقدي' });
  assert.equal(r.status, 201);
  assert.equal(r.data.balance, before - 50000);
  r = await admin.post('/api/payments', { client_id: ids.client, amount: '300', method: 'شيك' });
  assert.equal(r.status, 400, 'cheque needs a due date');
  r = await admin.post('/api/payments', { client_id: ids.client, amount: '300', method: 'شيك', cheque_due: daysAgo(-3) });
  assert.equal(r.data.balance, before - 50000, 'pending cheque does not count');
  const cheque = r.data.payment.id;
  r = await admin.post(`/api/payments/${cheque}/cheque`, { status: 'cleared' });
  assert.equal(r.data.balance, before - 80000);
  r = await admin.post(`/api/payments/${cheque}/cheque`, { status: 'bounced' });
  assert.equal(r.data.balance, before - 50000, 'bounced cheque no longer counts');
});

test('statement running balance matches the account balance', async () => {
  const acc = (await admin.get(`/api/clients/${ids.client}/account`)).data;
  const st = (await admin.get(`/api/clients/${ids.client}/statement`)).data;
  assert.equal(st.closing, acc.balance);
  assert.equal(st.rows[0].kind, 'opening');
  assert.equal(st.pending_cheques.length, 0);
  const late = (await admin.get(`/api/clients/${ids.client}/statement?from=${todayISO()}`)).data;
  assert.equal(late.closing, acc.balance, 'earlier rows fold into the carried balance');
  const page = await (await fetch(`${app.base}/print/statement/${ids.client}`, { headers: { cookie: await cookieOf(admin) } })).text();
  assert.ok(page.includes('كشف حساب') && page.includes('م/حمدي'));
});

// helpers.js keeps the cookie private; log in again to get one for a raw fetch.
async function cookieOf() {
  const res = await fetch(`${app.base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'kaream', password: 'secret1' }) });
  return res.headers.get('set-cookie').split(';')[0];
}

test('a priced sheet cannot be cancelled until its pricing is cancelled', async () => {
  let r = await admin.post(`/api/sheets/${ids.pressSheet}/cancel`, { reason: 'test' });
  assert.equal(r.status, 409);
  const before = (await admin.get(`/api/clients/${ids.client}/account`)).data.balance;
  r = await admin.post(`/api/pricing/batches/${ids.batch}/cancel`, { reason: 'سعر غلط' });
  assert.equal(r.status, 200);
  assert.equal(r.data.balance, before - 64000);
  r = await admin.get(`/api/pricing/clients/${ids.client}`);
  assert.ok(r.data.lines.some((l) => l.id === ids.punchLine), 'lines are back in the queue');
});

test('delivery by the manager feeds follow-up', async () => {
  let r = await staff.get(`/api/deliveries/pending/${ids.client}`);
  assert.equal(r.status, 200);
  assert.ok(!JSON.stringify(r.data).match(/rate|amount|price/), 'no money in delivery data');
  r = await staff.post('/api/deliveries', { client_id: ids.client, line_ids: [ids.punchLine], delivery_date: daysAgo(10), receiver: 'أحمد' });
  assert.equal(r.status, 201);
  r = await staff.post('/api/deliveries', { client_id: ids.client, line_ids: [ids.punchLine] });
  assert.equal(r.status, 409, 'cannot deliver twice');

  // price the delivered line again, then follow-up with a 7-day alert
  await admin.post('/api/pricing/approve', { client_id: ids.client, charges: [{ line_id: ids.punchLine, unit: 'piece', rate: '1' }] });
  await admin.put('/api/settings', { alert_days: 7 });
  await admin.post('/api/promises', { client_id: ids.client, promised_date: todayISO(), amount: '100' });
  r = await admin.get('/api/followup');
  assert.equal(r.status, 200);
  // the opening balance was paid off by the cash payment, so the oldest open debt is the delivered line
  assert.ok(r.data.overdue.some((o) => o.client_id === ids.client && o.days === 10), JSON.stringify(r.data.overdue));
  assert.equal(r.data.promises.length, 1);
  assert.ok(r.data.undelivered.some((u) => u.client_id === ids.client));
  r = await admin.get('/api/reports/balances');
  assert.ok(r.data.outstanding > 0);
});
