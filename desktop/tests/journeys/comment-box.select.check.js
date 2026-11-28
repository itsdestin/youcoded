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
  for (let j = 0; j < 40 && !document.querySelector('[role=menu]'); j++) await wait(25);
  return document.querySelector('[role=menu]') ? { ok: true } : { ok: false, why: 'the menu never opened on the selection' };
})()
