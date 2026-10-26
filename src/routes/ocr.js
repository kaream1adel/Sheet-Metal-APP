// القراءة الآلية: the examples the reader learns from, and how well it reads.
// The reading itself runs in the browser (public/js/ocr.js); the server keeps the
// examples and the record of every read.
import { Router } from 'express';
import { getDb, audit } from '../db.js';
import { requirePerm } from '../auth.js';
import { httpError } from '../util.js';
import { FEATURE_VERSION, NUMBER_FIELDS, NAME_FIELDS } from '../../public/js/ocr.js';
import { LESSON } from './sheets.js';

export const ocr = Router();
const MAX_SAMPLES = 3000;      // per sheet
const MAX_FEATURE = 512;       // bytes

// Sheets the reader may learn from: confirmed, or kept as a lesson, with a photo.
const TEACHING = `s.photo_path IS NOT NULL AND s.no_teach = 0 AND (s.status = 'confirmed' OR (s.status = 'cancelled' AND s.cancel_reason = '${LESSON.replace(/'/g, "''")}'))`;

// Everything the reader knows (current feature version only).
ocr.get('/ocr/model', requirePerm('sheets.create'), (_req, res) => {
  const rows = getDb().prepare(`SELECT o.type, o.field, o.label, o.technician_id, o.features FROM ocr_samples o
    JOIN sheets s ON s.id = o.sheet_id WHERE o.feature_version = ? AND ${TEACHING}`).all(FEATURE_VERSION);
  res.json({ version: FEATURE_VERSION, samples: rows.map((r) => ({ ...r, features: Buffer.from(r.features).toString('base64') })) });
});

// The browser cut a reviewed sheet into examples; they replace that sheet's old ones.
ocr.post('/ocr/samples', requirePerm('sheets.review'), (req, res) => {
  const db = getDb();
  const s = db.prepare(`SELECT s.* FROM sheets s WHERE s.id = ? AND ${TEACHING}`).get(req.body?.sheet_id);
  if (!s) throw httpError(409, 'البرنامج بيتعلم بس من ورق متأكد أو محفوظ كدرس وليه صورة');
  if (Number(req.body?.feature_version) !== FEATURE_VERSION) throw httpError(409, 'نسخة القراءة اتغيرت — حدّث الصفحة');
  const raw = Array.isArray(req.body?.samples) ? req.body.samples : [];
  if (raw.length > MAX_SAMPLES) throw httpError(400, 'الأمثلة كتير قوي');
  const fields = new Set([...NUMBER_FIELDS, ...NAME_FIELDS]);
  const samples = raw.map((x) => {
    const type = ['kind', 'cell', 'digit'].includes(x?.type) ? x.type : null;
    const field = type === 'digit' ? '' : String(x?.field || '');
    const label = String(x?.label ?? '');
    const features = Buffer.from(String(x?.features || ''), 'base64');
    const ok = type && features.length > 0 && features.length <= MAX_FEATURE &&
      (type === 'digit' ? /^[0-9.]$/.test(label)
        : type === 'kind' ? fields.has(field) && ['ditto', 'ink'].includes(label)
          : NAME_FIELDS.includes(field) && /^[a-z0-9]{1,20}$/.test(label));
    if (!ok) throw httpError(400, 'مثال مش سليم');
    return { type, field, label, features };
  });
  db.transaction(() => {
    db.prepare('DELETE FROM ocr_samples WHERE sheet_id = ?').run(s.id);
    const ins = db.prepare('INSERT INTO ocr_samples (sheet_id, technician_id, type, field, label, features, feature_version) VALUES (?,?,?,?,?,?,?)');
    for (const x of samples) ins.run(s.id, s.technician_id, x.type, x.field, x.label, x.features, FEATURE_VERSION);
    audit(req.user.id, 'teach', 'sheet', s.id, undefined, { samples: samples.length });
  })();
  res.status(201).json({ saved: samples.length });
});

