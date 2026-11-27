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
  const segs = [...viewer.querySelectorAll('mark[data-comment-id]')].filter((m) => window.__cbText.includes(m.textContent));
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
  // WHY up to 2 s, not one look: a Word file redraws its text once more after the highlight is added and the box
  // follows a frame or two later; on a loaded machine one early look caught it 12 px off (1 run in 8, 2026-11-27).
  // The bug this guards (the box stuck in the bottom-left corner) never comes right, so waiting cannot hide it.
  let first = where();
  for (let j = 0; first && j < 40; j++) { await wait(50); first = where(); }
  if (first) return { ok: false, why: first };
  scroller.scrollTop += 40;
  await frames();
  const after = where();
  if (after) return { ok: false, why: `after scrolling 40px: ${after}` };
  // Close it the way a user does (a click elsewhere drops an empty draft), ready for the next run.
  viewer.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
  getSelection().removeAllRanges();
  for (let j = 0; j < 40 && document.querySelector('textarea[aria-label="New comment"]'); j++) await wait(25);
  return { ok: true };
})()
