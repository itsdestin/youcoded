// The page kit's dropdown (page-kit.ts PAGE_KIT_JS): a Page's plain <select> opens the app's own
// menu look, never the browser's white list (design guide, "Building a Page"; Destin: "these bare
// native browser dropdowns"). Runs the REAL hosted document — prepareHostedDocument's output, with
// the bootstrap and the kit script — in jsdom, so a kit that stopped being injected fails here too.
// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { prepareHostedDocument } from '../src/renderer/components/pages/page-theme';
import { PAGE_KIT_CSS } from '../src/renderer/components/pages/page-kit';

// WHY a dynamic import by name: jsdom ships without type declarations in this install (as money-page.test.ts).
const JSDOM_MODULE = 'jsdom';
let JSDOM: new (html: string, opts: object) => { window: Window & typeof globalThis };
beforeAll(async () => { ({ JSDOM } = (await import(JSDOM_MODULE)) as { JSDOM: typeof JSDOM }); });

const PAGE = `<!doctype html><html><head><title>t</title></head><body>
  <label class="yc-label" for="kind">Kind</label>
  <select class="yc-select" id="kind" aria-label="Kind">
    <option value="work">Work</option>
    <option value="home" selected>Home</option>
    <option value="health" disabled>Health</option>
    <option value="social">Social</option>
    <option value="__add" data-yc-action>Add another kind…</option>
  </select>
  <button id="other">Other</button>
  <script>
    window.seen = [];
    document.getElementById('kind').addEventListener('change', function (e) { window.seen.push(e.target.value); });
  </script>
</body></html>`;

function mount() {
  const dom = new JSDOM(prepareHostedDocument(PAGE, ':root{}', PAGE_KIT_CSS), { runScripts: 'dangerously', pretendToBeVisual: true });
  const w = dom.window as any;
  const d: Document = w.document;
  const sel = d.getElementById('kind') as HTMLSelectElement;
  const press = (el: Element) => {
    const down = new w.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
    el.dispatchEvent(down);
    return down;
  };
  const key = (el: Element, k: string) => {
    const ev = new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    return ev;
  };
  const menu = () => d.querySelector('.yc-menu[role="listbox"]') as HTMLElement | null;
  const rows = () => [...d.querySelectorAll('.yc-menu__item')] as HTMLElement[];
  return { w, d, sel, press, key, menu, rows };
}

describe('the page kit dropdown', () => {
  it('is put into every hosted page', () => {
    expect(prepareHostedDocument(PAGE, '', PAGE_KIT_CSS)).toContain('<script id="youcoded-kit-js">');
  });

  it('a press on a <select> opens the kit list, not the browser one, with every option in it', () => {
    const { sel, press, menu, rows, d } = mount();
    const down = press(sel);
    // The browser's own list opens as the press's default action: cancelled means it never shows.
    expect(down.defaultPrevented).toBe(true);
    expect(menu()).not.toBeNull();
    expect(rows().map((r) => r.textContent)).toEqual(['Work', 'Home', 'Health', 'Social', 'Add another kind…']);
    expect(rows()[1].getAttribute('aria-selected')).toBe('true');
    expect(rows()[2].getAttribute('aria-disabled')).toBe('true');
    expect(sel.getAttribute('aria-expanded')).toBe('true');
    expect(d.activeElement).toBe(sel);
    // The foot action sits apart from the choices, behind the tapered line.
    expect(d.querySelector('.yc-menu__foot')!.textContent).toBe('Add another kind…');
    expect(d.querySelector('.yc-menu__list')!.textContent).not.toContain('Add another kind');
  });

  it('choosing a row sets the real select and fires change, and the list closes', () => {
    const { w, sel, press, menu, rows } = mount();
    press(sel);
    rows()[3].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    expect(sel.value).toBe('social');
    expect(w.seen).toEqual(['social']);
    expect(menu()).toBeNull();
    // A disabled row does nothing.
    press(sel);
    rows()[2].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    expect(sel.value).toBe('social');
    expect(menu()).not.toBeNull();
  });

  it('works from the keyboard: arrows skip a disabled row, Enter chooses, type-ahead jumps', () => {
    const { w, sel, key, menu } = mount();
    sel.focus();
    expect(key(sel, 'ArrowDown').defaultPrevented).toBe(true);
    expect(menu()).not.toBeNull();
    key(sel, 'ArrowDown'); // from Home, past disabled Health, to Social
    key(sel, 'Enter');
    expect(sel.value).toBe('social');
    expect(w.seen).toEqual(['social']);
    key(sel, ' ');
    key(sel, 'w');
    key(sel, 'Enter');
    expect(sel.value).toBe('work');
  });

  it('Escape closes the list, and the app is not also told to leave the page', async () => {
    const { w, sel, press, key, menu } = mount();
    const posted: unknown[] = [];
    w.parent.postMessage = (m: unknown) => posted.push(m);
    press(sel);
    const esc = key(sel, 'Escape');
    expect(esc.defaultPrevented).toBe(true);
    expect(menu()).toBeNull();
    expect(sel.value).toBe('home');
    await new Promise((r) => setTimeout(r, 5)); // settle: the bootstrap would tell the app one tick later
    expect(posted).toEqual([]);
  });

  it('a press outside, or the select losing focus, closes it', () => {
    const { d, sel, press, menu } = mount();
    press(sel);
    press(d.getElementById('other')!);
    expect(menu()).toBeNull();
    press(sel);
    sel.blur();
    expect(menu()).toBeNull();
  });

  it('the foot action is chosen like any option, so the page handler sees its value', () => {
    const { w, sel, press, rows } = mount();
    press(sel);
    rows()[4].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    expect(w.seen).toEqual(['__add']);
  });
});

