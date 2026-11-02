// القراءة الآلية (optional, needs internet): a photo of a technician's paper goes to Claude,
// which returns the table as strict JSON (structured output). Clients and materials are
// matched against the app's own lists (closed set), never invented. The result becomes the
// lines of an op_sheet in review; anything the reader is unsure of stays yellow until a
// person looks (lineIssues 'ai_unsure'). The API key is read here, on the server, and is
// never sent to a browser. Ported from the first version (git show fd5faa1:src/ai.js).
import fs from 'fs';
import { join } from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { getDb } from './db.js';
import { dataDir } from './paths.js';
import { getSettings } from './settings.js';
import { httpError, todayISO } from './util.js';
import * as P from '../public/js/modules/ops-paper.js';

// $ per million tokens (input, output, cache read), for the cost log.
export const AI_MODELS = {
  'claude-opus-5-5': { name: 'Claude Opus 5.5 (الأدق)', input: 4, output: 20, cacheRead: 0.2 },
  'claude-sonnet-5': { name: 'Claude Sonnet 5 (أرخص)', input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-5-5': { name: 'Claude Sonnet 5.5 (أرخص)', input: 2, output: 10, cacheRead: 0.2 },
};
export const DEFAULT_AI_MODEL = 'claude-opus-5-5';

// What the reader returns per row (the paper's fields).
const NUMBERS = ['thickness', 'pieces', 'ops_per_piece', 'total_written', 'sheets', 'minutes_per_sheet',
  'pieces_per_sheet', 'hits_per_piece', 'louvers_per_piece'];
const TEXTS = ['sheet_size', 'start_time', 'end_time'];
const DITTO_ABLE = ['client_id', 'part_name', 'material_id', 'work_date', 'material_source', ...NUMBERS, ...TEXTS];
// reader field → op_lines field
const TO_LINE = { client_id: 'client_text', material_id: 'material_text', ops_per_piece: 'per_piece' };
const MACHINE_FIELDS = {
  press: ['pieces', 'ops_per_piece', 'total_written'],
  shear: ['pieces', 'ops_per_piece', 'total_written'],
  laser: ['sheets', 'minutes_per_sheet', 'start_time', 'end_time'],
  punch: ['sheets', 'minutes_per_sheet', 'start_time', 'end_time', 'sheet_size', 'pieces_per_sheet', 'pieces', 'hits_per_piece', 'louvers_per_piece'],
};

const nullable = (type) => ({ anyOf: [{ type }, { type: 'null' }] });

// What Claude must return. Every field is always present (null when not written).
export const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['machine', 'sheet_date', 'technician_name', 'rows', 'notes'],
  properties: {
    machine: { type: 'string', enum: ['press', 'shear', 'laser', 'punch', 'unknown'] },
    sheet_date: nullable('string'),
    technician_name: nullable('string'),
    notes: nullable('string'),
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['row', 'client_written', 'client_id', 'part_name', 'material_written', 'material_id', ...NUMBERS, ...TEXTS,
          'work_date', 'material_source', 'ditto_fields', 'confidence', 'uncertain_fields'],
        properties: {
          row: { type: 'integer' },
          client_written: nullable('string'),
          client_id: nullable('integer'),
          part_name: nullable('string'),
          material_written: nullable('string'),
          material_id: nullable('integer'),
          ...Object.fromEntries(NUMBERS.map((f) => [f, nullable('number')])),
          ...Object.fromEntries(TEXTS.map((f) => [f, nullable('string')])),
          work_date: nullable('string'),
          material_source: { anyOf: [{ type: 'string', enum: ['client', 'factory'] }, { type: 'null' }] },
          ditto_fields: { type: 'array', items: { type: 'string', enum: DITTO_ABLE } },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          uncertain_fields: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

// Stable instructions (cached): the old paper's RULES. Today's date and the photo go in the user turn.
export const RULES = `You read photos of handwritten daily machine sheets from an Egyptian sheet-metal workshop and return the table as JSON.

Read every row that has writing; skip empty rows. "row" is the printed row number (the م column) when the paper has one, otherwise the order from the top starting at 1.

Tell the machine from the title at the top ("التناية – سجل التشغيل اليومي", "المقص …", "الليزر …", "البنش …") and from the column headings. Use "unknown" only when neither shows it.

The paper looks like this:
- Header line: التاريخ, اسم المشغل (the technician), أمر الشغل, الوردية — often left empty, or used for the day name.
- Press brake and shear columns, right to left: م | اسم القطعة | العميل | الخامة | السمك | عدد القطع | عدد التنيات (or القصات) / قطعة | إجمالي التنيات (or القصات) | التاريخ | المراجعة.
- Laser and punch columns: م | اسم القطعة | العميل | الخامة | السمك | الكمية | وقت البداية | وقت النهاية | التاريخ | المراجعة. الكمية is the number of sheets. Technicians usually write the minutes in وقت البداية (for example "٧ دقيقة"): that is minutes_per_sheet. When real clock times are written in both وقت البداية and وقت النهاية (for example 8:30 and 9:10), put them in start_time / end_time as H:MM and leave minutes_per_sheet null.
- The المراجعة column is often used for "خامة العميل" / "خامة المصنع" (material_source client / factory), or holds a ditto mark.
- The thickness and the material are sometimes written together in one cell ("١٫٥م اسود", "AL ٢م"): split them.
- The punch technician sometimes ignores the columns and writes sentences across the table, for example "تم عمل عدد ٣٧ لوح صاج مجلفن ١م مقاس 2500X1250 ترى ١٠×١٠×١٠ بيطلع عدد ٤ قطع … ١٤٨ = ٤×٣٧ قطعة". Turn each such job into one row: sheets 37, material مجلفن, thickness 1, sheet_size "2500x1250", pieces_per_sheet 4, pieces 148, part_name "ترى ١٠×١٠×١٠". Put meters and other worked-out amounts in notes, not in the row. A day name or date written between jobs is the work_date of the jobs under it.
- Louvers (لوفر) are written on the punch sheet: louvers_per_piece is the number of louvers in one piece, pieces the number of pieces.

Machines and their columns:
- press (التناية): pieces = عدد القطع, ops_per_piece = تنيات للقطعة, total_written = إجمالي التنيات
- shear (المقص): pieces = عدد القطع, ops_per_piece = قصات للقطعة, total_written = إجمالي القصات
- laser (الليزر): sheets = عدد الألواح, minutes_per_sheet = دقائق للوح (or start_time / end_time)
- punch (البنش): sheets = عدد الألواح, minutes_per_sheet = دقائق للوح (or start_time / end_time), sheet_size = مقاس اللوح (text like "2500x1250"), pieces_per_sheet = قطع من اللوح, pieces = إجمالي القطع, hits_per_piece = ضربات للقطعة, louvers_per_piece = لوفر للقطعة
Every machine also has: client (العميل), part_name (اسم القطعة, optional), material (الخامة), thickness in mm (السمك), work_date (التاريخ), material_source (المراجعة: "خامة العميل" / "عميل" = client, "خامة المصنع" / "مصنع" = factory).
Fields that do not belong to the machine are null.

How the technicians write:
- Digits may be Arabic-Indic (٠١٢٣٤٥٦٧٨٩) or Western; return numbers as plain numbers. The Arabic zero ٠ is a small dot. ٫ or , between digits is a decimal point.
- Thickness may carry a trailing "م" (mm): "١٫٥م" is 1.5.
- "~", "//", "〃" or a short squiggle in a cell means "same as the row above": put that field in ditto_fields and set the field itself to null. Do not copy the value yourself.
- A horizontal line drawn across the table starts a new day.
- Copy the totals exactly as the technician wrote them, even if the arithmetic is wrong. Never compute a missing value.
- Dates: return YYYY-MM-DD. If the year is missing use the year of today's date given with the photo; a day/month like "٢٠/١٠" is 20 October.

Clients and materials are a closed set: pick client_id / material_id from the lists below when the written name is the same client or material (spelling variants, missing "ال", typos, nicknames that clearly match). If no listed name matches, set the id to null and keep what is written in client_written / material_written. Never guess an id for a name you can't read.

Confidence per row: "high" only when every filled cell is clearly legible; otherwise "medium" or "low", and list the unclear fields in uncertain_fields (use the field names above). Do not invent rows, values or names. Put anything written outside the table (stops, breakdowns) in notes.`;

function listsBlock() {
  const db = getDb();
  const clients = db.prepare("SELECT id, name, aliases FROM parties WHERE kind = 'client' AND active = 1 ORDER BY id").all();
  const materials = db.prepare('SELECT id, name, aliases FROM materials WHERE active = 1 ORDER BY id').all();
  const techs = db.prepare('SELECT name FROM technicians WHERE active = 1 ORDER BY id').all();
  const al = (s) => { try { const a = JSON.parse(s || '[]'); return a.length ? ` / ${a.join(' / ')}` : ''; } catch { return ''; } };
  return [
    'Clients (id: name / other spellings):', ...clients.map((c) => `${c.id}: ${c.name}${al(c.aliases)}`), clients.length ? '' : '(none yet)',
    'Materials (id: name / other spellings):', ...materials.map((m) => `${m.id}: ${m.name}${al(m.aliases)}`),
    '',
    `Technicians: ${techs.map((t) => t.name).join('، ') || '(none yet)'}`,
  ].join('\n');
}

// ---------- settings + status ----------
export function aiStatus() {
  const s = getSettings();
  const model = s.ai_model && /^claude-/.test(s.ai_model) ? s.ai_model : DEFAULT_AI_MODEL;
  return { enabled: !!s.ai_enabled && !!s.ai_api_key, configured: !!s.ai_api_key, model };
}

export function aiUsage() {
  const db = getDb();
  const month = todayISO().slice(0, 7);
  const row = db.prepare('SELECT COUNT(*) AS reads, COALESCE(SUM(cost_micro_usd), 0) AS c FROM ai_usage WHERE substr(at, 1, 7) = ?').get(month);
  return { month, month_reads: row.reads, month_usd: row.c / 1e6 };
}

// Tests point this at a fake API. The SDK retries only a dropped connection, once; a busy
// service is retried later by the photo job instead of inside one long wait.
const client = (apiKey) => new Anthropic({ apiKey, baseURL: process.env.SHEETMETAL_AI_BASE_URL || undefined, timeout: 10 * 60 * 1000, maxRetries: 1 });
const READ_DEADLINE_MS = 8 * 60 * 1000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // the API's limit for one image

/**
 * Reads one sheet photo. Returns { result, usage } where result follows SCHEMA.
 * hint: { machine (code or null), jobId }.
 * Errors are Arabic httpErrors; err.retry = true when trying again later makes sense.
 */
export async function readSheetPhoto(photoPath, hint = {}) {
  const s = getSettings();
  const status = aiStatus();
  if (!status.enabled) throw httpError(409, 'القراءة الآلية مش متفعلة');
  const file = join(dataDir(), photoPath);
  if (!fs.existsSync(file)) throw httpError(404, 'ملف الصورة مش موجود');
  const bytes = fs.readFileSync(file);
  if (bytes.length > MAX_IMAGE_BYTES) throw httpError(422, 'الصورة كبيرة قوي على القراءة — صوّرها تاني');
  const intro = [
    `Today's date: ${todayISO()}.`,
    hint.machine ? `This sheet is for the ${hint.machine} machine.` : 'The machine is not known: tell it from the title and columns.',
    'Read the sheet.',
  ].join(' ');

  const retry = (err) => Object.assign(err, { retry: true });
  const params = {
    model: status.model,
    max_tokens: 32000,
    // Handwriting is hard: "high" makes the model look twice at unclear digits and names.
    output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA } },
    system: [
      { type: 'text', text: RULES, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: listsBlock(), cache_control: { type: 'ephemeral' } },
    ],
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: bytes.toString('base64') } },
        { type: 'text', text: intro },
      ],
    }],
  };

  let message;
  try {
    const stream = client(s.ai_api_key).messages.stream(params, { signal: AbortSignal.timeout(READ_DEADLINE_MS) });
    message = await stream.finalMessage();
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      throw httpError(502, 'مفتاح القراءة الآلية غلط أو موقوف — الأدمن يراجعه في الإعدادات');
    }
    if (err instanceof Anthropic.BadRequestError) throw httpError(422, 'خدمة القراءة مقبلتش الصورة دي — صوّرها تاني أو اكتبها بإيدك');
    if (err instanceof Anthropic.RateLimitError) throw retry(httpError(503, 'خدمة القراءة مشغولة دلوقتي'));
    if (err instanceof Anthropic.APIUserAbortError || err?.name === 'AbortError' || err?.name === 'TimeoutError') {
      throw retry(httpError(504, 'القراءة خدت وقت أطول من اللازم'));
    }
    if (err instanceof Anthropic.APIConnectionError) throw retry(httpError(503, 'مفيش نت أو خدمة القراءة مش بترد'));
    if (err instanceof Anthropic.APIError) throw retry(httpError(502, `خدمة القراءة رجعت خطأ (${err.status ?? '—'})`));
    throw retry(httpError(502, 'حصلت مشكلة في الاتصال بخدمة القراءة'));
  }
  // Every answer is paid for, so it is logged before anything else can fail.
  const usage = recordUsage(message, hint.jobId);
  if (message.stop_reason === 'refusal') throw httpError(422, 'خدمة القراءة رفضت الصورة دي — اكتبها بإيدك');
  if (message.stop_reason === 'max_tokens') throw retry(httpError(502, 'القراءة ما كملتش'));
  const text = (message.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  let result;
  try { result = JSON.parse(text); } catch { throw retry(httpError(502, 'رد القراءة مش مفهوم')); }
  if (!result || typeof result !== 'object' || !Array.isArray(result.rows)) throw retry(httpError(502, 'رد القراءة مش مفهوم'));
  return { result, usage };
}

