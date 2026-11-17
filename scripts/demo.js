// npm run demo — starts the app on a separate demo database (demo-data/) filled with
// invented clients, technician sheets, pricing, receipts, cheques and expenses, so the
// whole flow can be seen without any real data. Logins: admin / demo1234, manager / demo1234.
// Delete demo-data/ to start over.
import fs from 'fs';
import { join } from 'path';
import { ROOT } from '../src/paths.js';

const dir = join(ROOT, 'demo-data');
process.env.SHEETMETAL_DATA = dir;
const fresh = !fs.existsSync(join(dir, 'safa.sqlite'));
const PORT = Number(process.argv[2] || process.env.PORT || 4300);

const { openDb } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
openDb();
await new Promise((resolve) => createApp().listen(PORT, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${PORT}`;

const session = () => {
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = await res.json().catch(() => ({}));
    if (res.status >= 300) throw new Error(`${method} ${url} → ${res.status} ${JSON.stringify(data)}`);
    return data;
  };
  return { get: (u) => call('GET', u), post: (u, b) => call('POST', u, b || {}), put: (u, b) => call('PUT', u, b) };
};

async function seed() {
  const admin = session();
  const staff = session();
  await admin.post('/api/setup', { username: 'admin', display_name: 'الأدمن', password: 'demo1234' });
  await admin.post('/api/users', { username: 'manager', display_name: 'مدير الورشة', password: 'demo1234', role: 'staff' });
  await staff.post('/api/login', { username: 'manager', password: 'demo1234' });

  const tech = async (name, machine) => (await staff.post('/api/technicians', { name, machine })).technician.id;
  const tPress = await tech('حسن (تناية)', 'press');
  const tLaser = await tech('سيد (ليزر)', 'laser');
  const tPunch = await tech('رجب (بنش)', 'punch');
  const party = async (kind, name) => (await admin.post('/api/parties', { kind, name, force: true })).party.id;
  const A = await party('client', 'ورشة النور');
  const B = await party('client', 'مصنع الأمل للتكييف');
  const C = await party('client', 'شركة الريان للمقاولات');
  const P = await party('partner', 'الشريك الأول');
  const S = await party('supplier', 'مورد الصاج');
  await party('worker', 'محمود العامل');

  await admin.put('/api/pricing/general', { prices: [
    { section: 'press', band: '<3', rate: '2' }, { section: 'press', band: '>=3', rate: '3' },
    { section: 'shear', band: '', rate: '0.5' },
    { section: 'laser', band: '', rate: '15', min_charge: '150' }, { section: 'punch', band: '', rate: '12', min_charge: '150' },
    { section: 'louver', band: '', rate: '5' }, { section: 'material', band: '', rate: '48' },
  ] });
  await admin.post('/api/treasury/opening', { account: 'cash', amount: '25000', date: '2026-10-01' });
  await admin.post('/api/treasury/opening', { account: 'bank', amount: '60000', date: '2026-10-01' });

  const sheet = async (body) => (await staff.post('/api/operations/sheets', { submit: true, ...body })).sheet;
  const approve = async (s) => {
    const yellow = s.issues.filter((i) => i.level === 'yellow' && !i.acked).map((i) => i.key);
    if (yellow.length) await staff.post(`/api/operations/sheets/${s.id}/ack`, { keys: yellow });
    return (await staff.post(`/api/operations/sheets/${s.id}/approve`)).sheet;
  };
  const priced = [
    await approve(await sheet({ machine: 'press', technician_id: tPress, sheet_date: '2026-10-05', lines: [
      { part_name: 'جنب دولاب', client_text: 'ورشة النور', material_text: '١٫٥م اسود', pieces: '١٨', per_piece: '٢', total_written: '٣٦' },
      { part_name: 'زاوية', client_text: 'ورشة النور', material_text: '~', pieces: 3, per_piece: 3, total_written: 9, ditto_fields: ['material_text'] },
      { part_name: 'غطا', client_text: 'مصنع الأمل للتكييف', material_text: '3م مجلفن', pieces: 6, per_piece: 4, total_written: 24 },
    ] })),
    await approve(await sheet({ machine: 'laser', technician_id: tLaser, sheet_date: '2026-10-06', lines: [
      { part_name: 'شعار', client_text: 'ورشة النور', material_text: '2م ستانلس', sheets: '1', start_time: '6 دقيقة', single_piece: true },
      { part_name: 'فلنشة', client_text: 'شركة الريان للمقاولات', material_text: '3م اسود', sheets: '3', start_time: '10 دقيقة' },
    ] })),
    await approve(await sheet({ machine: 'punch', technician_id: tPunch, sheet_date: '2026-10-07', lines: [
      { part_name: 'باب تهوية', client_text: 'مصنع الأمل للتكييف', material_text: '1م مجلفن', pieces: 20, sheets: 4, start_time: '7 دقيقة',
        louvers_per_piece: 6, material_source: 'خامة المصنع', length_cm: 244, width_cm: 122 },
    ] })),
  ];
  for (const s of priced) {
    await admin.post(`/api/pricing/sheets/${s.id}/confirm`, {});
    await admin.post(`/api/pricing/sheets/${s.id}/post`, {});
  }
  // one sheet waiting for pricing, one still in review (unknown client)
  await approve(await sheet({ machine: 'shear', technician_id: tPress, sheet_date: '2026-10-20', lines: [
    { part_name: 'شرائح', client_text: 'شركة الريان للمقاولات', material_text: '2م اسود', pieces: 40, per_piece: 2, total_written: 80 },
  ] }));
  await sheet({ machine: 'press', technician_id: tPress, sheet_date: '2026-10-21', lines: [
    { part_name: 'رف', client_text: 'عميل جديد مش متسجل', material_text: '1.5م اسود', pieces: 12, per_piece: 4, total_written: 50 },
  ] });

  await admin.post('/api/treasury/receipts', { party_id: A, date: '2026-10-10', amount: '300', method: 'cash' });
  await admin.post('/api/treasury/receipts', { party_id: B, date: '2026-10-12', amount: '1500', method: 'cheque',
    cheque: { number: '000731', bank: 'بنك تجريبي', due_date: '2026-11-25' } });
  await admin.post('/api/treasury/receipts', { party_id: C, date: '2026-10-15', amount: '400', method: 'instapay' });
  await admin.post('/api/treasury/receipts', { party_id: P, date: '2026-10-02', amount: '50000', method: 'transfer' });
  await admin.post('/api/treasury/vouchers', { kind: 'expense', date: '2026-10-03', paid_from: 'partner', paid_from_party_id: P,
    description: 'إيجار شهر 10', lines: [{ category_id: 2, amount: '15000' }] });
  await admin.post('/api/treasury/vouchers', { kind: 'expense', date: '2026-10-12', paid_from: 'cash', description: 'دهان',
    lines: [{ category_id: 6, amount: '4000' }, { category_id: 6, amount: '2500', cost_party_id: B, recharge: true }] });
  await admin.post('/api/treasury/vouchers', { kind: 'material_purchase', date: '2026-10-04', paid_from: 'supplier_credit', party_id: S,
    items: [{ material_id: 1, qty: '10', unit: 'لوح', unit_rate: '1850' }] });
  await admin.post('/api/treasury/transfers', { date: '2026-10-16', from_account: 'cash', to_account: 'bank', amount: '5000' });
  await staff.post('/api/treasury/vouchers', { kind: 'expense', date: '2026-10-20', paid_from: 'cash', description: 'كهربا',
    lines: [{ category_id: 3, amount: '1200' }] });
}

if (fresh) {
  await seed();
  console.log('Demo data created in demo-data/');
}
console.log(`شركة الصفا (demo) → ${base}   logins: admin / demo1234, manager / demo1234`);
