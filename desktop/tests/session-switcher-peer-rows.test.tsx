// @vitest-environment jsdom
//
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
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { render, fireEvent, within } from '@testing-library/react';
import SessionStrip from '../src/renderer/components/SessionStrip';
import { ArtifactProvider } from '../src/renderer/state/ArtifactContext';
import { SESSION_DRAG_MIME, endLocalSessionDrag } from '../src/renderer/session-drag-model';
import type { SessionStatusColor } from '../src/renderer/components/StatusDot';

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

// Same two jsdom accommodations the html-drag test documents: the strip packs
// pills against a clientWidth jsdom reports as 0, and measures labels with a
// canvas jsdom does not implement.
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
