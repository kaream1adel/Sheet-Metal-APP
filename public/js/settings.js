// الإعدادات: المستخدمين، الفنيين، الخامات والكثافات، بنود المصروفات، القراءة الآلية، النسخ الاحتياطي،
// التحديث، المشاركة، إقفال الشهر، الاستيراد من الإكسيل (module import).
import { h, fill, icon, button, pageHead, emptyState, skeleton, formModal, confirmModal, toast, toastError, tabs, pill,
  dataTable, field, notice, fmtDate, fmtDateTime, todayISO, num } from './ui.js';
import { get, post, put, patch, del } from './api.js';
import { createGrid } from './grid.js';
import { importSettingsTab } from './modules/import.js';

const TABS = [
  { key: 'users', label: 'المستخدمين', icon: 'user-gear', perm: 'users' },
  { key: 'technicians', label: 'الفنيين', icon: 'hard-hat', perm: 'settings' },
  { key: 'materials', label: 'الخامات والكثافات', icon: 'cube', perm: 'settings' },
  { key: 'categories', label: 'بنود المصروفات', icon: 'list-bullets', perm: 'settings' },
  { key: 'ai', label: 'القراءة الآلية', icon: 'sparkle', perm: 'settings' },
  { key: 'backup', label: 'النسخ الاحتياطي', icon: 'cloud-arrow-up', perm: 'settings' },
  { key: 'update', label: 'التحديث', icon: 'arrows-clockwise', perm: 'settings' },
  { key: 'share', label: 'المشاركة', icon: 'qr-code', perm: 'settings' },
  { key: 'locks', label: 'إقفال الشهر', icon: 'lock-key', perm: 'settings' },
  { key: 'import', label: 'الاستيراد من الإكسيل', icon: 'file-xls', perm: 'import' },
];
const MACHINES = [['', '—'], ['press', 'التناية'], ['shear', 'المقص'], ['laser', 'الليزر'], ['punch', 'البنش']];
const MACHINE_NAME = Object.fromEntries(MACHINES);

export async function settingsPage(main, tab, ctx) {
  const visible = TABS.filter((t) => ctx.can(t.perm));
  const current = visible.find((t) => t.key === tab)?.key || visible[0]?.key;
  const box = h('div', {}, skeleton());
  fill(main, pageHead('الإعدادات', 'المستخدمين والقوائم والنسخ الاحتياطي والتحديث.'),
    tabs(visible.map((t) => ({ ...t, href: `#/settings/${t.key}` })), current), box);
  const screens = { users, technicians, materials, categories, ai, backup, update, share, locks, import: importSettingsTab };
  await screens[current](box, ctx);
}

