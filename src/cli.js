// Command line helpers.  node src/cli.js create-admin <username> <password> [display name]
import { openDb, getDb, closeDb } from './db.js';
import { hashPassword, MIN_PASSWORD } from './auth.js';

const [cmd, username, password, ...name] = process.argv.slice(2);

if (cmd === 'create-admin') {
  if (!username || !password || password.length < MIN_PASSWORD) {
    console.error(`usage: create-admin <username> <password (≥${MIN_PASSWORD})> [display name]`);
    process.exit(1);
  }
  openDb();
  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    db.prepare("UPDATE users SET password_hash = ?, role = 'admin', active = 1, failed_attempts = 0, locked_until = NULL WHERE id = ?")
      .run(hashPassword(password), existing.id);
    console.log(`admin "${username}" updated`);
  } else {
    db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, ?, 'admin')")
      .run(username, name.join(' ') || username, hashPassword(password));
    console.log(`admin "${username}" created`);
  }
  closeDb();
} else {
  console.error('commands: create-admin');
  process.exit(1);
}
