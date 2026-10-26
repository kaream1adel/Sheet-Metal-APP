// القراءة بالذكاء الاصطناعي against a fake Claude API: settings and the secret key,
// a plain photo of any paper, the request we send, and how the answer fills the sheet.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { startApp, client } from './helpers.js';
import { getDb } from '../src/db.js';

let app;
let admin;
let staff;
let fake;
let L;
let reply = null;          // what the fake API answers next
let lastRequest = null;
const KEY = 'sk-test-key-123';
const ids = {};

const jpeg = () => `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3000, 3)]).toString('base64')}`;
const message = (obj, extra = {}) => ({
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
  content: [{ type: 'text', text: JSON.stringify(obj) }], stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 3000, output_tokens: 900, cache_read_input_tokens: 1500, cache_creation_input_tokens: 0 }, ...extra,
});
const emptyRow = (row) => ({
  row, client_written: null, client_id: null, part_name: null, material_written: null, material_id: null,
  thickness: null, pieces: null, ops_per_piece: null, total_written: null, sheets: null, minutes_per_sheet: null,
  pieces_per_sheet: null, hits_per_piece: null, louvers_per_piece: null, minutes: null, sheet_size: null,
  work_date: null, material_source: null, ditto_fields: [], confidence: 'high', uncertain_fields: [],
});

// The SDK may send the key as x-api-key or as a bearer token.
const keyOf = (req) => req.headers['x-api-key'] || String(req.headers.authorization || '').replace(/^Bearer /, '');

before(async () => {
  const api = express();
  api.use(express.json({ limit: '20mb' }));
  api.post('/v1/messages', (req, res) => {
    lastRequest = { headers: req.headers, body: req.body };
    if (keyOf(req) !== KEY) return res.status(401).json({ type: 'error', error: { type: 'authentication_error', message: 'bad key' } });
    res.json(typeof reply === 'function' ? reply() : reply);
  });
  api.get('/v1/models/:id', (req, res) => {
    if (keyOf(req) !== KEY) return res.status(401).json({ type: 'error', error: { type: 'authentication_error', message: 'bad key' } });
    res.json({ type: 'model', id: req.params.id, display_name: 'x', created_at: '2026-01-01T00:00:00Z' });
  });
  fake = await new Promise((r) => { const s = api.listen(0, '127.0.0.1', () => r(s)); });
  process.env.SHEETMETAL_AI_BASE_URL = `http://127.0.0.1:${fake.address().port}`;

  app = await startApp();
  admin = client(app.base);
  staff = client(app.base);
  await admin.post('/api/setup', { username: 'kaream', display_name: 'كريم', password: 'secret1' });
  await admin.post('/api/users', { username: 'manager', display_name: 'المدير', password: 'secret2', role: 'staff' });
  await staff.post('/api/login', { username: 'manager', password: 'secret2' });
  ids.masria = (await staff.post('/api/clients', { name: 'المصرية للتكييف' })).data.client.id;
  ids.nour = (await staff.post('/api/clients', { name: 'النور' })).data.client.id;
  ids.tech = (await staff.post('/api/technicians', { name: 'حمدي' })).data.technician.id;
  L = (await staff.get('/api/lookups')).data;
});
after(async () => {
  delete process.env.SHEETMETAL_AI_BASE_URL;
  await new Promise((r) => fake.close(r));
  await app.stop();
});

test('turning it on: needs a key; the key never comes back to any browser', async () => {
  assert.equal((await staff.get('/api/ai')).status, 403);
  assert.equal((await admin.put('/api/ai', { enabled: true })).status, 400, 'no key yet');
  let r = await admin.put('/api/ai', { api_key: 'wrong-key', enabled: true });
  assert.equal(r.status, 200);
  assert.equal((await admin.post('/api/ai/test')).status, 400, 'a wrong key is caught by the test button');
  r = await admin.put('/api/ai', { api_key: KEY, model: 'claude-opus-5-5' });
  assert.equal(r.data.enabled, true);
  assert.equal((await admin.post('/api/ai/test')).status, 200);
  assert.equal((await admin.put('/api/ai', { model: 'gpt-4' })).status, 400);
  const everything = JSON.stringify([(await admin.get('/api/settings')).data, (await admin.get('/api/ai')).data, (await admin.get('/api/audit')).data, (await staff.get('/api/lookups')).data]);
  assert.ok(!everything.includes(KEY) && !everything.includes('wrong-key'), 'the key is never sent out');
  assert.equal((await staff.get('/api/lookups')).data.ai, true);
});

