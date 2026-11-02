// The technician's paper as the app reads it (public/js/modules/ops-paper.js, shared by the
// server and the browser): numbers in Arabic digits, «١٫٥م اسود», minutes, dates, ditto marks,
// sections, and the red / yellow rules of the review gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../public/js/modules/ops-paper.js';

const MATS = [
  { id: 1, name: 'أسود', aliases: ['اسود', 'حديد اسود', 'صاج اسود'] },
  { id: 2, name: 'مجلفن', aliases: ['جلفنة', 'صاج مجلفن'] },
  { id: 4, name: 'ألومنيوم', aliases: ['الومنيوم', 'al'] },
];

test('numbers as the technician writes them', () => {
  assert.equal(P.parseNum('١٫٥م'), 1.5);
  assert.equal(P.parseNum('2,5'), 2.5);
  assert.equal(P.parseNum('١٢'), 12);
  assert.equal(P.parseNum('٧ دقيقة'), 7);
  assert.equal(P.parseNum('1,250'), 1250);
  assert.equal(P.parseNum(''), null);
  assert.equal(P.parseNum(null), null);
  assert.ok(Number.isNaN(P.parseNum('خمسة')));
  assert.ok(Number.isNaN(P.parseNum('1.2.3')));
});

test('material and thickness from one cell: «١٫٥م اسود», «2مم مجلفن», «AL ٢م»', () => {
  assert.deepEqual(pick(P.parseMaterialText('١٫٥م اسود', MATS)), { thickness: 1.5, material_id: 1 });
  assert.deepEqual(pick(P.parseMaterialText('2مم صاج مجلفن', MATS)), { thickness: 2, material_id: 2 });
  assert.deepEqual(pick(P.parseMaterialText('AL ٢م', MATS)), { thickness: 2, material_id: 4 });
  assert.deepEqual(pick(P.parseMaterialText('3 مجلفن', MATS)), { thickness: 3, material_id: 2 });
  assert.deepEqual(pick(P.parseMaterialText('الأسود', MATS)), { thickness: null, material_id: 1 });
  assert.deepEqual(pick(P.parseMaterialText('نحاس 1م', MATS)), { thickness: 1, material_id: null });
  assert.deepEqual(pick(P.parseMaterialText('', MATS)), { thickness: null, material_id: null });
});
const pick = (r) => ({ thickness: r.thickness, material_id: r.material_id });

test('minutes on the laser / punch paper: written minutes or two clock times', () => {
  assert.deepEqual(pickM(P.parseMinutes('٧ دقيقة', '', 3)), { minutes_per_sheet: 7, from: 'minutes', error: null });
  assert.deepEqual(pickM(P.parseMinutes('8:30', '9:10', 4)), { minutes_per_sheet: 10, from: 'clock', error: null });
  assert.deepEqual(pickM(P.parseMinutes('23:50', '0:20', 1)), { minutes_per_sheet: 30, from: 'clock', error: null }, 'over midnight');
  assert.deepEqual(pickM(P.parseMinutes('', '', 3)), { minutes_per_sheet: null, from: null, error: null });
  assert.equal(P.parseMinutes('بدري', '', 1).error, 'bad');
  assert.equal(P.parseMinutes('8:30', '', 1).error, 'bad', 'a start time with no end is not minutes');
});
const pickM = (r) => ({ minutes_per_sheet: r.minutes_per_sheet, from: r.from, error: r.error });

test('dates are real calendar dates; «٢٠/١٠» takes the sheet year', () => {
  assert.equal(P.validDate('2026-10-20'), true);
  assert.equal(P.validDate('2026-02-29'), false);
  assert.equal(P.validDate('2028-02-29'), true);
  assert.equal(P.validDate('2026-13-01'), false);
  assert.equal(P.validDate('2026-04-31'), false);
  assert.equal(P.validDate('20/10/2026'), false);
  assert.deepEqual(P.parseWorkDate('٢٠/١٠', '2026-10-21'), { value: '2026-10-20', ok: true });
  assert.deepEqual(P.parseWorkDate('5/1/27', '2026-12-30'), { value: '2027-01-05', ok: true });
  assert.deepEqual(P.parseWorkDate('2026-10-5'), { value: '2026-10-05', ok: true });
  assert.deepEqual(P.parseWorkDate('31/9', '2026-09-30'), { value: '31/9', ok: false }, 'kept as written, red');
  assert.deepEqual(P.parseWorkDate('', '2026-09-30'), { value: null, ok: true });
});

