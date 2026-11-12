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
  let worstDrift = 0, spacerFrames = 0, steps = 0, driftAt = null, lastDrift = 0, firstSpacerAt = null;
  while (s.scrollTop > 0 && steps++ < 200) {
    s.dispatchEvent(new WheelEvent('wheel', { deltaY: -1200, bubbles: true }));
    s.scrollTop = Math.max(0, s.scrollTop - 1200);
    const box = s.getBoundingClientRect(); const mid = box.top + box.height / 2;
    const ref = entriesOf(s).find((e) => { const b = e.getBoundingClientRect(); return b.top <= mid && b.bottom >= mid && !isSpacer(e); });
    const key = ref && ref.dataset.entryKey; const top0 = ref ? ref.getBoundingClientRect().top : 0;
    const ts = performance.now(); const st0 = s.scrollTop, sh0 = s.scrollHeight;
    // WHY: a drift is content ABOVE the entry changing height; remembering every entry's height and blank/drawn
    // state at the start of the step lets the failure name which entries changed (2026-11-08: the only way the
    // top-of-conversation jumps were traced to blank entries drawn too late, when scrollTop could not go lower).
    const before = new Map(entriesOf(s).map((e) => [e.dataset.entryKey, [r1(e.getBoundingClientRect().height), isSpacer(e)]]));
    while (performance.now() - ts < 450) {
      await raf();
      const cur = key && s.querySelector('[data-entry-key="' + CSS.escape(key) + '"]');
      if (cur) {
        const d = Math.abs(cur.getBoundingClientRect().top - top0);
        // WHY the detail (failed once under a busy machine, 2026-11-03, 20px, never alone): a drift seen for one
        // frame and corrected by the next is the place-holding running a frame late; one still there after 450 ms
        // is a real jump. The failure now says which, and on what entry, so the next one explains itself.
        if (d > worstDrift) {
          const above = [];
          for (const e of entriesOf(s)) {
            if (e === cur) break;
            const b = before.get(e.dataset.entryKey); const h = r1(e.getBoundingClientRect().height);
            if ((!b || Math.abs(b[0] - h) > 0.4) && above.length < 6) above.push(`${e.dataset.entryKey} ${b ? `${b[1] ? 'blank' : 'drawn'} ${b[0]}` : 'new'} -> ${h}`);
          }
          worstDrift = d; driftAt = { above, stAtStart: r1(st0), key, frame: Math.round(performance.now() - ts), step: steps, scrollTopMoved: r1(s.scrollTop - st0), scrollHeightMoved: r1(s.scrollHeight - sh0), spacer: isSpacer(cur) }; }
        lastDrift = d;
      }
      // WHY the detail: a blank spacer in view means an entry was not drawn before the frame it came into sight
      // (2026-11-08: the observer had marked it drawn but its update was still queued). Step and time say which.
      if (spacersInWindow() > 0 && !spacerFrames++) firstSpacerAt = { step: steps, frame: Math.round(performance.now() - ts), scrollTopMoved: r1(s.scrollTop - st0) };
    }
    if (driftAt && driftAt.step === steps) driftAt.after450ms = r1(lastDrift);
  }
  await wait(800);
  const box = s.getBoundingClientRect();
  rep.scrollSteps = steps; rep.worstDriftPx = r1(worstDrift); rep.worstDriftAt = driftAt; rep.framesWithSpacerInWindow = spacerFrames; rep.firstSpacerAt = firstSpacerAt;
  rep.spacersNearWindowAtTop = entriesOf(s).filter((e) => { const b = e.getBoundingClientRect(); return isSpacer(e) && b.bottom > box.top - 1000 && b.top < box.bottom + 1000; }).length;
  // PLACEHOLDER  a code block the browser has not drawn yet (content-visibility: auto) holds a placeholder height;
  //              it must equal the height the block has once drawn, or drawing it later pushes the reader's text
  //              (a 43-line block held at 128 px grew by 756 px and the whole entry below jumped - found under CPU
  //              throttling, 2026-10-23). Blocks whose lines run wider than the box carry a horizontal scrollbar the
  //              line count cannot know about, so they are left out.
  const blocks = [...s.querySelectorAll('.yc-code-block')].filter((b) => { const pre = b.querySelector('pre'); return pre && pre.scrollWidth <= pre.clientWidth; });
  let worstPlaceholder = 0;
  for (const b of blocks) {
    const held = parseFloat(getComputedStyle(b).containIntrinsicBlockSize.replace('auto', ''));
    const drawn = b.querySelector('pre').getBoundingClientRect().height;
    if (Number.isFinite(held)) worstPlaceholder = Math.max(worstPlaceholder, Math.abs(held - drawn));
  }
  rep.codeBlocksChecked = blocks.length; rep.worstPlaceholderErrorPx = r1(worstPlaceholder);
  const why = [];
  if (!blocks.length) why.push('no code block was in the page to check the placeholder height against (is the seed conversation missing its code?)');
  if (worstPlaceholder > 1) why.push(`a code block holds a placeholder ${r1(worstPlaceholder)}px different from its drawn height`);
  if (rep.drawnAtFirstFrame >= rep.entries * 0.5) why.push(`drew ${rep.drawnAtFirstFrame} of ${rep.entries} entries at the first frame (expected only the newest screens)`);
  if (rep.bottomMovePx > 1) why.push(`the bottom moved ${rep.bottomMovePx}px after opening`);
  if (rep.flickFramesWithSpacerInWindow > 0) why.push(`${rep.flickFramesWithSpacerInWindow} flick frames showed a blank spacer in the window`);
  if (rep.worstDriftPx > 1) why.push(`scrolling up moved the entry in view by ${rep.worstDriftPx}px (${driftAt ? `${driftAt.frame} ms into step ${driftAt.step}, ${driftAt.after450ms ?? '?'}px off 450 ms later — ${driftAt.after450ms > 1 ? 'a lasting jump' : 'corrected a frame late'}; scrollTop at step start ${driftAt.stAtStart}; changed above it: ${driftAt.above.join(', ') || 'nothing'}` : 'no detail'})`);
  if (rep.framesWithSpacerInWindow > 0) why.push(`${rep.framesWithSpacerInWindow} frames showed a blank spacer in the window while scrolling up (first: step ${firstSpacerAt.step}, ${firstSpacerAt.frame} ms in)`);
  if (rep.spacersNearWindowAtTop > 0) why.push(`${rep.spacersNearWindowAtTop} entries near the window are still blank at the top`);
  return { ok: why.length === 0, why: why.join('; '), report: rep };
})()
