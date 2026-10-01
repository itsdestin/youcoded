// @vitest-environment jsdom
// EditorFrame as the editor's host (Task 6): it opens the document in main, frames the
// editor on the document's own origin, relays the editor's requests to main and the answers
// back, and decides when to save (design §3a, §4, §5).
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { EditorFrame, autosaveDelay } from '../../src/renderer/components/office/EditorFrame';
import { closeDoc, openDoc, resetOfficeStoreForTests, saveStateFor, useOfficeAlerts } from '../../src/renderer/components/office/office-store';
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

/** mountFrame, plus the frame's imperative handle. */
async function mountWithHandle() {
  const handle = React.createRef<import('../../src/renderer/components/office/EditorFrame').EditorFrameHandle>();
  const r = await mountFrame({ ref: handle } as never);
  return { ...r, handle };
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
    expect(sent()[2]).toEqual({ yc: 'event', name: 'open-file', payload: FILE.name });
  });

  it('never tells the editor which folder the file is in', async () => {
    fakeBridge();
    const { fromEditor, sent } = await mountFrame();
    fromEditor({ yc: 'ready' });
    const folder = FILE.path.slice(0, FILE.path.lastIndexOf('/'));
    expect(folder.length).toBeGreaterThan(0);
    for (const m of sent()) expect(JSON.stringify(m)).not.toContain(folder);
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

  it('leaves no save state behind when a save lands after the frame has gone', async () => {
    let answer!: (v: unknown) => void;
    fakeBridge({ invoke: vi.fn((_t: string, cmd: string) => (cmd === 'save_file' ? new Promise((r) => (answer = r)) : Promise.resolve(null))) });
    const { fromEditor, unmount } = await mountFrame();
    fromEditor({ yc: 'rpc', id: 1, cmd: 'save_file', args: { data: '' } });
    const { resetOfficeStoreForTests: reset } = await import('../../src/renderer/components/office/office-store');
    unmount();
    reset(); // the tab closed: nothing is recorded for this file
    await act(async () => { answer('ok'); await Promise.resolve(); await Promise.resolve(); });
    expect(saveStateFor(FILE.path)).toEqual({ phase: 'saved' }); // the default: no entry was recreated
  });

  // Fix round 5: a close lets go of a save still with main (the 5 s cap); main drains it. If it
  // then fails, the tab is gone — the "An Office document couldn't be saved." toast says so.
  it('says so when a save the close let go of fails after the frame has gone', async () => {
    let fail!: (e: Error) => void;
    fakeBridge({ invoke: vi.fn((_t: string, cmd: string) => (cmd === 'save_file' ? new Promise((_r, rej) => (fail = rej)) : Promise.resolve(null))) });
    const onClosed = vi.fn();
    const { fromEditor, rerender, unmount } = await mountFrame({ onClosed });
    fromEditor({ yc: 'rpc', id: 1, cmd: 'save_file', args: { data: '' } });
    vi.useFakeTimers();
    rerender(<EditorFrame file={FILE} closing onClosed={onClosed} />);
    await act(async () => { vi.advanceTimersByTime(5_000); });
    expect(onClosed).toHaveBeenCalled();
    unmount();
    const alerts = renderHook(() => useOfficeAlerts());
    expect(alerts.result.current.closeFailed).toBeNull();
    await act(async () => { fail(new Error("Office doesn't have permission to save this file.")); await Promise.resolve(); await Promise.resolve(); });
    expect(alerts.result.current.closeFailed).toBe(FILE.path);
  });

  it('says nothing when a save fails after "Close without saving" let the frame go', async () => {
    let fail!: (e: Error) => void;
    fakeBridge({ invoke: vi.fn((_t: string, cmd: string) => (cmd === 'save_file' ? new Promise((_r, rej) => (fail = rej)) : Promise.resolve(null))) });
    const { fromEditor, unmount } = await mountFrame();
    fromEditor({ yc: 'rpc', id: 1, cmd: 'save_file', args: { data: '' } });
    unmount();
    const alerts = renderHook(() => useOfficeAlerts());
    await act(async () => { fail(new Error('x')); await Promise.resolve(); await Promise.resolve(); });
    expect(alerts.result.current.closeFailed).toBeNull();
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

  // Finish plan Task 5 (measured 2026-09-30): a 20 MB workbook freezes ~2 s gathering its bytes,
  // so saving 3 s into every pause put that freeze wherever the person paused. A document whose
  // editor was slow to hand its bytes over waits ten times that long (at most 20 s); a quick one
  // keeps 3 s.
  it('waits longer before autosaving a document whose editor froze long to hand its bytes over', async () => {
    fakeBridge();
    const { fromEditor, saves } = await mountFrame();
    vi.useFakeTimers();
    // First save: the default 3 s, and the editor takes 1.5 s to hand its bytes over.
    fromEditor({ yc: 'rpc', id: 1, cmd: 'set_document_modified', args: { modified: true } });
    act(() => { vi.advanceTimersByTime(3_000); });
    expect(saves()).toBe(1);
    act(() => { vi.advanceTimersByTime(1_500); });
    fromEditor({ yc: 'rpc', id: 2, cmd: 'write_editor_bin', args: { data: 'AA==' } });
    fromEditor({ yc: 'rpc', id: 3, cmd: 'save_file', args: { data: '' } });
    await settle();
    expect(saveStateFor(FILE.path).phase).toBe('saved');
    // Next change: not after 3 s, but after 15 s (10 x 1.5 s).
    fromEditor({ yc: 'rpc', id: 4, cmd: 'set_document_modified', args: { modified: true } });
    act(() => { vi.advanceTimersByTime(14_999); });
    expect(saves()).toBe(1);
    act(() => { vi.advanceTimersByTime(1); });
    expect(saves()).toBe(2);
    // This time the bytes come at once: the next change is back to 3 s.
    fromEditor({ yc: 'rpc', id: 5, cmd: 'write_editor_bin', args: { data: 'AA==' } });
    fromEditor({ yc: 'rpc', id: 6, cmd: 'save_file', args: { data: '' } });
    await settle();
    fromEditor({ yc: 'rpc', id: 7, cmd: 'set_document_modified', args: { modified: true } });
    act(() => { vi.advanceTimersByTime(3_000); });
    expect(saves()).toBe(3);
  });

  it('never waits more than 20 s, however long the editor froze', () => {
    expect(autosaveDelay(0)).toBe(3_000);
    expect(autosaveDelay(100)).toBe(3_000);
    expect(autosaveDelay(450)).toBe(4_500);
    expect(autosaveDelay(60_000)).toBe(20_000);
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

  it('never lets a close go after 5 s while a change is still unsaved, even with a save_file out', async () => {
    fakeBridge({ invoke: vi.fn((_t: string, cmd: string) => (cmd === 'save_file' ? new Promise(() => {}) : Promise.resolve(null))) });
    const onClosed = vi.fn();
    const onCloseFailed = vi.fn();
    const { fromEditor, rerender } = await mountFrame({ onClosed, onCloseFailed });
    vi.useFakeTimers();
    fromEditor({ yc: 'rpc', id: 1, cmd: 'set_document_modified', args: { modified: true } });
    rerender(<EditorFrame file={FILE} closing onClosed={onClosed} onCloseFailed={onCloseFailed} />);
    fromEditor({ yc: 'rpc', id: 2, cmd: 'save_file', args: { data: '' } });
    fromEditor({ yc: 'rpc', id: 3, cmd: 'set_document_modified', args: { modified: true } }); // typed during it
    await act(async () => { vi.advanceTimersByTime(5_000); });
    expect(onClosed).not.toHaveBeenCalled();
    expect(onCloseFailed).toHaveBeenCalledWith("Office didn't finish saving this file.");
    expect(saveStateFor(FILE.path)).toMatchObject({ phase: 'failed', message: "Office didn't finish saving this file." });
  });

  it("counts a refused write_editor_bin as a failed save, with main's reason", async () => {
    fakeBridge({ invoke: vi.fn(async (_t: string, cmd: string) => { if (cmd === 'write_editor_bin') throw new Error("The disk is full, so Office couldn't save this file."); return null; }) });
    const onClosed = vi.fn();
    const onCloseFailed = vi.fn();
    const { fromEditor, rerender } = await mountFrame({ onClosed, onCloseFailed });
    fromEditor({ yc: 'rpc', id: 1, cmd: 'set_document_modified', args: { modified: true } });
    rerender(<EditorFrame file={FILE} closing onClosed={onClosed} onCloseFailed={onCloseFailed} />);
    fromEditor({ yc: 'rpc', id: 2, cmd: 'write_editor_bin', args: { data: 'RE9D' } });
    await settle();
    expect(saveStateFor(FILE.path)).toMatchObject({ phase: 'failed', message: "The disk is full, so Office couldn't save this file." });
    await vi.waitFor(() => expect(onCloseFailed).toHaveBeenCalledWith("The disk is full, so Office couldn't save this file."));
    expect(onClosed).not.toHaveBeenCalled();
  });

  it('a save that lands after the 5 s cap called it failed clears the failure and saves the rest normally', async () => {
    let answer!: (v: unknown) => void;
    fakeBridge({ invoke: vi.fn((_t: string, cmd: string) => (cmd === 'save_file' ? new Promise((r) => (answer = r)) : Promise.resolve(null))) });
    const onCloseFailed = vi.fn();
    const { fromEditor, saves, rerender } = await mountFrame({ onCloseFailed });
    vi.useFakeTimers();
    fromEditor({ yc: 'rpc', id: 1, cmd: 'set_document_modified', args: { modified: true } });
    rerender(<EditorFrame file={FILE} closing onCloseFailed={onCloseFailed} />);
    fromEditor({ yc: 'rpc', id: 2, cmd: 'save_file', args: { data: '' } });
    fromEditor({ yc: 'rpc', id: 3, cmd: 'set_document_modified', args: { modified: true } });
    await act(async () => { vi.advanceTimersByTime(5_000); });
    expect(saveStateFor(FILE.path).phase).toBe('failed');
    rerender(<EditorFrame file={FILE} onCloseFailed={onCloseFailed} />);
    const before = saves();
    await act(async () => { answer('ok'); await Promise.resolve(); await Promise.resolve(); });
    expect(saveStateFor(FILE.path).phase).not.toBe('failed');
    await act(async () => { vi.advanceTimersByTime(3_000); });
    expect(saves()).toBe(before + 1); // the change typed during it: an ordinary follow-up save
  });

  it('a save that lands after the 60 s guard called it failed is taken as saved', async () => {
    fakeBridge();
    const { fromEditor, handle } = await mountWithHandle();
    vi.useFakeTimers();
    fromEditor({ yc: 'rpc', id: 1, cmd: 'set_document_modified', args: { modified: true } });
    act(() => handle.current!.save());
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(saveStateFor(FILE.path).phase).toBe('failed');
    fromEditor({ yc: 'rpc', id: 2, cmd: 'save_file', args: { data: '' } });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(saveStateFor(FILE.path).phase).not.toBe('failed');
  });

  it('counts an asked-for save that never reaches save_file within 60 s as failed', async () => {
    fakeBridge();
    const { fromEditor, handle } = await mountWithHandle();
    vi.useFakeTimers();
    fromEditor({ yc: 'rpc', id: 1, cmd: 'set_document_modified', args: { modified: true } });
    act(() => handle.current!.save());
    await act(async () => { vi.advanceTimersByTime(59_999); });
    expect(saveStateFor(FILE.path).phase).not.toBe('failed');
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(saveStateFor(FILE.path)).toMatchObject({ phase: 'failed', message: "Office didn't finish saving this file." });
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

  it("waits through the editor's own save — change log, bytes, name, then save_file — before a close lets go", async () => {
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
    fromEditor({ yc: 'rpc', id: 4, cmd: 'write_editor_bin', args: { data: 'RE9D' } });
    fromEditor({ yc: 'rpc', id: 5, cmd: 'get_current_path', args: {} });
    await settle();
    expect(saveStateFor(FILE.path).phase).not.toBe('saved'); // save_changes is not the save
    expect(onClosed).not.toHaveBeenCalled();
    fromEditor({ yc: 'rpc', id: 6, cmd: 'save_file', args: { data: '' } });
    await settle();
    expect(onClosed).not.toHaveBeenCalled();
    answerSave('ok');
    await vi.waitFor(() => expect(onClosed).toHaveBeenCalledTimes(1));
    expect(calls).toEqual(['set_document_modified', 'save_changes', 'set_document_modified', 'write_editor_bin', 'get_current_path', 'save_file']);
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

// Print (finish plan Task 3): main shows the print dialog. When it could not and the person
// saved a PDF instead, main answers where it went; the editor is only told "ok".
describe('EditorFrame and Print', () => {
  it('tells the editor only "ok", and notes a PDF saved instead of printing', async () => {
    const bridge = fakeBridge({ invoke: vi.fn(async (_t: string, cmd: string) => (cmd === 'print_document' ? { saved: { name: 'memo.pdf', folder: 'out' } } : 'ok')) as never });
    const { fromEditor, posted } = await mountFrame();
    fromEditor({ yc: 'rpc', id: 4, cmd: 'print_document', args: {} });
    await settle();
    expect(bridge.invoke).toHaveBeenCalledWith('t1', 'print_document', {});
    expect(posted).toHaveBeenCalledWith({ yc: 'rpc-result', id: 4, result: 'ok' }, ORIGIN);
    expect(saveStateFor(FILE.path).note).toBe('Saved a copy as memo.pdf in out.');
    expect(saveStateFor(FILE.path).phase).toBe('saved');
  });

  it('a print that went to the printer, or was cancelled, leaves the strip as it was', async () => {
    fakeBridge({ invoke: vi.fn(async (_t: string, cmd: string) => (cmd === 'print_document' ? {} : 'ok')) as never });
    const { fromEditor, posted } = await mountFrame();
    fromEditor({ yc: 'rpc', id: 4, cmd: 'print_document', args: {} });
    await settle();
    expect(posted).toHaveBeenCalledWith({ yc: 'rpc-result', id: 4, result: 'ok' }, ORIGIN);
    expect(saveStateFor(FILE.path).note).toBeFalsy();
    expect(saveStateFor(FILE.path).phase).toBe('saved');
  });

  it("says main's reason on the strip when printing failed", async () => {
    fakeBridge({ invoke: vi.fn(async () => { throw new Error('Office is already printing a document. Finish or cancel that first.'); }) });
    const { fromEditor, posted } = await mountFrame();
    fromEditor({ yc: 'rpc', id: 6, cmd: 'print_document', args: {} });
    await settle();
    expect(posted).toHaveBeenCalledWith({ yc: 'rpc-result', id: 6, error: 'Office is already printing a document. Finish or cancel that first.' }, ORIGIN);
    expect(saveStateFor(FILE.path).note).toBe('Office is already printing a document. Finish or cancel that first.');
    expect(saveStateFor(FILE.path).phase).toBe('saved');
  });
});

// Save As / Download as / Export to PDF (finish plan Task 2): main writes the copy and answers
// where it went; the editor is told only "ok", and YouCoded's own strip says where.
describe('EditorFrame and Save As', () => {
  it('tells the editor only "ok", and notes the copy\'s name and folder on the strip', async () => {
    const bridge = fakeBridge({ invoke: vi.fn(async (_t: string, cmd: string) => (cmd === 'save_file_as' ? { name: 'Report.pdf', folder: 'out' } : 'ok')) as never });
    const { fromEditor, posted } = await mountFrame();
    fromEditor({ yc: 'rpc', id: 9, cmd: 'save_file_as', args: { path: 'yc-save/abc/Report.pdf' } });
    await settle();
    expect(bridge.invoke).toHaveBeenCalledWith('t1', 'save_file_as', { path: 'yc-save/abc/Report.pdf' });
    expect(posted).toHaveBeenCalledWith({ yc: 'rpc-result', id: 9, result: 'ok' }, ORIGIN);
    expect(saveStateFor(FILE.path).note).toBe('Saved a copy as Report.pdf in out.');
    // The document itself was not saved by it: its own save state is untouched.
    expect(saveStateFor(FILE.path).phase).toBe('saved');
  });

  it("says main's reason on the strip when the copy or its dialog is refused", async () => {
    fakeBridge({ invoke: vi.fn(async () => { throw new Error('That file is open in Office. Close it or choose another name.'); }) });
    const { fromEditor, posted } = await mountFrame();
    fromEditor({ yc: 'rpc', id: 3, cmd: 'save_file_as', args: { path: 'yc-save/abc/x.docx' } });
    await settle();
    expect(posted).toHaveBeenCalledWith({ yc: 'rpc-result', id: 3, error: 'That file is open in Office. Close it or choose another name.' }, ORIGIN);
    expect(saveStateFor(FILE.path).note).toBe('That file is open in Office. Close it or choose another name.');
    expect(saveStateFor(FILE.path).phase).toBe('saved');
  });

  it('a Save As does not drop the pending save of the document itself', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fakeBridge({ invoke: vi.fn(async (_t: string, cmd: string) => (cmd === 'save_file_as' ? { name: 'x.pdf', folder: 'out' } : cmd === 'save_dialog' ? 'yc-save/abc/x.pdf' : 'ok')) as never });
    const { fromEditor, saves } = await mountFrame();
    fromEditor({ yc: 'rpc', id: 1, cmd: 'set_document_modified', args: { modified: true } });
    // The editor's save-as path, as measured: "not modified", its bytes, the dialog, the copy,
    // then "not modified" once more.
    fromEditor({ yc: 'rpc', id: 2, cmd: 'set_document_modified', args: { modified: false } });
    fromEditor({ yc: 'rpc', id: 3, cmd: 'write_editor_bin', args: { data: 'AA==' } });
    fromEditor({ yc: 'rpc', id: 4, cmd: 'save_dialog', args: {} });
    await settle();
    fromEditor({ yc: 'rpc', id: 5, cmd: 'save_file_as', args: { path: 'yc-save/abc/x.pdf' } });
    await settle();
    fromEditor({ yc: 'rpc', id: 6, cmd: 'set_document_modified', args: { modified: false } });
    expect(saveStateFor(FILE.path).phase).toBe('unsaved');
    await act(async () => { vi.advanceTimersByTime(3_100); });
    expect(saves()).toBe(1);
  });

  // The documented limit: the editor's trailing "not modified" is ignored for 2 s after the Save
  // As ends (measured: it arrives within milliseconds). One later than that is the editor's own
  // again and drops the pending save, as any "not modified" does.
  it('a trailing "not modified" past the 2 s window is taken as the editor\'s own (the limit)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fakeBridge({ invoke: vi.fn(async (_t: string, cmd: string) => (cmd === 'save_file_as' ? { name: 'x.pdf', folder: 'out' } : cmd === 'save_dialog' ? 'yc-save/abc/x.pdf' : 'ok')) as never });
    const { fromEditor, saves } = await mountFrame();
    fromEditor({ yc: 'rpc', id: 1, cmd: 'set_document_modified', args: { modified: true } });
    fromEditor({ yc: 'rpc', id: 2, cmd: 'set_document_modified', args: { modified: false } });
    fromEditor({ yc: 'rpc', id: 4, cmd: 'save_dialog', args: {} });
    await settle();
    fromEditor({ yc: 'rpc', id: 5, cmd: 'save_file_as', args: { path: 'yc-save/abc/x.pdf' } });
    await settle();
    expect(saveStateFor(FILE.path).phase).toBe('unsaved');
    await act(async () => { vi.advanceTimersByTime(2_100); });
    fromEditor({ yc: 'rpc', id: 6, cmd: 'set_document_modified', args: { modified: false } });
    expect(saveStateFor(FILE.path).phase).toBe('saved');
    await act(async () => { vi.advanceTimersByTime(3_100); });
    expect(saves()).toBe(0);
  });

  it('typing after a Save As ends its hold on "not modified" at once', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fakeBridge({ invoke: vi.fn(async (_t: string, cmd: string) => (cmd === 'save_file_as' ? { name: 'x.pdf', folder: 'out' } : cmd === 'save_dialog' ? 'yc-save/abc/x.pdf' : 'ok')) as never });
    const { fromEditor } = await mountFrame();
    fromEditor({ yc: 'rpc', id: 4, cmd: 'save_dialog', args: {} });
    await settle();
    fromEditor({ yc: 'rpc', id: 5, cmd: 'save_file_as', args: { path: 'yc-save/abc/x.pdf' } });
    await settle();
    // An edit and its undo straight after: the undo's "not modified" is the editor's own.
    fromEditor({ yc: 'rpc', id: 6, cmd: 'set_document_modified', args: { modified: true } });
    expect(saveStateFor(FILE.path).phase).toBe('unsaved');
    fromEditor({ yc: 'rpc', id: 7, cmd: 'set_document_modified', args: { modified: false } });
    expect(saveStateFor(FILE.path).phase).toBe('saved');
  });

  it('a Save As that ends after the frame has gone writes no save state', async () => {
    let finish: (v: unknown) => void = () => {};
    fakeBridge({ invoke: vi.fn((_t: string, cmd: string) => (cmd === 'save_file_as' ? new Promise((r) => { finish = r; }) : Promise.resolve(cmd === 'save_dialog' ? 'yc-save/abc/x.pdf' : 'ok'))) as never });
    const { fromEditor, unmount } = await mountFrame();
    fromEditor({ yc: 'rpc', id: 1, cmd: 'set_document_modified', args: { modified: true } });
    fromEditor({ yc: 'rpc', id: 2, cmd: 'set_document_modified', args: { modified: false } });
    fromEditor({ yc: 'rpc', id: 4, cmd: 'save_dialog', args: {} });
    await settle();
    fromEditor({ yc: 'rpc', id: 5, cmd: 'save_file_as', args: { path: 'yc-save/abc/x.pdf' } });
    await settle();
    const before = saveStateFor(FILE.path);
    unmount();
    await act(async () => { finish({ name: 'x.pdf', folder: 'out' }); await Promise.resolve(); await Promise.resolve(); });
    expect(saveStateFor(FILE.path).phase).toBe(before.phase);
    expect(saveStateFor(FILE.path).note).toBeUndefined();
  });

  it('a Save As of a document with nothing unsaved asks for no save', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fakeBridge({ invoke: vi.fn(async (_t: string, cmd: string) => (cmd === 'save_file_as' ? { name: 'x.pdf', folder: 'out' } : cmd === 'save_dialog' ? 'yc-save/abc/x.pdf' : 'ok')) as never });
    const { fromEditor, saves } = await mountFrame();
    fromEditor({ yc: 'rpc', id: 2, cmd: 'set_document_modified', args: { modified: false } });
    fromEditor({ yc: 'rpc', id: 4, cmd: 'save_dialog', args: {} });
    await settle();
    fromEditor({ yc: 'rpc', id: 5, cmd: 'save_file_as', args: { path: 'yc-save/abc/x.pdf' } });
    await settle();
    await act(async () => { vi.advanceTimersByTime(3_100); });
    expect(saves()).toBe(0);
    expect(saveStateFor(FILE.path).phase).toBe('saved');
  });

  it('a cancelled Save As keeps the unsaved changes pending too', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fakeBridge({ invoke: vi.fn(async (_t: string, cmd: string) => (cmd === 'save_dialog' ? null : 'ok')) as never });
    const { fromEditor, saves } = await mountFrame();
    fromEditor({ yc: 'rpc', id: 1, cmd: 'set_document_modified', args: { modified: true } });
    fromEditor({ yc: 'rpc', id: 2, cmd: 'set_document_modified', args: { modified: false } });
    fromEditor({ yc: 'rpc', id: 4, cmd: 'save_dialog', args: {} });
    await settle();
    fromEditor({ yc: 'rpc', id: 6, cmd: 'set_document_modified', args: { modified: false } });
    await act(async () => { vi.advanceTimersByTime(3_100); });
    expect(saves()).toBe(1);
  });
});

// Task 2 fix round 1: a second note with the same text keeps its own full time.
describe('the Save As note', () => {
  it('a second identical note is not cleared by the first one\'s timer', async () => {
    vi.useFakeTimers();
    const { markNote } = await import('../../src/renderer/components/office/office-store');
    markNote(FILE.path, 'Saved a copy as x.pdf in out.');
    vi.advanceTimersByTime(5_000);
    markNote(FILE.path, 'Saved a copy as x.pdf in out.');
    vi.advanceTimersByTime(4_000); // the first note's 8 s are over, the second's are not
    expect(saveStateFor(FILE.path).note).toBe('Saved a copy as x.pdf in out.');
    vi.advanceTimersByTime(4_500);
    expect(saveStateFor(FILE.path).note).toBeUndefined();
  });
});

// Comments on an open document go through its editor (main/office/office-comments.ts): main's
// request reaches the editor holding the token, the editor's answer goes back to main, and its
// news that a comment changed is passed on so reading views refresh.
describe('EditorFrame relaying comment requests', () => {
  function withComments() {
    const bridge = fakeBridge();
    let request: ((r: { token: string; id: string; op: unknown }) => void) | null = null;
    const extra = {
      onCommentsRequest: vi.fn((cb: (r: { token: string; id: string; op: unknown }) => void) => { request = cb; return () => {}; }),
      commentsAnswer: vi.fn(),
      commentsChanged: vi.fn(),
    };
    Object.assign(bridge, extra);
    return { ...extra, ask: (token: string, id: string, op: unknown) => act(() => { request!({ token, id, op }); }) };
  }

  it('answers "not ready" while the document is still opening, without bothering the editor', async () => {
    const c = withComments();
    const { sent } = await mountFrame();
    c.ask('t1', 'q1', { kind: 'list' });
    expect(c.commentsAnswer).toHaveBeenCalledWith('q1', { ok: false, error: 'editor-not-ready' }, 't1');
    expect(sent().some((m) => m.type === 'yc:office-comments')).toBe(false);
  });

  it('passes a request to the drawn editor and its answer back to main; another token\'s request is not its', async () => {
    const c = withComments();
    const { fromEditor, sent } = await mountFrame();
    fromEditor({ type: 'yc:office-loaded' });
    c.ask('t1', 'q2', { kind: 'add', text: 'hi' });
    expect(sent().filter((m) => m.type === 'yc:office-comments')).toEqual([{ type: 'yc:office-comments', id: 'q2', op: { kind: 'add', text: 'hi' } }]);
    c.ask('other-token', 'q3', { kind: 'list' });
    expect(c.commentsAnswer).toHaveBeenCalledWith('q3', { ok: false, error: 'editor-not-ready' }, 'other-token');
    fromEditor({ type: 'yc:office-comments-result', id: 'q2', result: { ok: true, id: 'e1' } });
    expect(c.commentsAnswer).toHaveBeenCalledWith('q2', { ok: true, id: 'e1' }, 't1');
    // Only the editor's own frame speaks for it.
    fromEditor({ type: 'yc:office-comments-result', id: 'q9', result: { ok: true } }, { source: null });
    expect(c.commentsAnswer).not.toHaveBeenCalledWith('q9', expect.anything());
  });

  it('says when a comment changed in the editor, naming the document by its token', async () => {
    const c = withComments();
    const { fromEditor } = await mountFrame();
    fromEditor({ type: 'yc:office-comments-changed' });
    expect(c.commentsChanged).toHaveBeenCalledWith('t1');
  });
});
