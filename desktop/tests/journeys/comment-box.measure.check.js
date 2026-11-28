(async () => {
  // The second half of the "comment-box-*" journeys — see comment-box.select.check.js for the why. After "Add
  // comment" was clicked: the new-comment box must sit right under (or, with no room, right over) the new highlight,
  // inside the part of the file panel you can see, and must follow the highlight when the panel scrolls.
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  let ta = null;
  for (let j = 0; j < 80 && !(ta = document.querySelector('textarea[aria-label="New comment"]')); j++) await wait(25);
  if (!ta) return { ok: false, why: 'no new-comment box opened' };
  await wait(150);
  let box = ta;
  while (box && getComputedStyle(box).position !== 'fixed') box = box.parentElement;
  const viewer = document.querySelector('[data-artifact-viewer]');
  // WHY the draft's own id (2026-11-27): matching any highlight whose words appear in the selected line could pick an
  // older, shorter one. The draft is the only highlight drawn active while its box is open (use-quote-marks.ts).
  const active = viewer.querySelector('mark[data-comment-id][class*="!bg-accent/30"]');
  const segs = active ? [...viewer.querySelectorAll(`mark[data-comment-id="${CSS.escape(active.dataset.commentId)}"]`)] : [];
  if (!segs.length) return { ok: false, why: 'the new highlight was not drawn' };
  let scroller = viewer.parentElement;
  while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
  const where = () => {
    const rs = segs.map((s) => s.getBoundingClientRect());
    const hl = { left: Math.min(...rs.map((x) => x.left)), top: Math.min(...rs.map((x) => x.top)), bottom: Math.max(...rs.map((x) => x.bottom)) };
    const b = box.getBoundingClientRect();
    const panel = scroller.getBoundingClientRect();
    const r = (n) => Math.round(n);
    const said = `box l${r(b.left)} t${r(b.top)}-${r(b.bottom)}, highlight l${r(hl.left)} t${r(hl.top)}-${r(hl.bottom)}, panel t${r(panel.top)}-${r(panel.bottom)}`;
    const below = b.top >= hl.bottom - 1 && b.top - hl.bottom <= 16;
    const above = b.bottom <= hl.top + 1 && hl.top - b.bottom <= 16;
    if (!below && !above) return `the box is not next to the highlight (${said})`;
    if (Math.abs(b.left - hl.left) > 24 && b.right < panel.right - 16) return `the box is not lined up with the highlight (${said})`;
    if (b.top < panel.top - 1 || b.bottom > panel.bottom + 1) return `the box leaves the visible panel (${said})`;
    return null;
  };
  // WHY a few frames of grace, not one look: if the file's text re-wraps just as the box opens (the font finishing
  // loading on a busy machine), the box follows it a frame later. 500 ms is far below what a stuck box (the
  // bottom-left-corner bug, or one that never follows) would need — those never come right.
  let first = where();
  for (let j = 0; first && j < 10; j++) { await wait(50); first = where(); }
  if (first) return { ok: false, why: first };
  scroller.scrollTop += 40;
  await frames();
  const after = where();
  if (after) return { ok: false, why: `after scrolling 40px: ${after}` };
  // WHY re-wrap the text (2026-11-27): words can move with no scroll and no window resize — the font finishing
  // loading, dragging the file panel's divider — and the box used to stay where it was, on top of them (measured
  // ~100 px off). Narrowing the text column does the same on purpose. Only "next to it" is judged: in a column this
  // narrow the box is pushed in from the edge, so its left side cannot line up.
  // If the re-wrap pushes the words past the visible part of the panel, the box rightly stops at the panel's edge
  // (where it may already have been), so only "still inside the panel" can be judged then. Both journeys keep their
  // words in view on a normal run, and both failed this check on the code that never followed (2026-11-27).
  viewer.style.maxWidth = '260px';
  await wait(100);
  await frames();
  const rewrapped = where();
  const hlNow = segs.map((s) => s.getBoundingClientRect());
  const pr = scroller.getBoundingClientRect();
  const wordsVisible = Math.min(...hlNow.map((x) => x.top)) >= pr.top && Math.max(...hlNow.map((x) => x.bottom)) <= pr.bottom - 100;
  viewer.style.maxWidth = '';
  await frames();
  if (rewrapped && (wordsVisible ? !rewrapped.includes('not lined up') : rewrapped.includes('leaves the visible panel'))) {
    return { ok: false, why: `after the text re-wrapped: ${rewrapped}` };
  }
  // Close it the way a user does (a click elsewhere drops an empty draft), ready for the next run.
  viewer.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
  getSelection().removeAllRanges();
  for (let j = 0; j < 40 && document.querySelector('textarea[aria-label="New comment"]'); j++) await wait(25);
  return { ok: true };
})()