// ---------- المستخدمين ----------
async function users(box) {
  const d = await get('/api/users');
  const roleOptions = Object.entries(d.roles);
  // The role's permissions are ticked and fixed; anything more is an extra permission.
  const permChecks = (role, extra = []) => {
    const base = new Set(d.role_permissions[role] || []);
    return h('div', { class: 'perm-list' }, Object.entries(d.permissions).map(([p, label]) => h('label', { class: 'check-row' },
      h('input', { type: 'checkbox', value: p, checked: base.has(p) || extra.includes(p), disabled: base.has(p) }), label)));
  };
  const edit = async (u) => {
    let role = u?.role || 'staff';
    const extraNow = u ? u.permissions.filter((x) => !(d.role_permissions[u.role] || []).includes(x)) : [];
    const holder = h('div', { class: 'field' }, h('label', {}, 'الصلاحيات (اللي متعلّم عليها رمادي جاية من الدور)'), permChecks(role, extraNow));
    const r = await formModal({
      title: u ? `تعديل ${u.display_name}` : 'مستخدم جديد', wide: true,
      fields: [
        { name: 'display_name', label: 'الاسم', value: u?.display_name || '' },
        ...(u ? [] : [{ name: 'username', label: 'اسم المستخدم' }]),
        { name: 'role', label: 'الدور', type: 'select', options: roleOptions, value: role },
        { name: 'password', label: u ? 'كلمة سر جديدة (سيبها فاضية لو مش هتغيرها)' : 'كلمة السر (6 على الأقل)', type: 'password' },
        ...(u ? [{ name: 'active', label: 'الحساب شغال', type: 'checkbox', value: u.active }] : []),
      ],
      extra: holder,
      onChange: (v) => {
        if (v.role === role) return;
        const kept = [...holder.querySelectorAll('input:checked:not(:disabled)')].map((x) => x.value);
        role = v.role;
        holder.lastChild.replaceWith(permChecks(role, kept));
      },
      submitLabel: u ? 'حفظ' : 'ضيف المستخدم',
      onSubmit: async (v) => {
        const extra_permissions = [...holder.querySelectorAll('input:checked:not(:disabled)')].map((x) => x.value);
        const body = { ...v, extra_permissions };
        if (u && !body.password) delete body.password;
        return u ? patch(`/api/users/${u.id}`, body) : post('/api/users', body);
      },
    });
    if (r) { toast('اتحفظ'); users(box); }
  };
  fill(box,
    h('div', { class: 'row', style: 'margin-bottom:12px' }, button('مستخدم جديد', { kind: 'primary', icon: 'user-plus', onClick: () => edit(null) })),
    dataTable([
      { label: 'الاسم', value: (u) => h('b', {}, u.display_name) },
      { label: 'اسم المستخدم', value: (u) => h('span', { class: 'num' }, u.username) },
      { label: 'الدور', value: (u) => d.roles[u.role] },
      { label: 'بيشوف الفلوس', value: (u) => (u.permissions.includes('money.view') ? pill('accent', 'أيوه') : pill('neutral', 'لأ')) },
      { label: 'الحالة', value: (u) => (u.active ? pill('ok', 'شغال') : pill('neutral', 'موقوف')) },
    ], d.users, { onRow: edit }));
}

// ---------- الفنيين ----------
async function technicians(box, ctx) {
  const { technicians: list } = await get('/api/technicians');
  const edit = async (t) => {
    const r = await formModal({
      title: t ? `تعديل ${t.name}` : 'فني جديد',
      fields: [
        { name: 'name', label: 'الاسم', value: t?.name || '' },
        { name: 'machine', label: 'المكنة اللي بيشتغل عليها عادة', type: 'select', options: MACHINES, value: t?.machine || '' },
        ...(t ? [{ name: 'active', label: 'شغال', type: 'checkbox', value: t.active }] : []),
      ],
      onSubmit: (v) => (t ? patch(`/api/technicians/${t.id}`, v) : post('/api/technicians', v)),
    });
    if (r) { toast('اتحفظ'); await ctx.loadLookups(); technicians(box, ctx); }
  };
  fill(box,
    h('div', { class: 'row', style: 'margin-bottom:12px' }, button('فني جديد', { kind: 'primary', icon: 'plus', onClick: () => edit(null) })),
    dataTable([
      { label: 'الاسم', value: (t) => h('b', {}, t.name) },
      { label: 'المكنة', value: (t) => MACHINE_NAME[t.machine || ''] },
      { label: 'الحالة', value: (t) => (t.active ? pill('ok', 'شغال') : pill('neutral', 'موقوف')) },
    ], list, { onRow: edit, empty: emptyState('hard-hat', 'لسه مفيش فنيين', 'ضيف الفنيين عشان تختارهم في ورقة التشغيل.', button('فني جديد', { kind: 'primary', onClick: () => edit(null) }), true) }));
}

