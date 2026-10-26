// Which build this is. The release workflow writes version.json into the package;
// a plain checkout falls back to package.json with build 0.
import fs from 'fs';
import { join } from 'path';
import { ROOT } from './paths.js';

function readJson(name) {
  try { return JSON.parse(fs.readFileSync(join(ROOT, name), 'utf8')); } catch { return null; }
}

const built = readJson('version.json');
const pkg = readJson('package.json') || {};

export const VERSION = {
  version: built?.version || pkg.version || '0.0.0',
  build: Number(built?.build) || 0,
  commit: built?.commit || '',
};
export const APP_VERSION = VERSION.build ? `${VERSION.version} (${VERSION.build})` : VERSION.version;
