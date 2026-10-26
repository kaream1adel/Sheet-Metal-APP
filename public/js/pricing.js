// Pricing (admin). Lines come pre-filled from the price memory; the admin changes
// only the exceptions, groups lines into items if needed, and approves.
import { h, toast, money, fmtDate, fmtNum, asciiDigits, formModal, icon, pageHead, emptyState } from './ui.js';
import { get, post, patch } from './api.js';
import { go } from './app.js';

const toP = (s) => {               // "2.50" → 250 piastres, '' → null
  const t = asciiDigits(String(s ?? '')).replace(/,/g, '').trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : NaN;
};
const fromP = (p) => (p === null || p === undefined ? '' : (p / 100).toFixed(2));
const num = (s) => { const n = Number(asciiDigits(String(s ?? '')).replace(/,/g, '')); return Number.isFinite(n) ? n : NaN; };

const FACT_LABELS = { pieces: 'قطع', ops_per_piece: 'عمليات/قطعة', total_written: 'إجمالي', sheets: 'ألواح', minutes_per_sheet: 'دقائق/لوح',
  sheet_size: 'مقاس', pieces_per_sheet: 'قطع/لوح', hits_per_piece: 'ضربات/قطعة', louvers_per_piece: 'لوفر/قطعة', minutes: 'دقائق' };

export async function renderPricing(main, clientId) {
  const { clients } = await get('/api/pricing/clients');
  const side = h('div', { class: 'card', style: 'padding:8px;min-width:190px' },
    clients.length === 0 ? h('div', { class: 'muted', style: 'padding:8px' }, 'مفيش شغل مستني تسعير')
      : clients.map((c) => h('a', { href: `#/pricing/${c.id}`, class: 'plist' + (Number(clientId) === c.id ? ' on' : '') },
        h('span', {}, c.name), h('span', { class: 'badge-s' }, c.lines))));
  const body = h('div', { style: 'flex:1;min-width:0' });
  main.replaceChildren(pageHead('التسعير', 'الشغل المتأكد جاهز هنا متقسم على العملاء. الأسعار المحفوظة متعبية لوحدها — غيّر الاستثناءات واعتمد.'),
    h('div', { class: 'pricing-wrap' }, side, body));
  if (!clientId && clients[0]) return go(`#/pricing/${clients[0].id}`);
  if (!clientId) { body.append(emptyState('check-circle', 'كل الشغل المتأكد متسعر', 'أول ما ورقة تتأكد، سطورها هتظهر هنا عند عملاؤها.')); return; }
  await renderClientPricing(body, Number(clientId));
}

