// Browser glue for the automatic reader (ocr.js): the learned examples, a sheet photo
// as pixels, reading it, and teaching from a reviewed sheet.
import { get, post } from './api.js';
import { toGray } from './vision.js';
import { formLayout } from './forms.js';
import { buildModel, readSheet, extractSamples, fromBase64, toBase64, FEATURE_VERSION } from './ocr.js';

let cached = null;

export async function loadModel(force = false) {
  if (!cached || force) {
    cached = get('/api/ocr/model').then(({ samples }) => buildModel(samples.map((s) => ({ ...s, features: fromBase64(s.features) }))));
    cached.catch(() => { cached = null; });
  }
  return cached;
}

// The straightened page as gray pixels, from an <img>-loadable URL (or data URL).
export function pageFromUrl(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      resolve(toGray(ctx.getImageData(0, 0, c.width, c.height)));
    };
    img.onerror = () => reject(new Error('مقدرتش أفتح صورة الورقة'));
    img.src = url;
  });
}

// Reads a page; never throws (reading is a bonus, not a step anyone must wait on).
export async function readPage(page, layout, technicianId = null) {
  try {
    const model = await loadModel();
    return readSheet(page, layout, model, { technicianId });
  } catch (err) {
    console.warn('reading failed', err);
    return [];
  }
}

// A confirmed (or lesson) photo sheet → examples for the reader.
export async function teachFrom(sheet) {
  if (!sheet?.photo) return 0;
  const layout = formLayout(sheet.machine_code, sheet.photo.form_version);
  const page = await pageFromUrl(sheet.photo.url);
  const samples = extractSamples(page, layout, sheet.lines.map((l) => ({ ...l, ditto_fields: l.ditto_fields || [] })));
  await post('/api/ocr/samples', {
    sheet_id: sheet.id, feature_version: FEATURE_VERSION,
    samples: samples.map((s) => ({ type: s.type, field: s.field, label: s.label, features: toBase64(s.features) })),
  });
  cached = null; // learn it right away
  return samples.length;
}
