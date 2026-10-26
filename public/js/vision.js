// Turns a phone photo of a printed form into a straight, evenly lit page image.
// Pure math on pixel arrays (no DOM), so it runs in the browser and in Node tests.
//
//   1. find the four solid black corner squares (dark, square, solid blobs)
//   2. try the four ways the page could be turned; the QR code read at its printed
//      place says which one is right, and which machine + sheet number this is
//   3. warp the photo onto the form's own millimetre grid (PX_PER_MM)
//   4. even out shadows, then check sharpness / light / fit
//
// The QR reader is passed in (jsQR in the browser and in tests).
import { formLayout, parseQr, PX_PER_MM, FORM_VERSION } from './forms.js';

const DETECT_MAX = 1200;      // detection runs on a smaller copy
const MIN_SHARPNESS = 150;    // variance of the Laplacian on the straightened table (tune with real photos)
const MIN_BRIGHTNESS = 70;    // paper this dark = photo in the dark

// ---------- small image helpers ----------
export function toGray({ width, height, data }) {
  const g = new Uint8ClampedArray(width * height);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (data[j] * 77 + data[j + 1] * 150 + data[j + 2] * 29) >> 8;
  return { width, height, data: g };
}

function shrink(gray, factor) {
  if (factor <= 1) return gray;
  const f = Math.ceil(factor);
  const w = Math.floor(gray.width / f);
  const h = Math.floor(gray.height / f);
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let dy = 0; dy < f; dy++) {
        const row = (y * f + dy) * gray.width + x * f;
        for (let dx = 0; dx < f; dx++) s += gray.data[row + dx];
      }
      out[y * w + x] = s / (f * f);
    }
  }
  return { width: w, height: h, data: out, scale: f };
}

// Dark pixels compared with their neighbourhood, so shadows don't matter.
function darkMask(gray) {
  const { width: w, height: h, data } = gray;
  const ii = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += data[y * w + x];
      ii[(y + 1) * (w + 1) + x + 1] = ii[y * (w + 1) + x + 1] + row;
    }
  }
  const r = Math.max(8, Math.round(Math.min(w, h) / 14));
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const sum = ii[y1 * (w + 1) + x1] - ii[y0 * (w + 1) + x1] - ii[y1 * (w + 1) + x0] + ii[y0 * (w + 1) + x0];
      const mean = sum / ((x1 - x0) * (y1 - y0));
      mask[y * w + x] = data[y * w + x] < mean * 0.62 && data[y * w + x] < 140 ? 1 : 0;
    }
  }
  return mask;
}

// Connected dark blobs with their size, box and centre.
function blobs(mask, w, h) {
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const out = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    let area = 0; let sx = 0; let sy = 0;
    let minX = w; let maxX = 0; let minY = h; let maxY = 0;
    while (top) {
      const p = stack[--top];
      const x = p % w;
      const y = (p - x) / w;
      area++; sx += x; sy += y;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[top++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[top++] = p + 1; }
      if (y > 0 && mask[p - w] && !seen[p - w]) { seen[p - w] = 1; stack[top++] = p - w; }
      if (y < h - 1 && mask[p + w] && !seen[p + w]) { seen[p + w] = 1; stack[top++] = p + w; }
    }
    if (area >= 25) out.push({ area, x: sx / area, y: sy / area, bw: maxX - minX + 1, bh: maxY - minY + 1 });
  }
  return out;
}

// ---------- geometry ----------
const polyArea = (p) => {
  let a = 0;
  for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i].x * q.y - q.x * p[i].y; }
  return Math.abs(a) / 2;
};

// Clockwise on screen (y grows down), starting anywhere.
function clockwise(pts) {
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  return [...pts].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
}

function isConvex(p) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = p[i]; const b = p[(i + 1) % 4]; const c = p[(i + 2) % 4];
    const z = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (z === 0) return false;
    if (sign && Math.sign(z) !== sign) return false;
    sign = Math.sign(z);
  }
  return true;
}

// The four corner squares: solid, square-ish blobs of similar size spanning the biggest area.
export function findMarkers(gray) {
  const small = shrink(gray, Math.max(gray.width, gray.height) / DETECT_MAX);
  const { width: w, height: h } = small;
  const minSide = Math.min(w, h);
  const cands = blobs(darkMask(small), w, h).filter((b) => {
    const side = Math.max(b.bw, b.bh);
    return side >= minSide * 0.012 && side <= minSide * 0.12 &&
      b.bw / b.bh > 0.45 && b.bw / b.bh < 2.2 && b.area / (b.bw * b.bh) > 0.72;
  }).sort((a, b) => b.area - a.area).slice(0, 14);
  if (cands.length < 4) return null;

  let best = null;
  const n = cands.length;
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++) for (let d = c + 1; d < n; d++) {
    const four = [cands[a], cands[b], cands[c], cands[d]];
    const areas = four.map((q) => q.area);
    if (Math.max(...areas) > 4 * Math.min(...areas)) continue;
    const quad = clockwise(four);
    if (!isConvex(quad)) continue;
    const area = polyArea(quad);
    if (!best || area > best.area) best = { area, quad };
  }
  if (!best || best.area < w * h * 0.08) return null;
  const f = small.scale || 1;
  // Blob centres are in the small copy: back to the photo's pixels (centre of the f×f block).
  return {
    points: best.quad.map((q) => ({ x: (q.x + 0.5) * f - 0.5, y: (q.y + 0.5) * f - 0.5 })),
    coverage: best.area / (w * h),
  };
}

