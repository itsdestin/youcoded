// Workbench fixtures for YouCoded Pages (Phase 1 shell). Three pages that
// need nothing from outside their frame — exactly what Phase 1 allows — so the
// library, the pinned buttons and the host can be reviewed with no backend.
//
// Each page is written against the style kit's classes (page-kit.ts) and the
// tokens page-theme.ts delivers, and each keeps a little working state (a
// running timer, planned events, strokes on a canvas) so a theme switch can be
// SEEN to preserve it: switch themes with the timer running and it keeps
// counting.
//
// Round 1 of the shell deck (2026-09-16): a notes board and a bare canvas
// read as "too basic for what i had envisioned". The samples now show what a
// page can be — a week planner and a paint studio with tools, palette, undo
// and redo — because the samples are what sets the expectation for the
// creator skill.
import type { PageDocument } from '../../../../shared/pages-types';

const T = '2026-09-14T18:20:00.000Z';

const TIMER_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Focus timer</title>
<style>
  .clock { font-family: var(--font-mono); font-size: 64px; font-weight: 500; letter-spacing: .02em; line-height: 1; text-align: center; padding: 24px 0 8px; }
  .ring { width: 220px; height: 220px; border-radius: 50%; margin: 24px auto 0; display: grid; place-items: center;
          background: conic-gradient(var(--accent) var(--pct, 0%), var(--inset) 0); }
  .ring > div { width: 196px; height: 196px; border-radius: 50%; background: var(--panel); display: grid; place-items: center; }
  .presets { justify-content: center; }
</style></head>
<body>
<div class="yc-page yc-stack">
  <div class="yc-row yc-row--between">
    <div><div class="yc-eyebrow">Focus</div><h1>Focus timer</h1></div>
    <span class="yc-chip" id="state">Ready</span>
  </div>
  <div class="yc-card">
    <div class="ring" id="ring"><div><div class="clock" id="clock">25:00</div></div></div>
    <div class="yc-row presets" style="margin-top:16px">
      <button class="yc-button yc-button--sm" data-min="5">5 min</button>
      <button class="yc-button yc-button--sm" data-min="15">15 min</button>
      <button class="yc-button yc-button--sm yc-pill--on" data-min="25">25 min</button>
      <button class="yc-button yc-button--sm" data-min="50">50 min</button>
    </div>
    <div class="yc-row yc-row--end" style="margin-top:16px">
      <button class="yc-button yc-button--ghost" id="reset">Reset</button>
      <button class="yc-button yc-button--primary" id="go">Start</button>
    </div>
  </div>
  <div class="yc-card yc-card--inset yc-stack" style="gap:6px">
    <div class="yc-eyebrow">Today</div>
    <div class="yc-row"><span class="yc-title" id="done">0</span><span class="yc-muted">sessions finished</span></div>
  </div>
</div>
<script>
  var total = 25*60, left = total, running = false, tick = null, done = 0;
  var clock = document.getElementById('clock'), ring = document.getElementById('ring'), go = document.getElementById('go'), st = document.getElementById('state');
  function fmt(s){ var m = Math.floor(s/60), r = s%60; return (m<10?'0':'')+m+':'+(r<10?'0':'')+r; }
  function paint(){ clock.textContent = fmt(left); ring.style.setProperty('--pct', (100*(1-left/total))+'%'); }
  function stop(){ running=false; clearInterval(tick); go.textContent='Start'; st.textContent = left===total ? 'Ready' : 'Paused'; }
  go.onclick = function(){
    if (running) return stop();
    running = true; go.textContent = 'Pause'; st.textContent = 'Running';
    tick = setInterval(function(){ left--; if (left<=0){ left=0; paint(); stop(); done++; document.getElementById('done').textContent=done; st.textContent='Finished'; left=total; return; } paint(); }, 1000);
  };
  document.getElementById('reset').onclick = function(){ stop(); left = total; paint(); st.textContent='Ready'; };
  document.querySelectorAll('[data-min]').forEach(function(b){ b.onclick = function(){
    document.querySelectorAll('[data-min]').forEach(function(x){ x.classList.remove('yc-pill--on'); }); b.classList.add('yc-pill--on');
    stop(); total = left = parseInt(b.dataset.min,10)*60; paint(); st.textContent='Ready';
  }; });
  paint();
