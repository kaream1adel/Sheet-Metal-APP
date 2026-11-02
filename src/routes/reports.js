// Module reports (التقارير والرئيسية) — mounted at /api/reports in src/app.js.
//
//   GET  /home                     المركز المالي (money.view)
//   GET  /clients  /clients.xlsx   ملخص العملاء (reports + money.view)
//   GET  /aging                    أعمار الديون (reports + money.view)
//   GET  /profit                   مكسب الشهر (reports + money.view)
//   GET  /cashflow                 التدفق المتوقع (reports + money.view)
//   GET  /partners                 جاري الشركاء (reports + money.view)
//   GET  /production               الإنتاج — quantities only (reports or operations.*)
//   GET  /audit  /audit/filters    سجل التعديلات (reports; money and free text removed without money.view)
//   GET/POST/PATCH/DELETE /followups, POST /followups/:id/done   متابعة التحصيل (reports)
//
// Nothing here posts to the ledger: reports read it. Every response passes stripMoney().
// ?as_of=YYYY-MM-DD (a real calendar date) moves "today" for the date-based reports.
import { Router } from 'express';
import { requirePerm, requireAny } from '../auth.js';
import { stripMoney } from '../money.js';
import { httpError, asyncRoute } from '../util.js';
import { MACHINES } from '../ledger.js';
import { dateParam, monthParam, today } from '../reports/dates.js';
import { clientsSummary, aging, clientDebtAge, lastPayment } from '../reports/clients.js';
import { financialPosition, chequesDue, needsAttention, homeCounters } from '../reports/position.js';
import { monthProfit, profitSeries } from '../reports/profit.js';
import { expectedCashflow } from '../reports/cashflow.js';
import { partnersReport } from '../reports/partners.js';
import { productionReport, GROUPS } from '../reports/production.js';
import { auditEntries, auditFilters } from '../reports/audit.js';
import { listFollowUps, createFollowUp, updateFollowUp, completeFollowUp, deleteFollowUp } from '../reports/followups.js';
import { clientsSummaryWorkbook } from '../reports/excel.js';
import { can } from '../permissions.js';
import { getDb } from '../db.js';

export const reports = Router();

const money = [requirePerm('reports'), requirePerm('money.view')];
const asOf = (req) => dateParam(req.query.as_of, 'التاريخ', today(), 'as_of');
const send = (req, res, data) => res.json(stripMoney(req.user, data));
const idParam = (v, label = 'رقم') => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw httpError(400, `${label} غلط`);
  return n;
};

// ---------- الرئيسية: المركز المالي ----------
reports.get('/home', requirePerm('money.view'), (req, res) => {
  const d = asOf(req);
  send(req, res, {
    as_of: d,
    position: financialPosition(d),
    cheques_due: chequesDue(d, 7),
    counters: homeCounters(d),
    attention: needsAttention(d),
    follow_ups_due: can(req.user, 'reports') ? listFollowUps(req.user, { status: 'due', asOf: d }).slice(0, 6) : [],
  });
});

// ---------- ملخص العملاء ----------
reports.get('/clients', ...money, (req, res) => {
  send(req, res, clientsSummary({ asOf: asOf(req), includeInactive: req.query.active_only !== '1' }));
});

