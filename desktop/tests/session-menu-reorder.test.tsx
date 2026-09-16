// @vitest-environment jsdom
//
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
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { render, fireEvent, within } from '@testing-library/react';
import SessionStrip from '../src/renderer/components/SessionStrip';
import { ArtifactProvider } from '../src/renderer/state/ArtifactContext';
import { SESSION_DRAG_MIME, endLocalSessionDrag } from '../src/renderer/session-drag-model';

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

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 1200 });
  (HTMLCanvasElement.prototype as any).getContext = () => ({
    measureText: (t: string) => ({ width: t.length * 7 }),
    font: '',
  });
});
afterAll(() => { delete (HTMLElement.prototype as any).clientWidth; });

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
