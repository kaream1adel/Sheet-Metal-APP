// A small synthetic «حسابات شركة الصفا» workbook for the import tests: invented names and
// amounts only, the same sheet shapes as the real file (both client-sheet layouts, statements
// linked by C2, the «عملاء» log with sync keys, partners, cheques, expenses, materials, store).
// Every formula cell carries a cached result, as Excel saves it.
import ExcelJS from 'exceljs';

const D = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const F = (formula, result) => ({ formula, result });

// Layout: the first column of each section; the 63-column sheets start material at AV (48),
// the newer layout here starts it one column later to prove columns come from the headers.
const SECTION_COLS = {
  press: ['التاريخ', 'القطعة', 'عدد القطع', 'عدد التنيات', 'نزلة تناية\n(أقل من 3مم)', 'الخامة', 'السمك (مم)\nتلقائي', 'نزلة تناية\n(3مم فأكبر)', 'سعر محدد؟\n(نعم / لا)', 'السعر المحدد\n(للقطعة)', 'مبلغ السعر\nالمحدد', 'إجمالي التكلفة\n(جنيه)'],
  laser: ['التاريخ', 'اللوح / القطعة', 'عدد الالواح', 'الوقت بالدقيقة', 'اجمالي الدقائق', 'الخامة', 'قطعة واحدة؟\n(نعم / لا)', 'إجمالي التكلفة\n(جنيه)'],
  punch: ['التاريخ', 'اللوح / القطعة', 'عدد الالواح', 'الوقت بالدقيقة', 'اجمالي الدقائق', 'الخامة', 'قطعة واحدة؟\n(نعم / لا)', 'إجمالي التكلفة\n(جنيه)'],
  louver: ['التاريخ', 'القطعة', 'عدد القطع', 'عدد لوفر', 'العدد الكلي للوفر', 'الخامة', 'إجمالي التكلفة\n(جنيه)'],
  shear: ['التاريخ', 'القطعة', 'عدد القطع', 'عدد القصات', 'نزلة مقص', 'الخامة', 'إجمالي التكلفة\n(جنيه)'],
  material: ['التاريخ', 'الكمية\n(عدد الألواح)', 'سمك بالمم', 'طول بالسم', 'عرض بالسم', 'الخامة', 'الوزن الكلي (كجم)\nتلقائي', 'وزن مجلفن\n(كجم)', 'وزن أسود\n(كجم)', 'وزن ستانلس\n(كجم)', 'وزن ألومنيوم\n(كجم)', 'إجمالي التكلفة\n(جنيه)'],
};
const TITLES = { press: 'التناية', laser: 'الليزر', punch: 'البنش', louver: 'اللوفر', shear: 'المقص', material: 'خامة من عندنا' };

