// Backups, restore, the update button and rollback (against a fake GitHub), share page.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import express from 'express';
import { startApp, client } from './helpers.js';
import { setRestartHandler, tarCommand, PACKAGE_ASSET, UPDATE_REPO } from '../src/update.js';
import { openDb, getDb } from '../src/db.js';

let app;
let admin;
let staff;
let home;
let github;
let release = {};        // what the fake GitHub serves
let restarts = 0;

// A package like the release workflow builds. cli.js is a stub: exit code = trial migration result.
function makePackage(build, { migrationOk = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sheetmetal-pkg-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ version: '0.2.0', build, commit: 'abc' }));
  fs.writeFileSync(path.join(dir, 'src', 'server.js'), '// new server\n');
  fs.writeFileSync(path.join(dir, 'src', 'cli.js'), `process.exit(${migrationOk ? 0 : 1});\n`);
  const tarball = path.join(dir, 'pkg.tar.gz');
  execFileSync(tarCommand(), ['-czf', tarball, '-C', dir, 'version.json', 'src']);
  const buf = fs.readFileSync(tarball);
  fs.rmSync(dir, { recursive: true, force: true });
  return { buf, manifest: { version: '0.2.0', build, sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length, notes: 'تجربة' } };
}

before(async () => {
  app = await startApp();
  admin = client(app.base);
  staff = client(app.base);
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sheetmetal-home-'));

  const gh = express();
  gh.get(`/repos/${UPDATE_REPO}/releases/latest`, (req, res) => {
    const base = `http://127.0.0.1:${github.address().port}`;
    res.json({ published_at: '2026-10-26T10:00:00Z', assets: [
      { name: 'manifest.json', browser_download_url: `${base}/manifest.json` },
      { name: PACKAGE_ASSET, browser_download_url: `${base}/pkg` },
    ] });
  });
  gh.get('/manifest.json', (_req, res) => res.json(release.manifest));
  gh.get('/pkg', (_req, res) => res.end(release.buf));
  github = await new Promise((r) => { const s = gh.listen(0, '127.0.0.1', () => r(s)); });
  process.env.SHEETMETAL_UPDATE_API = `http://127.0.0.1:${github.address().port}`;
  setRestartHandler(() => { restarts += 1; });

  await admin.post('/api/setup', { username: 'kaream', display_name: 'كريم', password: 'secret1' });
  await admin.post('/api/users', { username: 'manager', display_name: 'المدير', password: 'secret2', role: 'staff' });
  await staff.post('/api/login', { username: 'manager', password: 'secret2' });
});

after(async () => {
  delete process.env.SHEETMETAL_HOME;
  await new Promise((r) => github.close(r));
  await app.stop();
  fs.rmSync(home, { recursive: true, force: true });
});

test('staff can not reach backups, updates or the share page', async () => {
  for (const url of ['/api/backups', '/api/update', '/api/share', '/api/autostart']) {
    assert.equal((await staff.get(url)).status, 403, url);
  }
  assert.equal((await staff.post('/api/backups')).status, 403);
  assert.equal((await staff.post('/api/update/apply')).status, 403);
  const home = await staff.get('/api/home');
  assert.equal(home.data.system, undefined);
});

test('manual backup, list, download and a bad name', async () => {
  const r = await admin.post('/api/backups');
  assert.equal(r.status, 201);
  assert.match(r.data.name, /_manual\.sqlite$/);
  const list = await admin.get('/api/backups');
  assert.ok(list.data.backups.some((b) => b.name === r.data.name && b.reason_name === 'يدوي'));
  assert.equal(list.data.status.stale, false);
  const dl = await fetch(`${app.base}/api/backups/${r.data.name}/download`, { headers: { cookie: admin.cookie } });
  assert.equal(dl.status, 200);
  assert.equal(Buffer.from(await dl.arrayBuffer()).subarray(0, 15).toString(), 'SQLite format 3');
  assert.equal((await admin.get('/api/backups/..%2Fsheet-metal.sqlite/download')).status, 400);
});

test('restore brings the old data back and keeps a safety copy', async () => {
  const { data: { name } } = await admin.post('/api/backups');
  const c = await admin.post('/api/clients', { name: 'عميل بعد النسخة' });
  assert.equal(c.status, 201);
  assert.equal((await admin.post(`/api/backups/${name}/restore`, {})).status, 400); // must confirm
  const r = await admin.post(`/api/backups/${name}/restore`, { confirm: true });
  assert.equal(r.status, 200);
  assert.match(r.data.safety, /_restore\.sqlite$/);
  const { data } = await admin.get('/api/clients');
  assert.ok(!data.clients.some((x) => x.name === 'عميل بعد النسخة'));
  const audit = getDb().prepare("SELECT * FROM audit_log WHERE action = 'restore'").get();
  assert.ok(audit && JSON.parse(audit.after_json).restored === name);
});

