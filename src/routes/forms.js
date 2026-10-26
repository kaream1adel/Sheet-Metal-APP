// طباعة الورق: numbered paper forms with a QR code per page, and the list of
// printed numbers that never came back. The form drawing itself comes from
// public/js/forms.js, the same layout the photo straightening uses.
import { Router } from 'express';
import QRCode from 'qrcode';
import { getDb, audit } from '../db.js';
import { requirePerm } from '../auth.js';
import { can } from '../permissions.js';
import { getSettings } from '../settings.js';
import { httpError, cleanText, parseNumber } from '../util.js';
import { formLayout, qrText, FORM_VERSION } from '../../public/js/forms.js';

export const forms = Router();
const MAX_PRINT = 100;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Printed numbers not uploaded although a later number of the same machine was:
// that paper is probably lying somewhere with work on it.
export function missingSheets(machineId = null) {
  return getDb().prepare(`
    SELECT p.machine_id, m.name AS machine_name, m.code AS machine_code, p.sheet_no, p.printed_at
    FROM printed_sheets p JOIN machines m ON m.id = p.machine_id
    WHERE p.voided_at IS NULL AND (? IS NULL OR p.machine_id = ?)
      AND NOT EXISTS (SELECT 1 FROM sheets s WHERE s.machine_id = p.machine_id AND s.sheet_no = CAST(p.sheet_no AS TEXT) AND s.status <> 'cancelled')
      AND p.sheet_no < (SELECT MAX(CAST(s.sheet_no AS INTEGER)) FROM sheets s
                        WHERE s.machine_id = p.machine_id AND s.status <> 'cancelled' AND s.sheet_no GLOB '[0-9]*')
    ORDER BY m.sort, p.sheet_no`).all(machineId, machineId);
}

forms.get('/api/forms', requirePerm('sheets.create'), (_req, res) => {
  const db = getDb();
  const machines = db.prepare(`
    SELECT m.id, m.code, m.name,
      (SELECT MAX(sheet_no) FROM printed_sheets p WHERE p.machine_id = m.id) AS last_printed,
      (SELECT COUNT(*) FROM printed_sheets p WHERE p.machine_id = m.id AND p.voided_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM sheets s WHERE s.machine_id = m.id AND s.sheet_no = CAST(p.sheet_no AS TEXT) AND s.status <> 'cancelled')) AS not_uploaded
    FROM machines m WHERE m.active = 1 ORDER BY m.sort`).all()
    .filter((m) => formLayout(m.code));
  res.json({ machines, missing: missingSheets() });
});

// Reserves the next numbers; the print page then draws exactly those.
forms.post('/api/forms/print', requirePerm('sheets.create'), (req, res) => {
  const db = getDb();
  const machine = db.prepare('SELECT * FROM machines WHERE id = ? AND active = 1').get(req.body?.machine_id);
  if (!machine || !formLayout(machine.code)) throw httpError(400, 'اختار المكنة');
  const count = parseNumber(req.body?.count);
  if (!Number.isInteger(count) || count < 1 || count > MAX_PRINT) throw httpError(400, `عدد الورق من 1 لـ ${MAX_PRINT}`);
  const range = db.transaction(() => {
    const last = db.prepare('SELECT COALESCE(MAX(sheet_no), 0) n FROM printed_sheets WHERE machine_id = ?').get(machine.id).n;
    const ins = db.prepare('INSERT INTO printed_sheets (machine_id, sheet_no, form_version, printed_by) VALUES (?,?,?,?)');
    for (let n = last + 1; n <= last + count; n++) ins.run(machine.id, n, FORM_VERSION, req.user.id);
    const r = { from: last + 1, to: last + count };
    audit(req.user.id, 'print', 'printed_sheets', machine.id, undefined, { machine: machine.code, ...r });
    return r;
  })();
  res.status(201).json({ machine_code: machine.code, ...range, url: `/print/forms?machine=${machine.code}&from=${range.from}&to=${range.to}` });
});

