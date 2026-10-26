// Where things live. The data folder is kept apart from the code so an
// update only ever replaces code. SHEETMETAL_DATA overrides it (tests use a temp dir).
//
// Installed layout (SHEETMETAL_HOME is set by "Start Sheet Metal.bat"):
//   <home>\Start Sheet Metal.bat   node\node.exe   cloudflared.exe
//   <home>\data\                   the database and backups — never touched by an update
//   <home>\versions\<build>\       code downloaded by the update button
//   <home>\current.txt             which code runs ("." = the code next to the .bat)
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import fs from 'fs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLIC_DIR = join(ROOT, 'public');

// The install folder, or null when running from a plain checkout (dev, tests).
export function homeDir() {
  return process.env.SHEETMETAL_HOME ? resolve(process.env.SHEETMETAL_HOME) : null;
}

export function dataDir() {
  if (process.env.SHEETMETAL_DATA) return resolve(process.env.SHEETMETAL_DATA);
  return join(homeDir() || ROOT, 'data');
}

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}
