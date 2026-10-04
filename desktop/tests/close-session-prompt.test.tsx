// @vitest-environment jsdom
// desktop/tests/close-session-prompt.test.tsx
//
// The close prompt as settled over ten workbench comparison rounds
// (?mode=workbench&view=compare, surface close-prompt-body). Four of these pin
// decisions that are easy to undo by accident:
//
//   1. The tag/note EDITOR is collapsed by default. The dialog's primary button
//      is "Close session"; a tag list and a textarea in front of it is a form
//      standing between the user and the thing they asked for.
//   2. Save COLLAPSES the editor and writes nothing. The label invites someone
//      to wire it to onConfirm later, which would close the dialog mid-edit.
//   3. Reserved flags PRELOAD from the session and round-trip. Priority renders
//      as an ordinary tag here, so a session already flagged Priority must show
//      it applied, and un-toggling it must CLEAR it. The old contract was
//      set-only (`flags: FlagName[]`, every entry written true), which would
//      silently ignore the un-toggle.
//   4. Complete is still a fresh yes/no on the same result object.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import CloseSessionPrompt from '../src/renderer/components/CloseSessionPrompt';

afterEach(cleanup);

const TAGS = [
  { id: 'tag_work', label: 'work', color: 'tag-blue', archived: false, createdAt: '' },
  { id: 'tag_bug', label: 'bug', color: 'tag-red', archived: false, createdAt: '' },
];

function mockWindowClaude(meta: Record<string, unknown>) {
  (window as any).claude = {
    session: { getMeta: vi.fn().mockResolvedValue(meta) },
    tags: { list: vi.fn().mockResolvedValue(TAGS), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    on: {},
  };
}

function mount(onConfirm = vi.fn()) {
  render(
    <CloseSessionPrompt
      open
      sessionName="fix chat scroll stick"
      sessionId="sess-1"
      onCancel={() => {}}
      onConfirm={onConfirm}
    />,
  );
  return onConfirm;
}

describe('CloseSessionPrompt', () => {
  beforeEach(() => vi.clearAllMocks());

  it('opens collapsed — no tag editor in front of the close button', async () => {
    mockWindowClaude({ tags: [], note: '', supported: true, flags: {} });
    mount();
    // Each row says its own emptiness — the glyph column means "tags" and
    // "note" are never named in words, so the empty text carries it.
    expect(await screen.findByText('No tags')).toBeInTheDocument();
    expect(screen.getByText('No note')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Search or create a tag…')).not.toBeInTheDocument();
  });

  it('summarises what is already applied, and opens the editor on click', async () => {
    mockWindowClaude({ tags: ['tag_work'], note: 'blocked on the gh dead-end', supported: true, flags: { priority: true } });
    mount();
    // Priority is a flag, not a tag id — it shows as the pin (pick-menus-2#PM2-3).
    expect(await screen.findByRole('img', { name: 'Pinned to top' })).toBeInTheDocument();
    expect(screen.getByText('work')).toBeInTheDocument();
    // Rendered in typographic quotes, so match on substring rather than equality.
    expect(screen.getByText(/blocked on the gh dead-end/)).toBeInTheDocument();

    // The way in is the whole card; the pencil is decoration on top of it, so
    // the accessible name is what a test (and a screen reader) has to use.
    fireEvent.click(screen.getByRole('button', { name: 'Edit tags and note' }));
    expect(await screen.findByPlaceholderText('Search or create a tag…')).toBeInTheDocument();
  });

  it('closes the editor with Save, returning to the summary', async () => {
    // Save commits nothing on its own — it collapses the editor. The dialog's
    // own button is what writes. Pinned because a "Save" label invites someone
    // to wire it to onConfirm later, which would close the dialog mid-edit.
    mockWindowClaude({ tags: [], note: '', supported: true, flags: {} });
    const onConfirm = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit tags and note' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    expect(await screen.findByText('No tags')).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('clears a preloaded Priority when the user un-toggles it', async () => {
    // The regression the flag-delta contract exists for: under the old
    // set-only shape this emitted nothing and Priority stayed applied.
    mockWindowClaude({ tags: [], note: '', supported: true, flags: { priority: true } });
    const onConfirm = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit tags and note' }));
    fireEvent.click(await screen.findByRole('switch', { name: 'Pin to top' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close session' }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    expect(onConfirm.mock.calls[0][0].flags).toEqual({ priority: false });
  });

  it('sends nothing for a flag the user never touched', async () => {
    mockWindowClaude({ tags: [], note: '', supported: true, flags: { priority: true } });
    const onConfirm = mount();
    await screen.findByRole('img', { name: 'Pinned to top' });
    fireEvent.click(screen.getByRole('button', { name: 'Close session' }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    // A delta, not a snapshot — an untouched flag must not be rewritten.
    expect(onConfirm.mock.calls[0][0].flags).toEqual({});
  });

  // P-15 (2026-08-25 UI audit): header comes from the shared Dialog shell (so
  // the ✕ exists), and "Don't show again" is a real switch on its own row
  // rather than a bespoke pill wedged beside the buttons.
  it('uses the shared header and a real switch for "Don\'t show again"', async () => {
    mockWindowClaude({ tags: [], note: '', supported: true, flags: {} });
    // jsdom here has no localStorage; install a Map-backed stub (same shape
    // handle-prompt.test.tsx uses) so the suppress write can be observed.
    const store = new Map<string, string>();
    const stub = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    };
    Object.defineProperty(globalThis, 'localStorage', { value: stub, configurable: true, writable: true });
    (window as any).localStorage = stub;
    const onConfirm = mount();
    await screen.findByText('No tags');
    expect(screen.getByRole('heading', { name: 'Close session' })).toBeInTheDocument();
    expect(screen.getByText('fix chat scroll stick')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close Close session' })).toBeInTheDocument();

    const sw = screen.getByRole('switch', { name: "Don't show again" });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(sw);
    expect(sw).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Close session' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    // The switch still drives the suppress flag the caller reads on the next close.
    expect(store.get('youcoded-close-prompt-disabled')).toBe('1');
  });

  it('marks complete from the toggle at the bottom', async () => {
    mockWindowClaude({ tags: [], note: '', supported: true, flags: {} });
    const onConfirm = mount();
    fireEvent.click(await screen.findByRole('switch', { name: 'Mark complete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close session' }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    expect(onConfirm.mock.calls[0][0].flags).toEqual({ complete: true });
  });
});