// ---------- الخامات والكثافات (an editable grid: each cell saves on its own) ----------
async function materials(box, ctx) {
  const { materials: list } = await get('/api/materials');
  const groups = ['أسود', 'مجلفن', 'ستانلس', 'ألومنيوم'];
  const status = h('span', { class: 'small muted' });
  const save = async (row) => {
    if (!row.name) return;
    const body = { name: row.name, aliases: row.aliases_text || '', density: row.density ?? '', grp: row.grp || '', active: row.active !== false };
    try {
      if (row.id) await patch(`/api/materials/${row.id}`, body);
      else row.id = (await post('/api/materials', body)).material.id;
      status.textContent = 'اتحفظ';
      ctx.loadLookups().catch(() => {});
    } catch (ex) { toastError(ex); }
  };
  const grid = createGrid({
    rows: list.map((m) => ({ ...m, aliases_text: m.aliases.join('، ') })),
    newRow: () => ({ active: true }),
    canDelete: false, totals: false, keysHint: false,
    columns: [
      { key: 'name', label: 'الخامة', type: 'text', width: 140, ditto: false },
      { key: 'density', label: 'الكثافة (جم/سم³)', type: 'number', width: 90, ditto: false },
      { key: 'grp', label: 'المجموعة', type: 'text', width: 110, suggest: groups },
      { key: 'aliases_text', label: 'بتتكتب كمان', type: 'text', width: 220, ditto: false },
      { key: 'active', label: 'شغالة', type: 'check' },
    ],
    marks: (row, key) => (key === 'density' && row.name && !row.density ? { level: 'yellow', message: 'من غير كثافة مش هنعرف نحسب وزن الخامة' } : null),
    onChange: (row) => save(row),
    rowTitle: (row) => row.name || 'خامة جديدة',
  });
  fill(box,
    notice('info', 'الكثافات دي عامة لحد ما يتعمل الاستيراد من الإكسيل. الوزن = السمك/10 × الطول × العرض × العدد × الكثافة ÷ 1000.'),
    h('div', { style: 'margin-top:12px' }, grid.el),
    h('div', { class: 'row', style: 'margin-top:6px' }, status));
}

// ---------- بنود المصروفات ----------
async function categories(box) {
  const { expense_categories: list } = await get('/api/expense-categories');
  const edit = async (c) => {
    const r = await formModal({
      title: c ? `تعديل ${c.name}` : 'بند جديد',
      fields: [
        { name: 'name', label: 'اسم البند', value: c?.name || '' },
        { name: 'keywords', label: 'كلمات بتدل عليه (افصل بفاصلة)', value: (c?.keywords || []).join('، '), help: 'بتساعد الاستيراد والبحث يعرفوا البند من الوصف.', wide: true },
        ...(c ? [{ name: 'active', label: 'شغال', type: 'checkbox', value: c.active }] : []),
      ],
      onSubmit: (v) => (c ? patch(`/api/expense-categories/${c.id}`, v) : post('/api/expense-categories', v)),
    });
    if (r) { toast('اتحفظ'); categories(box); }
  };
  fill(box,
    h('div', { class: 'row', style: 'margin-bottom:12px' }, button('بند جديد', { kind: 'primary', icon: 'plus', onClick: () => edit(null) })),
    dataTable([
      { label: 'البند', value: (c) => h('b', {}, c.name) },
      { label: 'كلمات', value: (c) => h('span', { class: 'small muted' }, c.keywords.join('، ')) },
      { label: 'الحالة', value: (c) => (c.active ? pill('ok', 'شغال') : pill('neutral', 'موقوف')) },
    ], list, { onRow: edit }));
}

