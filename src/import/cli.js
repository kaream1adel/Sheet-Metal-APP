// node src/cli.js import-excel <file> [--apply] [--json]
//   without --apply: reads the workbook, prints the preview (what needs the admin's eye) and the
//   reconciliation of a simulated import (nothing is written but the preview run itself)
//   with --apply: imports for real (refused while another import is applied)
// node src/cli.js import-excel --rollback <run id> <reason>
// The data folder is SHEETMETAL_DATA (or ./data).
import fs from 'fs';
import { basename } from 'path';
import { openDb, closeDb } from '../db.js';
import { formatMoney } from '../money.js';

const fmt = (m) => (m === null || m === undefined ? '' : formatMoney(Math.abs(m) < 5 ? 0 : m));

export function printReconciliation(rec, log = console.log) {
  if (!rec?.rows) return;
  log('\nالمطابقة (الإكسيل | البرنامج | الفرق):');
  let group = '';
  for (const r of rec.rows) {
    if (r.group !== group) { group = r.group; log(`-- ${{ clients: 'العملاء', work: 'شيتات الشغل (E1)', partners: 'الشركاء', ledgers: 'الدفاتر', store: 'المخزن حاليا' }[group] || group}`); }
    log(`${r.ok ? 'OK ' : 'XX '} ${r.label}: ${fmt(r.excel_amount)} | ${fmt(r.app_amount)} | ${fmt(r.diff_amount)}`);
    for (const p of r.parts || []) if (!p.ok || r.total) log(`      ${p.ok ? '' : 'XX '}${p.label}: ${fmt(p.excel_amount)} | ${fmt(p.app_amount)} | ${fmt(p.diff_amount)}`);
    if (r.note) log(`      ${r.note}`);
  }
  log(rec.ok ? 'كله مطابق.' : `فيه ${rec.mismatches} سطر مش مطابق.`);
}

function printPreview(run, log) {
  const p = run.preview;
  if (!p) return;
  log(`عملية الاستيراد رقم ${run.id} — ${run.file_name} — ${run.status}`);
  log(`العدد: ${JSON.stringify(p.counts)}`);
  if (run.simulated) log(`هيتسجل: ${JSON.stringify(run.simulated)}`);
  if (run.error) log(`خطأ: ${run.error}`);
  for (const n of p.names) log(`اسم: «${n.name}» = ${n.spellings.join(' / ')} (${(n.reasons || []).join('، ')})`);
  for (const s of p.suggestions) log(`أسماء شبه بعض (مش متدمجة): ${s.a_name} ↔ ${s.b_name}`);
  for (const x of p.partners) log(`شريك ${x.partner}: ${x.desc || '(من غير وصف)'} ${fmt(x.amount)} → ${x.class_name}${x.flag ? ` [${x.flag}]` : ''} ${x.date}`);
  for (const d of p.dates) log(`تاريخ ${d.ref}: «${d.text}» → ${d.date} (${d.kind}${d.followers ? `، ومعاه ${d.followers} صف` : ''})`);
  for (const d of p.duplicates) log(`مكرر ${d.ref} = ${d.of}: ${d.text} ${fmt(d.amount)} ${d.date}`);
  for (const f of p.formula) log(`${f.info ? 'ملاحظة' : 'فرق معادلة'} ${f.ref}: الإكسيل ${fmt(f.excel_amount)} المعادلة ${fmt(f.formula_amount)} — ${f.reason}`);
  for (const s of p.skipped) log(`متستوردش ${s.ref}: ${s.reason} ${s.text || ''}`);
}

export async function run(args = []) {
  const json = args.includes('--json');
  const log = json ? () => {} : console.log;
  openDb();
  try {
    const svc = await import('./index.js');
    if (args[0] === '--rollback') {
      const out = svc.rollbackRun(Number(args[1]), args.slice(2).filter((a) => a !== '--json').join(' '), null);
      log(`اتلغى الاستيراد رقم ${out.id}`);
      printReconciliation(out.reconciliation, log);
      if (json) console.log(JSON.stringify(out));
      return out;
    }
    const file = args.find((a) => !a.startsWith('--'));
    if (!file || !fs.existsSync(file)) throw new Error('usage: import-excel <file.xlsx> [--apply] [--json]');
    let out = await svc.createPreview({ fileName: basename(file), buffer: fs.readFileSync(file) });
    printPreview(out, log);
    if (args.includes('--apply')) {
      out = await svc.applyRun(out.id, {});
      log(`\nاتستورد — العملية رقم ${out.id}`);
    }
    printReconciliation(out.reconciliation, log);
    if (json) console.log(JSON.stringify(out));
    return out;
  } finally {
    closeDb();
  }
}
