// تسعير ورقة: one approved sheet, its items grouped by client, an Excel-like grid per client with
// a variable سعر الوحدة per line (the suggestion in grey until confirmed, «محتاج سعر» in yellow),
// «طبّق على باقي بنود الورقة» / «على البنود المشابهة», خصم / إضافة per client, and
// «اعتماد التسعير والترحيل» (one posting per client). Posted clients show frozen, with their بيان أعمال.
import { h, fill, icon, button, pageHead, backLink, emptyState, notice, pill, field, numberInput, textInput, toast,
  toastError, confirmModal, money, moneySpan, fmtDate, parseNum } from '../ui.js';
import { get, post, patch, put } from '../api.js';
import { createGrid } from '../grid.js';
import { ensurePricingStyles } from './pricing-style.js';
import { SOURCE_SHORT, ratePounds, materialText, calcText, qtyText, needsText } from './pricing-common.js';

const EXCLUDE = '__exclude';

export async function priceSheet(main, params, ctx) {
  ensurePricingStyles();
  const id = Number(params.id);
  let data = await get(`/api/pricing/sheets/${id}`);
  const body = h('div', {});
  const foot = h('div', { class: 'pr-foot no-print' });

  const reload = async (fresh = null) => {
    data = fresh || await get(`/api/pricing/sheets/${id}`);
    draw();
  };

  function draw() {
    const s = data.sheet;
    fill(main,
      backLink('#/pricing', 'أوراق مستنية تسعير'),
      pageHead(`تسعير ورقة ${s.serial}`, `${s.machine_name}${s.technician_name ? ` — ${s.technician_name}` : ''} — ${fmtDate(s.sheet_date)}`,
        s.has_photo ? button('صورة الورقة', { icon: 'camera', href: `/api/operations/sheets/${s.id}/photo`, target: '_blank' }) : null,
        button('ورقة التشغيل', { icon: 'files', href: `#/ops/sheets/${s.id}`, kind: 'ghost' })),
      s.month_locked ? notice('warn', `شهر الورقة (${s.sheet_date.slice(0, 7)}) مقفول — الترحيل هيترفض لحد ما الأدمن يفتح الشهر من الإعدادات ← إقفال الشهر.`) : null,
      body, foot);
    if (!data.clients.length) {
      fill(body, emptyState('files', 'الورقة دي مفيهاش بنود تتسعر', 'مفيش سطر عليه اسم عميل. لو ده صح اقفل الورقة عشان تطلع من القايمة، أو صلّح الورقة من التشغيل.',
        s.priced_status === 'posted' ? button('أوراق مستنية تسعير', { href: '#/pricing' })
          : button('اقفل الورقة من غير ترحيل', { kind: 'primary', onClick: async () => {
            try { await post(`/api/pricing/sheets/${id}/post`, {}); toast('الورقة اتقفلت'); ctx.go('#/pricing'); } catch (ex) { toastError(ex); }
          } })));
      fill(foot);
      foot.hidden = true;
      return;
    }
    fill(body, data.clients.map(clientBlock));
    drawFoot();
  }

  // ---------- one client ----------
  function clientBlock(c) {
    const waiting = c.items.filter((i) => i.status === 'suggested');
    const posted = c.items.filter((i) => i.status === 'posted');
    const live = c.batches.filter((b) => b.status === 'posted');
    const head = h('div', { class: 'pr-client-head' },
      h('h2', {}, h('a', { href: `#/clients/${c.client.id}/pricing` }, c.client.name),
        c._state = h('span', {}, statePill(c, waiting)),
        live.map((b) => h('a', { class: 'pill neutral', href: `#/pricing/batch/${b.id}` }, `بيان أعمال ${b.serial}`))),
      h('div', { class: 'row' },
        waiting.some((i) => i.rate !== null && !i.rate_confirmed)
          ? button('أكّد السعر المقترح', { size: 'sm', icon: 'check', kind: 'ghost', onClick: () => confirmAll(c.client.id) }) : null,
        waiting.length && data.clients.filter((x) => x.waiting_count).length > 1
          ? button('رحّل العميل ده بس', { size: 'sm', onClick: () => postClients([c.client.id]) }) : null,
        live.map((b) => button('تصحيح سعر', { size: 'sm', icon: 'pencil-simple', href: `#/pricing/batch/${b.id}?correct=1` }))));
    const box = h('section', { class: 'pr-client' }, head);
    if (waiting.length) box.append(...waitingGrid(c, waiting));
    if (posted.length) {
      if (waiting.length) box.append(h('h3', { style: 'margin-top:14px' }, 'اللي اترحّل من العميل ده'));
      box.append(postedGrid(posted).el);
    }
    if (c.excluded.length) {
      box.append(h('div', { class: 'small muted', style: 'margin-top:8px' }, icon('info', 'sm'), ' بنود مستبعدة (مش هتتحاسب): ',
        c.excluded.map((i) => h('span', { style: 'margin-inline-end:10px' }, `${i.part_name || i.section_name}${i.cancel_reason ? ` (${i.cancel_reason})` : ''} `,
          h('button', { class: 'btn ghost sm', type: 'button', onclick: () => restore(i) }, 'رجّعه')))));
    }
    return box;
  }

  function columns(items, { editable }) {
    const hasMaterial = items.some((i) => i.section === 'material');
    const cols = [
      { key: 'part_name', label: 'القطعة', type: 'computed', text: true, compute: (r) => r.part_name || '—' },
      { key: 'section_name', label: 'القسم', type: 'computed', text: true, compute: (r) => r.section_name },
      { key: 'material', label: 'الخامة', type: 'computed', text: true, compute: (r) => materialText(r) || '—' },
      { key: 'calc', label: 'الحساب', type: 'computed', text: true, compute: (r) => calcText(r) },
    ];
    if (hasMaterial) {
      cols.push(
        { key: 'length_cm', label: 'طول (سم)', type: 'number', width: 64, ditto: false, readOnly: (r) => !editable || r.section !== 'material' },
        { key: 'width_cm', label: 'عرض (سم)', type: 'number', width: 64, ditto: false, readOnly: (r) => !editable || r.section !== 'material' });
    }
    cols.push(
      editable
        ? { key: 'billing', label: 'طريقة الحساب', type: 'select', width: 130, ditto: false,
          options: (r) => [...r.billings.map((b) => [b, BILLING_LABELS[b]]), [EXCLUDE, 'استبعد البند (مش هيتحاسب)']] }
        : { key: 'billing_name', label: 'طريقة الحساب', type: 'computed', text: true, compute: (r) => r.billing_name },
      { key: 'qty', label: 'الكمية', type: 'computed', text: true, compute: (r) => r.qty, format: (_v, r) => qtyText(r) },
      { key: 'rate_typed', label: 'سعر الوحدة', type: editable ? 'number' : 'computed', width: 86, ditto: false,
        placeholder: (r) => (r.rate !== null && !r.rate_confirmed ? String(ratePounds(r.rate)) : ''),
        compute: (r) => r.rate, format: (v) => (v === null || v === undefined ? '' : money(v)) },
      { key: 'amount', label: 'المبلغ', type: 'computed', compute: (r) => r.amount, format: (v, r) => (v === null || v === undefined ? (r && r.needs ? needsText(r) : '') : money(v)),
        total: (rows) => rows.reduce((s, r) => s + (r.amount || 0), 0), totalFormat: (v) => money(v) },
      { key: 'source', label: 'المصدر', type: 'computed', text: true,
        compute: (r) => [r.rate_confirmed ? (r.rate_source === 'manual' ? 'اتكتب' : 'متأكد') : (SOURCE_SHORT[r.rate_source] || '—'), r.min_applied ? 'الحد الأدنى' : '']
          .filter(Boolean).join(' · ') },
    );
    return cols;
  }

  const rowOf = (i) => ({ ...i, rate_typed: i.rate_confirmed ? ratePounds(i.rate) : null });

  function waitingGrid(c, items) {
    const applyBar = h('div', { class: 'pr-apply', hidden: true });
    const g = createGrid({
      columns: columns(items, { editable: true }),
      rows: items.map(rowOf),
      canAdd: false, canDelete: false, keysHint: false, totals: 'top', maxHeight: '60vh',
      rowTitle: (r) => `${r.part_name || r.section_name} — ${r.section_name}`,
      marks: (r, key) => {
        if (key === 'rate_typed' && r.needs?.includes('rate')) return { level: 'yellow', message: 'محتاج سعر — مفيش سعر سابق للعميل ولا سعر عام', seen: false };
        if ((key === 'length_cm' || key === 'width_cm') && r.needs?.includes('dims')) return { level: 'red', message: 'اكتب الطول والعرض بالسنتيمتر' };
        if (key === 'calc' && r.needs?.includes('qty')) return { level: 'red', message: 'ناقص الكمية على الورقة — غيّر طريقة الحساب أو صلّح الورقة' };
        return null;
      },
      cellClass: (r, key) => ((key === 'rate_typed' || key === 'amount') && !r.rate_confirmed && r.rate !== null ? 'suggested' : ''),
      onChange: (row, key, value, idx, grid) => change(c, row, key, value, idx, grid, applyBar),
    });
    return [g.el, applyBar, adjustBox(c)];
  }

  function postedGrid(items) {
    return createGrid({ columns: columns(items, { editable: false }), rows: items.map((i) => ({ ...i, rate_typed: ratePounds(i.rate) })),
      readOnly: true, canAdd: false, canDelete: false, keysHint: false, totals: 'top', maxHeight: '50vh',
      rowTitle: (r) => `${r.part_name || r.section_name} — ${r.section_name}` });
  }

  async function change(c, row, key, value, idx, grid, applyBar) {
    const old = c.items.find((i) => i.id === row.id);
    try {
      let item;
      if (key === 'billing' && value === EXCLUDE) {
        grid.setValue(idx, 'billing', old.billing);
        const reason = await confirmModal('استبعاد البند', `«${row.part_name || row.section_name}» مش هيتحاسب على ${c.client.name}. تقدر ترجّعه بعدين.`, 'استبعد البند', { danger: true, withReason: true, reasonLabel: 'السبب (مثال: شغل ضمان، إعادة تشغيل)' });
        if (!reason) return;
        await post(`/api/pricing/items/${row.id}/exclude`, { reason });
        toast('البند اتستبعد');
        return reload();
      }
      if (key === 'billing') item = (await patch(`/api/pricing/items/${row.id}`, { billing: value })).item;
      else if (key === 'rate_typed') item = (await patch(`/api/pricing/items/${row.id}`, { rate: value === null ? '' : String(value) })).item;
      else if (key === 'length_cm' || key === 'width_cm') item = (await patch(`/api/pricing/items/${row.id}`, { [key]: value === null ? '' : String(value) })).item;
      else return;
      Object.assign(c.items.find((i) => i.id === row.id), item);
      const fresh = rowOf(item);
      for (const k of Object.keys(fresh)) row[k] = fresh[k];
      grid.refreshRow(idx);
      recount(c);
      if (key === 'rate_typed' && item.rate !== null && item.rate_confirmed) showApply(c, item, applyBar);
    } catch (ex) {
      toastError(ex);
      const back = rowOf(old);
      for (const k of Object.keys(back)) row[k] = back[k];
      grid.refreshRow(idx);
    }
  }

  function showApply(c, item, bar) {
    const others = data.clients.flatMap((x) => x.items).filter((i) => i.status === 'suggested' && i.id !== item.id
      && i.section === item.section && i.billing === item.billing && i.band === item.band);
    if (!others.length) { bar.hidden = true; return; }
    const similar = others.filter((i) => i.client_id === item.client_id && i.material_id === item.material_id && i.thickness === item.thickness);
    fill(bar, icon('copy', 'sm'), h('span', {}, `السعر ${money(item.rate)} لكل ${item.unit_name}. تطبّقه على:`),
      button(`باقي بنود الورقة (${others.length})`, { size: 'sm', onClick: () => apply(item, 'sheet') }),
      similar.length ? button(`البنود المشابهة (${similar.length})`, { size: 'sm', onClick: () => apply(item, 'similar') }) : null,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { bar.hidden = true; } }, 'لأ'));
    bar.hidden = false;
  }

  async function apply(item, scope) {
    try {
      const r = await post(`/api/pricing/sheets/${id}/apply-rate`, { item_id: item.id, scope });
      toast(r.applied ? `اتطبّق على ${r.applied} بند` : 'مفيش بنود تانية زيه');
      reload(r.sheet);
    } catch (ex) { toastError(ex); }
  }

  async function confirmAll(clientId) {
    try {
      const r = await post(`/api/pricing/sheets/${id}/confirm`, { client_id: clientId });
      toast(`اتأكد ${r.confirmed} سعر`);
      reload(r.sheet);
    } catch (ex) { toastError(ex); }
  }

  async function restore(i) {
    try { await post(`/api/pricing/items/${i.id}/restore`, {}); toast('البند رجع'); reload(); } catch (ex) { toastError(ex); }
  }

  // ---------- خصم / إضافة ----------
  function adjustBox(c) {
    const a = c.adjustment;
    const disc = numberInput({ value: a.discount_amount ? ratePounds(a.discount_amount) : '', placeholder: '0' });
    const add = numberInput({ value: a.addition_amount ? ratePounds(a.addition_amount) : '', placeholder: '0' });
    const note = textInput({ value: a.note || '', placeholder: 'مثال: نقل، خصم كمية' });
    const fDisc = field('خصم على الورقة', disc);
    const fAdd = field('إضافة على الورقة', add);
    const fNote = field('ملاحظة', note);
    const sums = h('div', { class: 'pr-sums' });
    c._sums = sums;
    const save = async () => {
      for (const [f, el] of [[fDisc, disc], [fAdd, add]]) {
        const v = parseNum(el.value);
        if (Number.isNaN(v) || (v !== null && v < 0)) { f.setError('اكتب مبلغ صحيح'); return; }
      }
      try {
        const r = await put(`/api/pricing/sheets/${id}/adjustments`, { client_id: c.client.id, discount: disc.value, addition: add.value, note: note.value });
        c.adjustment = r.adjustment;
        recount(c);
      } catch (ex) {
        const target = { discount: fDisc, addition: fAdd }[ex.data?.field];
        if (target) target.setError(ex.message); else toastError(ex);
      }
    };
    for (const el of [disc, add, note]) el.addEventListener('change', save);
    const box = h('div', { class: 'pr-adjust' }, fDisc, fAdd, fNote, sums);
    recount(c);
    return box;
  }

  // the client's state pill: «n محتاج سعر» / «جاهز للترحيل» / «اترحّل» (kept current as rates are typed)
  function statePill(c, waiting) {
    if (!waiting.length) return pill('ok', 'اترحّل');
    return c.needs_rate_count ? pill('warn', `${c.needs_rate_count} محتاج سعر`) : pill('accent', 'جاهز للترحيل');
  }

  function recount(c) {
    const waiting = c.items.filter((i) => i.status === 'suggested');
    c.work_amount = waiting.reduce((s, i) => s + (i.amount || 0), 0);
    c.net_amount = c.work_amount + (c.adjustment.addition_amount || 0) - (c.adjustment.discount_amount || 0);
    c.needs_rate_count = waiting.filter((i) => i.needs?.includes('rate')).length;
    c.waiting_count = waiting.length;
    if (c._state) fill(c._state, statePill(c, waiting));
    if (c._sums) {
      fill(c._sums,
        h('div', { class: 'l' }, h('span', {}, 'الشغل'), moneySpan(c.work_amount)),
        c.adjustment.addition_amount ? h('div', { class: 'l' }, h('span', {}, '+ إضافة'), moneySpan(c.adjustment.addition_amount)) : null,
        c.adjustment.discount_amount ? h('div', { class: 'l' }, h('span', {}, '− خصم'), moneySpan(c.adjustment.discount_amount)) : null,
        h('div', { class: 'l' }, h('span', {}, 'الصافي على العميل'), h('b', { class: 'money' }, money(c.net_amount))));
    }
    drawFoot();
  }

  function drawFoot() {
    const waitingClients = data.clients.filter((c) => c.waiting_count);
    const needs = data.clients.flatMap((c) => c.items).filter((i) => i.status === 'suggested' && i.needs?.length).length;
    const net = waitingClients.reduce((s, c) => s + c.net_amount, 0);
    foot.hidden = false;
    if (!waitingClients.length) {
      fill(foot, icon('check-circle'), h('div', { class: 'grow' }, h('b', {}, 'الورقة دي اترحّلت كلها'),
        h('div', { class: 'small muted' }, 'أي تغيير في سعر بيبقى «تصحيح سعر» من بيان الأعمال.')),
      button('أوراق مستنية تسعير', { href: '#/pricing' }));
      return;
    }
    fill(foot,
      h('div', { class: 'grow' },
        h('div', { class: 'small muted' }, `صافي الورقة على ${waitingClients.length} عميل`),
        h('b', { class: 'money' }, money(net))),
      needs ? pill('warn', `${needs} بند لسه ناقص`) : pill('ok', 'كل البنود متسعرة'),
      button('اعتماد التسعير والترحيل', { kind: 'primary', size: 'big', icon: 'seal-check', disabled: !!needs || !ctx.can('money.post'),
        title: needs ? 'كمّل أسعار البنود الصفرا الأول' : null, onClick: () => postClients(null) }));
  }

  async function postClients(clientIds) {
    const list = data.clients.filter((c) => c.waiting_count && (!clientIds || clientIds.includes(c.client.id)));
    const text = `هيترحّل على حساب ${list.map((c) => `${c.client.name} (${money(c.net_amount)})`).join('، ')}. الأسعار بعد الترحيل بتتقفل، والتعديل بيبقى «تصحيح سعر».`;
    if (!await confirmModal('اعتماد التسعير والترحيل', text, 'اعتمد ورحّل')) return;
    try {
      const r = await post(`/api/pricing/sheets/${id}/post`, clientIds ? { client_ids: clientIds } : {});
      toast(`اترحّل ${r.batches.map((b) => b.serial).join('، ')}`, false, r.priced_status === 'posted'
        ? { action: { label: 'الورقة اللي بعدها', onClick: () => ctx.go('#/pricing') } } : {});
      reload(r.sheet);
    } catch (ex) {
      toastError(ex);
      if (ex.data?.problems) reload();
    }
  }

  draw();
}

const BILLING_LABELS = {
  bend: 'بالتنية', cut: 'بالقصة', minute: 'بالدقيقة', louver: 'باللوفر', kg: 'بالكيلو', piece: 'سعر محدد للقطعة', lump: 'مبلغ مقطوع',
};