// A spoiled or lost paper: stop warning about it (kept, with the reason).
forms.post('/api/forms/void', requirePerm('sheets.create'), (req, res) => {
  const db = getDb();
  const reason = cleanText(req.body?.reason, 200);
  if (!reason) throw httpError(400, 'اكتب السبب');
  const p = db.prepare('SELECT * FROM printed_sheets WHERE machine_id = ? AND sheet_no = ?').get(req.body?.machine_id, req.body?.sheet_no);
  if (!p) throw httpError(404, 'الرقم ده ما اتطبعش');
  if (p.voided_at) throw httpError(409, 'الرقم ده متلغي بالفعل');
  db.transaction(() => {
    db.prepare("UPDATE printed_sheets SET voided_at = datetime('now'), voided_by = ?, void_reason = ? WHERE id = ?").run(req.user.id, reason, p.id);
    audit(req.user.id, 'void', 'printed_sheets', p.id, null, { sheet_no: p.sheet_no, reason });
  })();
  res.json({ ok: true });
});

// ---------- the printable forms ----------
// One SVG per page in millimetres, so what prints is exactly the layout.
async function formSvg(layout, sheetNo, company) {
  const L = layout;
  const t = L.table;
  const qr = (await QRCode.toString(qrText(L.machine, sheetNo, L.version), { type: 'svg', margin: 0, errorCorrectionLevel: 'M' }))
    .replace('<svg ', `<svg x="${L.qr.x}" y="${L.qr.y}" width="${L.qr.size}" height="${L.qr.size}" `);
  const right = t.x + t.width;
  const text = (x, y, size, s, { anchor = 'start', weight = 'normal', fill = '#000' } = {}) =>
    `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" direction="rtl">${esc(s)}</text>`;
  const line = (x1, y1, x2, y2, w = 0.3) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#000" stroke-width="${w}"/>`;
  const parts = [];
  for (const m of L.markers) parts.push(`<rect x="${m.x - L.markerSize / 2}" y="${m.y - L.markerSize / 2}" width="${L.markerSize}" height="${L.markerSize}" fill="#000"/>`);
  parts.push(qr);
  // Header: what this sheet is, then the two things the technician writes once.
  parts.push(text(right, L.qr.y + 6, 7, `ورقة ${L.title}`, { weight: 'bold' }));
  parts.push(text(right, L.qr.y + 13, 5, `رقم ${sheetNo}`, { weight: 'bold' }));
  parts.push(text(right - 75, L.qr.y + 6, 3.6, 'اسم الفني: ..............................'));
  parts.push(text(right - 75, L.qr.y + 13, 3.6, 'التاريخ:  ......... / ......... / ...............'));
  parts.push(text(L.qr.x + L.qr.size + 4, L.qr.y + L.qr.size - 1, 2.6, `${company} · نموذج ${L.version}`, { anchor: 'end', fill: '#555' }));
  // Table
  parts.push(`<rect x="${t.x}" y="${t.y}" width="${t.width}" height="${t.headerH}" fill="#e9eef3"/>`);
  const bottom = t.bodyY + t.rows * t.rowH;
  for (let r = 0; r <= t.rows; r++) parts.push(line(t.x, t.bodyY + r * t.rowH, right, t.bodyY + r * t.rowH, r === 0 ? 0.5 : 0.3));
  parts.push(line(t.x, t.y, right, t.y, 0.5));
  for (const c of L.columns) {
    parts.push(line(c.x, t.y, c.x, bottom, 0.3));
    const size = Math.min(3.3, c.w / 4.2);
    const words = c.label.split(' ');
    if (words.length > 1 && c.w < 22) {
      parts.push(text(c.x + c.w / 2, t.y + 5, size, words[0], { anchor: 'middle', weight: 'bold' }));
      parts.push(text(c.x + c.w / 2, t.y + 9.5, size, words.slice(1).join(' '), { anchor: 'middle', weight: 'bold' }));
    } else {
      parts.push(text(c.x + c.w / 2, t.y + 7.5, size, c.label, { anchor: 'middle', weight: 'bold' }));
    }
  }
  parts.push(line(right, t.y, right, bottom, 0.5));
  parts.push(line(t.x, t.y, t.x, bottom, 0.5));
  const num = L.columns.find((c) => c.field === 'row_no');
  for (let r = 1; r <= t.rows; r++) parts.push(text(num.x + num.w / 2, t.bodyY + (r - 0.5) * t.rowH + 1.3, 3.4, String(r), { anchor: 'middle', fill: '#666' }));
  // Legend and notes
  parts.push(text(right, L.legendY, 3.2, '~ أو // = زي اللي فوق   ·   خط بالعرض = يوم جديد   ·   الأرقام عربي أو إنجليزي'));
  parts.push(`<rect x="${L.notes.x}" y="${L.notes.y}" width="${L.notes.width}" height="${L.notes.height}" fill="none" stroke="#000" stroke-width="0.3"/>`);
  parts.push(text(right - 2, L.notes.y + 5, 3.4, 'ملاحظات (توقف، أعطال، أي حاجة مش في الجدول):', { fill: '#444' }));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${L.width}mm" height="${L.height}mm" viewBox="0 0 ${L.width} ${L.height}" font-family="Segoe UI, Tahoma, Arial, sans-serif">${parts.join('')}</svg>`;
}

