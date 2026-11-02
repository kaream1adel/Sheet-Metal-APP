// صوّر ورقة: every photo is a job read on the server. Against a fake Claude API: without a
// key (manual entry with the photo), with the reader (machine told by the reader or picked),
// a busy service retried by itself, a wrong key, retry, type-by-hand, the same photo twice,
// the trust gate (unsure / unproven cells are yellow) and the key never reaching a browser.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { startApp, client, sendMessage } from './helpers.js';
import { getDb } from '../src/db.js';
import { kick, idle } from '../src/photos.js';

let app;
let admin;
let staff;
let fake;
let reply = null;
let calls = 0;
let lastBody = null;
const KEY = 'sk-ant-test-photos-0123456789';
const ids = {};

const jpeg = (seed = 3) => `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3000, seed)]).toString('base64')}`;
const message = (obj) => ({
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
  content: [{ type: 'text', text: JSON.stringify(obj) }], stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 3000, output_tokens: 900, cache_read_input_tokens: 1500, cache_creation_input_tokens: 0 },
});
const row = (n, extra) => ({
  row: n, client_written: null, client_id: null, part_name: null, material_written: null, material_id: null,
  thickness: null, pieces: null, ops_per_piece: null, total_written: null, sheets: null, minutes_per_sheet: null,
  pieces_per_sheet: null, hits_per_piece: null, louvers_per_piece: null, sheet_size: null, start_time: null, end_time: null,
  work_date: null, material_source: null, ditto_fields: [], confidence: 'high', uncertain_fields: [], ...extra,
});
const keyOf = (req) => req.headers['x-api-key'] || String(req.headers.authorization || '').replace(/^Bearer /, '');
const wait = async () => { kick(); await idle(); };

before(async () => {
  const api = express();
  api.use(express.json({ limit: '20mb' }));
  api.post('/v1/messages', (req, res) => {
    calls += 1;
    lastBody = req.body;
    if (keyOf(req) !== KEY) return res.status(401).json({ type: 'error', error: { type: 'authentication_error', message: 'bad key' } });
    const r = typeof reply === 'function' ? reply(req) : reply;
    if (r?.status) return res.status(r.status).set('retry-after-ms', '1').json({ type: 'error', error: { type: r.type, message: 'x' } });
    sendMessage(req, res, r);
  });
  fake = await new Promise((r) => { const s = api.listen(0, '127.0.0.1', () => r(s)); });
  process.env.SHEETMETAL_AI_BASE_URL = `http://127.0.0.1:${fake.address().port}`;

  app = await startApp();
  admin = client(app.base);
  staff = client(app.base);
  await admin.post('/api/setup', { username: 'owner', display_name: 'المالك', password: 'secret1' });
  await admin.post('/api/users', { username: 'manager', display_name: 'المدير', password: 'secret2', role: 'staff' });
  await staff.post('/api/login', { username: 'manager', password: 'secret2' });
  ids.client = (await staff.post('/api/parties', { kind: 'client', name: 'شركة الأفق التجريبية' })).data.party.id;
  ids.tech = (await staff.post('/api/technicians', { name: 'حسين التجريبي', machine: 'laser' })).data.technician.id;
  ids.black = (await staff.get('/api/lookups')).data.materials.find((m) => m.name === 'أسود').id;
});
after(async () => {
  await idle();
  delete process.env.SHEETMETAL_AI_BASE_URL;
  await new Promise((r) => fake.close(r));
  await app.stop();
});

test('without a key: the machine is asked, then a draft sheet with the photo is ready to type', async () => {
  let r = await staff.post('/api/operations/photos', { image: jpeg(1) });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.job.status, 'needs_machine');
  r = await staff.post(`/api/operations/photos/${r.data.job.id}/machine`, { machine: 'press' });
  assert.equal(r.data.job.status, 'done');
  assert.equal(r.data.job.sheet.machine_name, 'التناية');
  assert.equal(r.data.job.sheet.status, 'draft');
  assert.equal(r.data.job.sheet.lines, 0);
  const sheet = (await staff.get(`/api/operations/sheets/${r.data.job.sheet.id}`)).data.sheet;
  assert.equal(sheet.source, 'photo');
  assert.ok(sheet.photo_url);
  const photo = await fetch(app.base + sheet.photo_url, { headers: { cookie: staff.cookie } });
  assert.equal(photo.status, 200);
  assert.equal(photo.headers.get('content-type'), 'image/jpeg');

  r = await staff.post('/api/operations/photos', { images: [jpeg(2), jpeg(3)], machine: 'laser', technician_id: ids.tech });
  assert.equal(r.data.jobs.length, 2, 'several photos at once');
  assert.ok(r.data.jobs.every((j) => j.status === 'done' && j.sheet.status === 'draft'), 'machine known: drafts right away');
  assert.equal((await staff.post(`/api/operations/photos/${r.data.jobs[0].id}/retry`)).status, 409);
  assert.equal(calls, 0, 'nothing was sent anywhere');
});

