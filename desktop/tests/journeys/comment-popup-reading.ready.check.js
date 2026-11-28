(async () => {
  // Before the journey right-clicks the middle of the spreadsheet: wait until a real cell is drawn under that point.
  // WHY (2026-11-27): the grid draws only the cells in view, and right after opening it uses a first guess at its
  // size until it has measured itself. On a busy machine the right-click once landed on the blank stand-in space
  // there, so the menu offered only Copy / Select all (no cell, so no "Add comment") — the next step then failed.
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let what = 'no spreadsheet grid found';
  for (let j = 0; j < 200; j++) {
    const grid = [...document.querySelectorAll('[data-artifact-viewer] [data-sheet]')].find((g) => g.getBoundingClientRect().height > 0);
    if (grid) {
      // The driver presses the centre of the element it targets ("A B C D …" is the grid's scroll area).
      let area = grid; while (area && !/(auto|scroll)/.test(getComputedStyle(area).overflowY)) area = area.parentElement;
      const r = (area ?? grid).getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (hit?.closest('[data-cell]')) return { ok: true };
      what = `at the grid's centre: <${hit?.tagName?.toLowerCase()} class="${hit?.className}">`;
    }
    await wait(25);
  }
  return { ok: false, why: `no spreadsheet cell under the point the next right-click presses after 5 s (${what})` };
})()
