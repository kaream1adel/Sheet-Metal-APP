// الإنتاج, technician profile, income, machines/materials, and the reader's "forget".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, client } from './helpers.js';

let app;
let admin;
let staff;
let L;
let tech;
let clientId;
const today = new Date().toISOString().slice(0, 10);

before(async () => {
  app = await startApp();
  admin = client(app.base);
  staff = client(app.base);
  await admin.post('/api/setup', { username: 'kaream', display_name: 'كريم', password: 'secret1' });
  await admin.post('/api/users', { username: 'manager', display_name: 'المدير', password: 'secret2', role: 'staff' });
  await staff.post('/api/login', { username: 'manager', password: 'secret2' });
  L = (await staff.get('/api/lookups')).data;
  tech = (await staff.post('/api/technicians', { name: 'حمدي' })).data.technician.id;
  clientId = (await staff.post('/api/clients', { name: 'عميل' })).data.client.id;
  const press = L.machines.find((m) => m.code === 'press').id;
  const laser = L.machines.find((m) => m.code === 'laser').id;
  const mat = L.materials[0].id;
  const sheet = async (machine_id, lines) => {
    const r = await staff.post('/api/sheets', { machine_id, technician_id: tech, sheet_date: today, lines });
    const c = await staff.post(`/api/sheets/${r.data.sheet.id}/confirm`, { acks: r.data.sheet.issues.map((i) => i.key) });
    assert.equal(c.status, 200, JSON.stringify(c.data));
    return r.data.sheet.id;
  };
  await sheet(press, [
    { client_id: clientId, material_id: mat, thickness: '2', pieces: '10', ops_per_piece: '3', total_written: '30' },
    { client_id: clientId, material_id: mat, thickness: '1.5', pieces: '4', ops_per_piece: '2', total_written: '8' },
    { client_id: clientId, material_id: mat, thickness: '2', pieces: '6', ops_per_piece: '1' },
  ]);
  await sheet(laser, [{ client_id: clientId, material_id: mat, thickness: '3', sheets: '2', minutes_per_sheet: '15' }]);
  // A sheet with a total the technician got wrong, fixed in review.
  const r = await staff.post('/api/sheets', { machine_id: press, technician_id: tech, sheet_date: today,
    lines: [{ client_id: clientId, material_id: mat, thickness: '2', pieces: '5', ops_per_piece: '2', total_written: '12' }] });
  await staff.put(`/api/sheets/${r.data.sheet.id}`, { technician_id: tech, sheet_date: today,
    lines: [{ client_id: clientId, material_id: mat, thickness: '2', pieces: '5', ops_per_piece: '2', total_written: '10' }] });
  const s = (await staff.get(`/api/sheets/${r.data.sheet.id}`)).data.sheet;
  await staff.post(`/api/sheets/${s.id}/confirm`, { acks: s.issues.map((i) => i.key) });
});
after(async () => { await app.stop(); });

test('الإنتاج: totals per technician and machine in each machine\'s units (staff, no money)', async () => {
  const r = await staff.get(`/api/production?from=${today}&to=${today}&group=day`);
  assert.equal(r.status, 200);
  const press = r.data.rows.find((x) => x.machine_code === 'press');
  assert.equal(press.lines, 4);
  assert.equal(press.pieces, 25);
  assert.equal(press.ops, 30 + 8 + 6 + 10);
  assert.equal(press.technician_name, 'حمدي');
  const laser = r.data.rows.find((x) => x.machine_code === 'laser');
  assert.equal(laser.minutes, 30);
  assert.ok(!JSON.stringify(r.data).match(/amount|rate|price/));
  const week = await staff.get('/api/production?group=week');
  assert.equal(week.data.rows.filter((x) => x.machine_code === 'press').length, 1);
});

test('technician profile: usual clients, normal ranges, mistakes found in review', async () => {
  const r = await staff.get(`/api/technicians/${tech}/profile`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const p = r.data;
  assert.equal(p.sheets, 3);
  assert.equal(p.clients[0].id, clientId);
  assert.equal(p.ranges.thickness.usual, 2);
  assert.ok(p.mistakes.some((m) => m.code === 'mismatch' && m.field === 'total_written'), JSON.stringify(p.mistakes));
});

test('income by month is the admin\'s', async () => {
  assert.equal((await staff.get('/api/reports/income')).status, 403);
  const r = await admin.get('/api/reports/income');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.data.rows));
  assert.equal(r.data.totals.received, 0);
});

test('materials and machine names can be edited; staff can not', async () => {
  assert.equal((await staff.get('/api/materials')).status, 403);
  let r = await admin.post('/api/materials', { name: 'نحاس', aliases: 'نحاس احمر, copper', density: '8.96' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const id = r.data.material.id;
  r = await admin.patch(`/api/materials/${id}`, { active: false });
  assert.equal(r.status, 200);
  assert.ok(!(await admin.get('/api/lookups')).data.materials.some((m) => m.id === id), 'inactive material leaves the lists');
  assert.equal((await admin.post('/api/materials', { name: 'نحاس' })).status, 409);
  const press = L.machines.find((m) => m.code === 'press');
  assert.equal((await admin.patch(`/api/machines/${press.id}`, { name: 'التناية الكبيرة' })).status, 200);
  assert.equal((await admin.get('/api/lookups')).data.machines.find((m) => m.id === press.id).name, 'التناية الكبيرة');
});