test('ditto marks: ~ // 〃 copy the row above with its client and material; row 1 copies nothing', () => {
  for (const m of ['~', '//', '〃', ' ~ ']) assert.equal(P.isDitto(m), true, m);
  assert.equal(P.isDitto('abc'), false);
  const lines = P.resolveDitto([
    { client_text: 'أ', client_id: 5, material_text: 'اسود', material_id: 1, thickness: 2, ditto_fields: ['thickness'] },
    { client_text: null, client_id: null, thickness: null, material_text: null, ditto_fields: ['client_text', 'thickness', 'material_text', 'bogus'] },
    { client_text: null, thickness: null, ditto_fields: ['client_text'] },
  ]);
  assert.deepEqual(lines[0].ditto_fields, []);
  assert.equal(lines[1].client_id, 5);
  assert.equal(lines[1].client_text, 'أ');
  assert.equal(lines[1].material_id, 1);
  assert.equal(lines[1].thickness, 2);
  assert.deepEqual(lines[1].ditto_fields, ['client_text', 'thickness', 'material_text']);
  assert.equal(lines[2].client_id, 5, 'a chain of dittos follows the first written value');
});

test('paper columns per machine are exactly the technician paper', () => {
  assert.deepEqual(P.paperColumns('press').map((c) => c.label),
    ['اسم القطعة', 'العميل', 'الخامة', 'السمك', 'عدد القطع', 'عدد التنيات / قطعة', 'إجمالي التنيات', 'التاريخ', 'المراجعة']);
  assert.deepEqual(P.paperColumns('shear').map((c) => c.label),
    ['اسم القطعة', 'العميل', 'الخامة', 'السمك', 'عدد القطع', 'عدد القصات / قطعة', 'إجمالي القصات', 'التاريخ', 'المراجعة']);
  for (const m of ['laser', 'punch']) {
    assert.deepEqual(P.paperColumns(m).map((c) => c.label),
      ['اسم القطعة', 'العميل', 'الخامة', 'السمك', 'الكمية (ألواح)', 'وقت البداية', 'وقت النهاية', 'التاريخ', 'المراجعة']);
  }
  assert.deepEqual(P.paperColumns('x'), []);
});

test('sections a line feeds: machine, louvers on the punch sheet, factory material', () => {
  assert.deepEqual(P.lineSections('press', { pieces: 4, per_piece: 2 }), ['press']);
  assert.deepEqual(P.lineSections('punch', { sheets: 2, pieces: 10, louvers_per_piece: 6 }), ['punch', 'louver']);
  assert.deepEqual(P.lineSections('punch', { pieces: 10, louvers_per_piece: 6 }), ['louver']);
  assert.deepEqual(P.lineSections('laser', { sheets: 1, material_source: 'factory' }), ['laser', 'material']);
  assert.equal(P.computedTotal('press', { pieces: 12, per_piece: 3 }), 36);
  assert.equal(P.computedTotal('laser', { pieces: 12, per_piece: 3 }), null);
});

const codes = (list) => list.map((i) => `${i.level}:${i.field}:${i.code}`).sort();

