// القراءة الآلية v1: reads a straightened sheet photo cell by cell, learning only from
// sheets people already reviewed (no data leaves the PC, nothing to download).
//
//   empty cell   → too little ink (a rule, works from day one)
//   ~ or //      → learned from cells the reviewer marked as ditto (until there are a few
//                  examples such a cell is only flagged as "writing I can't read yet")
//   numbers      → split into connected ink blobs, left to right; each blob is matched
//                  against digits cut from confirmed sheets (k nearest neighbours)
//   client, material, الخامة من → the whole cell is matched against confirmed cells
//                  of each known name: a closed set, not free reading
//
// Same-technician examples count more (each writes his own way). It only suggests:
// every read lands as a yellow cell until a person has looked at it.
// Pure math on pixel arrays: runs in the browser and in Node tests.
import { cellRect, PX_PER_MM } from './forms.js';

export const FEATURE_VERSION = 1;
export const NUMBER_FIELDS = ['thickness', 'pieces', 'ops_per_piece', 'total_written', 'sheets', 'minutes_per_sheet',
  'pieces_per_sheet', 'hits_per_piece', 'louvers_per_piece', 'minutes'];
export const NAME_FIELDS = ['client_id', 'material_id', 'material_source'];
const MIN_DIGIT_SAMPLES = 20;   // fewer than this: numbers are not read yet
const MIN_NAME_SAMPLES = 2;     // per field
const MIN_DITTO_SAMPLES = 4;    // fewer: no ditto guesses at all (shape alone can't tell ~ from a short word)
export const SURE = 0.9;        // confidence at or above this needs no look (green)

const INK = 140;                // darker than this (on the evened page) is ink
const INSET = 1.2;              // mm kept away from the printed lines

// ---------- cutting a cell ----------
export function cellCrop(page, layout, row, field) {
  const r = cellRect(layout, row, field);
  if (!r) return null;
  const x0 = Math.round((r.x + INSET) * PX_PER_MM);
  const y0 = Math.round((r.y + INSET) * PX_PER_MM);
  const w = Math.max(4, Math.round((r.w - 2 * INSET) * PX_PER_MM));
  const h = Math.max(4, Math.round((r.h - 2 * INSET) * PX_PER_MM));
  const ink = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x0 + x; const py = y0 + y;
      if (px >= 0 && py >= 0 && px < page.width && py < page.height) ink[y * w + x] = page.data[py * page.width + px] < INK ? 1 : 0;
    }
  }
  return { width: w, height: h, ink };
}

// 8-connected ink blobs, without bits of printed line along the edges and specks.
function blobsOf(crop) {
  const { width: w, height: h, ink } = crop;
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const out = [];
  for (let s = 0; s < ink.length; s++) {
    if (!ink[s] || seen[s]) continue;
    let top = 0; stack[top++] = s; seen[s] = 1;
    const px = [];
    let minX = w; let maxX = 0; let minY = h; let maxY = 0;
    while (top) {
      const p = stack[--top];
      const x = p % w; const y = (p - x) / w;
      px.push(p);
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx; const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        if (ink[q] && !seen[q]) { seen[q] = 1; stack[top++] = q; }
      }
    }
    const bw = maxX - minX + 1; const bh = maxY - minY + 1;
    if (px.length < 3) continue; // speck (the Arabic zero ٠ is only a dot, so keep small ones)
    const touches = minX === 0 || minY === 0 || maxX === w - 1 || maxY === h - 1;
    // A printed line that crept into the crop: thin and long, along an edge.
    if (touches && ((bh <= 3 && bw > w * 0.4) || (bw <= 3 && bh > h * 0.4))) continue;
    out.push({ px, minX, maxX, minY, maxY, bw, bh, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 });
  }
  return out;
}

