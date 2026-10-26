// Builds dist/sheet-metal-win-x64.tar.gz + dist/manifest.json for the update button, and
// build/app (the same files + node\node.exe + cloudflared.exe) for the Setup installer.
// Run by the release workflow on Windows after `npm prune --omit=dev`.
// Env: BUILD (run number), COMMIT (git sha).
import fs from 'fs';
import crypto from 'crypto';
import { execSync } from 'child_process';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const build = Number(process.env.BUILD);
if (!build) throw new Error('BUILD is required');
const commit = process.env.COMMIT || '';
const notes = execSync('git log -1 --pretty=%B', { encoding: 'utf8' }).trim();

fs.writeFileSync('version.json', JSON.stringify({ version: pkg.version, build, commit }, null, 2));
fs.rmSync('dist', { recursive: true, force: true });
fs.mkdirSync('dist');
const files = ['src', 'public', 'node_modules', 'package.json', 'package-lock.json', 'version.json', 'Start Sheet Metal.bat'];
execSync(`tar -czf dist/sheet-metal-win-x64.tar.gz ${files.map((f) => `"${f}"`).join(' ')}`, { stdio: 'inherit' });

const buf = fs.readFileSync('dist/sheet-metal-win-x64.tar.gz');
const manifest = {
  version: pkg.version,
  build,
  commit,
  notes,
  sha256: crypto.createHash('sha256').update(buf).digest('hex'),
  size: buf.length,
  node: process.version,
  node_abi: process.versions.modules,
};
fs.writeFileSync('dist/manifest.json', JSON.stringify(manifest, null, 2));
fs.writeFileSync('dist/notes.txt', `${notes}\n\nNode ${process.version}`);
console.log(manifest);

// The installer's files. node.exe is the very Node that built node_modules, so the
// native module always matches it.
fs.rmSync('build', { recursive: true, force: true });
const app = 'build/app';
for (const f of files) fs.cpSync(f, `${app}/${f}`, { recursive: true });
fs.mkdirSync(`${app}/node`, { recursive: true });
fs.copyFileSync(process.execPath, `${app}/node/node.exe`);
const cf = await fetch('https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe');
if (!cf.ok) throw new Error(`cloudflared download: ${cf.status}`);
fs.writeFileSync(`${app}/cloudflared.exe`, Buffer.from(await cf.arrayBuffer()));
console.log('installer files ready in build/app');
