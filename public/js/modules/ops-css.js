// The operations screens' own layout rules, on top of public/css/app.css (same tokens, same
// conventions). Injected once, so the module needs no edit of the shared stylesheet.
const CSS = `
.ops-form { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); align-items: start; margin-bottom: 14px; }
.ops-filters { display: flex; flex-wrap: wrap; gap: 10px 12px; align-items: flex-end; margin-bottom: 14px; }
.ops-filters .field { width: 170px; }
.ops-filters .field.grow { flex: 1; min-width: 180px; width: auto; }
.ops-toolbar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 4px 0 10px; }
.ops-toolbar .legend { display: inline-flex; gap: 12px; align-items: center; font-size: 12.5px; color: var(--muted); margin-inline-start: auto; }
.ops-toolbar .legend i { display: inline-block; width: 12px; height: 12px; border-radius: 3px; border: 1px solid var(--border-strong); vertical-align: -2px; margin-inline-end: 4px; }
.ops-toolbar .legend i.t { background: var(--cell-typed); } .ops-toolbar .legend i.c { background: var(--cell-computed); }
.ops-toolbar .legend i.r { background: var(--red-soft); border-color: var(--red-mark); } .ops-toolbar .legend i.y { background: var(--yellow-soft); border-color: var(--yellow-mark); }
.ops-split { display: grid; gap: 16px; grid-template-columns: minmax(0, 1fr); }
.ops-split.with-photo { grid-template-columns: minmax(0, 1.25fr) minmax(320px, 1fr); }
.ops-photo { position: sticky; top: 12px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); overflow: hidden; display: flex; flex-direction: column; max-height: calc(100dvh - 24px); }
.ops-photo .bar { display: flex; gap: 6px; align-items: center; padding: 6px 8px; border-bottom: 1px solid var(--border); background: var(--surface-2); }
.ops-photo .bar b { font-size: 13px; font-weight: 600; margin-inline-end: auto; }
.ops-photo .view { overflow: auto; flex: 1; min-height: 260px; background: #1f2937; cursor: grab; touch-action: pan-x pan-y; }
.ops-photo .view img { display: block; width: calc(var(--z, 1) * 100%); max-width: none; height: auto; margin: 0 auto; user-select: none; -webkit-user-drag: none; }
.ops-photo .none { padding: 30px 16px; text-align: center; color: var(--muted); font-size: 13px; }
.ops-issues { display: grid; gap: 6px; margin-top: 14px; }
.ops-issues h3 { font-size: 14px; margin: 6px 0 2px; display: flex; gap: 8px; align-items: center; }
.ops-issue { display: flex; gap: 10px; align-items: flex-start; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface); font-size: 13.5px; }
.ops-issue.red { border-color: var(--red-line); background: var(--red-soft); }
.ops-issue.yellow { border-color: var(--yellow-line); background: var(--yellow-soft); }
.ops-issue.yellow.seen { background: var(--surface); border-color: var(--border); color: var(--muted); }
.ops-issue .where { font-weight: 600; white-space: nowrap; }
.ops-issue .what { flex: 1; min-width: 0; }
.ops-issue .acts { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
.chip { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--accent-line); background: var(--surface); color: var(--accent); border-radius: 999px; padding: 3px 12px; font-size: 13px; cursor: pointer; min-height: 30px; font-family: inherit; }
.chip:hover { background: var(--accent-soft); }
.chip:active { transform: scale(.98); }
.ops-bar { position: sticky; bottom: 0; z-index: 20; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; padding: 10px 0; margin-top: 16px; background: var(--bg); border-top: 1px solid var(--border); }
.ops-bar .state { font-size: 13px; color: var(--muted); margin-inline-end: auto; }
.ops-meta { display: flex; gap: 8px 16px; flex-wrap: wrap; align-items: center; font-size: 13.5px; color: var(--text-2); margin-bottom: 12px; }
.ops-meta b { font-weight: 600; }
.ops-counts { display: inline-flex; gap: 6px; }
.job-list { display: grid; gap: 10px; }
.job { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 12px; align-items: start; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 10px; box-shadow: var(--shadow); }
.job .thumb { width: 72px; height: 92px; border-radius: 8px; object-fit: cover; background: var(--surface-3); border: 1px solid var(--border); }
.job .head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.job .head b { font-weight: 600; }
.job .sub { font-size: 13px; color: var(--muted); margin-top: 3px; }
.job .acts { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.upload-zone { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); }
.upload-zone .btn { height: 64px; font-size: 16px; justify-content: center; }
.upload-zone input[type=file] { display: none; }
.ops-home .stats a.stat:hover { border-color: var(--accent-line); text-decoration: none; }
.ops-home .stat.warn b { color: var(--yellow); } .ops-home .stat.danger b { color: var(--red); }
.ops-home .lists { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); margin-top: 16px; }
.ops-list { display: grid; }
.ops-list a { display: flex; gap: 10px; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--border); color: inherit; text-decoration: none; min-height: 44px; }
.ops-list a:last-child { border-bottom: 0; }
.ops-list a:hover { background: var(--surface-2); }
.ops-list a .grow { flex: 1; min-width: 0; }
.ops-list a .small { color: var(--muted); }
.card.list-card { padding: 0; overflow: hidden; }
.card.list-card > h3 { margin: 0; padding: 12px 14px; font-size: 14px; border-bottom: 1px solid var(--border); display: flex; gap: 8px; align-items: center; }
.ops-progress { height: 6px; border-radius: 3px; background: var(--surface-3); overflow: hidden; min-width: 70px; }
.ops-progress i { display: block; height: 100%; background: var(--accent); }
.step { display: grid; gap: 12px; }
.step .card { padding: 14px; }
.step .f { display: grid; gap: 6px; }
.step .f label { font-size: 13px; color: var(--text-2); font-weight: 500; }
.step .f.mark-red input, .step .f.mark-red select { border-color: var(--red-mark); background: var(--red-soft); }
.step .f.mark-yellow input, .step .f.mark-yellow select { border-color: var(--yellow-mark); background: var(--yellow-soft); }
.step .f .v { background: var(--cell-computed); border-radius: 8px; padding: 0 10px; min-height: 44px; display: flex; align-items: center; }
.step .f .msg { font-size: 12.5px; }
.step .f.mark-red .msg { color: var(--red); } .step .f.mark-yellow .msg { color: var(--yellow); }
.step .nav { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.step .dots { display: flex; gap: 4px; flex-wrap: wrap; justify-content: center; }
.step .dots button { min-width: 44px; height: 44px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface); font-size: 12px; cursor: pointer; font-family: inherit; }
.step .dots button.on { border-color: var(--accent); color: var(--accent); font-weight: 600; }
.step .dots button.red { background: var(--red-soft); border-color: var(--red-line); }
.step .dots button.yellow { background: var(--yellow-soft); border-color: var(--yellow-line); }
.qty { font-variant-numeric: tabular-nums; }
@media (max-width: 820px) {
  .ops .btn { min-height: 44px; }
  .ops .btn.sm { min-height: 38px; }
  .ops-split.with-photo { grid-template-columns: minmax(0, 1fr); }
  .ops-photo { position: relative; top: 0; max-height: none; }
  .ops-photo .view { max-height: 46vh; }
  .ops-filters .field { width: calc(50% - 6px); }
  .ops-bar { bottom: 60px; }
  .ops-bar { flex-wrap: nowrap; gap: 6px; padding: 8px 0; }
  .ops-bar .state { display: none; }
  .ops-bar .btn { flex: 1 1 0; min-width: 0; padding: 0 8px; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ops-bar .btn svg { display: none; }
  .ops-toolbar .legend { display: none; }
  .chip { min-height: 40px; }
  .step .f input, .step .f select { min-height: 44px; }
}
`;

let done = false;
export function opsStyles() {
  if (done || typeof document === 'undefined') return;
  done = true;
  document.head.append(Object.assign(document.createElement('style'), { textContent: CSS, id: 'ops-css' }));
}