</script>
</body></html>`;

// A week at a glance: seven columns, events with a category colour, an
// add-event form, and week navigation. Dates are fixed so the review is
// reproducible; "today" is Wednesday of the shown week.
const PLANNER_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Week planner</title>
<style>
  .week { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 8px; }
  .day { background: var(--panel); border: 1px solid var(--edge); border-radius: var(--radius-lg, 12px); padding: 10px; min-height: 380px; display: flex; flex-direction: column; gap: 8px; }
  .day--today { border-color: var(--accent); box-shadow: inset 0 3px 0 var(--accent); }
  .day h3 { display: flex; justify-content: space-between; align-items: baseline; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--fg-muted); font-weight: 500; }
  .day h3 b { font-size: 18px; color: var(--fg); font-weight: 600; letter-spacing: 0; }
  .ev { border-radius: var(--radius-md, 8px); background: var(--inset); border: 1px solid var(--edge-dim); border-left: 3px solid var(--c); padding: 6px 8px; font-size: 12px; cursor: pointer; }
  .ev:hover { border-color: var(--edge); }
  .ev time { display: block; font-size: 11px; color: var(--fg-muted); font-family: var(--font-mono); }
  .ev.done { opacity: .5; text-decoration: line-through; }
  .add { display: none; grid-template-columns: 1.4fr .8fr .8fr 1fr auto; gap: 8px; align-items: end; }
  .add.open { display: grid; }
  .legend { display: flex; gap: 14px; flex-wrap: wrap; }
  .stat { display: flex; flex-direction: column; gap: 2px; }
  .stat b { font-size: 22px; font-weight: 600; line-height: 1; }
</style></head>
<body>
<div class="yc-page yc-stack">
  <div class="yc-row yc-row--between">
    <div><div class="yc-eyebrow">Personal</div><h1 id="title">Week of 14 September</h1></div>
    <div class="yc-row">
      <button class="yc-button yc-button--ghost" id="prev" aria-label="Previous week">‹</button>
      <button class="yc-button" id="today">Today</button>
      <button class="yc-button yc-button--ghost" id="next" aria-label="Next week">›</button>
      <button class="yc-button yc-button--primary" id="addbtn">Add event</button>
    </div>
  </div>
  <form class="yc-card add" id="add">
    <div><label class="yc-label">What</label><input class="yc-input" id="f-title" placeholder="Dentist, standup, gym…" required></div>
    <div><label class="yc-label">Day</label><select class="yc-select" id="f-day"></select></div>
    <div><label class="yc-label">Time</label><input class="yc-input" id="f-time" type="time" value="09:00"></div>
    <div><label class="yc-label">Kind</label><select class="yc-select" id="f-kind"><option value="work">Work</option><option value="home">Home</option><option value="health">Health</option><option value="social">Social</option></select></div>
    <div class="yc-row"><button type="button" class="yc-button yc-button--ghost" id="cancel">Cancel</button><button type="submit" class="yc-button yc-button--primary">Save</button></div>
  </form>
  <div class="week" id="week"></div>
  <div class="yc-card yc-row yc-row--between">
    <div class="legend">
      <span class="yc-badge" style="--badge:#3070d6">Work</span>
      <span class="yc-badge" style="--badge:#2f9e5b">Home</span>
      <span class="yc-badge" style="--badge:#d63a3a">Health</span>
      <span class="yc-badge" style="--badge:#8c4fd0">Social</span>
    </div>
    <div class="yc-row" style="gap:24px">
      <div class="stat"><b id="n-events">0</b><span class="yc-caption">events this week</span></div>
      <div class="stat"><b id="n-done">0</b><span class="yc-caption">done</span></div>
      <div class="stat"><b id="n-left">0</b><span class="yc-caption">still to do</span></div>
    </div>
  </div>
</div>
<script>
  var COLORS = { work:'#3070d6', home:'#2f9e5b', health:'#d63a3a', social:'#8c4fd0' };
  var DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  var MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  var base = new Date(2026, 8, 14); // Monday 14 Sep 2026
  var todayIdx = 2; // Wednesday
  var offset = 0;
  var events = {
    0: [ { t:'09:30', n:'Team standup', k:'work' }, { t:'12:30', n:'Lunch with Sam', k:'social' }, { t:'18:00', n:'Gym', k:'health' } ],
    1: [ { t:'10:00', n:'Design review', k:'work' }, { t:'19:30', n:'Cook for the week', k:'home' } ],
    2: [ { t:'08:15', n:'Dentist', k:'health', done:true }, { t:'11:00', n:'Sprint planning', k:'work' }, { t:'15:00', n:'Call the landlord', k:'home' }, { t:'18:30', n:'Board games night', k:'social' } ],
    3: [ { t:'09:00', n:'Deep work block', k:'work' }, { t:'17:30', n:'Run', k:'health' } ],
    4: [ { t:'13:00', n:'Ship the release', k:'work' }, { t:'20:00', n:'Movie', k:'social' } ],
    5: [ { t:'10:00', n:'Farmers market', k:'home' } ],
    6: [ { t:'11:00', n:'Brunch', k:'social' }, { t:'16:00', n:'Plan next week', k:'home' } ]
  };
  var week = document.getElementById('week'), form = document.getElementById('add');
  DAYS.forEach(function(d,i){ var o=document.createElement('option'); o.value=i; o.textContent=d; document.getElementById('f-day').appendChild(o); });
  function dayDate(i){ var d = new Date(base); d.setDate(base.getDate() + offset*7 + i); return d; }
  function render(){
    var first = dayDate(0);
    document.getElementById('title').textContent = 'Week of ' + first.getDate() + ' ' + MONTHS[first.getMonth()];
    week.innerHTML = '';
    var total=0, done=0;
    for (var i=0;i<7;i++){
      var col = document.createElement('div'); col.className = 'day' + (offset===0 && i===todayIdx ? ' day--today' : '');
      var d = dayDate(i);
      col.innerHTML = '<h3><span>'+DAYS[i]+'</span><b>'+d.getDate()+'</b></h3>';
      var list = offset===0 ? (events[i]||[]) : [];
      list.slice().sort(function(a,b){ return a.t<b.t?-1:1; }).forEach(function(e){
        total++; if (e.done) done++;
        var el = document.createElement('div'); el.className = 'ev' + (e.done?' done':''); el.style.setProperty('--c', COLORS[e.k]);
        el.innerHTML = '<time>'+e.t+'</time>'+e.n.replace(/</g,'&lt;');
        el.title = e.done ? 'Mark as not done' : 'Mark as done';
        el.onclick = function(){ e.done = !e.done; render(); };
        col.appendChild(el);
      });
      if (!list.length) { var em = document.createElement('div'); em.className='yc-caption'; em.textContent = 'Nothing planned'; col.appendChild(em); }
      week.appendChild(col);
    }
    document.getElementById('n-events').textContent = total;
    document.getElementById('n-done').textContent = done;
    document.getElementById('n-left').textContent = total - done;
  }
  document.getElementById('prev').onclick = function(){ offset--; render(); };
  document.getElementById('next').onclick = function(){ offset++; render(); };
  document.getElementById('today').onclick = function(){ offset = 0; render(); };
  document.getElementById('addbtn').onclick = function(){ form.classList.toggle('open'); if (form.classList.contains('open')) document.getElementById('f-title').focus(); };
  document.getElementById('cancel').onclick = function(){ form.classList.remove('open'); form.reset(); };
  form.onsubmit = function(ev){
    ev.preventDefault();
    var i = +document.getElementById('f-day').value;
    (events[i] = events[i] || []).push({ t: document.getElementById('f-time').value || '09:00', n: document.getElementById('f-title').value.trim() || 'Untitled', k: document.getElementById('f-kind').value });
    offset = 0; form.classList.remove('open'); form.reset(); render();
  };
  render();
</script>
</body></html>`;

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
  var ops = [], redo = [], cur = null;
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
  c.onpointerup = c.onpointercancel = function(){ if(!cur) return; ops.push(cur); redo = []; cur = null; px.clearRect(0,0,p.width,p.height); redraw(); };
  document.getElementById('undo').onclick = function(){ if (ops.length) { redo.push(ops.pop()); redraw(); } };
  document.getElementById('redo').onclick = function(){ if (redo.length) { ops.push(redo.pop()); redraw(); } };
  document.getElementById('clear').onclick = function(){ if (!ops.length) return; redo = ops.slice().reverse(); ops = []; redraw(); };
  document.getElementById('save').onclick = function(){ var b = document.getElementById('save'); b.textContent = 'Saved'; setTimeout(function(){ b.textContent = 'Save as picture'; }, 1200); };
  window.addEventListener('keydown', function(e){
    if (e.target.tagName === 'INPUT') return;
    if ((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='z') { e.preventDefault(); (e.shiftKey ? document.getElementById('redo') : document.getElementById('undo')).click(); return; }
    var k = { b:'brush', e:'eraser', l:'line', r:'rect', o:'ellipse' }[e.key.toLowerCase()]; if (k) setTool(k);
  });
  // A little something on the paper so the studio does not open blank.
  ops = [
    { t:'brush', c:'#3070d6', w:10, a:1, p:[[180,420],[220,300],[300,240],[400,260],[470,340],[520,440]] },
    { t:'ellipse', c:'#e5a13a', w:8, a:1, p:[[560,140],[700,280]] },
    { t:'rect', c:'#2f9e5b', w:6, a:.8, p:[[760,380],[960,520]] },
    { t:'line', c:'#d63a3a', w:4, a:1, p:[[140,600],[980,600]] }
  ];
  window.onresize = fit; dot(); fit();
</script>
</body></html>`;

export function seedPages(): PageDocument[] {
  return [
    {
      id: 'page-focus-timer',
      name: 'Focus timer',
      description: 'A 25-minute timer with presets and a count of sessions finished today.',
      icon: 'timer',
      home: { kind: 'personal' },
      pinned: true,
      updatedAt: T,
      html: TIMER_HTML,
    },
    {
      id: 'page-week-planner',
      name: 'Week planner',
      description: 'Your week in seven columns: events by kind, done or still to do, and a quick add.',
      icon: 'calendar',
      home: { kind: 'personal' },
      pinned: false,
      updatedAt: '2026-09-12T09:05:00.000Z',
      html: PLANNER_HTML,
    },
    {
      id: 'page-paint',
      name: 'Paint studio',
      description: 'Brush, eraser and shapes, a palette with custom colours, size and opacity, undo and redo.',
      icon: 'paint',
      home: { kind: 'project', path: '/home/destin/youcoded-dev/youcoded', name: 'youcoded' },
      pinned: true,
      updatedAt: '2026-09-10T21:40:00.000Z',
      html: PAINT_HTML,
    },
  ];
}
