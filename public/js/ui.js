// Tiny DOM helpers shared by the screens.

// h('div', {class: 'x', onclick: fn}, child, 'text', [more children])
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// Like el.replaceChildren, but skips null/false and flattens arrays (as h() does).
export function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

let toastTimer;
export function toast(msg, bad = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, bad ? 4500 : 2500);
}

// Piastres → "1,234.50 ج"
export function money(p) {
  if (p === null || p === undefined) return '';
  const neg = p < 0;
  const v = Math.abs(p);
  const s = `${Math.floor(v / 100).toLocaleString('en-US')}.${String(v % 100).padStart(2, '0')}`;
  return `${neg ? '-' : ''}${s} ج`;
}

export function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${Number(d)}/${Number(m)}/${y}`;
}

export const fmtNum = (n) => (n === null || n === undefined ? '' : String(Number(n.toFixed(3))));

export function todayISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Arabic digits → Western, for anything typed.
export const asciiDigits = (s) => String(s ?? '')
  .replace(/[٠-٩]/g, (c) => '٠١٢٣٤٥٦٧٨٩'.indexOf(c))
  .replace(/[۰-۹]/g, (c) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(c))
  .replace(/٫/g, '.');

// Arabic letter folding for search: أإآ→ا, ى→ي, ة→ه, no diacritics.
export const fold = (s) => asciiDigits(s).toLowerCase()
  .replace(/[ً-ْـ]/g, '')
  .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').trim();

// A simple modal with a form. fields: [{name, label, type, value, options}]
export function formModal({ title, fields, submitLabel = 'حفظ', onSubmit }) {
  return new Promise((resolve) => {
    const err = h('div', { class: 'err' });
    const inputs = {};
    const body = fields.map((f) => {
      let input;
      if (f.type === 'select') {
        input = h('select', { name: f.name }, f.options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(f.value) }, l)));
      } else if (f.type === 'checkbox') {
        input = h('input', { type: 'checkbox', name: f.name, checked: !!f.value });
      } else if (f.type === 'textarea') {
        input = h('textarea', { name: f.name, rows: 3 }, f.value ?? '');
      } else {
        input = h('input', { type: f.type || 'text', name: f.name, value: f.value ?? '', autocomplete: 'off', placeholder: f.placeholder || '' });
      }
      inputs[f.name] = input;
      return h('div', { class: 'field' }, h('label', {}, f.label), input, f.help ? h('div', { class: 'small muted' }, f.help) : null);
    });
    const close = (v) => { back.remove(); resolve(v); };
    const form = h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        const values = {};
        for (const [k, el] of Object.entries(inputs)) values[k] = el.type === 'checkbox' ? el.checked : el.value;
        try {
          const r = await onSubmit(values);
          close(r ?? true);
        } catch (ex) { err.textContent = ex.message; }
      },
    }, h('h2', {}, title), h('div', { class: 'grid' }, body), err,
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, submitLabel),
      h('button', { class: 'btn', type: 'button', onclick: () => close(null) }, 'إلغاء')));
    const back = h('div', { class: 'modal-back', onclick: (e) => { if (e.target === back) close(null); } }, h('div', { class: 'modal' }, form));
    document.body.append(back);
    setTimeout(() => form.querySelector('input,select,textarea')?.focus(), 30);
  });
}

export function confirmModal(title, text, okLabel = 'تمام') {
  return new Promise((resolve) => {
    const close = (v) => { back.remove(); resolve(v); };
    const back = h('div', { class: 'modal-back' }, h('div', { class: 'modal' },
      h('h2', {}, title), h('p', {}, text),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => close(true) }, okLabel),
        h('button', { class: 'btn', onclick: () => close(false) }, 'رجوع'))));
    document.body.append(back);
  });
}
