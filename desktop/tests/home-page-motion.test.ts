// @vitest-environment jsdom
// Redesign round 1, motion-nav c ("Glide and grow"): the Home page's motion starts only from the
// person's own press (or the pop-up appearing), never from a redraw that arrived by itself, and
// it is off for reduced-motion, a hidden page and the practice "before" screen. jsdom cannot play
// animations, so Element.animate is replaced by a recorder and the tests read what was asked for.
import { it, expect, afterEach, vi } from 'vitest';
import { mount as mountPage, unmount, q, qa, frame, tick, flip, noCameraPicture } from './home-page-harness';

interface Call { el: Element; frames: Array<Record<string, unknown>>; opts: Record<string, unknown>; anim: Record<string, unknown> }
let calls: Call[] = [];
function recordAnimations() {
  calls = [];
  (Element.prototype as any).animate = function (this: Element, frames: Call['frames'], opts: Call['opts']) {
    const anim = {}; calls.push({ el: this, frames, opts, anim }); return anim;
  };
}
afterEach(() => {
  unmount(); vi.useRealTimers();
  delete (Element.prototype as any).animate; delete (window as any).__motionOff; delete (window as any).matchMedia;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
});
// WHY the recorder is cleared after mounting: the page's first drawing plays its own "wake up" polish
// (home-page-feel.test.ts); these tests are about movement from presses and pop-ups.
async function mount(o: Parameters<typeof mountPage>[0]) { const r = await mountPage(o); calls.length = 0; return r; }
const collapsed = () => ({ open: [] as string[] });
const press = async (el: HTMLElement) => { el.click(); await frame(); };

it('plays a card opening only for the press, and nothing for a redraw that arrives by itself', async () => {
  recordAnimations();
  await mount({ data: collapsed(), fetchHook: noCameraPicture });
  const fold = qa('[data-fold]')[0];
  await press(fold);
  expect(fold.getAttribute('aria-expanded')).toBe('true');
  const cascade = calls.filter((c) => c.opts.delay !== undefined);
  expect(cascade.length).toBeGreaterThan(1); // the rows of what opened, one after another
  expect(cascade.every((c) => c.el.closest('.lights-body'))).toBe(true);
  expect(calls.some((c) => c.el.tagName.toLowerCase() === 'svg')).toBe(true); // the arrow turns
  calls.length = 0;
  flip('light.living_room_lamp'); await frame(); await tick(5000); // a push and a check
  // (the card that changed by itself gets the one quiet shine from home-page-feel.test.ts, nothing else)
  expect(calls.filter((c) => !c.el.parentElement?.classList.contains('fx-glint'))).toEqual([]);
});

it('slides a page in from the side its tab sits on, and back the other way', async () => {
  recordAnimations();
  await mount({ data: collapsed(), fetchHook: noCameraPicture });
  await press(q('#chips [data-view="media"]'));
  const slide = () => calls.filter((c) => c.el.id === 'view' || c.el.id === 'rooms').map((c) => String((c.frames[0] as any).transform));
  expect(slide()).toEqual(['translateX(32px)']);
  calls.length = 0;
  await press(q('#chips [data-home]'));
  expect(slide().every((t) => t === 'translateX(-32px)')).toBe(true);
  expect(slide().length).toBeGreaterThan(0);
});

it('glides a card by the distance it moved, using the same element', async () => {
  recordAnimations();
  let shift = 0;
  const real = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const r = real.call(this); return { ...r, top: this.classList.contains('room') ? shift : 0, left: 0 } as DOMRect;
  };
  try {
    await mount({ data: collapsed(), fetchHook: noCameraPicture });
    qa('[data-fold]')[0].click();
    shift = 40; // the page has redrawn and everything below moved down 40
    await frame();
    const glide = calls.find((c) => c.el.classList.contains('room') && String((c.frames[0] as any).transform).startsWith('translate('));
    expect(String((glide!.frames[0] as any).transform)).toBe('translate(0px,-40px)');
    expect(glide!.anim).toHaveProperty('__mo', 1);
  } finally { Element.prototype.getBoundingClientRect = real; }
});

