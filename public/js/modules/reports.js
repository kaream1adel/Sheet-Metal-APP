// Module reports (التقارير، الرئيسية للأدمن): المركز المالي on the admin home, ملخص العملاء,
// أعمار الديون, مكسب الشهر, التدفق المتوقع, جاري الشركاء, الإنتاج, سجل التعديلات, متابعة التحصيل,
// and the client file's المتابعة tab. Screens live in reports-*.js; this file is the contract
// the shell imports: homeAdmin, clientFollowUpsTab and routes.
import { homeAdmin } from './reports-home.js';
import { clientsSummary, aging, monthProfit, cashflow, partnersReport } from './reports-finance.js';
import { production } from './reports-production.js';
import { auditLog } from './reports-audit.js';
import { followUps, clientFollowUpsTab, newFollowUp } from './reports-followups.js';

export { homeAdmin, clientFollowUpsTab, newFollowUp, clientsSummary, aging, monthProfit, cashflow, partnersReport, production, auditLog, followUps };

export const routes = [
  { path: '#/reports/clients', screen: clientsSummary, perm: 'reports', any: ['money.view'] },
  { path: '#/reports/aging', screen: aging, perm: 'reports', any: ['money.view'] },
  { path: '#/reports/profit', screen: monthProfit, perm: 'reports', any: ['money.view'] },
  { path: '#/reports/cashflow', screen: cashflow, perm: 'reports', any: ['money.view'] },
  { path: '#/reports/partners', screen: partnersReport, perm: 'reports', any: ['money.view'] },
  // Quantities only: the workshop manager may open it too.
  { path: '#/reports/production', screen: production, any: ['reports', 'operations.record', 'operations.approve'] },
  { path: '#/reports/audit', screen: auditLog, perm: 'reports' },
  { path: '#/reports/followups', screen: followUps, perm: 'reports' },
];
