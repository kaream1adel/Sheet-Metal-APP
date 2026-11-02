// Module operations (التشغيل): أوراق التشغيل, ورقة جديدة (grid.js with the paper columns of each
// machine), صوّر ورقة (AI reading jobs), المراجعة والاعتماد (red / yellow gate), أوامر الشغل,
// سجل الإنتاج, the staff home (المطلوب النهارده) and the client file's أوامر الشغل tab.
//
// Screen contract (app.js router): async (main, params, ctx).  Tab contract: async (box, party, ctx).
// The screens live in ops-*.js; the paper rules shared with the server in ops-paper.js.
import { sheetsList, sheetNew, sheetView, reviewQueue, reviewSheet } from './ops-sheets.js';
import { photoJobs } from './ops-photos.js';
import { workOrders, workOrderView, clientWorkOrdersTab } from './ops-orders.js';
import { homeStaff, productionLog } from './ops-home.js';

export { sheetsList, sheetNew, sheetView, reviewQueue, reviewSheet, photoJobs, workOrders, workOrderView, productionLog, homeStaff, clientWorkOrdersTab };

export const routes = [
  { path: '#/ops/sheets', screen: sheetsList, any: ['operations.record', 'operations.approve'] },
  { path: '#/ops/sheets/new', screen: sheetNew, perm: 'operations.record' },
  { path: '#/ops/sheets/:id', screen: sheetView, any: ['operations.record', 'operations.approve'] },
  { path: '#/ops/photos', screen: photoJobs, perm: 'operations.record' },
  { path: '#/ops/review', screen: reviewQueue, perm: 'operations.approve' },
  { path: '#/ops/review/:id', screen: reviewSheet, perm: 'operations.approve' },
  { path: '#/ops/orders', screen: workOrders, perm: 'workorders' },
  { path: '#/ops/orders/:id', screen: workOrderView, perm: 'workorders' },
  { path: '#/ops/production', screen: productionLog, any: ['operations.record', 'reports'] },
];
