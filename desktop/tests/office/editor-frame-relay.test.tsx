// @vitest-environment jsdom
// EditorFrame as the editor's host (Task 6): it opens the document in main, frames the
// editor on the document's own origin, relays the editor's requests to main and the answers
// back, and decides when to save (design §3a, §4, §5).
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { EditorFrame } from '../../src/renderer/components/office/EditorFrame';
import { closeDoc, openDoc, resetOfficeStoreForTests, saveStateFor } from '../../src/renderer/components/office/office-store';
import type { OfficeBridge, OfficeFile } from '../../src/shared/office-types';

const FILE: OfficeFile = { path: '/home/you/plan.docx', name: 'plan.docx', kind: 'document', folder: 'you', at: '2026-09-28T00:00:00Z' };
const ORIGIN = 'office://t1';

type Bridge = Pick<OfficeBridge, 'open' | 'invoke' | 'close'>;
function fakeBridge(overrides: Partial<Bridge> = {}) {
  const bridge = {
    open: vi.fn(async () => ({ ok: true as const, token: 't1', origin: ORIGIN })),
    invoke: vi.fn(async (): Promise<unknown> => 'ok'),
    close: vi.fn(async () => {}),
    ...overrides,
  };
  (window as unknown as { claude: unknown }).claude = { office: bridge };
  return bridge;
}

/** Renders the frame, waits for main's answer, and spies on what the host posts into it. */
async function mountFrame(props: Partial<React.ComponentProps<typeof EditorFrame>> = {}) {
  const r = render(<EditorFrame file={FILE} {...props} />);
  const iframe = r.container.querySelector('iframe')!;
  await waitFor(() => expect(iframe.getAttribute('src')).toBe(`${ORIGIN}/index.html`));
  // The message listener is attached in an effect after that render; let it run before the
  // test speaks for the editor (under a loaded suite it can land a tick later).
  await act(async () => { await Promise.resolve(); });
  // WHY a recorder fed by every window the frame has had: jsdom may swap the iframe's window
  // once it acts on the new src, and under a loaded suite that can happen after this point.
  // The test always speaks as, and listens to, the frame's CURRENT window.
  const posted = vi.fn();
  const spied = new WeakSet<Window>();
  const current = () => {
    const w = iframe.contentWindow!;
    if (!spied.has(w)) { spied.add(w); vi.spyOn(w, 'postMessage').mockImplementation((...a: unknown[]) => { posted(...a); }); }
    return w;
  };
  current();
  const fromEditor = (data: unknown, over: { origin?: string; source?: Window | null } = {}) => {
    const w = current();
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data, origin: over.origin ?? ORIGIN, source: over.source === undefined ? w : over.source }));
    });
  };
  const sent = () => posted.mock.calls.map((c) => c[0] as Record<string, unknown>);
  const saves = () => sent().filter((m) => m.type === 'yc:office-save').length;
  return { ...r, iframe, posted, fromEditor, sent, saves };
}

/** Lets the relay's promise chain (invoke → then → post) run. */
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

beforeEach(() => resetOfficeStoreForTests());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (window as unknown as { claude?: unknown }).claude;
});

describe('EditorFrame hosting the editor', () => {
  it("frames the editor page on the document's own origin", async () => {
    const bridge = fakeBridge();
    const { iframe } = await mountFrame();
    expect(bridge.open).toHaveBeenCalledWith(FILE.path);
    expect(iframe.getAttribute('src')).toBe('office://t1/index.html');
  });

  it('answers the editor being ready with the theme, the mode, then the file to open', async () => {
    fakeBridge();
    const { fromEditor, sent } = await mountFrame();
    fromEditor({ yc: 'ready' });
    const kinds = sent().map((m) => m.type ?? m.yc);
    expect(kinds).toEqual(['yc:office-theme', 'yc:office-mode', 'event']);
    expect(sent()[2]).toEqual({ yc: 'event', name: 'open-file', payload: FILE.path });
  });

  it("relays an editor request to main and posts main's answer back under the same id", async () => {
    const bridge = fakeBridge({ invoke: vi.fn(async () => 'DOCY-bytes') });
    const { fromEditor, posted } = await mountFrame();
    fromEditor({ yc: 'rpc', id: 5, cmd: 'open_file', args: {} });
    await settle();
    expect(bridge.invoke).toHaveBeenCalledWith('t1', 'open_file', {});
    expect(posted).toHaveBeenCalledWith({ yc: 'rpc-result', id: 5, result: 'DOCY-bytes' }, ORIGIN);
  });

  it("posts main's refusal back to the editor as that request's error", async () => {
    fakeBridge({ invoke: vi.fn(async () => { throw new Error("Office can't find this file."); }) });
    const { fromEditor, posted } = await mountFrame();
    fromEditor({ yc: 'rpc', id: 5, cmd: 'open_file', args: {} });
    await settle();
    expect(posted).toHaveBeenCalledWith({ yc: 'rpc-result', id: 5, error: "Office can't find this file." }, ORIGIN);
  });

  it('ignores a request from another origin or from another window', async () => {
    const bridge = fakeBridge();
    const { fromEditor } = await mountFrame();
    fromEditor({ yc: 'rpc', id: 1, cmd: 'open_file', args: {} }, { origin: 'office://someone-else' });
    fromEditor({ yc: 'rpc', id: 2, cmd: 'open_file', args: {} }, { source: window });
    await settle();
    expect(bridge.invoke).not.toHaveBeenCalled();
    // The same request from the frame itself IS relayed — so the two above were refused for
    // where they came from, not because nothing is ever relayed.
    fromEditor({ yc: 'rpc', id: 3, cmd: 'open_file', args: {} });
    await settle();
    expect(bridge.invoke).toHaveBeenCalledTimes(1);
  });

  it('hands the document back to main when the frame goes away', async () => {
    const bridge = fakeBridge();
    const { unmount } = await mountFrame();
    unmount();
    await waitFor(() => expect(bridge.close).toHaveBeenCalledWith('t1'));
  });
});

