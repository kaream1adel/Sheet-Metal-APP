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

// The fake Claude API answers a message the way the real one does: as server-sent events
// when the request asks to stream (the app streams), as JSON otherwise.
export function sendMessage(req, res, msg) {
  if (!req.body?.stream) return res.json(msg);
  res.setHeader('Content-Type', 'text/event-stream');
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev('message_start', { message: { ...msg, content: [], stop_reason: null, stop_sequence: null } });
  (msg.content || []).forEach((block, index) => {
    if (block.type === 'text') {
      ev('content_block_start', { index, content_block: { type: 'text', text: '' } });
      ev('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } });
    } else {
      ev('content_block_start', { index, content_block: block });
    }
    ev('content_block_stop', { index });
  });
  ev('message_delta', { delta: { stop_reason: msg.stop_reason, stop_sequence: null, stop_details: msg.stop_details ?? null }, usage: { output_tokens: msg.usage?.output_tokens ?? 0 } });
  ev('message_stop', {});
  res.end();
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