reports.get('/clients.xlsx', ...money, asyncRoute(async (req, res) => {
  const d = asOf(req);
  const buf = await clientsSummaryWorkbook(clientsSummary({ asOf: d, includeInactive: req.query.active_only !== '1' }));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="clients-summary-${d}.xlsx"; filename*=UTF-8''${encodeURIComponent(`ملخص العملاء ${d}.xlsx`)}`);
  res.send(Buffer.from(buf));
}));

// ---------- أعمار الديون ----------
reports.get('/aging', ...money, (req, res) => send(req, res, aging({ asOf: asOf(req) })));

// ---------- مكسب الشهر ----------
reports.get('/profit', ...money, (req, res) => {
  const month = monthParam(req.query.month, today().slice(0, 7));
  const n = Math.min(Math.max(Number(req.query.months) || 6, 1), 24);
  send(req, res, { ...monthProfit(month), series: profitSeries(month, n) });
});

// ---------- التدفق المتوقع ----------
reports.get('/cashflow', ...money, (req, res) => send(req, res, expectedCashflow(asOf(req), 4)));

// ---------- جاري الشركاء ----------
reports.get('/partners', ...money, (req, res) => send(req, res, partnersReport()));

// ---------- الإنتاج (no money: the workshop manager sees it) ----------
reports.get('/production', requireAny('reports', 'operations.record', 'operations.approve'), (req, res) => {
  const from = dateParam(req.query.from, 'تاريخ البداية', null, 'from');
  const to = dateParam(req.query.to, 'تاريخ النهاية', null, 'to');
  if (from && to && from > to) throw httpError(400, 'تاريخ البداية بعد تاريخ النهاية', { field: 'from' });
  const group = req.query.group || 'machine';
  if (!(group in GROUPS)) throw httpError(400, 'اختار التجميع: المكنة، الفني، العميل أو الشهر');
  const machine = req.query.machine || null;
  if (machine && !MACHINES.includes(machine)) throw httpError(400, 'المكنة غلط');
  send(req, res, productionReport({ from, to, group, machine,
    technicianId: idParam(req.query.technician_id, 'الفني'), clientId: idParam(req.query.client_id, 'العميل') }));
});

// ---------- سجل التعديلات ----------
reports.get('/audit/filters', requirePerm('reports'), (req, res) => send(req, res, auditFilters(req.user)));
reports.get('/audit', requirePerm('reports'), (req, res) => {
  const from = dateParam(req.query.from, 'تاريخ البداية', null, 'from');
  const to = dateParam(req.query.to, 'تاريخ النهاية', null, 'to');
  if (from && to && from > to) throw httpError(400, 'تاريخ البداية بعد تاريخ النهاية', { field: 'from' });
  send(req, res, auditEntries(req.user, {
    from, to, userId: idParam(req.query.user_id, 'المستخدم'), entity: req.query.entity || null, action: req.query.action || null,
    entityId: idParam(req.query.entity_id), q: req.query.q ? String(req.query.q).slice(0, 80) : null,
    beforeId: idParam(req.query.before_id), limit: req.query.limit,
  }));
});

// ---------- متابعة التحصيل ----------
const STATUSES = new Set(['due', 'open', 'done', 'all']);
reports.get('/followups', requirePerm('reports'), (req, res) => {
  const status = req.query.status || 'open';
  if (!STATUSES.has(status)) throw httpError(400, 'الحالة غلط');
  const d = asOf(req);
  const partyId = idParam(req.query.party_id, 'الطرف');
  const out = { as_of: d, follow_ups: listFollowUps(req.user, { status, partyId, asOf: d }) };
  // The client file's tab: his balance, last payment and debt age next to the notes.
  if (partyId && can(req.user, 'money.view')) {
    const p = getDb().prepare('SELECT kind FROM parties WHERE id = ?').get(partyId);
    if (p?.kind === 'client') out.summary = { ...lastPayment(partyId, d), ...clientDebtAge(partyId, d) };
  }
  send(req, res, out);
});

reports.post('/followups', requirePerm('reports'), (req, res) => {
  res.status(201);
  send(req, res, { follow_up: createFollowUp(req.user, req.body || {}) });
});

reports.patch('/followups/:id', requirePerm('reports'), (req, res) => {
  send(req, res, { follow_up: updateFollowUp(req.user, req.params.id, req.body || {}) });
});

reports.post('/followups/:id/done', requirePerm('reports'), (req, res) => {
  send(req, res, completeFollowUp(req.user, req.params.id, req.body || {}));
});

reports.delete('/followups/:id', requirePerm('reports'), (req, res) => {
  send(req, res, { deleted: deleteFollowUp(req.user, req.params.id) });
});

reports.use((_req, _res, next) => next(httpError(404, 'التقرير ده مش موجود')));