// Resamples ink inside a box to gw×gh (area average), as 0..255 bytes.
function grid(crop, keep, box, gw, gh) {
  const out = new Uint8Array(gw * gh);
  const sx = box.w / gw; const sy = box.h / gh;
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      let s = 0; let n = 0;
      for (let y = Math.floor(box.y + gy * sy); y < Math.ceil(box.y + (gy + 1) * sy); y++) {
        for (let x = Math.floor(box.x + gx * sx); x < Math.ceil(box.x + (gx + 1) * sx); x++) {
          n++;
          if (x >= 0 && y >= 0 && x < crop.width && y < crop.height && keep[y * crop.width + x]) s++;
        }
      }
      out[gy * gw + gx] = n ? Math.round((s / n) * 255) : 0;
    }
  }
  return out;
}

const mask = (crop, blobs) => {
  const m = new Uint8Array(crop.width * crop.height);
  for (const b of blobs) for (const p of b.px) m[p] = 1;
  return m;
};
const union = (blobs) => ({
  minX: Math.min(...blobs.map((b) => b.minX)), maxX: Math.max(...blobs.map((b) => b.maxX)),
  minY: Math.min(...blobs.map((b) => b.minY)), maxY: Math.max(...blobs.map((b) => b.maxY)),
});

// Everything we need to know about one cell.
export function analyzeCell(page, layout, row, field) {
  const crop = cellCrop(page, layout, row, field);
  if (!crop) return null;
  const blobs = blobsOf(crop);
  const inkPx = blobs.reduce((s, b) => s + b.px.length, 0);
  const fraction = inkPx / (crop.width * crop.height);
  if (!blobs.length || fraction < 0.004) return { empty: true, crop, blobs: [] };
  const u = union(blobs);
  const bw = u.maxX - u.minX + 1; const bh = u.maxY - u.minY + 1;
  const pad = 2;
  const box = { x: u.minX - pad, y: u.minY - pad, w: bw + 2 * pad, h: bh + 2 * pad };
  // Shape of the whole writing (for names and ditto): 32×12 + where/how big it is.
  const shape = grid(crop, mask(crop, blobs), box, 32, 12);
  const extra = [bw / crop.width, bh / crop.height, Math.min(1, fraction * 8), Math.min(1, blobs.length / 8)].map((v) => Math.round(v * 255));
  return { empty: false, crop, blobs, fraction, bw, bh, feature: Uint8Array.from([...shape, ...extra]) };
}

// Blobs of a number, left to right (digits are written left to right in Arabic too).
// Overlapping blobs (a broken stroke) are one character.
export function numberParts(cell) {
  const sorted = [...cell.blobs].sort((a, b) => a.cx - b.cx);
  const groups = [];
  for (const b of sorted) {
    const g = groups[groups.length - 1];
    const overlap = g ? Math.min(g.maxX, b.maxX) - Math.max(g.minX, b.minX) : -1;
    if (g && overlap > 0.5 * Math.min(g.maxX - g.minX + 1, b.bw)) {
      g.blobs.push(b); Object.assign(g, union(g.blobs));
    } else groups.push({ blobs: [b], ...union([b]) });
  }
  const bandTop = Math.min(...groups.map((g) => g.minY));
  const bandH = Math.max(...groups.map((g) => g.maxY)) - bandTop + 1;
  const maxH = Math.max(...groups.map((g) => g.maxY - g.minY + 1));
  return groups.map((g) => {
    const w = g.maxX - g.minX + 1; const h = g.maxY - g.minY + 1;
    const side = Math.max(w, h) + 2;
    const box = { x: (g.minX + g.maxX + 1) / 2 - side / 2, y: (g.minY + g.maxY + 1) / 2 - side / 2, w: side, h: side };
    const img = grid(cell.crop, mask(cell.crop, g.blobs), box, 12, 12);
    // Size and height on the line tell "٠" (a dot in the middle) from "٫" (low, slanted).
    const extra = [w / h / 3, h / maxH, ((g.minY + g.maxY) / 2 - bandTop) / bandH].map((v) => Math.round(Math.min(1, v) * 255));
    return Uint8Array.from([...img, ...extra]);
  });
}

