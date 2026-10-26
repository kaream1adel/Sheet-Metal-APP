// Deliveries (manager + admin): tick what leaves the workshop, print the note. No prices.
import { h, toast, fmtDate, todayISO, formModal } from './ui.js';
import { get, post } from './api.js';
import { go } from './app.js';

export async function renderDeliveries(main) {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const clientId = Number(params.get('client')) || null;
  const [{ clients }, { deliveries }] = await Promise.all([get('/api/deliveries/pending'), get('/api/deliveries')]);

  const box = h('div');
  main.replaceChildren(
    h('div', { class: 'top' }, h('h1', {}, 'تسليم الشغل')),
    h('div', { class: 'row', style: 'margin-bottom:12px' },
      h('span', { class: 'muted' }, 'العميل:'),
      h('select', { onchange: (e) => go(e.target.value ? `#/deliveries?client=${e.target.value}` : '#/deliveries') },
        h('option', { value: '' }, clients.length ? 'اختار العميل اللي جاي ياخد شغله' : 'مفيش شغل مستني تسليم'),
        clients.map((c) => h('option', { value: c.id, selected: c.id === clientId }, `${c.name} (${c.lines} سطر)`)))),
    box,
    h('h2', { style: 'margin-top:24px' }, 'آخر أذونات التسليم'),
    deliveries.length === 0 ? h('div', { class: 'card muted' }, 'لسه مفيش.') :
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['#', 'التاريخ', 'العميل', 'المستلم', 'سطور', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, deliveries.map((d) => h('tr', { class: d.cancelled_at ? 'cancelled-row' : '' },
          h('td', { class: 'num' }, d.id), h('td', {}, fmtDate(d.delivery_date)), h('td', {}, d.client_name), h('td', {}, d.receiver || '—'),
          h('td', { class: 'num' }, d.cancelled_at ? 'اتلغى' : d.lines),
          h('td', {}, h('div', { class: 'row', style: 'flex-wrap:nowrap' },
            h('button', { class: 'btn sm', onclick: () => window.open(`/print/delivery/${d.id}`, '_blank') }, 'طباعة'),
            !d.cancelled_at ? h('button', { class: 'btn sm danger', onclick: async () => {
              const ok = await formModal({ title: 'إلغاء إذن التسليم', fields: [{ name: 'reason', label: 'السبب (هيتسجل)' }], submitLabel: 'إلغاء',
                onSubmit: (v) => post(`/api/deliveries/${d.id}/cancel`, v) });
              if (ok) { toast('اتلغى — الشغل رجع مستني تسليم'); go(location.hash); }
            } }, 'إلغاء') : null))))))));

  if (!clientId) return;
  const { lines } = await get(`/api/deliveries/pending/${clientId}`);
  const picked = new Set(lines.map((l) => l.id));
  const dateIn = h('input', { type: 'date', value: todayISO() });
  const receiverIn = h('input', { type: 'text', placeholder: 'اسم المستلم (اختياري)' });
  const notesIn = h('input', { type: 'text', placeholder: 'ملاحظات (اختياري)' });
  const all = h('input', { type: 'checkbox', checked: true, onchange: (e) => {
    box.querySelectorAll('tbody input[type=checkbox]').forEach((c) => { c.checked = e.target.checked; });
    lines.forEach((l) => (e.target.checked ? picked.add(l.id) : picked.delete(l.id)));
  } });
  box.replaceChildren(
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, all), ['تاريخ الشغل', 'الشغل', 'الكمية'].map((t) => h('th', {}, t)))),
      h('tbody', {}, lines.map((l) => h('tr', {},
        h('td', {}, h('input', { type: 'checkbox', checked: true, onchange: (e) => (e.target.checked ? picked.add(l.id) : picked.delete(l.id)) })),
        h('td', {}, fmtDate(l.date)), h('td', {}, l.text), h('td', { class: 'small' }, l.qty)))))),
    h('div', { class: 'actions' }, h('span', { class: 'muted small' }, 'تاريخ التسليم'), dateIn, receiverIn, notesIn,
      h('button', { class: 'btn primary', onclick: async () => {
        if (!picked.size) return toast('علّم على الشغل اللي اتسلم', true);
        try {
          const { delivery } = await post('/api/deliveries', { client_id: clientId, line_ids: [...picked], delivery_date: dateIn.value, receiver: receiverIn.value, notes: notesIn.value });
          toast(`اتسجل إذن التسليم رقم ${delivery.id}`);
          window.open(`/print/delivery/${delivery.id}`, '_blank');
          go('#/deliveries');
        } catch (ex) { toast(ex.message, true); }
      } }, 'سجّل التسليم واطبع الإذن')));
}
