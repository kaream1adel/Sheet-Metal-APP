// The reader's suggestions on the server: filling cells, yellow "look at this" issues,
// accuracy after confirming, learning examples, practice sheets.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, client } from './helpers.js';

let app;
let admin;
let staff;
let lookups;
let clientId;
let sheetId;

const jpeg = () => `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3000, 1)]).toString('base64')}`;
const keys = (sheet) => sheet.issues.map((i) => `${i.level}:${i.key}`);

before(async () => {
  app = await startApp();
  admin = client(app.base);
  staff = client(app.base);
  await admin.post('/api/setup', { username: 'kaream', display_name: 'كريم', password: 'secret1' });
  await admin.post('/api/users', { username: 'manager', display_name: 'المدير', password: 'secret2', role: 'staff' });
  await staff.post('/api/login', { username: 'manager', password: 'secret2' });
  clientId = (await staff.post('/api/clients', { name: 'عميل تجربة' })).data.client.id;
  lookups = (await staff.get('/api/lookups')).data;
});
after(async () => { await app.stop(); });

test('reads fill the sheet; unsure ones are yellow until someone looks', async () => {
  const black = lookups.materials[0].id;
  const r = await staff.post('/api/sheets/photo', {
    qr: 'SM1:press:1', image: jpeg(), quality: {},
    reads: [
      { row: 1, field: 'client_id', kind: 'value', value: String(clientId), confidence: 0.6, candidates: [{ value: String(clientId), score: 0.7 }] },
      { row: 1, field: 'material_id', kind: 'value', value: String(black), confidence: 0.95 },
      { row: 1, field: 'pieces', kind: 'value', value: '4', confidence: 0.95 },
      { row: 1, field: 'ops_per_piece', kind: 'value', value: '2', confidence: 0.4 },
      { row: 2, field: 'client_id', kind: 'ditto', confidence: 0.7 },
      { row: 2, field: 'pieces', kind: 'ink', confidence: 0 },
      { row: 3, field: 'pieces', kind: 'ink', confidence: 0 },
      { row: 1, field: 'part_name', kind: 'value', value: 'x', confidence: 1 }, // not a read field: ignored
      { row: 1, field: 'client_id', kind: 'value', value: '999', confidence: 1 }, // duplicate cell: ignored
      { row: 4, field: 'client_id', kind: 'value', value: '999', confidence: 1 }, // no such client: unread
    ],
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const s = r.data.sheet;
  sheetId = s.id;
  const row = (n) => s.lines.find((l) => l.row_no === n);
  assert.equal(row(1).client_id, clientId);
  assert.equal(row(1).pieces, 4);
  assert.equal(row(2).client_id, clientId, '~ took the value above');
  assert.deepEqual(row(2).ditto_fields, ['client_id']);
  assert.equal(row(3), undefined, 'unreadable writing does not invent a line');
  const k = keys(s);
  assert.ok(k.includes('yellow:1:client_id:ocr'));
  assert.ok(k.includes('yellow:1:ops_per_piece:ocr'));
  assert.ok(!k.some((x) => x.startsWith('yellow:1:pieces:ocr')), 'sure reads need no look');
  assert.ok(!k.some((x) => x.startsWith('yellow:1:material_id:ocr')));
  assert.ok(k.includes('yellow:2:client_id:ocr'));
  assert.ok(k.includes('yellow:2:pieces:unread'));
  assert.ok(k.includes('yellow:3:client_id:unread_row'));
  assert.ok(k.includes('yellow:4:client_id:unread_row'));
  assert.equal(s.reads.find((x) => x.row_no === 1 && x.field === 'client_id').candidates.length, 1);
});

test('typing over a read clears its flag; reads never overwrite typing', async () => {
  let s = (await staff.get(`/api/sheets/${sheetId}`)).data.sheet;
  const lines = Array.from({ length: 12 }, (_, i) => ({ row_no: i + 1 }));
  const black = lookups.materials[0].id;
  for (const l of s.lines) Object.assign(lines[l.row_no - 1], l);
  Object.assign(lines[0], { ops_per_piece: '3', thickness: '2', work_date: '2026-10-20', total_written: '12' });
  Object.assign(lines[1], { material_id: black, thickness: '2', pieces: '5', ops_per_piece: '1', work_date: '2026-10-20' });
  let r = await staff.put(`/api/sheets/${sheetId}`, { lines });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  s = r.data.sheet;
  assert.ok(!keys(s).includes('yellow:1:ops_per_piece:ocr'), 'typed 3 over the read 2');
  assert.ok(keys(s).includes('yellow:1:client_id:ocr'), 'still the read value');
  assert.deepEqual(s.lines.find((l) => l.row_no === 2).ditto_fields, ['client_id'], 'ditto mark kept by the editor');

  // Reading again only fills blanks.
  r = await staff.post(`/api/sheets/${sheetId}/reads`, { reads: [{ row: 1, field: 'ops_per_piece', kind: 'value', value: '7', confidence: 0.5 }] });
  assert.equal(r.status, 200);
  assert.equal(r.data.sheet.lines.find((l) => l.row_no === 1).ops_per_piece, 3);
});

test('confirming records what each read really was; then the sheet can teach', async () => {
  let s = (await staff.get(`/api/sheets/${sheetId}`)).data.sheet;
  // Settle the rest: technician/date for the sheet, rows 3 and 4 are scribbles.
  const tech = (await staff.post('/api/technicians', { name: 'حمدي' })).data.technician.id;
  const lines = s.lines.map((l) => ({ ...l }));
  let r = await staff.put(`/api/sheets/${sheetId}`, { technician_id: tech, sheet_date: '2026-10-20', lines });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  s = r.data.sheet;
  assert.equal((await staff.post('/api/ocr/samples', { sheet_id: sheetId, feature_version: 1, samples: [] })).status, 409, 'not before confirming');
  r = await staff.post(`/api/sheets/${sheetId}/confirm`, { acks: s.issues.map((i) => i.key) });
  assert.equal(r.status, 200, JSON.stringify(r.data));

  const stats = (await admin.get('/api/ocr/stats')).data;
  const by = Object.fromEntries(stats.accuracy.map((a) => [a.what, a]));
  assert.equal(by.client_id.reads, 1);
  assert.equal(by.client_id.correct, 1);
  assert.equal(by.number.reads, 2); // pieces 4 ✓, ops 2 ✗ (became 3)
  assert.equal(by.number.correct, 1);
  assert.equal(by.ditto.correct, 1);
  assert.equal(stats.unread, 3);

  assert.deepEqual((await staff.get('/api/ocr/pending')).data.ids, [sheetId]);
  const f = Buffer.alloc(147, 9).toString('base64');
  r = await staff.post('/api/ocr/samples', { sheet_id: sheetId, feature_version: 1, samples: [
    { type: 'digit', label: '4', features: f }, { type: 'cell', field: 'client_id', label: String(clientId), features: f },
    { type: 'kind', field: 'client_id', label: 'ditto', features: f }] });
  assert.equal(r.status, 201);
  assert.equal((await staff.post('/api/ocr/samples', { sheet_id: sheetId, feature_version: 1, samples: [{ type: 'digit', label: 'x', features: f }] })).status, 400);
  const model = (await staff.get('/api/ocr/model')).data;
  assert.equal(model.samples.length, 3);
  assert.equal(model.samples[0].features, f);
  assert.deepEqual((await staff.get('/api/ocr/pending')).data.ids, []);
  assert.equal((await staff.get('/api/ocr/stats')).status, 403, 'stats are the admin\'s');
});

test('a practice sheet only teaches: kept as a lesson, never counted as work', async () => {
  await staff.post('/api/forms/print', { machine_id: lookups.machines.find((m) => m.code === 'press').id, count: 3 });
  let r = await staff.post('/api/sheets/photo', { qr: 'SM1:press:2', image: jpeg(), quality: {} });
  const id = r.data.sheet.id;
  assert.equal((await staff.post(`/api/sheets/${id}/lesson`)).status, 400, 'empty sheet teaches nothing');
  await staff.put(`/api/sheets/${id}`, { lines: [{ row_no: 1, client_id: clientId, pieces: '1', ops_per_piece: '1' }] });
  r = await staff.post(`/api/sheets/${id}/lesson`);
  assert.equal(r.status, 200);
  assert.equal(r.data.sheet.status, 'cancelled');
  assert.deepEqual((await staff.get('/api/ocr/pending')).data.ids, [id]);
  const forms = (await staff.get('/api/forms')).data;
  assert.ok(!forms.missing.some((m) => m.sheet_no === 2), 'its printed number is not "missing"');
});

test('an admin quantity fix makes the reader learn the sheet again; forget stops it for good', async () => {
  const s = (await admin.get(`/api/sheets/${sheetId}`)).data.sheet;
  assert.ok(!(await staff.get('/api/ocr/pending')).data.ids.includes(sheetId), 'learned already');
  const r = await admin.patch(`/api/lines/${s.lines[0].id}`, { pieces: '6' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok((await staff.get('/api/ocr/pending')).data.ids.includes(sheetId), 'to be learned again with the fixed value');
  assert.equal((await staff.post('/api/ocr/forget', { sheet_id: sheetId })).status, 403, 'admin only');
  assert.equal((await admin.post('/api/ocr/forget', { sheet_id: sheetId })).status, 200);
  assert.ok(!(await staff.get('/api/ocr/pending')).data.ids.includes(sheetId));
  const f = Buffer.alloc(147, 9).toString('base64');
  assert.equal((await staff.post('/api/ocr/samples', { sheet_id: sheetId, feature_version: 1, samples: [{ type: 'digit', label: '4', features: f }] })).status, 409);
  assert.ok(!(await admin.get('/api/ocr/sheets')).data.sheets.some((x) => x.id === sheetId));
});
