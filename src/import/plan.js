// From the parsed workbook to an import plan: who is who (name merges), every date resolved,
// partner rows classified, expense categories and cost centres suggested, duplicates found,
// and the Excel figures the result must reconcile with. The admin's decisions (from the
// preview) are applied here, so the same function serves the preview and the import.
//
// decisions = {
//   names:    { <groupId>: '<primary name>' },          the name the party gets
//   merges:   [[<groupId>, <groupId>], …],              merge two groups the import kept apart
//   dates:    { <cellRef>: 'YYYY-MM-DD' },               a date cell's value (rows below inherit it)
//   partners: { <rowRef>: { class, account?, category_id? } },
//   expenses: { <rowRef>: { category_id?, cost_client?: <groupId>|'' } },
//   skip:     { <rowRef>: true },                        leave a row out (e.g. a duplicate)
// }
import { foldName, todayISO } from '../util.js';
import { resolveColumn, medianDate, readDateCell, dateInText, FLAG_KINDS } from './dates.js';
import { bareName, toMillimes } from './parse.js';
import { SECTION_NAMES } from '../ledger.js';

export const MACHINE_OF = { press: 'press', laser: 'laser', punch: 'punch', louver: 'punch', shear: 'shear', material: null };
export const PARTNER_CLASSES = {
  deposit: 'إيداع من الشريك', expense: 'مصروف دفعه الشريك', withdrawal: 'سحب نقدي للشريك', cheque: 'شيك من الشركة للشريك', skip: 'متستوردش',
};
const CREDIT_CLASSES = ['deposit', 'expense', 'skip'];
const DEBIT_CLASSES = ['withdrawal', 'cheque', 'skip'];

// ---------- names ----------
const key = (s) => foldName(s);
const bareKey = (s) => foldName(bareName(s));
const lev = (a, b) => {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
};
export function similarNames(a, b) {
  const f = bareKey(a);
  const g = bareKey(b);
  if (!f || !g || f === g) return f === g && !!f;
  if (Math.min(f.length, g.length) >= 3 && (f.includes(g) || g.includes(f))) return true;
  return Math.min(f.length, g.length) >= 4 && lev(f, g) <= 1;
}

// A tiny union-find over spellings. Each spelling remembers where it was seen.
class Groups {
  constructor() { this.parent = new Map(); this.names = new Map(); this.reasons = new Map(); this.byBare = new Map(); }
  add(name, source) {
    const n = String(name ?? '').replace(/\s+/g, ' ').trim();
    if (!n || !/\p{L}/u.test(n)) return null;
    const k = key(n);
    if (!this.parent.has(k)) {
      this.parent.set(k, k);
      this.names.set(k, { name: n, sources: [] });
      // the same name once «م/» or «عميل» is taken off is the same party
      const b = bareKey(n);
      if (b && this.byBare.has(b)) this.union(k, this.byBare.get(b), 'نفس الاسم من غير اللقب');
      else if (b) this.byBare.set(b, k);
    }
    const e = this.names.get(k);
    if (source && !e.sources.includes(source)) e.sources.push(source);
    return k;
  }
  find(k) { let r = k; while (this.parent.get(r) !== r) r = this.parent.get(r); return r; }
  union(a, b, reason) {
    if (!a || !b || !this.parent.has(a) || !this.parent.has(b)) return;
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    this.parent.set(rb, ra);
    const list = [...(this.reasons.get(ra) || []), ...(this.reasons.get(rb) || []), reason].filter(Boolean);
    this.reasons.set(ra, [...new Set(list)]);
  }
  groups() {
    const m = new Map();
    for (const k of this.parent.keys()) {
      const r = this.find(k);
      if (!m.has(r)) m.set(r, []);
      m.get(r).push(this.names.get(k));
    }
    return [...m.entries()].map(([root, members]) => ({ root, members, reasons: this.reasons.get(root) || [] }));
  }
}

