// Shared pieces of the operations screens: the client list (with fuzzy match and «عميل جديد»),
// open work orders, status pills, the photo viewer with zoom, and the image downscaler.
import { h, fill, icon, button, pill, formModal, confirmModal, toast, fmtDate, num } from '../ui.js';
import { get, post, patch } from '../api.js';
import { foldName, MACHINE_NAMES } from './ops-paper.js';

// ---------- clients ----------
let clientsCache = null;
export async function clients(refresh = false) {
  if (!clientsCache || refresh) clientsCache = (await get('/api/parties', { kind: 'client' })).parties;
  return clientsCache;
}
export const clientsNow = () => clientsCache || [];
export function clientByText(text, list = clientsNow()) {
  const f = foldName(text);
  if (!f) return null;
  return list.find((c) => [c.name, ...(c.aliases || [])].some((n) => foldName(n) === f)) || null;
}
export const clientName = (id) => clientsNow().find((c) => c.id === id)?.name || '';

// «عميل جديد» from a name written on the paper: the parties' similar-name check asks first.
// Resolves to the new client, or null.
export async function createClient(name) {
  return formModal({
    title: 'عميل جديد',
    intro: 'العميل هيتضاف لقايمة العملاء ويتربط بالسطر ده.',
    fields: [
      { name: 'name', label: 'اسم العميل', value: name || '', wide: true },
      { name: 'phone', label: 'التليفون (اختياري)', inputmode: 'tel' },
    ],
    submitLabel: 'ضيف العميل',
    onSubmit: async (v) => {
      const body = { kind: 'client', name: v.name, phone: v.phone };
      let r;
      try {
        r = await post('/api/parties', body);
      } catch (ex) {
        if (ex.status === 409 && ex.data.similar?.length) {
          const names = ex.data.similar.map((s) => s.name).join('، ');
          const ok = await confirmModal('في اسم قريب', `في عميل متسجل باسم قريب: ${names}. لو ده نفس العميل اختاره من القايمة بدل ما تعمل واحد جديد. تكمل وتعمله عميل جديد؟`, 'أيوه، عميل جديد');
          if (!ok) throw new Error('اتلغى — اختار العميل الموجود من الاقتراحات');
          r = await post('/api/parties', { ...body, force: true });
        } else {
          if (ex.status === 409 && ex.data.existing) ex.data.field = 'name';
          throw ex;
        }
      }
      await clients(true);
      return r.party;
    },
  });
}

// The written name becomes another name of the chosen client (so next time it matches).
export async function addAlias(client, alias) {
  const c = clientsNow().find((x) => x.id === client.id) || client;
  const aliases = [...new Set([...(c.aliases || []), alias])];
  await patch(`/api/parties/${c.id}`, { aliases });
  await clients(true);
}

// ---------- work orders ----------
let ordersCache = null;
export async function openOrders(refresh = false) {
  if (!ordersCache || refresh) {
    try { ordersCache = (await get('/api/operations/orders-open')).orders; } catch { ordersCache = []; }
  }
  return ordersCache;
}
export const ordersNow = () => ordersCache || [];

// ---------- words and pills ----------
export const machineName = (m) => MACHINE_NAMES[m] || m;
export function statusPill(view) {
  const kind = { draft: 'neutral', review: 'warn', approved: 'ok', cancelled: 'neutral' }[view] || 'neutral';
  const text = { draft: 'مسودة', review: 'في المراجعة', approved: 'معتمدة', cancelled: 'ملغية' }[view] || view;
  return pill(kind, text);
}
export function countsPills(c) {
  if (!c) return null;
  return h('span', { class: 'ops-counts' },
    c.red ? pill('danger', `${c.red} أحمر`) : null,
    c.unseen ? pill('warn', `${c.unseen} أصفر`) : null,
    !c.red && !c.unseen ? pill('ok', 'جاهزة للاعتماد') : null);
}
export const ORDER_PILL = { open: 'accent', in_progress: 'warn', done: 'ok', delivered: 'neutral', cancelled: 'neutral' };
export const dateText = (iso) => (iso ? fmtDate(iso) : '—');
export const qty = (n, unit = '') => (n === null || n === undefined ? '—' : `${num(n)}${unit ? ` ${unit}` : ''}`);

