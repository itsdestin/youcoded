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
  var saved = (window.youcoded && window.youcoded.data) || {};
  var total = 25*60, left = total, running = false, tick = null, done = saved.done || 0;
  document.getElementById('done').textContent = done;
  function persist(){ if (window.youcoded) window.youcoded.save({ done: done }); }
  var clock = document.getElementById('clock'), ring = document.getElementById('ring'), go = document.getElementById('go'), st = document.getElementById('state');
  function fmt(s){ var m = Math.floor(s/60), r = s%60; return (m<10?'0':'')+m+':'+(r<10?'0':'')+r; }
  function paint(){ clock.textContent = fmt(left); ring.style.setProperty('--pct', (100*(1-left/total))+'%'); }
  function stop(){ running=false; clearInterval(tick); go.textContent='Start'; st.textContent = left===total ? 'Ready' : 'Paused'; }
  go.onclick = function(){
    if (running) return stop();
    running = true; go.textContent = 'Pause'; st.textContent = 'Running';
    tick = setInterval(function(){ left--; if (left<=0){ left=0; paint(); stop(); done++; document.getElementById('done').textContent=done; persist(); st.textContent='Finished'; left=total; return; } paint(); }, 1000);
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
  var saved = (window.youcoded && window.youcoded.data) || null;
  var events = saved && saved.events ? saved.events : {
    0: [ { t:'09:30', n:'Team standup', k:'work' }, { t:'12:30', n:'Lunch with Sam', k:'social' }, { t:'18:00', n:'Gym', k:'health' } ],
    1: [ { t:'10:00', n:'Design review', k:'work' }, { t:'19:30', n:'Cook for the week', k:'home' } ],
    2: [ { t:'08:15', n:'Dentist', k:'health', done:true }, { t:'11:00', n:'Sprint planning', k:'work' }, { t:'15:00', n:'Call the landlord', k:'home' }, { t:'18:30', n:'Board games night', k:'social' } ],
    3: [ { t:'09:00', n:'Deep work block', k:'work' }, { t:'17:30', n:'Run', k:'health' } ],
    4: [ { t:'13:00', n:'Ship the release', k:'work' }, { t:'20:00', n:'Movie', k:'social' } ],
    5: [ { t:'10:00', n:'Farmers market', k:'home' } ],
    6: [ { t:'11:00', n:'Brunch', k:'social' }, { t:'16:00', n:'Plan next week', k:'home' } ]
  };
  function persist(){ if (window.youcoded) window.youcoded.save({ events: events }); }
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
        el.onclick = function(){ e.done = !e.done; persist(); render(); };
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
    offset = 0; form.classList.remove('open'); form.reset(); persist(); render();
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
      ...base, id: 'page-trip-board', name: 'Trip board', icon: 'calendar',
      description: 'Lisbon in October: the forecast for each day beside what is booked.',
      updatedAt: '2026-09-15T11:30:00.000Z', htmlStamp: 1789471800000,
      html: simplePage('Lisbon · 3–9 October', 'Trip board', [['Fri 3', '24° clear · arrive 14:10'], ['Sat 4', '23° clear · Alfama walk'], ['Sun 5', '21° showers · Gulbenkian'], ['Mon 6', '22° cloud · Sintra train 09:41']]),
      connections: [{ id: 'weather', kind: 'key', service: 'OpenWeather', address: 'api.openweathermap.org', access: 'lookup', approved: true, savedKey: true }],
      // The failed state: the page keeps its last good numbers, the band says so.
      refresh: { at: minutesAgo(190), failed: true },
    },
    {
      ...base, id: 'page-weather', name: 'Weather', icon: 'page',
      description: 'Today and the next five days for the places you care about.',
      updatedAt: '2026-09-19T07:10:00.000Z', htmlStamp: 1789801800000,
      html: simplePage('Phoenix', 'Weather', [['Now', '38° clear'], ['Tonight', '29°'], ['Sat', '39° clear'], ['Sun', '37° wind']]),
      // First ask, and a key for this service is already saved: offered, still asks.
      connections: [{ id: 'weather', kind: 'key', service: 'OpenWeather', address: 'api.openweathermap.org', access: 'lookup', approved: false, savedKey: true }],
    },
    {
      ...base, id: 'page-task-board', name: 'Task board', icon: 'list',
      description: 'Your Todoist tasks as a board you can drag between columns.',
      updatedAt: '2026-09-19T06:40:00.000Z', htmlStamp: 1789800000000,
      html: simplePage('Todoist', 'Task board', [['Draft fiscal note', 'Today'], ['Reply to Sarah', 'Today'], ['Renew domain', 'Mon']]),
      // First ask, fresh key, FULL access: the blunter sentence and the key box.
      connections: [{ id: 'todoist', kind: 'key', service: 'Todoist', address: 'api.todoist.com', access: 'full', approved: false, savedKey: false,
        keyHelp: { steps: ['Open todoist.com and sign in.', 'Go to Settings, then Integrations, then Developer.', 'Copy the API token and paste it below.'] } }],
    },
    {
      ...base, id: 'page-headlines', name: 'Headlines', icon: 'notes',
      description: 'A front page built from the feeds you follow.',
      updatedAt: '2026-09-19T05:00:00.000Z', htmlStamp: 1789794000000,
      html: simplePage('This morning', 'Headlines', [['BBC News', '12 stories'], ['Hacker News', '30 stories']]),
      // An edit added a second feed: one line approved, one New.
      connections: [
        { id: 'bbc', kind: 'public', address: 'feeds.bbci.co.uk', approved: true },
        { id: 'hn', kind: 'public', address: 'hnrss.org', approved: false },
      ],
      refresh: { at: minutesAgo(12), failed: false },
    },
    {
      ...base, id: 'page-link-reader', name: 'Link reader', icon: 'page',
      description: 'Paste any link and read the article without the clutter.',
      updatedAt: '2026-09-18T20:15:00.000Z', htmlStamp: 1789762500000,
      html: simplePage('Reader', 'Link reader', [['Paste a link to begin', '']]),
      // The whole internet: its own blunt approval, alone on the page.
      connections: [{ id: 'open', kind: 'open', approved: false }],
    },
    {
      ...base, id: 'page-release-board', name: 'Release board', icon: 'list',
      home: { kind: 'project', path: '/home/destin/youcoded-dev/youcoded', name: 'youcoded' },
      description: 'Open pull requests and the checks on each, for this project.',
      updatedAt: '2026-09-17T13:00:00.000Z', htmlStamp: 1789650000000,
      html: simplePage('itsdestin/youcoded', 'Release board', [['#541 Pages connections', 'checks running'], ['#538 Project files', 'ready']]),
      connections: [{ id: 'gh', kind: 'github', access: 'lookup', approved: true }],
      refresh: { at: minutesAgo(1), failed: false },
      // Rewritten since it was allowed: the band shows the quiet note.
      codeChanged: true,
    },
  ];
}