// The kit's own pieces that act (Destin's picks, pages-kit-questions 2026-10-16): the switch is the
// app's Toggle (role=switch, aria-checked, keyboard); a notice's Details fold opens INSIDE the box and
// its buttons sit after the fold; the fold row opens inside itself; and every scroller a page makes
// gets the app's one scroll fade without the page asking.
const PIECES = `<!doctype html><html><head><title>t</title></head><body>
  <button class="yc-switch" role="switch" aria-checked="false" aria-label="Wi-Fi" id="wifi"></button>
  <button class="yc-switch" aria-label="Bare" id="bare"></button>
  <button class="yc-switch" role="switch" aria-checked="true" aria-label="Locked" id="locked" disabled></button>
  <div class="yc-notice yc-notice--danger" role="alert" id="notice">
    <div class="yc-notice__text">Your list couldn't be saved. Your changes are still here.</div>
    <div class="yc-notice__actions" id="acts"><button class="yc-button yc-button--sm yc-button--primary">Try again</button></div>
    <details class="yc-fold yc-notice__details" id="details"><summary>Details</summary><code>ENOSPC: no space left on device</code></details>
  </div>
  <details class="yc-fold" id="fold"><summary>Advanced options <span class="yc-fold__hint">Rarely needed</span></summary><div id="inside">Hidden until opened</div></details>
  <div id="list" style="overflow-y: auto; height: 40px"><p>a</p></div>
  <div id="clip" style="overflow: hidden"><p>b</p></div>
  <div id="host"></div>
  <script>
    window.changes = [];
    document.addEventListener('change', function (e) { window.changes.push(e.target.id + '=' + e.target.getAttribute('aria-checked')); });
  </script>
</body></html>`;

async function mountPieces() {
  const posted: { type?: string; top?: boolean; bottom?: boolean }[] = [];
  const dom = new JSDOM(prepareHostedDocument(PIECES, ':root{}', PAGE_KIT_CSS), {
    runScripts: 'dangerously', pretendToBeVisual: true,
    // What the page tells the app, from its first line on.
    beforeParse: (win: any) => { win.parent.postMessage = (m: any) => posted.push(m); },
  });
  const w = dom.window as any;
  const d: Document = w.document;
  // The kit starts on DOMContentLoaded, as in a real page: wait for it.
  if (d.readyState === 'loading') await new Promise((r) => d.addEventListener('DOMContentLoaded', r));
  const $ = (id: string) => d.getElementById(id)!;
  const click = (el: Element) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  const key = (el: Element, k: string) => {
    const ev = new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    return ev;
  };
  const frame = () => new Promise((r) => w.requestAnimationFrame(r));
  const edges = () => posted.filter((m) => m && m.type === 'youcoded:edges').map(({ top, bottom }) => ({ top, bottom }));
  return { w, d, $, click, key, frame, edges };
}

