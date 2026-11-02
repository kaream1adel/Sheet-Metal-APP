// أوراق التشغيل over HTTP: drafts with serials, the paper parsed on the server (Arabic digits,
// «١٫٥م اسود», ditto), the review gate (red fixed, yellow visited) enforced on the server,
// اعتماد locking the sheet, cancel with a reason (refused once a line is posted), the
// correction that makes a new version, the month lock, and staff never receiving money.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, client } from './helpers.js';
import { isMoneyKey } from '../src/money.js';
import { getDb } from '../src/db.js';
import { approvedLinesForSheet } from '../src/operations/sheets.js';

let app;
let admin;
let staff;
let viewer;
const ids = {};

const keys = (v, out = new Set()) => {
  if (Array.isArray(v)) v.forEach((x) => keys(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keys(x, out); }
  return out;
};
const assertNoMoney = (data, what) => {
  const bad = [...keys(data)].filter(isMoneyKey);
  assert.deepEqual(bad, [], `${what} leaked money: ${bad.join(', ')}`);
};

before(async () => {
  app = await startApp();
  admin = client(app.base);
  staff = client(app.base);
  viewer = client(app.base);
  await admin.post('/api/setup', { username: 'owner', display_name: 'المالك', password: 'secret1' });
  await admin.post('/api/users', { username: 'manager', display_name: 'مدير الورشة', password: 'secret2', role: 'staff' });
  await staff.post('/api/login', { username: 'manager', password: 'secret2' });
  ids.tech = (await staff.post('/api/technicians', { name: 'فني تجريبي', machine: 'press' })).data.technician.id;
  ids.tech2 = (await staff.post('/api/technicians', { name: 'فني الليزر التجريبي', machine: 'laser' })).data.technician.id;
  ids.c1 = (await staff.post('/api/parties', { kind: 'client', name: 'ورشة النجمة التجريبية', aliases: 'النجمه' })).data.party.id;
  ids.c2 = (await staff.post('/api/parties', { kind: 'client', name: 'مصنع القمر التجريبي' })).data.party.id;
});
after(() => app.stop());

test('a new draft gets serial تش-0001; the server parses the paper (digits, ١٫٥م اسود, ditto, empty rows)', async () => {
  const r = await staff.post('/api/operations/sheets', {
    machine: 'press', technician_id: ids.tech, sheet_date: '2026-10-15',
    lines: [
      { part_name: 'جنب', client_text: 'النجمه', material_text: '١٫٥م اسود', pieces: '١٢', per_piece: '٣', total_written: '٣٦', work_date: '١٥/١٠' },
      { part_name: '', client_text: '~', material_text: '~', thickness: '~', pieces: '4', per_piece: '2', total_written: '8', ditto_fields: ['client_text', 'material_text', 'thickness'] },
      { part_name: '', client_text: '', pieces: '' },
    ],
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const s = r.data.sheet;
  assert.equal(s.serial, 'تش-0001');
  assert.equal(s.view_status, 'draft');
  assert.equal(s.status_name, 'مسودة');
  assert.equal(s.lines.length, 2, 'the empty row is dropped');
  const [a, b] = s.lines;
  assert.equal(a.client_id, ids.c1, 'an alias matches the client');
  assert.equal(a.client_name, 'ورشة النجمة التجريبية');
  assert.equal(a.thickness, 1.5);
  assert.equal(a.material_name, 'أسود');
  assert.equal(a.pieces, 12);
  assert.equal(a.work_date, '2026-10-15');
  assert.equal(a.material_text, '1.5م اسود', 'the app shows Western digits');
  assert.equal(a.material_text, '1.5م اسود', 'the app shows Western digits');
  assert.equal(b.client_id, ids.c1, 'ditto copies the client');
  assert.equal(b.thickness, 1.5);
  assert.equal(b.material_id, a.material_id);
  assert.deepEqual(b.ditto_fields.sort(), ['client_text', 'material_text', 'thickness']);
  assert.equal(s.counts.red, 0);
  ids.sheet1 = s.id;
  // drafts are not in the review queue
  const q = await staff.get('/api/operations/review');
  assert.ok(!q.data.sheets.some((x) => x.id === s.id));
});

test('bad input is refused with an Arabic message: bad number, bad sheet date, unknown machine', async () => {
  let r = await staff.post('/api/operations/sheets', { machine: 'press', sheet_date: '2026-10-15', lines: [{ pieces: 'كتير' }] });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /عدد القطع رقم غلط/);
  assert.equal(r.data.field, 'pieces');
  r = await staff.post('/api/operations/sheets', { machine: 'press', sheet_date: '2026-02-30', lines: [] });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /تاريخ الورقة غلط/);
  r = await staff.post('/api/operations/sheets', { machine: 'oven', sheet_date: '2026-10-15' });
  assert.equal(r.status, 400);
  r = await staff.post('/api/operations/sheets', { machine: 'press', sheet_date: '2026-10-15', lines: [{ thickness: '0' }] });
  assert.equal(r.status, 400);
  r = await staff.post('/api/operations/sheets', { machine: 'press', sheet_date: '2026-10-15', technician_id: 999 });
  assert.equal(r.status, 400);
});

test('the review gate: red must be fixed, yellow must be visited; the server refuses to approve before', async () => {
  let r = await staff.post('/api/operations/sheets', {
    machine: 'press', technician_id: ids.tech, sheet_date: '2026-10-16', submit: true,
    lines: [
      { client_text: 'عميل مش معروف', material_text: '2م اسود', pieces: 5, per_piece: 2, total_written: 10 },
      { client_text: 'مصنع القمر التجريبي', material_text: '3م مجلفن', pieces: 10, per_piece: 3, total_written: 32, work_date: '31/9' },
    ],
  });
  assert.equal(r.status, 201);
  let s = r.data.sheet;
  ids.gate = s.id;
  assert.equal(s.view_status, 'review');
  assert.deepEqual(s.issues.filter((i) => i.level === 'red').map((i) => i.code).sort(), ['bad_date', 'no_client']);
  assert.equal(s.issues.find((i) => i.code === 'total_mismatch').row_no, 2);
  assert.ok((await staff.get('/api/operations/review')).data.sheets.some((x) => x.id === s.id && x.counts.red === 2));

  r = await staff.post(`/api/operations/sheets/${s.id}/approve`);
  assert.equal(r.status, 409);
  assert.match(r.data.error, /بالأحمر/);
  assert.equal(r.data.counts.red, 2);

  // fix the reds: pick the client, fix the date
  const lines = s.lines.map((l) => ({ ...l }));
  lines[0].client_id = ids.c2; lines[0].client_text = 'مصنع القمر التجريبي';
  lines[1].work_date = '1/9';
  r = await staff.put(`/api/operations/sheets/${s.id}`, { lines });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  s = r.data.sheet;
  assert.equal(s.counts.red, 0);
  assert.equal(s.counts.unseen, 2, 'total mismatch + date far from the sheet');
  r = await staff.post(`/api/operations/sheets/${s.id}/approve`);
  assert.equal(r.status, 409);
  assert.match(r.data.error, /صفرا/);

  // visit the yellows; a stale key is refused
  assert.equal((await staff.post(`/api/operations/sheets/${s.id}/ack`, { keys: ['x|y|z|w'] })).status, 409);
  r = await staff.post(`/api/operations/sheets/${s.id}/ack`, { keys: s.issues.filter((i) => i.level === 'yellow').map((i) => i.key) });
  assert.equal(r.status, 200);
  assert.equal(r.data.sheet.counts.unseen, 0);

  // a changed number brings its yellow back (new message)
  const again = r.data.sheet.lines.map((l) => ({ ...l }));
  again[1].total_written = 31;
  r = await staff.put(`/api/operations/sheets/${s.id}`, { lines: again });
  assert.equal(r.data.sheet.counts.unseen, 1);
  // yellow seen while typing is acknowledged with the save
  const seen = r.data.sheet.issues.filter((i) => !i.acked && i.level === 'yellow');
  const withSeen = r.data.sheet.lines.map((l) => ({ ...l, seen: seen.filter((i) => i.line_id === l.id).map((i) => `${i.field}|${i.code}|${i.message}`) }));
  r = await staff.put(`/api/operations/sheets/${s.id}`, { lines: withSeen });
  assert.equal(r.data.sheet.counts.unseen, 0);

  r = await staff.post(`/api/operations/sheets/${s.id}/approve`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.sheet.status, 'approved');
  assert.equal(r.data.sheet.approved_by_name, 'مدير الورشة');
  assert.ok(r.data.sheet.approved_at);
});

test('an approved sheet is locked: no edit, no second approval; pricing gets its lines', async () => {
  let r = await staff.put(`/api/operations/sheets/${ids.gate}`, { notes: 'تعديل' });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /معتمدة/);
  assert.equal((await staff.post(`/api/operations/sheets/${ids.gate}/approve`)).status, 409);
  const lines = approvedLinesForSheet(ids.gate);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].client_id, ids.c2);
  assert.deepEqual(lines[0].sections, ['press']);
  assert.equal(lines[1].work_date, '2026-09-01');
  assert.equal(lines[0].work_date, '2026-10-16', 'no line date: the sheet date');
  assert.equal(lines[0].material_density, 7.85);
  assert.deepEqual(approvedLinesForSheet(ids.sheet1), [], 'a draft has nothing to price');
  const audit = getDb().prepare("SELECT action FROM audit_log WHERE entity = 'op_sheet' AND entity_id = ? ORDER BY id").all(ids.gate).map((a) => a.action);
  assert.ok(audit.includes('create') && audit.includes('approve') && audit.includes('ack'));
});

