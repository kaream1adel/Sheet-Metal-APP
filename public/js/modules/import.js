// Module import (الاستيراد من الإكسيل), in الإعدادات ← الاستيراد من الإكسيل:
//   1. ارفع الملف → the server reads it and SIMULATES the import: preview + reconciliation, nothing kept
//   2. المعاينة (#/import/:id): names, partner rows, dates, duplicates, formula differences, expenses;
//      every choice re-runs the simulation («طبّق الاختيارات»)
//   3. تأكيد الاستيراد → one transaction; the reconciliation table (Excel vs app) stays on the run
//   4. إلغاء الاستيراد (with a reason) reverses everything the run posted
// Settings tab: importSettingsTab(box, ctx). Screen: importRun(main, params, ctx).
import { h, fill, button, pageHead, backLink, emptyState, notice, pill, skeleton, toast, toastError, confirmModal, dataTable, fmtDateTime, tabs } from '../ui.js';
import { api, get } from '../api.js';
import { reconciliationTable } from './import-recon.js';
import { namesPanel, partnersPanel, datesPanel, duplicatesPanel, formulaPanel, expensesPanel, countsLine } from './import-preview.js';

const LONG = { timeout: 300000 }; // reading and simulating the workbook takes a while
const STATUS = { preview: ['warn', 'معاينة'], applied: ['ok', 'اتستورد'], rolled_back: ['neutral', 'اتلغى'], failed: ['danger', 'فشل'] };
const statusPill = (s) => pill(...(STATUS[s] || ['neutral', s]));

function readFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('الملف مش بيتقري'));
    r.readAsDataURL(file);
  });
}

export async function importSettingsTab(box, ctx) {
  fill(box, skeleton('table'));
  const d = await get('/api/import');
  const input = h('input', { type: 'file', accept: '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', class: 'sr-only', id: 'import-file' });
  const err = h('div', { class: 'field-err', role: 'alert' });
  const status = h('div', { class: 'small muted' });
  const pick = button('اختار ملف الحسابات (.xlsx)', { kind: 'primary', icon: 'upload-simple', onClick: () => input.click() });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    err.textContent = '';
    if (!/\.xlsx$/i.test(file.name)) { err.textContent = 'لازم يكون ملف إكسيل .xlsx'; return; }
    pick.disabled = true;
    status.textContent = 'بنقرا الملف ونجرب الاستيراد من غير ما نسجل حاجة… ممكن ياخد دقيقة.';
    try {
      const data = await readFile(file);
      const r = await api('POST', '/api/import/upload', { file_name: file.name, data }, LONG);
      toast('الملف اتقرا — راجع المعاينة');
      ctx.go(`#/import/${r.run.id}`);
    } catch (ex) {
      err.textContent = ex.message;
      status.textContent = '';
    } finally {
      pick.disabled = false;
      input.value = '';
    }
  });
  const applied = d.runs.find((r) => r.status === 'applied');
  fill(box,
    h('div', { class: 'card' },
      h('h3', { class: 'section-title' }, 'استيراد ملف «حسابات شركة الصفا»'),
      h('p', { class: 'muted' }, 'ارفع الملف وهتشوف معاينة قبل أي تسجيل: الأسماء اللي اتجمعت، تصنيف صفوف الشركاء، التواريخ اللي محتاجة قرار، المكرر، وجدول مطابقة بين أرقام الإكسيل والبرنامج. التسجيل بيحصل لما تأكد بس، وتقدر تلغيه بعدها.'),
      applied ? notice('info', `فيه استيراد متنفذ بالفعل (رقم ${applied.id}). استيراد جديد محتاج تلغي ده الأول من صفحته.`) : null,
      h('div', { class: 'row', style: 'gap:12px;align-items:center;flex-wrap:wrap' }, input, pick, status), err),
    h('h3', { class: 'section-title' }, 'عمليات الاستيراد'),
    dataTable([
      { label: 'رقم', value: (r) => h('span', { class: 'num' }, r.id) },
      { label: 'الملف', value: (r) => h('span', { class: 'ltr' }, r.file_name) },
      { label: 'الحالة', value: (r) => [statusPill(r.status), r.error && r.status === 'preview' ? ' ' : null, r.error && r.status === 'preview' ? pill('danger', 'فيه مشكلة') : null] },
      { label: 'اترفع', value: (r) => h('span', { class: 'num' }, fmtDateTime(r.created_at)) },
      { label: 'بواسطة', value: (r) => r.created_by_name || '—' },
    ], d.runs, { onRow: (r) => ctx.go(`#/import/${r.id}`), empty: emptyState('file-xls', 'لسه مفيش استيراد', 'اختار ملف الحسابات من فوق عشان تبدأ.', null, true) }));
}

const TABS = [
  { key: 'recon', label: 'المطابقة', icon: 'scales' },
  { key: 'names', label: 'الأسماء', icon: 'users-three' },
  { key: 'partners', label: 'الشركاء', icon: 'handshake' },
  { key: 'dates', label: 'التواريخ', icon: 'calendar-blank' },
  { key: 'dups', label: 'المكرر والمتساب', icon: 'copy' },
  { key: 'formula', label: 'فروق المعادلات', icon: 'calculator' },
  { key: 'expenses', label: 'المصروفات', icon: 'receipt' },
];