// ---------- categories and cost centres ----------
// Extra words the workbook uses, by the seeded category's name (folded). Checked in this order.
const EXTRA_WORDS = [
  ['نقل', ['تروسيكل', 'نقل', 'نولون', 'عربيه', 'شحن']],
  ['مرتبات واجور', ['مرتب', 'اجور', 'يوميه']],
  ['ايجار', ['ايجار']],
  ['كهرباء ومياه', ['كهرب', 'مياه']],
  ['تامينات', ['تامين']],
  ['ضيافه', ['فطار', 'فطور', 'قهوه', 'شاي', 'اكل', 'غدا', 'ضيافه']],
  ['صيانه وقطع غيار', ['عدسات', 'صيانه', 'تصليح', 'قطع غيار']],
  ['خامات ومستلزمات', ['مسامير', 'مسمار', 'جوان', 'خلايا', 'خليه', 'استرتش', 'مستلزمات', 'خامات']],
  ['اعمال خارجيه (دهان ولحام)', ['دهان', 'لحام']],
  ['مصاريف اداريه', ['اداريه', 'ادوات مكتبيه']],
];
const plainFold = (s) => foldName(s).replace(/[()]/g, '');

export function categoryFor(text, categories) {
  const t = ` ${plainFold(text)} `;
  const active = categories.filter((c) => c.active !== 0);
  for (const [catName, words] of EXTRA_WORDS) {
    const cat = active.find((c) => plainFold(c.name) === plainFold(catName));
    if (!cat) continue;
    const kw = [...words, ...(Array.isArray(cat.keywords) ? cat.keywords : []).map(plainFold)];
    if (kw.some((w) => w && t.includes(w))) return cat;
  }
  for (const c of active) {
    const kw = (Array.isArray(c.keywords) ? c.keywords : []).map(plainFold).filter(Boolean);
    if (kw.some((w) => t.includes(w))) return c;
  }
  return active.find((c) => /متنوع/.test(c.name)) || active[active.length - 1] || null;
}

// The client a sentence mentions («لحام علب النور», «استرتش لمصنع الأمل»): a whole-word match of one
// of his spellings, optionally after و / ب / ل. The longest spelling wins.
export function mentionedClient(text, clients) {
  const words = ` ${foldName(text)} `;
  let best = null;
  for (const c of clients) {
    for (const n of c.spellings) {
      const f = foldName(n);
      if (!f || f.length < 2) continue;
      const esc = f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`\\s[وبل]?${esc}\\s`, 'u').test(words) && (!best || f.length > best.len)) best = { id: c.id, len: f.length };
    }
  }
  return best?.id ?? null;
}