test('update is refused outside the installed app', async () => {
  const s = await admin.get('/api/update');
  assert.equal(s.data.installed, false);
  assert.equal((await admin.post('/api/update/apply')).status, 409);
});

test('a broken download or a failing migration changes nothing', async () => {
  process.env.SHEETMETAL_HOME = home;
  release = makePackage(5);
  release.manifest = { ...release.manifest, sha256: 'f'.repeat(64) };
  let r = await admin.post('/api/update/apply');
  assert.equal(r.status, 502);
  assert.ok(!fs.existsSync(path.join(home, 'current.txt')));

  release = makePackage(5, { migrationOk: false });
  r = await admin.post('/api/update/apply');
  assert.equal(r.status, 500);
  assert.match(r.data.error, /التحديث اتلغى/);
  assert.ok(!fs.existsSync(path.join(home, 'current.txt')));
  assert.ok(!fs.existsSync(path.join(home, 'versions', '5')));
  assert.equal(restarts, 0);
});

test('update: check, apply into versions\\<build>, then roll back', async () => {
  process.env.SHEETMETAL_HOME = home;
  release = makePackage(7);
  let r = await admin.post('/api/update/check');
  assert.equal(r.data.available, true);
  assert.equal(r.data.latest.build, 7);
  assert.equal((await admin.get('/api/home')).data.system.update_available, true);

  r = await admin.post('/api/update/apply');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(restarts, 1);
  const read = (f) => fs.readFileSync(path.join(home, f), 'utf8');
  assert.equal(read('current.txt'), '7');
  assert.equal(read('previous.txt'), '.');
  assert.equal(read('update-trial.txt'), '7');
  assert.ok(fs.existsSync(path.join(home, 'versions', '7', 'src', 'server.js')));
  const list = await admin.get('/api/backups');
  assert.ok(list.data.backups.some((b) => b.reason === 'update'));
  assert.ok(getDb().prepare("SELECT 1 FROM audit_log WHERE action = 'update' AND entity = 'app'").get());

  // This process is still the old build (0), so the schema did not change: no data is lost.
  r = await admin.get('/api/update');
  assert.equal(r.data.can_rollback, true);
  assert.equal(r.data.rollback_loses_data, false);
  assert.equal((await admin.post('/api/update/rollback', {})).status, 400); // must confirm
  r = await admin.post('/api/update/rollback', { confirm: true });
  assert.equal(r.status, 200);
  assert.equal(restarts, 2);
  assert.equal(read('current.txt'), '.');
  assert.equal(read('previous.txt'), '7');
  assert.ok(!fs.existsSync(path.join(home, 'update-trial.txt')));
});

test('rollback after a schema change goes back to the pre-update backup', async () => {
  process.env.SHEETMETAL_HOME = home;
  const { data: { name } } = await admin.post('/api/backups');
  await admin.post('/api/clients', { name: 'عميل بعد التحديث' });
  // Pretend this running build (0) is the update that moved the schema from 1.
  fs.writeFileSync(path.join(home, 'current.txt'), '0');
  fs.mkdirSync(path.join(home, 'versions', '0', 'src'), { recursive: true });
  fs.writeFileSync(path.join(home, 'previous.txt'), '7');
  fs.writeFileSync(path.join(process.env.SHEETMETAL_DATA, 'update-state.json'),
    JSON.stringify({ from: '7', to: '0', backup: name, schema_before: 1 }));
  let r = await admin.get('/api/update');
  assert.equal(r.data.rollback_loses_data, true);
  setRestartHandler(() => { restarts += 1; openDb(); }); // the "old code" starting again
  r = await admin.post('/api/update/rollback', { confirm: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.restored, name);
  const { data } = await admin.get('/api/clients');
  assert.ok(!data.clients.some((x) => x.name === 'عميل بعد التحديث'));
  assert.ok(getDb().prepare("SELECT 1 FROM audit_log WHERE action = 'rollback'").get());
});

test('share page: wifi links with QR codes, token never sent back', async () => {
  let r = await admin.put('/api/share/settings', { tunnel_enabled: false, tunnel_token: 'secret-token', tunnel_url: 'https://warsha.example.com' });
  assert.equal(r.status, 200);
  r = await admin.get('/api/share');
  assert.equal(r.status, 200);
  assert.equal(r.data.settings.tunnel_token_set, true);
  assert.ok(!JSON.stringify(r.data).includes('secret-token'));
  for (const l of r.data.lan) assert.match(l.qr, /^<svg/);
  const a = getDb().prepare("SELECT after_json FROM audit_log WHERE entity = 'settings' ORDER BY id DESC").get();
  assert.ok(!a.after_json.includes('secret-token'));
  assert.equal((await admin.put('/api/share/settings', { tunnel_url: 'http://x' })).status, 400);
});
