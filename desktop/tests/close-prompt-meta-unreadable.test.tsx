// @vitest-environment jsdom
/**
 * The close prompt never shows "No note" for a note it could not read — and never lets
 * that blank overwrite the real one.
 *
 * Error inventory 2026-09-10, false message 12. When reading a conversation's tags and
 * note failed, BOTH hosts answered blanks (`catch { return { tags: [], note: '', ... } }`)
 * and the prompt's own `.catch` did the same. The prompt then showed "No tags / No note"
 * for a conversation that had them, and used that blank as the baseline for its delta —
 * so typing a note REPLACED the stored one the user was never shown.
 *
 * A read that failed now reaches the prompt as `unreadable` (or a rejection), and the
 * prompt uses its existing "can't be changed here" state: the reason is shown, the tag
 * and note controls are not, and confirming writes nothing to either. A conversation
 * that simply has no note yet still shows "No note".
 */
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { join } from 'node:path';
import CloseSessionPrompt from '../src/renderer/components/CloseSessionPrompt';
import { readStripped } from './helpers/guard-scope';

function mockWindowClaude(getMeta: ReturnType<typeof vi.fn>) {
  (window as any).claude = {
    session: { getMeta },
    tags: { list: vi.fn().mockResolvedValue([]), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    on: {},
  };
}

function mount() {
  const onConfirm = vi.fn();
  render(<CloseSessionPrompt open sessionName="fix chat scroll" sessionId="sess-1" onCancel={() => {}} onConfirm={onConfirm} />);
  return onConfirm;
}

/** Enter confirms the prompt (its window-level handler), without depending on a button label. */
const confirm = () => fireEvent.keyDown(window, { key: 'Enter' });

describe('CloseSessionPrompt — an unreadable note is not "No note"', () => {
  afterEach(() => { cleanup(); delete (window as any).claude; });

  it('a read that REJECTED says so, hides the editor, and confirming writes no note or tags', async () => {
    mockWindowClaude(vi.fn().mockRejectedValue(new Error("Error invoking remote method 'session:get-meta': Error: store unavailable")));
    const onConfirm = mount();

    expect(await screen.findByText(/couldn.t load this conversation.s tags and note/i)).toBeInTheDocument();
    expect(screen.queryByText('No note')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit tags and note' })).toBeNull();
    expect(screen.queryByText(/Error invoking remote method/)).toBeNull();

    confirm();
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ noteChanged: false, addTagIds: [], removeTagIds: [] }));
  });

  it('a host that answered `unreadable` is treated the same way, with its reason', async () => {
    mockWindowClaude(vi.fn().mockResolvedValue({ tags: [], note: '', supported: true, unreadable: "EACCES: permission denied, open '/home/me/YouCoded/Personal/Conversations/claude/sess-1.json'" }));
    mount();

    expect(await screen.findByText(/couldn.t load this conversation.s tags and note/i)).toBeInTheDocument();
    expect(screen.getByText(/EACCES: permission denied/)).toBeInTheDocument();
    expect(screen.queryByText('No note')).toBeNull();
  });

  it('a conversation that really has no note still says "No note"', async () => {
    mockWindowClaude(vi.fn().mockResolvedValue({ tags: [], note: '', supported: true, flags: {} }));
    mount();

    expect(await screen.findByText('No note')).toBeInTheDocument();
    expect(screen.queryByText(/couldn.t load/i)).toBeNull();
  });
});

describe('both hosts report a failed read instead of answering blanks', () => {
  const MAIN = join(__dirname, '..', 'src', 'main');

  it("main's session:get-meta marks a thrown read or a missing store as unreadable", () => {
    const src = readStripped(join(MAIN, 'ipc-handlers.ts'));
    const start = src.indexOf('ipcMain.handle(IPC.SESSION_GET_META');
    expect(start).toBeGreaterThanOrEqual(0);
    const body = src.slice(start, src.indexOf('ipcMain.handle(', start + 10));
    expect(body).toMatch(/if \(!store\) return \{[^}]*unreadable:/);
    expect(body).toMatch(/catch \(\w+\) \{[^}]*unreadable:/);
  });

  it("remote-server's session:get-meta does the same", () => {
    const src = readStripped(join(MAIN, 'remote-server.ts'));
    const start = src.indexOf("case 'session:get-meta':");
    expect(start).toBeGreaterThanOrEqual(0);
    const body = src.slice(start, src.indexOf("case '", start + 10));
    expect(body).toMatch(/unreadable:/);
    expect(body).not.toMatch(/fall through to empty/);
  });
});