// ---------- the plan ----------
// model: readWorkbook() output. lookups: { categories: [{id,name,keywords[],active}] }.
export function buildPlan(model, decisions = {}, { lookups = { categories: [] }, today = todayISO(), fileName = '', hash = '' } = {}) {
  const dec = { names: {}, merges: [], dates: {}, partners: {}, expenses: {}, skip: {}, ...decisions };
  const preview = { names: [], suggestions: [], partners: [], dates: [], duplicates: [], formula: [], skipped: [], log: [], expenses: [], info: [] };

  // --- clients ---
  const G = new Groups();
  const workByName = new Map();
  for (const w of model.work) {
    const k = G.add(w.name, 'شيت الشغل');
    workByName.set(key(w.name), k);
    if (w.title && key(w.title) !== key(w.name)) G.union(k, G.add(w.title, 'عنوان شيت الشغل'), 'عنوان الشيت');
  }
  const stmtClient = new Map();
  for (const st of model.statements) {
    const k = G.add(st.client, 'الكشف');
    stmtClient.set(st.name, k);
    if (st.link) {
      const target = workByName.get(key(st.link)) || G.add(st.link, 'رابط الكشف');
      G.union(k, target, st.linkFromFormula ? `الكشف مربوط بالشيت (C2)` : 'اسم الشيت مكتوب في الكشف');
    }
  }
  const summaryClient = new Map();
  for (const r of model.summary?.rows || []) {
    const k = G.add(r.name, 'ملخص العملاء');
    summaryClient.set(r.row, k);
    const st = r.statement && model.statements.find((s) => key(s.name) === key(r.statement));
    if (st) G.union(stmtClient.get(st.name), k, 'صف الملخص مربوط بالكشف');
  }
  // log names: only joined when they are the same name (with or without a title)
  const logRows = model.log?.rows || [];
  for (const r of logRows) if (r.client_text) G.add(r.client_text, 'سجل العملاء');
  const merges = (prefix) => (dec.merges || []).filter((m) => Array.isArray(m) && m.every((x) => String(x).startsWith(prefix))).map((m) => m.map((x) => String(x).slice(prefix.length)));
  for (const [a, b] of merges('c:')) G.union(a, b, 'دمج الأدمن');

  const groups = G.groups();
  const cid = (root) => (root ? `c:${root}` : null);
  const groupOf = (name) => { const k = key(name); return G.parent.has(k) ? cid(G.find(k)) : null; };
  const clients = groups.map((g) => {
    const summaryName = (model.summary?.rows || []).map((r) => r.name).find((n) => G.find(key(n)) === g.root);
    const stmtName = model.statements.map((s) => s.client).find((n) => G.find(key(n)) === g.root);
    const workName = model.work.map((w) => w.name).find((n) => G.find(key(n)) === g.root);
    const dflt = summaryName || stmtName || workName || g.members[0].name;
    const spellings = [...new Set(g.members.map((m) => m.name))];
    const chosen = dec.names[cid(g.root)] && spellings.includes(dec.names[cid(g.root)]) ? dec.names[cid(g.root)] : dflt;
    return {
      id: cid(g.root), name: chosen, default_name: dflt, aliases: spellings.filter((n) => n !== chosen), spellings,
      walk_in: spellings.some((n) => /خارجي/.test(foldName(n))) ? 1 : 0,
      sources: g.members.map((m) => ({ name: m.name, sources: m.sources })), reasons: g.reasons,
      onlyLog: g.members.every((m) => m.sources.every((s) => s === 'سجل العملاء')),
    };
  });
  const clientById = new Map(clients.map((c) => [c.id, c]));
  for (const c of clients) {
    if (c.spellings.length > 1) preview.names.push({ group: c.id, kind: 'client', name: c.name, default_name: c.default_name, spellings: c.spellings, reasons: c.reasons, sources: c.sources });
  }
  // similar groups the import kept apart: the admin may merge them
  for (let i = 0; i < clients.length; i++) {
    for (let j = i + 1; j < clients.length; j++) {
      if (clients[i].spellings.some((a) => clients[j].spellings.some((b) => similarNames(a, b)))) {
        preview.suggestions.push({ kind: 'client', a: clients[i].id, a_name: clients[i].name, b: clients[j].id, b_name: clients[j].name });
      }
    }
  }

  // --- dates ---
  const allDateValues = [];
  const collect = (v) => { if (v !== null && v !== undefined) allDateValues.push(v); };
  model.work.forEach((w) => w.items.forEach((i) => collect(i.dateValue)));
  logRows.forEach((r) => collect(r.dateValue));
  model.statements.forEach((s) => s.rows.forEach((r) => collect(r.dateValue)));
  (model.expenses?.rows || []).forEach((r) => collect(r.dateValue));
  (model.materials?.rows || []).forEach((r) => collect(r.dateValue));
  const firm = allDateValues.map(readDateCell).filter((d) => d && d.candidates.length === 1 && !(d.stored && d.swapped)).map((d) => d.candidates[0]).filter((d) => d <= today).sort();
  const fallback = firm.length ? firm[firm.length - 1] : today;
  const dates = new Map();
  const resolve = (cells, median) => {
    const res = resolveColumn(cells, { today, fallback, overrides: dec.dates, median });
    for (const [ref, r] of res) dates.set(ref, r);
    // how many rows below a flagged first date follow it
    let lastFlag = null;
    for (const c of cells) {
      const r = res.get(c.ref);
      if (FLAG_KINDS.has(r.kind)) { lastFlag = { ref: c.ref, ...r, sheet: c.sheet, followers: 0 }; preview.dates.push(lastFlag); } else if (r.kind === 'inherited' && lastFlag) lastFlag.followers++;
      else lastFlag = null;
    }
  };
  for (const w of model.work) {
    const median = medianDate(w.items.map((i) => i.dateValue).filter((v) => v !== null));
    const bySec = new Map();
    for (const it of w.items) { if (!bySec.has(it.section)) bySec.set(it.section, []); bySec.get(it.section).push(it); }
    for (const list of bySec.values()) resolve(list.map((i) => ({ ref: i.dateRef, value: i.dateValue, sheet: w.name })), median);
  }
  {
    const median = medianDate(logRows.map((r) => r.dateValue).filter((v) => v !== null));
    const bySec = new Map();
    for (const r of logRows) { if (!bySec.has(r.section)) bySec.set(r.section, []); bySec.get(r.section).push(r); }
    for (const list of bySec.values()) resolve(list.map((r) => ({ ref: r.dateRef, value: r.dateValue, sheet: r.sheet })), median);
  }
  for (const st of model.statements) {
    const seen = new Set();
    const cells = st.rows.filter((r) => !seen.has(r.dateRef) && seen.add(r.dateRef)).map((r) => ({ ref: r.dateRef, value: r.dateValue, sheet: st.name }));
    resolve(cells, medianDate(cells.map((c) => c.value).filter(Boolean)));
  }
  for (const sh of [model.expenses, model.materials]) {
    if (!sh) continue;
    const cells = sh.rows.map((r) => ({ ref: r.dateRef, value: r.dateValue, sheet: sh.name }));
    resolve(cells, medianDate(cells.map((c) => c.value).filter(Boolean)));
  }
  // partners: a date written in the description wins over the date column
  for (const ps of model.partnerSheets) {
    const seen = new Set();
    const cells = [];
    for (const r of ps.rows) {
      if (seen.has(r.dateRef)) continue;
      seen.add(r.dateRef);
      const inText = dateInText(r.desc);
      cells.push({ ref: r.dateRef, value: inText || r.dateValue, sheet: ps.name, column: r.dateValue, inText });
    }
    resolve(cells, null);
    for (const c of cells) {
      if (!c.inText || c.column === null || c.column === undefined || dec.dates[c.ref]) continue;
      const col = readDateCell(c.column);
      if (col && !col.candidates.includes(c.inText)) {
        preview.dates.push({ ref: c.ref, sheet: c.sheet, kind: 'conflict', date: c.inText, text: `${col.text} (في عمود التاريخ) — ${c.inText} (في الوصف)`, options: [c.inText, ...col.candidates], followers: 0 });
      }
    }
  }
  const dateOf = (ref) => dates.get(ref)?.date || fallback;

  // --- work items, log lines, client rates ---
  const allKeys = new Set(model.work.flatMap((w) => w.keys));
  const work = [];
  const clientRates = [];
  for (const w of model.work) {
    const client = groupOf(w.name);
    for (const it of w.items) {
      if (dec.skip[it.ref]) continue;
      const amount = it.excel_amount > 0 ? it.excel_amount : null;
      const row = { ...it, client, date: dateOf(it.dateRef), machine: MACHINE_OF[it.section], status: amount ? 'posted' : 'settled', amount };
      // billed as the Excel billed it; when our formula gives another amount, the Excel amount
      // is kept as a lump (مبلغ مقطوع) and the difference is reported
      if (amount && (it.rate === null || it.formula_amount !== amount)) {
        row.billing = 'lump';
        row.lump = true;
        preview.formula.push({ ref: it.ref, sheet: w.name, section: it.section, section_name: SECTION_NAMES[it.section], excel_amount: amount,
          formula_amount: it.formula_amount, rate: it.rate, reason: it.rate === null ? 'سعر الوحدة مش موجود أو فيه كسور' : 'المبلغ مكتوب بإيد أو مختلف عن المعادلة' });
      }
      if (it.notes.length && !row.lump) preview.formula.push({ ref: it.ref, sheet: w.name, section: it.section, section_name: SECTION_NAMES[it.section], excel_amount: amount, formula_amount: it.formula_amount, rate: it.rate, reason: it.notes.join('، '), info: true });
      work.push(row);
    }
    const r = w.rates;
    const add = (section, band, pounds) => {
      if (pounds === null || pounds === undefined || pounds <= 0) return;
      const m = toMillimes(pounds);
      if (Math.abs(pounds * 1000 - m) > 1e-6) return;
      clientRates.push({ client, section, band, rate: m, ref: w.e1Ref });
    };
    add('press', '<3', r.press_thin); add('press', '>=3', r.press_thick); add('laser', '', r.laser); add('punch', '', r.punch);
    add('louver', '', r.louver); add('shear', '', r.shear);
  }
  const logLines = [];
  for (const r of logRows) {
    if (r.key && allKeys.has(r.key)) continue; // already in the client's sheet
    if (dec.skip[r.ref]) continue;
    const client = r.client_text ? groupOf(r.client_text) : null;
    if (!client) {
      preview.skipped.push({ ref: r.ref, sheet: r.sheet, row: r.row, reason: 'سطر في سجل العملاء من غير اسم عميل', text: r.client_text || '' });
      continue;
    }
    const line = { ...r, client, date: dateOf(r.dateRef), machine: MACHINE_OF[r.section] };
    logLines.push(line);
    preview.log.push({ ref: r.ref, section: r.section, section_name: SECTION_NAMES[r.section], client: client, client_name: clientById.get(client)?.name, date: line.date, has_key: !!r.key });
  }

  // --- statements ---
  const manual = [];
  const receipts = [];
  for (const st of model.statements) {
    const client = stmtClient.get(st.name) ? cid(G.find(stmtClient.get(st.name))) : null;
    preview.skipped.push(...st.skipped);
    for (const r of st.rows) {
      if (dec.skip[r.ref]) continue;
      const date = dateOf(r.dateRef);
      let kind = r.kind;
      if (r.negative) kind = kind === 'debit' ? 'discount' : 'debit';
      if (kind === 'debit' || kind === 'discount') manual.push({ ref: r.ref, client, date, kind, amount: r.amount, desc: r.desc, negative: r.negative });
      else receipts.push({ ref: r.ref, client, date, amount: r.amount, desc: r.desc, cheque: r.cheque });
    }
  }

  // --- suppliers ---
  const S = new Groups();
  for (const m of model.materials?.rows || []) S.add(m.supplier, 'الخامات');
  for (const [a, b] of merges('s:')) S.union(a, b, 'دمج الأدمن');
  const sid = (root) => (root ? `s:${root}` : null);

  // --- partners and cheques ---
  const partners = (model.partners?.rows || []).map((p) => ({ id: `p:${key(p.name)}`, name: p.name, sheet: p.sheet, spellings: [...new Set([p.name, p.sheet])] }));
  const partnerOfSheet = (name) => partners.find((p) => key(p.sheet) === key(name) || key(p.name) === key(name));
  const partnerByPayee = (payee) => partners.find((p) => p.spellings.some((n) => key(n) === key(payee) || bareKey(n) === bareKey(payee)));
  const chequeRows = (model.cheques?.rows || []).filter((c) => !dec.skip[c.ref]).map((c) => ({ ...c, used: false }));
  const partnerOps = [];
  for (const ps of model.partnerSheets) {
    const partner = partnerOfSheet(ps.name);
    if (!partner) continue;
    preview.skipped.push(...ps.skipped);
    for (const r of ps.rows) {
      const d = dec.partners[r.ref] || {};
      let cls;
      let category = null;
      let account = 'bank';
      let flag = null;
      let cheque = null;
      if (r.side === 'credit') {
        if (/تغذي|ايداع|إيداع/.test(r.desc)) cls = 'deposit';
        else if ((category = categoryFor(r.desc, lookups.categories)) && r.desc && /كهرب|ايجار|إيجار|مرتب|تامين|تأمين|بند غير محدد|مدفوع|مصروف|فاتور/.test(r.desc)) cls = 'expense';
        else { cls = 'deposit'; flag = 'مش واضح نوعه — اتعامل كإيداع'; }
        if (!category) category = categoryFor(r.desc, lookups.categories);
      } else {
        const match = chequeRows.find((c) => !c.used && c.amount === r.amount && partnerByPayee(c.payee) === partner);
        if (match) { cls = 'cheque'; cheque = match; match.used = true; } else { cls = 'withdrawal'; account = 'cash'; if (/شيك/.test(r.desc)) flag = 'مكتوب شيك بس مش موجود في شيت الشيكات — اتعامل كسحب نقدي'; }
      }
      const allowed = r.side === 'credit' ? CREDIT_CLASSES : DEBIT_CLASSES;
      if (d.class && allowed.includes(d.class)) {
        if (d.class !== 'cheque' && cheque) { cheque.used = false; cheque = null; }
        if (d.class === 'cheque' && !cheque) {
          const match = chequeRows.find((c) => !c.used && c.amount === r.amount);
          if (match) { cheque = match; match.used = true; }
        }
        cls = d.class;
      }
      if (d.account && ['cash', 'bank'].includes(d.account)) account = d.account;
      else if (cls === 'withdrawal' && !d.account) account = 'cash';
      if (d.category_id) category = lookups.categories.find((c) => c.id === Number(d.category_id)) || category;
      const date = dateOf(r.dateRef);
      const op = { ref: r.ref, partner: partner.id, partner_name: partner.name, side: r.side, class: cls, account, category, amount: r.amount, desc: r.desc, date, cheque, flag };
      partnerOps.push(op);
      preview.partners.push({ ref: r.ref, partner: partner.name, side: r.side, side_name: r.side === 'credit' ? 'دائن (دفعه للشركة)' : 'مدين (أخده من الشركة)',
        desc: r.desc, date, amount: r.amount, class: cls, class_name: PARTNER_CLASSES[cls], account, category_id: category?.id ?? null, category_name: category?.name || '',
        cheque_ref: cheque?.ref || null, options: r.side === 'credit' ? CREDIT_CLASSES : DEBIT_CLASSES, flag });
    }
  }
  // cheques of the company that are not a partner's: to a supplier, or an expense
  const otherCheques = [];
  {
    const cells = chequeRows.filter((c) => !c.used).map((c) => ({ ref: c.dateRef, value: c.dateValue, sheet: c.sheet }));
    resolve(cells, null);
  }
  for (const c of chequeRows) {
    if (c.used) continue;
    const sup = S.parent.has(key(c.payee)) ? sid(S.find(key(c.payee))) : null;
    const category = categoryFor(`${c.desc} ${c.payee}`, lookups.categories);
    otherCheques.push({ ...c, date: dateOf(c.dateRef), supplier: sup, category });
    preview.info.push({ ref: c.ref, text: `شيك لـ«${c.payee}» مش لشريك — هيتسجل ${sup ? 'دفعة للمورد' : `مصروف (${category?.name || ''})`}` });
  }

  // --- daily expenses ---
  const clientList = clients.map((c) => ({ id: c.id, spellings: [...c.spellings, ...c.spellings.map(bareName)] }));
  const expenses = [];
  if (model.expenses) {
    preview.skipped.push(...model.expenses.skipped);
    for (const r of model.expenses.rows) {
      const d = dec.expenses[r.ref] || {};
      let category = categoryFor(`${r.desc} ${r.notes}`, lookups.categories);
      if (d.category_id) category = lookups.categories.find((c) => c.id === Number(d.category_id)) || category;
      let cost = mentionedClient(`${r.desc} ${r.notes}`, clientList);
      const suggested = cost;
      if (d.cost_client !== undefined) cost = d.cost_client && clientById.has(d.cost_client) ? d.cost_client : null;
      const e = { ref: r.ref, date: dateOf(r.dateRef), desc: r.desc, notes: r.notes, amount: r.amount, category, cost_client: cost, negative: r.negative };
      expenses.push(e);
      preview.expenses.push({ ref: r.ref, date: e.date, desc: r.desc, amount: r.amount, category_id: category?.id ?? null, category_name: category?.name || '',
        cost_client: cost, cost_client_name: cost ? clientById.get(cost)?.name : '', suggested_client: suggested });
    }
  }

  // --- material purchases ---
  const purchases = [];
  if (model.materials) {
    preview.skipped.push(...model.materials.skipped);
    for (const r of model.materials.rows) {
      const supplier = S.parent.has(key(r.supplier)) ? sid(S.find(key(r.supplier))) : null;
      purchases.push({ ...r, supplier_text: r.supplier, date: dateOf(r.dateRef), supplier });
    }
  }
  const suppliers = S.groups().map((g) => {
    const spellings = [...new Set(g.members.map((m) => m.name))];
    const chosen = dec.names[sid(g.root)] && spellings.includes(dec.names[sid(g.root)]) ? dec.names[sid(g.root)] : spellings[0];
    return { id: sid(g.root), name: chosen, aliases: spellings.filter((n) => n !== chosen), spellings };
  });
  for (let i = 0; i < suppliers.length; i++) {
    for (let j = i + 1; j < suppliers.length; j++) {
      if (suppliers[i].spellings.some((a) => suppliers[j].spellings.some((b) => similarNames(a, b)))) {
        preview.suggestions.push({ kind: 'supplier', a: suppliers[i].id, a_name: suppliers[i].name, b: suppliers[j].id, b_name: suppliers[j].name });
      }
    }
  }
  for (const s of suppliers) if (s.spellings.length > 1) preview.names.push({ group: s.id, kind: 'supplier', name: s.name, default_name: s.spellings[0], spellings: s.spellings, reasons: [] });

  // --- duplicates (same date, same text, same amount): flagged, kept unless skipped ---
  const dupScan = (list, sheetOf, text) => {
    const seen = new Map();
    for (const r of list) {
      const k = `${r.date}|${foldName(text(r))}|${r.amount}|${r.kind || ''}|${r.client || ''}`;
      if (seen.has(k)) preview.duplicates.push({ ref: r.ref, of: seen.get(k), sheet: sheetOf(r), date: r.date, text: text(r), amount: r.amount });
      else seen.set(k, r.ref);
    }
  };
  dupScan(expenses, () => model.expenses?.name, (r) => r.desc);
  dupScan([...manual, ...receipts], (r) => r.ref.split('!')[0], (r) => r.desc);
  dupScan(purchases, () => model.materials?.name, (r) => `${r.supplier_text || r.supplier} ${r.material_text}`);
  // a row the admin skipped leaves the import
  const keep = (r) => !dec.skip[r.ref];

  // --- the Excel figures to reconcile with ---
  const targets = {
    clients: (model.summary?.rows || []).map((r) => ({ name: r.name, client: summaryClient.get(r.row) ? cid(G.find(summaryClient.get(r.row))) : null,
      debit: r.debit ?? 0, discount: r.discount ?? 0, credit: r.credit ?? 0, balance: r.balance ?? ((r.debit ?? 0) - (r.discount ?? 0) - (r.credit ?? 0)) })),
    clients_total: model.summary?.total || null,
    work: model.work.map((w) => ({ sheet: w.name, client: groupOf(w.name), e1: w.e1 ?? 0, ref: w.e1Ref })),
    partners: (model.partners?.rows || []).map((p) => ({ name: p.name, partner: `p:${key(p.name)}`, credit: p.credit ?? 0, debit: p.debit ?? 0, net: p.net ?? ((p.credit ?? 0) - (p.debit ?? 0)) })),
    partners_total: model.partners?.total || null,
    expenses: model.expenses ? model.expenses.total ?? 0 : null,
    cheques: model.cheques ? model.cheques.total ?? 0 : null,
    materials_cash: model.materials ? model.materials.cash ?? 0 : null,
    materials_cheque: model.materials ? model.materials.cheque ?? 0 : null,
    store: model.store?.balance ?? null,
  };

  const densities = [];
  for (const w of [...model.templates, ...model.work]) {
    for (const d of w.densities) if (!densities.some((x) => key(x.name) === key(d.name))) densities.push(d);
  }

  const counts = {
    clients: clients.length, suppliers: suppliers.length, partners: partners.length,
    work_posted: work.filter((w) => w.status === 'posted').length, work_settled: work.filter((w) => w.status === 'settled').length,
    log_lines: logLines.length, manual: manual.length, receipts: receipts.length, partner_rows: partnerOps.filter((p) => p.class !== 'skip').length,
    cheques: chequeRows.length, expenses: expenses.filter(keep).length, purchases: purchases.filter(keep).length,
    dates_flagged: preview.dates.length, duplicates: preview.duplicates.length, skipped: preview.skipped.length,
  };
  return {
    file: { name: fileName, hash }, today, fallback,
    clients, suppliers, partners, densities, clientRates,
    work, logLines, manual: manual.filter(keep), receipts: receipts.filter(keep), partnerOps: partnerOps.filter((p) => p.class !== 'skip'),
    otherCheques, expenses: expenses.filter(keep), purchases: purchases.filter(keep),
    targets, preview, counts,
  };
}
