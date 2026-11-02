// Module pricing (التسعير) — mounted at /api/pricing in src/app.js.
//
//   GET  /queue                         أوراق مستنية تسعير (grouped by date, counts by client)
//   GET  /sheets/:id                    تسعير ورقة: items by client (generated idempotently)
//   POST /sheets/:id/apply-rate         { item_id, scope: 'sheet' | 'similar' }
//   POST /sheets/:id/confirm            { client_id? } confirm every suggested rate
//   PUT  /sheets/:id/adjustments        { client_id, discount, addition, note }   (draft خصم / إضافة)
//   POST /sheets/:id/post               { client_ids? }  اعتماد التسعير والترحيل
//   PATCH /items/:id                    { rate, confirm, billing, length_cm, width_cm, thickness }
//   POST /items/:id/exclude             { reason }  ·  POST /items/:id/restore
//   GET  /batches/:id                   بيان أعمال (opened from كشف الحساب)
//   POST /batches/:id/correct           تصحيح سعر { reason, items: [{ id, rate, billing }], discount, addition, note }
//   GET  /general · PUT /general        الأسعار العامة { prices: [{ section, band, rate, min_charge }] }
//   GET  /manual?client_id · POST /manual · GET /manual/:id · POST /manual/:id/cancel   قيد يدوي على عميل
//   GET  /clients/:id/sheet?from&to     شيت التسعير (any signed-in user; staff get quantities only)
//
// Rules: a permission on every route, stripMoney() on every response, postings only through
// src/ledger.js (inside src/pricing/service.js), audit() inside the same transaction.
import { Router } from 'express';
import { requireUser, requirePerm } from '../auth.js';
import { stripMoney } from '../money.js';
import { httpError } from '../util.js';
import * as P from '../pricing/service.js';

export const pricing = Router();

const pricer = requirePerm('pricing');
const id = (req) => {
  const n = Number(req.params.id);
  if (!Number.isSafeInteger(n) || n <= 0) throw httpError(404, 'مش موجود');
  return n;
};
const send = (req, res, data, status = 200) => res.status(status).json(stripMoney(req.user, data));

pricing.get('/queue', pricer, (req, res) => send(req, res, P.pricingQueue(req.user.id)));
pricing.get('/waiting-count', pricer, (req, res) => send(req, res, { sheets: P.waitingSheetsCount() }));

pricing.get('/sheets/:id', pricer, (req, res) => send(req, res, P.sheetForPricing(id(req), req.user.id)));

pricing.post('/sheets/:id/apply-rate', pricer, (req, res) => {
  const n = P.applyRate(id(req), Number(req.body?.item_id), req.body?.scope, req.user.id);
  send(req, res, { applied: n, sheet: P.sheetForPricing(id(req), req.user.id) });
});

pricing.post('/sheets/:id/confirm', pricer, (req, res) => {
  const n = P.confirmSuggested(id(req), req.body?.client_id ? Number(req.body.client_id) : null, req.user.id);
  send(req, res, { confirmed: n, sheet: P.sheetForPricing(id(req), req.user.id) });
});

pricing.put('/sheets/:id/adjustments', pricer, (req, res) => {
  send(req, res, { adjustment: P.setAdjustment(id(req), req.body || {}, req.user.id) });
});

pricing.post('/sheets/:id/post', pricer, requirePerm('money.post'), (req, res) => {
  const ids = Array.isArray(req.body?.client_ids) && req.body.client_ids.length ? req.body.client_ids : null;
  const r = P.postSheet(id(req), { clientIds: ids, userId: req.user.id });
  send(req, res, { ...r, sheet: P.sheetForPricing(id(req), req.user.id) }, 201);
});

pricing.patch('/items/:id', pricer, (req, res) => send(req, res, { item: P.updateItem(id(req), req.body || {}, req.user.id) }));
pricing.post('/items/:id/exclude', pricer, (req, res) => send(req, res, { item: P.excludeItem(id(req), req.body?.reason, req.user.id) }));
pricing.post('/items/:id/restore', pricer, (req, res) => send(req, res, { item: P.restoreItem(id(req), req.user.id) }));

pricing.get('/batches/:id', requirePerm('money.view'), (req, res) => send(req, res, P.batchView(id(req))));
pricing.post('/batches/:id/correct', pricer, requirePerm('money.post'), (req, res) => {
  const b = req.body || {};
  const nb = P.correctBatch(id(req), { reason: b.reason, items: b.items, discount: b.discount, addition: b.addition, note: b.note, userId: req.user.id });
  send(req, res, { batch: nb }, 201);
});

pricing.get('/general', pricer, (req, res) => send(req, res, { prices: P.generalPrices() }));
pricing.put('/general', pricer, (req, res) => {
  const changed = P.saveGeneralPrices(req.body?.prices, req.user.id);
  send(req, res, { changed, prices: P.generalPrices() });
});

const manualPerm = requirePerm('money.post');
pricing.get('/manual', requirePerm('money.view'), (req, res) => {
  send(req, res, { entries: P.listManualEntries(req.query.client_id ? Number(req.query.client_id) : null) });
});
pricing.post('/manual', manualPerm, requirePerm('money.view'), (req, res) => send(req, res, { entry: P.createManualEntry(req.body || {}, req.user.id) }, 201));
pricing.get('/manual/:id', requirePerm('money.view'), (req, res) => send(req, res, { entry: P.manualEntryView(id(req)) }));
pricing.post('/manual/:id/cancel', manualPerm, requirePerm('money.view'), (req, res) => {
  send(req, res, { entry: P.cancelManualEntry(id(req), req.body?.reason, req.user.id) });
});

pricing.get('/clients/:id/sheet', requireUser, (req, res) => {
  send(req, res, P.clientPricingSheet(id(req), { from: req.query.from || null, to: req.query.to || null }));
});

// Anything else under /api/pricing is an unknown path.
pricing.use(requireUser, (_req, res) => res.status(404).json({ error: 'مش موجود' }));
