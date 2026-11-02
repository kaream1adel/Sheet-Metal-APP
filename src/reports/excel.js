// ملخص العملاء as an Excel file, in the workbook's own layout: right-to-left, one row per
// client, a total row. Amounts are written in pounds (millimes / 1000) with 2 decimals.
import ExcelJS from 'exceljs';

export const SUMMARY_COLUMNS = [
  { header: 'العميل', key: 'name', width: 34 },
  { header: 'إجمالي المدين', key: 'debit', width: 16, money: true },
  { header: 'إجمالي الخصم', key: 'discount', width: 16, money: true },
  { header: 'إجمالي الدائن', key: 'credit', width: 16, money: true },
  { header: 'الرصيد النهائي', key: 'balance', width: 16, money: true },
  { header: 'آخر دفعة', key: 'last_payment', width: 14 },
  { header: 'قيمة آخر دفعة', key: 'last_payment_value', width: 16, money: true },
  { header: 'عمر المديونية (يوم)', key: 'age', width: 18 },
];

const pounds = (m) => (m === null || m === undefined ? null : m / 1000);

export async function clientsSummaryWorkbook(summary) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'شركة الصفا';
  wb.created = new Date();
  const ws = wb.addWorksheet('ملخص العملاء', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 2 }] });
  ws.columns = SUMMARY_COLUMNS.map(({ key, width }) => ({ key, width }));
  ws.mergeCells(1, 1, 1, SUMMARY_COLUMNS.length);
  ws.getCell(1, 1).value = `شركة الصفا — ملخص العملاء${summary.as_of ? ` حتى ${summary.as_of}` : ''}`;
  ws.getCell(1, 1).font = { bold: true, size: 13 };
  const head = ws.getRow(2);
  SUMMARY_COLUMNS.forEach((c, i) => { head.getCell(i + 1).value = c.header; });
  head.font = { bold: true };
  head.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE9EEF3' } };
    cell.border = { bottom: { style: 'thin' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  });
  for (const r of summary.rows) {
    ws.addRow({
      name: r.name, debit: pounds(r.debit_total), discount: pounds(r.discount_total), credit: pounds(r.credit_total),
      balance: pounds(r.balance), last_payment: r.last_payment_date || '', last_payment_value: pounds(r.last_payment_amount),
      age: r.debt_age_days ?? '',
    });
  }
  const t = summary.totals;
  const total = ws.addRow({ name: 'الإجمالي', debit: pounds(t.debit_total), discount: pounds(t.discount_total), credit: pounds(t.credit_total), balance: pounds(t.balance) });
  total.font = { bold: true };
  total.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE9EEF3' } };
    cell.border = { top: { style: 'thin' } };
  });
  SUMMARY_COLUMNS.forEach((c, i) => { if (c.money) ws.getColumn(i + 1).numFmt = '#,##0.00'; });
  return wb.xlsx.writeBuffer();
}