it('plays nothing when the page is hidden, when reduced motion is asked for, or on the "before" screen', async () => {
  recordAnimations();
  await mount({ data: collapsed(), fetchHook: noCameraPicture });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
  await press(qa('[data-fold]')[0]);
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  (window as any).__motionOff = true;
  await press(qa('[data-fold]')[1]);
  expect(calls).toEqual([]);
  unmount();
  delete (window as any).__motionOff;
  (window as any).matchMedia = () => ({ matches: true });
  await mount({ data: collapsed(), fetchHook: noCameraPicture });
  await press(qa('[data-fold]')[0]);
  expect(calls).toEqual([]);
});

it('grows the pop-up out of its card, fades its contents in after, and shrinks it back on a throw-away copy', async () => {
  recordAnimations();
  await mount({ fetchHook: noCameraPicture });
  await tick(2000); // the page has been open a while
  const card = q('[data-eid="light.living_room_lamp"]');
  card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  const dlg = q('.dlg');
  const opening = calls.filter((c) => dlg.contains(c.el) || c.el === dlg || c.el === dlg.parentElement);
  expect(opening.some((c) => c.el === dlg)).toBe(true);
  expect(opening.filter((c) => c.el.parentElement === dlg).every((c) => (c.opts.delay as number) > 0)).toBe(true); // contents wait for the frame
  calls.length = 0;
  await tick(1000); // history arrives while it is open
  expect(calls).toEqual([]);
  q('[data-dlg-close]').click();
  const ghost = document.body.querySelector(':scope > .dlg-scrim') as HTMLElement;
  expect(ghost).not.toBeNull();
  expect(ghost.inert).toBe(true);
  expect(document.querySelectorAll('#dlg .dlg').length).toBe(0); // the real one is gone at once
  calls.find((c) => c.el === ghost)!.anim.onfinish && (calls.find((c) => c.el === ghost)!.anim as any).onfinish();
  expect(document.body.querySelector(':scope > .dlg-scrim')).toBeNull();
});

it('does not animate a pop-up that is already open when the page loads', async () => {
  recordAnimations();
  await mountPage({ data: { dlg: 'light.living_room_lamp' }, fetchHook: noCameraPicture });
  expect(calls.filter((c) => c.el.closest('#dlg'))).toEqual([]);
});

it('opens an Edit row’s settings the same way: contents drop in one after another', async () => {
  recordAnimations();
  await mount({ data: { editing: true, open: [] }, fetchHook: noCameraPicture });
  const name = qa('[data-act="edopen"]')[0];
  await press(name);
  expect(name.getAttribute('aria-expanded')).toBe('true');
  const menu = q('.edx-menu');
  expect(calls.filter((c) => c.el.parentElement === menu && c.opts.delay !== undefined).length).toBeGreaterThan(1);
});

// Destin, 2026-10-04: "the tab switchers at the top bounce around when I change pages". Two causes:
// a glide on the filled pill, and bold text on the chosen pill that made it wider and pushed its
// neighbours. The row must stay still: no animation on it, and no style that changes a pill's size.
it('leaves the pill row perfectly still when the page changes', async () => {
  recordAnimations();
  await mount({ data: collapsed(), fetchHook: noCameraPicture });
  const boxes = () => qa('#chips .pill').map((p) => p.outerHTML.replace(/ (sel|aria-pressed="\w+")/g, '').length);
  const before = boxes();
  await press(q('#chips [data-view="media"]'));
  await press(q('#chips [data-home]'));
  expect(calls.filter((c) => q('#chips').contains(c.el) || c.el.closest('.toprow'))).toEqual([]);
  expect(boxes()).toEqual(before);
});

it('gives the selected pill no size-changing style (no bolder text, no scale)', async () => {
  const { HOME_ASSISTANT_PAGE_HTML } = await import('../src/renderer/dev/workbench/fixtures/home-assistant-page');
  const rules = (HOME_ASSISTANT_PAGE_HTML.match(/\.pill\.sel[^{]*\{[^}]*\}/g) || []).join(' ');
  expect(rules).not.toMatch(/font-weight|font-size|padding|width|transform|scale/);
});