const PRICE_UNKNOWN = { input: 5, output: 25, cacheRead: 0.5 }; // the dearest price, an estimate
function recordUsage(message, jobId) {
  const u = message.usage || {};
  const attempts = Array.isArray(u.iterations) && u.iterations.length ? u.iterations : [u];
  let cost = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  for (const a of attempts) {
    const price = AI_MODELS[a.model || message.model] || PRICE_UNKNOWN;
    const inTok = (a.input_tokens || 0) + (a.cache_creation_input_tokens || 0) * 1.25;
    cost += inTok * price.input + (a.cache_read_input_tokens || 0) * price.cacheRead + (a.output_tokens || 0) * price.output;
    input += a.input_tokens || 0;
    output += a.output_tokens || 0;
    cacheRead += a.cache_read_input_tokens || 0;
  }
  const r = getDb().prepare('INSERT INTO ai_usage (job_id, model, input_tokens, output_tokens, cache_read_tokens, cost_micro_usd) VALUES (?,?,?,?,?,?)')
    .run(jobId ?? null, message.model || 'unknown', input, output, cacheRead, Math.round(cost));
  return { id: Number(r.lastInsertRowid), model: message.model };
}

// ---------- the reader's answer → op_lines ----------
const CONF = { high: 0.95, medium: 0.75, low: 0.45 };
const UNPROVEN = 0.85; // "sure" on a field whose readings have no track record yet
// Fields that decide money: the model's own "sure" counts only once its readings of that
// field have proven right after review (or the technician's own total agrees).
const GATED = new Set(['client_text', 'material_text', 'thickness', 'pieces', 'per_piece', 'total_written', 'sheets',
  'minutes_per_sheet', 'start_time', 'end_time', 'louvers_per_piece', 'pieces_per_sheet', 'hits_per_piece', 'material_source']);

