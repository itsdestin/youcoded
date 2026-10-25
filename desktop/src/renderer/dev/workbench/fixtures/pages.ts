// Workbench fixtures for YouCoded Pages (Phase 1 shell). Sample pages that
// need nothing from outside their frame — exactly what Phase 1 allows — so the
// library, the pinned buttons and the host can be reviewed with no backend.
//
// Each page is written against the style kit's classes (page-kit.ts) and the
// tokens page-theme.ts delivers, and keeps a little working state (strokes on
// a canvas) so a theme switch can be SEEN to preserve it.
//
// Round 1 of the shell deck (2026-09-16): a notes board and a bare canvas
// read as "too basic for what i had envisioned". The samples now show what a
// page can be — a paint studio with tools, palette, undo and redo — because
// the samples are what sets the expectation for the creator skill.
//
// 2026-10-16 (Destin): the Focus timer and Week planner samples were removed.
// WHY: they duplicated what the other samples already show; the kit dropdown
// they demonstrated (and its "Add another…" foot action) now lives on the Kit
// pieces practice page (kit-pieces-page.ts).
import type { PageDocument } from '../../../../shared/pages-types';
import { MONEY_PAGE } from './money/money';
import { HOME_ASSISTANT_PAGE_HTML, HOME_ASSISTANT_PAGE_JSON } from './home-assistant-page';