// How a confirmed number was written, one label per character.
export function numberLabel(v) {
  if (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) return null;
  const s = String(Number(v));
  return /^\d+(\.\d+)?$/.test(s) ? s.split('') : null;
}

// ---------- learning ----------
// From one reviewed sheet: [{ type: 'kind'|'cell'|'digit', field, label, features }].
// lines: [{ row_no, client_id, material_id, ..., ditto_fields: [...] }]
export function extractSamples(page, layout, lines) {
  const out = [];
  const fields = layout.columns.map((c) => c.field).filter((f) => NUMBER_FIELDS.includes(f) || NAME_FIELDS.includes(f));
  for (const l of lines) {
    if (l.row_no < 1 || l.row_no > layout.table.rows) continue;
    const ditto = new Set(l.ditto_fields || []);
    for (const field of fields) {
      const cell = analyzeCell(page, layout, l.row_no, field);
      if (!cell || cell.empty) continue;
      const value = l[field];
      if (ditto.has(field)) { out.push({ type: 'kind', field, label: 'ditto', features: cell.feature }); continue; }
      if (value === null || value === undefined || value === '') continue;
      out.push({ type: 'kind', field, label: 'ink', features: cell.feature });
      if (NAME_FIELDS.includes(field)) out.push({ type: 'cell', field, label: String(value), features: cell.feature });
      else {
        const chars = numberLabel(value);
        const parts = numberParts(cell);
        if (chars && chars.length === parts.length) parts.forEach((f, i) => out.push({ type: 'digit', field: '', label: chars[i], features: f }));
      }
    }
  }
  return out;
}

// samples: [{ type, field, label, technician_id, features: Uint8Array }]
export function buildModel(samples) {
  const model = { digit: [], cell: {}, kind: [], scale: {} };
  for (const s of samples) {
    const f = s.features instanceof Uint8Array ? s.features : Uint8Array.from(s.features);
    const item = { label: s.label, tech: s.technician_id || null, f };
    if (s.type === 'digit') model.digit.push(item);
    else if (s.type === 'kind') model.kind.push(item);
    else if (s.type === 'cell') (model.cell[s.field] ||= []).push(item);
  }
  // Typical distance to the nearest same-label example: what "close" means for this data.
  const typical = (items) => {
    const ds = [];
    for (let i = 0; i < Math.min(items.length, 150); i++) {
      let best = Infinity;
      for (let j = 0; j < items.length; j++) {
        if (i !== j && items[j].label === items[i].label) best = Math.min(best, dist(items[i].f, items[j].f));
      }
      if (best < Infinity) ds.push(best);
    }
    ds.sort((a, b) => a - b);
    return ds.length ? Math.max(ds[Math.floor(ds.length / 2)], 1) : null;
  };
  model.scale.digit = typical(model.digit);
  model.scale.kind = typical(model.kind);
  for (const [f, items] of Object.entries(model.cell)) model.scale[f] = typical(items);
  model.counts = {
    digit: model.digit.length,
    ditto: model.kind.filter((k) => k.label === 'ditto').length,
    ...Object.fromEntries(Object.entries(model.cell).map(([f, items]) => [f, items.length])),
  };
  return model;
}

function dist(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s);
}

// k nearest neighbours; same-technician examples look 20% closer.
function knn(items, f, tech, k, scale) {
  const near = items.map((it) => ({ it, d: dist(f, it.f) * (tech && it.tech === tech ? 0.8 : 1) }))
    .sort((a, b) => a.d - b.d).slice(0, k);
  if (!near.length) return null;
  const score = {};
  for (const n of near) score[n.it.label] = (score[n.it.label] || 0) + 1 / (n.d + scale * 0.05);
  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
  const total = ranked.reduce((s, [, v]) => s + v, 0);
  const share = ranked[0][1] / total;
  const closeness = Math.max(0, Math.min(1, 1.6 - near[0].d / scale));
  return { label: ranked[0][0], confidence: share * closeness, ranked: ranked.map(([label, v]) => ({ label, score: v / total })) };
}

