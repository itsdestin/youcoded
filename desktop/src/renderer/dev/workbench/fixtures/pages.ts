// Workbench fixtures for YouCoded Pages (Phase 1 shell). Three pages that
// need nothing from outside their frame — exactly what Phase 1 allows — so the
// library, the pinned buttons and the host can be reviewed with no backend.
//
// Each page is written against the style kit's classes (page-kit.ts) and the
// tokens page-theme.ts delivers, and each keeps a little working state (a
// running timer, typed notes, strokes on a canvas) so a theme switch can be
// SEEN to preserve it: switch themes with the timer running and it keeps
// counting.
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

const NOTES_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Notes board</title>
<style>
  .board { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
  .note { min-height: 140px; display: flex; flex-direction: column; gap: 8px; }
  .note textarea { flex: 1; min-height: 80px; resize: none; }
  .note .yc-row { justify-content: space-between; }
</style></head>
<body>
<div class="yc-page yc-stack">
  <div class="yc-row yc-row--between">
    <div><div class="yc-eyebrow">Personal</div><h1>Notes board</h1></div>
    <button class="yc-button yc-button--primary" id="add">New note</button>
  </div>
  <div class="board" id="board"></div>
</div>
<script>
  var notes = [
    { t: 'Groceries', b: 'Oat milk\\nCoffee beans\\nLimes' },
    { t: 'Call back', b: 'Dentist about Thursday\\nLandlord re: heater' },
    { t: 'Ideas', b: 'A page that shows the week at a glance' }
  ];
  var board = document.getElementById('board');
  function render(){
    board.innerHTML = '';
    notes.forEach(function(n, i){
      var c = document.createElement('div'); c.className = 'yc-card note';
      c.innerHTML = '<input class="yc-input" value="'+n.t.replace(/"/g,'&quot;')+'" placeholder="Title">'
        + '<textarea class="yc-textarea" placeholder="Write here">'+n.b.replace(/</g,'&lt;')+'</textarea>'
        + '<div class="yc-row"><span class="yc-caption">Note '+(i+1)+'</span><button class="yc-button yc-button--ghost yc-button--sm">Remove</button></div>';
      c.querySelector('input').oninput = function(e){ n.t = e.target.value; };
      c.querySelector('textarea').oninput = function(e){ n.b = e.target.value; };
      c.querySelector('button').onclick = function(){ notes.splice(i,1); render(); };
      board.appendChild(c);
    });
  }
  document.getElementById('add').onclick = function(){ notes.unshift({ t: '', b: '' }); render(); board.querySelector('input').focus(); };
  render();
</script>
</body></html>`;

const PAINT_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Paint</title>
<style>
  html, body { height: 100%; overflow: hidden; }
  .wrap { height: 100%; display: flex; flex-direction: column; }
  .bar { padding: 10px 16px; border-bottom: 1px solid var(--edge); background: var(--panel); }
  canvas { flex: 1; width: 100%; display: block; background: #ffffff; cursor: crosshair; touch-action: none; }
  .sw { width: 22px; height: 22px; border-radius: 50%; border: 2px solid var(--edge); cursor: pointer; }
  .sw.on { border-color: var(--fg); box-shadow: 0 0 0 2px var(--panel), 0 0 0 3px var(--fg); }
</style></head>
<body>
<div class="wrap">
  <div class="bar yc-row">
    <span class="yc-eyebrow">Paint</span>
    <span class="yc-spacer"></span>
    <span class="sw on" style="background:#1d1d1d" data-c="#1d1d1d"></span>
    <span class="sw" style="background:#d63a3a" data-c="#d63a3a"></span>
    <span class="sw" style="background:#e5a13a" data-c="#e5a13a"></span>
    <span class="sw" style="background:#2f9e5b" data-c="#2f9e5b"></span>
    <span class="sw" style="background:#3070d6" data-c="#3070d6"></span>
    <span class="sw" style="background:#8c4fd0" data-c="#8c4fd0"></span>
    <span class="yc-spacer"></span>
    <label class="yc-caption yc-row">Size <input type="range" min="2" max="24" value="6" id="size"></label>
    <button class="yc-button yc-button--sm" id="clear">Clear</button>
  </div>
  <canvas id="c"></canvas>
</div>
<script>
  var c = document.getElementById('c'), x = c.getContext('2d'), color = '#1d1d1d', size = 6, down = false, strokes = [];
  function fit(){ var r = c.getBoundingClientRect(); c.width = r.width * devicePixelRatio; c.height = r.height * devicePixelRatio; x.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0); redraw(); }
  function redraw(){ x.clearRect(0,0,c.width,c.height); strokes.forEach(function(s){ x.strokeStyle = s.c; x.lineWidth = s.w; x.lineCap = x.lineJoin = 'round'; x.beginPath(); s.p.forEach(function(q,i){ i ? x.lineTo(q[0],q[1]) : x.moveTo(q[0],q[1]); }); x.stroke(); }); }
  function pt(e){ var r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  c.onpointerdown = function(e){ down = true; strokes.push({ c: color, w: size, p: [pt(e)] }); c.setPointerCapture(e.pointerId); };
  c.onpointermove = function(e){ if(!down) return; strokes[strokes.length-1].p.push(pt(e)); redraw(); };
  c.onpointerup = c.onpointercancel = function(){ down = false; };
  document.querySelectorAll('.sw').forEach(function(s){ s.onclick = function(){ document.querySelectorAll('.sw').forEach(function(t){ t.classList.remove('on'); }); s.classList.add('on'); color = s.dataset.c; }; });
  document.getElementById('size').oninput = function(e){ size = +e.target.value; };
  document.getElementById('clear').onclick = function(){ strokes = []; redraw(); };
  window.onresize = fit; fit();
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
      id: 'page-notes-board',
      name: 'Notes board',
      description: 'Sticky notes you can add, edit and remove.',
      icon: 'notes',
      home: { kind: 'personal' },
      pinned: false,
      updatedAt: '2026-09-12T09:05:00.000Z',
      html: NOTES_HTML,
    },
    {
      id: 'page-paint',
      name: 'Paint',
      description: 'A simple canvas with six colours and a brush size.',
      icon: 'paint',
      home: { kind: 'project', path: '/home/destin/youcoded-dev/youcoded', name: 'youcoded' },
      pinned: true,
      updatedAt: '2026-09-10T21:40:00.000Z',
      html: PAINT_HTML,
    },
  ];
}