function workSheet(wb, name, { materialAt = 48, rates = {}, rows = [], e1 = null, keysAt = null }) {
  const ws = wb.addWorksheet(name);
  const starts = { press: 1, laser: 14, punch: 23, louver: 32, shear: 40, material: materialAt };
  ws.getCell(1, 1).value = `${name} — حساب الشغل`;
  ws.getCell(1, 4).value = 'إجمالي المبلغ';
  ws.getCell(1, 5).value = F('SUM(E5,H5,R5,AA5,AJ5,AR5,BG5,K5)', e1 ?? undefined);
  const col = {};
  for (const [sec, heads] of Object.entries(SECTION_COLS)) {
    const s = starts[sec];
    ws.mergeCells(2, s, 2, s + heads.length - 1);
    ws.getCell(2, s).value = TITLES[sec];
    ws.getCell(4, s).value = 'السعر';
    heads.forEach((hd, i) => { ws.getCell(6, s + i).value = hd; });
    col[sec] = (field) => s + heads.indexOf(field);
  }
  // rates on row 4 (above the quantity they price) and the laser / punch minimum
  const R = { press_thin: ['press', 'نزلة تناية\n(أقل من 3مم)'], press_thick: ['press', 'نزلة تناية\n(3مم فأكبر)'], laser: ['laser', 'اجمالي الدقائق'],
    laser_min: ['laser', 'إجمالي التكلفة\n(جنيه)'], punch: ['punch', 'اجمالي الدقائق'], punch_min: ['punch', 'إجمالي التكلفة\n(جنيه)'],
    louver: ['louver', 'العدد الكلي للوفر'], shear: ['shear', 'نزلة مقص'], black: ['material', 'وزن أسود\n(كجم)'], galvanized: ['material', 'وزن مجلفن\n(كجم)'] };
  for (const [k, v] of Object.entries({ laser_min: 150, punch_min: 150, ...rates })) ws.getCell(4, col[R[k][0]](R[k][1])).value = v;
  // the density table after the material section
  const d = starts.material + SECTION_COLS.material.length + 1;
  ws.getCell(6, d).value = 'الخامة'; ws.getCell(6, d + 1).value = 'الكثافة (جم/سم³)'; ws.getCell(6, d + 2).value = 'المجموعة';
  [['اسود', 7.85, 'اسود'], ['حديد', 7.85, 'اسود'], ['مجلفن', 7.85, 'مجلفن'], ['المونيا', 2.7, 'المونيا']].forEach(([n, den, g], i) => {
    ws.getCell(7 + i, d).value = n; ws.getCell(7 + i, d + 1).value = den; ws.getCell(7 + i, d + 2).value = g;
  });
  if (keysAt) ws.getCell(4, keysAt).value = 'مفاتيح مزامنة';
  for (const r of rows) {
    for (const [sec, cells] of Object.entries(r)) {
      if (sec === 'row' || sec === 'keys') continue;
      for (const [field, v] of Object.entries(cells)) ws.getCell(r.row, col[sec](field)).value = v;
    }
    (r.keys || []).forEach((k, i) => { ws.getCell(r.row, keysAt + i).value = k; });
  }
  return ws;
}

function statement(wb, name, { link = null, rows = [], totals }) {
  const ws = wb.addWorksheet(name);
  ['التاريخ', 'الوصف', 'مدين', 'خصم', 'دائن', 'الرصيد'].forEach((t, i) => { ws.getCell(1, i + 1).value = t; });
  if (link) {
    ws.getCell(2, 2).value = `إجمالي حساب الشغل (تلقائي من شيت «${link.sheet}»)`;
    ws.getCell(2, 3).value = F(`'${link.sheet}'!E1`, link.e1);
  }
  for (const r of rows) {
    if (r.date !== undefined) ws.getCell(r.row, 1).value = r.date;
    if (r.desc) ws.getCell(r.row, 2).value = r.desc;
    if (r.debit !== undefined) ws.getCell(r.row, 3).value = r.debit;
    if (r.discount !== undefined) ws.getCell(r.row, 4).value = r.discount;
    if (r.credit !== undefined) ws.getCell(r.row, 5).value = r.credit;
  }
  ws.getCell(2, 8).value = 'إجمالي المدين (عليه)'; ws.getCell(2, 9).value = F('SUM(C2:C201)', totals.debit);
  ws.getCell(3, 8).value = 'إجمالي الخصم'; ws.getCell(3, 9).value = F('SUM(D2:D201)', totals.discount);
  ws.getCell(4, 8).value = 'إجمالي الدائن (المدفوع)'; ws.getCell(4, 9).value = F('SUM(E2:E201)', totals.credit);
  ws.getCell(5, 8).value = 'الرصيد النهائي (المتبقي)'; ws.getCell(5, 9).value = F('I2-I3-I4', totals.debit - totals.discount - totals.credit);
  return ws;
}

// The figures the workbook carries (and the import must reproduce).
export const EXPECT = {
  e1: { 'ورشة النسيم': 1406.8, 'النجمة': 114, 'عميل خارجي': 0 },
  clients: {
    'ورشة النسيم': { debit: 1606.8, discount: 6.8, credit: 1300 },
    'مصنع النجمة': { debit: 114, discount: 0, credit: 80 },
    'تجارة الفجر': { debit: 500, discount: 0, credit: 100 },
  },
  partner: { credit: 6300, debit: 2150 },
  expenses: 590, cheques: 2400, materials_cash: 2000, materials_cheque: 700, store: -4210,
};

