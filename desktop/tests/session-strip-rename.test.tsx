// @vitest-environment jsdom
//
// The session switcher's rename affordance, as decided on the
// session-switcher-rename deck (SR-3, "pencil only"). The point of that choice
// over the saved-conversation list's dotted-underline treatment is that the
// NAME must keep switching sessions — so both halves are pinned here, not just
// the pencil's existence.
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { render, fireEvent, within } from '@testing-library/react';
import SessionStrip from '../src/renderer/components/SessionStrip';
import { ArtifactProvider } from '../src/renderer/state/ArtifactContext';

const MY_WINDOW = 1;

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 1200 });
  (HTMLCanvasElement.prototype as any).getContext = () => ({
    measureText: (t: string) => ({ width: t.length * 7 }), font: '',
  });
});
afterAll(() => { delete (HTMLElement.prototype as any).clientWidth; });

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
  fireEvent.click(view.container.querySelector('[title="All Sessions"]')!);
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
