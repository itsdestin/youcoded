// @vitest-environment jsdom
// desktop/tests/close-session-prompt.test.tsx
//
// The close prompt is Session details (backlog row 17, deck close-session-1): the session's
// own card, the Tags card edited in place, one card for Pin to top and Mark complete. What
// these pin is easy to undo by accident:
//
//   1. Nothing is written until Close session. The cards edit local state and the caller
//      writes a DELTA — Cancel (the ✕) leaves nothing behind.
//   2. Reserved flags PRELOAD from the session and round-trip: a session already pinned
//      shows pinned, and un-pinning must CLEAR it (the old set-only contract ignored it).
//   3. Enter closes the session only from outside the controls — Enter on a tag, a switch
//      or "+ New tag" is that control's own (it used to close the session mid-edit).
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

  it('opens on the Session details cards — name, note, tags in place, no second editor', async () => {
    mockWindowClaude({ tags: [], note: '', supported: true, flags: {} });
    mount();
    expect(await screen.findByText('No tags on this session yet')).toBeInTheDocument();
    expect(screen.getByText('fix chat scroll stick')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add a note/ })).toBeInTheDocument();
    // The tag search is right there — no "Edit tags and note" step in front of it.
    expect(screen.getByPlaceholderText('Search or create a tag…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit tags and note' })).toBeNull();
  });

  it('puts Pin to top and Mark complete under their own label, not under Tags', async () => {
    // close-session-1#CS-1: "weird for them to fall under the "tags" subheader".
    mockWindowClaude({ tags: [], note: '', supported: true, flags: {} });
    mount();
    const label = await screen.findByText('In your lists');
    const card = label.parentElement!;
    expect(card).toContainElement(screen.getByRole('switch', { name: 'Pin to top' }));
    expect(card).toContainElement(screen.getByRole('switch', { name: 'Mark complete' }));
    expect(screen.getByText('Tags').parentElement).not.toContainElement(screen.getByRole('switch', { name: 'Pin to top' }));
  });

  it('shows what is already applied: the pin, the tag and the note', async () => {
    mockWindowClaude({ tags: ['tag_work'], note: 'blocked on the gh dead-end', supported: true, flags: { priority: true } });
    mount();
    expect(await screen.findByRole('button', { name: 'Edit work' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Pin to top' })).toHaveAttribute('aria-checked', 'true');
    // Rendered in typographic quotes, so match on substring rather than equality.
    expect(screen.getByText(/blocked on the gh dead-end/)).toBeInTheDocument();
  });

  it('writes nothing while editing; Close session sends the tag and note changes as one delta', async () => {
    mockWindowClaude({ tags: ['tag_work'], note: '', supported: true, flags: {} });
    const onConfirm = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove work' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add bug' }));
    fireEvent.click(screen.getByRole('button', { name: /Add a note/ }));
    const box = screen.getByRole('textbox', { name: 'Note' });
    fireEvent.change(box, { target: { value: 'parked until the release' } });
    fireEvent.blur(box);
    expect(onConfirm).not.toHaveBeenCalled();
    expect((window as any).claude.session.setTag).toBeUndefined();

    fireEvent.click(screen.getByRole('button', { name: 'Close session' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    expect(onConfirm.mock.calls[0][0]).toMatchObject({
      addTagIds: ['tag_bug'], removeTagIds: ['tag_work'], note: 'parked until the release', noteChanged: true,
    });
  });

  it('Enter on a focused tag opens it, and does not close the session', async () => {
    mockWindowClaude({ tags: ['tag_work'], note: '', supported: true, flags: {} });
    const onConfirm = mount();
    const tag = await screen.findByRole('button', { name: 'Edit work' });
    tag.focus();
    fireEvent.keyDown(tag, { key: 'Enter' });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(await screen.findByText('Edit “work”')).toBeInTheDocument();
    // From outside any control, Enter still closes.
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('clears a preloaded Priority when the user un-toggles it', async () => {
    // The regression the flag-delta contract exists for: under the old
    // set-only shape this emitted nothing and Priority stayed applied.
    mockWindowClaude({ tags: [], note: '', supported: true, flags: { priority: true } });
    const onConfirm = mount();
    fireEvent.click(await screen.findByRole('switch', { name: 'Pin to top' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close session' }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    expect(onConfirm.mock.calls[0][0].flags).toEqual({ priority: false });
  });

  it('sends nothing for a flag the user never touched', async () => {
    mockWindowClaude({ tags: [], note: '', supported: true, flags: { priority: true } });
    const onConfirm = mount();
    await screen.findByRole('switch', { name: 'Pin to top' });
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
    await screen.findByText('No tags on this session yet');
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
