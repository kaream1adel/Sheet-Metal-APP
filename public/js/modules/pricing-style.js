// The pricing screens' few extra rules, on the shared tokens of public/css/app.css (one design
// system: same colours, radii and the Excel convention). Injected once.
const CSS = `
.pr-client { margin-bottom: 22px; }
.pr-client-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.pr-client-head h2 { margin: 0; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.pr-client-head h2 a { color: inherit; }
table.xg td.suggested input::placeholder { color: var(--muted); opacity: 1; font-style: italic; }
table.xg td.suggested.computed, .xg-card .f.suggested .v { color: var(--muted); font-style: italic; }
.xg-card .f.suggested input::placeholder { color: var(--muted); opacity: 1; font-style: italic; }
.pr-apply { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 8px; padding: 8px 12px;
  border: 1px solid var(--accent-line); background: var(--accent-soft); border-radius: 8px; font-size: 14px; color: var(--accent); }
.pr-apply[hidden] { display: none; }
.pr-adjust { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)) minmax(0, 1.4fr); gap: 12px; align-items: end; margin-top: 12px; }
.pr-sums { display: flex; flex-direction: column; gap: 2px; padding: 8px 12px; background: var(--cell-total); border-radius: 8px; font-size: 13px; }
.pr-sums .l { display: flex; justify-content: space-between; gap: 12px; }
.pr-sums .l b { font-size: 15px; }
.pr-foot { position: sticky; bottom: 0; z-index: 5; display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
  margin-top: 18px; padding: 12px 16px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow-lg); }
.pr-foot .grow { flex: 1; min-width: 0; }
.pr-foot b.money { font-size: 20px; }
.pr-chips { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 14px; }
.pr-chip { border: 1px solid var(--border-strong); background: var(--surface); border-radius: 999px; padding: 4px 12px; cursor: pointer; font-size: 13px; color: var(--text-2); min-height: 32px; }
.pr-chip b { font-variant-numeric: tabular-nums; margin-inline-start: 4px; color: var(--muted); font-weight: 600; }
.pr-chip.on { background: var(--accent-soft); border-color: var(--accent-line); color: var(--accent); }
.pr-chip:active { transform: scale(.98); }
.pr-day { display: flex; align-items: baseline; gap: 10px; margin: 20px 0 8px; }
.pr-day h2 { margin: 0; }
.pr-day span { color: var(--muted); font-size: 13px; }
.pr-section { margin-bottom: 22px; }
.pr-section .section-title { margin-top: 8px; }
.pr-sumstrip { display: flex; flex-wrap: wrap; gap: 6px 18px; padding: 8px 12px; background: var(--cell-total); border: 1px solid var(--border);
  border-bottom: 0; border-radius: var(--radius) var(--radius) 0 0; font-size: 13px; color: var(--text-2); }
.pr-sumstrip span b { font-variant-numeric: tabular-nums; direction: ltr; unicode-bidi: isolate; margin-inline-start: 4px; color: var(--text); }
.pr-sumstrip + .table-wrap { border-radius: 0 0 var(--radius) var(--radius); }
.pr-sheet td.computed { background: var(--cell-computed); }
.pr-sheet td { white-space: nowrap; }
.pr-grand { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
.pr-kv { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 14px; }
.pr-correct { margin-top: 18px; }
@media (max-width: 820px) {
  .pr-adjust { grid-template-columns: 1fr 1fr; }
  .pr-adjust .pr-sums { grid-column: 1 / -1; }
  .pr-foot { bottom: 64px; padding: 10px 12px; }
  .pr-foot .btn { width: 100%; }
  .pr-chip, .pr-client-head .btn, .pr-tabhead .btn { min-height: 44px; }
  .pr-sumstrip { border-radius: var(--radius); border-bottom: 1px solid var(--border); margin-bottom: 8px; }
  .pr-sheet td { white-space: normal; }
}
@media print {
  .pr-foot, .pr-apply, .pr-adjust input { display: none !important; }
}
`;

export function ensurePricingStyles() {
  if (document.getElementById('pricing-css')) return;
  const el = document.createElement('style');
  el.id = 'pricing-css';
  el.textContent = CSS;
  document.head.append(el);
}