// Reviewed photo sheets the reader hasn't learned from yet (e.g. the tab was closed).
ocr.get('/ocr/pending', requirePerm('sheets.review'), (_req, res) => {
  const rows = getDb().prepare(`SELECT s.id FROM sheets s WHERE ${TEACHING}
    AND NOT EXISTS (SELECT 1 FROM ocr_samples o WHERE o.sheet_id = s.id AND o.feature_version = ?) ORDER BY s.id`).all(FEATURE_VERSION);
  res.json({ ids: rows.map((r) => r.id) });
});

// For the admin's القراءة الآلية screen.
ocr.get('/ocr/stats', requirePerm('settings.manage'), (_req, res) => {
  const db = getDb();
  const samples = db.prepare(`SELECT o.type, o.field, o.label, COUNT(*) n FROM ocr_samples o JOIN sheets s ON s.id = o.sheet_id
    WHERE o.feature_version = ? AND ${TEACHING} GROUP BY o.type, o.field, o.label`).all(FEATURE_VERSION);
  const sheets = db.prepare(`SELECT COUNT(DISTINCT o.sheet_id) n FROM ocr_samples o JOIN sheets s ON s.id = o.sheet_id WHERE o.feature_version = ? AND ${TEACHING}`).get(FEATURE_VERSION).n;
  const lessons = db.prepare('SELECT COUNT(*) n FROM sheets WHERE status = \'cancelled\' AND cancel_reason = ?').get(LESSON).n;
  // Accuracy per week and per kind of cell, from confirmed sheets.
  const accuracy = db.prepare(`SELECT strftime('%Y-%W', finalized_at) AS week,
      CASE WHEN kind = 'ditto' THEN 'ditto' WHEN field IN ('client_id','material_id','material_source') THEN field
        WHEN field IN ('part_name','client_text','sheet_size') THEN 'text' WHEN field = 'work_date' THEN 'date' ELSE 'number' END AS what, source,
      COUNT(*) AS reads, SUM(correct) AS correct, SUM(CASE WHEN confidence >= 0.9 THEN 1 ELSE 0 END) AS sure,
      SUM(CASE WHEN confidence >= 0.9 AND correct = 0 THEN 1 ELSE 0 END) AS sure_wrong
    FROM cell_reads WHERE finalized_at IS NOT NULL AND correct IS NOT NULL GROUP BY week, what, source ORDER BY week DESC, source, what`).all();
  const unread = db.prepare(`SELECT COUNT(*) n FROM cell_reads WHERE finalized_at IS NOT NULL AND kind = 'ink'`).get().n;
  res.json({ version: FEATURE_VERSION, sheets, lessons, samples, accuracy, unread });
});

// Sheets the reader learned from, newest first (to find one that taught it wrong).
ocr.get('/ocr/sheets', requirePerm('settings.manage'), (_req, res) => {
  const rows = getDb().prepare(`SELECT s.id, s.sheet_no, s.status, s.confirmed_at, s.cancelled_at, m.name AS machine_name, t.name AS technician_name,
      (SELECT COUNT(*) FROM ocr_samples o WHERE o.sheet_id = s.id) AS samples
    FROM sheets s JOIN machines m ON m.id = s.machine_id LEFT JOIN technicians t ON t.id = s.technician_id
    WHERE ${TEACHING} ORDER BY s.id DESC LIMIT 100`).all();
  res.json({ sheets: rows });
});

// انسى الورقة دي: its examples go, and it is never learned from again.
ocr.post('/ocr/forget', requirePerm('settings.manage'), (req, res) => {
  const db = getDb();
  const s = db.prepare('SELECT id FROM sheets WHERE id = ?').get(req.body?.sheet_id);
  if (!s) throw httpError(404, 'الورقة مش موجودة');
  db.transaction(() => {
    const n = db.prepare('DELETE FROM ocr_samples WHERE sheet_id = ?').run(s.id).changes;
    db.prepare('UPDATE sheets SET no_teach = 1 WHERE id = ?').run(s.id);
    audit(req.user.id, 'forget', 'sheet', s.id, { samples: n }, { no_teach: 1 });
  })();
  res.json({ ok: true });
});
