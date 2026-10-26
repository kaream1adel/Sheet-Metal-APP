// The Express app (no listening here, so tests can start it on any port).
import express from 'express';
import { PUBLIC_DIR } from './paths.js';
import { getDb, audit } from './db.js';
import { loadUser, login, endSession, startSession, publicUser, hashPassword, checkPasswordRule, requireUser } from './auth.js';
import { HttpError, httpError, cleanText } from './util.js';
import { people } from './routes/people.js';
import { sheets } from './routes/sheets.js';

export const APP_VERSION = '0.1.0';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback'); // the tunnel connects from localhost
  app.use(express.json({ limit: '1mb' }));

  // State-changing requests must be JSON: a plain HTML form on another site can't send that.
  app.use('/api', (req, _res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.is('application/json')) {
      return next(httpError(415, 'طلب غير مدعوم'));
    }
    next();
  });
  app.use(loadUser);

  // ---------- session ----------
  app.get('/api/session', (req, res) => {
    const needsSetup = getDb().prepare('SELECT COUNT(*) n FROM users').get().n === 0;
    res.json({ user: publicUser(req.user), needsSetup, version: APP_VERSION });
  });

  // First run only: create the admin account.
  app.post('/api/setup', (req, res) => {
    const db = getDb();
    const { username, display_name, password } = req.body || {};
    const u = cleanText(username, 40);
    if (!u) throw httpError(400, 'اكتب اسم المستخدم');
    checkPasswordRule(password);
    const id = db.transaction(() => {
      if (db.prepare('SELECT COUNT(*) n FROM users').get().n > 0) throw httpError(409, 'البرنامج متجهز بالفعل');
      const r = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, ?, 'admin')")
        .run(u, cleanText(display_name, 60) || u, hashPassword(password));
      audit(r.lastInsertRowid, 'setup', 'user', r.lastInsertRowid);
      return r.lastInsertRowid;
    })();
    startSession(req, res, id);
    res.status(201).json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)) });
  });

  app.post('/api/login', (req, res) => {
    const user = login(req, res, req.body?.username, req.body?.password);
    res.json({ user: publicUser(user) });
  });

  app.post('/api/logout', (req, res) => {
    endSession(req, res);
    res.json({ ok: true });
  });

  app.get('/api/audit', requireUser, (req, res) => {
    if (!publicUser(req.user).permissions.includes('settings.manage')) throw httpError(403, 'مش مسموح لك بالحركة دي');
    const rows = getDb().prepare(`
      SELECT a.*, u.display_name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
      WHERE (? IS NULL OR a.entity = ?) AND (? IS NULL OR a.entity_id = ?)
      ORDER BY a.id DESC LIMIT 200`).all(req.query.entity ?? null, req.query.entity ?? null, req.query.id ?? null, req.query.id ?? null);
    res.json({ audit: rows });
  });

  app.use('/api', people);
  app.use('/api', sheets);
  app.use('/api', (_req, _res, next) => next(httpError(404, 'مش موجود')));

  // ---------- the screens ----------
  app.use(express.static(PUBLIC_DIR, { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));
  app.get('*', (_req, res) => res.sendFile('index.html', { root: PUBLIC_DIR }));

  // ---------- errors: always Arabic, never a stack trace to the browser ----------
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'طلب غير مفهوم' });
    console.error(err);
    res.status(500).json({ error: 'حصلت مشكلة في البرنامج. جرب تاني، ولو اتكررت بلغ الأدمن.' });
  });
  return app;
}