/**
 * Reads every cell the model knows how to read.
 * Returns [{ row, field, kind: 'ditto'|'value'|'ink', value, confidence, candidates }]:
 *   ditto → the reviewer's value from the row above applies; ink → writing we can't read yet.
 * Empty cells are left out.
 */
export function readSheet(page, layout, model, { technicianId = null } = {}) {
  const reads = [];
  const fields = layout.columns.map((c) => c.field).filter((f) => NUMBER_FIELDS.includes(f) || NAME_FIELDS.includes(f));
  const dittoKnown = model.counts.ditto >= MIN_DITTO_SAMPLES;
  for (let row = 1; row <= layout.table.rows; row++) {
    for (const field of fields) {
      const cell = analyzeCell(page, layout, row, field);
      if (!cell || cell.empty) continue;
      // Ditto first: it changes what the cell means.
      let ditto = null;
      if (row > 1 && dittoKnown) {
        const k = knn(model.kind, cell.feature, technicianId, 5, model.scale.kind);
        if (k?.label === 'ditto') ditto = k.confidence;
      }
      if (ditto !== null) { reads.push({ row, field, kind: 'ditto', value: null, confidence: round(ditto), candidates: [] }); continue; }

      if (NAME_FIELDS.includes(field)) {
        const items = model.cell[field] || [];
        if (items.length < MIN_NAME_SAMPLES) { reads.push({ row, field, kind: 'ink', value: null, confidence: 0, candidates: [] }); continue; }
        const k = knn(items, cell.feature, technicianId, 7, model.scale[field] || 1);
        reads.push({ row, field, kind: 'value', value: k.label, confidence: round(k.confidence),
          candidates: k.ranked.slice(0, 3).map((c) => ({ value: c.label, score: round(c.score) })) });
      } else {
        if (model.digit.length < MIN_DIGIT_SAMPLES) { reads.push({ row, field, kind: 'ink', value: null, confidence: 0, candidates: [] }); continue; }
        const parts = numberParts(cell).map((f) => knn(model.digit, f, technicianId, 3, model.scale.digit));
        const text = parts.map((p) => p.label).join('');
        const ok = /^\d+(\.\d+)?$/.test(text);
        reads.push({ row, field, kind: ok ? 'value' : 'ink', value: ok ? String(Number(text)) : null,
          confidence: ok ? round(Math.min(...parts.map((p) => p.confidence))) : 0, candidates: [] });
      }
    }
  }
  crossCheck(reads);
  return reads;
}

// pieces × per-piece = the technician's own total: when all three were read and agree,
// they back each other up; when they don't, none of them is sure.
function crossCheck(reads) {
  const at = (row, field) => reads.find((r) => r.row === row && r.field === field && r.kind === 'value');
  for (const row of new Set(reads.map((r) => r.row))) {
    const [a, b, t] = [at(row, 'pieces'), at(row, 'ops_per_piece'), at(row, 'total_written')];
    if (!a || !b || !t) continue;
    const agree = Math.abs(Number(a.value) * Number(b.value) - Number(t.value)) < 1e-6;
    for (const r of [a, b, t]) r.confidence = round(agree ? Math.min(1, r.confidence + 0.15) : Math.min(r.confidence, 0.5));
  }
}

const round = (v) => Math.round(v * 100) / 100;

// Features travel as base64 (compact JSON for the server).
export function toBase64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return typeof btoa === 'function' ? btoa(s) : Buffer.from(bytes).toString('base64');
}
export function fromBase64(b64) {
  if (typeof atob !== 'function') return Uint8Array.from(Buffer.from(b64, 'base64'));
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