export function provenFields() {
  const rows = getDb().prepare(`SELECT field, COUNT(*) AS n, SUM(CASE WHEN correct = 0 THEN 1 ELSE 0 END) AS wrong
    FROM ai_reads WHERE confidence >= ${P.SURE} GROUP BY field`).all();
  return new Set(rows.filter((r) => r.n >= 150 && r.wrong / r.n <= 0.01).map((r) => r.field));
}

// The reader's rows as raw lines for normalizeLines (trusted: they carry read_json, the
// confidence per line field). Rows are numbered by their order (free paper repeats numbers).
export function toLines(result, machine) {
  const db = getDb();
  const clientName = db.prepare("SELECT name FROM parties WHERE id = ? AND kind = 'client'");
  const matName = db.prepare('SELECT name FROM materials WHERE id = ?');
  const own = new Set(MACHINE_FIELDS[machine] || []);
  const proven = provenFields();
  const rows = (result.rows || []).filter((r) => r && typeof r === 'object').slice(0, 200);
  return rows.map((row) => {
    const base = CONF[row.confidence] ?? 0.45;
    const unsure = new Set((row.uncertain_fields || []).map((f) => TO_LINE[f] || (f === 'client' ? 'client_text' : f === 'material' ? 'material_text' : f)));
    const has = (...f) => f.every((k) => typeof row[k] === 'number');
    const agrees = new Set();
    const disagrees = new Set();
    if ((machine === 'press' || machine === 'shear') && has('pieces', 'ops_per_piece', 'total_written')) {
      const ok = Math.abs(row.pieces * row.ops_per_piece - row.total_written) < 1e-6;
      for (const f of ['pieces', 'per_piece', 'total_written']) (ok ? agrees : disagrees).add(f);
    }
    if (machine === 'punch' && has('sheets', 'pieces_per_sheet', 'pieces')) {
      const ok = Math.abs(row.sheets * row.pieces_per_sheet - row.pieces) < 1e-6;
      for (const f of ['sheets', 'pieces_per_sheet', 'pieces']) (ok ? agrees : disagrees).add(f);
    }
    const conf = (f) => {
      let c = unsure.has(f) ? Math.min(base, 0.5) : base;
      if (disagrees.has(f)) c = Math.min(c, 0.6);
      else if (c >= P.SURE && GATED.has(f) && !proven.has(f) && !agrees.has(f)) c = UNPROVEN;
      return Math.round(c * 100) / 100;
    };
    const line = { ditto_fields: [], notes: '' };
    const fields = {};
    const ditto = new Set((row.ditto_fields || []).map((f) => TO_LINE[f] || f));
    // client: matched id → the official name; else what is written (red until chosen)
    const cName = row.client_id ? clientName.get(row.client_id)?.name : null;
    if (cName) {
      line.client_id = row.client_id;
      line.client_text = cName;
      const w = P.foldName(row.client_written);
      const g = P.foldName(cName);
      const same = !w || g === w || g.includes(w) || w.includes(g);
      fields.client_text = { v: row.client_id, c: same ? conf('client_text') : Math.min(conf('client_text'), 0.75), w: row.client_written ?? null };
    } else if (row.client_written) {
      line.client_text = String(row.client_written).slice(0, 80);
      fields.client_text = { v: null, c: 0.5, w: line.client_text };
    }
    const mName = row.material_id ? matName.get(row.material_id)?.name : null;
    if (mName) {
      line.material_id = row.material_id;
      line.material_text = row.material_written ? String(row.material_written).slice(0, 60) : mName;
      fields.material_text = { v: row.material_id, c: conf('material_text') };
    } else if (row.material_written) {
      line.material_text = String(row.material_written).slice(0, 60);
    }
    if (row.part_name) line.part_name = String(row.part_name).slice(0, 120);
    if (row.work_date) { line.work_date = row.work_date; fields.work_date = { v: row.work_date, c: conf('work_date') }; }
    if (row.material_source) { line.material_source = row.material_source; fields.material_source = { v: row.material_source, c: conf('material_source') }; }
    for (const f of [...NUMBERS, ...TEXTS]) {
      const lf = TO_LINE[f] || f;
      if (f !== 'thickness' && !own.has(f)) continue;
      const v = row[f];
      if (v === null || v === undefined || v === '') continue;
      if (NUMBERS.includes(f) && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) continue;
      if (f === 'thickness' && v === 0) continue;
      line[lf] = NUMBERS.includes(f) ? v : String(v).slice(0, 40);
      fields[lf] = { v: line[lf], c: conf(lf) };
    }
    for (const f of ditto) {
      if (!P.DITTO_FIELDS.includes(f)) continue;
      line.ditto_fields.push(f);
      fields[f] = { v: null, c: conf(f), ditto: true };
    }
    line.read_json = { fields, confidence: row.confidence || null };
    return line;
  });
}

// After normalizeLines resolved ditto and matching, the reading's values are the line's
// values (so «nobody changed it» compares like with like).
export function settleReads(lines) {
  for (const l of lines) {
    const f = l.read_json?.fields;
    if (!f) continue;
    for (const [k, r] of Object.entries(f)) {
      if (k === 'client_text') r.v = l.client_id ?? null;
      else if (k === 'material_text') r.v = l.material_id ?? null;
      else if (r.ditto) r.v = l[k] ?? null;
    }
  }
  return lines;
}

// The technician named on the sheet, if he is one of ours.
export function matchTechnician(name) {
  if (!name) return null;
  const w = P.foldName(name);
  if (!w) return null;
  const t = getDb().prepare('SELECT id, name FROM technicians WHERE active = 1').all()
    .find((x) => { const g = P.foldName(x.name); return g === w || g.includes(w) || w.includes(g); });
  return t?.id ?? null;
}
