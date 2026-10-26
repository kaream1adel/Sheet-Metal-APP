// الحسابات: expenses, monthly sales / expenses / profit / cash, and one name per client.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, client } from './helpers.js';

let app;
let admin;
let staff;
const today = new Date().toISOString().slice(0, 10);

before(async () => {
  app = await startApp();
  admin = client(app.base);
  staff = client(app.base);
  await admin.post('/api/setup', { username: 'kaream', display_name: 'كريم', password: 'secret1' });
  await admin.post('/api/users', { username: 'manager', display_name: 'المدير', password: 'secret2', role: 'staff' });
  await staff.post('/api/login', { username: 'manager', password: 'secret2' });
});
after(async () => { await app.stop(); });

test('expenses: recorded in piastres, cancelled with a reason, never by staff', async () => {
  const { data } = await admin.get('/api/expenses');
  assert.ok(data.categories.length >= 8);
  const cat = data.categories.find((c) => c.name === 'كهربا ومياه').id;
  assert.equal((await staff.post('/api/expenses', { amount: '100', category_id: cat })).status, 403);
  assert.equal((await staff.get('/api/accounts/summary')).status, 403);
  let r = await admin.post('/api/expenses', { amount: '١٢٥٠٫٥٠', category_id: cat, payee: 'الكهربا' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.expense.amount, 125050);
  assert.equal((await admin.post('/api/expenses', { amount: '0', category_id: cat })).status, 400);
  const second = (await admin.post('/api/expenses', { amount: '50', category_id: cat })).data.expense.id;
  assert.equal((await admin.post(`/api/expenses/${second}/cancel`, {})).status, 400, 'needs a reason');
  assert.equal((await admin.post(`/api/expenses/${second}/cancel`, { reason: 'اتسجل مرتين' })).status, 200);
  r = await admin.get('/api/expenses');
  assert.equal(r.data.expenses.length, 2, 'cancelled stays visible');
  assert.equal((await admin.post('/api/expense-categories', { name: 'كهربا ومياه' })).status, 409);
});

test('summary: sales from priced work, profit = sales − expenses, cash = collected − expenses', async () => {
  const c = (await admin.post('/api/clients', { name: 'شركة النجمة' })).data.client.id;
  const L = (await staff.get('/api/lookups')).data;
  const press = L.machines.find((m) => m.code === 'press').id;
  const s = (await staff.post('/api/sheets', { machine_id: press, sheet_date: today, technician_id: null,
    lines: [{ client_id: c, material_id: L.materials[0].id, thickness: '2', pieces: '10', ops_per_piece: '3', total_written: '30' }] })).data.sheet;
  assert.equal((await staff.post(`/api/sheets/${s.id}/confirm`, { acks: s.issues.map((i) => i.key) })).status, 200);
  const line = (await admin.get(`/api/pricing/clients/${c}`)).data.lines[0];
  let r = await admin.post('/api/pricing/approve', { client_id: c, charges: [{ line_id: line.id, unit: 'bend', rate: '2.00' }] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  r = await admin.post('/api/payments', { client_id: c, amount: '40', method: 'نقدي', pay_date: today });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const sum = (await admin.get('/api/accounts/summary')).data;
  const m = sum.this_month;
  assert.equal(m.sales, 6000);        // 30 bends × 2.00
  assert.equal(m.expenses, 125050);
  assert.equal(m.profit, 6000 - 125050);
  assert.equal(m.collected, 4000);
  assert.equal(m.cash, 4000 - 125050);
  assert.equal(sum.by_category[0].name, 'كهربا ومياه');
  const home = (await admin.get('/api/home')).data;
  assert.equal(home.month.sales, 6000);
  assert.equal((await staff.get('/api/home')).data.month, undefined, 'no money for staff');
});

test('one client, one name: a similar name asks first', async () => {
  let r = await staff.post('/api/clients', { name: 'المصرية للتكييف' });
  assert.equal(r.status, 201);
  r = await staff.post('/api/clients', { name: 'مصريه للتكييف' });
  assert.equal(r.status, 409);
  assert.equal(r.data.similar[0].name, 'المصرية للتكييف');
  r = await staff.post('/api/clients', { name: 'مصريه للتكييف', force: true });
  assert.equal(r.status, 201, 'added when the person says it is another client');
  assert.equal((await staff.post('/api/clients', { name: 'النور' })).status, 201, 'different names pass');
});
