(async () => {
  // The first half of the "comment-box-*" journeys (a `check` step; scripts/shoot/driver.mjs). It selects ONE WHOLE
  // line of the open file and releases the mouse so the reading view's own menu opens, presses its real
  // "Add comment", and comment-box.measure.check.js checks where the box landed.
  //
  // WHY a whole line: that is the selection the bug always hit (2026-11-22, Destin: "comment boxes sometimes show up
  // in weird places, like the bottom left"). Drawing the new highlight around exactly the selected text, or a Word
  // file redrawing its text, wiped the selection the box was placed from, and it fell back to the document's
  // bottom-left corner: 3 of 3 whole-line selections, 12 of 14 Word-file comments, 19 of 20 second comments.
  // Each journey runs this twice, so the second run is a second comment in the same open file.
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let v = null;
  for (let j = 0; j < 200; j++) {
    v = document.querySelector('[data-artifact-viewer]');
    if (v && !v.hasAttribute('data-doc-loading') && v.innerText.trim().length > 200) break;
    v = null;
    await wait(50);
  }
  if (!v) return { ok: false, why: 'the file never finished opening' };
  // Let the file's saved comments load and their highlights be drawn first: redrawing them changes the selection,
  // which (rightly) closes the menu.
  await wait(800);
  const trial = (window.__cbTrial = (window.__cbTrial ?? -1) + 1);
  const tw = document.createTreeWalker(v, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.data.trim().length > 20 && !n.parentElement.closest('mark') ? 1 : 3),
  });
  const nodes = [];
  for (let n; (n = tw.nextNode());) nodes.push(n);
  // Lines further down on each run, so the second comment is not on top of the first.
  const node = nodes[Math.min(nodes.length - 1, 2 + trial * 4)];
  if (!node) return { ok: false, why: 'no line of text long enough to select' };
  node.parentElement.scrollIntoView({ block: 'center' });
  await wait(250);
  // WHY wait for the chat to stand still, and retry: ANY scroll on the page closes this menu, and the chat beside
  // the file corrects its own scroll position once after first draw. On a quiet machine that is over before the
  // selection; on a loaded one it landed 0.1-2.7 s after the menu opened and closed it, so the journey's next click
  // found no "Add comment" (3 runs in 4 under load, 2026-11-27; the scroll was `.chat-scroll`, not the file).
  const chat = document.querySelector('.chat-scroll');
  if (chat) {
    let sig = null, since = performance.now();
    for (const t0 = performance.now(); performance.now() - t0 < 8000; await wait(50)) {
      const now = chat.scrollTop + ':' + chat.scrollHeight;
      if (now !== sig) { sig = now; since = performance.now(); }
      if (performance.now() - since > 700) break;
    }
  }
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = document.createRange();
    r.selectNodeContents(node);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    window.__cbText = node.data;
    node.parentElement.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    node.parentElement.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    for (let j = 0; j < 40 && !document.querySelector('[role=menu]'); j++) await wait(25);
    if (!document.querySelector('[role=menu]')) continue;
    // WHY the click is made here, not as the journey's next step: between two journey steps the driver waits for
    // the page to settle (up to seconds), and a scroll in that gap closed the menu in 3 runs of 8 even after the
    // wait above. What these journeys prove is where the box lands, so the real menu entry is pressed at once.
    const item = [...document.querySelectorAll('[role=menu] [role=menuitem]')].find((m) => m.textContent.trim() === 'Add comment');
    if (!item) continue;
    item.click();
    for (let j = 0; j < 40 && !document.querySelector('textarea[aria-label="New comment"]'); j++) await wait(25);
    if (document.querySelector('textarea[aria-label="New comment"]')) return { ok: true };
  }
  return { ok: false, why: 'the menu never opened on the selection, or "Add comment" opened no box' };
})()
