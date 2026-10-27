(async () => {
  // The in-page half of a "first-draw-jump" journey (a `check` step; scripts/shoot/driver.mjs). Real layout, because where
  // an entry lands is layout. WHY (2026-10-22 review): the first-draw plan (src/renderer/state/first-draw-plan.ts) leaves the
  // older entries of a long conversation as blank spacers of a GUESSED height; a PROGRAMMATIC jump to one of them (not a
  // scroll the reader performs) must land on that entry and then stay put when the spacer is replaced by its real body.
  const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const entriesOf = (s) => [...s.querySelectorAll(".timeline-entry")];
  const isSpacer = (e) => !e.firstElementChild;
  const r1 = (n) => Math.round(n * 10) / 10;
  document.querySelector("[data-session-strip] [data-session-id=\"wb-2\"]").click();
  let s = null; const t0 = performance.now();
  while (!s && performance.now() - t0 < 15000) {
    await raf();
    s = document.querySelector("[data-chat-session-id=\"wb-2\"] .chat-scroll");
    if (s && !entriesOf(s).length) s = null;
  }
  if (!s) return { ok: false, why: "the long conversation never appeared (is the journey started with seed=long-N?)" };
  await wait(1500); // let the open settle, as the stability journey does
  // longConversation(): entry 2i is "Question i" (a user message), entry 2i+1 its answer.
  const target = entriesOf(s)[6];
  if (!target || !isSpacer(target)) return { ok: false, why: "precondition: the entry to jump to is not a first-draw spacer (is it too near the bottom?)" };
  const key = target.dataset.entryKey;
  const rep = { entriesDrawnBefore: entriesOf(s).filter((e) => !isSpacer(e)).length };
  const spacersInWindow = () => {
    const r = s.getBoundingClientRect();
    return entriesOf(s).filter((e) => { const b = e.getBoundingClientRect(); return isSpacer(e) && b.bottom > r.top && b.top < r.bottom; }).length;
  };
  const entryNow = () => s.querySelector("[data-entry-key=\"" + CSS.escape(key) + "\"]");
  // TARGET: chat Find ("Find in chat", Ctrl+F) on words that live only in a spacer entry.
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true }));
  let input = null; const tF = performance.now();
  while (!input && performance.now() - tF < 5000) { await raf(); input = document.querySelector("[data-chat-session-id=\"wb-2\"] input[aria-label=\"Find in chat\"]") || document.querySelector("input[aria-label=\"Find in chat\"]"); }
  if (!input) return { ok: false, why: "Ctrl+F did not open the chat find bar" };
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(input, "Question 3: please"); input.dispatchEvent(new Event("input", { bubbles: true }));
  const tJump = performance.now(); let landed = false;
  while (!landed && performance.now() - tJump < 10000) { await raf(); landed = CSS.highlights.has("chat-find-current"); }
  if (!landed) return { ok: false, why: "Find never selected the match", report: rep };
  await wait(300); // let Find's own bounded post-layout correction run before measuring
  const el0 = entryNow();
  const vp = s.getBoundingClientRect();
  const range = CSS.highlights.get("chat-find-current").values().next().value;
  const rb = range.getBoundingClientRect();
  rep.landedInEntry = !!el0 && !isSpacer(el0) && el0.contains(range.startContainer);
  rep.centerInWindow = (rb.top + rb.bottom) / 2 > vp.top && (rb.top + rb.bottom) / 2 < vp.bottom;
  const top0 = range.getBoundingClientRect().top; let worst = 0; let spacerFrames = 0; const tS = performance.now();
  while (performance.now() - tS < 1500) { await raf(); worst = Math.max(worst, Math.abs(range.getBoundingClientRect().top - top0)); if (spacersInWindow() > 0) spacerFrames++; }
  rep.movedAfterLandingPx = r1(worst); rep.framesWithSpacerInWindow = spacerFrames;
  const why = [];
  if (!rep.landedInEntry) why.push("Find did not land on the matching message");
  if (!rep.centerInWindow) why.push("the match is outside the visible window");
  if (rep.movedAfterLandingPx > 1) why.push("the match moved " + rep.movedAfterLandingPx + "px after Find landed");
  if (rep.framesWithSpacerInWindow > 0) why.push(rep.framesWithSpacerInWindow + " frames showed a blank spacer in the window");
  return { ok: why.length === 0, why: why.join("; "), report: rep };
})()
