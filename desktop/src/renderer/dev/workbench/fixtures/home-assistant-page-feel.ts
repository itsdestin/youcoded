// How the Home page answers a press and shows a change (redesign round 1, motion-state c,
// "Spread and spring", picked by Destin 2026-10-04 and CALMED after his notes: no spin on
// play/pause, smaller movements, nothing that delays the visible result of a press).
//
// THE RULES that keep it safe with live updates and the in-place drawing
// (home-assistant-page-redraw.ts keeps the same elements across redraws):
//  1. The RESULT of a press is on screen in the same frame (the page already redraws inside the
//     click). Everything here is polish layered on top and starts from nearly the final look
//     (a bulb from 90% size, a glow from 60%), so it can never make a press feel late.
//  2. Full motion plays only for a card the person just pressed (the capture-phase listeners
//     below remember it for 2.5 s). A change that arrives by itself (a wall switch, an
//     automation, a push, a check) gets ONE quiet cue instead: a soft shine across the card.
//  3. Only transform and opacity are animated; endless animation uses steps(); reduced-motion,
//     a hidden page and the practice-only window.__feelOff switch all turn it off.
// HOME_FEEL_JS is pasted INSIDE the page's script (shares $, thing, etc.); feelAfter(id) is
// called by put() after each drawing. Template string: no backticks, no dollar-brace, no
// backslashes.

export const HOME_FEEL_CSS = `
  /* Light spreads from the card's top-left corner (where the look's glow is brightest). */
  .tile > .glow, .lights > .glow, .clim > .glow { transform-origin: 0 0; }
  /* Dragging brightness: the glow follows the slider (--b is set while dragging, 0..1). */
  .tile.on > .glow { opacity: calc(.14 + var(--b, .6) * .26); }
  /* Muting dims the volume bar softly instead of snapping. */
  @media (prefers-reduced-motion: no-preference) { :root:not([data-feel-off]) .tile .vlr { transition: opacity 160ms ease; } }
  /* The sending / done / didn't work note: it must never catch a press meant for the control
     under it (it sat over the volume +), so it is see-through to the pointer unless it holds
     buttons. Smaller and quieter, a pill that fades up (feelAfter plays it). */
  .pend { pointer-events: none; font-size: 10px; line-height: 1.2; padding: 2px 8px; bottom: 5px; }
  .pend[data-pend="failed"] { pointer-events: auto; font-size: 11px; }
  .pend[data-pend="sending"] .pend-dot { animation: fxDot 1s steps(2) infinite; }
  @keyframes fxDot { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
  @media (prefers-reduced-motion: reduce) { .pend[data-pend="sending"] .pend-dot { animation: none; } }
  :root[data-hid] .pend-dot { animation-play-state: paused; }
  /* A change from elsewhere: a soft shine crosses the card once. The box clips it to the card. */
  .fx-glint { position: absolute; inset: 0; z-index: 2; overflow: hidden; border-radius: inherit; pointer-events: none; }
  .fx-glint i { position: absolute; top: 0; bottom: 0; left: 0; width: 45%; background: linear-gradient(100deg, transparent, rgba(255, 255, 255, .2), transparent); }
  /* First load: three bulbs wake one after another. */
  .fx-bulbs { display: flex; gap: 10px; justify-content: center; margin-bottom: 10px; }
  .fx-bulbs i { width: 14px; height: 14px; border-radius: 50%; background: var(--fg-muted); opacity: .3; animation: fxWake 1.2s steps(6) infinite; }
  .fx-bulbs i:nth-child(2) { animation-delay: -.4s; } .fx-bulbs i:nth-child(3) { animation-delay: -.8s; }
  @keyframes fxWake { 0%, 100% { opacity: .3; } 50% { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { .fx-bulbs i { animation: none; opacity: .6; } }
  :root[data-hid] .fx-bulbs i { animation-play-state: paused; }
`;