describe('the page kit switch', () => {
  it('a click flips aria-checked and fires change; Space and Enter do the same and keep the browser out', async () => {
    const { w, $, click, key } = await mountPieces();
    const wifi = $('wifi');
    click(wifi);
    expect(wifi.getAttribute('aria-checked')).toBe('true');
    const space = key(wifi, ' ');
    // Cancelled, so the browser's own Space-to-click never flips it a second time.
    expect(space.defaultPrevented).toBe(true);
    expect(wifi.getAttribute('aria-checked')).toBe('false');
    key(wifi, 'Enter');
    expect(wifi.getAttribute('aria-checked')).toBe('true');
    expect(w.changes).toEqual(['wifi=true', 'wifi=false', 'wifi=true']);
  });

  it('a switch the page wrote bare is made a switch for screen readers, and a disabled one never flips', async () => {
    const { w, $, key } = await mountPieces();
    expect($('bare').getAttribute('role')).toBe('switch');
    expect($('bare').getAttribute('aria-checked')).toBe('false');
    const locked = $('locked');
    locked.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
    key(locked, ' ');
    expect(locked.getAttribute('aria-checked')).toBe('true');
    expect(w.changes).toEqual([]);
  });
});

describe('the page kit notice and fold row', () => {
  it("the notice's Details fold opens inside the box, and its buttons sit after the fold on their own line", async () => {
    const { w, $, click } = await mountPieces();
    const notice = $('notice');
    const details = $('details') as HTMLDetailsElement;
    expect(notice.contains(details)).toBe(true);
    click(details.querySelector('summary')!);
    expect(details.open).toBe(true);
    // The page wrote the buttons BEFORE the fold; the kit still draws them after it, full width.
    const acts = w.getComputedStyle($('acts'));
    expect(Number(acts.order)).toBeGreaterThan(Number(w.getComputedStyle(details).order));
    expect(acts.flexBasis).toBe('100%');
    expect(acts.justifyContent).toBe('flex-end');
  });

  it('the fold row opens and closes in place, its content inside the same box', async () => {
    const { $, click } = await mountPieces();
    const fold = $('fold') as HTMLDetailsElement;
    expect(fold.open).toBe(false);
    expect(fold.contains($('inside'))).toBe(true);
    click(fold.querySelector('summary')!);
    expect(fold.open).toBe(true);
    click(fold.querySelector('summary')!);
    expect(fold.open).toBe(false);
  });
});

describe('the page kit scroll fade', () => {
  it('marks every element the page makes scroll, now and when added later, and keeps the mark through a redraw', async () => {
    const { d, $, frame } = await mountPieces();
    expect($('list').classList.contains('yc-scroll')).toBe(true);
    expect($('clip').classList.contains('yc-scroll')).toBe(false);
    $('host').innerHTML = '<section id="later" style="overflow-x: scroll"></section>';
    await frame();
    expect($('later').classList.contains('yc-scroll')).toBe(true);
    // A page that redraws by rewriting the class (a morph) drops the mark; it is put back at once.
    $('list').className = 'something-else';
    await Promise.resolve();
    expect($('list').classList.contains('yc-scroll')).toBe(true);
    expect(d.querySelectorAll('.yc-scroll').length).toBe(2);
  });

  it("is the app's own fade: the kit's gradients and keyframes are scroll-mask.css's, word for word", () => {
    const appCss = readFileSync(fileURLToPath(new URL('../src/renderer/styles/scroll-mask.css', import.meta.url)), 'utf8');
    const pieces = [
      ...appCss.match(/--scroll-mask-[xy]: linear-gradient\([^;]+;/g)!,
      ...appCss.match(/@keyframes scroll-mask-[a-z]+ \{[^\n]+/g)!,
      ...appCss.match(/--scroll-mask-(on|s): [^;]+;/g)!,
    ];
    expect(pieces.length).toBe(8);
    for (const p of pieces) expect(PAGE_KIT_CSS).toContain(p);
  });

  it('tells the app which edges of the page hide more, only when that changes', async () => {
    const { w, d, frame, edges } = await mountPieces();
    await frame();
    expect(edges()).toEqual([{ top: false, bottom: false }]);
    // jsdom lays nothing out, so the page's size and scroll are set by hand.
    const se = d.documentElement;
    let top = 0;
    Object.defineProperty(se, 'scrollHeight', { configurable: true, get: () => 2000 });
    Object.defineProperty(se, 'clientHeight', { configurable: true, get: () => 500 });
    Object.defineProperty(se, 'scrollTop', { configurable: true, get: () => top });
    d.dispatchEvent(new w.Event('scroll'));
    await frame();
    top = 1500;
    d.dispatchEvent(new w.Event('scroll'));
    d.dispatchEvent(new w.Event('scroll'));
    await frame();
    d.dispatchEvent(new w.Event('scroll'));
    await frame();
    // One report per change, none for the scrolls that changed nothing.
    expect(edges()).toEqual([{ top: false, bottom: false }, { top: false, bottom: true }, { top: true, bottom: false }]);
  });
});
