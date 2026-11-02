// Dates in the workbook. Three habits meet here:
//   - typed as text «27-8-2026» / «21/9/2026» (day first) — read as day/month/year;
//   - typed so Excel turned them into a date with day and month SWAPPED (a US-locale Excel
//     reads «2/9/2026» as February 9th): any stored date whose day is ≤ 12 is ambiguous and
//     is read the way that fits its neighbours (and is never in the future);
//   - left empty under a date: the row inherits the date of the row above. The first empty
//     row of a column has nothing above it: it is flagged for the admin (default: the first
//     date below it, else the run's fallback date).
// Every guess is reported (kind swapped / inherited_first / invalid / conflict) so the admin
// can change it in the preview; decisions override a cell before the inheritance runs.
import { toAsciiDigits, isRealDate } from '../util.js';

const pad = (n) => String(n).padStart(2, '0');
export const iso = (y, m, d) => isRealDate(`${y}-${pad(m)}-${pad(d)}`);
const dayNo = (s) => Math.round(Date.parse(`${s}T12:00:00Z`) / 86400000);

// One raw cell → { candidates: [iso…], text, ambiguous } or null when empty.
// Excel serial numbers (a date typed into a number cell) count as stored dates.
export function readDateCell(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date || (typeof v === 'number' && v > 30000 && v < 80000)) {
    const d = v instanceof Date ? v : new Date(Math.round((v - 25569) * 86400000));
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    const asIs = iso(y, m, day);
    const swapped = day <= 12 && day !== m ? iso(y, day, m) : null;
    return { text: `${day}/${m}/${y}`, stored: true, candidates: [asIs, swapped].filter(Boolean), swapped };
  }
  const s = toAsciiDigits(String(v)).trim();
  let m = s.match(/^(\d{1,2})\s*[-/.\\]\s*(\d{1,2})\s*[-/.\\]\s*(\d{4})$/);
  if (m) {
    const d = iso(Number(m[3]), Number(m[2]), Number(m[1]));
    return { text: s, stored: false, candidates: d ? [d] : [], invalid: !d };
  }
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) {
    const d = iso(Number(m[1]), Number(m[2]), Number(m[3]));
    return { text: s, stored: false, candidates: d ? [d] : [], invalid: !d };
  }
  return { text: s, stored: false, candidates: [], invalid: true };
}

// A date written inside a sentence («شيك بتاريخ 9/10/2026»): day/month/year.
export function dateInText(text) {
  const s = toAsciiDigits(String(text ?? ''));
  const m = s.match(/(\d{1,2})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{4})/);
  return m ? iso(Number(m[3]), Number(m[2]), Number(m[1])) : null;
}

// Resolves one column of dates.
// cells: [{ ref, value }] in row order (only rows that carry data).
// opts: { today, fallback, overrides: { ref: iso }, median }
// Returns Map(ref → { date, kind, text, options? }) where kind is one of
//   'typed' (clear), 'swapped' (stored day/month read the other way), 'stored_ambiguous'
//   (stored, ≤ 12, kept as stored), 'inherited', 'inherited_first' (flagged), 'invalid'
//   (unreadable text, treated like empty and flagged), 'override' (the admin's choice).
export function resolveColumn(cells, { today, fallback = null, overrides = {}, median = null } = {}) {
  const parsed = cells.map((c) => ({ ...c, d: overrides[c.ref] ? { candidates: [overrides[c.ref]], override: true } : readDateCell(c.value) }));
  const firm = (p) => p.d && p.d.candidates.length === 1 && !(p.d.stored && p.d.swapped);
  const out = new Map();
  let prev = null;
  const notFuture = (list) => {
    const ok = list.filter((x) => !today || x <= today);
    return ok.length ? ok : list;
  };
  const pending = [];
  const flush = (date) => {
    pending.forEach((p, j) => out.set(p.ref, { date, kind: p.d?.invalid ? 'invalid' : j === 0 ? 'inherited_first' : 'inherited', text: p.d?.text || '' }));
    pending.length = 0;
  };
  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];
    const d = p.d;
    if (d && d.override) {
      prev = d.candidates[0];
      flush(prev);
      out.set(p.ref, { date: prev, kind: 'override', text: String(p.value ?? '') });
      continue;
    }
    if (d && d.candidates.length) {
      let date;
      let kind = 'typed';
      if (d.candidates.length === 1) {
        date = d.candidates[0];
        // a stored date in the future whose day ≤ 12 was swapped (day ≤ 12 but day == month has one reading)
        if (d.stored && today && date > today && d.swapped && d.swapped <= today) { date = d.swapped; kind = 'swapped'; }
      } else {
        const next = parsed.slice(i + 1).find(firm);
        const ref = prev ?? next?.d.candidates[0] ?? median ?? today;
        let cands = notFuture(d.candidates);
        if (prev) {
          const after = cands.filter((x) => x >= prev);
          if (after.length) cands = after;
        }
        cands = [...cands].sort((a, b) => Math.abs(dayNo(a) - dayNo(ref)) - Math.abs(dayNo(b) - dayNo(ref)));
        date = cands[0];
        kind = date === d.swapped ? 'swapped' : 'stored_ambiguous';
      }
      prev = date;
      flush(date);
      out.set(p.ref, { date, kind, text: d.text, options: d.candidates.length > 1 ? d.candidates : undefined });
      continue;
    }
    // empty or unreadable
    if (prev) {
      out.set(p.ref, { date: prev, kind: d?.invalid ? 'invalid' : 'inherited', text: d?.text || '' });
      continue;
    }
    pending.push(p); // nothing above: takes the first date found below (flagged)
  }
  flush(fallback);
  return out;
}

// The median of the firm dates of a sheet: the reference for an ambiguous date with no
// neighbour in its own column.
export function medianDate(values) {
  const list = values.map(readDateCell).filter((d) => d && d.candidates.length === 1 && !(d.stored && d.swapped)).map((d) => d.candidates[0]).sort();
  return list.length ? list[Math.floor(list.length / 2)] : null;
}

// The kinds the admin is asked to look at ('stored_ambiguous' fits its neighbours and is not asked).
export const FLAG_KINDS = new Set(['swapped', 'inherited_first', 'invalid', 'conflict']);
