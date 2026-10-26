// The photo pipeline on synthetic "phone photos" of a printed form: drawn page,
// put in perspective and turned, with a shadow and noise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { formLayout, qrText, parseQr, rowRect, cellRect, PX_PER_MM, FORM_MACHINES } from '../public/js/forms.js';
import { processPhoto, homography, project } from '../public/js/vision.js';

const decode = (rgba, w, h) => jsQR(rgba, w, h, { inversionAttempts: 'dontInvert' });

// The printed page as a grayscale bitmap at `ppm` px/mm.
function drawPage(layout, text, ppm = 8) {
  const w = Math.round(layout.width * ppm);
  const h = Math.round(layout.height * ppm);
  const g = new Uint8ClampedArray(w * h).fill(250);
  const rect = (x, y, rw, rh, v = 15) => {
    for (let j = Math.round(y * ppm); j < Math.round((y + rh) * ppm); j++) {
      for (let i = Math.round(x * ppm); i < Math.round((x + rw) * ppm); i++) if (i >= 0 && j >= 0 && i < w && j < h) g[j * w + i] = v;
    }
  };
  for (const m of layout.markers) rect(m.x - layout.markerSize / 2, m.y - layout.markerSize / 2, layout.markerSize, layout.markerSize);
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const mod = layout.qr.size / n;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.modules.get(r, c)) rect(layout.qr.x + c * mod, layout.qr.y + r * mod, mod, mod);
  const t = layout.table;
  for (let r = 0; r <= t.rows; r++) rect(t.x, t.bodyY + r * t.rowH, t.width, 0.4);
  rect(t.x, t.y, t.width, 0.4);
  for (const c of layout.columns) rect(c.x, t.y, 0.4, t.headerH + t.rows * t.rowH);
  rect(t.x + t.width, t.y, 0.4, t.headerH + t.rows * t.rowH);
  // Some "handwriting" strokes in a few cells.
  for (let r = 1; r <= 5; r++) rect(t.x + 30, t.bodyY + (r - 0.5) * t.rowH, 20, 0.7, 40);
  return { width: w, height: h, data: g, ppm };
}

