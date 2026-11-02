// الأطراف over HTTP: create/edit with aliases and the similar-name check, balances for
// admins, and staff never receiving a money field (list, one, statement, lookups).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, client } from './helpers.js';
import { isMoneyKey } from '../src/money.js';
import { post as postTxn } from '../src/ledger.js';

let app;
let admin;
let staff;
let anon;

before(async () => {
  app = await startApp();
  admin = client(app.base);
  staff = client(app.base);
  anon = client(app.base);
  await admin.post('/api/setup', { username: 'owner', display_name: 'المالك', password: 'secret1' });
  const u = await admin.post('/api/users', { username: 'manager', display_name: 'المدير', password: 'secret2', role: 'staff' });
  assert.equal(u.status, 201);
  await staff.post('/api/login', { username: 'manager', password: 'secret2' });
});
after(() => app.stop());

// Every key anywhere in a response.
function keys(v, out = new Set()) {
  if (Array.isArray(v)) v.forEach((x) => keys(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keys(x, out); }
  return out;
}
const assertNoMoney = (data, what) => {
  const bad = [...keys(data)].filter(isMoneyKey);
  assert.deepEqual(bad, [], `${what} leaked money: ${bad.join(', ')}`);
};

test('signed-out users get 401; every module answers 404 on unknown paths', async () => {
  assert.equal((await anon.get('/api/parties')).status, 401);
  for (const m of ['operations', 'pricing', 'treasury', 'reports', 'import']) assert.equal((await admin.get(`/api/${m}/anything`)).status, 404, m);
});

test('create a client with aliases and an opening balance; list shows the balance in words', async () => {
  const r = await admin.post('/api/parties', { kind: 'client', name: 'ورشة السلام التجريبية', aliases: 'السلام، ورشه السلام', phone: '0100', opening_balance: '1,500.25' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.deepEqual(r.data.party.aliases, ['السلام', 'ورشه السلام']);
  assert.equal(r.data.party.balance, 1500250);
  assert.equal(r.data.party.balance_text, 'لنا عنده 1,500.25');
  const list = await admin.get('/api/parties?kind=client');
  const p = list.data.parties.find((x) => x.id === r.data.party.id);
  assert.equal(p.balance, 1500250);
  assert.equal(list.data.totals.owes_us >= 1500250, true);
  const s = await admin.get(`/api/parties/${p.id}/statement`);
  assert.equal(s.data.rows.length, 1);
  assert.equal(s.data.rows[0].debit, 1500250);
  assert.equal(s.data.closing_text, 'لنا عنده 1,500.25');
});

test('one name per kind: exact names and aliases are taken, similar names ask first', async () => {
  let r = await admin.post('/api/parties', { kind: 'client', name: 'ورشة السلام التجريبية' });
  assert.equal(r.status, 409);
  r = await admin.post('/api/parties', { kind: 'client', name: 'السلام' }); // an alias
  assert.equal(r.status, 409);
  assert.ok(r.data.existing);
  r = await admin.post('/api/parties', { kind: 'client', name: 'السلام التجريبيه' });
  assert.equal(r.status, 409);
  assert.ok(r.data.similar.length >= 1);
  r = await admin.post('/api/parties', { kind: 'client', name: 'السلام التجريبيه', force: true });
  assert.equal(r.status, 201);
  r = await admin.post('/api/parties', { kind: 'supplier', name: 'ورشة السلام التجريبية' }); // other kind: fine
  assert.equal(r.status, 201);
  const sim = await admin.get(`/api/parties/similar?kind=client&name=${encodeURIComponent('ورشه السلام')}`);
  assert.ok(sim.data.similar.length >= 1);
  assert.equal((await admin.post('/api/parties', { kind: 'x', name: 'y' })).status, 400);
  assert.equal((await admin.post('/api/parties', { kind: 'client', name: '  ' })).status, 400);
});

test('edit a party: rename, aliases, deactivate; audited', async () => {
  const { data: { party } } = await admin.post('/api/parties', { kind: 'worker', name: 'عامل تجريبي أول' });
  let r = await admin.patch(`/api/parties/${party.id}`, { name: 'عامل تجريبي', aliases: ['ابو عامل'], active: false });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.party.name, 'عامل تجريبي');
  assert.equal(r.data.party.active, false);
  const list = await admin.get('/api/parties?kind=worker');
  assert.ok(!list.data.parties.some((p) => p.id === party.id));
  const all = await admin.get('/api/parties?kind=worker&include_inactive=1');
  assert.ok(all.data.parties.some((p) => p.id === party.id));
  const audit = await admin.get(`/api/audit?entity=party&id=${party.id}`);
  assert.ok(audit.data.audit.some((a) => a.action === 'update'));
  r = await admin.get(`/api/parties?q=${encodeURIComponent('ابو')}&include_inactive=1`);
  assert.ok(r.data.parties.some((p) => p.id === party.id));
});

test('staff: can add clients, never receives money; can not add partners or post opening balances', async () => {
  let r = await staff.post('/api/parties', { kind: 'client', name: 'مصنع الفجر التجريبي', credit_limit: '5000' });
  assert.equal(r.status, 201);
  const id = r.data.party.id;
  assertNoMoney(r.data, 'create');
  // credit_limit was silently ignored
  const asAdmin = await admin.get(`/api/parties/${id}`);
  assert.equal(asAdmin.data.party.credit_limit, null);

  postTxn('pricing', '2026-10-01', 'بيان أعمال المقص', [
    { account: 'receivable', party_id: id, debit: 777000 }, { account: 'revenue:shear', credit: 777000 },
  ], { partyId: id });

  r = await staff.post('/api/parties', { kind: 'client', name: 'عميل برصيد', opening_balance: '10' });
  assert.equal(r.status, 403);
  r = await staff.post('/api/parties', { kind: 'partner', name: 'شريك جديد' });
  assert.equal(r.status, 403);

  for (const url of ['/api/parties', '/api/parties?kind=client', `/api/parties/${id}`, `/api/parties/${id}/statement`, '/api/lookups', '/api/general-prices']) {
    const x = await staff.get(url);
    assert.equal(x.status, 200, url);
    assertNoMoney(x.data, url);
  }
  const st = await staff.get(`/api/parties/${id}/statement`);
  assert.equal(st.data.rows.length, 1);
  assert.equal(st.data.rows[0].kind, 'pricing');
  // Free text can carry amounts («تغذية 50000»): staff get no description or reason.
  assert.ok(!('description' in st.data.rows[0]) && !('reason' in st.data.rows[0]));
  // The admin sees the same statement with money.
  const full = await admin.get(`/api/parties/${id}/statement`);
  assert.equal(full.data.rows[0].debit, 777000);
  assert.equal(full.data.closing_text, 'لنا عنده 777.00');
});

test('staff: partners do not exist for them; supplier and worker statements are money.view only', async () => {
  const pr = await admin.post('/api/parties', { kind: 'partner', name: 'شريك تجريبي للفحص', opening_balance: '-50000' });
  assert.equal(pr.status, 201);
  const sp = await admin.post('/api/parties', { kind: 'supplier', name: 'مورد تجريبي للفحص', opening_balance: '-1000' });
  assert.equal(sp.status, 201);
  assert.equal((await staff.get('/api/parties?kind=partner')).status, 403);
  const all = await staff.get('/api/parties');
  assert.equal(all.status, 200);
  assert.ok(all.data.parties.every((p) => p.kind !== 'partner'));
  assert.ok(!all.data.parties.some((p) => p.id === pr.data.party.id));
  assert.equal((await staff.get(`/api/parties/${pr.data.party.id}`)).status, 403);
  assert.equal((await staff.get(`/api/parties/${pr.data.party.id}/statement`)).status, 403);
  assert.equal((await staff.get('/api/parties/similar?kind=partner&name=شريك')).status, 403);
  // Suppliers: the list (for expense vouchers) yes, the statement no.
  assert.equal((await staff.get('/api/parties?kind=supplier')).status, 200);
  assert.equal((await staff.get(`/api/parties/${sp.data.party.id}/statement`)).status, 403);
  // The admin sees both.
  assert.equal((await admin.get(`/api/parties/${pr.data.party.id}/statement`)).data.rows[0].description, 'رصيد أول المدة');
  assert.ok((await admin.get('/api/parties?kind=partner')).data.parties.some((p) => p.id === pr.data.party.id));
});

test('statement date range and bad input', async () => {
  const { data: { party } } = await admin.post('/api/parties', { kind: 'client', name: 'عميل فترات', opening_balance: '100', opening_date: '2026-09-01' });
  postTxn('receipt', '2026-10-15', 'إيصال', [{ account: 'cash', debit: 40000 }, { account: 'receivable', party_id: party.id, credit: 40000 }], { partyId: party.id });
  const r = await admin.get(`/api/parties/${party.id}/statement?from=2026-10-01&to=2026-10-31`);
  assert.equal(r.data.opening, 100000);
  assert.equal(r.data.rows.length, 1);
  assert.equal(r.data.rows[0].credit, 40000);
  assert.equal(r.data.closing_text, 'لنا عنده 60.00');
  assert.equal((await admin.get(`/api/parties/${party.id}/statement?from=bad`)).status, 400);
  assert.equal((await admin.get('/api/parties/99999/statement')).status, 404);
});

test('lookups: technicians, materials and expense categories', async () => {
  let r = await staff.post('/api/technicians', { name: 'فني تجريبي', machine: 'press' });
  assert.equal(r.status, 201);
  assert.equal((await staff.post('/api/materials', { name: 'نحاس' })).status, 403);
  r = await admin.post('/api/materials', { name: 'نحاس', density: '٨٫٩٦', grp: 'أخرى', aliases: 'نحاس احمر' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.material.density, 8.96);
  assert.equal((await admin.post('/api/materials', { name: 'رصاص', density: '-1' })).status, 400);
  r = await admin.post('/api/expense-categories', { name: 'إنترنت', keywords: 'نت، راوتر' });
  assert.equal(r.status, 201);
  const lk = await admin.get('/api/lookups');
  assert.ok(lk.data.technicians.some((t) => t.name === 'فني تجريبي'));
  assert.ok(lk.data.materials.some((m) => m.name === 'نحاس'));
  assert.ok(lk.data.expense_categories.some((c) => c.name === 'إنترنت'));
  assert.equal(lk.data.machines.length, 4);
  assert.equal(lk.data.sections.length, 6);
  assert.equal(lk.data.general_prices.find((g) => g.section === 'laser').min_charge, 150000);
});

test('users: staff can not manage users; admin can grant an extra permission', async () => {
  assert.equal((await staff.get('/api/users')).status, 403);
  const list = await admin.get('/api/users');
  const mgr = list.data.users.find((u) => u.username === 'manager');
  assert.ok(!mgr.permissions.includes('money.view'));
  assert.ok(mgr.permissions.includes('operations.approve'));
  const r = await admin.patch(`/api/users/${mgr.id}`, { extra_permissions: ['reports', 'bogus'] });
  assert.equal(r.status, 200);
  assert.ok(r.data.user.permissions.includes('reports'));
  assert.ok(!r.data.user.permissions.includes('bogus'));
  // reports without money.view: the raw audit log (totals, credit limits) stays closed.
  assert.equal((await staff.get('/api/audit')).status, 403);
  assert.equal((await admin.get('/api/audit')).status, 200);
  const me = list.data.users.find((u) => u.username === 'owner');
  assert.equal((await admin.patch(`/api/users/${me.id}`, { role: 'staff' })).status, 400); // last admin
});
