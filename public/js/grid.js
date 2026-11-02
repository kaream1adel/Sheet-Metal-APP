// The reusable Excel-like editable grid (ورقة تشغيل entry, شيت التسعير, review, imports).
//
//   const g = createGrid({ columns, rows, ...options });  container.append(g.el);
//
// Conventions (the workbook's): typed cells are white inputs, computed cells are grey text.
// Enter moves down (adds a row at the end when allowed), Shift+Enter up, Tab across, Esc undoes
// the cell. Arabic or Western digits; "٫" and "," decimals. "~", "//", "〃" (and ״ ") mean "same
// as the row above": the value is copied, the key is kept in row.ditto_fields, and it follows
// the row above when that changes. On the phone (≤ 820px) rows become cards.
//
// columns: [{
//   key, label,
//   type: 'text' | 'number' | 'select' | 'date' | 'check' | 'computed',
//   width,                         min width in px of a typed cell
//   options: [[value, label]] | (row) => [[value, label]]     (select)
//   suggest: string[] | () => string[]                        (text: a datalist)
//   compute: (row, i, rows) => value                          (computed)
//   format: (value, row) => string    display of computed / totals (default: numbers via num())
//   parse: (text, row) => value       typed → value (default: number → parseNum, else trimmed text)
//   ditto: true                       allow ~ // 〃 (default true for typed columns)
//   readOnly: (row, i) => boolean     this cell shown as computed
//   total: 'sum' | (rows) => value    totals row; totalFormat: (v) => string
//   text: true                        computed text (right-aligned)
//   placeholder, title, hidden     placeholder may be (row) => string (e.g. a suggested value in grey)
// }]
// options: {
//   rows, newRow: () => ({}), canAdd = true, canDelete = true, readOnly = false,
//   onChange(row, key, value, i, grid)   after a typed cell is committed (and after ditto propagation)
//   onRowsChange(rows, grid)             after a row is added or removed
//   onDelete(row, i) → false to keep the row
//   marks(row, key, i) → { level: 'red' | 'yellow', message, seen? } | null
//   onVisit(row, key, i)                 a yellow cell got focus (acknowledge it on the server)
//   onDitto(row, key, prevRow, raw) → value      custom "same as above" (default: prevRow[key])
//   rowNumber(row, i) → label            first column (default i + 1)
//   rowTitle(row, i) → string            card title on the phone
//   cellClass(row, key, i) → string      extra classes on a cell (e.g. 'suggested' for a grey value)
//   totals: 'top' | 'bottom' | false     sticky totals row (default 'top', like the workbook)
//   maxHeight: '70vh', cards: true, keysHint: true, emptyText
// }
// returns { el, rows, getRows(), setRows(rows), refresh(), refreshRow(i), focus(i, key), addRow(row?),
//           removeRow(i), setValue(i, key, value), errors(), destroy() }
import { h, fill, icon, num, parseNum, asciiDigits, toastUndo } from './ui.js';

export const DITTO_MARKS = ['~', '//', '〃', '״', '"', '””', '“'];
export const isDitto = (raw) => DITTO_MARKS.includes(asciiDigits(raw).trim());

const PHONE = '(max-width: 820px)';

