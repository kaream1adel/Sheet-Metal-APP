import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, client } from './helpers.js';
import { toPiastres } from '../src/money.js';
import { parseNumber } from '../src/util.js';
import { validateSheet } from '../src/sheets.js';

let app;
let admin;
let staff;
const ids = {};

before(async () => {
  app = await startApp();
  admin = client(app.base);
  staff = client(app.base);
});
after(async () => { await app.stop(); });

test('number and money parsing', () => {
  assert.equal(parseNumber('١٫٥م'), 1.5);
  assert.equal(parseNumber('2,5'), 2.5);
  assert.equal(parseNumber('٣٧'), 37);
  assert.equal(parseNumber(''), null);
  assert.ok(Number.isNaN(parseNumber('abc')));
  assert.equal(toPiastres('1,234.50'), 123450);
  assert.equal(toPiastres('٤٩٫٧٥'), 4975);
  assert.equal(toPiastres('-10'), -1000);
  assert.ok(Number.isNaN(toPiastres('1.234')));
});

test('first run creates exactly one admin', async () => {
  let r = await admin.get('/api/session');
  assert.equal(r.data.needsSetup, true);
  r = await admin.post('/api/setup', { username: 'kaream', display_name: 'كريم', password: 'secret1' });
  assert.equal(r.status, 201);
  assert.equal(r.data.user.role, 'admin');
  r = await client(app.base).post('/api/setup', { username: 'x', password: 'secret1' });
  assert.equal(r.status, 409);
});

test('state-changing requests must be JSON', async () => {
  const r = await admin.post('/api/clients', 'name=x', { raw: true });
  assert.equal(r.status, 415);
});

test('admin creates the manager; wrong passwords lock the account', async () => {
  let r = await admin.post('/api/users', { username: 'manager', display_name: 'المدير', password: 'pass123', role: 'staff' });
  assert.equal(r.status, 201);
  const intruder = client(app.base);
  for (let i = 0; i < 5; i++) {
    r = await intruder.post('/api/login', { username: 'manager', password: 'wrong' });
    assert.equal(r.status, 401);
  }
  r = await intruder.post('/api/login', { username: 'manager', password: 'pass123' });
  assert.equal(r.status, 423, 'locked even with the right password');
  // admin resets the password, which also clears the lock
  r = await admin.patch(`/api/users/${(await admin.get('/api/users')).data.users.find((u) => u.username === 'manager').id}`, { password: 'pass456' });
  assert.equal(r.status, 200);
  r = await staff.post('/api/login', { username: 'manager', password: 'pass456' });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.role, 'staff');
  assert.ok(!r.data.user.permissions.includes('money.view'));
});

test('staff never receives money and cannot set it', async () => {
  let r = await admin.post('/api/clients', { name: 'أحمد الهادي', opening_balance: '1,500.25' });
  assert.equal(r.status, 201);
  assert.equal(r.data.client.opening_balance, 150025);
  ids.client = r.data.client.id;

  r = await staff.get('/api/clients');
  assert.equal(r.status, 200);
  const c = r.data.clients.find((x) => x.id === ids.client);
  assert.ok(!('opening_balance' in c) && !('balance' in c), 'money fields stripped on the server');

  r = await staff.patch(`/api/clients/${ids.client}`, { phone: '0100', opening_balance: '0' });
  assert.equal(r.status, 200);
  r = await admin.get(`/api/clients/${ids.client}`);
  assert.equal(r.data.client.opening_balance, 150025, 'staff edit ignored the money field');
  assert.equal(r.data.client.phone, '0100');

  r = await staff.get('/api/users');
  assert.equal(r.status, 403);
});

