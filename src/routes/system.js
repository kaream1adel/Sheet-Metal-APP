// Backups, updates, the share page (tunnel + QR), start-with-Windows, general settings,
// the AI reading key (server only) and إقفال الشهر. Admin only (permission "settings").
import { Router } from 'express';
import { requirePerm } from '../auth.js';
import { audit } from '../db.js';
import { getSettings, setSettings, publicSettings } from '../settings.js';
import { listMonthLocks, lockMonth, unlockMonth } from '../ledger.js';
import { listBackups, makeBackup, backupFile, restoreBackup, backupStatus } from '../backup.js';
import { checkForUpdate, applyUpdate, rollback, updateStatus } from '../update.js';
import { shareInfo, restartTunnel, cloudflaredPath } from '../tunnel.js';
import { autostartStatus, setAutostart } from '../windows.js';
import { cleanText, httpError, asyncRoute } from '../util.js';
import fs from 'fs';

export const system = Router();
const admin = requirePerm('settings');

// ---------- backups ----------
system.get('/backups', admin, (_req, res) => {
  res.json({ backups: listBackups(), status: backupStatus() });
});

system.post('/backups', admin, asyncRoute(async (req, res) => {
  const name = await makeBackup('manual');
  audit(req.user.id, 'backup', 'backup', null, null, { name });
  res.status(201).json({ name, status: backupStatus() });
}));

system.get('/backups/:name/download', admin, (req, res) => {
  res.download(backupFile(req.params.name), req.params.name);
});

system.post('/backups/:name/restore', admin, asyncRoute(async (req, res) => {
  if (req.body?.confirm !== true) throw httpError(400, 'لازم توافق على الاسترجاع الأول');
  const r = await restoreBackup(req.params.name, req.user.id);
  res.json({ ok: true, ...r });
}));

system.put('/backups/settings', admin, (req, res) => {
  const dir = cleanText(req.body?.backup_copy_dir, 300);
  if (dir && !fs.existsSync(dir)) throw httpError(400, 'الفولدر ده مش موجود على الجهاز');
  const before = getSettings().backup_copy_dir;
  setSettings({ backup_copy_dir: dir });
  audit(req.user.id, 'update', 'settings', null, { backup_copy_dir: before }, { backup_copy_dir: dir });
  res.json({ status: backupStatus() });
});

// ---------- updates ----------
system.get('/update', admin, (_req, res) => res.json(updateStatus()));

system.post('/update/check', admin, asyncRoute(async (_req, res) => {
  await checkForUpdate();
  res.json(updateStatus());
}));

system.post('/update/apply', admin, asyncRoute(async (req, res) => {
  const r = await applyUpdate(req.user.id);
  res.json({ ok: true, restarting: true, version: r.to.version, build: r.to.build });
}));

system.post('/update/rollback', admin, asyncRoute(async (req, res) => {
  if (req.body?.confirm !== true) throw httpError(400, 'لازم توافق على الرجوع الأول');
  const r = await rollback(req.user.id);
  res.json({ ok: true, restarting: true, ...r });
}));

// ---------- share (tunnel + QR) ----------
system.get('/share', admin, asyncRoute(async (_req, res) => {
  const s = getSettings();
  res.json({
    ...(await shareInfo()),
    has_cloudflared: !!cloudflaredPath(),
    // The token is a secret: say whether it is set, never send it back.
    settings: { tunnel_enabled: s.tunnel_enabled, tunnel_url: s.tunnel_url, tunnel_token_set: !!s.tunnel_token },
  });
}));

system.put('/share/settings', admin, (req, res) => {
  const b = req.body || {};
  const v = {};
  if (b.tunnel_enabled !== undefined) v.tunnel_enabled = !!b.tunnel_enabled;
  if (b.tunnel_url !== undefined) {
    const url = cleanText(b.tunnel_url, 200);
    if (url && !/^https:\/\/[^\s/]+/.test(url)) throw httpError(400, 'اللينك الثابت لازم يبدأ بـ https://');
    v.tunnel_url = url;
  }
  if (b.tunnel_token !== undefined) v.tunnel_token = cleanText(b.tunnel_token, 400);
  const mask = (s) => ({ ...s, tunnel_token: s.tunnel_token ? '••••' : '' });
  const pick = (s) => mask({ tunnel_enabled: s.tunnel_enabled, tunnel_url: s.tunnel_url, tunnel_token: s.tunnel_token });
  const before = pick(getSettings());
  const after = pick(setSettings(v));
  audit(req.user.id, 'update', 'settings', null, before, after);
  restartTunnel();
  res.json({ ok: true });
});