// ---------- القراءة الآلية: the key stays on the server ----------
async function ai(box, ctx) {
  const s = await get('/api/settings/ai');
  const enabled = h('input', { type: 'checkbox', checked: s.enabled });
  const key = h('input', { type: 'password', autocomplete: 'off', class: 'ltr', placeholder: s.configured ? 'محفوظ — اكتب مفتاح جديد لو عايز تغيره' : 'sk-ant-…' });
  const model = h('select', {}, s.models.map((m) => h('option', { value: m.id, selected: m.id === s.model }, m.name)));
  const keyField = field('مفتاح الخدمة (API key)', key, { help: 'من console.anthropic.com. بيتحفظ على الكمبيوتر بس ومبيتبعتش لأي موبايل أو متصفح.' });
  fill(box, h('div', { class: 'card grid', style: 'max-width:640px' },
    h('h2', {}, 'القراءة الآلية بالذكاء الاصطناعي'),
    h('div', { class: 'small' }, 'صورة ورقة الفني بتتبعت لـ Claude يقراها ويرجّع السطور، وكل سطر بيتربط بعميله من القايمة. الخانات اللي مش واضحة بتتعلم بالأصفر في المراجعة.'),
    h('div', { class: 'small muted' }, 'محتاجة نت. صورة الورقة بس اللي بتتبعت (من غير أسعار).'),
    s.configured ? notice('ok', 'المفتاح محفوظ.') : notice('warn', 'لسه مفيش مفتاح.'),
    h('label', { class: 'check-row' }, enabled, 'شغّل القراءة الآلية'),
    keyField,
    field('الموديل', model),
    h('div', { class: 'row' }, button('حفظ', { kind: 'primary', onClick: async () => {
      const body = { enabled: enabled.checked, model: model.value };
      if (key.value.trim()) body.api_key = key.value.trim();
      try { await put('/api/settings/ai', body); toast('اتحفظ'); await ctx.loadLookups(); ai(box, ctx); } catch (ex) { keyField.setError(ex.message); }
    } }),
    s.configured ? button('امسح المفتاح', { kind: 'danger', onClick: async () => {
      if (!(await confirmModal('مسح المفتاح', 'القراءة الآلية هتقف لحد ما تحط مفتاح تاني.', 'امسح', { danger: true }))) return;
      await put('/api/settings/ai', { api_key: '', enabled: false }); toast('اتمسح'); ai(box, ctx);
    } }) : null)));
}

// ---------- النسخ الاحتياطي (+ start with Windows) ----------
const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

async function backup(box) {
  const { backups, status } = await get('/api/backups');
  const auto = await get('/api/autostart').catch(() => ({ supported: false }));
  const dirInput = h('input', { value: status.copy_dir || '', class: 'ltr', placeholder: 'E:\\ أو C:\\Users\\...\\OneDrive' });
  const dirField = field('انسخ كل نسخة كمان على فلاشة أو فولدر OneDrive (اختياري)', dirInput);
  const restore = async (b) => {
    const ok = await confirmModal('استرجاع نسخة احتياطية',
      `البيانات هترجع زي ما كانت وقت ${fmtDateTime(b.at)}. أي حاجة اتسجلت بعد كده هتختفي من البرنامج (بس هتتحفظ في نسخة قبل الاسترجاع). متأكد؟`, 'استرجع', { danger: true });
    if (!ok) return;
    try { await post(`/api/backups/${encodeURIComponent(b.name)}/restore`, { confirm: true }); toast('البيانات اترجعت'); setTimeout(() => location.reload(), 800); } catch (ex) { toastError(ex); }
  };
  fill(box, h('div', { class: 'settings-grid' },
    h('div', { class: 'card grid' },
      h('h2', {}, 'النسخ الاحتياطي'),
      h('div', { class: 'small muted' }, 'بتتعمل نسخة لوحدها كل ما البرنامج يشتغل، وكل يوم، وقبل أي تحديث.'),
      h('div', {}, 'آخر نسخة: ', h('b', { class: 'num' }, fmtDateTime(status.last_at))),
      status.error ? notice('danger', `آخر نسخة فشلت: ${status.error}`) : null,
      status.copy_error ? notice('warn', `النسخة اتعملت بس متنسختش على الفولدر التاني: ${status.copy_error}`) : null,
      status.stale && !status.error ? notice('warn', 'مفيش نسخة احتياطية من أكتر من يومين.') : null,
      h('div', {}, button('اعمل نسخة دلوقتي', { kind: 'primary', icon: 'cloud-arrow-up', onClick: async () => {
        try { await post('/api/backups'); toast('اتعملت نسخة احتياطية'); backup(box); } catch (ex) { toastError(ex); }
      } })),
      dirField,
      h('div', {}, button('حفظ الفولدر', { onClick: async () => {
        try { await put('/api/backups/settings', { backup_copy_dir: dirInput.value }); toast('اتحفظ'); backup(box); } catch (ex) { dirField.setError(ex.message); }
      } })),
      auto.supported ? h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: auto.enabled, onchange: async (e) => {
        try { await put('/api/autostart', { enabled: e.target.checked }); toast('اتحفظ'); } catch (ex) { toastError(ex); e.target.checked = !e.target.checked; }
      } }), 'البرنامج يشتغل لوحده لما الكمبيوتر يفتح') : null),
    h('div', { class: 'grid' },
      h('h2', {}, 'النسخ المحفوظة'),
      dataTable([
        { label: 'الوقت', value: (b) => h('span', { class: 'num' }, fmtDateTime(b.at)) },
        { label: 'النوع', value: (b) => b.reason_name },
        { label: 'الحجم', value: (b) => h('span', { class: 'num' }, fmtSize(b.size)) },
        { label: '', value: (b) => h('div', { class: 'row end' },
          button('تحميل', { size: 'sm', icon: 'download-simple', href: `/api/backups/${encodeURIComponent(b.name)}/download` }),
          button('استرجاع', { size: 'sm', kind: 'danger', onClick: () => restore(b) })) },
      ], backups, { empty: emptyState('cloud-arrow-up', 'لسه مفيش نسخ', 'أول نسخة بتتعمل لما البرنامج يشتغل.', null, true) }))));
}

