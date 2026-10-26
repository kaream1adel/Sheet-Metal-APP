// Backups, updates, the share page (tunnel + QR) and start-with-Windows. Admin only.
import { Router } from 'express';
import { requirePerm } from '../auth.js';
import { audit } from '../db.js';
import { getSettings, setSettings } from '../settings.js';
import { listBackups, makeBackup, backupFile, restoreBackup, backupStatus } from '../backup.js';
import { checkForUpdate, applyUpdate, rollback, updateStatus } from '../update.js';
import { shareInfo, restartTunnel, cloudflaredPath } from '../tunnel.js';
import { autostartStatus, setAutostart } from '../windows.js';
import { cleanText, httpError, asyncRoute } from '../util.js';
import fs from 'fs';

export const system = Router();
const admin = requirePerm('settings.manage');

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
