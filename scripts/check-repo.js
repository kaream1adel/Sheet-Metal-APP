// Fails when the repo holds anything that must never be public: data, backups, databases.
// Runs in CI on every push and pull request.
import { execSync } from 'child_process';

const files = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean);
const bad = files.filter((f) => /(^|\/)(data|backups|versions)\//i.test(f)
  || /\.(sqlite|sqlite-wal|sqlite-shm|db|bak|tar\.gz|zip)$/i.test(f)
  || /(^|\/)(\.env|config\.bat|cloudflared\.exe)$/i.test(f));
if (bad.length) {
  console.error('These files must never be in the public repo:\n' + bad.join('\n'));
  process.exit(1);
}
console.log(`ok — ${files.length} files checked`);