test('cancel needs a reason, and is refused once a line of the sheet is posted', async () => {
  assert.equal((await staff.post(`/api/operations/sheets/${ids.gate}/cancel`, { reason: '  ' })).status, 400);
  // pricing posted one of its lines
  const line = getDb().prepare('SELECT id FROM op_lines WHERE sheet_id = ? ORDER BY row_no LIMIT 1').get(ids.gate);
  const pid = getDb().prepare(`INSERT INTO price_items (op_line_id, sheet_id, client_id, section, billing, status, qty, rate, amount)
    VALUES (?, ?, ?, 'press', 'bend', 'posted', 10, 1000, 10000)`).run(line.id, ids.gate, ids.c2).lastInsertRowid;
  let r = await staff.post(`/api/operations/sheets/${ids.gate}/cancel`, { reason: 'غلط' });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /اترحّل/);
  r = await staff.post(`/api/operations/sheets/${ids.gate}/correct`, { reason: 'غلط' });
  assert.equal(r.status, 409, 'no correction either');
  getDb().prepare("UPDATE price_items SET status = 'suggested' WHERE id = ?").run(pid);
  r = await staff.post(`/api/operations/sheets/${ids.gate}/cancel`, { reason: 'الورقة اتكتبت مرتين' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.sheet.status, 'cancelled');
  assert.equal(r.data.sheet.cancel_reason, 'الورقة اتكتبت مرتين');
  assert.equal(getDb().prepare('SELECT status FROM price_items WHERE id = ?').get(pid).status, 'cancelled', 'its suggested prices go with it');
  assert.equal((await staff.post(`/api/operations/sheets/${ids.gate}/cancel`, { reason: 'تاني' })).status, 409);
});

