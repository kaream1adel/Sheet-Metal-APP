// Phone access from anywhere: a Cloudflare tunnel publishes the app over HTTPS.
// Without a token it is a free "quick" link that changes when the PC restarts;
// with a token from a free Cloudflare account it is a fixed link (tunnel_url).
// cloudflared.exe sits next to the launcher; it is bundled, not in the repo.
import fs from 'fs';
import os from 'os';
import { join } from 'path';
import { spawn } from 'child_process';
import QRCode from 'qrcode';
import { homeDir, ROOT } from './paths.js';
import { getSettings } from './settings.js';

const QUICK_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const RETRY_MS = 30000;

const tunnel = { state: 'off', url: null, error: null, child: null, port: null, timer: null, wanted: false };

export function cloudflaredPath() {
  for (const dir of [homeDir(), ROOT].filter(Boolean)) {
    for (const name of ['cloudflared.exe', 'cloudflared']) {
      const p = join(dir, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

export function startTunnel(port) {
  tunnel.port = port;
  stopTunnel();
  const s = getSettings();
  if (!s.tunnel_enabled) return;
  const bin = cloudflaredPath();
  if (!bin) {
    tunnel.state = 'missing';
    return;
  }
  tunnel.wanted = true;
  tunnel.state = 'starting';
  tunnel.error = null;
  tunnel.url = s.tunnel_token ? s.tunnel_url || null : null;
  const args = s.tunnel_token
    ? ['tunnel', '--no-autoupdate', 'run', '--token', s.tunnel_token]
    : ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`];
  const child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  tunnel.child = child;
  const onOutput = (chunk) => {
    const text = chunk.toString();
    const m = text.match(QUICK_URL);
    if (m && !s.tunnel_token) tunnel.url = m[0];
    if (/Registered tunnel connection|Connection [a-z0-9-]+ registered/i.test(text) || m) tunnel.state = 'on';
    if (/error/i.test(text) && tunnel.state !== 'on') tunnel.error = text.trim().split('\n').pop().slice(0, 300);
  };
  child.stdout.on('data', onOutput);
  child.stderr.on('data', onOutput);
  child.on('error', (err) => { tunnel.state = 'error'; tunnel.error = err.message; });
  child.on('exit', () => {
    if (tunnel.child !== child) return; // replaced on purpose
    tunnel.child = null;
    if (!tunnel.wanted) return;
    // It dropped (no internet, PC woke up...): try again in a while. A quick link changes.
    tunnel.state = 'error';
    tunnel.error ||= 'الاتصال وقع — هجرب تاني لوحدي';
    tunnel.timer = setTimeout(() => startTunnel(port), RETRY_MS);
    tunnel.timer.unref();
  });
}

export function stopTunnel() {
  tunnel.wanted = false;
  clearTimeout(tunnel.timer);
  const child = tunnel.child;
  tunnel.child = null;
  child?.kill();
  tunnel.state = 'off';
  tunnel.url = null;
}

export const restartTunnel = () => startTunnel(tunnel.port);

// Links that work on the workshop Wi-Fi without the internet.
export function lanUrls(port) {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${port}`);
  }
  return out;
}

const qr = (url) => QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });

export async function shareInfo() {
  const s = getSettings();
  const lan = lanUrls(tunnel.port);
  return {
    tunnel: {
      state: tunnel.state,
      url: tunnel.url,
      error: tunnel.error,
      fixed: !!s.tunnel_token,
      enabled: !!s.tunnel_enabled,
      qr: tunnel.url ? await qr(tunnel.url) : null,
    },
    lan: await Promise.all(lan.map(async (url) => ({ url, qr: await qr(url) }))),
  };
}

process.on('exit', () => tunnel.child?.kill());
