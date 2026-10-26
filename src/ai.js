// قراءة بالذكاء الاصطناعي (optional, needs internet): a photo of a technician's sheet —
// a printed form or the plain paper they already use — goes to Claude, which returns
// the table as strict JSON. Clients and materials are matched against the app's own
// lists (closed set), never invented. The result becomes ordinary reads: they fill
// empty cells only, and anything unsure stays yellow until a person looks (same gate
// as the offline reader). Only the admin's API key leaves this file; it is never
// sent to a browser.
import fs from 'fs';
import { join } from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { betaJSONSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/beta/json-schema';
import { getDb } from './db.js';
import { dataDir } from './paths.js';
import { getSettings } from './settings.js';
import { MACHINE_FIELDS } from './sheets.js';
import { httpError, todayISO } from './util.js';

// Choices shown in الإعدادات. $ per million tokens (input, output, cache read).
export const AI_MODELS = {
  'claude-opus-5-5': { name: 'Claude Opus 5.5 (الأدق)', input: 4, output: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { name: 'Claude Sonnet 5.5 (أرخص)', input: 2, output: 10, cacheRead: 0.2 },
  'claude-haiku-5-5': { name: 'Claude Haiku 5.5 (الأرخص)', input: 0.1, output: 0.5, cacheRead: 0.01 },
};
export const DEFAULT_AI_MODEL = 'claude-opus-5-5';

const NUMBERS = ['thickness', 'pieces', 'ops_per_piece', 'total_written', 'sheets', 'minutes_per_sheet',
  'pieces_per_sheet', 'hits_per_piece', 'louvers_per_piece', 'minutes'];
const DITTO_ABLE = ['client_id', 'part_name', 'material_id', 'thickness', 'work_date', 'material_source', ...NUMBERS, 'sheet_size'];

const nullable = (type) => ({ anyOf: [{ type }, { type: 'null' }] });

// What Claude must return. Every field is always present (null when not written).
const SCHEMA = {
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
        required: ['row', 'client_written', 'client_id', 'part_name', 'material_written', 'material_id', ...NUMBERS,
          'sheet_size', 'work_date', 'material_source', 'ditto_fields', 'confidence', 'uncertain_fields'],
        properties: {
          row: { type: 'integer' },
          client_written: nullable('string'),
          client_id: nullable('integer'),
          part_name: nullable('string'),
          material_written: nullable('string'),
          material_id: nullable('integer'),
          ...Object.fromEntries(NUMBERS.map((f) => [f, nullable('number')])),
          sheet_size: nullable('string'),
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

// Stable instructions (cached). Today's date and the photo go in the user turn.
const RULES = `You read photos of handwritten daily machine sheets from an Egyptian sheet-metal workshop and return the table as JSON.

The sheet is either the workshop's printed form (title "ورقة التناية / المقص / الليزر / البنش", a QR code, numbered rows) or the plain paper the technicians used before. Read every row that has writing; skip empty rows. "row" is the printed row number when the form has one, otherwise the order from the top starting at 1.

Machines and their columns:
- press (التناية): pieces = عدد القطع, ops_per_piece = تنيات للقطعة, total_written = إجمالي التنيات
- shear (المقص): pieces = عدد القطع, ops_per_piece = قصات للقطعة, total_written = إجمالي القصات
- laser (الليزر): sheets = عدد الألواح, minutes_per_sheet = دقائق للوح
- punch (البنش): sheets = عدد الألواح, sheet_size = مقاس اللوح (text like "2500x1250"), pieces_per_sheet = قطع من اللوح, pieces = إجمالي القطع, hits_per_piece = ضربات للقطعة, louvers_per_piece = لوفر للقطعة, minutes = دقائق
Every machine also has: client (العميل), part_name (اسم القطعة, optional), material (الخامة), thickness in mm (السمك), work_date (التاريخ), material_source (الخامة من: "عميل" = client, "مصنع" = factory).
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
  const clients = db.prepare('SELECT id, name FROM clients WHERE active = 1 ORDER BY id').all();
  const materials = db.prepare('SELECT id, name, aliases FROM materials WHERE active = 1 ORDER BY id').all();
  const techs = db.prepare('SELECT name FROM technicians WHERE active = 1 ORDER BY id').all();
  return [
    'Clients (id: name):', ...clients.map((c) => `${c.id}: ${c.name}`), clients.length ? '' : '(none yet)',
    'Materials (id: name / other spellings):', ...materials.map((m) => `${m.id}: ${m.name}${JSON.parse(m.aliases || '[]').length ? ' / ' + JSON.parse(m.aliases).join(' / ') : ''}`),
    '',
    `Technicians: ${techs.map((t) => t.name).join('، ') || '(none yet)'}`,
  ].join('\n');
}

// ---------- settings + status ----------
export function aiStatus() {
  const s = getSettings();
  const model = AI_MODELS[s.ai_model] ? s.ai_model : DEFAULT_AI_MODEL;
  return { enabled: !!s.ai_enabled && !!s.ai_api_key, configured: !!s.ai_api_key, model };
}

export function aiUsage() {
  const db = getDb();
  const month = todayISO().slice(0, 7);
  const row = db.prepare(`SELECT COUNT(*) AS reads, COALESCE(SUM(cost_micro_usd), 0) AS cost FROM ai_usage WHERE substr(at, 1, 7) = ?`).get(month);
  const all = db.prepare('SELECT COUNT(*) AS reads, COALESCE(SUM(cost_micro_usd), 0) AS cost FROM ai_usage').get();
  return { month, month_reads: row.reads, month_usd: row.cost / 1e6, total_reads: all.reads, total_usd: all.cost / 1e6 };
}

// Tests point this at a fake API.
const client = (apiKey) => new Anthropic({ apiKey, baseURL: process.env.SHEETMETAL_AI_BASE_URL || undefined, timeout: 120000, maxRetries: 2 });

/**
 * Reads one sheet photo. Returns { result, usage } where result follows SCHEMA.
 * hint: { machine (code or null), form: true when it is the printed form }.
 */
export async function readSheetPhoto(photoPath, hint = {}) {
  const s = getSettings();
  const status = aiStatus();
  if (!status.enabled) throw httpError(409, 'القراءة بالذكاء الاصطناعي مش متفعلة — فعّلها من الإعدادات');
  const file = join(dataDir(), photoPath);
  if (!fs.existsSync(file)) throw httpError(404, 'ملف الصورة مش موجود');
  const image = fs.readFileSync(file).toString('base64');
  const intro = [
    `Today's date: ${todayISO()}.`,
    hint.machine ? `This sheet is for the ${hint.machine} machine.` : 'The machine is not known: tell it from the title and columns.',
    hint.form ? 'This is the printed form (already straightened).' : 'This is a plain photo of the paper.',
    'Read the sheet.',
  ].join(' ');

  let message;
  try {
    message = await client(s.ai_api_key).beta.messages.parse({
      model: status.model,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default', // a declined request is retried on a suitable model inside the same call
      output_config: { effort: 'medium', format: betaJSONSchemaOutputFormat(SCHEMA) },
      system: [
        { type: 'text', text: RULES, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: listsBlock(), cache_control: { type: 'ephemeral' } },
      ],
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } },
          { type: 'text', text: intro },
        ],
      }],
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      throw httpError(502, 'مفتاح الذكاء الاصطناعي غلط أو موقوف — راجعه في الإعدادات');
    }
    if (err instanceof Anthropic.RateLimitError) throw httpError(503, 'خدمة القراءة مشغولة دلوقتي — جرب كمان دقيقة');
    if (err instanceof Anthropic.APIConnectionError) throw httpError(503, 'مفيش نت أو الخدمة مش بترد — اتقرت الورقة من غير الذكاء الاصطناعي');
    if (err instanceof Anthropic.APIError) throw httpError(502, `خدمة القراءة رجعت خطأ (${err.status}) — جرب تاني`);
    throw err;
  }
  if (message.stop_reason === 'refusal') throw httpError(422, 'خدمة القراءة رفضت الصورة دي — اكتبها بإيدك');
  if (message.stop_reason === 'max_tokens' || !message.parsed_output) throw httpError(502, 'القراءة ما كملتش — جرب تاني');

  const usage = recordUsage(message, hint.sheetId);
  return { result: message.parsed_output, usage };
}

