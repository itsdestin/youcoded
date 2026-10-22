(async () => {
  // The in-page half of the "first-draw-stability" journey (a `check` step; scripts/shoot/driver.mjs), and of
  // desktop/scripts/first-draw-scroll-probe.mjs, which prints the numbers. It runs in REAL layout (the practice
  // app in headless Chrome) because scroll stability is layout: jsdom cannot see it. See
  // src/renderer/state/first-draw-plan.ts for what is being guarded.
  //
  // Opens the long conversation (`?seed=long-<N>` -> session wb-2), then checks, per paint frame:
  //   OPEN    the newest entries are drawn, the rest are spacers, and the bottom edge never moves (<= 1 px);
  //   FLICK   a hard fling up (250 px a frame) never shows a blank spacer inside the window;
  //   SCROLL  going up to the top in steps, the entry in the middle of the window never moves (<= 1 px) and no
  //           spacer is ever inside the window; at the top, everything within 1,000 px of the window is drawn.
  const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const entriesOf = (s) => [...s.querySelectorAll('.timeline-entry')];
  const isSpacer = (e) => !e.firstElementChild;
  const r1 = (n) => Math.round(n * 10) / 10;
  const t0 = performance.now();
  document.querySelector('[data-session-strip] [data-session-id="wb-2"]').click();
  let s = null;
  while (!s && performance.now() - t0 < 15000) {
    await raf();
    s = document.querySelector('[data-chat-session-id="wb-2"] .chat-scroll');
    if (s && !entriesOf(s).length) s = null;
  }
  if (!s) return { ok: false, why: 'the long conversation never appeared (is the journey started with seed=long-N?)' };
  const rep = { clickToFirstFrameMs: Math.round(performance.now() - t0) };
  const gap = () => s.scrollHeight - s.scrollTop - s.clientHeight;
  const spacersInWindow = () => {
    const r = s.getBoundingClientRect();
    return entriesOf(s).filter((e) => { const b = e.getBoundingClientRect(); return isSpacer(e) && b.bottom > r.top && b.top < r.bottom; }).length;
  };
  // OPEN
  const all0 = entriesOf(s);
  rep.entries = all0.length;
  rep.drawnAtFirstFrame = all0.filter((e) => !isSpacer(e)).length;
  const g0 = gap(); let maxGapMove = 0; const tOpen = performance.now();
  while (performance.now() - tOpen < 1500) { await raf(); maxGapMove = Math.max(maxGapMove, Math.abs(gap() - g0)); }
  rep.bottomMovePx = r1(maxGapMove);
  // FLICK
  let flickSpacerFrames = 0;
  for (let i = 0; i < 16; i++) {
    s.dispatchEvent(new WheelEvent('wheel', { deltaY: -250, bubbles: true }));
    s.scrollTop = Math.max(0, s.scrollTop - 250);
    await raf();
    if (spacersInWindow() > 0) flickSpacerFrames++;
  }
  await wait(1000);
  rep.flickFramesWithSpacerInWindow = flickSpacerFrames;
  // SCROLL up to the top (the chat un-pins on WHEEL INTENT, so announce it as a real wheel would).
  let worstDrift = 0, spacerFrames = 0, steps = 0;
  while (s.scrollTop > 0 && steps++ < 200) {
    s.dispatchEvent(new WheelEvent('wheel', { deltaY: -1200, bubbles: true }));
    s.scrollTop = Math.max(0, s.scrollTop - 1200);
    const box = s.getBoundingClientRect(); const mid = box.top + box.height / 2;
    const ref = entriesOf(s).find((e) => { const b = e.getBoundingClientRect(); return b.top <= mid && b.bottom >= mid && !isSpacer(e); });
    const key = ref && ref.dataset.entryKey; const top0 = ref ? ref.getBoundingClientRect().top : 0;
    const ts = performance.now();
    while (performance.now() - ts < 450) {
      await raf();
      const cur = key && s.querySelector('[data-entry-key="' + CSS.escape(key) + '"]');
      if (cur) worstDrift = Math.max(worstDrift, Math.abs(cur.getBoundingClientRect().top - top0));
      if (spacersInWindow() > 0) spacerFrames++;
    }
  }
  await wait(800);
  const box = s.getBoundingClientRect();
  rep.scrollSteps = steps; rep.worstDriftPx = r1(worstDrift); rep.framesWithSpacerInWindow = spacerFrames;
  rep.spacersNearWindowAtTop = entriesOf(s).filter((e) => { const b = e.getBoundingClientRect(); return isSpacer(e) && b.bottom > box.top - 1000 && b.top < box.bottom + 1000; }).length;
  const why = [];
  if (rep.drawnAtFirstFrame >= rep.entries * 0.5) why.push(`drew ${rep.drawnAtFirstFrame} of ${rep.entries} entries at the first frame (expected only the newest screens)`);
  if (rep.bottomMovePx > 1) why.push(`the bottom moved ${rep.bottomMovePx}px after opening`);
  if (rep.flickFramesWithSpacerInWindow > 0) why.push(`${rep.flickFramesWithSpacerInWindow} flick frames showed a blank spacer in the window`);
  if (rep.worstDriftPx > 1) why.push(`scrolling up moved the entry in view by ${rep.worstDriftPx}px`);
  if (rep.framesWithSpacerInWindow > 0) why.push(`${rep.framesWithSpacerInWindow} frames showed a blank spacer in the window while scrolling up`);
  if (rep.spacersNearWindowAtTop > 0) why.push(`${rep.spacersNearWindowAtTop} entries near the window are still blank at the top`);
  return { ok: why.length === 0, why: why.join('; '), report: rep };
})()
