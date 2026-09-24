// @vitest-environment jsdom
//
// SessionStrip — the session pill bar and its All Sessions menu. Each section
// below keeps its own window.claude bridge, mount helper and hooks; only the
// jsdom accommodations and the DataTransfer model are shared.
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { render, fireEvent, within } from '@testing-library/react';
import SessionStrip from '../src/renderer/components/SessionStrip';
import { ArtifactProvider } from '../src/renderer/state/ArtifactContext';
import { SESSION_DRAG_MIME, endLocalSessionDrag } from '../src/renderer/session-drag-model';
import type { SessionStatusColor } from '../src/renderer/components/StatusDot';

// The strip packs its pills against the bar parent's clientWidth, which jsdom
// reports as 0 — leaving exactly ONE pill rendered. Hand it a real budget.
//
// The canvas stub is not cosmetic: the strip measures pill labels with
// measureText, and jsdom answers getContext with a "Not implemented" console
// error per call. Fourteen of those per run bury a real failure.
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 1200 });
  (HTMLCanvasElement.prototype as any).getContext = () => ({
    measureText: (t: string) => ({ width: t.length * 7 }),
    font: '',
  });
});
afterAll(() => {
  delete (HTMLElement.prototype as any).clientWidth;
});

/** jsdom has no DataTransfer. Model what the real one does with types/data. */
function transfer(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    get types() { return Array.from(data.keys()); },
    setData: (t: string, v: string) => { data.set(t, v); },
    getData: (t: string) => data.get(t) ?? '',
    setDragImage: vi.fn(),
    dropEffect: 'none',
    effectAllowed: 'uninitialized',
    files: [] as { name: string }[],
  };
}