// 3×3 homography taking the 4 `from` points onto the 4 `to` points.
export function homography(from, to) {
  const A = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i];
    const { x: u, y: v } = to[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  // Gaussian elimination with partial pivoting on the 8×9 augmented matrix.
  for (let col = 0; col < 8; col++) {
    let piv = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]];
    if (Math.abs(A[col][col]) < 1e-12) return null;
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const k = A[r][col] / A[col][col];
      for (let c = col; c < 9; c++) A[r][c] -= k * A[col][c];
    }
  }
  return [...A.map((r, i) => r[8] / r[i]), 1];
}

export function project(H, x, y) {
  const d = H[6] * x + H[7] * y + H[8];
  return { x: (H[0] * x + H[1] * y + H[2]) / d, y: (H[3] * x + H[4] * y + H[5]) / d };
}

// Samples the photo over a rectangle of the form (mm) at `ppm` pixels per mm.
function warp(gray, H, rect, ppm) {
  const w = Math.round(rect.w * ppm);
  const h = Math.round(rect.h * ppm);
  const out = new Uint8ClampedArray(w * h);
  const { width: sw, height: sh, data } = gray;
  for (let j = 0; j < h; j++) {
    const my = rect.y + (j + 0.5) / ppm;
    for (let i = 0; i < w; i++) {
      const mx = rect.x + (i + 0.5) / ppm;
      const d = H[6] * mx + H[7] * my + H[8];
      const x = (H[0] * mx + H[1] * my + H[2]) / d;
      const y = (H[3] * mx + H[4] * my + H[5]) / d;
      if (x < 0 || y < 0 || x >= sw - 1 || y >= sh - 1) { out[j * w + i] = 255; continue; }
      const x0 = x | 0; const y0 = y | 0; const fx = x - x0; const fy = y - y0;
      const p = y0 * sw + x0;
      const top = data[p] + (data[p + 1] - data[p]) * fx;
      const bot = data[p + sw] + (data[p + sw + 1] - data[p + sw]) * fx;
      out[j * w + i] = top + (bot - top) * fy;
    }
  }
  return { width: w, height: h, data: out };
}

const toRgba = ({ width, height, data }) => {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i++) { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = data[i]; rgba[i * 4 + 3] = 255; }
  return rgba;
};

// Paper should be white everywhere: divide by a smooth estimate of the paper's brightness.
function evenLight(img) {
  const B = 24; // block, px
  const bw = Math.ceil(img.width / B);
  const bh = Math.ceil(img.height / B);
  const blocks = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      // A bright percentile, not the max, so one noisy pixel can't fake paper.
      const hist = new Uint32Array(256);
      let n = 0;
      for (let y = by * B; y < Math.min(img.height, (by + 1) * B); y++) {
        for (let x = bx * B; x < Math.min(img.width, (bx + 1) * B); x++) { hist[img.data[y * img.width + x]]++; n++; }
      }
      let k = 255; let c = 0;
      while (k > 0 && (c += hist[k]) < n * 0.1) k--;
      blocks[by * bw + bx] = Math.max(k, 30);
    }
  }
  // Blocks fully covered by ink (black squares, QR) borrow their neighbours' paper.
  const smooth = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let m = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const x = bx + dx; const y = by + dy;
        if (x >= 0 && y >= 0 && x < bw && y < bh) m = Math.max(m, blocks[y * bw + x]);
      }
      smooth[by * bw + bx] = m;
    }
  }
  const out = new Uint8ClampedArray(img.data.length);
  for (let y = 0; y < img.height; y++) {
    const fy = Math.min(bh - 1.001, Math.max(0, (y + 0.5) / B - 0.5));
    const y0 = fy | 0; const ty = fy - y0;
    for (let x = 0; x < img.width; x++) {
      const fx = Math.min(bw - 1.001, Math.max(0, (x + 0.5) / B - 0.5));
      const x0 = fx | 0; const tx = fx - x0;
      const i0 = y0 * bw + x0;
      const i1 = Math.min(bh - 1, y0 + 1) * bw + x0;
      const x1 = Math.min(bw - 1, x0 + 1) - x0;
      const bg = (smooth[i0] * (1 - tx) + smooth[i0 + x1] * tx) * (1 - ty) + (smooth[i1] * (1 - tx) + smooth[i1 + x1] * tx) * ty;
      out[y * img.width + x] = (img.data[y * img.width + x] * 250) / bg;
    }
  }
  const brightness = [...smooth].sort((a, b) => a - b)[smooth.length >> 1];
  return { image: { width: img.width, height: img.height, data: out }, brightness };
}

