// The printed paper forms, in millimetres. One description serves three jobs:
// printing the form (src/routes/print.js), straightening a photo of it (vision.js)
// and cutting the photo into rows and cells (review screen now, OCR later).
// Pure data + math: imported by the browser and by Node.
//
// NEVER change a shipped layout: photos already taken use it. Add FORM_VERSION + 1
// (the QR says which version a sheet was printed with).

export const FORM_VERSION = 1;
export const PX_PER_MM = 5; // resolution of a straightened photo

const A4 = { portrait: { width: 210, height: 297 }, landscape: { width: 297, height: 210 } };

// Paper columns, right to left as written. weight = relative width.
const COMMON_START = [
  { field: 'row_no', label: 'م', weight: 7 },
  { field: 'client_id', label: 'العميل', weight: 34 },
  { field: 'part_name', label: 'اسم القطعة', weight: 26 },
  { field: 'material_id', label: 'الخامة', weight: 17 },
  { field: 'thickness', label: 'السمك', weight: 12 },
];
const COMMON_END = [
  { field: 'work_date', label: 'التاريخ', weight: 17 },
  { field: 'material_source', label: 'الخامة من', weight: 14 },
];

const MACHINES = {
  press: {
    title: 'التناية', orientation: 'portrait', rows: 12,
    columns: [
      { field: 'pieces', label: 'عدد القطع', weight: 15 },
      { field: 'ops_per_piece', label: 'تنيات للقطعة', weight: 15 },
      { field: 'total_written', label: 'إجمالي التنيات', weight: 17 },
    ],
  },
  shear: {
    title: 'المقص', orientation: 'portrait', rows: 12,
    columns: [
      { field: 'pieces', label: 'عدد القطع', weight: 15 },
      { field: 'ops_per_piece', label: 'قصات للقطعة', weight: 15 },
      { field: 'total_written', label: 'إجمالي القصات', weight: 17 },
    ],
  },
  laser: {
    title: 'الليزر', orientation: 'portrait', rows: 12,
    columns: [
      { field: 'sheets', label: 'عدد الألواح', weight: 18 },
      { field: 'minutes_per_sheet', label: 'دقائق للوح', weight: 18 },
    ],
  },
  punch: {
    title: 'البنش', orientation: 'landscape', rows: 10,
    columns: [
      { field: 'sheets', label: 'عدد الألواح', weight: 14 },
      { field: 'sheet_size', label: 'مقاس اللوح', weight: 22 },
      { field: 'pieces_per_sheet', label: 'قطع من اللوح', weight: 14 },
      { field: 'pieces', label: 'إجمالي القطع', weight: 14 },
      { field: 'hits_per_piece', label: 'ضربات للقطعة', weight: 14 },
      { field: 'louvers_per_piece', label: 'لوفر للقطعة', weight: 14 },
      { field: 'minutes', label: 'دقائق', weight: 13 },
    ],
  },
};

export const FORM_MACHINES = Object.keys(MACHINES);

const MARKER = 8;          // solid black corner squares, mm
const MARKER_INSET = 8;    // from the paper edge to the square's outer edge
const QR = 20;             // QR code size, mm
const MARGIN = 16;         // table side margins

const cache = new Map();

// Everything about one machine's form. x grows to the right, y grows down (mm, page coordinates).
export function formLayout(machineCode, version = FORM_VERSION) {
  const key = `${machineCode}:${version}`;
  if (cache.has(key)) return cache.get(key);
  const m = MACHINES[machineCode];
  if (!m || version !== FORM_VERSION) return null;
  const { width, height } = A4[m.orientation];
  const c = MARKER_INSET + MARKER / 2;
  // Order: top-left, top-right, bottom-right, bottom-left (clockwise).
  const markers = [{ x: c, y: c }, { x: width - c, y: c }, { x: width - c, y: height - c }, { x: c, y: height - c }];

  const landscape = m.orientation === 'landscape';
  const top = 20;
  const qr = { x: MARGIN + 4, y: top, size: QR };
  const tableY = top + QR + 4;
  const headerH = 12;
  const rowH = landscape ? 11 : 14.5;
  const tableW = width - 2 * MARGIN;
  const cols = [...COMMON_START, ...m.columns, ...COMMON_END];
  const total = cols.reduce((s, x) => s + x.weight, 0);
  // Right to left: the first column touches the right edge.
  let right = width - MARGIN;
  const columns = cols.map((col) => {
    const w = (col.weight / total) * tableW;
    right -= w;
    return { field: col.field, label: col.label, x: right, w };
  });
  const table = { x: MARGIN, y: tableY, width: tableW, headerH, rowH, rows: m.rows, bodyY: tableY + headerH };
  const tableBottom = table.bodyY + m.rows * rowH;
  const layout = {
    machine: machineCode, version, title: m.title, orientation: m.orientation, width, height,
    markers, markerSize: MARKER, qr, table, columns,
    notes: { x: MARGIN, y: tableBottom + 9, width: tableW, height: Math.max(10, height - MARKER_INSET - MARKER - 3 - (tableBottom + 9)) },
    legendY: tableBottom + 5,
  };
  cache.set(key, layout);
  return layout;
}

// Rectangles in mm.
export function rowRect(layout, row) { // row: 1-based paper row
  const t = layout.table;
  return { x: t.x, y: t.bodyY + (row - 1) * t.rowH, w: t.width, h: t.rowH };
}
export function cellRect(layout, row, field) {
  const col = layout.columns.find((c) => c.field === field);
  const r = rowRect(layout, row);
  return col ? { x: col.x, y: r.y, w: col.w, h: r.h } : null;
}

// What the QR code on each sheet says: "SM<version>:<machine>:<number>".
export const qrText = (machineCode, sheetNo, version = FORM_VERSION) => `SM${version}:${machineCode}:${sheetNo}`;
export function parseQr(text) {
  const m = /^SM(\d+):([a-z]+):(\d{1,7})$/.exec(String(text || '').trim());
  if (!m || !MACHINES[m[2]]) return null;
  return { version: Number(m[1]), machine: m[2], sheetNo: Number(m[3]) };
}
