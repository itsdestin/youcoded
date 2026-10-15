// The page kit's dropdown (page-kit.ts PAGE_KIT_JS): a Page's plain <select> opens the app's own
// menu look, never the browser's white list (design guide, "Building a Page"; Destin: "these bare
// native browser dropdowns"). Runs the REAL hosted document — prepareHostedDocument's output, with
// the bootstrap and the kit script — in jsdom, so a kit that stopped being injected fails here too.
// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
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
