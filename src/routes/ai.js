// Settings for the online reader (admin): on/off, API key (never sent back), model, cost.
import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { audit } from '../db.js';
import { requirePerm } from '../auth.js';
import { getSettings, setSettings } from '../settings.js';
import { AI_MODELS, aiStatus, aiUsage } from '../ai.js';
import { cleanText, httpError, asyncRoute } from '../util.js';

export const ai = Router();
const admin = requirePerm('settings.manage');

ai.get('/ai', admin, (_req, res) => {
  res.json({ ...aiStatus(), usage: aiUsage(), models: Object.entries(AI_MODELS).map(([id, m]) => ({ id, ...m })) });
});

ai.put('/ai', admin, (req, res) => {
  const b = req.body || {};
  const v = {};
  if (b.enabled !== undefined) v.ai_enabled = !!b.enabled;
  if (b.model !== undefined) {
    if (!AI_MODELS[b.model]) throw httpError(400, 'الموديل ده مش من الاختيارات');
    v.ai_model = b.model;
  }
  if (b.api_key !== undefined) v.ai_api_key = cleanText(b.api_key, 300);
  if (v.ai_enabled && !(v.ai_api_key ?? getSettings().ai_api_key)) throw httpError(400, 'حط مفتاح الخدمة الأول');
  const mask = (s) => ({ ai_enabled: s.ai_enabled, ai_model: s.ai_model, ai_api_key: s.ai_api_key ? '••••' : '' });
  const before = mask(getSettings());
  setSettings(v);
  audit(req.user.id, 'update', 'settings', null, before, mask(getSettings()));
  res.json({ ...aiStatus(), usage: aiUsage() });
});

// Checks the key without reading anything (free).
ai.post('/ai/test', admin, asyncRoute(async (_req, res) => {
  const s = getSettings();
  if (!s.ai_api_key) throw httpError(400, 'حط مفتاح الخدمة الأول');
  try {
    const client = new Anthropic({ apiKey: s.ai_api_key, baseURL: process.env.SHEETMETAL_AI_BASE_URL || undefined, timeout: 20000, maxRetries: 1 });
    await client.models.retrieve(aiStatus().model);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) throw httpError(400, 'المفتاح غلط أو موقوف');
    if (err instanceof Anthropic.APIConnectionError) throw httpError(503, 'مفيش اتصال بالنت');
    throw httpError(502, 'الخدمة مش بترد دلوقتي');
  }
}));