test('the same photo twice is refused; a broken image is refused', async () => {
  const r = await staff.post('/api/operations/photos', { image: jpeg(2) });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /اترفعت قبل كده/);
  assert.equal((await staff.post('/api/operations/photos', { image: 'data:image/png;base64,AAAA' })).status, 400);
  assert.equal((await staff.post('/api/operations/photos', { image: jpeg(4), machine: 'oven' })).status, 400);
});

test('with the reader: a photo becomes a sheet in review with its lines; unsure cells are yellow', async () => {
  const s = await admin.put('/api/settings/ai', { api_key: KEY, enabled: true });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  assert.equal(JSON.stringify(s.data).includes(KEY), false, 'the key never comes back');
  assert.equal(JSON.stringify((await staff.get('/api/lookups')).data).includes(KEY), false);
  reply = message({
    machine: 'laser', sheet_date: '2026-10-22', technician_name: 'حسين', notes: 'وقفة نص ساعة',
    rows: [
      row(1, { client_written: 'الافق', client_id: ids.client, material_written: '2م اسود', material_id: ids.black, thickness: 2, sheets: 3, minutes_per_sheet: 7 }),
      row(2, { ditto_fields: ['client_id', 'material_id', 'thickness'], sheets: 1, minutes_per_sheet: 8, confidence: 'medium', uncertain_fields: ['minutes_per_sheet'] }),
      row(3, { client_written: 'عميل جديد خالص', sheets: 2, minutes_per_sheet: 5, thickness: 1 }),
    ],
  });
  let r = await staff.post('/api/operations/photos', { image: jpeg(5) });
  assert.equal(r.status, 201);
  assert.ok(['queued', 'reading'].includes(r.data.job.status), r.data.job.status);
  const id = r.data.job.id;
  await wait();
  r = await staff.get(`/api/operations/photos/${id}`);
  const job = r.data.job;
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.equal(job.sheet.machine_name, 'الليزر');
  assert.equal(job.sheet.status, 'review');
  assert.equal(job.sheet.lines, 3);
  assert.equal(lastBody.model, 'claude-opus-5-5');
  assert.equal(lastBody.output_config.format.type, 'json_schema', 'structured output');
  assert.match(lastBody.system[0].text, /المراجعة column/, 'the old-paper rules');
  assert.match(lastBody.system[1].text, /شركة الأفق التجريبية/, 'the client list (closed set)');

  const sheet = (await staff.get(`/api/operations/sheets/${job.sheet.id}`)).data.sheet;
  assert.equal(sheet.sheet_date, '2026-10-22');
  assert.equal(sheet.technician_id, ids.tech, 'technician matched by name');
  assert.match(sheet.notes, /وقفة/);
  const [a, b, c] = sheet.lines;
  assert.equal(a.client_id, ids.client);
  assert.equal(a.client_text, 'شركة الأفق التجريبية', 'the official name');
  assert.equal(b.client_id, ids.client, 'ditto from the row above');
  assert.equal(b.thickness, 2);
  assert.equal(c.client_id, null);
  const red = sheet.issues.filter((i) => i.level === 'red');
  assert.deepEqual(red.map((i) => `${i.row_no}:${i.code}`), ['3:no_client']);
  const yellow = sheet.issues.filter((i) => i.level === 'yellow' && i.code === 'ai_unsure');
  assert.ok(yellow.some((i) => i.row_no === 2 && i.field === 'start_time') || yellow.some((i) => i.row_no === 2 && i.field === 'minutes_per_sheet'),
    JSON.stringify(yellow));
  assert.ok(yellow.some((i) => i.row_no === 1 && i.field === 'sheets'), 'a sure reading without a track record is still yellow');
  const usage = getDb().prepare('SELECT sheet_id, job_id FROM ai_usage ORDER BY id DESC LIMIT 1').get();
  assert.equal(usage.sheet_id, job.sheet.id, 'the cost is linked to its sheet');

  // fix the red, visit the yellows, approve: the reader's track record grows
  const lines = sheet.lines.map((l) => ({ ...l }));
  lines[2].client_id = ids.client;
  lines[2].client_text = 'شركة الأفق التجريبية';
  r = await staff.put(`/api/operations/sheets/${sheet.id}`, { lines });
  const s2 = r.data.sheet;
  assert.equal(s2.counts.red, 0);
  await staff.post(`/api/operations/sheets/${sheet.id}/ack`, { keys: s2.issues.filter((i) => i.level === 'yellow').map((i) => i.key) });
  r = await staff.post(`/api/operations/sheets/${sheet.id}/approve`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const track = getDb().prepare('SELECT COUNT(*) n, SUM(correct) ok FROM ai_reads WHERE sheet_id = ?').get(sheet.id);
  assert.ok(track.n > 0);
});

test('the reader cannot tell the machine: it is asked, and the reading is not paid twice', async () => {
  reply = message({ machine: 'unknown', sheet_date: null, technician_name: null, notes: null,
    rows: [row(1, { client_id: ids.client, client_written: 'الأفق', pieces: 3, ops_per_piece: 2, total_written: 6, thickness: 2 })] });
  let r = await staff.post('/api/operations/photos', { image: jpeg(6) });
  await wait();
  const id = r.data.job.id;
  r = await staff.get(`/api/operations/photos/${id}`);
  assert.equal(r.data.job.status, 'needs_machine');
  assert.equal(r.data.job.rows_read, 1);
  const before = calls;
  r = await staff.post(`/api/operations/photos/${id}/machine`, { machine: 'press' });
  assert.equal(r.data.job.status, 'done');
  assert.equal(r.data.job.sheet.lines, 1);
  assert.equal(calls, before, 'picking the machine reuses the reading');
  const sheet = (await staff.get(`/api/operations/sheets/${r.data.job.sheet.id}`)).data.sheet;
  assert.equal(sheet.lines[0].per_piece, 2);
  assert.ok(!sheet.issues.some((i) => i.row_no === 1 && ['pieces', 'per_piece', 'total_written'].includes(i.field) && i.code === 'ai_unsure'),
    'the technician total agrees: those numbers are sure');
});

test('a busy service is retried by itself; a wrong key fails with a clear message; retry and type-by-hand', async () => {
  let busy = true;
  reply = () => (busy ? { status: 429, type: 'rate_limit_error' }
    : message({ machine: 'press', sheet_date: null, technician_name: null, notes: null, rows: [row(1, { pieces: 1, ops_per_piece: 1 })] }));
  let r = await staff.post('/api/operations/photos', { image: jpeg(7) });
  const id = r.data.job.id;
  await wait();
  let job = getDb().prepare('SELECT * FROM photo_jobs WHERE id = ?').get(id);
  assert.equal(job.status, 'queued', 'waiting to try again');
  assert.match(job.error, /مشغولة/);
  busy = false;
  getDb().prepare("UPDATE photo_jobs SET ready_at = datetime('now', '-1 minute') WHERE id = ?").run(id);
  await wait();
  assert.equal((await staff.get(`/api/operations/photos/${id}`)).data.job.status, 'done');

  await admin.put('/api/settings/ai', { api_key: 'sk-ant-wrong-key-000000000' });
  r = await staff.post('/api/operations/photos', { image: jpeg(8) });
  await wait();
  job = (await staff.get(`/api/operations/photos/${r.data.job.id}`)).data.job;
  assert.equal(job.status, 'failed');
  assert.match(job.error, /مفتاح/);
  await admin.put('/api/settings/ai', { api_key: KEY });
  assert.equal((await staff.post(`/api/operations/photos/${job.id}/retry`)).status, 200);
  await wait();
  assert.equal((await staff.get(`/api/operations/photos/${job.id}`)).data.job.status, 'done', 'works after fixing the key');

  await admin.put('/api/settings/ai', { api_key: 'sk-ant-wrong-key-000000000' });
  r = await staff.post('/api/operations/photos', { image: jpeg(9) });
  await wait();
  const failed = (await staff.get(`/api/operations/photos/${r.data.job.id}`)).data.job;
  assert.equal(failed.status, 'failed');
  assert.equal((await staff.post(`/api/operations/photos/${failed.id}/manual`, {})).status, 400, 'the machine is needed');
  r = await staff.post(`/api/operations/photos/${failed.id}/manual`, { machine: 'shear' });
  assert.equal(r.data.job.status, 'done', 'type it by hand: a draft with its photo');
  assert.equal(r.data.job.sheet.status, 'draft');
  await admin.put('/api/settings/ai', { api_key: KEY });
});

test('the list, the counts, dismissing a finished photo; staff gets no money and no key', async () => {
  const list = (await staff.get('/api/operations/photos')).data;
  assert.equal(list.ai, true);
  assert.ok(list.jobs.length >= 5);
  assert.equal(JSON.stringify(list).includes(KEY), false);
  const done = list.jobs.find((j) => j.status === 'done');
  assert.equal((await staff.post(`/api/operations/photos/${done.id}/dismiss`)).status, 200);
  assert.ok(!(await staff.get('/api/operations/photos')).data.jobs.some((j) => j.id === done.id));
  const home = (await staff.get('/api/operations/home')).data;
  assert.equal(typeof home.photos.reading, 'number');
  assert.equal(home.photos.ai, true);
});