test('red: unknown client, missing numbers, bad date, factory size, work order of another client', () => {
  assert.deepEqual(codes(P.lineIssues('press', { client_text: 'مجهول', thickness: 2 })),
    ['red:client_text:no_client', 'red:per_piece:missing', 'red:pieces:missing']);
  assert.match(P.lineIssues('press', { client_text: 'مجهول' })[0].message, /«مجهول» مش في قايمة العملاء/);
  assert.deepEqual(codes(P.lineIssues('press', { client_id: 1, pieces: 3, per_piece: 2 })), ['red:thickness:missing'], 'press needs the thickness (rate band)');
  assert.deepEqual(codes(P.lineIssues('laser', { client_id: 1, thickness: 2, sheets: 2 })), ['red:start_time:missing']);
  assert.deepEqual(codes(P.lineIssues('laser', { client_id: 1, thickness: 2, sheets: 2, minutes_per_sheet: 5, minutes_error: 'bad' })), ['red:start_time:bad_minutes']);
  assert.deepEqual(codes(P.lineIssues('shear', { client_id: 1, thickness: 2, pieces: 1, per_piece: 1, work_date: '2026-02-30' })), ['red:work_date:bad_date']);
  assert.deepEqual(codes(P.lineIssues('laser', { client_id: 1, thickness: 2, sheets: 1, minutes_per_sheet: 4, material_source: 'factory', material_id: 1 })),
    ['red:length_cm:factory_size']);
  assert.deepEqual(codes(P.lineIssues('laser', { client_id: 1, sheets: 1, minutes_per_sheet: 4, material_source: 'factory', length_cm: 100, width_cm: 50 })),
    ['red:material_text:factory_material', 'red:thickness:missing']);
  const orders = { 7: { client_id: 2, status: 'open', serial: 'أم-0007' }, 8: { client_id: 1, status: 'cancelled', serial: 'أم-0008' } };
  const ok = { client_id: 1, thickness: 2, pieces: 1, per_piece: 1 };
  assert.deepEqual(codes(P.lineIssues('press', { ...ok, work_order_id: 7 }, { orders })), ['red:work_order_id:order_client']);
  assert.deepEqual(codes(P.lineIssues('press', { ...ok, work_order_id: 8 }, { orders })), ['red:work_order_id:order_cancelled']);
  assert.deepEqual(codes(P.lineIssues('press', { ...ok, work_order_id: 9 }, { orders })), ['red:work_order_id:order_missing']);
  assert.deepEqual(P.lineIssues('press', ok), []);
});

test('yellow: technician total differs, unusual values, unknown material, far date, unsure reading', () => {
  const base = { client_id: 1, thickness: 2, pieces: 10, per_piece: 3 };
  const t = P.lineIssues('press', { ...base, total_written: 32 });
  assert.deepEqual(codes(t), ['yellow:total_written:total_mismatch']);
  assert.match(t[0].message, /إجمالي الفني 32 والمحسوب 30/);
  assert.deepEqual(P.lineIssues('press', { ...base, total_written: 30 }), []);
  assert.deepEqual(codes(P.lineIssues('press', { ...base, thickness: 40 })), ['yellow:thickness:unusual_thickness']);
  assert.deepEqual(codes(P.lineIssues('press', { ...base, material_text: 'نحاس' })), ['yellow:material_text:material_unknown']);
  assert.deepEqual(codes(P.lineIssues('press', { ...base, work_date: '2026-06-01' }, { sheetDate: '2026-10-01' })), ['yellow:work_date:date_far']);
  assert.deepEqual(codes(P.lineIssues('press', { ...base, work_date: '2026-10-09' }, { sheetDate: '2026-10-09', today: '2026-10-08' })), ['yellow:work_date:date_future']);
  const read = { fields: { pieces: { v: 10, c: 0.5 }, per_piece: { v: 3, c: 0.95 }, client_text: { v: 1, c: 0.75 } } };
  assert.deepEqual(codes(P.lineIssues('press', { ...base, read_json: read })), ['yellow:client_text:ai_unsure', 'yellow:pieces:ai_unsure']);
  assert.deepEqual(codes(P.lineIssues('press', { ...base, pieces: 11, client_id: 3, read_json: read })), [], 'a cell somebody changed is no longer the reader\'s');
  // the key changes with the message, so an edit brings a yellow back
  const a = P.issueKey(t[0]);
  const b = P.issueKey(P.lineIssues('press', { ...base, total_written: 33 })[0]);
  assert.notEqual(a, b);
});

test('an empty row is not a line', () => {
  assert.equal(P.isEmptyLine({ part_name: '', pieces: null }), true);
  assert.equal(P.isEmptyLine({ part_name: 'باب' }), false);
  assert.equal(P.isEmptyLine({ pieces: 0 }), false);
});
