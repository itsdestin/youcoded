(async () => {
  // The in-page half of the "touch-terminal-keys" journey. On a phone (no computer window), terminal view puts a
  // key row (Esc, Tab, Enter…) under the terminal. In framed themes it once sat UNDER the frame glass: present and
  // "clickable" in the DOM, invisible and untappable in practice, so a startup question sent to terminal view could
  // not be answered on a phone (2026-09-24). jsdom cannot see stacking, so this asks the real browser what a tap at
  // each key's centre would hit.
  const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
  const t0 = performance.now();
  const keyNames = ['Esc', 'Tab', 'Enter'];
  const find = () => keyNames.map((n) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === n && b.offsetParent));
  let keys = find();
  while (keys.some((k) => !k) && performance.now() - t0 < 10000) { await raf(); keys = find(); }
  if (keys.some((k) => !k)) return { ok: false, why: 'the terminal key row never appeared (is the journey started with platform=android, in terminal view?)' };
  for (let i = 0; i < 10; i++) await raf(); // let the layout settle after the view switch
  // WHY every element is made hit-testable for the measurement: the frame glass ignores taps (pointer-events: none),
  // so a plain elementFromPoint looks straight through it — yet it PAINTS over whatever sits below it, which is the
  // bug. With hit-testing forced on, elementFromPoint names whatever is drawn on top. Removed again before returning.
  const probe = document.createElement('style');
  probe.textContent = '* { pointer-events: auto !important; }';
  document.head.append(probe);
  await raf();
  const covered = [];
  for (const [i, k] of keys.entries()) {
    const r = k.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || r.bottom > innerHeight || r.top < 0) { covered.push(`${keyNames[i]} is off screen`); continue; }
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!hit || !k.contains(hit)) covered.push(`${keyNames[i]} is covered by ${hit ? hit.tagName.toLowerCase() + '.' + [...hit.classList].join('.') : 'nothing'}`);
  }
  probe.remove();
  return covered.length ? { ok: false, why: `a tap would miss the key row: ${covered.join('; ')}` } : { ok: true };
})()
