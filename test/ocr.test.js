// القراءة الآلية on synthetic handwriting: one "technician" writes Arabic digits, ditto
// marks and a few client names with random wobble; the reader learns from three
// reviewed sheets and must read a fourth.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formLayout, cellRect, PX_PER_MM } from '../public/js/forms.js';
import { extractSamples, buildModel, readSheet, numberLabel, toBase64, fromBase64, SURE } from '../public/js/ocr.js';

const layout = formLayout('press');
let seed = 11;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const jit = (v, a) => v + (rnd() - 0.5) * 2 * a;

// Strokes in a unit box (x right, y down).
const circle = (cx, cy, r) => Array.from({ length: 13 }, (_, i) => [cx + r * Math.cos((i / 12) * 2 * Math.PI), cy + r * Math.sin((i / 12) * 2 * Math.PI)]);
const GLYPHS = {
  0: [circle(0.5, 0.55, 0.1)],
  1: [[[0.5, 0.05], [0.5, 0.95]]],
  2: [[[0.25, 0.05], [0.4, 0.3], [0.7, 0.25], [0.8, 0.05]], [[0.4, 0.3], [0.45, 0.95]]],
  3: [[[0.15, 0.05], [0.3, 0.3], [0.45, 0.12], [0.6, 0.3], [0.85, 0.05]], [[0.3, 0.3], [0.35, 0.95]]],
  4: [[[0.75, 0.05], [0.3, 0.25], [0.75, 0.45], [0.25, 0.65], [0.8, 0.95]]],
  5: [circle(0.5, 0.5, 0.32)],
  6: [[[0.15, 0.05], [0.7, 0.15], [0.75, 0.95]]],
  7: [[[0.1, 0.05], [0.5, 0.95], [0.9, 0.05]]],
  8: [[[0.1, 0.95], [0.5, 0.05], [0.9, 0.95]]],
  9: [circle(0.45, 0.3, 0.22), [[0.67, 0.3], [0.67, 0.95]]],
  '.': [[[0.55, 0.72], [0.45, 0.97]]],
};
const TILDE = [Array.from({ length: 9 }, (_, i) => [i / 8, 0.5 + 0.25 * Math.sin((i / 8) * 2 * Math.PI)])];
// A "name": a fixed scribble per client (cursive-ish), wobbled each time it's written.
const NAMES = Object.fromEntries([1, 2, 3, 4].map((id) => [id, [Array.from({ length: 9 }, (_, i) => [i / 8, 0.25 + rnd() * 0.6])]]));
const MATERIALS = { 1: [[[0, 0.6], [0.3, 0.2], [0.6, 0.7], [1, 0.4]]], 2: [circle(0.3, 0.5, 0.25), [[0.6, 0.2], [1, 0.8]]] };

function blankPage() {
  const w = layout.width * PX_PER_MM;
  const h = layout.height * PX_PER_MM;
  const data = new Uint8ClampedArray(w * h).fill(248);
  const page = { width: w, height: h, data };
  // The printed grid, slightly off (straightening is never perfect).
  const t = layout.table;
  const hline = (y) => { for (let x = t.x * PX_PER_MM; x < (t.x + t.width) * PX_PER_MM; x++) data[Math.round((y + 0.3) * PX_PER_MM) * w + Math.round(x)] = 20; };
  const vline = (x) => { for (let y = t.y * PX_PER_MM; y < (t.bodyY + t.rows * t.rowH) * PX_PER_MM; y++) data[Math.round(y) * w + Math.round((x - 0.3) * PX_PER_MM)] = 20; };
  for (let r = 0; r <= t.rows; r++) hline(t.bodyY + r * t.rowH);
  for (const c of layout.columns) vline(c.x);
  return page;
}

// Thick wobbly strokes into a box (mm).
function drawStrokes(page, strokes, box, wobble = 0.05) {
  const dx = jit(0, 0.03); const sc = jit(1, 0.08);
  for (const s of strokes) {
    const pts = s.map(([x, y]) => [box.x + (jit(x, wobble) * sc + dx) * box.w, box.y + jit(y, wobble) * sc * box.h]);
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1]; const [x1, y1] = pts[i];
      const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * PX_PER_MM * 2) + 1;
      for (let k = 0; k <= n; k++) {
        const x = (x0 + ((x1 - x0) * k) / n) * PX_PER_MM; const y = (y0 + ((y1 - y0) * k) / n) * PX_PER_MM;
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) page.data[Math.round(y + oy) * page.width + Math.round(x + ox)] = 30;
      }
    }
  }
}

