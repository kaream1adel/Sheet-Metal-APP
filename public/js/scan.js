// صوّر ورقة (photo of a printed form → straightened page → new sheet in review)
// and طباعة الورق (numbered forms with a QR code per page).
import { h, toast, fill, fmtDate, formModal } from './ui.js';
import { get, post } from './api.js';
import { go, state } from './app.js';
import { processPhoto } from './vision.js';
import { formLayout } from './forms.js';

const MAX_SIDE = 2400; // photos are scaled to this before processing

// ---------- shared: photo file → straightened page ----------
let jsqr = null;
function loadQrReader() {
  jsqr ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/jsQR.js';
    s.onload = () => resolve(window.jsQR);
    s.onerror = () => { jsqr = null; reject(new Error('مقدرتش أحمّل قارئ الكود')); };
    document.head.append(s);
  });
  return jsqr;
}

// <img> applies the phone's rotation (EXIF) by itself.
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('الملف ده مش صورة')); };
    img.src = url;
  });
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

// Returns { result (vision.processPhoto), jpeg (data URL of the straightened page) }.
export async function photoToPage(file) {
  const [decode, img] = await Promise.all([loadQrReader(), loadImage(file)]);
  await nextFrame(); // let "جاري التجهيز…" paint before the heavy work
  const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * scale);
  c.height = Math.round(img.naturalHeight * scale);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const photo = ctx.getImageData(0, 0, c.width, c.height);
  const result = processPhoto(photo, (rgba, w, h) => decode(rgba, w, h, { inversionAttempts: 'dontInvert' }));
  let jpeg = null;
  if (result.image) {
    const { width, height, data } = result.image;
    const out = document.createElement('canvas');
    out.width = width;
    out.height = height;
    const id = out.getContext('2d').createImageData(width, height);
    for (let i = 0; i < data.length; i++) { id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = data[i]; id.data[i * 4 + 3] = 255; }
    out.getContext('2d').putImageData(id, 0, 0);
    jpeg = out.toDataURL('image/jpeg', 0.85);
  }
  return { result, jpeg };
}

export const uploadBody = (result, jpeg, forced = false) => ({ qr: result.qr.text, image: jpeg, quality: result.quality, forced });

// The straightened page with the table grid drawn over it: shows the cutting lines up.
export function pagePreview(jpeg, layout) {
  const t = layout.table;
  const lines = [];
  for (let r = 0; r <= t.rows; r++) lines.push(`<line x1="${t.x}" x2="${t.x + t.width}" y1="${t.bodyY + r * t.rowH}" y2="${t.bodyY + r * t.rowH}"/>`);
  for (const col of layout.columns) lines.push(`<line x1="${col.x}" x2="${col.x}" y1="${t.y}" y2="${t.bodyY + t.rows * t.rowH}"/>`);
  const box = h('div', { class: 'page-preview' }, h('img', { src: jpeg, alt: '' }));
  box.insertAdjacentHTML('beforeend', `<svg viewBox="0 0 ${layout.width} ${layout.height}" preserveAspectRatio="none">
    <g stroke="#1f6fd1" stroke-width="0.6" stroke-opacity=".75">${lines.join('')}</g></svg>`);
  return box;
}

// ---------- صوّر ورقة ----------
export function renderScan(main) {
  const list = h('div', { class: 'grid', style: 'margin-top:14px' });
  const camera = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true, onchange: (e) => handle(e.target) });
  const files = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, onchange: (e) => handle(e.target) });

  async function handle(input) {
    const chosen = [...input.files];
    input.value = '';
    for (const file of chosen) await one(file);
  }

  async function one(file) {
    const card = h('div', { class: 'card grid scan-card' }, h('div', { class: 'muted' }, 'جاري تجهيز الصورة…'));
    list.prepend(card);
    let r;
    try { r = await photoToPage(file); } catch (ex) { fill(card, h('div', { class: 'issue red' }, ex.message)); return; }
    const { result, jpeg } = r;
    const name = result.qr ? `ورقة ${machineName(result.qr.machine)} رقم ${result.qr.sheetNo}` : 'الورقة';
    const retake = h('button', { class: 'btn', onclick: () => camera.click() }, 'صوّر تاني');
    const upload = async (forced) => {
      fill(card, h('b', {}, name), h('div', { class: 'muted' }, 'جاري الرفع…'));
      try {
        const { sheet } = await post('/api/sheets/photo', uploadBody(result, jpeg, forced));
        fill(card, h('div', { class: 'row', style: 'justify-content:space-between' },
          h('b', {}, `${name} اترفعت ✓`),
          h('a', { class: 'btn primary', href: `#/sheets/${sheet.id}` }, 'راجعها دلوقتي')),
          pagePreview(jpeg, result.layout));
        toast(`${name} اترفعت`);
      } catch (ex) {
        fill(card, h('b', {}, name), h('div', { class: 'issue red' }, ex.message),
          ex.data?.existing_id ? h('a', { class: 'btn', href: `#/sheets/${ex.data.existing_id}` }, 'افتح الورقة اللي اترفعت') : null);
      }
    };
    if (result.ok) return upload(false);
    fill(card,
      h('b', {}, name),
      result.problems.map((p) => h('div', { class: 'issue red' }, p)),
      jpeg ? pagePreview(jpeg, result.layout) : null,
      h('div', { class: 'row' }, retake,
        jpeg ? h('button', { class: 'btn', onclick: () => upload(true) }, 'ارفعها برضه') : null));
  }

  main.replaceChildren(
    h('div', { class: 'top' }, h('h1', {}, 'صوّر ورقة')),
    h('div', { class: 'card grid' },
      h('div', {}, 'حط الورقة على حاجة سادة، وصوّرها من فوق. لازم الأربع مربعات السودا اللي في الأركان يبانوا في الصورة.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary big', onclick: () => camera.click() }, '📷 صوّر بالكاميرا'),
        h('button', { class: 'btn big', onclick: () => files.click() }, 'اختار صور من الجهاز')),
      h('div', { class: 'small muted' }, 'الورقة بتتعدل وبتتقري لوحدها، وبعدين بتروح للمراجعة.')),
    camera, files, list);
}