// A paint studio: tool rail (brush, eraser, line, rectangle, ellipse), a
// palette with a custom colour, size and opacity, undo/redo/clear, and a
// paper-white canvas that keeps its colours in every theme.
const PAINT_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Paint studio</title>
<style>
  html, body { height: 100%; overflow: hidden; }
  .stage { position: absolute; inset: 0; display: grid; place-items: center; padding: 20px; background: var(--well); }
  .paper { position: relative; width: min(100%, 1100px); height: min(100%, 700px); background: #ffffff; border-radius: var(--radius-md, 8px); box-shadow: 0 8px 32px rgba(0,0,0,.25); overflow: hidden; }
  canvas { position: absolute; inset: 0; width: 100%; height: 100%; cursor: crosshair; touch-action: none; }
  #preview { pointer-events: none; }
  .name { font: inherit; font-size: 14px; font-weight: 500; color: var(--fg); background: transparent; border: 1px solid transparent; border-radius: var(--radius-md, 8px); padding: 4px 8px; min-width: 200px; }
  .name:hover, .name:focus { border-color: var(--edge); background: var(--inset); outline: none; }
  .dot { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; background: #ffffff; border: 1px solid var(--edge); margin: 0 auto; }
  .dot i { display: block; border-radius: 50%; background: var(--paint, #1d1d1d); width: var(--sz, 6px); height: var(--sz, 6px); opacity: var(--op, 1); }
  .hint { display: flex; gap: 10px; flex-wrap: wrap; }
</style></head>
<body>
<div class="yc-app">
  <div class="yc-toolbar">
    <span class="yc-eyebrow">Studio</span>
    <input class="name" value="Untitled painting" aria-label="Painting name">
    <span class="yc-spacer"></span>
    <button class="yc-button yc-button--sm" id="undo" disabled>Undo</button>
    <button class="yc-button yc-button--sm" id="redo" disabled>Redo</button>
    <button class="yc-button yc-button--sm yc-button--ghost" id="clear">Clear</button>
    <button class="yc-button yc-button--sm yc-button--primary" id="save">Save as picture</button>
  </div>
  <div class="yc-app__body">
    <div class="yc-rail" id="rail">
      <button class="yc-tool yc-tool--on" data-tool="brush" title="Brush (B)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 3l3 3-9 9-4 1 1-4 9-9zM5 21c2 0 3-1 3-3 0-1-1-2-2-2s-3 1-3 3c0 1 1 2 2 2z"/></svg></button>
      <button class="yc-tool" data-tool="eraser" title="Eraser (E)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 21h14M3 15l9-9 6 6-6 6H8l-5-3zM12 6l6 6"/></svg></button>
      <button class="yc-tool" data-tool="line" title="Line (L)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 20L20 4"/></svg></button>
      <button class="yc-tool" data-tool="rect" title="Rectangle (R)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="5" width="16" height="14" rx="1"/></svg></button>
      <button class="yc-tool" data-tool="ellipse" title="Ellipse (O)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="12" rx="8" ry="6"/></svg></button>
    </div>
    <div class="yc-app__main">
      <div class="stage"><div class="paper" id="paper"><canvas id="c"></canvas><canvas id="preview"></canvas></div></div>
    </div>
    <aside class="yc-sidebar">
      <section class="yc-stack" style="gap:8px">
        <div class="yc-eyebrow">Colour</div>
        <div class="yc-swatches" id="swatches"></div>
        <label class="yc-row yc-row--between yc-small"><span class="yc-muted">Custom</span><input type="color" id="custom" value="#1d1d1d" aria-label="Custom colour"></label>
      </section>
      <section class="yc-stack" style="gap:8px">
        <div class="yc-eyebrow">Brush</div>
        <div class="dot" id="dot"><i></i></div>
        <label class="yc-small"><span class="yc-row yc-row--between"><span class="yc-muted">Size</span><span id="szv">6 px</span></span><input class="yc-range" type="range" id="size" min="1" max="48" value="6"></label>
        <label class="yc-small"><span class="yc-row yc-row--between"><span class="yc-muted">Opacity</span><span id="opv">100%</span></span><input class="yc-range" type="range" id="opacity" min="10" max="100" value="100"></label>
      </section>
      <section class="yc-stack" style="gap:8px">
        <div class="yc-eyebrow">Shortcuts</div>
        <div class="hint yc-small yc-muted"><span><span class="yc-kbd">B</span> brush</span><span><span class="yc-kbd">E</span> eraser</span><span><span class="yc-kbd">L</span> line</span><span><span class="yc-kbd">R</span> rect</span><span><span class="yc-kbd">O</span> ellipse</span><span><span class="yc-kbd">Ctrl Z</span> undo</span></div>
      </section>
      <section class="yc-stack" style="gap:4px">
        <div class="yc-eyebrow">This painting</div>
        <div class="yc-caption"><span id="count">0</span> strokes · 1100 × 700</div>
      </section>
    </aside>
  </div>
</div>
<script>
  var PALETTE = ['#1d1d1d','#6b6b6b','#ffffff','#d63a3a','#e5a13a','#f2d34b','#2f9e5b','#2bb3b1','#3070d6','#8c4fd0','#e55d9c','#8a5a3c'];
  var paper = document.getElementById('paper'), c = document.getElementById('c'), p = document.getElementById('preview');
  var x = c.getContext('2d'), px = p.getContext('2d');
  var tool = 'brush', color = '#1d1d1d', size = 6, alpha = 1;
  var savedPaint = (window.youcoded && window.youcoded.data) || null;
  var ops = [], redo = [], cur = null;
  function persist(){ if (window.youcoded) window.youcoded.save({ ops: ops }); }
  var sw = document.getElementById('swatches');
  PALETTE.forEach(function(col, i){ var b = document.createElement('button'); b.className = 'yc-swatch' + (i===0?' yc-swatch--on':''); b.style.background = col; b.title = col; b.onclick = function(){ setColor(col, b); }; sw.appendChild(b); });
  function setColor(col, btn){ color = col; document.querySelectorAll('.yc-swatch').forEach(function(s){ s.classList.toggle('yc-swatch--on', s===btn); }); document.getElementById('custom').value = col; dot(); }
  document.getElementById('custom').oninput = function(e){ setColor(e.target.value, null); };
  function dot(){ var d = document.getElementById('dot'); d.style.setProperty('--paint', color); d.style.setProperty('--sz', Math.min(36, size)+'px'); d.style.setProperty('--op', alpha); }
  document.getElementById('size').oninput = function(e){ size = +e.target.value; document.getElementById('szv').textContent = size+' px'; dot(); };
  document.getElementById('opacity').oninput = function(e){ alpha = e.target.value/100; document.getElementById('opv').textContent = e.target.value+'%'; dot(); };
  document.querySelectorAll('[data-tool]').forEach(function(b){ b.onclick = function(){ setTool(b.dataset.tool); }; });
  function setTool(t){ tool = t; document.querySelectorAll('[data-tool]').forEach(function(b){ b.classList.toggle('yc-tool--on', b.dataset.tool===t); }); }
  function fit(){ var r = paper.getBoundingClientRect(); [c,p].forEach(function(k){ k.width = r.width*devicePixelRatio; k.height = r.height*devicePixelRatio; k.getContext('2d').setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0); }); redraw(); }
  function pt(e){ var r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  function draw(ctx, o){
    ctx.save(); ctx.globalAlpha = o.a; ctx.lineWidth = o.w; ctx.lineCap = ctx.lineJoin = 'round';
    ctx.strokeStyle = o.t === 'eraser' ? '#ffffff' : o.c; if (o.t === 'eraser') ctx.globalAlpha = 1;
    ctx.beginPath();
    if (o.t === 'brush' || o.t === 'eraser') { o.p.forEach(function(q,i){ i ? ctx.lineTo(q[0],q[1]) : ctx.moveTo(q[0],q[1]); }); if (o.p.length===1) ctx.lineTo(o.p[0][0]+0.01, o.p[0][1]); }
    else { var a = o.p[0], b = o.p[o.p.length-1];
      if (o.t === 'line') { ctx.moveTo(a[0],a[1]); ctx.lineTo(b[0],b[1]); }
      if (o.t === 'rect') ctx.rect(Math.min(a[0],b[0]), Math.min(a[1],b[1]), Math.abs(b[0]-a[0]), Math.abs(b[1]-a[1]));
      if (o.t === 'ellipse') ctx.ellipse((a[0]+b[0])/2, (a[1]+b[1])/2, Math.abs(b[0]-a[0])/2, Math.abs(b[1]-a[1])/2, 0, 0, Math.PI*2); }
    ctx.stroke(); ctx.restore();
  }
  function redraw(){ x.clearRect(0,0,c.width,c.height); ops.forEach(function(o){ draw(x,o); }); document.getElementById('count').textContent = ops.length; document.getElementById('undo').disabled = !ops.length; document.getElementById('redo').disabled = !redo.length; }
  c.onpointerdown = function(e){ cur = { t: tool, c: color, w: size, a: alpha, p: [pt(e)] }; c.setPointerCapture(e.pointerId); };
  c.onpointermove = function(e){ if(!cur) return; cur.p.push(pt(e)); px.clearRect(0,0,p.width,p.height); draw(px, cur); };
  c.onpointerup = c.onpointercancel = function(){ if(!cur) return; ops.push(cur); redo = []; cur = null; px.clearRect(0,0,p.width,p.height); redraw(); persist(); };
  document.getElementById('undo').onclick = function(){ if (ops.length) { redo.push(ops.pop()); redraw(); persist(); } };
  document.getElementById('redo').onclick = function(){ if (redo.length) { ops.push(redo.pop()); redraw(); persist(); } };
  document.getElementById('clear').onclick = function(){ if (!ops.length) return; redo = ops.slice().reverse(); ops = []; redraw(); persist(); };
  document.getElementById('save').onclick = function(){ var b = document.getElementById('save'); b.textContent = 'Saved'; setTimeout(function(){ b.textContent = 'Save as picture'; }, 1200); };
  window.addEventListener('keydown', function(e){
    if (e.target.tagName === 'INPUT') return;
    if ((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='z') { e.preventDefault(); (e.shiftKey ? document.getElementById('redo') : document.getElementById('undo')).click(); return; }
    var k = { b:'brush', e:'eraser', l:'line', r:'rect', o:'ellipse' }[e.key.toLowerCase()]; if (k) setTool(k);
  });
  // A little something on the paper the first time, so the studio does not open blank.
  ops = (savedPaint && savedPaint.ops) ? savedPaint.ops : [
    { t:'brush', c:'#3070d6', w:10, a:1, p:[[180,420],[220,300],[300,240],[400,260],[470,340],[520,440]] },
    { t:'ellipse', c:'#e5a13a', w:8, a:1, p:[[560,140],[700,280]] },
    { t:'rect', c:'#2f9e5b', w:6, a:.8, p:[[760,380],[960,520]] },
    { t:'line', c:'#d63a3a', w:4, a:1, p:[[140,600],[980,600]] }
  ];
  // The seed was drawn for an 1100-wide paper; scale it to whatever width the
  // paper actually got (a narrower window, the rail open) so nothing is cut off.
  (function(){ if (savedPaint && savedPaint.ops) return; var k = paper.getBoundingClientRect().width / 1100; if (k > 0 && k !== 1) ops.forEach(function(o){ o.w = Math.max(2, o.w * k); o.p = o.p.map(function(q){ return [q[0]*k, q[1]*k]; }); }); })();
  window.onresize = fit; dot(); fit();
</script>
</body></html>`;

// ── Phase 2: connected pages (questions decks, 2026-09-19) ────────────────
// Seven pages that each reach something outside, so every approval state is
// reviewable: a YouCoded sign-in, a saved key offered again, a fresh key with
// full access, an edit that added a line, the whole internet, and GitHub.
// Their numbers are baked in — the workbench makes no requests — and they are
// what the page would show after the app fetched on its behalf.

const ANALYTICS_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>YouCoded analytics</title>
<style>
  .tiles { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 12px; }
  .tile b { display:block; font-size: 28px; font-weight: 600; line-height: 1.1; margin-top: 4px; }
  .bars { display:flex; align-items:flex-end; gap:6px; height:140px; padding-top: 8px; }
  .bars i { flex:1; background: var(--accent); border-radius: 4px 4px 0 0; opacity:.85; min-width: 6px; }
  .bars i:last-child { opacity: 1; }
  .two { display:grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .meter { height:6px; border-radius:3px; background: var(--inset); overflow:hidden; flex:1; }
  .meter > span { display:block; height:100%; background: var(--accent); }
  @media (max-width: 720px) { .tiles { grid-template-columns: 1fr 1fr; } .two { grid-template-columns: 1fr; } }
</style></head>
<body>
<div class="yc-page yc-stack">
  <div class="yc-row yc-row--between">
    <div><div class="yc-eyebrow">YouCoded</div><h1>Who is using the app</h1></div>
    <div class="yc-row"><button class="yc-button yc-button--sm">7 days</button><button class="yc-button yc-button--sm yc-pill--on">30 days</button><button class="yc-button yc-button--sm">90 days</button></div>
  </div>
  <div class="tiles">
    <div class="yc-card tile"><span class="yc-eyebrow">Today</span><b>412</b><span class="yc-muted yc-small">people</span></div>
    <div class="yc-card tile"><span class="yc-eyebrow">This month</span><b>2,186</b><span class="yc-muted yc-small">people</span></div>
    <div class="yc-card tile"><span class="yc-eyebrow">New this week</span><b>143</b><span class="yc-muted yc-small">installs</span></div>
    <div class="yc-card tile"><span class="yc-eyebrow">On the newest version</span><b>71%</b><span class="yc-muted yc-small">of people today</span></div>
  </div>
  <div class="yc-card yc-stack" style="gap:8px">
    <div class="yc-row yc-row--between"><span class="yc-title">People per day</span><span class="yc-muted yc-small">last 30 days</span></div>
    <div class="bars" id="bars"></div>
  </div>
  <div class="two">
    <div class="yc-card yc-stack" style="gap:10px"><span class="yc-title">Versions</span><div id="versions" class="yc-stack" style="gap:8px"></div></div>
    <div class="yc-card yc-stack" style="gap:10px"><span class="yc-title">Where</span><div id="where" class="yc-stack" style="gap:8px"></div></div>
  </div>
</div>
<script>
  var d=[210,224,231,228,190,176,240,252,261,270,266,214,201,280,291,302,310,305,250,238,322,340,351,349,360,301,288,380,398,412];
  var max=Math.max.apply(null,d); document.getElementById('bars').innerHTML=d.map(function(v){return '<i style="height:'+(100*v/max)+'%" title="'+v+'"></i>';}).join('');
  function rows(id,list){ document.getElementById(id).innerHTML=list.map(function(r){ return '<div class="yc-row"><span style="width:96px" class="yc-small">'+r[0]+'</span><span class="meter"><span style="width:'+r[1]+'%"></span></span><span class="yc-muted yc-small" style="width:40px;text-align:right">'+r[1]+'%</span></div>'; }).join(''); }
  rows('versions',[['1.3.2',71],['1.3.1',17],['1.3.0',8],['older',4]]);
  rows('where',[['United States',46],['Germany',11],['United Kingdom',9],['Canada',7],['India',6]]);
</script>
</body></html>`;

/** A plain kit-styled page for the other connected samples: a heading and a
 *  list of rows. Enough to show the page opening after Allow. */
function simplePage(eyebrow: string, title: string, rows: Array<[string, string]>): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>
<div class="yc-page yc-stack">
  <div><div class="yc-eyebrow">${eyebrow}</div><h1>${title}</h1></div>
  <div class="yc-card"><div class="yc-list">${rows.map(([a, b]) => `<div class="yc-list-row yc-row yc-row--between"><span>${a}</span><span class="yc-muted">${b}</span></div>`).join('')}</div></div>
</div></body></html>`;
}

/** Minutes before "now", so the band's "Updated 2 min ago" is always 2 min. */
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

// WHY the parenthetical in each placeholder's NAME (Destin, 2026-10-16): these are practice
// samples, and the name alone did not say which approval or band state each one exists to
// show. The ids stay the same so screen names and tests keep working.
function connectedPages(): PageDocument[] {
  const base = { home: { kind: 'personal' as const }, pinned: false, data: null };
  return [
    {
      ...base, id: 'page-analytics', name: 'YouCoded analytics', icon: 'chart', pinned: true,
      description: 'People using the app each day, new installs, versions and countries.',
      updatedAt: '2026-09-18T16:00:00.000Z', htmlStamp: 1789747200000, html: ANALYTICS_HTML,
      connections: [{ id: 'yc', kind: 'youcoded', approved: true }],
      refresh: { at: minutesAgo(2), failed: false },
    },
    {
      ...base, id: 'page-trip-board', name: 'Trip board (refresh failed)', icon: 'calendar',
      description: 'Lisbon in October: the forecast for each day beside what is booked.',
      updatedAt: '2026-09-15T11:30:00.000Z', htmlStamp: 1789471800000,
      html: simplePage('Lisbon · 3–9 October', 'Trip board', [['Fri 3', '24° clear · arrive 14:10'], ['Sat 4', '23° clear · Alfama walk'], ['Sun 5', '21° showers · Gulbenkian'], ['Mon 6', '22° cloud · Sintra train 09:41']]),
      connections: [{ id: 'weather', kind: 'key', service: 'OpenWeather', address: 'api.openweathermap.org', access: 'lookup', approved: true, savedKey: true }],
      // The failed state: the page keeps its last good numbers, the band says so.
      refresh: { at: minutesAgo(190), failed: true },
    },
    {
      ...base, id: 'page-weather', name: 'Weather (saved key, asks first)', icon: 'page',
      description: 'Today and the next five days for the places you care about.',
      updatedAt: '2026-09-19T07:10:00.000Z', htmlStamp: 1789801800000,
      html: simplePage('Phoenix', 'Weather', [['Now', '38° clear'], ['Tonight', '29°'], ['Sat', '39° clear'], ['Sun', '37° wind']]),
      // First ask, and a key for this service is already saved: offered, still asks.
      connections: [{ id: 'weather', kind: 'key', service: 'OpenWeather', address: 'api.openweathermap.org', access: 'lookup', approved: false, savedKey: true }],
    },
    {
      ...base, id: 'page-task-board', name: 'Task board (new key, full access)', icon: 'list',
      description: 'Your Todoist tasks as a board you can drag between columns.',
      updatedAt: '2026-09-19T06:40:00.000Z', htmlStamp: 1789800000000,
      html: simplePage('Todoist', 'Task board', [['Draft fiscal note', 'Today'], ['Reply to Sarah', 'Today'], ['Renew domain', 'Mon']]),
      // First ask, fresh key, FULL access: the blunter sentence and the key box.
      connections: [{ id: 'todoist', kind: 'key', service: 'Todoist', address: 'api.todoist.com', access: 'full', approved: false, savedKey: false,
        keyHelp: { steps: ['Open todoist.com and sign in.', 'Go to Settings, then Integrations, then Developer.', 'Copy the API token and paste it below.'] },
        // Finishing Pages step 1: written as a service recipe, so the card lists what it may do.
        allow: [
          { method: 'GET', path: '/rest/v2/tasks', does: 'See your tasks and projects' },
          { method: 'GET', path: '/rest/v2/projects', does: 'See your tasks and projects' },
          { method: 'POST', path: '/rest/v2/tasks', does: 'Add, complete and move tasks' },
        ] }],
    },
    {
      ...base, id: 'page-headlines', name: 'Headlines (second website added)', icon: 'notes',
      description: 'A front page built from the feeds you follow.',
      updatedAt: '2026-09-19T05:00:00.000Z', htmlStamp: 1789794000000,
      html: simplePage('This morning', 'Headlines', [['BBC News', '12 stories'], ['Hacker News', '30 stories']]),
      // An edit added a second feed: one line approved, one New.
      connections: [
        { id: 'bbc', kind: 'public', address: 'feeds.bbci.co.uk', approved: true },
        { id: 'hn', kind: 'public', address: 'hnrss.org', approved: false },
      ],
      // One site it may open without asking, for Page settings' list.
      openSites: ['news.ycombinator.com'],
      refresh: { at: minutesAgo(12), failed: false },
    },
    {
      ...base, id: 'page-link-reader', name: 'Link reader (any website)', icon: 'page',
      description: 'Paste any link and read the article without the clutter.',
      updatedAt: '2026-09-18T20:15:00.000Z', htmlStamp: 1789762500000,
      html: simplePage('Reader', 'Link reader', [['Paste a link to begin', '']]),
      // The whole internet: its own blunt approval, alone on the page.
      connections: [{ id: 'open', kind: 'open', approved: false }],
    },
    {
      // Home-device deck (2026-10-01): the Home Assistant page, waiting for its
      // first yes, so the device approval card (address box, key step with the
      // Open Home Assistant button) is what opens. After Allow, the workbench's
      // pretend Home Assistant (mock-shim's fake-home-assistant) answers it.
      ...base, id: 'page-home', name: HOME_ASSISTANT_PAGE_JSON.name, icon: 'page',
      description: HOME_ASSISTANT_PAGE_JSON.description,
      customIcon: HOME_ASSISTANT_PAGE_JSON.customIcon,
      updatedAt: '2026-10-01T08:00:00.000Z', htmlStamp: 1790841600000,
      html: HOME_ASSISTANT_PAGE_HTML,
      connections: [{ ...(HOME_ASSISTANT_PAGE_JSON.connections[0] as { id: string; service: string; address: string; keyPage: string; keyHelp: { steps: string[] } }), kind: 'device', access: 'full', needsKey: true, approved: false, savedKey: false }],
    },
    {
      ...base, id: 'page-release-board', name: 'Release board (reads GitHub, changed since allowed)', icon: 'list',
      home: { kind: 'project', path: '/home/destin/youcoded-dev/youcoded', name: 'youcoded' },
      description: 'Open pull requests and the checks on each, for this project.',
      updatedAt: '2026-09-17T13:00:00.000Z', htmlStamp: 1789650000000,
      html: simplePage('itsdestin/youcoded', 'Release board', [['#541 Pages connections', 'checks running'], ['#538 Project files', 'ready']]),
      connections: [{ id: 'gh', kind: 'github', access: 'lookup', approved: true }],
      refresh: { at: minutesAgo(1), failed: false },
      // Rewritten since it was allowed: the band shows the quiet note.
      codeChanged: true,
    },
    {
      // Finishing Pages step 1 (2026-10-24): a service no one built into the app,
      // described by a recipe — iCloud's calendar server, signed in with an Apple
      // ID and an app password (two parts), allowed only the calendar actions it
      // names — plus a public weather address. Together they make the
      // "could send what it reads… to api.open-meteo.com" line.
      ...base, id: 'page-family-calendar', name: 'Family calendar', icon: 'calendar',
      description: 'Everyone\'s events for the week, with the forecast for each day.',
      updatedAt: '2026-10-24T09:00:00.000Z', htmlStamp: 1792832400000,
      html: simplePage('This week', 'Family calendar', [['Mon 26', 'Dentist 15:00 · 22° clear'], ['Wed 28', 'Parent evening 18:30 · 19° rain'], ['Sat 31', 'Halloween party · 17° cloud']]),
      connections: [
        { id: 'icloud', kind: 'key', service: 'iCloud Calendar', address: 'caldav.icloud.com', access: 'full', approved: false, savedKey: false,
          allow: [
            // A calendar server speaks WebDAV: PROPFIND lists calendars, REPORT reads events.
            { method: 'PROPFIND', path: '/', does: 'See your calendars and events' },
            { method: 'REPORT', path: '/', does: 'See your calendars and events' },
            { method: 'PUT', path: '/', does: 'Add, change and remove events' },
            { method: 'DELETE', path: '/', does: 'Add, change and remove events' },
          ],
          parts: [
            { id: 'appleId', label: 'Apple ID email', in: 'basic-user' },
            { id: 'password', label: 'App password', secret: true, in: 'basic-password', hint: 'An app password, not your Apple ID password. Apple shows it once, when you make it.' },
          ],
          keyHelp: { steps: ['Sign in at account.apple.com.', 'Open Sign-In and Security, then App-Specific Passwords.', 'Make one called "YouCoded calendar" and copy it into the box below.'] } },
        { id: 'weather', kind: 'public', address: 'api.open-meteo.com', approved: false },
      ],
    },
    {
      // Page start session (spec 2026-10-14): a project page that may open the
      // new-conversation window with a message waiting. Opens on its approval
      // card; after Allow its button calls youcoded.startSession.
      ...base, id: 'page-weekly-briefing', name: 'Weekly briefing (can start a conversation)', icon: 'notes',
      home: { kind: 'project', path: '/home/destin/youcoded-dev/youcoded', name: 'youcoded' },
      description: 'What changed this week, and a button that starts the update in a new conversation.',
      updatedAt: '2026-10-14T09:00:00.000Z', htmlStamp: 1791968400000,
      html: WEEKLY_BRIEFING_HTML,
      connections: [{ id: 'start-session', kind: 'session', approved: false }],
    },
    {
      // Pages read and change chats, and run a program (spec 2026-10-16): the
      // shape of Destin's management page — every chat with change, its own
      // program, and Start a chat. Opens on its approval card.
      ...base, id: 'page-work-board', name: 'Work board', icon: 'list',
      description: 'Every piece of work, the chats on each, and buttons to start, resume or merge.',
      updatedAt: '2026-10-16T09:00:00.000Z', htmlStamp: 1792141200000,
      html: simplePage('youcoded-dev', 'Work board', [['#75 Choose skills per project', 'Agentic buildout'], ['#1 Rebuild the Android app', 'Agentic buildout']]),
      connections: [
        { id: 'chats', kind: 'chats', access: 'full', scope: { all: true }, approved: false },
        { id: 'helper', kind: 'program', file: 'work-items.mjs', approved: false },
        { id: 'start-session', kind: 'session', approved: false },
      ],
    },
    {
      // The narrow case: look only, one project, nothing else — so no
      // "could send your chat list" line.
      ...base, id: 'page-project-chats', name: 'Project chats', icon: 'notes',
      home: { kind: 'project', path: '/home/destin/youcoded-dev/youcoded', name: 'youcoded' },
      description: 'This project\'s chats, newest first, with a Resume button on each.',
      updatedAt: '2026-10-16T09:00:00.000Z', htmlStamp: 1792141200000,
      html: simplePage('youcoded', 'Project chats', [['Status bar names the repo', 'today'], ['Android rebuild wrap-up', 'yesterday']]),
      connections: [{ id: 'chats', kind: 'chats', access: 'lookup', scope: { projects: ['youcoded'] }, approved: false }],
    },
  ];
}

/** The start-session sample: a button that asks for the window, and the copy
 *  box an older app (no startSession) falls back to. */
const WEEKLY_BRIEFING_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Weekly briefing</title></head><body>
<div class="yc-page yc-stack">
  <div><div class="yc-eyebrow">youcoded · this week</div><h1>Weekly briefing</h1></div>
  <div class="yc-card yc-stack" style="gap:10px">
    <span class="yc-muted">Last updated 7 days ago.</span>
    <button class="yc-button yc-button--primary" id="go">Update now</button>
    <span class="yc-muted yc-small" id="note"></span>
  </div>
</div>
<script>
  document.getElementById('go').addEventListener('click', function () {
    // Several lines on purpose (review F4): the window's message preview has to
    // show a real page's long message scrolling inside its own box.
    var prompt = [
      'Run the weekly update for this project.',
      '',
      '1. Read what changed since last week: new commits, closed issues and any notes in the briefing folder.',
      '2. For each change, write one plain sentence saying what a reader will notice.',
      '3. Mark anything that still needs a decision, and say who has to make it.',
      '4. Refresh the briefing page with the new list, newest first.',
      '5. Keep last week\\'s list underneath, folded, so nothing is lost.',
      '',
      'Do not delete any older briefings. When you are done, tell me what changed in three lines or fewer.'
    ].join('\\n');
    var note = document.getElementById('note');
    if (typeof window.youcoded.startSession !== 'function') { note.textContent = 'Copy this into a new conversation: ' + prompt; return; }
    window.youcoded.startSession({ prompt: prompt }).then(function (r) { note.textContent = r.ok ? '' : 'The conversation window could not open.'; });
  });
</script>
</body></html>`;

export function seedPages(): PageDocument[] {
  return [
    // Finance dashboard, design stage (2026-10-05).
    MONEY_PAGE,
    ...connectedPages(),
    {
      id: 'page-paint',
      name: 'Paint studio',
      description: 'Brush, eraser and shapes, a palette with custom colours, size and opacity, undo and redo.',
      icon: 'paint',
      home: { kind: 'project', path: '/home/destin/youcoded-dev/youcoded', name: 'youcoded' },
      pinned: true,
      updatedAt: '2026-09-10T21:40:00.000Z',
      htmlStamp: 1789077600000,
      html: PAINT_HTML,
      data: null,
    },
  ];
}