// ---------- التحديث ----------
async function update(box) {
  const render = (s) => {
    const cur = s.current.build ? `${s.current.version} (رقم ${s.current.build})` : `${s.current.version} (نسخة تطوير)`;
    const latest = s.latest;
    fill(box, h('div', { class: 'card grid', style: 'max-width:640px' },
      h('h2', {}, 'التحديث'),
      h('div', {}, 'النسخة الحالية: ', h('b', { class: 'num' }, cur)),
      !s.installed ? notice('info', 'التحديث بيشتغل بس لما البرنامج يتفتح من "Start Sheet Metal.bat".') : null,
      s.check_error ? h('div', { class: 'small muted' }, 'آخر محاولة للتشييك مقدرتش توصل للنت.') : null,
      s.available ? notice('warn', h('b', {}, `في نسخة جديدة: ${latest.version} (رقم ${latest.build})`),
        latest.notes ? h('div', { class: 'small', style: 'white-space:pre-wrap;margin-top:4px' }, latest.notes) : null)
        : s.checked_at ? h('div', { class: 'small muted' }, `إنت على آخر نسخة (آخر تشييك ${fmtDateTime(s.checked_at)})`) : null,
      h('div', { class: 'row' },
        button('شوف لو في تحديث', { disabled: !s.installed, onClick: async () => { try { render(await post('/api/update/check')); } catch (ex) { toastError(ex); } } }),
        s.available ? button('تحديث', { kind: 'primary', disabled: !s.installed || s.busy, onClick: () => apply(latest) }) : null,
        s.can_rollback ? button('رجوع للنسخة السابقة', { kind: 'danger', onClick: () => rollback(s) }) : null)));
  };
  const apply = async (latest) => {
    if (!(await confirmModal('تحديث البرنامج', `هعمل نسخة احتياطية، وأحمّل النسخة ${latest.version} (رقم ${latest.build})، وأعيد تشغيل البرنامج. البرنامج هيقف دقيقة تقريباً. نكمل؟`, 'حدّث'))) return;
    try { const r = await post('/api/update/apply'); await waitForRestart(`اتحدث لنسخة ${r.version}`); } catch (ex) { toastError(ex); }
  };
  const rollback = async (s) => {
    const text = s.rollback_loses_data
      ? 'التحديث الأخير غيّر شكل البيانات، فالرجوع هيرجّع البيانات كمان لوقت التحديث: أي شغل اتسجل بعده هيختفي من البرنامج (بس هيتحفظ في نسخة احتياطية). متأكد؟'
      : 'البرنامج هيرجع للنسخة اللي كانت قبل آخر تحديث وهيعيد التشغيل. بياناتك مش هتتغير. نكمل؟';
    if (!(await confirmModal('رجوع للنسخة السابقة', text, 'ارجع', { danger: true }))) return;
    try { await post('/api/update/rollback', { confirm: true }); await waitForRestart('رجعنا للنسخة السابقة'); } catch (ex) { toastError(ex); }
  };
  render(await get('/api/update'));
}

