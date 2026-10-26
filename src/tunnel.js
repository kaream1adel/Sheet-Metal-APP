// Phone access from anywhere: a Cloudflare tunnel publishes the app over HTTPS.
// Without a token it is a free "quick" link that changes when the PC restarts;
// with a token from a free Cloudflare account it is a fixed link (tunnel_url).
// cloudflared.exe sits next to the launcher. If it is missing the app downloads it
// from Cloudflare's GitHub releases by itself, so the link just appears.
import fs from 'fs';
import os from 'os';
import { join } from 'path';
import { spawn } from 'child_process';
import QRCode from 'qrcode';
import { homeDir, ROOT } from './paths.js';
import { httpError } from './util.js';
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

// The official build for this PC, or null where there is no single-file build (macOS).
function downloadUrl() {
  if (process.env.SHEETMETAL_CLOUDFLARED_URL) return process.env.SHEETMETAL_CLOUDFLARED_URL;
  const arch = { x64: 'amd64', ia32: '386', arm64: 'arm64' }[process.arch];
  const os_ = { win32: 'windows', linux: 'linux' }[process.platform];
  if (!arch || !os_) return null;
  return `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-${os_}-${arch}${os_ === 'windows' ? '.exe' : ''}`;
}

let downloading = null;
async function downloadCloudflared() {
  const url = downloadUrl();
  if (!url) throw httpError(409, 'التحميل التلقائي مش متاح على الجهاز ده');
  const dest = join(homeDir() || ROOT, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  const part = `${dest}.part`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5 * 60000) });
    if (!res.ok) throw new Error(`download ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1_000_000) throw new Error('download too small');
    fs.writeFileSync(part, buf, { mode: 0o755 });
    fs.renameSync(part, dest);
    return dest;
  } finally {
    fs.rmSync(part, { force: true });
  }
}

export function startTunnel(port) {
  tunnel.port = port;
  stopTunnel();
  const s = getSettings();
  if (!s.tunnel_enabled) return;
  const bin = cloudflaredPath();
  if (!bin) {
    if (downloading) return;
    tunnel.state = 'downloading';
    tunnel.error = null;
    downloading = downloadCloudflared()
      .then(() => { downloading = null; startTunnel(port); })
      .catch((err) => {
        downloading = null;
        tunnel.state = 'missing';
        tunnel.error = `مقدرتش أحمّل cloudflared: ${err.message}`;
        // No internet yet (PC just booted?): try again in a few minutes.
        tunnel.timer = setTimeout(() => startTunnel(port), 10 * RETRY_MS);
        tunnel.timer.unref();
      });
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
