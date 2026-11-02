// Starts the app. Listens on all interfaces so phones on the Wi-Fi (and the
// Cloudflare tunnel) can reach it.
import { exec } from 'child_process';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { openDb, closeDb } from './db.js';
import { createApp, APP_VERSION } from './app.js';
import { startBackupSchedule } from './backup.js';
import { recoverAfterFailedUpdate, markStarted, startUpdateChecks, adoptInstalledCode } from './update.js';
import { startTunnel, stopTunnel } from './tunnel.js';
import { keepAwake } from './windows.js';

// Background work of a module (the AI photo queue of module operations): src/photos.js,
// when it exists, exports startPhotoJobs() / stopPhotoJobs(). Any error loading it (a missing
// dependency, a syntax error) must stop the start, not silently leave the queue off.
const photosFile = fileURLToPath(new URL('./photos.js', import.meta.url));
const photos = fs.existsSync(photosFile) ? await import('./photos.js') : null;

const PORT = Number(process.env.PORT || 4300);

adoptInstalledCode();
recoverAfterFailedUpdate();
openDb();
const server = createApp().listen(PORT, '0.0.0.0', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Safa (Sheet Metal) ${APP_VERSION} — ${url}`);
  console.log('Keep this window open while you use the app.');
  // A fresh update that got this far works: the launcher must not roll it back.
  setTimeout(markStarted, 5000).unref();
  startBackupSchedule();
  photos?.startPhotoJobs?.();
  startUpdateChecks();
  startTunnel(PORT);
  keepAwake();
  // The launcher sets OPEN=1: open the browser once the server is really listening.
  if (process.env.OPEN === '1' && process.platform === 'win32') exec(`start "" "${url}"`);
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use — the app is probably already running.`);
    console.error(`Open http://localhost:${PORT} in the browser.\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

const shutdown = () => {
  stopTunnel();
  photos?.stopPhotoJobs?.();
  server.close(() => { closeDb(); process.exit(0); });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