async function waitForRestart(doneMessage) {
  const back = h('div', { class: 'modal-back' }, h('div', { class: 'modal', style: 'text-align:center' },
    h('h2', {}, 'البرنامج بيعيد التشغيل…'), h('p', { class: 'muted' }, 'متقفلش الشباك الأسود. الصفحة هتفتح لوحدها.')));
  document.body.append(back);
  await new Promise((r) => setTimeout(r, 2500));
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch('/api/session', { cache: 'no-store' });
      if (res.ok) {
        try { sessionStorage.setItem('after-restart', doneMessage); } catch { /* blocked */ }
        location.reload();
        return;
      }
    } catch { /* still restarting */ }
    await new Promise((r) => setTimeout(r, 1500));
  }
  back.querySelector('p').textContent = 'البرنامج لسه مارجعش. بص على الشباك الأسود على الكمبيوتر.';
}

// ---------- المشاركة (phone link + QR) ----------
async function share(box) {
  const d = await get('/api/share');
  const t = d.tunnel;
  const svg = (markup) => { const q = h('div', { class: 'qr' }); q.innerHTML = markup; return q; }; // server-made QR SVG
  const copy = (url) => button('نسخ', { size: 'sm', icon: 'copy', onClick: async () => {
    try { await navigator.clipboard.writeText(url); toast('اتنسخ'); } catch { toast('انسخه بإيدك', true); }
  } });
  const STATE = { on: ['ok', 'شغال'], starting: ['warn', 'بيتصل…'], downloading: ['warn', 'بيجهز اللينك لأول مرة…'], error: ['danger', 'فيه مشكلة'], off: ['neutral', 'مقفول'], missing: ['danger', 'مقدرش يجهز اللينك'] };
  const [kind, word] = STATE[t.state] || ['neutral', t.state];
  const enabled = h('input', { type: 'checkbox', checked: d.settings.tunnel_enabled });
  const url = h('input', { value: d.settings.tunnel_url || '', placeholder: 'https://warsha.example.com', class: 'ltr' });
  const token = h('input', { type: 'password', class: 'ltr', autocomplete: 'off', placeholder: d.settings.tunnel_token_set ? 'محفوظ — اكتب جديد لو عايز تغيره' : 'Tunnel token' });
  const urlField = field('اللينك الثابت', url);
  fill(box,
    h('div', { class: 'settings-grid' },
      h('div', { class: 'card grid share' },
        h('h2', {}, 'من أي مكان (إنترنت)'),
        h('div', {}, 'الحالة: ', pill(kind, word)),
        t.url ? [svg(t.qr), h('div', { class: 'row' }, h('a', { href: t.url, target: '_blank', rel: 'noopener', class: 'num', style: 'word-break:break-all' }, t.url), copy(t.url)),
          !t.fixed ? h('div', { class: 'small muted' }, 'اللينك ده بيتغير كل ما الكمبيوتر يعيد تشغيل — ارجع هنا تاخد الجديد.') : null] : null,
        t.error && t.state !== 'on' ? h('div', { class: 'small muted num' }, t.error) : null,
        h('div', { class: 'row' }, button('اتصل من جديد', { onClick: async () => { await post('/api/share/restart'); toast('بيتصل من جديد…'); setTimeout(() => share(box), 6000); } }),
          button('تحديث', { kind: 'ghost', onClick: () => share(box) }))),
      h('div', { class: 'card grid share' },
        h('h2', {}, 'على واي فاي الورشة'),
        d.lan.length === 0 ? h('div', { class: 'muted' }, 'الكمبيوتر مش متوصل بشبكة.') : d.lan.map((l) => [svg(l.qr), h('div', { class: 'row' }, h('span', { class: 'num' }, l.url), copy(l.url))]))),
    h('div', { class: 'card grid', style: 'margin-top:14px;max-width:640px' },
      h('h2', {}, 'إعدادات اللينك'),
      h('label', { class: 'check-row' }, enabled, 'افتح البرنامج على الإنترنت'),
      h('div', { class: 'small muted' }, 'لينك ثابت مش بيتغير: محتاج حساب Cloudflare مجاني ودومين. لو مش موجود سيب الخانتين فاضيين.'),
      urlField, field('Tunnel token', token),
      h('div', { class: 'row' }, button('حفظ', { kind: 'primary', onClick: async () => {
        const body = { tunnel_enabled: enabled.checked, tunnel_url: url.value };
        if (token.value) body.tunnel_token = token.value;
        try { await put('/api/share/settings', body); toast('اتحفظ'); setTimeout(() => share(box), 4000); } catch (ex) { urlField.setError(ex.message); }
      } }), d.settings.tunnel_token_set ? button('امسح اللينك الثابت', { onClick: async () => {
        await put('/api/share/settings', { tunnel_token: '', tunnel_url: '' }); toast('رجعنا للينك المجاني'); share(box);
      } }) : null)));
}

