// Fails when the repo holds anything that must never be public: data, backups, databases,
// spreadsheets (the real workbook must never be committed; tests build a synthetic one),
// and amounts taken from the real workbook.
// Runs in CI on every push and pull request.
//
// Real amounts: the figures known to come from the workbook are kept here only as salted
// fingerprints (never the figure itself, the repo is public). Every number in every tracked
// text file is normalised — read as pounds and as millimes, rounded to the piastre, digits
// only, trailing zeros dropped — and compared with them. On the shop PC, more real figures
// can be listed one per line in data/real-amounts.txt (data/ is never committed).
import { execSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';

const files = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean);
const bad = files.filter((f) => /(^|\/)(data|backups|versions)\//i.test(f)
  || /\.(sqlite|sqlite-wal|sqlite-shm|db|bak|tar\.gz|zip|xlsx|xlsm|xls|csv)$/i.test(f)
  || /(^|\/)(\.env|config\.bat|cloudflared\.exe)$/i.test(f));
if (bad.length) {
  console.error('These files must never be in the public repo:\n' + bad.join('\n'));
  process.exit(1);
}

const fp = (digits) => crypto.createHash('sha256').update(`safa:${digits}`).digest('hex').slice(0, 16);
// the two client balances the design spec quotes from the workbook
const REAL = new Set(['875641b0f8161acf', '09402def4a9e03a9']);

// "12,345.67" / "12345.671234" / 12345670 (millimes) -> "1234567"
const forms = (token) => {
  const v = Number(token.replace(/,/g, ''));
  if (!Number.isFinite(v)) return [];
  const norm = (x) => Math.abs(x).toFixed(2).replace('.', '').replace(/^0+/, '').replace(/0+$/, '');
  return [norm(v), Number.isInteger(v) ? norm(v / 1000) : null].filter((d) => d && d.length >= 5);
};

const local = new Set();
if (fs.existsSync('data/real-amounts.txt')) {
  for (const l of fs.readFileSync('data/real-amounts.txt', 'utf8').split(/\r?\n/)) for (const d of forms(l.trim())) local.add(d);
}

const leaks = [];
for (const f of files) {
  if (!/\.(js|mjs|cjs|json|md|html|css|txt|yml|yaml|bat|ps1|sql)$/i.test(f) || f === 'package-lock.json' || !fs.existsSync(f)) continue;
  const text = fs.readFileSync(f, 'utf8');
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
      if (forms(m[0]).some((d) => REAL.has(fp(d)) || local.has(d))) leaks.push(`${f}:${i + 1}`);
    }
  });
}
if (leaks.length) {
  console.error('These lines hold an amount from the real workbook (use an invented amount):\n' + [...new Set(leaks)].join('\n'));
  process.exit(1);
}
console.log(`ok — ${files.length} files checked`);