function sharpness(img, rect) {
  const { width: w, data } = img;
  let s = 0; let s2 = 0; let n = 0;
  for (let y = Math.max(1, rect.y); y < Math.min(img.height - 1, rect.y + rect.h); y++) {
    for (let x = Math.max(1, rect.x); x < Math.min(w - 1, rect.x + rect.w); x++) {
      const p = y * w + x;
      const l = 4 * data[p] - data[p - 1] - data[p + 1] - data[p - w] - data[p + w];
      s += l; s2 += l * l; n++;
    }
  }
  return n ? s2 / n - (s / n) ** 2 : 0;
}

const meanIn = (img, r) => {
  let s = 0; let n = 0;
  for (let y = Math.round(r.y); y < Math.round(r.y + r.h); y++) for (let x = Math.round(r.x); x < Math.round(r.x + r.w); x++) { s += img.data[y * img.width + x]; n++; }
  return n ? s / n : 255;
};

// Reads the QR code at its printed place, for one guess of how the page is turned.
function readQrAt(gray, quad, rotation, decodeQr) {
  const pts = [0, 1, 2, 3].map((i) => quad[(i + rotation) % 4]);
  const side = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const across = side(pts[0], pts[1]) + side(pts[2], pts[3]);
  const down = side(pts[1], pts[2]) + side(pts[3], pts[0]);
  // The marker spacing tells portrait from landscape; any machine of that shape gives the QR's place.
  const probe = formLayout(across > down ? 'punch' : 'press');
  const H = homography(probe.markers, pts);
  if (!H) return null;
  const q = probe.qr;
  const pad = 4;
  const region = warp(gray, H, { x: q.x - pad, y: q.y - pad, w: q.size + 2 * pad, h: q.size + 2 * pad }, 10);
  const found = decodeQr(toRgba(region), region.width, region.height);
  const parsed = found && parseQr(found.data);
  return parsed ? { ...parsed, text: found.data, points: pts } : null;
}

/**
 * photo: { width, height, data: RGBA }  (the browser hands over at most ~2400 px)
 * decodeQr: (rgba, width, height) => { data } | null   (jsQR)
 * Returns { ok, problems: [Arabic], qr, layout, image: gray page at PX_PER_MM, quality }.
 */
export function processPhoto(photo, decodeQr) {
  const gray = toGray(photo);
  const problems = [];
  const found = findMarkers(gray);
  if (!found) {
    // Maybe the code is readable even if the corners aren't: say which sheet it is.
    const whole = decodeQr(photo.data, photo.width, photo.height);
    const qr = whole && parseQr(whole.data);
    return {
      ok: false,
      qr,
      problems: ['مش لاقي المربعات السودا الأربعة في أركان الورقة. صوّر الورقة كلها من فوق، والأركان الأربعة باينة.'],
    };
  }
  let qr = null;
  for (let r = 0; r < 4 && !qr; r++) qr = readQrAt(gray, found.points, r, decodeQr);
  if (!qr) {
    return { ok: false, problems: ['مش قادر أقرا الكود (QR) اللي فوق على الشمال. اتأكد إن الصورة واضحة ومفيش ضل أو لمعة عليه.'] };
  }
  if (qr.version > FORM_VERSION) return { ok: false, qr, problems: ['الورقة دي مطبوعة من نسخة أحدث من البرنامج — حدّث البرنامج.'] };
  const layout = formLayout(qr.machine, qr.version);
  const H = homography(layout.markers, qr.points);
  const raw = warp(gray, H, { x: 0, y: 0, w: layout.width, h: layout.height }, PX_PER_MM);
  const { image, brightness } = evenLight(raw);

  const px = (v) => v * PX_PER_MM;
  const t = layout.table;
  const sharp = sharpness(image, { x: px(t.x), y: px(t.y), w: px(t.width), h: px(t.headerH + t.rows * t.rowH) });
  const markerInk = Math.max(...layout.markers.map((m) => meanIn(image, {
    x: px(m.x - layout.markerSize / 4), y: px(m.y - layout.markerSize / 4), w: px(layout.markerSize / 2), h: px(layout.markerSize / 2),
  })));
  if (brightness < MIN_BRIGHTNESS) problems.push('الصورة ضلمة. صوّر في مكان فيه نور أكتر.');
  if (sharp < MIN_SHARPNESS) problems.push('الصورة مش واضحة (مهزوزة أو بعيدة). ثبّت الموبايل وصوّر تاني.');
  if (markerInk > 110) problems.push('الورقة مش متعدلة صح في الصورة. صوّرها تاني من فوق.');
  if (found.coverage < 0.2) problems.push('الورقة صغيرة قوي في الصورة. قرّب الموبايل شوية.');

  return {
    ok: problems.length === 0,
    problems,
    qr: { version: qr.version, machine: qr.machine, sheetNo: qr.sheetNo, text: qr.text },
    layout,
    image,
    quality: { sharpness: Math.round(sharp), brightness: Math.round(brightness), coverage: Math.round(found.coverage * 100) / 100 },
  };
}