// ---------------------------------------------------------------------------
// INVARIANT: a row in the All Sessions menu reorders by being dragged UP or
// DOWN the list, from its grip, and lands where the insertion line says.
//
// Why this needs a guard: the menu rows used to share the pill bar's pointer
// drag, whose target slot comes from the cursor's clientX against the BAR's
// geometry with Y "ignored on purpose" — so the one gesture a vertical list
// invites could never land anywhere, while a sideways drag reordered against
// pills the dropdown isn't near. Nothing failed loudly; the grip was simply
// inert, which is invisible to types, lint and every existing test.
//
// Two jsdom limits are worked around here, and BOTH were caught by a test that
// passed for the wrong reason first. jsdom lays nothing out, so each row is
// given a real 40px box below. And a synthetic dragover carries NO clientX or
// clientY at all (measured: both arrive `undefined`), which silently sent
// every case down the same branch of the midline test — so drag events here
// are dispatched as real MouseEvents named 'dragover'/'drop' with the buffer
// attached, which is the only shape that delivers a coordinate.
// ---------------------------------------------------------------------------
describe('All Sessions menu reordering', () => {
  const MY_WINDOW = 1;

  const detach = {
    dragAdopt: vi.fn(),
    detachLive: vi.fn(async () => ({ windowId: 2 })),
    detachStart: vi.fn(),
    dragStarted: vi.fn(),
    dragEnded: vi.fn(),
    dragDropped: vi.fn(),
    openDetached: vi.fn(),
    focusAndSwitch: vi.fn(),
    dropResolve: vi.fn(async () => ({ targetWindowId: null })),
    getDirectory: vi.fn(async () => ({ leaderWindowId: MY_WINDOW, windows: [] })),
    onCrossWindowCursor: vi.fn(() => () => {}),
    onDirectoryUpdated: vi.fn(() => () => {}),
  };

  let facts: { platform: string; wayland: boolean } = { platform: 'linux', wayland: true };

  beforeEach(() => {
    vi.clearAllMocks();
    endLocalSessionDrag();
    if (!document.getElementById('root')) {
      const r = document.createElement('div'); r.id = 'root'; document.body.appendChild(r);
    }
    (window as any).claude = {
      detach,
      platformFacts: facts,
      tags: { list: async () => [] },
      session: { getMeta: async () => ({ tags: [], flags: {}, note: '' }) },
      on: { tagsChanged: () => () => {} },
    };
  });

  const sess = (id: string, name: string) =>
    ({ id, name, cwd: '/home/d/projects/thing', status: 'active', permissionMode: 'normal' }) as any;

  const ROW_H = 40;

  /**
   * The pointer path's drop runs behind `detach.dropResolve()`, so its effects
   * land a couple of microtasks after pointerup. Waiting on the mock settling —
   * not on a clock — keeps the negative assertion above honest.
   */
  async function flushDropResolution() {
    await Promise.all(detach.dropResolve.mock.results.map((r) => r.value).filter(Boolean));
    await Promise.resolve();
  }

  /**
   * fireEvent.dragOver builds an event with NO coordinates — e.clientY arrives
   * `undefined`, so every midline comparison silently takes the same branch. A
   * real MouseEvent under the drag event's name is the only construction jsdom
   * gives a working clientY, with the transfer buffer hung on afterwards.
   */
  function dispatchDrag(el: HTMLElement, type: 'dragover' | 'drop', dt: unknown, clientY: number) {
    const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 150, clientY });
    Object.defineProperty(ev, 'dataTransfer', { value: dt });
    fireEvent(el, ev);
  }

  function openMenu(sessions = [sess('a', 'alpha'), sess('b', 'beta'), sess('c', 'gamma')]) {
    const onReorderSessions = vi.fn();
    const onSelectSession = vi.fn();
    const view = render(
      <ArtifactProvider value={{ state: {} as any, dispatch: vi.fn() } as any}>
        <SessionStrip
          sessions={sessions}
          activeSessionId="a"
          onSelectSession={onSelectSession}
          onCreateSession={vi.fn()}
          onCloseSession={vi.fn()}
          onOpenResumeBrowser={vi.fn()}
          onReorderSessions={onReorderSessions}
          myWindowId={MY_WINDOW}
        />
      </ArtifactProvider>,
    );
    fireEvent.click(view.getByLabelText('All Sessions'));
    const portal = document.getElementById('root') as HTMLElement;
    const list = portal.querySelector('.scroll-fade') as HTMLElement;
    const rows = Array.from(list.querySelectorAll('[data-session-id]')) as HTMLElement[];
    // Give the rows a real stacked layout: row i occupies y = i*ROW_H … +ROW_H,
    // so "above the midline" and "below" are actual positions rather than an
    // artefact of jsdom's all-zero boxes.
    rows.forEach((row, i) => {
      row.getBoundingClientRect = () => ({
        top: i * ROW_H, bottom: i * ROW_H + ROW_H, height: ROW_H,
        left: 0, right: 300, width: 300, x: 0, y: i * ROW_H, toJSON: () => ({}),
      }) as DOMRect;
    });
    const grips = rows.map((r) => r.querySelector('[data-menu-drag-grip]') as HTMLElement);
    return { ...view, onReorderSessions, onSelectSession, list, rows, grips };
  }

  /**
   * Drag row `from` by its grip and drop it over row `over`. `half` picks which
   * side of that row's midline the cursor is on — the only thing separating
   * "lands before this row" from "lands after it". With jsdom's zero-height
   * boxes, clientY 0 reads as at-or-below the midline and -1 as above it.
   */
  function dragRowOnto(
    g: ReturnType<typeof openMenu>, from: number, over: number, half: 'above' | 'below' = 'below',
  ) {
    const dt = transfer();
    fireEvent.dragStart(g.grips[from], { dataTransfer: dt });
    const y = over * ROW_H + (half === 'above' ? ROW_H * 0.25 : ROW_H * 0.75);
    dispatchDrag(g.rows[over], 'dragover', dt, y);
    dispatchDrag(g.list, 'drop', dt, y);
    return dt;
  }

  describe('All Sessions menu — reordering by drag', () => {
    it('the grip is the handle, and it carries the row\'s session', () => {
      const g = openMenu();
      expect(g.grips.every(Boolean)).toBe(true);
      expect(g.grips[1].getAttribute('draggable')).toBe('true');
      const dt = transfer();
      fireEvent.dragStart(g.grips[1], { dataTransfer: dt });
      expect(dt.getData(SESSION_DRAG_MIME)).toBe('b');
      expect(dt.effectAllowed).toBe('move');
    });

    it('dragging a row DOWN the list moves it — the gesture that used to do nothing', () => {
      const g = openMenu();
      // alpha(0) dropped onto gamma(2): lands after it, slot 3 → index 2 once
      // alpha itself is spliced out.
      dragRowOnto(g, 0, 2);
      expect(g.onReorderSessions).toHaveBeenCalledWith(0, 2);
    });

    it('dragging a row UP the list moves it', () => {
      const g = openMenu();
      // gamma(2) dropped onto alpha(0): slot 1, and 1 < 2 so no shift.
      dragRowOnto(g, 2, 0);
      expect(g.onReorderSessions).toHaveBeenCalledWith(2, 1);
    });

    // The midline is the whole difference between "lands before this row" and
    // "lands after it". Two tests, not one: a second <SessionStrip> mounted
    // alongside the first makes every by-title query ambiguous.
    it('released on the TOP half, the row lands before the one under the cursor', () => {
      const g = openMenu();
      dragRowOnto(g, 0, 2, 'above');
      expect(g.onReorderSessions).toHaveBeenCalledWith(0, 1);
    });

    it('released on the BOTTOM half, it lands after it', () => {
      const g = openMenu();
      dragRowOnto(g, 0, 2, 'below');
      expect(g.onReorderSessions).toHaveBeenCalledWith(0, 2);
    });

    it('dropping a row back where it started changes nothing', () => {
      const g = openMenu();
      dragRowOnto(g, 1, 1);          // slot 2, from 1 → to 1
      expect(g.onReorderSessions).not.toHaveBeenCalled();
    });

    it('a released drag never leaves the list stuck as a drop target', () => {
      const g = openMenu();
      const dt = transfer();
      fireEvent.dragStart(g.grips[0], { dataTransfer: dt });
      fireEvent.dragEnd(g.grips[0], { dataTransfer: dt });
      fireEvent.drop(g.list, { dataTransfer: transfer() });   // stray drop, no payload
      expect(g.onReorderSessions).not.toHaveBeenCalled();
      expect(detach.dragAdopt).not.toHaveBeenCalled();
    });

    it('a row from ANOTHER window dropped on the list is still an adoption, not a reorder', () => {
      const g = openMenu();
      const dt = transfer({ [SESSION_DRAG_MIME]: 'from-elsewhere' });
      fireEvent.dragOver(g.list, { dataTransfer: dt });
      fireEvent.drop(g.list, { dataTransfer: dt });
      expect(detach.dragAdopt).toHaveBeenCalledWith({ sessionId: 'from-elsewhere' });
      expect(g.onReorderSessions).not.toHaveBeenCalled();
    });

    it('pressing the grip does not start the pill bar\'s pointer drag', async () => {
      // The two systems must not both claim the gesture: taking pointer capture
      // here can stop the browser ever firing dragstart. The tell is the pointer
      // path's own drop behaviour — it selects the session it released — and it
      // lands a few microtasks later, behind the async cross-window drop
      // resolution, so the assertion has to wait for it or it passes vacuously.
      const g = openMenu();
      fireEvent.pointerDown(g.grips[1], { button: 0, clientX: 40, clientY: 200, pointerId: 1, pointerType: 'mouse' });
      fireEvent.pointerMove(g.rows[1], { clientX: 200, clientY: 200, pointerId: 1, pointerType: 'mouse' });
      fireEvent.pointerUp(g.rows[1], { clientX: 200, clientY: 200, pointerId: 1, pointerType: 'mouse' });
      await flushDropResolution();
      expect(g.onReorderSessions).not.toHaveBeenCalled();
      expect(g.onSelectSession).not.toHaveBeenCalled();
    });

    it('the pill bar carries no grip, so the bail can never reach a pill drag', () => {
      // handlePointerDown is shared with the header's pill drag — eleven review
      // rounds of motion ride on it. The bail is safe there only because nothing
      // in the bar matches its selector; put a grip in a pill and every pill drag
      // dies silently. This is the guard for that, and it is why the change did
      // not have to be gated on the platform.
      const g = openMenu();
      const bar = g.container.querySelector('[data-session-strip]') as HTMLElement;
      expect(bar).toBeTruthy();
      expect(bar.querySelectorAll('[data-menu-drag-grip]').length).toBe(0);
      expect(bar.querySelectorAll('[data-session-idx]').length).toBeGreaterThan(0);
    });

    it('pressing the row anywhere else still reaches the pointer path', async () => {
      // The menu's tear-off-to-a-new-window on Windows/macOS rides that path;
      // narrowing the bail to the grip is what keeps it alive. This is the
      // positive control for the test above — same wait, opposite expectation.
      const g = openMenu();
      const name = within(g.rows[1]).getByText('beta');
      fireEvent.pointerDown(name, { button: 0, clientX: 200, clientY: 200, pointerId: 1, pointerType: 'mouse' });
      fireEvent.pointerUp(name, { clientX: 200, clientY: 200, pointerId: 1, pointerType: 'mouse' });
      await flushDropResolution();
      expect(g.onSelectSession).toHaveBeenCalledWith('b');
    });
  });

  describe('All Sessions menu — reordering on the live-window platforms', () => {
    beforeAll(() => { facts = { platform: 'win32', wayland: false }; });
    afterAll(() => { facts = { platform: 'linux', wayland: true }; });

    it('works there too — the grip is not gated on the tear-off model', () => {
      const g = openMenu();
      dragRowOnto(g, 0, 2);
      expect(g.onReorderSessions).toHaveBeenCalledWith(0, 2);
    });
  });
});