system.post('/share/restart', admin, (_req, res) => {
  restartTunnel();
  res.json({ ok: true });
});

// ---------- start with Windows ----------
system.get('/autostart', admin, (_req, res) => res.json(autostartStatus()));

system.put('/autostart', admin, (req, res) => {
  const r = setAutostart(!!req.body?.enabled);
  audit(req.user.id, 'update', 'settings', null, null, { autostart: r.enabled });
  res.json(r);
});

// ---------- what the home page shows the admin about the PC ----------
system.get('/system/status', admin, (_req, res) => {
  const u = updateStatus();
  res.json({ backup: backupStatus(), update_available: u.available, installed: u.installed, version: u.current });
});

// ---------- general settings ----------
system.get('/settings', admin, (_req, res) => res.json({ settings: publicSettings() }));

system.put('/settings', admin, (req, res) => {
  const b = req.body || {};
  const v = {};
  for (const k of ['company_name', 'company_phone', 'company_address']) if (b[k] !== undefined) v[k] = cleanText(b[k], 200);
  if (b.cheque_alert_days !== undefined) {
    const n = Number(b.cheque_alert_days);
    if (!Number.isInteger(n) || n < 0 || n > 60) throw httpError(400, 'عدد الأيام غلط');
    v.cheque_alert_days = n;
  }
  const before = publicSettings();
  setSettings(v);
  audit(req.user.id, 'update', 'settings', null, before, publicSettings());
  res.json({ settings: publicSettings() });
});

// ---------- القراءة الآلية: the Claude API key never leaves the server ----------
const AI_MODELS = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5 (الأدق)' },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5 (أرخص)' },
];

function aiView() {
  const s = getSettings();
  return { enabled: !!s.ai_enabled, configured: !!s.ai_api_key, model: s.ai_model, models: AI_MODELS };
}

system.get('/settings/ai', admin, (_req, res) => res.json(aiView()));

system.put('/settings/ai', admin, (req, res) => {
  const b = req.body || {};
  const v = {};
  if (b.enabled !== undefined) v.ai_enabled = !!b.enabled;
  if (b.model !== undefined) {
    if (!AI_MODELS.some((m) => m.id === b.model)) throw httpError(400, 'الموديل غلط');
    v.ai_model = b.model;
  }
  if (b.api_key !== undefined) {
    const key = cleanText(b.api_key, 300);
    if (key && !/^sk-ant-[A-Za-z0-9_-]{10,}$/.test(key)) throw httpError(400, 'المفتاح شكله غلط — بيبدأ بـ sk-ant-');
    v.ai_api_key = key;
  }
  if (v.ai_enabled && !(v.ai_api_key ?? getSettings().ai_api_key)) throw httpError(400, 'اكتب مفتاح الخدمة الأول');
  const before = aiView();
  setSettings(v);
  const after = aiView();
  // The key itself is never written to the audit log either.
  audit(req.user.id, 'update', 'settings', null, { ...before, models: undefined }, { ...after, models: undefined, key_changed: b.api_key !== undefined });
  res.json(after);
});

// ---------- إقفال الشهر ----------
system.get('/month-locks', admin, (_req, res) => res.json({ locks: listMonthLocks() }));

system.post('/month-locks', admin, (req, res) => {
  lockMonth(String(req.body?.month || ''), req.user.id, cleanText(req.body?.note, 300));
  res.status(201).json({ locks: listMonthLocks() });
});

system.delete('/month-locks/:month', admin, (req, res) => {
  unlockMonth(req.params.month, req.user.id, cleanText(req.body?.reason, 300));
  res.json({ locks: listMonthLocks() });
});