test('staff enters a press sheet; red and yellow rules gate the confirm', async () => {
  const lookups = (await staff.get('/api/lookups')).data;
  const press = lookups.machines.find((m) => m.code === 'press');
  const black = lookups.materials.find((m) => m.name === 'أسود');
  let r = await staff.post('/api/technicians', { name: 'حمدي', digit_system: 'arabic' });
  ids.tech = r.data.technician.id;

  r = await staff.post('/api/sheets', {
    machine_id: press.id, technician_id: ids.tech, sheet_date: '2026-10-24', sheet_no: '0147',
    lines: [
      { client_id: ids.client, material_id: black.id, thickness: '١م', pieces: '٣', ops_per_piece: '٢', total_written: '٦' },
      { client_id: ids.client, material_id: black.id, thickness: '1', pieces: '3', ops_per_piece: '3', total_written: '8' },
      { client_text: 'عبدالحليم', pieces: '5', ops_per_piece: '6', total_written: '30' },
      {},
    ],
  });
  assert.equal(r.status, 201);
  const s = r.data.sheet;
  ids.sheet = s.id;
  assert.equal(s.lines.length, 3, 'empty row dropped');
  assert.equal(s.lines[0].thickness, 1);
  const keys = s.issues.map((i) => `${i.level}:${i.key}`);
  assert.ok(keys.includes('red:2:total_written:mismatch'), '3 × 3 ≠ 8');
  assert.ok(keys.includes('red:3:client_id:missing'), 'client written but not chosen');
  assert.ok(keys.includes('yellow:3:material_id:missing'));
  assert.ok(keys.includes('yellow:3:thickness:missing'));

  r = await staff.post('/api/sheets', { machine_id: press.id, sheet_no: '0147', lines: [{ client_id: ids.client, pieces: 1, ops_per_piece: 1 }] });
  assert.equal(r.status, 409, 'same printed sheet twice');

  r = await staff.post(`/api/sheets/${ids.sheet}/confirm`, {});
  assert.equal(r.status, 409, 'reds block confirm');

  const lines = s.lines.map((l) => ({ ...l }));
  lines[1].total_written = 9;
  lines[2].client_id = ids.client;
  r = await staff.put(`/api/sheets/${ids.sheet}`, { technician_id: ids.tech, sheet_date: '2026-10-24', lines });
  assert.equal(r.status, 200);
  const yellow = r.data.sheet.issues.filter((i) => i.level === 'yellow').map((i) => i.key);
  assert.equal(r.data.sheet.counts.red, 0);
  assert.equal(yellow.length, 2);

  r = await staff.post(`/api/sheets/${ids.sheet}/confirm`, { acks: [yellow[0]] });
  assert.equal(r.status, 409, 'one yellow not visited');
  assert.deepEqual(r.data.unseen, [yellow[1]]);

  r = await staff.post(`/api/sheets/${ids.sheet}/confirm`, { acks: yellow });
  assert.equal(r.status, 200);
  assert.equal(r.data.sheet.status, 'confirmed');
});

test('a confirmed sheet is locked; only admin can cancel it, with a reason', async () => {
  let r = await staff.put(`/api/sheets/${ids.sheet}`, { lines: [] });
  assert.equal(r.status, 409);
  r = await staff.del(`/api/sheets/${ids.sheet}`);
  assert.equal(r.status, 409, 'confirmed sheets are never deleted');
  r = await staff.post(`/api/sheets/${ids.sheet}/cancel`, { reason: 'غلط' });
  assert.equal(r.status, 403);
  r = await admin.post(`/api/sheets/${ids.sheet}/cancel`, {});
  assert.equal(r.status, 400, 'reason required');
  r = await admin.post(`/api/sheets/${ids.sheet}/cancel`, { reason: 'اتسجلت مرتين' });
  assert.equal(r.status, 200);
  assert.equal(r.data.sheet.status, 'cancelled');
  r = await admin.get(`/api/audit?entity=sheet&id=${ids.sheet}`);
  assert.deepEqual(r.data.audit.map((a) => a.action).sort(), ['cancel', 'confirm', 'create', 'update']);
});

test('machine columns and punch cross-check', () => {
  const issues = validateSheet({ technician_id: 1, sheet_date: '2026-10-12' }, [
    { row_no: 1, client_id: 1, material_id: 1, thickness: 1, sheets: 37, pieces_per_sheet: 4, pieces: 148, hits_per_piece: 12, louvers_per_piece: null, minutes: null, work_date: null },
    { row_no: 2, client_id: 1, material_id: 1, thickness: 1, sheets: 20, pieces_per_sheet: 4, pieces: 70, work_date: null },
    { row_no: 3, client_id: 1, material_id: 1, thickness: 1, sheets: 1, pieces: 8, ops_per_piece: 2, work_date: null },
  ].map((l) => ({ ops_per_piece: null, total_written: null, minutes_per_sheet: null, hits_per_piece: null, louvers_per_piece: null, minutes: null, pieces_per_sheet: null, ...l })), 'punch', '2026-10-26');
  const keys = issues.map((i) => i.key);
  assert.ok(!keys.some((k) => k.startsWith('1:')), 'row 1 is clean: 37 × 4 = 148');
  assert.ok(keys.includes('2:pieces:mismatch'), '20 × 4 ≠ 70');
  assert.ok(keys.includes('3:ops_per_piece:foreign'), 'bends are not a punch column');
});
