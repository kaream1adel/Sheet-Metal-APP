// Module treasury (الخزينة والبنك، المصروفات، الشيكات): balances + movements, إيصال استلام,
// إذن صرف, تحويل, جرد الخزينة, المصروفات (list, new voucher, recurring), أوراق القبض / أوراق الدفع,
// and the A4 / half-page print pages of إيصال استلام نقدية / إذن صرف.
// The screens live in treasury-cash.js, treasury-expenses.js and treasury-cheques.js.
// Statement rows open their document here: receipt, voucher, cheque, transfer, cash_count.
import { registerDocOpener } from '../statement.js';
import {
  treasuryHome, receiptNew, receiptView, printReceipt, transferNew, transferView, cashCount, docHref,
} from './treasury-cash.js';
import { voucherNew, voucherView, printVoucher, expensesList, recurringExpenses } from './treasury-expenses.js';
import { chequesIn, chequesOut, chequeView } from './treasury-cheques.js';

export {
  treasuryHome, receiptNew, receiptView, printReceipt, transferNew, transferView, cashCount,
  voucherNew, voucherView, printVoucher, expensesList, recurringExpenses, chequesIn, chequesOut, chequeView, docHref,
};
export { chequeActions } from './treasury-cheques.js';
export { amountWords } from './treasury-words.js';

// each with the permission its screen needs, so a row never leads to «الصفحة دي مش ليك»
const OPEN_PERMS = { receipt: ['treasury'], voucher: ['treasury', 'expenses.record'], cheque: ['cheques'], transfer: ['treasury'], cash_count: ['treasury'] };
for (const [type, perms] of Object.entries(OPEN_PERMS)) {
  registerDocOpener(type, (row) => { const href = docHref(type, row.doc_id); if (href) location.hash = href; }, ...perms);
}

export const routes = [
  { path: '#/treasury', screen: treasuryHome, perm: 'treasury' },
  { path: '#/treasury/receipt', screen: receiptNew, perm: 'treasury' },
  { path: '#/treasury/receipts/:id', screen: receiptView, perm: 'treasury' },
  { path: '#/treasury/transfer', screen: transferNew, perm: 'treasury' },
  { path: '#/treasury/transfers/:id', screen: transferView, perm: 'treasury' },
  { path: '#/treasury/count', screen: cashCount, perm: 'treasury' },
  { path: '#/expenses', screen: expensesList, perm: 'expenses.record' },
  { path: '#/expenses/new', screen: voucherNew, perm: 'expenses.record' },
  { path: '#/expenses/recurring', screen: recurringExpenses, perm: 'treasury' },
  { path: '#/expenses/:id', screen: voucherView, any: ['treasury', 'expenses.record'] },
  { path: '#/cheques/in', screen: chequesIn, perm: 'cheques' },
  { path: '#/cheques/out', screen: chequesOut, perm: 'cheques' },
  { path: '#/cheques/:id', screen: chequeView, perm: 'cheques' },
  { path: '#/print/receipt/:id', screen: printReceipt, perm: 'treasury' },
  { path: '#/print/voucher/:id', screen: printVoucher, any: ['treasury', 'expenses.record'] },
];
