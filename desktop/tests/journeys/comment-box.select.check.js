(async () => {
  // The first half of the "comment-box-*" journeys (a `check` step; scripts/shoot/driver.mjs). It selects ONE WHOLE
  // line of the open file and releases the mouse so the reading view's own menu opens; the journey then clicks its
  // real "Add comment" and comment-box.measure.check.js checks where the box landed.
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
  const r = document.createRange();
  r.selectNodeContents(node);
  getSelection().removeAllRanges();
  getSelection().addRange(r);
  window.__cbText = node.data;
  node.parentElement.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
  node.parentElement.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
  // WHY up to 3 s: on a heavily loaded machine the menu took up to ~1 s just to draw (2026-11-27). The selection and
  // release are sent in the same instant on purpose: the browser's "selection changed" notice for it then lands
  // after the menu is up, which used to close it (ReadingHighlights.tsx, onSelChange).
  for (let j = 0; j < 120 && !document.querySelector('[role=menu]'); j++) await wait(25);
  if (!document.querySelector('[role=menu]')) return { ok: false, why: 'the menu never opened on the selection' };
  // WHY scroll the chat here (2026-11-27): the chat beside the file scrolls by itself — a streaming reply, or its
  // text re-wrapping when the app's font finishes loading — and that used to close this menu (it had no anchor, so ANY
  // scroll on the page closed it). On a busy machine the font swap landed after the menu opened and the next step
  // found no "Add comment". Doing it on purpose makes that case run every time instead of by luck.
  const chat = document.querySelector('.chat-scroll');
  if (chat) {
    chat.scrollTop = Math.max(0, chat.scrollTop - 40);
    await wait(150);
    if (!document.querySelector('[role=menu]')) return { ok: false, why: 'the chat beside the file scrolled and the menu closed' };
  }
  return { ok: true };
})()
