// A newer SheetMetal-Setup never edits current.txt; the code it installed next to the launcher
// takes over the pointers itself when it runs (src/update.js adoptInstalledCode).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ROOT } from '../src/paths.js';
import { adoptInstalledCode } from '../src/update.js';

const files = ['current.txt', 'previous.txt'].map((f) => path.join(ROOT, f));

test('code next to the launcher adopts current.txt; versions\<build> code leaves it alone', () => {
  const saved = process.env.SHEETMETAL_HOME;
  assert.ok(files.every((f) => !fs.existsSync(f)), 'the checkout has no update pointers');
  try {
    // running from somewhere else (versions\<build>): nothing changes
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'safa-home-'));
    fs.writeFileSync(path.join(other, 'current.txt'), '7');
    process.env.SHEETMETAL_HOME = other;
    assert.equal(adoptInstalledCode(), false);
    assert.equal(fs.readFileSync(path.join(other, 'current.txt'), 'utf8'), '7');
    fs.rmSync(other, { recursive: true, force: true });

    // the launcher ran the Setup's code (home = this code's folder) while current.txt said 7
    process.env.SHEETMETAL_HOME = ROOT;
    fs.writeFileSync(files[0], '7');
    assert.equal(adoptInstalledCode(), true);
    assert.equal(fs.readFileSync(files[0], 'utf8'), '.');
    assert.equal(fs.readFileSync(files[1], 'utf8'), '7');
    assert.equal(adoptInstalledCode(), false); // already "."
  } finally {
    for (const f of files) fs.rmSync(f, { force: true });
    if (saved === undefined) delete process.env.SHEETMETAL_HOME; else process.env.SHEETMETAL_HOME = saved;
  }
});
