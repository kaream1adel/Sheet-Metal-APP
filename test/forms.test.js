// Printed forms (numbers, print page, missing sheets) and photo upload / review rows.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, client } from './helpers.js';

let app;
let admin;
let staff;
let press;
let clientId;
const ids = {};

// Not a real picture, but shaped like a JPEG; the server only stores it.
const jpeg = (fill = 7) => `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3000, fill)]).toString('base64')}`;
const quality = { sharpness: 900, brightness: 230, coverage: 0.5 };

before(async () => {
  app = await startApp();
  admin = client(app.base);
  staff = client(app.base);
  await admin.post('/api/setup', { username: 'kaream', display_name: 'كريم', password: 'secret1' });
  await admin.post('/api/users', { username: 'manager', display_name: 'المدير', password: 'secret2', role: 'staff' });
  await staff.post('/api/login', { username: 'manager', password: 'secret2' });
  press = (await staff.get('/api/lookups')).data.machines.find((m) => m.code === 'press');
  clientId = (await staff.post('/api/clients', { name: 'عميل تجربة' })).data.client.id;
});
after(async () => { await app.stop(); });

test('printing reserves the next numbers; the print page draws exactly those', async () => {
  let r = await staff.post('/api/forms/print', { machine_id: press.id, count: 5 });
  assert.equal(r.status, 201);
  assert.deepEqual([r.data.from, r.data.to], [1, 5]);
  r = await staff.post('/api/forms/print', { machine_id: press.id, count: '٢' });
  assert.deepEqual([r.data.from, r.data.to], [6, 7]);
  assert.equal((await staff.post('/api/forms/print', { machine_id: press.id, count: 500 })).status, 400);

  const page = await fetch(`${app.base}${r.data.url}`, { headers: { cookie: staff.cookie } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.equal(html.match(/class="page"/g).length, 2);
  assert.match(html, /رقم 6/);
  assert.match(html, /ورقة التناية/);
  const notReserved = await fetch(`${app.base}/print/forms?machine=press&from=8&to=9`, { headers: { cookie: staff.cookie } });
  assert.equal(notReserved.status, 404);

  const list = await staff.get('/api/forms');
  assert.equal(list.data.machines.find((m) => m.code === 'press').last_printed, 7);
});

test('a photo becomes a sheet in review; the same paper can not come in twice', async () => {
  let r = await staff.post('/api/sheets/photo', { qr: 'SM1:press:2', image: jpeg(), quality });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const s = r.data.sheet;
  ids.sheet = s.id;
  assert.equal(s.source, 'photo');
  assert.equal(s.sheet_no, '2');
  assert.equal(s.status, 'review');
  assert.equal(s.photo.form_version, 1);

  const img = await fetch(app.base + s.photo.url, { headers: { cookie: staff.cookie } });
  assert.equal(img.status, 200);
  assert.equal(Buffer.from(await img.arrayBuffer()).length, 3004);
  assert.equal((await fetch(app.base + s.photo.url)).status, 401);

  r = await staff.post('/api/sheets/photo', { qr: 'SM1:press:2', image: jpeg(), quality });
  assert.equal(r.status, 409);
  assert.equal(r.data.existing_id, s.id);
  assert.equal((await staff.post('/api/sheets/photo', { qr: 'hello', image: jpeg(), quality })).status, 400);
  assert.equal((await staff.post('/api/sheets/photo', { qr: 'SM1:press:3', image: 'data:image/png;base64,AAAA' })).status, 400);
});

test('photo sheets keep each line on its printed row', async () => {
  const lines = Array.from({ length: 12 }, () => ({}));
  lines[4] = { row_no: 5, client_id: clientId, thickness: '2', pieces: '4', ops_per_piece: '2', total_written: '8', work_date: '2026-10-20' };
  lines[0] = { row_no: 1, client_id: clientId, thickness: '1', pieces: '1', ops_per_piece: '1', work_date: '2026-10-20' };
  const r = await staff.put(`/api/sheets/${ids.sheet}`, { lines });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.sheet.lines.map((l) => l.row_no), [1, 5]);
  assert.ok(r.data.sheet.issues.every((i) => [0, 1, 5].includes(i.row)));
  const bad = await staff.put(`/api/sheets/${ids.sheet}`, { lines: [{ row_no: 3, pieces: '1' }, { row_no: 3, pieces: '2' }] });
  assert.equal(bad.status, 400);
});

test('صوّر تاني replaces the photo of the same paper only', async () => {
  let r = await staff.post(`/api/sheets/${ids.sheet}/photo`, { qr: 'SM1:press:3', image: jpeg(), quality });
  assert.equal(r.status, 409);
  const before = (await staff.get(`/api/sheets/${ids.sheet}`)).data.sheet.photo.url;
  await new Promise((res) => setTimeout(res, 5)); // a new file name
  r = await staff.post(`/api/sheets/${ids.sheet}/photo`, { qr: 'SM1:press:2', image: jpeg(9), quality, forced: true });
  assert.equal(r.status, 200);
  assert.notEqual(r.data.sheet.photo.url, before);
  assert.equal(r.data.sheet.photo.forced, true);
  assert.deepEqual(r.data.sheet.lines.map((l) => l.row_no), [1, 5], 'typed lines kept');
});

test('a printed number skipped while a later one came back is reported until voided', async () => {
  await staff.post('/api/sheets/photo', { qr: 'SM1:press:4', image: jpeg(), quality });
  let r = await staff.get('/api/forms');
  assert.deepEqual(r.data.missing.map((m) => m.sheet_no), [1, 3]);
  assert.equal((await staff.get('/api/home')).data.missing_printed, 2);
  assert.equal((await staff.post('/api/forms/void', { machine_id: press.id, sheet_no: 1 })).status, 400); // needs a reason
  r = await staff.post('/api/forms/void', { machine_id: press.id, sheet_no: 1, reason: 'اتقطعت' });
  assert.equal(r.status, 200);
  r = await staff.get('/api/forms');
  assert.deepEqual(r.data.missing.map((m) => m.sheet_no), [3]);
});

test('backups copied to a USB/OneDrive folder take the sheet photos along', async () => {
  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');
  const usb = fs.mkdtempSync(path.join(os.tmpdir(), 'sheetmetal-usb-'));
  try {
    assert.equal((await admin.put('/api/backups/settings', { backup_copy_dir: usb })).status, 200);
    assert.equal((await admin.post('/api/backups')).status, 201);
    const photos = path.join(usb, 'Sheet Metal backups', 'photos', 'press');
    assert.ok(fs.readdirSync(photos).filter((f) => f.endsWith('.jpg')).length >= 3, 'every uploaded photo copied');
  } finally {
    fs.rmSync(usb, { recursive: true, force: true });
  }
});
