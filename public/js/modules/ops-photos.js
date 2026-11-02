// صوّر ورقة: one or many photos of technicians' papers (phone camera or files). Each photo is
// made smaller on the phone, sent, and read on the server (a job). The list follows every
// photo until it is a sheet in review — or asks for the machine, or offers retry / typing it.
import { h, fill, icon, button, pageHead, emptyState, skeleton, field, notice, pill, toast, toastError, confirmModal, fmtDateTime } from '../ui.js';
import { get, post } from '../api.js';
import { MACHINES, MACHINE_NAMES } from './ops-paper.js';
import { opsStyles } from './ops-css.js';
import { fileToJpeg, machineSelect, technicianSelect } from './ops-common.js';

const STATUS = {
  queued: ['neutral', 'مستنية دورها'],
  reading: ['accent', 'بتتقري'],
  done: ['ok', 'خلصت'],
  failed: ['danger', 'وقفت'],
  needs_machine: ['warn', 'محتاجة المكنة'],
  dismissed: ['neutral', 'اتشالت'],
};

let poll = null;

export async function photoJobs(main, _params, ctx) {
  opsStyles();
  clearTimeout(poll);
  const L = ctx.state.lookups;
  const machine = machineSelect('', 'البرنامج يعرفها من الورقة');
  const tech = technicianSelect(L.technicians, '', 'من الورقة');
  const camera = h('input', { type: 'file', accept: 'image/*', capture: 'environment' });
  const files = h('input', { type: 'file', accept: 'image/*', multiple: true });
  const uploads = h('div', { class: 'job-list' });
  const list = h('div', {}, skeleton());
  const aiBox = h('div', {});
  let ai = !!L.ai_enabled;

  const drawAi = () => {
    machine.options[0].text = ai ? 'البرنامج يعرفها من الورقة' : 'اختار المكنة (أو بعدين)';
    tech.options[0].text = ai ? 'من الورقة' : 'من غير فني';
    return fill(aiBox, ai
    ? notice('info', h('b', {}, 'القراءة الآلية شغالة'), ' — الصورة بتتقري على الكمبيوتر وتطلع ورقة في المراجعة. الخانات اللي القراءة مش متأكدة منها بتتعلم بالأصفر.')
    : notice('warn', h('b', {}, 'القراءة الآلية مش متفعلة'), ' — الصورة هتتحفظ وتتعمل منها مسودة، وتكتب السطور بإيدك والصورة جنبك.',
      ctx.can('settings') ? [' ', h('a', { href: '#/settings/ai' }, 'فعّلها من الإعدادات')] : null));
  };
  drawAi();

  async function send(fileList) {
    const arr = [...fileList].filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|heic|webp)$/i.test(f.name));
    if (!arr.length) return toast('اختار صورة', true);
    for (const f of arr) {
      const thumb = h('img', { class: 'thumb', alt: '' });
      const state = h('div', { class: 'sub' }, 'بتتجهز…');
      const card = h('div', { class: 'job' }, thumb, h('div', {}, h('div', { class: 'head' }, h('b', {}, f.name || 'صورة'), pill('neutral', 'بترفع')), state));
      uploads.prepend(card);
      try {
        const { url, width, height } = await fileToJpeg(f);
        thumb.src = url;
        state.textContent = `بتترفع… (${width}×${height})`;
        const r = await post('/api/operations/photos', { image: url, machine: machine.value || null, technician_id: tech.value || null });
        card.remove();
        toast(r.job.status === 'done' ? 'الصورة اترفعت — اكتب السطور جنبها' : 'الصورة اترفعت وبتتقري');
      } catch (ex) {
        fill(state, h('span', { style: 'color:var(--red)' }, ex.message));
        card.querySelector('.pill').replaceWith(pill('danger', 'ماترفعتش'));
        if (ex.status === 409 && ex.data?.existing_sheet) {
          state.append(' ', h('a', { href: `#/ops/sheets/${ex.data.existing_sheet}` }, 'افتح الورقة'));
        }
      }
    }
    await load();
  }
  camera.addEventListener('change', () => { send(camera.files); camera.value = ''; });
  files.addEventListener('change', () => { send(files.files); files.value = ''; });

  const jobCard = (j) => {
    const [kind, label] = STATUS[j.status] || ['neutral', j.status];
    const acts = [];
    if (j.status === 'done' && j.sheet) {
      const href = j.sheet.status === 'review' && ctx.can('operations.approve') ? `#/ops/review/${j.sheet.id}` : `#/ops/sheets/${j.sheet.id}`;
      acts.push(button(j.sheet.status === 'draft' ? 'اكتب السطور' : j.sheet.status === 'review' ? 'راجعها' : 'افتح الورقة', { href, size: 'sm', kind: 'primary', icon: 'caret-left' }));
      acts.push(button('شيلها من هنا', { size: 'sm', kind: 'ghost', onClick: () => act(j, 'dismiss') }));
    }
    if (j.status === 'needs_machine') {
      acts.push(h('span', { class: 'small muted' }, 'دي ورقة:'), MACHINES.map((m) => button(MACHINE_NAMES[m], { size: 'sm', onClick: () => act(j, 'machine', { machine: m }) })));
    }
    if (j.status === 'failed') {
      if (ai) acts.push(button('جرب تاني', { size: 'sm', kind: 'primary', icon: 'arrows-clockwise', onClick: () => act(j, 'retry') }));
      const m = machineSelect(j.machine || '', 'المكنة', { 'aria-label': 'المكنة' });
      acts.push(m, button('اكتبها بإيدك', { size: 'sm', icon: 'pencil-line', onClick: () => {
        if (!m.value) { toast('اختار المكنة الأول', true); m.focus(); return null; }
        return act(j, 'manual', { machine: m.value });
      } }));
      acts.push(button('شيلها', { size: 'sm', kind: 'ghost', onClick: async () => {
        if (await confirmModal('شيل الصورة', 'الصورة هتتشال من القايمة (هتفضل محفوظة في السجل).', 'شيلها')) act(j, 'dismiss');
      } }));
    }
    const sheetLine = j.sheet ? h('div', { class: 'sub' },
      h('b', { class: 'num' }, j.sheet.serial), ` · ${j.sheet.machine_name} · ${j.sheet.lines} ${j.sheet.lines === 1 ? 'سطر' : 'سطور'}`,
      j.sheet.red ? [' · ', pill('danger', `${j.sheet.red} أحمر`)] : null, j.sheet.yellow ? [' ', pill('warn', `${j.sheet.yellow} أصفر`)] : null,
      j.sheet.clients?.length ? h('div', {}, j.sheet.clients.map((c) => `${c.name} (${c.n})`).join('، ')) : null) : null;
    return h('div', { class: 'job' },
      h('a', { href: j.photo_url, target: '_blank', rel: 'noopener', 'aria-label': 'افتح الصورة' }, h('img', { class: 'thumb', src: j.photo_url, alt: '', loading: 'lazy' })),
      h('div', {},
        h('div', { class: 'head' }, pill(kind, label), j.status === 'reading' ? icon('circle-notch', 'spin') : null,
          j.machine_name ? h('span', {}, j.machine_name) : null, h('span', { class: 'small muted num' }, fmtDateTime(j.created_at))),
        j.error ? h('div', { class: 'sub', style: j.status === 'failed' ? 'color:var(--red)' : '' }, j.error) : null,
        j.status === 'needs_machine' && j.rows_read !== null ? h('div', { class: 'sub' }, `اتقرى منها ${j.rows_read} سطر — القراءة مش عارفة دي ورقة أنهي مكنة.`) : null,
        sheetLine,
        acts.length ? h('div', { class: 'acts' }, acts) : null));
  };

  async function act(j, what, body = {}) {
    try {
      await post(`/api/operations/photos/${j.id}/${what}`, body);
      if (what === 'manual' || (what === 'machine' && !ai)) toast('اتعملت مسودة — اكتب السطور');
      await load();
    } catch (ex) { toastError(ex); }
  }

  async function load() {
    clearTimeout(poll);
    let r;
    try { r = await get('/api/operations/photos'); } catch (ex) {
      fill(list, notice('danger', ex.message, ' ', button('جرب تاني', { size: 'sm', onClick: load })));
      return;
    }
    if (ai !== r.ai) { ai = r.ai; drawAi(); }
    const jobs = r.jobs;
    fill(list, jobs.length
      ? h('div', { class: 'job-list' }, jobs.map(jobCard))
      : emptyState('camera', 'لسه مفيش صور', 'صوّر ورقة الفني بالموبايل أو اختار صور من الجهاز. الورقة كلها في الصورة، والنور كويس.', null, true));
    if (jobs.some((j) => ['queued', 'reading'].includes(j.status)) && location.hash.startsWith('#/ops/photos')) poll = setTimeout(load, 4000);
  }
  window.addEventListener('hashchange', () => clearTimeout(poll), { once: true });

  fill(main, h('div', { class: 'ops' },
    pageHead('صوّر ورقة', 'صوّر ورقة الفني (أو كذا ورقة) والبرنامج يقراها ويطلّعها في المراجعة.',
      button('أوراق التشغيل', { href: '#/ops/sheets', icon: 'files' })),
    aiBox,
    h('div', { class: 'card', style: 'margin:14px 0' },
      h('div', { class: 'ops-form' },
        field('المكنة', machine, { help: ai ? 'اختياري — القراءة بتعرفها من عنوان الورقة' : 'لو اخترتها المسودة بتتعمل على طول' }),
        field('الفني', tech, { help: ai ? 'اختياري — القراءة بتعرفه من اسمه على الورقة' : 'اختياري' })),
      h('div', { class: 'upload-zone' },
        h('label', { class: 'btn primary big' }, icon('camera', 'lg'), 'صوّر بالكاميرا', camera),
        h('label', { class: 'btn big' }, icon('images', 'lg'), 'اختار صور من الجهاز', files)),
      h('p', { class: 'small muted', style: 'margin:10px 0 0' }, 'الصورة بتتصغر على الموبايل قبل ما تترفع. لو النت قطع، الصورة اللي اترفعت متحفظة ومش بتضيع.')),
    uploads,
    h('div', { class: 'section-title' }, h('h2', {}, 'الصور'), button('حدّث', { size: 'sm', kind: 'ghost', icon: 'arrows-clockwise', onClick: load })),
    list));
  await load();
}