// ---------------------------------------------------------------------------
// INVARIANT: on the 'html-drag' tear-off model (Linux/Wayland) the pill is a
// browser-native draggable whose drag carries the session id under the private
// MIME type and offers 'move'; a session dropped on this window's strip from
// another window is claimed by it; our own pill dropped back on the strip is a
// reorder; a foreign file drop is left alone; and the pills are NOT draggable
// on any other platform, where the pointer path owns the whole gesture.
//
// What jsdom CANNOT prove is that the compositor delivers a drag between two
// real windows, or what the picture looks like; both were measured directly
// (two-window probe, 2026-09-04: drops in both directions, session id intact,
// a 330px picture whole and crisp at 1.5x). What is pinned here is the
// routing, which is where a regression would actually hide.
// ---------------------------------------------------------------------------
describe('html-drag tear-off', () => {
  const MY_WINDOW = 1;

  const detach = {
    dragAdopt: vi.fn(),
    detachLive: vi.fn(async () => ({ windowId: 2 })),
    detachStart: vi.fn(),
    dragStarted: vi.fn(),
    dragEnded: vi.fn(),
    dragDropped: vi.fn(),
    openDetached: vi.fn(),
    dropResolve: vi.fn(async () => ({ targetWindowId: null })),
    getDirectory: vi.fn(async () => ({ leaderWindowId: MY_WINDOW, windows: [] })),
    onCrossWindowCursor: vi.fn(() => () => {}),
    onDirectoryUpdated: vi.fn(() => () => {}),
  };

  let facts: { platform: string; wayland: boolean } = { platform: 'linux', wayland: true };

  beforeEach(() => {
    vi.clearAllMocks();
    endLocalSessionDrag();
    (window as any).claude = {
      detach,
      platformFacts: facts,
      tags: { list: async () => [] },
      on: { tagsChanged: () => () => {} },
    };
  });

  function sess(id: string, name: string) {
    return { id, name, cwd: '/tmp', status: 'active', permissionMode: 'normal' } as any;
  }

  function mount(extra: Partial<React.ComponentProps<typeof SessionStrip>> = {}) {
    const onReorderSessions = vi.fn();
    const onSelectSession = vi.fn();
    const view = render(
      <ArtifactProvider value={{ state: {} as any, dispatch: vi.fn() } as any}>
        <SessionStrip
          sessions={[sess('a', 'alpha'), sess('b', 'beta'), sess('c', 'gamma')]}
          activeSessionId="a"
          onSelectSession={onSelectSession}
          onCreateSession={vi.fn()}
          onCloseSession={vi.fn()}
          onOpenResumeBrowser={vi.fn()}
          onReorderSessions={onReorderSessions}
          myWindowId={MY_WINDOW}
          {...extra}
        />
      </ArtifactProvider>,
    );
    const bar = view.container.querySelector('[data-session-strip]') as HTMLElement;
    const pills = Array.from(view.container.querySelectorAll('[data-session-idx]')) as HTMLElement[];
    return { ...view, bar, pills, onReorderSessions, onSelectSession };
  }

  const sessionDrag = (id: string) => transfer({ [SESSION_DRAG_MIME]: id });
  const fileDrag = () => Object.assign(transfer({ Files: '' }), { files: [{ name: 'quarterly-report.pdf' }] });

  describe('SessionStrip — html-drag (Linux/Wayland)', () => {
    it('makes every pill a browser draggable', () => {
      const { pills } = mount();
      expect(pills.length).toBe(3);
      expect(pills.every((p) => p.getAttribute('draggable') === 'true')).toBe(true);
    });

    it('dragstart carries the session id under the private type and offers a MOVE', () => {
      const { pills } = mount();
      const dt = transfer();
      fireEvent.pointerDown(pills[1], { button: 0, clientX: 100, clientY: 10, pointerId: 1, pointerType: 'mouse' });
      fireEvent.dragStart(pills[1], { dataTransfer: dt, clientX: 100, clientY: 10 });
      expect(dt.getData(SESSION_DRAG_MIME)).toBe('b');
      expect(dt.effectAllowed).toBe('move');
      // The picture is the pill itself, snapshotted — never main's link-drag helper.
      expect(dt.setDragImage).toHaveBeenCalled();
      // No screen-coordinate ticker: on Wayland it would stream zeros.
      expect(detach.dragStarted).not.toHaveBeenCalled();
    });

    it('claims a session dropped on it from another window, naming ONLY the session', () => {
      const { bar } = mount();
      const dt = sessionDrag('from-elsewhere');
      fireEvent.dragOver(bar, { dataTransfer: dt });
      expect(dt.dropEffect).toBe('move');
      fireEvent.drop(bar, { dataTransfer: dt });
      expect(detach.dragAdopt).toHaveBeenCalledWith({ sessionId: 'from-elsewhere' });
      // A renderer-supplied source window could misdirect a transfer, so none is sent.
      expect(Object.keys(detach.dragAdopt.mock.calls[0][0])).toEqual(['sessionId']);
    });

    it('our own pill dropped back on the strip is a reorder, not an adoption', () => {
      const { bar, pills, onReorderSessions, onSelectSession } = mount();
      const dt = transfer();
      fireEvent.pointerDown(pills[0], { button: 0, clientX: 20, clientY: 10, pointerId: 1, pointerType: 'mouse' });
      fireEvent.dragStart(pills[0], { dataTransfer: dt, clientX: 20, clientY: 10 });
      // jsdom lays nothing out, so no slot is ever "nearest": the drop lands
      // in place. What is pinned is the ROUTE — local commit, no adopt.
      fireEvent.dragOver(bar, { dataTransfer: dt, clientX: 200, clientY: 10 });
      fireEvent.drop(bar, { dataTransfer: dt, clientX: 200, clientY: 10 });
      expect(detach.dragAdopt).not.toHaveBeenCalled();
      expect(onSelectSession).toHaveBeenCalledWith('a');
      expect(onReorderSessions.mock.calls.every(([from, to]) => typeof from === 'number' && typeof to === 'number')).toBe(true);
    });

    it('leaves a real file drop completely alone', () => {
      const { bar } = mount();
      const dt = fileDrag();
      fireEvent.dragOver(bar, { dataTransfer: dt });
      fireEvent.drop(bar, { dataTransfer: dt });
      expect(detach.dragAdopt).not.toHaveBeenCalled();
      expect(dt.dropEffect).toBe('none'); // never claimed the drag
    });

    it('a drag that nothing accepted opens a new window — the desktop drop, as on Windows', () => {
      // Escape ends a drag identically (dropEffect 'none'); Destin chose the
      // desktop drop over Escape — cancelling is dragging back into the strip.
      const { pills } = mount();
      const dt = transfer();
      fireEvent.pointerDown(pills[0], { button: 0, clientX: 20, clientY: 10, pointerId: 1, pointerType: 'mouse' });
      fireEvent.dragStart(pills[0], { dataTransfer: dt, clientX: 20, clientY: 10 });
      fireEvent.dragEnd(pills[0], { dataTransfer: dt });   // dropEffect stays 'none'
      expect(detach.openDetached).toHaveBeenCalledWith({ sessionId: 'a' });
      expect(detach.detachStart).not.toHaveBeenCalled();
    });

    it('a drag something accepted does NOT also open a window', () => {
      const { pills } = mount();
      const dt = transfer();
      fireEvent.dragStart(pills[0], { dataTransfer: dt, clientX: 20, clientY: 10 });
      dt.dropEffect = 'move';
      fireEvent.dragEnd(pills[0], { dataTransfer: dt });
      expect(detach.openDetached).not.toHaveBeenCalled();
    });

    it("a window's only session goes back instead of opening an identical window", () => {
      const { pills } = mount({ sessions: [sess('only', 'solo')] });
      const dt = transfer();
      fireEvent.dragStart(pills[0], { dataTransfer: dt, clientX: 20, clientY: 10 });
      fireEvent.dragEnd(pills[0], { dataTransfer: dt });
      expect(detach.openDetached).not.toHaveBeenCalled();
    });

    it('right-click offers "Move to new window" and every other window by name', () => {
      const { pills, getByText } = mount({
        windowDirectory: {
          leaderWindowId: MY_WINDOW,
          windows: [
            { window: { id: MY_WINDOW, label: 'window 1', createdAt: 0 }, sessions: [] },
            { window: { id: 7, label: 'window 2', createdAt: 0 }, sessions: [sess('z', 'zeta')] },
          ],
        } as any,
      });
      fireEvent.contextMenu(pills[1], { clientX: 50, clientY: 20 });
      fireEvent.click(getByText('Move to new window'));
      expect(detach.openDetached).toHaveBeenCalledWith({ sessionId: 'b' });
      fireEvent.contextMenu(pills[1], { clientX: 50, clientY: 20 });
      fireEvent.click(getByText(/Move to window 2/));
      expect(detach.dragDropped).toHaveBeenCalledWith({ sessionId: 'b', targetWindowId: 7, insertIndex: 0 });
    });

    it('the menu refuses to tear off a window\'s only session', () => {
      const { pills, getByText } = mount({ sessions: [sess('only', 'solo')] });
      fireEvent.contextMenu(pills[0], { clientX: 50, clientY: 20 });
      const item = getByText('Move to new window').closest('button, [role="menuitem"]') as HTMLElement;
      expect(item).toBeTruthy();
      expect(item.getAttribute('aria-disabled') === 'true' || (item as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(item);
      expect(detach.openDetached).not.toHaveBeenCalled();
    });
  });

  describe('SessionStrip — every other platform is untouched', () => {
    // beforeAll, not beforeEach: the outer beforeEach copies `facts` onto
    // window.claude and runs FIRST, so a sibling beforeEach would set it one
    // test too late — and the test would pass for the wrong reason.
    beforeAll(() => { facts = { platform: 'win32', wayland: false }; });
    afterAll(() => { facts = { platform: 'linux', wayland: true }; });

    it('pills are not browser-draggable: the pointer path owns the gesture', () => {
      const { pills } = mount();
      expect(pills.some((p) => p.getAttribute('draggable') === 'true')).toBe(false);
    });

    it('does not claim a dropped session: Windows keeps the live tear-off', () => {
      const { bar } = mount();
      const dt = sessionDrag('from-elsewhere');
      fireEvent.dragOver(bar, { dataTransfer: dt });
      fireEvent.drop(bar, { dataTransfer: dt });
      expect(detach.dragAdopt).not.toHaveBeenCalled();
      expect(dt.dropEffect).toBe('none'); // never claimed the drag either
    });
  });
});

// The session switcher's rename affordance, as decided on the
// session-switcher-rename deck (SR-3, "pencil only"). The point of that choice
// over the saved-conversation list's dotted-underline treatment is that the
// NAME must keep switching sessions — so both halves are pinned here, not just
// the pencil's existence.
describe('renaming from the session list', () => {
  const MY_WINDOW = 1;

  const detach = {
    dragAdopt: vi.fn(), detachLive: vi.fn(async () => ({ windowId: 2 })), detachStart: vi.fn(),
    dragStarted: vi.fn(), dragEnded: vi.fn(), dragDropped: vi.fn(),
    openDetached: vi.fn(), dropResolve: vi.fn(async () => ({ targetWindowId: null })),
    getDirectory: vi.fn(async () => ({ leaderWindowId: MY_WINDOW, windows: [] })),
    onCrossWindowCursor: vi.fn(() => () => {}), onDirectoryUpdated: vi.fn(() => () => {}),
  };

  function bridge(withNaming: boolean) {
    (window as any).claude = {
      detach,
      platformFacts: { platform: 'linux', wayland: true },
      tags: { list: async () => [] },
      session: { getMeta: async () => ({ tags: [], note: '' }) },
      on: { tagsChanged: () => () => {} },
      ...(withNaming ? { sessionNaming: {
        get: async () => ({ mode: 'basic', model: null }),
        set: async () => {},
        title: async (_id: string, fallback: string) => ({ title: fallback, manual: false }),
        rename: async () => {},
      } } : {}),
    };
  }

  const sess = (id: string, name: string) =>
    ({ id, name, cwd: '/tmp', status: 'active', permissionMode: 'normal' }) as any;

  function mount() {
    const onSelectSession = vi.fn();
    // The dropdown portals into #root (so it inherits the theme class), which
    // jsdom does not have unless the test makes one.
    const root = document.createElement('div');
    root.id = 'root';
    document.body.appendChild(root);
    const view = render(
      <ArtifactProvider value={{ state: {} as any, dispatch: vi.fn() } as any}>
        <SessionStrip
          sessions={[sess('a', 'alpha'), sess('b', 'beta')]}
          activeSessionId="a"
          onSelectSession={onSelectSession}
          onCreateSession={vi.fn()}
          onCloseSession={vi.fn()}
          onOpenResumeBrowser={vi.fn()}
          onReorderSessions={vi.fn()}
          myWindowId={MY_WINDOW}
        />
      </ArtifactProvider>,
      { container: root },
    );
    // Open the "Sessions in this window" list.
    fireEvent.click(view.container.querySelector('[data-hint="All Sessions"]')!);
    // `data-session-id` is on the pill in the strip AND on the dropdown row.
    // Only the dropdown one is the subject here.
    const row = (id: string) => {
      const all = Array.from(document.querySelectorAll(`[data-session-id="${id}"]`)) as HTMLElement[];
      const inMenu = all.find((el) => !el.closest('[data-session-strip]'));
      if (!inMenu) throw new Error(`no dropdown row for ${id} (found ${all.length} candidates)`);
      return inMenu;
    };
    return { ...view, row, onSelectSession };
  }

  beforeEach(() => { vi.clearAllMocks(); document.body.innerHTML = ''; });

  describe('SessionStrip — renaming from the session list', () => {
    it('gives every row a pencil beside its name', () => {
      bridge(true);
      const { row } = mount();
      expect(within(row('a')).getByRole('button', { name: 'Rename alpha' })).toBeTruthy();
      expect(within(row('b')).getByRole('button', { name: 'Rename beta' })).toBeTruthy();
    });

    it('shows no pencil where naming has no backend', () => {
      // An Android phone running Claude Code locally: the bridge is absent, so
      // the row must look exactly as it did before naming existed.
      bridge(false);
      const { row } = mount();
      expect(within(row('a')).queryByRole('button', { name: 'Rename alpha' })).toBeNull();
    });

    it('clicking the NAME still switches to that session', () => {
      // This is the whole reason the dotted-underline treatment was not chosen:
      // the name is the most natural thing to click to switch.
      bridge(true);
      const { row, onSelectSession } = mount();
      fireEvent.click(within(row('b')).getByText('beta'));
      expect(onSelectSession).toHaveBeenCalledWith('b');
    });

    it('clicking the pencil opens the rename dialog and does NOT switch session', () => {
      bridge(true);
      const { row, onSelectSession } = mount();
      fireEvent.click(within(row('b')).getByRole('button', { name: 'Rename beta' }));
      expect(onSelectSession).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain('Rename session');
    });

    it('the pencil is a real button, not an element nested inside one', () => {
      // Nesting interactive content inside a <button> is invalid and confuses
      // screen readers, which is why the row is a div role="button".
      bridge(true);
      const { row } = mount();
      const pencil = within(row('a')).getByRole('button', { name: 'Rename alpha' });
      expect(pencil.tagName).toBe('BUTTON');
      expect(pencil.closest('button')).toBe(pencil);
    });

    it('the row is reachable and operable by keyboard', () => {
      bridge(true);
      const { row, onSelectSession } = mount();
      const target = within(row('b')).getByRole('button', { name: 'beta' });
      expect(target.getAttribute('tabindex')).toBe('0');
      fireEvent.keyDown(target, { key: 'Enter' });
      expect(onSelectSession).toHaveBeenCalledWith('b');
    });
  });
});

// ---------------------------------------------------------------------------
// INVARIANT: a "sessions in other windows" row is a REAL row, not a label —
// its X closes that session (passing the name, because App cannot look a peer
// session's name up in its own list), dragging it into this window's list
// claims it, and its status pill shows the colour the merge produced, green
// included.
//
// Before this section was rebuilt these were a flat button with a bare dot:
// no close, no drag, and always "Inactive". Each behaviour here is one that
// silently reverts to doing nothing if the handler is unhooked — the failure
// mode is a dead control, which no type or lint check can see.
// ---------------------------------------------------------------------------
describe('sessions in other windows', () => {
  const MY_WINDOW = 1;
  const PEER_WINDOW = 2;

  const detach = {
    dragAdopt: vi.fn(),
    detachLive: vi.fn(async () => ({ windowId: PEER_WINDOW })),
    detachStart: vi.fn(),
    dragStarted: vi.fn(),
    dragEnded: vi.fn(),
    dragDropped: vi.fn(),
    openDetached: vi.fn(),
    focusAndSwitch: vi.fn(),
    dropResolve: vi.fn(async () => ({ targetWindowId: null })),
    getDirectory: vi.fn(async () => ({ leaderWindowId: MY_WINDOW, windows: [] })),
    onCrossWindowCursor: vi.fn(() => () => {}),
    onDirectoryUpdated: vi.fn(() => () => {}),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    endLocalSessionDrag();
    // The dropdown portals into #root (not body) so the app's theme/font vars
    // reach it; jsdom starts with neither, so create it or createPortal throws.
    if (!document.getElementById('root')) {
      const root = document.createElement('div');
      root.id = 'root';
      document.body.appendChild(root);
    }
    (window as any).claude = {
      detach,
      platformFacts: { platform: 'linux', wayland: true },
      tags: { list: async () => [] },
      session: { getMeta: async () => ({ tags: [], flags: {}, note: '' }) },
      on: { tagsChanged: () => () => {} },
    };
  });

  function sess(id: string, name: string) {
    return { id, name, cwd: '/home/d/projects/thing', status: 'active', permissionMode: 'normal' } as any;
  }

  function mount(statuses: Array<[string, SessionStatusColor]> = []) {
    const onCloseSession = vi.fn();
    const view = render(
      <ArtifactProvider value={{ state: {} as any, dispatch: vi.fn() } as any}>
        <SessionStrip
          sessions={[sess('local', 'my session')]}
          activeSessionId="local"
          onSelectSession={vi.fn()}
          onCreateSession={vi.fn()}
          onCloseSession={onCloseSession}
          onOpenResumeBrowser={vi.fn()}
          onReorderSessions={vi.fn()}
          myWindowId={MY_WINDOW}
          sessionStatuses={new Map<string, SessionStatusColor>(statuses)}
          windowDirectory={{
            leaderWindowId: MY_WINDOW,
            windows: [
              { window: { id: MY_WINDOW, label: 'window 1', createdAt: 0 }, sessions: [sess('local', 'my session')] },
              { window: { id: PEER_WINDOW, label: 'window 2', createdAt: 0 }, sessions: [sess('theirs', 'their session')] },
            ],
          } as any}
        />
      </ArtifactProvider>,
    );
    // Open the switcher. The dropdown is portalled out of the strip, so scope
    // queries to document.body rather than the container.
    fireEvent.click(view.getByLabelText('All Sessions'));
    const heading = view.getByText('Sessions in other windows');
    const peerList = heading.nextElementSibling as HTMLElement;
    // Both lists carry `.scroll-fade`; the local one is the one that is not the
    // peer container. Picking by index would silently follow a reorder.
    const localList = Array.from(document.body.querySelectorAll('.scroll-fade'))
      .find((el) => el !== peerList) as HTMLElement;
    return { ...view, peerList, localList, onCloseSession };
  }

  describe('session switcher — sessions in other windows', () => {
    it('closes that session, and names it so the confirm prompt is not blank', () => {
      // App looks names up in its OWN session list, which by definition does not
      // contain a peer session — without the name the prompt reads "this session".
      const { peerList, onCloseSession } = mount();
      fireEvent.click(within(peerList).getByLabelText('Close Session'));
      expect(onCloseSession).toHaveBeenCalledWith('theirs', 'their session');
    });

    it('is draggable, and dropping it on this window\'s list claims it', () => {
      const { peerList, localList } = mount();
      const row = within(peerList).getByLabelText('Close Session').closest('[draggable]') as HTMLElement;
      expect(row.getAttribute('draggable')).toBe('true');

      const dt = transfer();
      fireEvent.dragStart(row, { dataTransfer: dt });
      expect(dt.getData(SESSION_DRAG_MIME)).toBe('theirs');

      fireEvent.dragOver(localList, { dataTransfer: dt });
      expect(dt.dropEffect).toBe('move');
      fireEvent.drop(localList, { dataTransfer: dt });
      expect(detach.dragAdopt).toHaveBeenCalledWith({ sessionId: 'theirs' });
    });

    it('shows the peer session as Working when the cross-window feed says green', () => {
      const { peerList } = mount([['theirs', 'green']]);
      expect(within(peerList).getByText('Working')).toBeTruthy();
    });

    it('shows Inactive when nothing knows the peer session\'s status', () => {
      const { peerList } = mount();
      expect(within(peerList).getByText('Inactive')).toBeTruthy();
    });

    it('ignores a foreign drag over this window\'s list', () => {
      const { localList } = mount();
      const dt = Object.assign(transfer({ Files: '' }), { files: [{ name: 'notes.pdf' }] });
      fireEvent.dragOver(localList, { dataTransfer: dt });
      fireEvent.drop(localList, { dataTransfer: dt });
      expect(detach.dragAdopt).not.toHaveBeenCalled();
      expect(dt.dropEffect).toBe('none');
    });
  });
});