export function createGrid(opts) {
  const o = {
    newRow: () => ({}), canAdd: true, canDelete: true, readOnly: false, totals: 'top', cards: true,
    keysHint: true, maxHeight: '70vh', emptyText: 'مفيش سطور لسه', ...opts,
  };
  let rows = (o.rows || []).map((r) => ({ ...r }));
  const cols = o.columns.filter((c) => !c.hidden);
  const hasTotals = o.totals && cols.some((c) => c.total);
  const parseErrors = new Map(); // `${i}:${key}` → message (bad number typed)
  let cells = [];                // cells[i][key] = { td, input, wrap }
  let totalCells = {};
  const el = h('div', { class: 'xg' });
  const mq = window.matchMedia ? window.matchMedia(PHONE) : { matches: false, addEventListener() {}, removeEventListener() {} };
  let mode = null;

  const isTyped = (c, row, i) => c.type !== 'computed' && !o.readOnly && !(c.readOnly && c.readOnly(row, i));
  const ditto = (row) => (Array.isArray(row.ditto_fields) ? row.ditto_fields : (row.ditto_fields = parseList(row.ditto_fields)));
  const optionsOf = (c, row) => (typeof c.options === 'function' ? c.options(row) : c.options || []);
  const placeholderOf = (c, row) => (typeof c.placeholder === 'function' ? c.placeholder(row) || '' : c.placeholder || '');

  function display(c, row, i) {
    const v = c.type === 'computed' ? c.compute?.(row, i, rows) : row[c.key];
    if (c.format) return c.format(v, row);
    if (c.type === 'select') return optionsOf(c, row).find(([x]) => String(x) === String(v ?? ''))?.[1] ?? '';
    if (c.type === 'check') return v ? 'نعم' : '';
    if (typeof v === 'number') return num(v);
    return v ?? '';
  }

  function inputValue(c, row) {
    const v = row[c.key];
    if (v === null || v === undefined) return '';
    return typeof v === 'number' ? String(Number(v.toFixed(6))) : String(v);
  }

  function parse(c, raw, row) {
    if (c.parse) return c.parse(raw, row);
    if (c.type === 'number') return parseNum(raw);
    if (c.type === 'check') return !!raw;
    if (c.type === 'select') return raw === '' ? null : (/^\d+$/.test(raw) ? Number(raw) : raw);
    const s = String(raw ?? '').trim();
    return s === '' ? null : s;
  }

  // ---------- committing a cell ----------
  function commit(i, c, raw) {
    const row = rows[i];
    const k = `${i}:${c.key}`;
    parseErrors.delete(k);
    const list = ditto(row);
    const at = list.indexOf(c.key);
    if (c.ditto !== false && c.type !== 'check' && isDitto(raw)) {
      const prev = rows[i - 1];
      if (!prev) {
        parseErrors.set(k, 'مفيش سطر فوقه ينسخ منه');
      } else {
        row[c.key] = o.onDitto ? o.onDitto(row, c.key, prev, raw) : prev[c.key];
        if (at < 0) list.push(c.key);
      }
    } else {
      const v = parse(c, raw, row);
      if (typeof v === 'number' && Number.isNaN(v)) {
        parseErrors.set(k, 'اكتب رقم صحيح');
      } else {
        row[c.key] = v;
        if (at >= 0) list.splice(at, 1);
      }
    }
    propagate(i, c.key);
    o.onChange?.(row, c.key, row[c.key], i, api);
    refreshRow(i, c.key);
    for (let j = i + 1; j < rows.length && ditto(rows[j]).includes(c.key); j++) refreshRow(j);
    refreshTotals();
  }

  // Rows below that said "same as above" for this key follow the new value.
  function propagate(i, key) {
    for (let j = i + 1; j < rows.length; j++) {
      if (!ditto(rows[j]).includes(key)) break;
      const c = cols.find((x) => x.key === key);
      rows[j][key] = o.onDitto ? o.onDitto(rows[j], key, rows[j - 1], '~') : rows[j - 1][key];
      if (c) o.onChange?.(rows[j], key, rows[j][key], j, api);
    }
  }

  // ---------- moving ----------
  function focus(i, key) {
    const cell = cells[i]?.[key];
    const target = cell?.input;
    if (target) {
      target.focus();
      if (target.select && target.tagName === 'INPUT') target.select();
      return true;
    }
    return false;
  }
  function move(i, c, delta) {
    const j = i + delta;
    if (j < 0) return;
    if (j >= rows.length) {
      if (!o.canAdd || o.readOnly || delta < 0) return;
      addRow();
    }
    // next typed cell in this column, skipping read-only rows
    for (let k = j; k >= 0 && k < rows.length; k += delta) if (focus(k, c.key)) return;
  }

  function keydown(e, i, c, input) {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.dispatchEvent(new Event('change'));
      move(i, c, e.shiftKey ? -1 : 1);
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && input.tagName === 'INPUT' && !e.altKey) {
      e.preventDefault();
      input.dispatchEvent(new Event('change'));
      move(i, c, e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Escape') {
      input.value = inputValue(c, rows[i]);
    }
  }

  // ---------- one cell's control ----------
  function control(i, c) {
    const row = rows[i];
    let input;
    if (c.type === 'select') {
      input = h('select', { 'aria-label': c.label },
        h('option', { value: '' }, ''),
        optionsOf(c, row).map(([v, l]) => h('option', { value: v, selected: String(v) === String(row[c.key] ?? '') }, l)));
      input.addEventListener('change', () => commit(i, c, input.value));
    } else if (c.type === 'check') {
      input = h('input', { type: 'checkbox', checked: !!row[c.key], 'aria-label': c.label });
      input.addEventListener('change', () => commit(i, c, input.checked));
    } else {
      const sug = typeof c.suggest === 'function' ? c.suggest() : c.suggest;
      const listId = sug?.length ? `xg-dl-${c.key}` : null;
      input = h('input', {
        type: c.type === 'date' ? 'date' : 'text', value: inputValue(c, row), placeholder: placeholderOf(c, row),
        inputmode: c.type === 'number' ? 'decimal' : null, class: c.type === 'number' ? 'n' : null,
        autocomplete: 'off', list: listId, 'aria-label': c.label, title: c.title || null,
      });
      if (listId && !document.getElementById(listId)) document.body.append(h('datalist', { id: listId }, sug.map((s) => h('option', { value: s }))));
      input.addEventListener('change', () => {
        if (input.value !== inputValue(c, rows[i]) || isDitto(input.value) || parseErrors.has(`${i}:${c.key}`)) commit(i, c, input.value);
      });
    }
    input.addEventListener('keydown', (e) => keydown(e, i, c, input));
    input.addEventListener('focus', () => {
      el.querySelectorAll('tr.sel').forEach((t) => t.classList.remove('sel'));
      cells[i]?._tr?.classList.add('sel');
      const m = o.marks?.(rows[i], c.key, i);
      if (m?.level === 'yellow' && !m.seen) {
        o.onVisit?.(rows[i], c.key, i);
        cells[i][c.key].td.classList.add('seen');
      }
    });
    if (c.width) input.style.setProperty('--w', `${c.width}px`);
    return input;
  }

  function markOf(i, c) {
    const pe = parseErrors.get(`${i}:${c.key}`);
    if (pe) return { level: 'red', message: pe };
    return o.marks?.(rows[i], c.key, i) || null;
  }

  function decorate(td, i, c) {
    const m = markOf(i, c);
    td.classList.toggle('mark-red', m?.level === 'red');
    td.classList.toggle('mark-yellow', m?.level === 'yellow');
    td.classList.toggle('seen', !!m?.seen);
    td.classList.toggle('ditto', ditto(rows[i]).includes(c.key));
    td.title = m?.message || (ditto(rows[i]).includes(c.key) ? 'زي اللي فوقه' : '');
    if (o.cellClass) {
      if (td.dataset.xc) td.classList.remove(...td.dataset.xc.split(' '));
      const extra = String(o.cellClass(rows[i], c.key, i) || '').trim();
      if (extra) td.classList.add(...extra.split(/\s+/));
      td.dataset.xc = extra;
    }
  }

  // ---------- table mode ----------
  function renderTable() {
    cells = [];
    const head = h('tr', {}, h('th', {}, 'م'), cols.map((c) => h('th', { title: c.title || null }, c.label)),
      o.canDelete && !o.readOnly ? h('th', {}, h('span', { class: 'sr-only' }, 'حذف')) : null);
    totalCells = {};
    const totalsRow = hasTotals ? h('tr', { class: 'xg-totals' }, h('td', { class: 'rn' }, 'Σ'), cols.map((c) => {
      const td = h('td', {});
      if (c.total) totalCells[c.key] = td;
      return td;
    }), o.canDelete && !o.readOnly ? h('td') : null) : null;
    const body = h('tbody', {}, rows.map((row, i) => rowEl(row, i)));
    const table = h('table', { class: 'xg' },
      h('thead', {}, head, o.totals === 'top' ? totalsRow : null),
      body,
      o.totals === 'bottom' && totalsRow ? h('tfoot', {}, totalsRow) : null);
    const wrap = h('div', { class: `xg-wrap${o.cards ? ' can-cards' : ''}`, style: `--xg-max:${o.maxHeight}` }, table);
    if (!rows.length) wrap.append(h('div', { class: 'empty compact' }, h('div', { class: 'small' }, o.emptyText)));
    fill(el, wrap, footer());
    refreshTotals();
    requestAnimationFrame(() => { const th = table.querySelector('thead th'); if (th) table.style.setProperty('--xg-head', `${th.offsetHeight}px`); });
  }

  function rowEl(row, i) {
    cells[i] = {};
    const tr = h('tr', {});
    cells[i]._tr = tr;
    tr.append(h('td', { class: 'rn' }, o.rowNumber ? o.rowNumber(row, i) : i + 1));
    for (const c of cols) {
      let td;
      if (isTyped(c, row, i)) {
        const input = control(i, c);
        td = h('td', { class: 'typed' }, input);
        cells[i][c.key] = { td, input };
      } else {
        td = h('td', { class: `computed${c.text || c.type === 'text' || c.type === 'select' ? ' text' : ''}` }, display(c, row, i));
        cells[i][c.key] = { td };
      }
      decorate(td, i, c);
      tr.append(td);
    }
    if (o.canDelete && !o.readOnly) {
      tr.append(h('td', { class: 'act' }, h('button', { type: 'button', title: 'امسح السطر', 'aria-label': `امسح السطر ${i + 1}`, onclick: () => removeRow(i) }, icon('trash', 'sm'))));
    }
    return tr;
  }

  // ---------- card mode (phone) ----------
  function renderCards() {
    cells = [];
    const list = h('div', { class: 'xg-cards' });
    if (hasTotals) {
      totalCells = {};
      list.append(h('div', { class: 'xg-card totals' }, h('div', { class: 't' }, 'الإجمالي'),
        cols.filter((c) => c.total).map((c) => { const v = h('div', { class: 'v' }); totalCells[c.key] = v; return h('div', { class: 'f' }, h('label', {}, c.label), v); })));
    }
    rows.forEach((row, i) => {
      cells[i] = {};
      const card = h('div', { class: 'xg-card' }, h('div', { class: 't' },
        h('span', {}, o.rowTitle ? o.rowTitle(row, i) : `سطر ${o.rowNumber ? o.rowNumber(row, i) : i + 1}`),
        o.canDelete && !o.readOnly ? h('button', { class: 'icon-btn danger', type: 'button', 'aria-label': 'امسح السطر', onclick: () => removeRow(i) }, icon('trash', 'sm')) : null));
      cells[i]._tr = card;
      for (const c of cols) {
        let f;
        if (isTyped(c, row, i)) {
          const input = control(i, c);
          f = h('div', { class: 'f' }, h('label', {}, c.label), input);
          cells[i][c.key] = { td: f, input };
        } else {
          f = h('div', { class: 'f' }, h('label', {}, c.label), h('div', { class: 'v' }, display(c, row, i)));
          cells[i][c.key] = { td: f };
        }
        decorate(f, i, c);
        card.append(f);
      }
      list.append(card);
    });
    if (!rows.length) list.append(h('div', { class: 'card empty compact' }, h('div', { class: 'small' }, o.emptyText)));
    fill(el, list, footer());
    refreshTotals();
  }

  function footer() {
    if (o.readOnly || (!o.canAdd && !o.keysHint)) return null;
    return h('div', { class: 'xg-foot' },
      o.canAdd ? h('button', { class: 'btn sm', type: 'button', onclick: () => { addRow(); focus(rows.length - 1, cols.find((c) => isTyped(c, rows[rows.length - 1], rows.length - 1))?.key); } }, icon('plus', 'sm'), 'سطر جديد') : null,
      o.keysHint ? h('span', { class: 'xg-keys' }, 'Enter للسطر اللي تحت · Tab للخانة اللي جنبها · ~ أو // يعني زي اللي فوقه') : null);
  }

  // ---------- refreshing without losing focus ----------
  // force: a key whose input is refreshed even while focused (the cell just committed).
  function refreshRow(i, force = null) {
    const row = rows[i];
    if (!row || !cells[i]) return;
    for (const c of cols) {
      const cell = cells[i][c.key];
      if (!cell) continue;
      if (cell.input) {
        if ((force === c.key || document.activeElement !== cell.input) && !parseErrors.has(`${i}:${c.key}`)) {
          if (cell.input.type === 'checkbox') cell.input.checked = !!row[c.key];
          else cell.input.value = inputValue(c, row);
        }
        if (typeof c.placeholder === 'function' && 'placeholder' in cell.input) cell.input.placeholder = placeholderOf(c, row);
      } else {
        const target = mode === 'cards' ? cell.td.querySelector('.v') : cell.td;
        target.textContent = display(c, row, i);
      }
      decorate(cell.td, i, c);
    }
  }

  function refreshTotals() {
    for (const c of cols) {
      const td = totalCells[c.key];
      if (!td) continue;
      const v = typeof c.total === 'function' ? c.total(rows)
        : rows.reduce((s, r, i) => s + (Number(c.type === 'computed' ? c.compute?.(r, i, rows) : r[c.key]) || 0), 0);
      td.textContent = c.totalFormat ? c.totalFormat(v) : c.format ? c.format(v, {}) : num(v);
    }
  }

  function render() {
    mode = o.cards && mq.matches ? 'cards' : 'table';
    if (mode === 'cards') renderCards(); else renderTable();
  }
  const onMq = () => render();
  mq.addEventListener?.('change', onMq);

  // ---------- rows ----------
  function addRow(row = null) {
    rows.push({ ...o.newRow(rows.length), ...(row || {}) });
    render();
    o.onRowsChange?.(rows, api);
    return rows.length - 1;
  }
  function removeRow(i) {
    const row = rows[i];
    if (!row) return;
    if (o.onDelete && o.onDelete(row, i) === false) return;
    rows.splice(i, 1);
    shiftErrors(i);
    render();
    o.onRowsChange?.(rows, api);
    toastUndo(`اتمسح السطر ${i + 1}`, () => {
      rows.splice(i, 0, row);
      render();
      o.onRowsChange?.(rows, api);
    });
  }
  function shiftErrors(from) {
    const next = new Map();
    for (const [k, v] of parseErrors) {
      const [i, key] = k.split(':');
      const n = Number(i);
      if (n < from) next.set(k, v); else if (n > from) next.set(`${n - 1}:${key}`, v);
    }
    parseErrors.clear();
    for (const [k, v] of next) parseErrors.set(k, v);
  }

  const api = {
    el,
    get rows() { return rows; },
    getRows: () => rows,
    setRows(next) { rows = (next || []).map((r) => ({ ...r })); parseErrors.clear(); render(); },
    refresh: () => render(),
    refreshRow: (i) => { refreshRow(i); refreshTotals(); },
    setValue(i, key, value) { if (!rows[i]) return; rows[i][key] = value; propagate(i, key); refreshRow(i); refreshTotals(); },
    focus,
    addRow,
    removeRow,
    errors: () => [...parseErrors.entries()].map(([k, message]) => { const [i, key] = k.split(':'); return { row: Number(i), key, message }; }),
    destroy() { mq.removeEventListener?.('change', onMq); el.remove(); },
  };
  render();
  return api;
}

function parseList(v) {
  if (!v) return [];
  try { const x = JSON.parse(v); return Array.isArray(x) ? x : []; } catch { return []; }
}