const machineName = (code) => state.lookups.machines.find((m) => m.code === code)?.name || code;

// ---------- طباعة الورق ----------
export async function renderPrintForms(main) {
  const { machines, missing } = await get('/api/forms');
  const cards = machines.map((m) => {
    const L = formLayout(m.code);
    const count = h('input', { type: 'number', min: 1, max: 100, value: 20, style: 'width:90px' });
    return h('div', { class: 'card grid' },
      h('h2', {}, `ورق ${m.name}`),
      h('div', { class: 'small muted' }, `${L.orientation === 'landscape' ? 'ورقة بالعرض' : 'ورقة بالطول'} · ${L.table.rows} سطر`,
        m.last_printed ? ` · آخر رقم اتطبع ${m.last_printed}` : ' · لسه ما اتطبعش'),
      h('div', { class: 'row' }, h('label', {}, 'عدد الورق'), count,
        h('button', { class: 'btn primary', onclick: async () => {
          const win = window.open('', '_blank'); // opened now, so the browser doesn't block it
          try {
            const r = await post('/api/forms/print', { machine_id: m.id, count: count.value });
            if (win) win.location = r.url; else location.href = r.url;
            toast(`اتحجزت الأرقام من ${r.from} لـ ${r.to}`);
            setTimeout(() => renderPrintForms(main), 500);
          } catch (ex) { win?.close(); toast(ex.message, true); }
        } }, 'اطبع')),
      m.last_printed ? h('a', { class: 'small', href: `/print/forms?machine=${m.code}&from=${Math.max(1, m.last_printed - 19)}&to=${m.last_printed}`, target: '_blank' },
        'اطبع آخر أرقام تاني (لو الطابعة باظت)') : null);
  });
  main.replaceChildren(
    h('div', { class: 'top' }, h('h1', {}, 'طباعة الورق')),
    h('div', { class: 'small muted', style: 'margin-bottom:12px' },
      'كل ورقة ليها رقم وكود خاص بيها، فمينفعش نفس الورقة تتسجل مرتين. في الطباعة اختار الحجم الفعلي (100%).'),
    h('div', { class: 'grid stats' }, cards),
    h('h2', { style: 'margin-top:20px' }, 'ورق اتطبع ولسه ما اترفعش'),
    missing.length === 0
      ? h('div', { class: 'card muted' }, 'مفيش ورق ناقص.')
      : h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['المكنة', 'رقم الورقة', 'اتطبعت', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, missing.map((x) => h('tr', {},
          h('td', {}, x.machine_name), h('td', { class: 'num' }, x.sheet_no), h('td', {}, fmtDate(x.printed_at)),
          h('td', {}, h('button', { class: 'btn sm', onclick: async () => {
            const ok = await formModal({
              title: `ورقة ${x.machine_name} رقم ${x.sheet_no}`, submitLabel: 'شيلها من القايمة',
              fields: [{ name: 'reason', label: 'إيه اللي حصل للورقة؟', placeholder: 'باظت / ضاعت / اتطبعت غلط' }],
              onSubmit: (v) => post('/api/forms/void', { machine_id: x.machine_id, sheet_no: x.sheet_no, reason: v.reason }),
            });
            if (ok) renderPrintForms(main);
          } }, 'الورقة دي باظت أو ضاعت'))))))));
}