function recordUsage(message, sheetId) {
  const price = AI_MODELS[message.model] || AI_MODELS[DEFAULT_AI_MODEL];
  const u = message.usage || {};
  const inTok = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) * 1.25;
  const cost = Math.round(inTok * price.input + (u.cache_read_input_tokens || 0) * price.cacheRead + (u.output_tokens || 0) * price.output);
  getDb().prepare('INSERT INTO ai_usage (sheet_id, model, input_tokens, output_tokens, cache_read_tokens, cost_micro_usd) VALUES (?,?,?,?,?,?)')
    .run(sheetId ?? null, message.model, u.input_tokens || 0, u.output_tokens || 0, u.cache_read_input_tokens || 0, cost);
  return { model: message.model, cost_usd: cost / 1e6 };
}

// ---------- AI result → reads the review screen already understands ----------
const fold = (s) => String(s ?? '').trim().toLowerCase()
  .replace(/[ً-ْـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/^ال/, '').replace(/\s+/g, ' ');
const CONF = { high: 0.95, medium: 0.75, low: 0.45 };

export function toReads(result, machineCode) {
  const db = getDb();
  const clientName = db.prepare('SELECT name FROM clients WHERE id = ?');
  const fields = new Set(['client_id', 'part_name', 'material_id', 'thickness', 'work_date', 'material_source', ...(MACHINE_FIELDS[machineCode] || [])]);
  const reads = [];
  for (const row of result.rows || []) {
    if (!Number.isInteger(row.row) || row.row < 1 || row.row > 60) continue;
    const base = CONF[row.confidence] ?? 0.45;
    const unsure = new Set(row.uncertain_fields || []);
    const ditto = new Set((row.ditto_fields || []).filter((f) => fields.has(f)));
    const conf = (f) => (unsure.has(f) || (f === 'client_id' && unsure.has('client')) ? Math.min(base, 0.5) : base);
    // The technician's own total doesn't match: none of the three can be "sure".
    const sum = ['press', 'shear'].includes(machineCode) && row.pieces != null && row.ops_per_piece != null && row.total_written != null
      && Math.abs(row.pieces * row.ops_per_piece - row.total_written) > 1e-6;
    const add = (field, kind, value, c) => reads.push({ row: row.row, field, kind, value, confidence: Math.round(c * 100) / 100, candidates: [], source: 'ai' });

    for (const f of fields) {
      if (ditto.has(f)) { add(f, 'ditto', null, Math.min(conf(f), 0.85)); continue; }
      let v = row[f];
      if (f === 'client_id' && v != null) {
        // A match to a name written quite differently is worth a look.
        const name = clientName.get(v)?.name;
        if (!name) { v = null; } else {
          const w = fold(row.client_written);
          const same = w && (fold(name) === w || fold(name).includes(w) || w.includes(fold(name)));
          add(f, 'value', String(v), same ? conf(f) : Math.min(conf(f), 0.75));
          continue;
        }
      }
      if (v === null || v === undefined || v === '') continue;
      if (NUMBERS.includes(f)) {
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) continue;
        add(f, 'value', String(v), sum && ['pieces', 'ops_per_piece', 'total_written'].includes(f) ? Math.min(conf(f), 0.6) : conf(f));
      } else if (f === 'work_date') {
        if (/^\d{4}-\d{2}-\d{2}$/.test(v)) add(f, 'value', v, conf(f));
      } else {
        add(f, 'value', String(v), conf(f));
      }
    }
    // A name we couldn't match: keep what is written, so the reviewer sees it (and can add the client).
    if (row.client_id == null && row.client_written && !ditto.has('client_id')) add('client_text', 'value', String(row.client_written).slice(0, 80), 0.5);
  }
  return reads;
}

// The technician named on the sheet, if he is one of ours.
export function matchTechnician(name) {
  if (!name) return null;
  const w = fold(name);
  const t = getDb().prepare('SELECT id, name FROM technicians WHERE active = 1').all()
    .find((x) => fold(x.name) === w || fold(x.name).includes(w) || w.includes(fold(x.name)));
  return t?.id ?? null;
}