// ---------- إقفال الشهر ----------
async function locks(box) {
  const { locks: list } = await get('/api/month-locks');
  const lastMonth = (() => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return todayISO(d).slice(0, 7); })();
  const lock = async () => {
    const r = await formModal({
      title: 'إقفال شهر', intro: 'بعد الإقفال مفيش أي حركة تتسجل بتاريخ في الشهر ده. التصحيح بيبقى بقيد بتاريخ بعده.',
      fields: [{ name: 'month', label: 'الشهر', type: 'month', value: lastMonth }, { name: 'note', label: 'ملاحظة (اختياري)', wide: true }],
      submitLabel: 'اقفل الشهر', onSubmit: (v) => post('/api/month-locks', v),
    });
    if (r) { toast('الشهر اتقفل'); locks(box); }
  };
  const unlock = async (l) => {
    const reason = await confirmModal(`فتح شهر ${l.month}`, 'فتح الشهر بيسمح بتسجيل حركات بتاريخه تاني. السبب بيتسجل في سجل التعديلات.', 'افتح الشهر', { withReason: true, reasonLabel: 'سبب الفتح' });
    if (!reason) return;
    try { await del(`/api/month-locks/${l.month}`, { reason }); toast('الشهر اتفتح'); locks(box); } catch (ex) { toastError(ex); }
  };
  fill(box,
    h('div', { class: 'row', style: 'margin-bottom:12px' }, button('اقفل شهر', { kind: 'primary', icon: 'lock-key', onClick: lock })),
    dataTable([
      { label: 'الشهر', value: (l) => h('b', { class: 'num' }, l.month) },
      { label: 'اتقفل', value: (l) => h('span', {}, h('span', { class: 'num' }, fmtDateTime(l.locked_at)), l.locked_by_name ? ` — ${l.locked_by_name}` : '') },
      { label: 'ملاحظة', value: (l) => l.note || '' },
      { label: '', value: (l) => button('افتح', { size: 'sm', icon: 'lock-key-open', onClick: () => unlock(l) }) },
    ], list, { empty: emptyState('lock-key', 'مفيش شهور مقفولة', 'اقفل الشهر بعد ما تراجع حساباته، عشان محدش يسجل فيه بالغلط.', null, true) }));
}

// Kept for module screens that want a quick number format in settings-like lists.
export { num, fmtDate };