function writeNumber(page, row, field, value) {
  const r = cellRect(layout, row, field);
  const chars = numberLabel(value);
  const cw = 3.2; const gap = 0.9; const ch = 6;
  const total = chars.reduce((s, c) => s + (c === '.' ? 1.4 : cw) + gap, -gap);
  let x = r.x + (r.w - total) / 2 + jit(0, 0.6);
  const y = r.y + (r.h - ch) / 2 + jit(0, 0.6);
  for (const c of chars) {
    const w = c === '.' ? 1.4 : cw;
    drawStrokes(page, GLYPHS[c], { x, y, w, h: ch });
    x += w + gap;
  }
}
function writeShape(page, row, field, strokes, w, h) {
  const r = cellRect(layout, row, field);
  drawStrokes(page, strokes, { x: r.x + (r.w - w) / 2 + jit(0, 0.8), y: r.y + (r.h - h) / 2 + jit(0, 0.6), w, h });
}

// A filled sheet: returns the page and the "confirmed" lines (with ditto marks).
function fillSheet(rows = 12) {
  const page = blankPage();
  const lines = [];
  let prev = null;
  for (let row = 1; row <= rows; row++) {
    const pieces = 1 + Math.floor(rnd() * 120);
    const ops = 1 + Math.floor(rnd() * 9);
    const l = { row_no: row, client_id: 1 + Math.floor(rnd() * 4), material_id: 1 + Math.floor(rnd() * 2),
      thickness: [1, 1.5, 2, 3, 0.8][Math.floor(rnd() * 5)], pieces, ops_per_piece: ops, total_written: pieces * ops, ditto_fields: [] };
    if (prev && rnd() < 0.4) { l.client_id = prev.client_id; l.ditto_fields.push('client_id'); }
    if (prev && rnd() < 0.3) { l.material_id = prev.material_id; l.ditto_fields.push('material_id'); }
    for (const f of ['client_id', 'material_id']) {
      if (l.ditto_fields.includes(f)) writeShape(page, row, f, TILDE, 6, 2.5);
      else if (f === 'client_id') writeShape(page, row, f, NAMES[l.client_id], 22, 6);
      else writeShape(page, row, f, MATERIALS[l.material_id], 10, 5);
    }
    for (const f of ['thickness', 'pieces', 'ops_per_piece', 'total_written']) writeNumber(page, row, f, l[f]);
    lines.push(l);
    prev = l;
  }
  return { page, lines };
}

test('nothing learned yet: only ink and ditto marks are found, nothing is guessed', () => {
  const { page } = fillSheet(4);
  const reads = readSheet(page, layout, buildModel([]));
  assert.ok(reads.length > 0);
  assert.ok(reads.every((r) => r.value === null), 'no values without examples');
  assert.ok(reads.every((r) => r.row <= 4), 'empty rows give nothing');
  assert.ok(!reads.some((r) => r.field === 'part_name' || r.field === 'work_date'));
});

test('learns from three reviewed sheets, then reads a new one', (t) => {
  const samples = [];
  for (let i = 0; i < 3; i++) {
    const { page, lines } = fillSheet();
    samples.push(...extractSamples(page, layout, lines).map((s) => ({ ...s, technician_id: 1 })));
  }
  // Features survive the trip through JSON.
  const model = buildModel(samples.map((s) => ({ ...s, features: fromBase64(toBase64(s.features)) })));
  t.diagnostic(JSON.stringify(model.counts));
  assert.ok(model.counts.digit > 100);
  assert.ok(model.counts.ditto >= 4);

  const { page, lines } = fillSheet();
  const reads = readSheet(page, layout, model, { technicianId: 1 });
  const want = (row, field) => {
    const l = lines[row - 1];
    return l.ditto_fields.includes(field) ? 'ditto' : String(l[field]);
  };
  const score = {};
  for (const r of reads) {
    const kind = ['client_id', 'material_id'].includes(r.field) ? r.field : 'number';
    score[kind] ||= { ok: 0, n: 0, sureWrong: 0 };
    const got = r.kind === 'ditto' ? 'ditto' : r.value;
    score[kind].n++;
    if (got === want(r.row, r.field)) score[kind].ok++;
    else if (r.confidence >= SURE) score[kind].sureWrong++;
  }
  t.diagnostic(JSON.stringify(score));
  assert.ok(score.client_id.ok / score.client_id.n >= 0.9, 'clients');
  assert.ok(score.material_id.ok / score.material_id.n >= 0.9, 'materials');
  assert.ok(score.number.ok / score.number.n >= 0.75, 'numbers');
  // What it calls sure must (almost) never be wrong.
  const sureWrong = Object.values(score).reduce((s, x) => s + x.sureWrong, 0);
  assert.ok(sureWrong <= 1, `sure but wrong: ${sureWrong}`);
});