// ---------- the photo viewer ----------
// Zoom with the buttons (or ctrl + wheel); drag to move. Returns the element.
export function photoViewer(url, { title = 'صورة الورقة' } = {}) {
  if (!url) {
    return h('div', { class: 'ops-photo' }, h('div', { class: 'bar' }, icon('image', 'sm'), h('b', {}, title)),
      h('div', { class: 'none' }, 'الورقة دي ملهاش صورة.'));
  }
  let z = 1;
  const img = h('img', { src: url, alt: title, draggable: 'false' });
  const view = h('div', { class: 'view' }, img);
  const set = (nz) => {
    const box = view.getBoundingClientRect();
    const cx = (view.scrollLeft + box.width / 2) / (z || 1);
    const cy = (view.scrollTop + box.height / 2) / (z || 1);
    z = Math.max(1, Math.min(5, nz));
    view.style.setProperty('--z', z);
    requestAnimationFrame(() => { view.scrollLeft = cx * z - box.width / 2; view.scrollTop = cy * z - box.height / 2; });
    level.textContent = `${Math.round(z * 100)}%`;
  };
  const level = h('span', { class: 'small muted num' }, '100%');
  view.addEventListener('wheel', (e) => { if (e.ctrlKey) { e.preventDefault(); set(z * (e.deltaY < 0 ? 1.15 : 0.87)); } }, { passive: false });
  let drag = null;
  view.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') return; drag = { x: e.clientX, y: e.clientY, l: view.scrollLeft, t: view.scrollTop }; view.style.cursor = 'grabbing'; });
  window.addEventListener('pointermove', (e) => { if (drag) { view.scrollLeft = drag.l - (e.clientX - drag.x); view.scrollTop = drag.t - (e.clientY - drag.y); } });
  window.addEventListener('pointerup', () => { drag = null; view.style.cursor = ''; });
  img.addEventListener('dblclick', () => set(z > 1 ? 1 : 2.5));
  const zb = (ic, label, fn) => h('button', { class: 'icon-btn', type: 'button', title: label, 'aria-label': label, onclick: fn }, icon(ic, 'sm'));
  return h('div', { class: 'ops-photo' },
    h('div', { class: 'bar' }, icon('image', 'sm'), h('b', {}, title), level,
      zb('magnifying-glass-minus', 'صغّر', () => set(z / 1.3)),
      zb('magnifying-glass-plus', 'كبّر', () => set(z * 1.3)),
      zb('arrows-clockwise', 'رجّعها لحجمها', () => set(1)),
      h('a', { class: 'icon-btn', href: url, target: '_blank', rel: 'noopener', title: 'افتحها لوحدها', 'aria-label': 'افتح الصورة لوحدها' }, icon('arrow-square-out', 'sm'))),
    view);
}

// ---------- photos from the phone camera ----------
// Any image file → a JPEG data URL, longest side ≤ 2400 px and ≤ ~4.5 MB (the reader's limit
// is 5 MB). Orientation from the camera is respected by the browser when drawing.
const MAX_SIDE = 2400;
const MAX_DATA_URL = 6_000_000;
export async function fileToJpeg(file) {
  const bmp = await loadImage(file);
  const w0 = bmp.width;
  const h0 = bmp.height;
  if (!w0 || !h0) throw new Error('الملف ده مش صورة');
  let side = MAX_SIDE;
  for (let attempt = 0; attempt < 5; attempt++) {
    const s = Math.min(1, side / Math.max(w0, h0));
    const c = document.createElement('canvas');
    c.width = Math.round(w0 * s);
    c.height = Math.round(h0 * s);
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(bmp, 0, 0, c.width, c.height);
    for (const q of [0.85, 0.75, 0.65]) {
      const url = c.toDataURL('image/jpeg', q);
      if (url.length <= MAX_DATA_URL) return { url, width: c.width, height: c.height };
    }
    side = Math.round(side * 0.8);
  }
  throw new Error('الصورة كبيرة قوي — صوّرها تاني');
}
async function loadImage(file) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* fall back */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
}

// A select of machines; withEmpty: the first option says what empty means.
export function machineSelect(value, withEmpty = null, attrs = {}) {
  return h('select', attrs,
    withEmpty !== null ? h('option', { value: '' }, withEmpty) : null,
    Object.entries(MACHINE_NAMES).map(([k, v]) => h('option', { value: k, selected: k === value }, v)));
}
export function technicianSelect(list, value, withEmpty = 'من غير فني', attrs = {}) {
  return h('select', attrs, h('option', { value: '' }, withEmpty),
    list.map((t) => h('option', { value: t.id, selected: String(t.id) === String(value ?? '') }, t.name)));
}

// «فني جديد» from the entry screens (operations.record may add technicians).
export async function createTechnician(machine) {
  return formModal({
    title: 'فني جديد', submitLabel: 'ضيف الفني',
    fields: [{ name: 'name', label: 'اسم الفني', wide: true }],
    onSubmit: async (v) => {
      const r = await post('/api/technicians', { name: v.name, machine: machine || null });
      toast(`اتضاف ${r.technician.name}`);
      return r.technician;
    },
  });
}

export { fill };