test('a plain photo of any paper (no QR) is a sheet; the AI reads it into the table', async () => {
  const press = L.machines.find((m) => m.code === 'press');
  let r = await staff.post('/api/sheets/photo', { machine_id: press.id, sheet_no: '١٢', image: jpeg(), quality: {} });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  ids.sheet = r.data.sheet.id;
  assert.equal(r.data.sheet.sheet_no, '12');
  assert.equal(r.data.sheet.photo.form_version, 0);
  assert.equal((await staff.post('/api/sheets/photo', { image: jpeg() })).status, 400, 'machine required without a QR');

  const black = L.materials[0].id;
  reply = message({
    machine: 'press', sheet_date: '2026-10-20', technician_name: 'حمدى', notes: 'المكنة وقفت ساعة الضهر',
    rows: [
      { ...emptyRow(1), client_written: 'المصريه', client_id: ids.masria, material_id: black, thickness: 1.5, pieces: 20, ops_per_piece: 4, total_written: 80, work_date: '2026-10-20', part_name: 'باب' },
      { ...emptyRow(2), ditto_fields: ['client_id', 'material_id'], thickness: 2, pieces: 10, ops_per_piece: 2, total_written: 21, confidence: 'medium' },
      { ...emptyRow(3), client_written: 'محمود الجديد', pieces: 5, ops_per_piece: 1, confidence: 'low', uncertain_fields: ['pieces'] },
      { ...emptyRow(4), client_id: 999, client_written: 'xx' }, // an id that doesn't exist is dropped
    ],
  });
  r = await staff.post(`/api/sheets/${ids.sheet}/ai-read`);
  assert.equal(r.status, 200, JSON.stringify(r.data));

  // What we sent: the photo, the strict schema, the cached lists, the refusal fallback.
  const b = lastRequest.body;
  assert.equal(b.model, 'claude-opus-5-5');
  assert.equal(b.output_config.format.type, 'json_schema');
  assert.equal(b.fallbacks, 'default');
  assert.match(lastRequest.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.ok(b.system.every((s) => s.cache_control?.type === 'ephemeral'));
  assert.match(b.system[1].text, /المصرية للتكييف/);
  assert.equal(b.messages[0].content[0].source.media_type, 'image/jpeg');

  const s = r.data.sheet;
  const row = (n) => s.lines.find((l) => l.row_no === n);
  assert.equal(row(1).client_id, ids.masria);
  assert.equal(row(1).part_name, 'باب');
  assert.equal(row(1).work_date, '2026-10-20');
  assert.equal(row(2).client_id, ids.masria, '~ took the client above');
  assert.deepEqual(row(2).ditto_fields.sort(), ['client_id', 'material_id']);
  assert.equal(row(3).client_id, null);
  assert.equal(row(3).client_text, 'محمود الجديد', 'unknown name kept for the reviewer, never a new client by itself');
  assert.equal(s.technician_id, ids.tech, 'technician matched by name');
  assert.equal(s.sheet_date, '2026-10-20');
  assert.match(s.notes, /وقفت/);
  const k = s.issues.map((i) => `${i.level}:${i.key}`);
  assert.ok(!k.includes('yellow:1:pieces:ocr'), 'sure reads need no look');
  assert.ok(k.includes('red:2:total_written:mismatch'), 'the wrong total is caught');
  assert.ok(k.includes('yellow:2:pieces:ocr'), 'a row whose total disagrees is not sure');
  assert.ok(k.includes('red:3:client_id:missing'));
  assert.ok(k.includes('yellow:3:pieces:ocr'), 'an unclear field is yellow');
  assert.ok(s.reads.every((x) => x.source === 'ai'));
  assert.equal(r.data.ai.machine_mismatch, null);

  const usage = (await admin.get('/api/ai')).data.usage;
  assert.equal(usage.month_reads, 1);
  assert.ok(usage.month_usd > 0.01 && usage.month_usd < 0.1, String(usage.month_usd));
});

test('refusals, bad keys and other machines are reported in plain Arabic', async () => {
  reply = message({ machine: 'laser', sheet_date: null, technician_name: null, notes: null, rows: [] });
  let r = await staff.post(`/api/sheets/${ids.sheet}/ai-read`);
  assert.equal(r.status, 200);
  assert.equal(r.data.ai.machine_mismatch, 'laser');
  reply = message({}, { stop_reason: 'refusal', content: [] });
  r = await staff.post(`/api/sheets/${ids.sheet}/ai-read`);
  assert.equal(r.status, 422);
  assert.match(r.data.error, /رفضت/);
  await admin.put('/api/ai', { api_key: 'expired' });
  r = await staff.post(`/api/sheets/${ids.sheet}/ai-read`);
  assert.equal(r.status, 502);
  assert.match(r.data.error, /المفتاح|مفتاح/);
  await admin.put('/api/ai', { enabled: false });
  assert.equal((await staff.post(`/api/sheets/${ids.sheet}/ai-read`)).status, 409);
  assert.ok(getDb().prepare('SELECT COUNT(*) n FROM ai_usage').get().n >= 2);
});