forms.get('/print/forms', async (req, res, next) => {
  try {
    if (!req.user) return res.redirect('/');
    if (!can(req.user, 'sheets.create')) return res.status(403).send('مش مسموح لك تفتح الصفحة دي.');
    const db = getDb();
    const machine = db.prepare('SELECT * FROM machines WHERE code = ?').get(String(req.query.machine || ''));
    const from = Number(req.query.from);
    const to = Number(req.query.to);
    if (!machine || !Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to - from >= MAX_PRINT) {
      return res.status(400).send('طلب غلط');
    }
    const printed = db.prepare('SELECT sheet_no, form_version FROM printed_sheets WHERE machine_id = ? AND sheet_no BETWEEN ? AND ? ORDER BY sheet_no')
      .all(machine.id, from, to);
    if (printed.length !== to - from + 1) return res.status(404).send('الأرقام دي ما اتحجزتش للطباعة');
    const company = getSettings().company_name;
    const pages = [];
    for (const p of printed) pages.push(await formSvg(formLayout(machine.code, p.form_version), p.sheet_no, company));
    const L = formLayout(machine.code);
    res.send(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<title>ورق ${esc(L.title)} ${from}–${to}</title>
<style>
  @page { size: A4 ${L.orientation}; margin: 0; }
  body { margin: 0; background: #e5e9ee; font-family: "Segoe UI", Tahoma, Arial, sans-serif; }
  .bar { position: sticky; top: 0; display: flex; gap: 8px; align-items: center; padding: 10px 16px; background: #1f4e79; color: #fff; }
  .bar button { font: inherit; padding: 8px 16px; border: 0; border-radius: 6px; background: #fff; color: #1f4e79; cursor: pointer; }
  .page { width: ${L.width}mm; height: ${L.height}mm; margin: 12px auto; background: #fff; box-shadow: 0 2px 10px rgba(0,0,0,.15); overflow: hidden; }
  .page svg { display: block; }
  @media print { body { background: none; } .bar { display: none; } .page { margin: 0; box-shadow: none; page-break-after: always; } }
</style></head><body>
<div class="bar"><button onclick="window.print()">اطبع</button><span>ورق ${esc(L.title)} من رقم ${from} لـ ${to} (${printed.length} ورقة) — في الطباعة اختار "الحجم الفعلي" (100%)</span></div>
${pages.map((svg) => `<div class="page">${svg}</div>`).join('\n')}
</body></html>`);
  } catch (err) { next(err); }
});