export async function importRun(main, params, ctx) {
  fill(main, pageHead('الاستيراد من الإكسيل', ''), skeleton('table'));
  let run = (await get(`/api/import/runs/${params.id}`)).run;
  const lookups = ctx.state.lookups || await ctx.loadLookups();
  const categories = lookups?.expense_categories || [];
  let tab = 'recon';
  let dirty = false;
  let dec = structuredClone(run.decisions || {});
  const body = h('div', {});
  const bar = h('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap;margin:12px 0' });

  const changed = () => { dirty = true; drawBar(); };
  const refresh = async () => {
    const r = await api('PUT', `/api/import/runs/${run.id}/decisions`, { decisions: dec }, LONG);
    run = r.run;
    dec = structuredClone(run.decisions || {});
    dirty = false;
    toast('المعاينة اتحدثت');
    draw();
  };
  const apply = async () => {
    if (dirty) { toast('طبّق الاختيارات الأول وراجع المطابقة', true); return; }
    const ok = await confirmModal('تأكيد الاستيراد', 'كل اللي في المعاينة هيتسجل في البرنامج مرة واحدة (أو مفيش حاجة خالص لو حصلت مشكلة). تقدر تلغيه بعدها من نفس الصفحة.', 'استورد');
    if (!ok) return;
    try {
      run = (await api('POST', `/api/import/runs/${run.id}/apply`, { decisions: dec }, LONG)).run;
      toast(run.reconciliation?.ok ? 'اتستورد وكل الأرقام مطابقة' : 'اتستورد — راجع جدول المطابقة');
      draw();
    } catch (ex) { toastError(ex); }
  };
  const rollback = async () => {
    const reason = await confirmModal('إلغاء الاستيراد', 'كل القيود اللي الاستيراد ده سجلها هتتلغي بقيود عكسية بنفس تاريخها، والمستندات هتتعلم ملغية، والعملاء والموردين اللي اتعملوا منه هيتقفلوا. ده بيتسجل في سجل التعديلات.', 'ألغِ الاستيراد', { danger: true, withReason: true, reasonLabel: 'سبب الإلغاء' });
    if (!reason) return;
    try {
      run = (await api('POST', `/api/import/runs/${run.id}/rollback`, { reason }, LONG)).run;
      toast('الاستيراد اتلغى');
      draw();
    } catch (ex) { toastError(ex); }
  };

  function drawBar() {
    if (run.status !== 'preview') {
      fill(bar, run.status === 'applied' ? button('إلغاء الاستيراد', { kind: 'danger', icon: 'arrow-counter-clockwise', onClick: rollback }) : null);
      return;
    }
    fill(bar,
      button('طبّق الاختيارات وأعد المعاينة', { kind: dirty ? 'primary' : '', icon: 'arrows-clockwise', disabled: !dirty, onClick: () => refresh().catch(toastError) }),
      button('تأكيد الاستيراد', { kind: dirty ? '' : 'primary', icon: 'check', disabled: dirty || !!run.error, onClick: apply }),
      dirty ? h('span', { class: 'small muted' }, 'فيه اختيارات لسه متطبقتش') : null);
  }

  function panel() {
    const p = run.preview || {};
    if (tab === 'recon') return reconciliationTable(run.reconciliation, { title: run.status === 'preview' ? 'المطابقة المتوقعة (تجربة من غير تسجيل)' : 'المطابقة: الإكسيل قصاد البرنامج دلوقتي' });
    if (run.status !== 'preview') return notice('info', 'الاختيارات دي اتقفلت بعد التأكيد. لو محتاج تغيّر حاجة: ألغِ الاستيراد وارفع الملف تاني.');
    if (tab === 'names') return namesPanel(p, dec, changed);
    if (tab === 'partners') return partnersPanel(p, dec, changed, categories);
    if (tab === 'dates') return datesPanel(p, dec, changed);
    if (tab === 'dups') return duplicatesPanel(p, dec, changed);
    if (tab === 'formula') return formulaPanel(p);
    return expensesPanel(p, dec, changed, categories);
  }

  function draw() {
    const p = run.preview || {};
    const badge = (key) => {
      const n = { dates: p.dates?.length, dups: p.duplicates?.length, partners: (p.partners || []).filter((x) => x.flag).length, formula: (p.formula || []).filter((x) => !x.info).length }[key];
      return n ? ` (${n})` : '';
    };
    fill(main,
      backLink('#/settings/import', 'الاستيراد من الإكسيل'),
      pageHead(`الاستيراد رقم ${run.id}`, `${run.file_name} — ${run.created_by_name || ''} — ${fmtDateTime(run.created_at)}`, statusPill(run.status)),
      run.error && run.status === 'preview' ? notice('danger', `التجربة وقفت: ${run.error} — مفيش حاجة هتتسجل لحد ما المشكلة تتحل.`) : null,
      run.status === 'applied' ? notice(run.reconciliation?.ok ? 'ok' : 'warn', `اتستورد ${fmtDateTime(run.applied_at)}.`) : null,
      run.status === 'rolled_back' ? notice('info', `الاستيراد ده اتلغى ${fmtDateTime(run.rolled_back_at)} — قيوده اتعكست ومستنداته اتعلمت ملغية.`) : null,
      countsLine(p.counts, run.simulated),
      bar,
      tabs(TABS.map((t) => ({ ...t, label: t.label + (run.status === 'preview' ? badge(t.key) : '') })), tab, (k) => { tab = k; draw(); }),
      body);
    drawBar();
    fill(body, panel());
  }
  draw();
}

export const routes = [
  { path: '#/import/:id', screen: importRun, perm: 'import' },
];
