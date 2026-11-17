// npm test — runs every test/*.test.js file by name. Node 20 accepts a folder after --test,
// Node 22 does not (it reads arguments as glob patterns), so the files are listed here instead.
import fs from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { ROOT } from '../src/paths.js';

const dir = join(ROOT, 'test');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort().map((f) => join(dir, f));
const r = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
