// Passwords (scrypt), session cookies and the permission middleware.
import crypto from 'crypto';
import { getDb, audit } from './db.js';
import { httpError } from './util.js';
import { can, permissionsOf } from './permissions.js';

const COOKIE = 'sheetmetal_s';
const SESSION_DAYS = 30;          // "remember this device"
const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
export const MIN_PASSWORD = 6;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [kind, saltB64, hashB64] = String(stored).split('$');
  if (kind !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

export function checkPasswordRule(password) {
  if (String(password || '').length < MIN_PASSWORD) {
    throw httpError(400, `كلمة السر لازم تكون ${MIN_PASSWORD} حروف أو أرقام على الأقل`);
  }
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(req, res, value, maxAgeSec) {
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`);
}

export function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  getDb()
    .prepare("INSERT INTO sessions (token_hash, user_id, expires_at, user_agent) VALUES (?, ?, datetime('now', ?), ?)")
    .run(sha(token), userId, `+${SESSION_DAYS} days`, String(req.headers['user-agent'] || '').slice(0, 200));
  setCookie(req, res, token, SESSION_DAYS * 86400);
}

export function endSession(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
  setCookie(req, res, '', 0);
}

// Attaches req.user (or null) from the session cookie.
export function loadUser(req, _res, next) {
  req.user = null;
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) {
    req.user = getDb().prepare(`
      SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > datetime('now') AND u.active = 1`).get(sha(token)) || null;
  }
  next();
}

export function requireUser(req, _res, next) {
  if (!req.user) return next(httpError(401, 'لازم تسجل دخول الأول'));
  next();
}

export const requirePerm = (perm) => (req, _res, next) => {
  if (!req.user) return next(httpError(401, 'لازم تسجل دخول الأول'));
  if (!can(req.user, perm)) return next(httpError(403, 'مش مسموح لك بالحركة دي'));
  next();
};

export function login(req, res, username, password) {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim());
  const fail = () => httpError(401, 'اسم المستخدم أو كلمة السر غلط');
  if (!user || !user.active) throw fail();
  if (user.locked_until && user.locked_until > new Date().toISOString()) {
    throw httpError(423, `الحساب اتقفل مؤقتاً بسبب محاولات غلط كتير. جرب تاني بعد ${LOCK_MINUTES} دقيقة.`);
  }
  if (!verifyPassword(String(password || ''), user.password_hash)) {
    const attempts = user.failed_attempts + 1;
    const lock = attempts >= MAX_ATTEMPTS ? new Date(Date.now() + LOCK_MINUTES * 60000).toISOString() : null;
    db.prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?')
      .run(lock ? 0 : attempts, lock, user.id);
    if (lock) audit(user.id, 'lockout', 'user', user.id);
    throw fail();
  }
  db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(user.id);
  startSession(req, res, user.id);
  return user;
}

export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    role: user.role,
    active: !!user.active,
    permissions: [...permissionsOf(user)],
  };
}