export const HOME_FEEL_JS = `
  // ── Feel (redesign round 1, motion-state c, calmed) ───────────────────────
  var FX_EASE = 'cubic-bezier(.2,.8,.2,1)', fxPressAt = {}, fxCascAt = {}, fxFirst = {};
  var fxRM = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  // WHY every animation asks first: reduced-motion must win, a hidden page must not animate, and
  // the practice-only "before" screen switches this layer off.
  function fxCan() { return !fxRM.matches && !document.hidden && !window.__feelOff && typeof Element.prototype.animate === 'function'; }
  function fxAnim(el, frames, ms, delay) { return el ? el.animate(frames, { duration: ms, delay: delay || 0, easing: FX_EASE, fill: 'backwards' }) : null; }
  function fxLights(el) { return el.classList.contains('lights'); }
  function fxId(el) {
    if (fxLights(el)) { var r = el.querySelector('[data-room]'); return 'room:' + (r ? r.getAttribute('data-room') : ''); }
    return el.getAttribute('data-eid') || '';
  }
  function fxRecent(map, id) { return !!id && !!map[id] && Date.now() - map[id] < 2500; }
  // What a card looks like, so the next drawing can say what changed.
  function fxSample(el) {
    var lights = fxLights(el), np = lights ? null : el.querySelector('.np'), key = el.querySelector('.np-ctl .key.main');
    var rl = el.querySelector('.gcard .rlbl'), tmp = el.querySelector('.clim-set .val b, .th-set'), ttl = np && np.querySelector('.ttl');
    return {
      on: el.classList.contains('on'), mute: el.classList.contains('muted'), np: !!np, ttl: ttl ? ttl.textContent : '',
      pp: key ? (key.getAttribute('aria-label') || '') : '', grp: rl ? rl.textContent : '',
      tick: el.querySelectorAll('.gitem[aria-pressed="true"]').length, tmp: tmp ? tmp.textContent : '', c: el.style.getPropertyValue('--c') || ''
    };
  }
  function fxDiff(a, b) {
    var d = [];
    if (a.on !== b.on) d.push(b.on ? 'on' : 'off');
    if (a.mute !== b.mute) d.push(b.mute ? 'muted' : 'unmuted');
    if (a.np !== b.np) { if (b.np) d.push('np-in'); } else if (a.ttl !== b.ttl && b.np) d.push('track');
    if (a.pp !== b.pp) d.push('pp');
    if (a.grp !== b.grp || a.tick !== b.tick) d.push('group');
    if (a.tmp && a.tmp !== b.tmp) d.push(parseFloat(b.tmp) > parseFloat(a.tmp) ? 'up' : 'down');
    if (a.c !== b.c && a.on === b.on && b.c) d.push('colour');
    return d;
  }
  // The person's own change: small, quick, and starting close to where it ends.
  function fxPlay(el, d, delay) {
    var lights = fxLights(el), glow = el.querySelector('.glow'), bulb = el.querySelector('.bulb');
    var pop = [{ transform: 'scale(.9)' }, { transform: 'scale(1.05)', offset: .55 }, { transform: 'none' }];
    function has(w) { return d.indexOf(w) >= 0; }
    if (has('on')) { fxAnim(glow, [{ transform: 'scale(.6)' }, { transform: 'none' }], 320, delay); fxAnim(bulb, pop, 260, delay); }
    if (has('off')) fxAnim(bulb, [{ transform: 'scale(1.04)' }, { transform: 'none' }], 180, delay);
    if (has('colour')) fxAnim(bulb, pop, 240);
    if (lights) return;
    if (has('np-in')) fxAnim(el.querySelector('.np'), [{ opacity: .35, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], 240);
    if (has('track')) fxAnim(el.querySelector('.np .txt'), [{ opacity: .3, transform: 'translateX(8px)' }, { opacity: 1, transform: 'none' }], 200);
    // Play / pause: a quiet dip and return (no spin, Destin's note).
    if (has('pp')) fxAnim(el.querySelector('.np-ctl .key.main'), [{ transform: 'scale(.92)' }, { transform: 'none' }], 160);
    if (has('group')) {
      Array.prototype.forEach.call(el.querySelectorAll('.gitem[aria-pressed="true"] .gtick'), function (t) { fxAnim(t, [{ transform: 'scale(.8)' }, { transform: 'none' }], 160); });
      fxAnim(el.querySelector('.gcard .rlbl'), [{ opacity: .3, transform: 'translateX(6px)' }, { opacity: 1, transform: 'none' }], 200);
    }
    var num = el.querySelector('.clim-set .val b, .th-set');
    if (has('up')) fxAnim(num, [{ opacity: .3, transform: 'translateY(30%)' }, { opacity: 1, transform: 'none' }], 160);
    if (has('down')) fxAnim(num, [{ opacity: .3, transform: 'translateY(-30%)' }, { opacity: 1, transform: 'none' }], 160);
  }
  // A change nobody here asked for: one soft shine, nothing else moves.
  function fxGlint(el) {
    var g = document.createElement('span'), s = document.createElement('i');
    g.className = 'fx-glint'; g.setAttribute('aria-hidden', 'true'); g.appendChild(s); el.appendChild(g);
    var a = s.animate([{ transform: 'translateX(-100%)' }, { transform: 'translateX(230%)' }], { duration: 700, easing: 'ease-out' });
    a.onfinish = a.oncancel = function () { if (g.parentNode) g.parentNode.removeChild(g); };
  }
  // WHY remembered, not measured: the press came first (capture phase), the drawing second.
  function fxPress(t) {
    var card = t.closest ? t.closest('[data-eid], .lights') : null; if (!card) return;
    var now = Date.now(), lt = card.closest('.lights');
    fxPressAt[fxId(card)] = now;
    if (lt) { fxPressAt[fxId(lt)] = now; if (t.closest('[data-room-to]')) fxCascAt[fxId(lt)] = now; }
  }
  // Buttons acknowledge at once, even for a tap shorter than a frame (and for ones whose
  // result comes later: next track, a remote key).
  var FX_ACK = '.vbtn, .key, .pwr, .step, .th-step, .mode, .th-mode, .gitem, .sw';
  document.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('button') : null; if (!t) return;
    fxPress(t);
    if (!t.disabled && fxCan() && t.matches(FX_ACK)) fxAnim(t, [{ transform: 'scale(.92)' }, { transform: 'none' }], 160);
  }, true);
  document.addEventListener('input', function (e) {
    var t = e.target; fxPress(t);
    var c = t.hasAttribute && t.hasAttribute('data-bright') ? t.closest('.tile') : null;
    if (c) c.style.setProperty('--b', String(t.value / 100));
  }, true);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) document.documentElement.setAttribute('data-hid', '1'); else document.documentElement.removeAttribute('data-hid');
  });

  // Called by put() after each drawing of an area.
  function feelAfter(id) {
    if (id !== 'rooms' && id !== 'favs' && id !== 'view') return;
    var host = $(id), can = fxCan(), cards = host.querySelectorAll('[data-eid], .lights');
    var first = cards.length && !fxFirst[id];
    if (first) fxFirst[id] = Date.now();
    for (var i = 0; i < cards.length; i++) {
      var el = cards[i], cur = fxSample(el), prev = el.__fx; el.__fx = cur;
      // A brightness you set keeps the glow at that level across redraws (the drawing resets the card's style).
      var br = el.querySelector('.lr[data-bright]');
      if (br && el.style.getPropertyValue('--b') !== String(br.value / 100)) el.style.setProperty('--b', String(br.value / 100));
      if (!can) continue;
      if (!prev) { if (first && id === 'rooms') fxAnim(el, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], 260, Math.min(i, 6) * 40); continue; }
      var d = fxDiff(prev, cur); if (!d.length) continue;
      var lt = el.closest('.lights'), mine = fxRecent(fxPressAt, fxId(el)) || (lt && fxRecent(fxPressAt, fxId(lt)));
      if (!mine) { fxGlint(el); continue; }
      var casc = lt && fxRecent(fxCascAt, fxId(lt)) ? Math.min(Array.prototype.indexOf.call(lt.querySelectorAll('[data-eid]'), el), 5) : 0;
      fxPlay(el, d, Math.max(casc, 0) * 45);
    }
    // The note under a card fades up; a refusal gives one small shake.
    var notes = host.querySelectorAll('.pend');
    for (var n = 0; n < notes.length; n++) {
      var note = notes[n], st = note.getAttribute('data-pend');
      if (note.__fxs === st) continue;
      note.__fxs = st;
      if (!can) continue;
      if (st === 'failed') fxAnim(note, [{ transform: 'translateX(0)' }, { transform: 'translateX(-4px)' }, { transform: 'translateX(3px)' }, { transform: 'none' }], 240);
      else if (st === 'done') fxAnim(note.querySelector('.pend-dot'), [{ transform: 'scale(1.8)' }, { transform: 'none' }], 200);
      else fxAnim(note, [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], 160);
    }
  }
`;
