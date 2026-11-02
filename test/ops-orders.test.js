// أوامر الشغل (optional), سجل الإنتاج and المطلوب النهارده: orders with serials and a status
// flow, lines linked to an order show its progress, an order of another client is red on the
// line, cancel with a reason, delete only when unused; production is approved lines with
// quantities only; the staff home counts what is waiting.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, client } from './helpers.js';
import { isMoneyKey } from '../src/money.js';

let app;
let admin;
let staff;
const ids = {};
const keys = (v, out = new Set()) => {
  if (Array.isArray(v)) v.forEach((x) => keys(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keys(x, out); }
  return out;
};

before(async () => {
  app = await startApp();
  admin = client(app.base);
  staff = client(app.base);
  await admin.post('/api/setup', { username: 'owner', display_name: 'المالك', password: 'secret1' });
  await admin.post('/api/users', { username: 'manager', display_name: 'المدير', password: 'secret2', role: 'staff' });
  await staff.post('/api/login', { username: 'manager', password: 'secret2' });
  ids.c1 = (await staff.post('/api/parties', { kind: 'client', name: 'مؤسسة الشروق التجريبية' })).data.party.id;
  ids.c2 = (await staff.post('/api/parties', { kind: 'client', name: 'ورشة الغروب التجريبية' })).data.party.id;
  ids.tech = (await staff.post('/api/technicians', { name: 'فني المقص التجريبي', machine: 'shear' })).data.technician.id;
});
after(() => app.stop());

test('create an order: serial أم-0001, validation in Arabic', async () => {
  let r = await staff.post('/api/operations/orders', { client_id: ids.c1, date: '2026-10-20', due_date: '2026-10-25', description: '40 باب كابينة' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.order.serial, 'أم-0001');
  assert.equal(r.data.order.status, 'open');
  assert.equal(r.data.order.status_name, 'مفتوح');
  ids.o1 = r.data.order.id;
  r = await staff.post('/api/operations/orders', { client_id: ids.c1, date: '2026-10-20', description: '' });
  assert.equal(r.status, 400);
  assert.equal(r.data.field, 'description');
  r = await staff.post('/api/operations/orders', { client_id: ids.c1, date: '2026-10-20', due_date: '2026-10-19', description: 'x' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /قبل/);
  assert.equal((await staff.post('/api/operations/orders', { client_id: 999, date: '2026-10-20', description: 'x' })).status, 400);
  assert.equal((await staff.post('/api/operations/orders', { client_id: ids.c1, date: '2026-04-31', description: 'x' })).status, 400);
});

test('lines link to an order (optional); another client\'s order is red; approval moves it to in_progress; progress shows', async () => {
  let r = await staff.post('/api/operations/sheets', {
    machine: 'shear', technician_id: ids.tech, sheet_date: '2026-10-21', submit: true,
    lines: [
      { client_id: ids.c1, work_order_id: ids.o1, material_text: '1م مجلفن', pieces: 40, per_piece: 4, total_written: 160 },
      { client_id: ids.c2, work_order_id: ids.o1, material_text: '1م مجلفن', pieces: 5, per_piece: 2, total_written: 10 },
      { client_id: ids.c2, material_text: '2م اسود', pieces: 8, per_piece: 1, total_written: 8 },
    ],
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  let s = r.data.sheet;
  assert.equal(s.lines[0].work_order_serial, 'أم-0001');
  assert.deepEqual(s.issues.filter((i) => i.level === 'red').map((i) => `${i.row_no}:${i.code}`), ['2:order_client']);
  const lines = s.lines.map((l) => ({ ...l }));
  lines[1].work_order_id = null;
  r = await staff.put(`/api/operations/sheets/${s.id}`, { lines });
  s = r.data.sheet;
  assert.equal(s.counts.red, 0);
  if (s.counts.unseen) await staff.post(`/api/operations/sheets/${s.id}/ack`, { keys: s.issues.map((i) => i.key) });
  r = await staff.post(`/api/operations/sheets/${s.id}/approve`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  ids.sheet = s.id;
  r = await staff.get(`/api/operations/orders/${ids.o1}`);
  assert.equal(r.data.order.status, 'in_progress');
  assert.equal(r.data.lines.length, 1);
  assert.equal(r.data.by_machine[0].pieces, 40);
  assert.equal(r.data.by_machine[0].ops, 160);
  assert.equal(r.data.by_machine[0].approved, 1);
  assert.deepEqual(r.data.next_statuses.sort(), ['cancelled', 'done', 'open']);
});

test('status flow: done, delivered; a jump that makes no sense is refused; cancel needs a reason', async () => {
  let r = await staff.patch(`/api/operations/orders/${ids.o1}`, { status: 'delivered' });
  assert.equal(r.status, 409);
  r = await staff.patch(`/api/operations/orders/${ids.o1}`, { status: 'done' });
  assert.equal(r.data.order.status, 'done');
  r = await staff.patch(`/api/operations/orders/${ids.o1}`, { status: 'delivered' });
  assert.equal(r.data.order.status_name, 'اتسلم');
  assert.equal((await staff.post(`/api/operations/orders/${ids.o1}/cancel`, { reason: 'x' })).status, 409, 'delivered cannot be cancelled');
  assert.equal((await staff.patch(`/api/operations/orders/${ids.o1}`, { client_id: ids.c2 })).status, 409, 'lines are linked: client fixed');
  r = await staff.post('/api/operations/orders', { client_id: ids.c2, date: '2026-10-22', description: 'رفوف' });
  const o2 = r.data.order.id;
  assert.equal((await staff.post(`/api/operations/orders/${o2}/cancel`, {})).status, 400);
  r = await staff.post(`/api/operations/orders/${o2}/cancel`, { reason: 'العميل لغى الطلب' });
  assert.equal(r.data.order.status, 'cancelled');
  assert.equal(r.data.order.cancel_reason, 'العميل لغى الطلب');
  assert.equal((await staff.patch(`/api/operations/orders/${o2}`, { description: 'x' })).status, 409);
});

test('delete only an unused order; lists filter by client and status', async () => {
  let r = await staff.post('/api/operations/orders', { client_id: ids.c2, date: '2026-10-22', description: 'اتكتب غلط' });
  assert.equal((await staff.del(`/api/operations/orders/${r.data.order.id}`)).status, 200);
  assert.equal((await staff.del(`/api/operations/orders/${ids.o1}`)).status, 409);
  r = await staff.get(`/api/operations/orders?client_id=${ids.c2}`);
  assert.ok(r.data.orders.every((o) => o.client_id === ids.c2));
  r = await staff.get('/api/operations/orders?status=cancelled');
  assert.equal(r.data.orders.length, 1);
  r = await staff.get('/api/operations/orders-open');
  assert.ok(r.data.orders.every((o) => ['open', 'in_progress'].includes(o.status)));
  assert.equal((await staff.get('/api/operations/orders?status=bad')).status, 400);
});

test('سجل الإنتاج: approved lines only, by date / machine / technician / client, quantities and no money', async () => {
  await staff.post('/api/operations/sheets', { machine: 'shear', sheet_date: '2026-10-21', submit: true, lines: [{ client_id: ids.c1, pieces: 999, per_piece: 1 }] });
  let r = await staff.get('/api/operations/production?from=2026-10-01&to=2026-10-31');
  assert.equal(r.status, 200);
  assert.equal(r.data.rows.length, 3, 'the sheet in review is not production yet');
  assert.equal(r.data.by_machine[0].machine, 'shear');
  assert.equal(r.data.by_machine[0].pieces, 53);
  assert.equal(r.data.by_machine[0].ops, 178);
  r = await staff.get(`/api/operations/production?from=2026-10-01&to=2026-10-31&client_id=${ids.c2}`);
  assert.equal(r.data.rows.length, 2);
  r = await staff.get(`/api/operations/production?from=2026-10-01&to=2026-10-31&technician_id=${ids.tech}&machine=shear`);
  assert.equal(r.data.rows.length, 3);
  r = await staff.get('/api/operations/production?from=2026-10-01&to=2026-10-31&machine=laser');
  assert.equal(r.data.rows.length, 0);
  assert.equal((await staff.get('/api/operations/production?from=2026-10-31&to=2026-10-01')).status, 400);
  const bad = [...keys(r.data)].filter(isMoneyKey);
  assert.deepEqual(bad, []);
});

test('المطلوب النهارده: sheets in review, photos, my drafts, open orders', async () => {
  await staff.post('/api/operations/sheets', { machine: 'press', sheet_date: '2026-10-23' });
  await staff.post('/api/operations/orders', { client_id: ids.c1, date: '2026-10-22', due_date: '2026-10-23', description: 'شاسيه' });
  const r = await staff.get('/api/operations/home');
  assert.equal(r.status, 200);
  assert.equal(r.data.review.count, 1);
  assert.equal(r.data.review.red, 0);
  assert.equal(r.data.drafts.length, 1);
  assert.equal(r.data.orders.count, 1);
  assert.equal(r.data.orders.due_soon.length, 1);
  assert.equal(r.data.photos.ai, false);
  assert.deepEqual([...keys(r.data)].filter(isMoneyKey), []);
});