test('a correction of an approved sheet makes a new version in review; the old one is cancelled and points to it', async () => {
  let r = await staff.post('/api/operations/sheets', {
    machine: 'laser', technician_id: ids.tech2, sheet_date: '2026-10-17', submit: true,
    lines: [{ client_text: 'ورشة النجمة التجريبية', material_text: 'مجلفن 2م', sheets: '3', start_time: '٧ دقيقة' }],
  });
  const s = r.data.sheet;
  assert.equal(s.lines[0].minutes_per_sheet, 7);
  assert.equal(s.lines[0].minutes_from, 'minutes');
  assert.equal(s.counts.red, 0, JSON.stringify(s.issues));
  r = await staff.post(`/api/operations/sheets/${s.id}/approve`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await staff.post(`/api/operations/sheets/${s.id}/correct`, {})).status, 400, 'a reason is required');
  r = await staff.post(`/api/operations/sheets/${s.id}/correct`, { reason: 'عدد الألواح 4 مش 3' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const v2 = r.data.sheet;
  assert.equal(v2.serial, `${s.serial}-2`);
  assert.equal(v2.version, 2);
  assert.equal(v2.view_status, 'review');
  assert.equal(v2.supersedes_id, s.id);
  assert.equal(v2.lines.length, 1);
  assert.deepEqual(v2.versions.map((x) => x.status), ['cancelled', 'review']);
  const old = (await staff.get(`/api/operations/sheets/${s.id}`)).data.sheet;
  assert.equal(old.status, 'cancelled');
  assert.equal(old.superseded_by, v2.id);
  assert.match(old.cancel_reason, /اتصححت/);
  const lines = v2.lines.map((l) => ({ ...l, sheets: 4 }));
  r = await staff.put(`/api/operations/sheets/${v2.id}`, { lines });
  assert.equal(r.data.sheet.lines[0].sheets, 4);
  assert.equal((await staff.post(`/api/operations/sheets/${v2.id}/approve`)).status, 200);
});

test('a draft: its writer may throw it away; sending to review; machine change only while empty', async () => {
  let r = await staff.post('/api/operations/sheets', { machine: 'shear', sheet_date: '2026-10-18' });
  const id = r.data.sheet.id;
  r = await staff.put(`/api/operations/sheets/${id}`, { machine: 'punch' });
  assert.equal(r.data.sheet.machine, 'punch');
  r = await staff.put(`/api/operations/sheets/${id}`, { lines: [{ client_text: 'مصنع القمر التجريبي', pieces: 10, louvers_per_piece: 6, thickness: 1 }] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.sheet.lines[0].sections, ['louver']);
  assert.equal(r.data.sheet.counts.red, 0, JSON.stringify(r.data.sheet.issues));
  assert.equal((await staff.put(`/api/operations/sheets/${id}`, { machine: 'press' })).status, 409);
  r = await staff.post(`/api/operations/sheets/${id}/submit`);
  assert.equal(r.data.sheet.view_status, 'review');
  r = await staff.post('/api/operations/sheets', { machine: 'press', sheet_date: '2026-10-18' });
  r = await staff.post(`/api/operations/sheets/${r.data.sheet.id}/cancel`, { reason: 'مش محتاجها' });
  assert.equal(r.status, 200);
  assert.equal(r.data.sheet.status, 'cancelled');
});

test('factory material asks length and width; a sheet with no lines cannot be approved', async () => {
  let r = await staff.post('/api/operations/sheets', {
    machine: 'laser', sheet_date: '2026-10-19', technician_id: ids.tech2, submit: true,
    lines: [{ client_text: 'مصنع القمر التجريبي', material_text: '2م اسود', sheets: 1, start_time: '8:00', end_time: '8:12', material_source: 'خامة المصنع' }],
  });
  let s = r.data.sheet;
  assert.equal(s.lines[0].material_source, 'factory');
  assert.equal(s.lines[0].minutes_per_sheet, 12);
  assert.equal(s.lines[0].minutes_from, 'clock');
  assert.deepEqual(s.issues.filter((i) => i.level === 'red').map((i) => i.code), ['factory_size']);
  r = await staff.put(`/api/operations/sheets/${s.id}`, { lines: s.lines.map((l) => ({ ...l, length_cm: '٢٥٠', width_cm: '125' })) });
  s = r.data.sheet;
  assert.equal(s.counts.red, 0);
  assert.deepEqual(s.lines[0].sections, ['laser', 'material']);
  r = await staff.post('/api/operations/sheets', { machine: 'press', sheet_date: '2026-10-19', submit: true });
  assert.equal(r.data.sheet.issues[0].code, 'no_lines');
  assert.equal((await staff.post(`/api/operations/sheets/${r.data.sheet.id}/approve`)).status, 409);
});

test('the month lock: no new sheet, no edit, no approval dated in a locked month', async () => {
  let r = await staff.post('/api/operations/sheets', { machine: 'press', sheet_date: '2026-08-10', technician_id: ids.tech, submit: true,
    lines: [{ client_id: ids.c1, material_text: '2م اسود', pieces: 1, per_piece: 1 }] });
  const id = r.data.sheet.id;
  assert.equal((await admin.post('/api/month-locks', { month: '2026-08' })).status, 201);
  r = await staff.post('/api/operations/sheets', { machine: 'press', sheet_date: '2026-08-11' });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /مقفول/);
  assert.equal((await staff.put(`/api/operations/sheets/${id}`, { notes: 'x' })).status, 409);
  assert.equal((await staff.post(`/api/operations/sheets/${id}/approve`)).status, 409);
  r = await staff.post('/api/operations/sheets', { machine: 'press', sheet_date: '2026-09-01', lines: [{ client_id: ids.c1, work_date: '2026-08-30' }] });
  assert.equal(r.status, 409, 'a line dated in the locked month too');
});

test('list filters: machine, technician, client, date, status, serial', async () => {
  let r = await staff.get('/api/operations/sheets?machine=laser');
  assert.ok(r.data.sheets.length >= 2 && r.data.sheets.every((s) => s.machine === 'laser'));
  r = await staff.get(`/api/operations/sheets?technician_id=${ids.tech}`);
  assert.ok(r.data.sheets.every((s) => s.technician_id === ids.tech));
  r = await staff.get(`/api/operations/sheets?client_id=${ids.c1}`);
  assert.ok(r.data.sheets.length >= 1 && r.data.sheets.every((s) => s.clients.includes('ورشة النجمة التجريبية')));
  r = await staff.get('/api/operations/sheets?from=2026-10-16&to=2026-10-16');
  assert.ok(r.data.sheets.every((s) => s.sheet_date === '2026-10-16'));
  r = await staff.get('/api/operations/sheets?status=draft');
  assert.ok(r.data.sheets.every((s) => s.view_status === 'draft'));
  r = await staff.get('/api/operations/sheets?status=cancelled');
  assert.ok(r.data.sheets.length >= 2);
  r = await staff.get(`/api/operations/sheets?q=${encodeURIComponent('0001')}`);
  assert.equal(r.data.sheets[0].serial, 'تش-0001');
  assert.equal((await staff.get('/api/operations/sheets?status=wat')).status, 400);
  assert.equal((await staff.get('/api/operations/sheets?from=2026-02-31')).status, 400);
});

test('client matching: exact alias, typos and partial names offered, create-new path', async () => {
  let r = await staff.get(`/api/operations/clients/match?text=${encodeURIComponent('النجمه')}`);
  assert.equal(r.data.exact, ids.c1);
  r = await staff.get(`/api/operations/clients/match?text=${encodeURIComponent('مصنع القمر التجريبى')}`);
  assert.equal(r.data.exact, ids.c2, 'ى and ي fold the same');
  r = await staff.get(`/api/operations/clients/match?text=${encodeURIComponent('القمر')}`);
  assert.equal(r.data.exact, null);
  assert.equal(r.data.candidates[0].id, ids.c2);
  r = await staff.get(`/api/operations/clients/match?text=${encodeURIComponent('ورشه النجمة التجربية')}`);
  assert.equal(r.data.candidates[0].id, ids.c1, 'a typo still finds it');
  r = await staff.get(`/api/operations/clients/match?text=${encodeURIComponent('القمرى')}`);
  assert.ok(r.data.candidates.some((c) => c.id === ids.c2), 'one word nearly the same is offered');
  r = await staff.get(`/api/operations/clients/match?text=${encodeURIComponent('القمرى')}`);
  assert.ok(r.data.candidates.some((c) => c.id === ids.c2), 'one word nearly the same is offered');
  // a similar new name asks first (parties' own check), then the line matches it
  r = await staff.post('/api/parties', { kind: 'client', name: 'النجمة التجريبية' });
  assert.equal(r.status, 409);
  assert.ok(r.data.similar.length);
});

test('staff never receives a money field from operations', async () => {
  const sheets = (await staff.get('/api/operations/sheets')).data;
  assertNoMoney(sheets, 'sheets list');
  for (const s of sheets.sheets.slice(0, 6)) assertNoMoney((await staff.get(`/api/operations/sheets/${s.id}`)).data, `sheet ${s.id}`);
  assertNoMoney((await staff.get('/api/operations/review')).data, 'review');
  assertNoMoney((await staff.get('/api/operations/home')).data, 'home');
  assertNoMoney((await staff.get('/api/operations/production?from=2026-01-01&to=2026-12-31')).data, 'production');
  assertNoMoney((await staff.get(`/api/operations/clients/match?text=x`)).data, 'match');
});

test('signed out: 401; unknown paths under operations: 404', async () => {
  assert.equal((await viewer.get('/api/operations/sheets')).status, 401);
  assert.equal((await staff.get('/api/operations/anything')).status, 404);
});