// WHY: this is a deliberately hand-authored, inert planning-page mockup in the
// workbench fixture set; it uses the real PageHost without reading or writing files.
const MASTER_PLAN_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>YouCoded plan</title>
<style>
  /* WHY: one reading surface, separated rows and a small attention rail make the
     overview scan like a plan rather than a stack of nested dashboard boxes. */
  .plan { max-width:1200px; margin:auto; padding:32px; display:grid; gap:28px; }
  .hero { display:flex; justify-content:space-between; gap:24px; align-items:start; padding-bottom:24px; border-bottom:1px solid var(--edge); }
  .hero p { max-width:760px; margin-top:8px; }
  .layout { display:grid; grid-template-columns:180px minmax(0,1fr); gap:32px; }
  .nav { display:grid; align-content:start; gap:8px; }
  .nav .yc-button { justify-content:start; padding:12px; }
  button[aria-current=true] { background:var(--accent); color:var(--on-accent); }
  .overview { display:grid; grid-template-columns:minmax(0,2fr) minmax(230px,1fr); gap:28px; }
  .item { padding:16px 0; border-bottom:1px solid var(--edge-dim); display:grid; gap:8px; }
  .item:first-child { padding-top:0; }
  .item:last-child { border-bottom:0; }
  .muted { color:var(--fg-muted); } .row { display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
  .between { justify-content:space-between; }
  .pill { background:var(--inset); border-radius:var(--radius-sm); padding:4px 8px; font-size:12px; white-space:nowrap; }
  .summary { display:flex; gap:24px; padding:16px 0 24px; }
  .summary strong { display:block; font-size:18px; font-weight:600; }
  .rail { border-left:1px solid var(--edge); padding-left:24px; }
  #content { display:grid; align-content:start; gap:16px; }
  .fields { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
  .fields .wide { grid-column:1/-1; } .fields label { display:grid; gap:6px; }
  .diff { display:grid; grid-template-columns:1fr 1fr; gap:24px; padding:16px 0; border-block:1px solid var(--edge); }
  .diff ul { padding-left:20px; display:grid; gap:12px; }
  .yc-button:active { background:var(--edge); }
  @media(max-width:640px){.plan{padding:16px}.layout,.overview,.fields,.diff{grid-template-columns:1fr}.nav{grid-template-columns:repeat(2,1fr)}.hero{display:block}.rail{border-left:0;padding-left:0}.summary{gap:16px}}
</style></head><body><main class="plan">
<section class="hero"><div><div class="yc-eyebrow">YOUCODED · PRIVATE PLANNING</div><h1>Build an open computing environment</h1><p>Portable, user-owned tools with provider choice and community-built alternatives.</p></div><button id="editVision">Edit vision</button></section>
<div class="layout"><nav class="nav" aria-label="Plan sections"><button aria-current="true" data-tab="work">Active work</button><button data-tab="vision">Vision</button><button data-tab="history">Sources & history</button><button data-tab="public">Public changes</button><button data-tab="access">Folder access</button></nav>
<section id="content"><div class="row between"><h2>Active work</h2><button class="yc-button" data-action="edit-item">Edit item</button></div>
<div class="summary"><div><strong>2</strong><span class="yc-caption">in progress</span></div><div><strong>1</strong><span class="yc-caption">needs a decision</span></div><div><strong>2</strong><span class="yc-caption">ready to start</span></div></div>
<div class="overview"><div><div class="yc-eyebrow">Now · keep moving</div>
<article class="item"><div class="row between"><h3>Pages foundation</h3><span class="pill">Building</span></div><p>Connect personal Pages with reusable tools and scoped file access.</p><p class="muted">Next: review the folder approval flow.</p><div class="row yc-small"><span>Owner: Maya</span><span class="muted">Updated 6 Oct</span><button class="yc-button yc-button--ghost" data-tab="history">Sources & reports</button></div></article>
<article class="item"><div class="row between"><h3>Portable workspace</h3><span class="pill">In review</span></div><p>Bring your conversations, files and preferences to another device.</p><p class="muted">Next: check restore behavior on a second computer.</p><div class="row yc-small"><span>Owner: Leo</span><span class="muted">Updated 5 Oct</span></div></article>
<div class="yc-eyebrow" style="margin-top:24px">Next · ready to start</div>
<article class="item"><div class="row between"><h3>Community reports</h3><span class="pill">Planned</span></div><p>Link user reports to the work they inform. Discussion stays in GitHub Issues.</p></article>
<article class="item"><div class="row between"><h3>Reusable agent tools</h3><span class="pill">Planned</span></div><p>Share small, composable tools across Pages and assistant tasks.</p></article></div>
<aside class="rail yc-stack"><div class="yc-eyebrow">Needs your attention</div><h3>Where should device work run?</h3><p>Device mesh needs a host-selection decision before it can be scheduled.</p><button class="yc-button" data-tab="vision">Review direction</button><hr class="yc-divider"><div class="yc-eyebrow">Recent progress</div><h3>Workspace export</h3><span class="pill">Merged · 5 Oct</span><p class="muted">Export includes preferences and linked files.</p><h3>Search shortcuts</h3><span class="pill">Released · 3 Oct</span><p class="muted">Available in the latest desktop release.</p><button class="yc-button yc-button--ghost" data-tab="history">View history</button></aside></div></section></div>
<script>
const c=document.getElementById('content'); let selected='work';
const sections={work:c.innerHTML,
vision:'<h2>Vision</h2><p>A user-owned, open-source computing environment. Choose providers, run local models, keep portable data and make tools your own.</p><article class="item"><div class="yc-eyebrow">Foundation</div><h3>Build once, reuse everywhere</h3><p>Customizable Pages and reusable agent tools share the same runtime. Community-built alternatives can be remixed without giving up ownership.</p></article><article class="item"><div class="yc-eyebrow">Open decision</div><h3>Device mesh</h3><p>Choose where work runs when more than one computer is available. Offline behavior and host selection need a decision before scheduling.</p><p class="muted">Source: Device mesh direction · Maya · 4 Oct 2026</p></article>',
history:'<h2>Sources & history</h2><p class="muted">Pages foundation · private planning record</p><article class="item"><div class="row between"><h3>Folder approval flow ready for review</h3><span class="pill">Build report</span></div><p>6 Oct 2026, 09:40 · Maya · Pages foundation report</p><p>Read and write are separate choices. The review includes a changed-host case and revoking access.</p><button class="yc-button" data-action="doc">Read build report</button></article><article class="item"><h3>Added scoped folder access</h3><p>5 Oct 2026, 15:20 · Leo · Pages phasing plan</p><p>Updated the milestone and linked the approval-flow design.</p><button class="yc-button" data-action="doc">Open source plan</button></article><article class="item"><h3>Folder choice is hard to find</h3><p>4 Oct 2026, 11:10 · Nina · GitHub issue #42</p><p>Community report · Open. Discussion and open/closed state stay in GitHub Issues.</p><button class="yc-button" data-action="issue">Read issue</button></article><article class="item"><h3>Keep planning notes private</h3><p>3 Oct 2026, 16:05 · Maya · Private conversation</p><p>Only approved public summaries are shared. Requests never become public issues automatically.</p></article><p id="feedback" aria-live="polite"></p>',
public:'<h2>Review public update</h2><p>Only these summary changes will appear in the read-only public view. Private notes and source documents stay private.</p><div class="row"><span class="pill">3 changes</span><span class="muted">Last approved 3 Oct · prepared by Maya, 6 Oct</span></div><div class="diff"><div><div class="yc-eyebrow">Published now</div><ul><li>Next: reusable agent tools</li><li>Community reports: 8 open</li><li>Milestone: planning overview</li></ul></div><div><div class="yc-eyebrow">Proposed update</div><ul><li>Next: Pages folder approval review</li><li>Community reports: 9 open</li><li>Milestone: scoped file access</li></ul></div></div><p class="muted">Every update needs your approval. Editing the private plan does not publish it.</p><div class="row"><button class="yc-button yc-button--primary" data-action="approve">Approve this update</button><button class="yc-button" data-action="reject">Keep current public view</button></div><p id="feedback" aria-live="polite"></p>',
access:'<h2>Folder access</h2><p>Access is limited to this Page, this folder and this computer.</p><article class="item"><div class="row between"><h3>Documents / Planning</h3><span class="pill">Remembered</span></div><p>Host: Studio laptop · YouCoded</p><p>Read files: allowed · Write files: allowed</p><p class="muted">Granted by Maya · 5 Oct 2026. Other folders are not included.</p><button class="yc-button yc-button--danger" data-action="revoke">Revoke access</button></article><article class="item"><h3>Choose another folder</h3><p>Host: Studio laptop · YouCoded</p><div class="row"><label><input id="readGrant" type="checkbox" checked> Read files</label><label><input id="writeGrant" type="checkbox"> Write files</label></div><button class="yc-button" data-action="grant">Choose folder…</button></article><article class="item"><div class="yc-eyebrow">Network · separate permission</div><h3>api.github.com</h3><p>Read issue titles and status. No GitHub writes.</p><p class="muted">Not approved. Folder access does not allow network requests.</p><button class="yc-button" data-action="network">Review network access</button></article><p id="feedback" aria-live="polite"></p>',
edit:'<h2>Edit work item</h2><p class="muted">Pages foundation · detailed plans remain linked documents</p><form id="itemForm" class="fields"><label class="wide">Title<input class="yc-input" name="title" value="Pages foundation" required></label><label>Status<select class="yc-select" name="status"><option>Building</option><option>In review</option><option>Planned</option><option>Merged</option><option>Released</option></select></label><label>Timing<select class="yc-select" name="timing"><option>Now</option><option>Next</option><option>Later</option></select></label><label>Owner<input class="yc-input" name="owner" value="Maya"></label><label>Source document<input class="yc-input" name="source" value="Pages phasing plan"></label><label class="wide">Next step<textarea class="yc-textarea" name="next">Review the folder approval flow.</textarea></label><div class="row wide"><button class="yc-button yc-button--primary" type="submit">Save draft</button><button class="yc-button" type="button" data-action="cancel">Cancel</button></div></form><p id="feedback" aria-live="polite"></p>',
exceptions:'<h2>Changes need review</h2><article class="item"><h3>Host changed</h3><p>The folder grant belongs to Studio laptop, not Travel laptop. Review access on this computer before using the folder.</p><button class="yc-button" data-tab="access">Review this computer</button></article><article class="item"><h3>Source history unavailable</h3><p>The Pages report could not be loaded.</p><button class="yc-button" data-action="retry">Retry</button></article><article class="item"><h3>Draft changed elsewhere</h3><p>Saved next step: Check folder revocation. Your draft: Review the folder approval flow.</p><button class="yc-button" data-action="conflict">Compare versions</button></article><p id="feedback" aria-live="polite"></p>'};
function paint(){c.innerHTML=sections[selected];document.querySelectorAll('.nav [data-tab]').forEach(b=>b.setAttribute('aria-current',String(b.dataset.tab===selected)));}
function openSection(tab){if(sections[tab]){selected=tab;paint();}}
document.querySelectorAll('.nav button').forEach(b=>{b.classList.add('yc-button');b.onclick=()=>openSection(b.dataset.tab)});
document.getElementById('editVision').classList.add('yc-button');
document.getElementById('editVision').onclick=()=>{openSection('vision');c.innerHTML='<h2>Edit vision fields</h2><form id="visionForm" class="yc-stack"><label for="purpose">Purpose</label><textarea id="purpose" class="yc-textarea">Portable, user-owned tools with provider choice and community-built alternatives.</textarea><p class="muted">Detailed plans remain linked documents.</p><div class="row"><button class="yc-button yc-button--primary" type="submit">Save draft</button><button class="yc-button" type="button" data-action="cancel">Cancel</button></div></form><p id="feedback" aria-live="polite"></p>'};
// WHY: edits and approval states live only in this frame. No save/fetch bridge,
// file grant, publication or GitHub write is invoked by the design fixture.
c.addEventListener('submit',e=>{e.preventDefault();if(e.target.id==='itemForm'){const data=new FormData(e.target);const temp=document.createElement('div');temp.innerHTML=sections.work;const item=temp.querySelector('.item');item.querySelector('h3').textContent=data.get('title');item.querySelector('.pill').textContent=data.get('status');item.querySelector('p.muted').textContent='Next: '+data.get('next');item.querySelector('.row.yc-small span').textContent='Owner: '+data.get('owner');sections.work=temp.innerHTML;const form=e.target;form.querySelectorAll('input').forEach(x=>x.setAttribute('value',x.value));form.querySelectorAll('textarea').forEach(x=>x.textContent=x.value);form.querySelectorAll('option').forEach(x=>{if(x.selected)x.setAttribute('selected','');else x.removeAttribute('selected');});sections.edit=c.innerHTML;openSection('work');const note=document.createElement('p');note.setAttribute('role','status');note.textContent='Draft saved. Public view unchanged.';c.prepend(note);}else{sections.vision='<h2>Vision</h2>';const p=document.createElement('p');p.textContent=document.getElementById('purpose').value;sections.vision+=p.outerHTML;openSection('vision');}});
c.addEventListener('click',e=>{const tab=e.target.closest('[data-tab]');if(tab){openSection(tab.dataset.tab);return;}const b=e.target.closest('[data-action]');if(!b)return;const f=document.getElementById('feedback');const a=b.dataset.action;
if(a==='edit-item'){openSection('edit');return;}
if(a==='cancel'){openSection(selected==='edit'?'work':'vision');return;}
if(a==='revoke'){b.closest('.item').innerHTML='<h3>Access revoked</h3><p>Documents / Planning is no longer available to this Page.</p>';sections.access=c.innerHTML;return;}
if(!f)return;
if(a==='approve')f.innerHTML='<p>Approve the 3 summary changes shown above? Private documents are excluded.</p><div class="row"><button class="yc-button" data-action="confirm-approval">Confirm approval</button><button class="yc-button" data-action="cancel-approval">Cancel</button></div>';
else if(a==='confirm-approval'){f.textContent='Update approved.';c.querySelector('[data-action="approve"]').remove();sections.public=c.innerHTML;}
else if(a==='cancel-approval'||a==='reject')f.textContent='Public view unchanged.';
else if(a==='grant'){const read=document.getElementById('readGrant').checked,write=document.getElementById('writeGrant').checked;f.dataset.read=String(read);f.dataset.write=String(write);f.innerHTML='<h3>Grant Documents / Planning?</h3><p>Studio laptop · this Page only · Read: '+(read?'allowed':'not allowed')+' · Write: '+(write?'allowed':'not allowed')+'</p><p>No network access is included.</p><div class="row"><button class="yc-button" data-action="confirm-grant">Grant this folder</button><button class="yc-button" data-action="cancel-grant">Cancel</button></div>';}
else if(a==='confirm-grant'){c.querySelector('.item').innerHTML='<h3>Documents / Planning</h3><p>Host: Studio laptop · YouCoded</p><p>Read files: '+(f.dataset.read==='true'?'allowed':'not allowed')+' · Write files: '+(f.dataset.write==='true'?'allowed':'not allowed')+'</p><p class="muted">Remembered for this Page only. Other folders are not included.</p><button class="yc-button yc-button--danger" data-action="revoke">Revoke access</button>';f.textContent='Folder access remembered for this Page on Studio laptop.';sections.access=c.innerHTML;}
else if(a==='cancel-grant')f.textContent='No access granted.';
else if(a==='network')f.innerHTML='<h3>Allow reads from api.github.com?</h3><p>Issue titles and status only. No GitHub writes or other hosts.</p><button class="yc-button" data-action="allow-network">Allow reads</button>';
else if(a==='allow-network'){c.querySelector('[data-action="network"]').previousElementSibling.textContent='Approved for issue reads only. No file access or GitHub writes.';f.textContent='Network reads approved for api.github.com.';sections.access=c.innerHTML;}
else if(a==='retry')f.textContent='Source history is still unavailable. Try again later.';
else if(a==='conflict')f.innerHTML='<h3>Choose a next step</h3><p>Your draft: Review the folder approval flow.</p><p>Saved version: Check folder revocation.</p><button class="yc-button" data-action="keep-local">Keep my draft</button> <button class="yc-button" data-action="use-saved">Use saved version</button>';
else if(a==='keep-local'||a==='use-saved')f.textContent=a==='keep-local'?'Your draft was kept.':'Saved next step selected.';
else if(a==='doc'||a==='issue'){const source=b.closest('.item').cloneNode(true);source.querySelectorAll('button').forEach(x=>x.remove());f.replaceChildren(source);}});
const initial=(window.youcoded&&window.youcoded.data&&window.youcoded.data.planView)||'work';openSection(initial);
</script></main></body></html>`;

export function seedPages(): PageDocument[] {
  return [
    ...connectedPages(),
    { id: 'page-master-plan', name: 'YouCoded plan', icon: 'notes', home: { kind: 'personal' }, pinned: true,
      description: 'Active work, vision and source-linked planning.', updatedAt: '2026-10-06T10:00:00.000Z', htmlStamp: 1791280800000, html: MASTER_PLAN_HTML,
      // WHY: named photos select actual subviews through page data, without
      // opening the sandbox or adding production navigation/testing hooks.
      data: { planView: typeof location === 'undefined' ? 'work' : new URLSearchParams(location.search).get('planView') ?? 'work' } },
    {
      id: 'page-focus-timer',
      name: 'Focus timer',
      description: 'A 25-minute timer with presets and a count of sessions finished today.',
      icon: 'timer',
      home: { kind: 'personal' },
      pinned: true,
      updatedAt: T,
      htmlStamp: 1789450800000,
      html: TIMER_HTML,
      data: null,
    },
    {
      id: 'page-week-planner',
      name: 'Week planner',
      description: 'Your week in seven columns: events by kind, done or still to do, and a quick add.',
      icon: 'calendar',
      home: { kind: 'personal' },
      pinned: false,
      updatedAt: '2026-09-12T09:05:00.000Z',
      htmlStamp: 1789200300000,
      html: PLANNER_HTML,
      data: null,
    },
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
