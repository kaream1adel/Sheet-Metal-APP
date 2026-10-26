// Where things live. The data folder is kept apart from the code so an
// update only ever replaces code. SHEETMETAL_DATA overrides it (tests use a temp dir).
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import fs from 'fs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLIC_DIR = join(ROOT, 'public');

export function dataDir() {
  return process.env.SHEETMETAL_DATA ? resolve(process.env.SHEETMETAL_DATA) : join(ROOT, 'data');
}

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}
