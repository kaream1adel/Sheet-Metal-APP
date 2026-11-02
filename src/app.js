// The Express app (no listening here, so tests can start it on any port).
import express from 'express';
import { createRequire } from 'module';
import { join, dirname } from 'path';
import { PUBLIC_DIR } from './paths.js';
import { getDb, audit } from './db.js';
import { loadUser, login, endSession, startSession, publicUser, hashPassword, checkPasswordRule, requirePerm } from './auth.js';
import { HttpError, httpError, cleanText } from './util.js';
import { can } from './permissions.js';
import { APP_VERSION } from './version.js';
import { users } from './routes/users.js';
import { parties } from './routes/parties.js';
import { lookups } from './routes/lookups.js';
import { system } from './routes/system.js';
// Module routers. Each module owns its file; the mount points are fixed here.
import { operations } from './routes/operations.js';
import { pricing } from './routes/pricing.js';
import { treasury } from './routes/treasury.js';
import { reports } from './routes/reports.js';
import { importer } from './routes/import.js';

export { APP_VERSION };

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback'); // the tunnel connects from localhost
  // Nothing we serve may be sniffed into another type (an uploaded photo stays a photo).
  app.use((_req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); next(); });
  // The session is read before any body, so a big body is parsed only for a signed-in user
  // who may upload there (the phone link makes this PC reachable from the internet).
  app.use(loadUser);
  // Sheet photos (operations) and the Excel file (import) are big; everything else is small.
  const BIG = [
    [/^\/api\/operations\/photos$/, ['operations.record']],
    [/^\/api\/operations\/sheets\/\d+\/photo$/, ['operations.record']],
    [/^\/api\/treasury\/vouchers\/\d+\/photo$/, ['expenses.record', 'treasury']],
    [/^\/api\/import(\/|$)/, ['import']],
  ];
  const bigJson = express.json({ limit: '25mb' });
  app.use((req, res, next) => {
    const hit = req.method === 'POST' && BIG.find(([re]) => re.test(req.path));
    if (!hit) return next();
    if (!req.user) return next(httpError(401, 'لازم تسجل دخول الأول'));
    if (!hit[1].some((p) => can(req.user, p))) return next(httpError(403, 'مش مسموح لك بالحركة دي'));
    bigJson(req, res, next);
  });
  app.use(express.json({ limit: '1mb' }));

  // State-changing requests must be JSON: a plain HTML form on another site can't send that.
  app.use('/api', (req, _res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.is('application/json')) {
      return next(httpError(415, 'طلب غير مدعوم'));
    }
    next();
  });

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

  // سجل التعديلات (raw). The reports module builds the friendly screen on top of it.
  // Its before/after JSON carries totals, credit limits and the like: money.view as well.
  app.get('/api/audit', requirePerm('reports'), requirePerm('money.view'), (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    const rows = getDb().prepare(`
      SELECT a.*, u.display_name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
      WHERE (? IS NULL OR a.entity = ?) AND (? IS NULL OR a.entity_id = ?)
      ORDER BY a.id DESC LIMIT ?`).all(req.query.entity ?? null, req.query.entity ?? null, req.query.id ?? null, req.query.id ?? null, limit);
    res.json({ audit: rows });
  });

  app.use('/api', users);
  app.use('/api', parties);
  app.use('/api', lookups);
  app.use('/api', system);
  app.use('/api/operations', operations);
  app.use('/api/pricing', pricing);
  app.use('/api/treasury', treasury);
  app.use('/api/reports', reports);
  app.use('/api/import', importer);
  app.use('/api', (_req, _res, next) => next(httpError(404, 'مش موجود')));

  // ---------- the screens ----------
  // The interface font (IBM Plex Sans Arabic), served locally so it works offline.
  const fonts = join(dirname(createRequire(import.meta.url).resolve('@fontsource/ibm-plex-sans-arabic/package.json')), 'files');
  app.use('/fonts', express.static(fonts, { maxAge: '30d', immutable: true }));
  app.use(express.static(PUBLIC_DIR, { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));
  app.get('*', (_req, res) => res.sendFile('index.html', { root: PUBLIC_DIR }));

  // ---------- errors: always Arabic, never a stack trace to the browser ----------
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'طلب غير مفهوم' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'الملف كبير قوي — صوّر الورقة تاني من غير زوم' });
    if (/SQLITE_CONSTRAINT/.test(err.code || '')) {
      console.error(err.message);
      return res.status(409).json({ error: 'البيانات دي متعارضة مع حاجة متسجلة قبل كده' });
    }
    console.error(err);
    res.status(500).json({ error: 'حصلت مشكلة في البرنامج. جرب تاني، ولو اتكررت بلغ الأدمن.' });
  });
  return app;
}