// Photo = page seen through a homography, on a dark table, with a light gradient and noise.
function takePhoto(page, layout, corners, { width = 1800, height = 1350, shadow = 0.45, noise = 10, seed = 7 } = {}) {
  const pageCorners = [{ x: 0, y: 0 }, { x: layout.width, y: 0 }, { x: layout.width, y: layout.height }, { x: 0, y: layout.height }];
  const H = homography(corners, pageCorners); // photo px → page mm
  const data = new Uint8ClampedArray(width * height * 4);
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = project(H, x + 0.5, y + 0.5);
      let v = 70;
      if (p.x >= 0 && p.y >= 0 && p.x < layout.width && p.y < layout.height) {
        v = page.data[Math.floor(p.y * page.ppm) * page.width + Math.floor(p.x * page.ppm)];
      }
      v *= 1 - shadow * (x / width) * (y / height); // darker toward one corner
      v += (rnd() - 0.5) * noise;
      const i = (y * width + x) * 4;
      data[i] = v; data[i + 1] = v; data[i + 2] = v * 0.95; data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

test('layouts: every machine fits its page and columns fill the table', () => {
  for (const m of FORM_MACHINES) {
    const L = formLayout(m);
    const t = L.table;
    assert.ok(t.bodyY + t.rows * t.rowH < L.notes.y, m);
    assert.ok(L.notes.y + L.notes.height <= L.height - 8, m);
    const sum = L.columns.reduce((s, c) => s + c.w, 0);
    assert.ok(Math.abs(sum - t.width) < 1e-9, m);
    assert.equal(L.columns[0].field, 'row_no'); // rightmost
    assert.ok(Math.abs(L.columns[0].x + L.columns[0].w - (t.x + t.width)) < 1e-9);
    assert.deepEqual(rowRect(L, 2).y, t.bodyY + t.rowH);
    assert.ok(cellRect(L, 1, 'client_id'));
  }
  assert.deepEqual(parseQr(qrText('press', 37)), { version: 1, machine: 'press', sheetNo: 37 });
  assert.equal(parseQr('SM1:oven:3'), null);
  assert.equal(parseQr('hello'), null);
});

test('a tilted, shadowed photo is straightened and identified', (t) => {
  const layout = formLayout('press');
  const page = drawPage(layout, qrText('press', 123));
  // Page corners in the photo: perspective, slightly rotated.
  const photo = takePhoto(page, layout, [{ x: 520, y: 70 }, { x: 1330, y: 120 }, { x: 1390, y: 1290 }, { x: 430, y: 1250 }]);
  const r = processPhoto(photo, decode);
  t.diagnostic(JSON.stringify(r.quality));
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
  assert.equal(r.qr.machine, 'press');
  assert.equal(r.qr.sheetNo, 123);
  assert.equal(r.image.width, layout.width * PX_PER_MM);
  assert.equal(r.image.height, layout.height * PX_PER_MM);
  // Grid lines land where the layout says (straightened within ~1 mm).
  const g = r.image;
  const at = (xmm, ymm) => g.data[Math.round(ymm * PX_PER_MM) * g.width + Math.round(xmm * PX_PER_MM)];
  const dark = (xmm, ymm) => Math.min(...[-1, -0.5, 0, 0.5, 1].map((d) => at(xmm, ymm + d)));
  for (const row of [0, 6, 12]) assert.ok(dark(100, layout.table.bodyY + row * layout.table.rowH + 0.2) < 120, `row line ${row}`);
  assert.ok(at(100, layout.table.bodyY + layout.table.rowH / 2 + 2) > 200, 'cell is white after evening the light');
});

test('upside-down landscape punch sheet', () => {
  const layout = formLayout('punch');
  const page = drawPage(layout, qrText('punch', 9));
  // Page turned 180°: its top-left corner is at the photo's bottom-right.
  const photo = takePhoto(page, layout, [{ x: 1700, y: 1250 }, { x: 120, y: 1220 }, { x: 160, y: 110 }, { x: 1660, y: 80 }]);
  const r = processPhoto(photo, decode);
  assert.equal(r.ok, true, r.problems.join(' / '));
  assert.equal(r.qr.machine, 'punch');
  assert.equal(r.qr.sheetNo, 9);
});


test('a blurry or cut-off photo is refused with a reason', (t) => {
  const layout = formLayout('laser');
  const page = drawPage(layout, qrText('laser', 5));
  // Bottom corners outside the photo.
  const cut = takePhoto(page, layout, [{ x: 500, y: 100 }, { x: 1300, y: 100 }, { x: 1300, y: 1700 }, { x: 500, y: 1700 }]);
  const r = processPhoto(cut, decode);
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /المربعات السودا/);

  // A 5×5 box blur: the code still reads, but writing this soft is not worth reading.
  const photo = takePhoto(page, layout, [{ x: 520, y: 70 }, { x: 1330, y: 90 }, { x: 1350, y: 1280 }, { x: 480, y: 1260 }], { noise: 0 });
  const k = 2;
  const src = photo.data.slice();
  for (let y = k; y < photo.height - k; y++) {
    for (let x = k; x < photo.width - k; x++) {
      let s = 0;
      for (let dy = -k; dy <= k; dy++) for (let dx = -k; dx <= k; dx++) s += src[((y + dy) * photo.width + x + dx) * 4];
      const i = (y * photo.width + x) * 4;
      photo.data[i] = photo.data[i + 1] = photo.data[i + 2] = s / (2 * k + 1) ** 2;
    }
  }
  const b = processPhoto(photo, decode);
  t.diagnostic(JSON.stringify({ quality: b.quality, problems: b.problems }));
  assert.equal(b.ok, false);
  assert.equal(b.qr.sheetNo, 5); // identified, just not sharp enough
  assert.ok(b.problems.some((p) => /مش واضحة/.test(p)), b.problems.join(' / '));
});
