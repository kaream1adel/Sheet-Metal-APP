// App settings stored as JSON values, with defaults.
import { getDb } from './db.js';

export const DEFAULT_SETTINGS = {
  company_name: 'شركة الصفا',
  company_phone: '',
  company_address: '',
  alert_days: 30,               // unpaid this many days after delivery → red in follow-up
  payment_methods: ['نقدي', 'تحويل بنكي', 'إنستاباي', 'فودافون كاش', 'محفظة إلكترونية', 'شيك'],
  backup_copy_dir: '',          // a USB stick or OneDrive folder that gets a copy of every backup
  tunnel_enabled: true,         // publish the app over HTTPS for phones (cloudflared)
  tunnel_token: '',             // a named Cloudflare tunnel (fixed link); empty = free quick link
  tunnel_url: '',               // the fixed link that goes with the token
};

export function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const { k, v } of getDb().prepare('SELECT k, v FROM settings').all()) {
    if (k in DEFAULT_SETTINGS) {
      try { out[k] = JSON.parse(v); } catch { /* keep default */ }
    }
  }
  return out;
}

export function setSettings(values) {
  const db = getDb();
  const up = db.prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v');
  for (const [k, v] of Object.entries(values)) if (k in DEFAULT_SETTINGS) up.run(k, JSON.stringify(v));
  return getSettings();
}

// Next serial number for a printed document (statement, delivery note, receipt).
export function nextSerial(kind) {
  const db = getDb();
  const key = `seq_${kind}`;
  const cur = Number(db.prepare('SELECT v FROM meta WHERE k = ?').get(key)?.v || 0) + 1;
  db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(key, String(cur));
  return cur;
}

// Small internal values (last backup time, last update check, ...).
export function getMeta(k) {
  return getDb().prepare('SELECT v FROM meta WHERE k = ?').get(k)?.v ?? null;
}
export function setMeta(k, v) {
  getDb().prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v === null ? null : String(v));
}