async function renderClientPricing(body, clientId) {
  const data = await get(`/api/pricing/clients/${clientId}`);
  const U = data.units;
  const lines = data.lines.map((l) => ({
    ...l, selected: true,
    charges: l.charges.map((c) => ({ ...c, rateText: fromP(c.rate), qtyText: c.qty === null ? '' : String(c.qty) })),
  }));
  const bundles = [];
  const inBundle = () => new Set(bundles.flatMap((b) => b.line_ids));

  const listBox = h('div');
  const footBox = h('div', { class: 'card', style: 'margin-top:12px' });
  const discountIn = h('input', { type: 'text', inputmode: 'decimal', placeholder: '0.00', style: 'width:100px', oninput: drawFoot });
  const discountReason = h('input', { type: 'text', placeholder: 'سبب الخصم', style: 'width:160px' });
  const dueIn = h('input', { type: 'date' });

  body.replaceChildren(
    h('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:10px' },
      h('div', {}, h('b', { style: 'font-size:17px' }, data.client.name), ' ',
        h('span', { class: 'muted small' }, `· ${data.lines.length} سطر مستني تسعير · الرصيد الحالي ${money(data.balance)}`)),
      h('div', { class: 'row' },
        // The routine case in one click: everything whose price is remembered for this client.
        h('button', { class: 'btn', title: 'يحدد السطور اللي كل أسعارها محفوظة لنفس العميل (الخضرا)', onclick: () => {
          let n = 0;
          for (const l of lines) { l.selected = l.charges.length > 0 && l.charges.every((c) => c.source === 'exact'); if (l.selected) n++; }
          draw();
          toast(n ? `اتحدد ${n} سطر ليهم سعر محفوظ — اعتمدهم من تحت` : 'مفيش سطور كل أسعارها محفوظة', !n);
        } }, icon('check-circle'), 'اللي ليه سعر محفوظ'),
        h('button', { class: 'btn', onclick: () => bundleSelected() }, 'بند مجمّع للمحدد'),
        h('button', { class: 'btn', onclick: oneRate }, 'سعر واحد للمحدد'),
        h('button', { class: 'btn', onclick: raise }, 'زوّد ٪'),
        h('a', { class: 'btn', href: `#/clients/${clientId}` }, 'صفحة العميل'))),
    data.groups.length ? h('div', { class: 'row small', style: 'margin-bottom:10px' }, h('span', { class: 'muted' }, 'اقتراح:'),
      data.groups.map((g) => h('button', { class: 'btn sm', onclick: () => bundleSelected(g.line_ids, g.part_name) },
        `اجمع "${g.part_name}" في بند (${g.line_ids.length} سطور)`))) : '',
    listBox, footBox);

  function draw() {
    const hidden = inBundle();
    const rows = [];
    for (const b of bundles) {
      rows.push(h('tr', { class: 'bundle' },
        h('td', {}, h('button', { class: 'btn sm danger', title: 'فك البند', onclick: () => { bundles.splice(bundles.indexOf(b), 1); draw(); } }, '×')),
        h('td', {}, h('b', {}, b.description), h('div', { class: 'small muted' }, `بند مجمّع · ${b.line_ids.length} سطر`)),
        h('td', {}, U[b.unit]), h('td', { class: 'num' }, b.unit === 'fixed' ? '1' : fmtNum(b.qty)),
        h('td', { class: 'num' }, fromP(b.rate)), h('td', { class: 'num' }, money(Math.round((b.unit === 'fixed' ? 1 : b.qty) * b.rate)))));
      for (const id of b.line_ids) {
        const l = lines.find((x) => x.id === id);
        rows.push(h('tr', { class: 'included' }, h('td'), h('td', { colspan: 5 }, `↳ ${l.text} — ${fmtDate(l.date)}`)));
      }
    }
    let lastKey = '';
    for (const l of lines) {
      if (hidden.has(l.id)) continue;
      const key = `${l.date}|${l.machine_name}`;
      if (key !== lastKey) {
        rows.push(h('tr', { class: 'day' }, h('td', { colspan: 6 }, `${fmtDate(l.date)} · ${l.machine_name}`)));
        lastKey = key;
      }
      l.charges.forEach((c, ci) => rows.push(chargeRow(l, c, ci)));
    }
    listBox.replaceChildren(h('div', { class: 'table-wrap' }, h('table', { class: 'price-table' },
      h('thead', {}, h('tr', {}, ['', 'الشغل', 'المحاسبة', 'الكمية', 'السعر', 'المبلغ'].map((t) => h('th', {}, t)))),
      h('tbody', {}, rows))),
    h('div', { class: 'small muted', style: 'margin-top:6px' }, 'أخضر = آخر سعر لنفس العميل · أصفر = مقترح من سمك أو عميل قريب · أحمر = أول مرة'));
    drawFoot();
  }

  function chargeRow(l, c, ci) {
    const first = ci === 0;
    const amountCell = h('td', { class: 'num' });
    const qtyOf = () => (c.qty === null ? num(c.qtyText) : c.qty);
    const updateAmount = () => {
      const r = toP(c.rateText); const q = qtyOf();
      amountCell.textContent = r === null || Number.isNaN(r) || !(q > 0) ? '—' : money(Math.round(q * r));
    };
    const unitSel = h('select', { onchange: (e) => {
      c.unit = e.target.value;
      const u = l.units.find((x) => x.unit === c.unit);
      c.qty = u.qty;
      c.qtyText = c.qty === null ? '' : String(c.qty);
      c.source = 'manual';
      draw();
    } }, l.units.map((u) => h('option', { value: u.unit, selected: u.unit === c.unit }, u.label)));
    const qtyCell = c.qty === null
      ? h('input', { type: 'text', class: 'n', value: c.qtyText, placeholder: 'الكمية', style: 'width:80px', oninput: (e) => { c.qtyText = e.target.value; updateAmount(); drawFoot(); } })
      : h('span', { class: 'num' }, fmtNum(c.qty));
    const cls = c.source === 'exact' ? 'rate-g' : c.source === 'near' ? 'rate-y' : c.source === 'none' ? 'rate-r' : '';
    const rateCell = h('td');
    const rateIn = h('input', { type: 'text', class: `n ${cls}`, value: c.rateText, inputmode: 'decimal', style: 'width:90px', title: c.note || '',
      oninput: (e) => { c.rateText = e.target.value; c.source = 'manual'; e.target.className = 'n'; updateAmount(); drawFoot(); },
      onchange: () => offerSimilar(l, c, rateCell) });
    rateCell.append(rateIn);
    updateAmount();
    return h('tr', {},
      h('td', {}, first ? h('input', { type: 'checkbox', checked: l.selected, onchange: (e) => { l.selected = e.target.checked; drawFoot(); } }) : null),
      h('td', {}, first ? [h('div', {}, l.text, l.delivered ? h('span', { class: 'small muted' }, ` · اتسلم ${fmtDate(l.delivered)}`) : null),
        h('div', { class: 'small muted' }, Object.entries(l.facts).filter(([, v]) => v !== null && v !== '').map(([k, v]) => `${FACT_LABELS[k]} ${typeof v === 'number' ? fmtNum(v) : v}`).join(' · '),
          ' ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); fixLine(l); } }, 'تعديل الكمية')),
      ] : h('span', { class: 'small muted' }, '↳ رسم تاني على نفس السطر')),
      h('td', {}, h('div', { class: 'row', style: 'flex-wrap:nowrap;gap:4px' }, unitSel,
        first ? h('button', { class: 'btn sm', title: 'وحدة تانية لنفس السطر', onclick: () => addCharge(l) }, '+')
          : h('button', { class: 'btn sm danger', title: 'شيل', onclick: () => { l.charges.splice(ci, 1); draw(); } }, '×'))),
      h('td', {}, qtyCell), rateCell, amountCell);
  }

  function addCharge(l) {
    const used = new Set(l.charges.map((c) => c.unit));
    const u = l.units.find((x) => !used.has(x.unit));
    if (!u) return toast('كل الوحدات مستخدمة', true);
    l.charges.push({ unit: u.unit, qty: u.qty, qtyText: u.qty === null ? '' : String(u.qty), rateText: '', source: 'none' });
    draw();
  }

  // After typing a rate, offer it (inline, under the box) to the other similar lines on screen.
  function offerSimilar(l, c, cell) {
    cell.querySelector('.similar')?.remove();
    const r = toP(c.rateText);
    if (r === null || Number.isNaN(r)) return;
    const similar = lines.filter((x) => x !== l && !inBundle().has(x.id) && x.machine_code === l.machine_code &&
      x.material_id === l.material_id && Number(x.thickness) === Number(l.thickness))
      .flatMap((x) => x.charges.filter((y) => y.unit === c.unit && toP(y.rateText) !== r));
    if (!similar.length) return;
    cell.append(h('div', { class: 'similar' }, h('button', { class: 'btn sm', type: 'button',
      onclick: () => { similar.forEach((y) => { y.rateText = fromP(r); y.source = 'manual'; }); draw(); } },
    `طبّق على ${similar.length} سطر مشابه`)));
  }

  const selectedLines = () => lines.filter((l) => l.selected && !inBundle().has(l.id));

  async function bundleSelected(ids, partName) {
    const pick = ids ? lines.filter((l) => ids.includes(l.id) && !inBundle().has(l.id)) : selectedLines();
    if (!pick.length) return toast('علّم على السطور اللي هتتجمع', true);
    const pieces = pick.reduce((s, l) => s + (Number(l.facts.pieces) || 0), 0);
    const r = await formModal({
      title: `بند مجمّع (${pick.length} سطر)`,
      fields: [
        { name: 'description', label: 'وصف البند (هيظهر في كشف الحساب)', value: partName || pick.find((l) => l.part_name)?.part_name || '' },
        { name: 'unit', label: 'المحاسبة', type: 'select', value: 'meter', options: [['meter', 'متر'], ['piece', 'قطعة'], ['sheet', 'لوح'], ['fixed', 'مبلغ ثابت']] },
        { name: 'qty', label: 'الكمية (للمبلغ الثابت سيبها فاضية)', help: pieces ? `مجموع القطع في السطور: ${fmtNum(pieces)} — مثلاً ${fmtNum(pieces)} قطعة × طول القطعة = الأمتار` : '' },
        { name: 'rate', label: 'السعر للوحدة (أو المبلغ كله لو ثابت)' },
      ],
      submitLabel: 'اعمل البند',
      onSubmit: (v) => {
        if (!v.description.trim()) throw new Error('اكتب وصف البند');
        const qty = v.unit === 'fixed' ? 1 : num(v.qty);
        if (!(qty > 0)) throw new Error('اكتب الكمية');
        const rate = toP(v.rate);
        if (rate === null || Number.isNaN(rate)) throw new Error('اكتب السعر');
        return { description: v.description.trim(), unit: v.unit, qty, rate, line_ids: pick.map((l) => l.id) };
      },
    });
    if (r && r !== true) { bundles.push(r); draw(); }
  }

  async function oneRate() {
    const pick = selectedLines();
    if (!pick.length) return toast('علّم على السطور الأول', true);
    const r = await formModal({ title: `سعر واحد لـ ${pick.length} سطر`, fields: [{ name: 'rate', label: 'السعر للوحدة (أول رسم في كل سطر)' }],
      onSubmit: (v) => { const p = toP(v.rate); if (p === null || Number.isNaN(p)) throw new Error('السعر غلط'); return p; } });
    if (typeof r === 'number') { pick.forEach((l) => { l.charges[0].rateText = fromP(r); l.charges[0].source = 'manual'; }); draw(); }
  }

  async function raise() {
    const pick = selectedLines();
    if (!pick.length) return toast('علّم على السطور الأول', true);
    const r = await formModal({ title: 'زوّد الأسعار بنسبة', fields: [{ name: 'pct', label: 'النسبة ٪ (بالسالب للتخفيض)', value: '10' }],
      onSubmit: (v) => { const n = num(v.pct); if (!Number.isFinite(n)) throw new Error('رقم غلط'); return { pct: n }; } });
    if (r?.pct !== undefined) {
      pick.forEach((l) => l.charges.forEach((c) => {
        const p = toP(c.rateText);
        if (p !== null && !Number.isNaN(p)) { c.rateText = fromP(Math.round(p * (1 + r.pct / 100))); c.source = 'manual'; }
      }));
      draw();
    }
  }

  async function fixLine(l) {
    const fields = ['thickness', ...Object.keys(l.facts).filter((k) => k !== 'sheet_size')].map((k) => ({
      name: k, label: k === 'thickness' ? 'السمك مم' : FACT_LABELS[k], value: k === 'thickness' ? (l.thickness ?? '') : (l.facts[k] ?? ''),
    }));
    const ok = await formModal({ title: `تعديل كمية: ${l.text}`, fields, submitLabel: 'حفظ (هيتسجل باسمك)',
      onSubmit: (v) => patch(`/api/lines/${l.id}`, v) });
    if (ok) { toast('اتعدل'); renderClientPricing(body, clientId); }
  }

  function payload() {
    const charges = [];
    for (const l of selectedLines()) {
      for (const c of l.charges) {
        const rate = toP(c.rateText);
        if (rate === null || Number.isNaN(rate)) throw new Error(`${l.text}: اكتب السعر`);
        if (c.qty === null && !(num(c.qtyText) > 0)) throw new Error(`${l.text}: اكتب الكمية`);
        charges.push({ line_id: l.id, unit: c.unit, rate: (rate / 100).toFixed(2), qty: c.qty === null ? c.qtyText : undefined });
      }
    }
    return {
      client_id: clientId, charges, due_date: dueIn.value || null,
      bundles: bundles.map((b) => ({ ...b, rate: (b.rate / 100).toFixed(2) })),
      discount: discountIn.value ? { amount: discountIn.value, reason: discountReason.value } : null,
    };
  }

  function total() {
    let t = 0;
    for (const l of selectedLines()) for (const c of l.charges) {
      const r = toP(c.rateText); const q = c.qty === null ? num(c.qtyText) : c.qty;
      if (r !== null && !Number.isNaN(r) && q > 0) t += Math.round(q * r);
    }
    for (const b of bundles) t += Math.round((b.unit === 'fixed' ? 1 : b.qty) * b.rate);
    const d = toP(discountIn.value);
    if (d && !Number.isNaN(d)) t -= d;
    return t;
  }

  function drawFoot() {
    const t = total();
    const missing = selectedLines().some((l) => l.charges.some((c) => { const r = toP(c.rateText); return r === null || Number.isNaN(r); }));
    footBox.replaceChildren(h('div', { class: 'row', style: 'justify-content:space-between' },
      h('div', { class: 'row' },
        h('span', { class: 'muted small' }, 'خصم'), discountIn, discountReason,
        h('span', { class: 'muted small' }, 'موعد الاستحقاق (اختياري)'), dueIn),
      h('div', { class: 'row' },
        h('span', {}, 'المحدد: ', h('b', {}, money(t))),
        h('span', { class: 'muted small' }, `الرصيد بعد الاعتماد: ${money(data.balance + t)}`),
        h('button', { class: 'btn primary', onclick: approve, title: missing ? 'فيه سطور محددة من غير سعر' : '' }, 'اعتماد التسعير'))));
  }

  async function approve() {
    let p;
    try { p = payload(); } catch (ex) { return toast(ex.message, true); }
    if (!p.charges.length && !p.bundles.length) return toast('مفيش سطور محددة', true);
    try {
      const r = await post('/api/pricing/approve', p);
      toast(`اتعتمد ${money(r.total)} — الرصيد ${money(r.balance)}`);
      go(`#/pricing/${clientId}`);
    } catch (ex) { toast(ex.message, true); }
  }

  // First draw, after every helper above is defined.
  draw();
}