export async function buildWorkbook() {
  const wb = new ExcelJS.Workbook();
  const summary = wb.addWorksheet('ملخص العملاء');
  wb.addWorksheet('حسابات الشركاء');

  // the older 63-column layout
  workSheet(wb, 'ورشة النسيم', {
    rates: { press_thin: 2, press_thick: 3, laser: 15, louver: 5, shear: 0.5, black: 48 },
    e1: 1406.8,
    rows: [
      { row: 7, press: { 'التاريخ': '27-8-2025', 'عدد القطع': 10, 'عدد التنيات': 3, 'نزلة تناية\n(أقل من 3مم)': F('C7*D7', 30), 'الخامة': '2مم اسود', 'نزلة تناية\n(3مم فأكبر)': F('0', 0), 'إجمالي التكلفة\n(جنيه)': F('E7*$E$4', 60) },
        laser: { 'التاريخ': '27-8-2025', 'عدد الالواح': 2, 'الوقت بالدقيقة': 5, 'اجمالي الدقائق': F('P7*Q7+P7', 12), 'الخامة': '2مم اسود', 'إجمالي التكلفة\n(جنيه)': F('R7*$R$4', 180) } },
      // a date Excel stored with day and month swapped (2/9 → 9 February)
      { row: 8, press: { 'التاريخ': D(2025, 2, 9), 'عدد القطع': 5, 'عدد التنيات': 2, 'نزلة تناية\n(أقل من 3مم)': F('C8*D8', 10), 'الخامة': 'اسود', 'إجمالي التكلفة\n(جنيه)': F('E8*$E$4', 20) },
        laser: { 'عدد الالواح': 1, 'الوقت بالدقيقة': 3, 'اجمالي الدقائق': F('P8*Q8+P8', 4), 'قطعة واحدة؟\n(نعم / لا)': 'نعم', 'إجمالي التكلفة\n(جنيه)': F('MAX(R8*$R$4,$U$4)', 150) } },
      { row: 9, press: { 'عدد القطع': 4, 'عدد التنيات': 2, 'الخامة': '4مم ستانلس', 'السمك (مم)\nتلقائي': F('4', 4), 'نزلة تناية\n(أقل من 3مم)': F('0', 0), 'نزلة تناية\n(3مم فأكبر)': F('C9*D9', 8), 'إجمالي التكلفة\n(جنيه)': F('H9*$H$4', 24) },
        louver: { 'التاريخ': '28-8-2025', 'عدد القطع': 6, 'عدد لوفر': 3, 'العدد الكلي للوفر': F('AH9*AI9', 18), 'إجمالي التكلفة\n(جنيه)': F('AJ9*$AJ$4', 90) },
        shear: { 'التاريخ': '28-8-2025', 'عدد القطع': 4, 'عدد القصات': 3, 'نزلة مقص': F('AP9*AQ9', 12), 'الخامة': '1مم', 'إجمالي التكلفة\n(جنيه)': F('AR9*$AR$4', 6) } },
      { row: 10, material: { 'التاريخ': '29-8-2025', 'الكمية\n(عدد الألواح)': 1, 'سمك بالمم': 2, 'طول بالسم': 100, 'عرض بالسم': 50, 'الخامة': 'اسود', 'الوزن الكلي (كجم)\nتلقائي': F('AX10/10*AY10*AZ10*AW10*7.85/1000', 7.85), 'وزن أسود\n(كجم)': F('BB10', 7.85), 'إجمالي التكلفة\n(جنيه)': F('BD10*$BD$4', 376.8) },
        punch: { 'التاريخ': '29-8-2025', 'عدد الالواح': 1, 'الوقت بالدقيقة': 4, 'اجمالي الدقائق': F('Y10*Z10+Y10', 5), 'إجمالي التكلفة\n(جنيه)': F('AA10*$AA$4', 0) } },
      // an amount typed over the formula (7.85 kg × 48 = 376.80, written 500)
      { row: 11, material: { 'الكمية\n(عدد الألواح)': 1, 'سمك بالمم': 2, 'طول بالسم': 100, 'عرض بالسم': 50, 'الخامة': 'اسود', 'الوزن الكلي (كجم)\nتلقائي': F('AX11/10*AY11*AZ11*7.85/1000', 7.85), 'وزن أسود\n(كجم)': F('BB11', 7.85), 'إجمالي التكلفة\n(جنيه)': 500 } },
    ],
  });

  // the newer layout: sync keys at the end, material one column later
  workSheet(wb, 'النجمة', {
    materialAt: 49, keysAt: 66, rates: { press_thin: 4, laser: 10 }, e1: 114,
    rows: [
      { row: 7, press: { 'التاريخ': '18/10/2025', 'عدد القطع': 3, 'عدد التنيات': 4, 'نزلة تناية\n(أقل من 3مم)': F('C7*D7', 12), 'الخامة': '1.5مم مجلفن', 'إجمالي التكلفة\n(جنيه)': F('E7*$E$4', 48) }, keys: ['OO_1_2_1700000000001_1'] },
      { row: 8, laser: { 'التاريخ': '19/10/2025', 'عدد الالواح': 1, 'الوقت بالدقيقة': 4, 'اجمالي الدقائق': F('P8*Q8+P8', 5), 'الخامة': '2مم اسود', 'إجمالي التكلفة\n(جنيه)': F('R8*$R$4', 50) }, keys: [null, 'OO_2_2_1700000000002_2'] },
      { row: 9, press: { 'التاريخ': '20/10/2025', 'عدد القطع': 2, 'عدد التنيات': 2, 'نزلة تناية\n(أقل من 3مم)': F('C9*D9', 4), 'إجمالي التكلفة\n(جنيه)': F('E9*$E$4', 16) } },
    ],
  });
  workSheet(wb, 'عميل خارجي', {
    materialAt: 49, keysAt: 66,
    rows: [{ row: 7, laser: { 'التاريخ': '19/10/2025', 'عدد الالواح': 1, 'الوقت بالدقيقة': 2, 'اجمالي الدقائق': F('P7*Q7+P7', 3), 'الخامة': '3مم اسود', 'إجمالي التكلفة\n(جنيه)': F('R7*$R$4', 0) } }],
  });
  // the template: a work sheet that is never imported
  workSheet(wb, 'قالب تصنيع', { rows: [] }).getCell(1, 1).value = 'اكتب اسم العميل — حساب الشغل';

  // the «عملاء» log: one row synced into the sheets (keys), one not, one with no client
  const log = wb.addWorksheet('عملاء');
  const head = ['التاريخ', 'عميل', 'عدد القطع', 'عدد التنيات', 'نزلة تناية', 'الخامة', '<-- الليزر', 'التاريخ', 'عميل', 'عدد الالواح', 'الوقت بالدقيقة', 'اجمالي الدقائق', 'الخامة',
    '<-- لوفر', 'التاريخ', 'عميل', 'عدد القطع', 'عدد لوفر', 'العدد الكلي للوفر', 'الخامة', '<-- مقص', 'التاريخ', 'عميل', 'عدد القطع', 'عدد القصات', 'نزلة مقص', 'الخامة',
    '<-- خامة من عندنا', 'التاريخ', 'عميل', 'سمك بالمم', 'طول بالسم', 'عرض بالسم', 'الخامة'];
  head.forEach((t, i) => { log.getCell(1, i + 1).value = t; });
  log.getCell(1, 40).value = 'حالة مزامنة العملاء';
  Object.entries({ A2: '18/10/2025', B2: 'النجمة', C2: 3, D2: 4, E2: F('C2*D2', 12), F2: '1.5مم مجلفن', H2: '19/10/2025', I2: 'م/ النجمة', J2: 1, K2: 4, L2: F('J2*K2+J2', 5),
    AI2: 'OO_1_2_1700000000001_1', AJ2: 'OO_2_2_1700000000002_2',
    H3: '21/10/2025', I3: 'م/ النجمة', J3: 2, K3: 3, L3: F('J3*K3+J3', 8), M3: '2مم اسود', AJ3: 'OO_2_3_1700000000003_3',
    AC4: '21/10/2025', AD4: '-', AE4: 2, AF4: 100, AG4: 50, AH4: 'اسود' }).forEach(([a, v]) => { log.getCell(a).value = v; });

  statement(wb, 'كشف ورشة النسيم', {
    link: { sheet: 'ورشة النسيم', e1: 1406.8 },
    rows: [
      { row: 3, date: D(2025, 8, 30), desc: 'دفعة', credit: 1000 },
      { row: 4, date: D(2025, 9, 3), desc: 'تم تحصيل شيك', credit: 300 },
      { row: 5, date: D(2025, 9, 5), desc: 'شغل يدوي', debit: 200 },
      { row: 6, discount: 6.8 },
    ],
    totals: { debit: 1606.8, discount: 6.8, credit: 1300 },
  });
  const stN = statement(wb, 'كشف مصنع النجمة', { link: { sheet: 'النجمة', e1: 114 }, rows: [{ row: 3, desc: 'باقي', credit: 20 }], totals: { debit: 114, discount: 0, credit: 80 } });
  stN.getCell('E2').value = F('50+10', 60); // a payment written on the linked row
  statement(wb, 'كشف تجارة الفجر', {
    rows: [{ row: 2, date: D(2025, 10, 1), debit: 500 }, { row: 3, date: D(2025, 10, 2), desc: 'نقدي', credit: 100 }],
    totals: { debit: 500, discount: 0, credit: 100 },
  });
  ['العميل', 'إجمالي المدين', 'إجمالي الخصم', 'إجمالي الدائن', 'الرصيد النهائي'].forEach((t, i) => { summary.getCell(1, i + 1).value = t; });
  [['ورشة النسيم', 1606.8, 6.8, 1300], ['مصنع النجمة', 114, 0, 80], ['تجارة الفجر', 500, 0, 100]].forEach(([n, b, c, d], i) => {
    const r = i + 2;
    summary.getCell(r, 1).value = n;
    summary.getCell(r, 2).value = F(`'كشف ${n}'!I2`, b);
    summary.getCell(r, 3).value = F(`'كشف ${n}'!I3`, c);
    summary.getCell(r, 4).value = F(`'كشف ${n}'!I4`, d);
    summary.getCell(r, 5).value = F(`B${r}-C${r}-D${r}`, Number((b - c - d).toFixed(6)));
  });
  summary.getCell(5, 1).value = 'الإجمالي';
  summary.getCell(5, 2).value = F('SUM(B2:B4)', 2220.8);
  summary.getCell(5, 3).value = F('SUM(C2:C4)', 6.8);
  summary.getCell(5, 4).value = F('SUM(D2:D4)', 1480);
  summary.getCell(5, 5).value = F('SUM(E2:E4)', 734);

  // partners
  const ps = wb.getWorksheet('حسابات الشركاء');
  ['الشريك', 'دائن (ما دفعه للشركة)', 'مدين (ما أخذه من الشركة)', 'صافي المستحق للشريك'].forEach((t, i) => { ps.getCell(1, i + 1).value = t; });
  ps.getCell('A2').value = 'شريك تجريبي';
  ps.getCell('B2').value = F("SUM('شريك تجريبي'!B2:B23)", 6300);
  ps.getCell('C2').value = F("SUM('شريك تجريبي'!C2:C23)", 2150);
  ps.getCell('D2').value = F('B2-C2', 4150);
  ps.getCell('A3').value = 'الإجمالي'; ps.getCell('B3').value = F('SUM(B2:B2)', 6300); ps.getCell('C3').value = F('SUM(C2:C2)', 2150); ps.getCell('D3').value = F('SUM(D2:D2)', 4150);
  const p = wb.addWorksheet('شريك تجريبي');
  ['الرصيد', 'دائن', 'مدين', 'الوصف'].forEach((t, i) => { p.getCell(1, i + 1).value = t; });
  p.getCell('L1').value = 'لتاريخ';
  Object.entries({ B2: 1000, D2: 'تغذية الحساب', B3: 300, D3: 'كهرباء', C4: 2000, D4: 'شيك بتاريخ 9/10/2025', L4: D(2025, 12, 10),
    C5: 150, D5: 'مبلغ مسحوب', L5: '10-10-2025', B6: 5000, D6: 'إيداع بتاريخ 11/10/2025' }).forEach(([a, v]) => { p.getCell(a).value = v; });

  // the company's cheques: one is the partner's (imported once), one is a bill
  const ch = wb.addWorksheet('الشيكات');
  ch.getCell('A1').value = 'الشيكات المصروفة من حساب الشركة'; ch.getCell('C1').value = 'إجمالي الشيكات'; ch.getCell('D1').value = F('SUM(E4:E503)', 2400);
  ['التاريخ', 'رقم الشيك', 'المستفيد (لمن)', 'البيان', 'المبلغ'].forEach((t, i) => { ch.getCell(3, i + 1).value = t; });
  Object.entries({ C4: 'شريك تجريبي', E4: 2000, A5: '12/10/2025', B5: '777123', C5: 'شركة الكهرباء التجريبية', D5: 'فاتورة كهرباء', E5: 400 }).forEach(([a, v]) => { ch.getCell(a).value = v; });

  // daily expenses: no date on the first rows, a duplicate, an amount written as words
  const ex = wb.addWorksheet('المصروفات اليومية');
  ex.getCell('A1').value = 'المصروفات اليومية في المصنع'; ex.getCell('C1').value = 'إجمالي المصروفات'; ex.getCell('D1').value = F('SUM(C4:C503)', 590);
  ['التاريخ', 'البند / البيان', 'المبلغ', 'ملاحظات'].forEach((t, i) => { ex.getCell(3, i + 1).value = t; });
  Object.entries({ B4: 'شاي وقهوه', C4: 50, B5: 'نقل', C5: 120, B6: 'نقل', C6: 120, B7: 'مسامير', C7: 'مسمار ب 20', A8: '15/10/2025', B8: 'لحام لورشة النسيم', C8: 300 })
    .forEach(([a, v]) => { ex.getCell(a).value = v; });

  // materials: cash and cheque
  const mt = wb.addWorksheet('الخامات');
  mt.getCell('A1').value = 'مشتريات الخامات'; mt.getCell('C1').value = 'إجمالي الخامات'; mt.getCell('D1').value = F('SUM(F4:F503)', 2700);
  mt.getCell('E1').value = 'مدفوع كاش'; mt.getCell('F1').value = F('SUMIFS(F4:F503,G4:G503,"كاش")', 2000);
  mt.getCell('G1').value = 'مدفوع بشيك'; mt.getCell('H1').value = F('SUMIFS(F4:F503,G4:G503,"شيك")', 700);
  ['التاريخ', 'المورد', 'الخامة', 'الكمية', 'سعر الوحدة', 'الإجمالي', 'طريقة الدفع\n(كاش / شيك)', 'رقم الشيك', 'ملاحظات'].forEach((t, i) => { mt.getCell(3, i + 1).value = t; });
  Object.entries({ A4: '16/10/2025', B4: 'مورد الحديد التجريبي', C4: '2 مم اسود', D4: 2, E4: 1000, F4: F('D4*E4', 2000), G4: 'كاش',
    A5: '17/10/2025', B5: 'مورد الصاج التجريبي', F5: 700, G5: 'شيك', H5: '12345' }).forEach(([a, v]) => { mt.getCell(a).value = v; });

  // «المخزن حاليا»: collected − expenses − cheques − materials (no partner money)
  const st = wb.addWorksheet('المخزن حاليا');
  st.getCell('A3').value = 'إجمالي المحصّل من العملاء (إجمالي الدائن)'; st.getCell('B3').value = F("INDEX('ملخص العملاء'!D:D,5)", 1480);
  st.getCell('A9').value = 'الرصيد الموجود حاليًا'; st.getCell('B9').value = F('B3+B8', -4210);
  return wb;
}

export async function workbookBuffer() {
  return Buffer.from(await (await buildWorkbook()).xlsx.writeBuffer());
}
