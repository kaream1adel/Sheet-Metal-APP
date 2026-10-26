// Starts the app on a random port with a throw-away database.
import fs from 'fs';
import os from 'os';
import path from 'path';

export async function startApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sheetmetal-test-'));
  process.env.SHEETMETAL_DATA = dir;
  const { openDb, closeDb } = await import('../src/db.js');
  const { createApp } = await import('../src/app.js');
  openDb();
  const server = await new Promise((resolve) => {
    const s = createApp().listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const stop = async () => {
    await new Promise((r) => server.close(r));
    closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { base, stop };
}

// A tiny client that keeps its own session cookie, like one browser.
export function client(base) {
  let cookie = '';
  const call = async (method, url, body, { raw } = {}) => {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    let payload;
    if (body !== undefined) {
      if (raw) { payload = body; headers['content-type'] = 'text/plain'; } else { payload = JSON.stringify(body); headers['content-type'] = 'application/json'; }
    }
    const res = await fetch(base + url, { method, headers, body: payload });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  };
  return {
    get cookie() { return cookie; },
    get: (u) => call('GET', u),
    post: (u, b = {}, o) => call('POST', u, b, o),
    put: (u, b) => call('PUT', u, b),
    patch: (u, b) => call('PATCH', u, b),
    del: (u) => call('DELETE', u, {}),
  };
}