describe('EditorFrame autosave', () => {
  it('marks the file unsaved on a change and asks the editor to save 3 s after it', async () => {
    fakeBridge();
    const { fromEditor, saves } = await mountFrame();
    vi.useFakeTimers();
    fromEditor({ yc: 'rpc', id: 1, cmd: 'set_document_modified', args: { modified: true } });
    expect(saveStateFor(FILE.path).phase).toBe('unsaved');
    act(() => { vi.advanceTimersByTime(2_999); });
    expect(saves()).toBe(0);
    act(() => { vi.advanceTimersByTime(1); });
    expect(saves()).toBe(1);
  });

  it('drops the pending save when the editor says the document is unchanged after all', async () => {
    fakeBridge();
    const { fromEditor, saves } = await mountFrame();
    vi.useFakeTimers();
    // What the editor sends while it lays out a freshly opened workbook.
    fromEditor({ yc: 'rpc', id: 1, cmd: 'set_document_modified', args: { modified: true } });
    fromEditor({ yc: 'rpc', id: 2, cmd: 'set_document_modified', args: { modified: false } });
    expect(saveStateFor(FILE.path).phase).toBe('saved');
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(saves()).toBe(0);
  });

  it("shows a save as saving, then saved on main's answer", async () => {
    let answer!: (v: unknown) => void;
    fakeBridge({ invoke: vi.fn((_t: string, cmd: string) => (cmd === 'save_file' ? new Promise((r) => (answer = r)) : Promise.resolve(null))) });
    const { fromEditor } = await mountFrame();
    fromEditor({ yc: 'rpc', id: 7, cmd: 'save_file', args: { data: '' } });
    expect(saveStateFor(FILE.path).phase).toBe('saving');
    answer('ok');
    await settle();
    expect(saveStateFor(FILE.path).phase).toBe('saved');
    expect(saveStateFor(FILE.path).savedAt).toBeTruthy();
  });

  it("shows a failed save with main's own reason", async () => {
    fakeBridge({ invoke: vi.fn(async (_t: string, cmd: string) => { if (cmd === 'save_file') throw new Error('The disk is full, so Office couldn\'t save this file.'); return null; }) });
    const { fromEditor } = await mountFrame();
    fromEditor({ yc: 'rpc', id: 7, cmd: 'save_file', args: { data: '' } });
    await settle();
    expect(saveStateFor(FILE.path)).toMatchObject({ phase: 'failed', message: "The disk is full, so Office couldn't save this file." });
  });

  it('saves a change made during a save exactly once more, after the first save lands', async () => {
    let answer!: (v: unknown) => void;
    fakeBridge({ invoke: vi.fn((_t: string, cmd: string) => (cmd === 'save_file' ? new Promise((r) => (answer = r)) : Promise.resolve(null))) });
    const { fromEditor, saves } = await mountFrame();
    vi.useFakeTimers();
    fromEditor({ yc: 'rpc', id: 1, cmd: 'save_file', args: { data: '' } });
    // Typing continues while the save is out.
    fromEditor({ yc: 'rpc', id: 2, cmd: 'set_document_modified', args: { modified: true } });
    fromEditor({ yc: 'rpc', id: 3, cmd: 'set_document_modified', args: { modified: true } });
    expect(saveStateFor(FILE.path).phase).toBe('unsaved');
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(saves()).toBe(0); // nothing starts behind a running save
    answer('ok');
    await settle();
    expect(saveStateFor(FILE.path).phase).toBe('unsaved'); // the follow-up is still to come
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(saves()).toBe(1);
  });

  it('a closed tab saves its last changes first, and lets go once that save lands', async () => {
    let answer!: (v: unknown) => void;
    const bridge = fakeBridge({ invoke: vi.fn((_t: string, cmd: string) => (cmd === 'save_file' ? new Promise((r) => (answer = r)) : Promise.resolve(null))) });
    openDoc(FILE);
    const onClosed = vi.fn();
    const { fromEditor, saves, rerender } = await mountFrame({ onClosed });
    fromEditor({ yc: 'rpc', id: 1, cmd: 'set_document_modified', args: { modified: true } });
    closeDoc(FILE.path);
    rerender(<EditorFrame file={FILE} closing onClosed={onClosed} />);
    expect(saves()).toBe(1); // asked at once, not 3 s later
    fromEditor({ yc: 'rpc', id: 2, cmd: 'save_file', args: { data: '' } });
    await settle();
    expect(onClosed).not.toHaveBeenCalled();
    answer('ok');
    await waitFor(() => expect(onClosed).toHaveBeenCalledTimes(1));
    expect(bridge.close).not.toHaveBeenCalled(); // the tab's unmount does that, after this
  });

  it('a closed tab whose save_file is already with main lets go after 5 s (main drains it)', async () => {
    fakeBridge({ invoke: vi.fn((_t: string, cmd: string) => (cmd === 'save_file' ? new Promise(() => {}) : Promise.resolve(null))) });
    const onClosed = vi.fn();
    const onCloseFailed = vi.fn();
    const { fromEditor, rerender } = await mountFrame({ onClosed, onCloseFailed });
    vi.useFakeTimers();
    fromEditor({ yc: 'rpc', id: 1, cmd: 'set_document_modified', args: { modified: true } });
    rerender(<EditorFrame file={FILE} closing onClosed={onClosed} onCloseFailed={onCloseFailed} />);
    fromEditor({ yc: 'rpc', id: 2, cmd: 'save_file', args: { data: '' } });
    await act(async () => { vi.advanceTimersByTime(4_999); });
    expect(onClosed).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(onCloseFailed).not.toHaveBeenCalled();
  });

  it('a closed tab whose editor never starts the save keeps the tab and says so after 5 s', async () => {
    fakeBridge();
    const onClosed = vi.fn();
    const onCloseFailed = vi.fn();
    const { fromEditor, rerender } = await mountFrame({ onClosed, onCloseFailed });
    vi.useFakeTimers();
    fromEditor({ yc: 'rpc', id: 1, cmd: 'set_document_modified', args: { modified: true } });
    rerender(<EditorFrame file={FILE} closing onClosed={onClosed} onCloseFailed={onCloseFailed} />);
    await act(async () => { vi.advanceTimersByTime(5_000); });
    expect(onClosed).not.toHaveBeenCalled();
    expect(onCloseFailed).toHaveBeenCalledWith("Office didn't finish saving this file.");
  });

  it('a change made during a save is saved before a close lets go', async () => {
    const answers: Array<(v: unknown) => void> = [];
    fakeBridge({ invoke: vi.fn((_t: string, cmd: string) => (cmd === 'save_file' ? new Promise((r) => answers.push(r)) : Promise.resolve(null))) });
    const onClosed = vi.fn();
    const { fromEditor, saves, rerender } = await mountFrame({ onClosed });
    fromEditor({ yc: 'rpc', id: 1, cmd: 'set_document_modified', args: { modified: true } });
    fromEditor({ yc: 'rpc', id: 2, cmd: 'save_file', args: { data: '' } }); // the autosave, running
    fromEditor({ yc: 'rpc', id: 3, cmd: 'set_document_modified', args: { modified: true } }); // typed during it
    rerender(<EditorFrame file={FILE} closing onClosed={onClosed} />);
    answers[0]('ok');
    await settle();
    // The first save landed, but the change made during it has not: no letting go yet, and its
    // follow-up save is asked for at once rather than 3 s later.
    expect(onClosed).not.toHaveBeenCalled();
    expect(saves()).toBe(1);
    fromEditor({ yc: 'rpc', id: 4, cmd: 'save_file', args: { data: '' } });
    await settle();
    expect(onClosed).not.toHaveBeenCalled();
    answers[1]('ok');
    await vi.waitFor(() => expect(onClosed).toHaveBeenCalledTimes(1));
  });

  it("waits through the editor's own save — change log, name, bytes, then save_file — before a close lets go", async () => {
    let answerSave!: (v: unknown) => void;
    const calls: string[] = [];
    fakeBridge({ invoke: vi.fn((_t: string, cmd: string) => { calls.push(cmd); return cmd === 'save_file' ? new Promise((r) => (answerSave = r)) : Promise.resolve(cmd === 'get_current_path' ? 'plan.docx' : 'ok'); }) });
    const onClosed = vi.fn();
    const { fromEditor, saves, rerender } = await mountFrame({ onClosed });
    fromEditor({ yc: 'rpc', id: 1, cmd: 'set_document_modified', args: { modified: true } });
    rerender(<EditorFrame file={FILE} closing onClosed={onClosed} />);
    expect(saves()).toBe(1);
    // What asc_Save sends, in order (measured in the dev window).
    fromEditor({ yc: 'rpc', id: 2, cmd: 'save_changes', args: { changes: [], deleteIndex: 11, count: 0 } });
    fromEditor({ yc: 'rpc', id: 3, cmd: 'set_document_modified', args: { modified: false } });
    fromEditor({ yc: 'rpc', id: 4, cmd: 'get_current_path', args: {} });
    fromEditor({ yc: 'rpc', id: 5, cmd: 'write_editor_bin', args: { data: 'RE9D' } });
    await settle();
    expect(saveStateFor(FILE.path).phase).not.toBe('saved'); // save_changes is not the save
    expect(onClosed).not.toHaveBeenCalled();
    fromEditor({ yc: 'rpc', id: 6, cmd: 'save_file', args: { data: '' } });
    await settle();
    expect(onClosed).not.toHaveBeenCalled();
    answerSave('ok');
    await vi.waitFor(() => expect(onClosed).toHaveBeenCalledTimes(1));
    expect(calls).toEqual(['set_document_modified', 'save_changes', 'set_document_modified', 'get_current_path', 'write_editor_bin', 'save_file']);
  });

  it("does not retry a failed save on its own when the editor re-marks the document modified", async () => {
    fakeBridge({ invoke: vi.fn(async (_t: string, cmd: string) => { if (cmd === 'save_file') throw new Error("Office doesn't have permission to save this file."); return null; }) });
    const { fromEditor, saves } = await mountFrame();
    fromEditor({ yc: 'rpc', id: 1, cmd: 'set_document_modified', args: { modified: true } });
    fromEditor({ yc: 'rpc', id: 2, cmd: 'save_file', args: { data: '' } });
    await settle();
    vi.useFakeTimers();
    // What the editor sends after its own save failed (EndSave(1)).
    fromEditor({ yc: 'rpc', id: 3, cmd: 'set_document_modified', args: { modified: true } });
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(saves()).toBe(0);
    expect(saveStateFor(FILE.path).phase).toBe('failed');
  });

  it("a failed save keeps a closing tab, with main's reason, after trying once more", async () => {
    fakeBridge({ invoke: vi.fn(async (_t: string, cmd: string) => { if (cmd === 'save_file') throw new Error("Office doesn't have permission to save this file."); return null; }) });
    const onClosed = vi.fn();
    const onCloseFailed = vi.fn();
    const { fromEditor, saves, rerender } = await mountFrame({ onClosed, onCloseFailed });
    fromEditor({ yc: 'rpc', id: 1, cmd: 'set_document_modified', args: { modified: true } });
    fromEditor({ yc: 'rpc', id: 2, cmd: 'save_file', args: { data: '' } });
    await settle();
    expect(saveStateFor(FILE.path).phase).toBe('failed');
    rerender(<EditorFrame file={FILE} closing onClosed={onClosed} onCloseFailed={onCloseFailed} />);
    expect(saves()).toBe(1); // the close tries once more
    fromEditor({ yc: 'rpc', id: 3, cmd: 'save_file', args: { data: '' } });
    await settle();
    expect(onClosed).not.toHaveBeenCalled();
    expect(onCloseFailed).toHaveBeenCalledWith("Office doesn't have permission to save this file.");
  });

  it('a closed tab with nothing unsaved lets go at once', async () => {
    fakeBridge();
    const onClosed = vi.fn();
    const { rerender, saves } = await mountFrame({ onClosed });
    rerender(<EditorFrame file={FILE} closing onClosed={onClosed} />);
    await waitFor(() => expect(onClosed).toHaveBeenCalledTimes(1));
    expect(saves()).toBe(0);
  });
});
