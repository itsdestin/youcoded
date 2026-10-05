// The one quit prompt (main/unsaved-quit.ts): a quit, or the last window's close, is refused before
// anything is torn down while a responding window has unsaved files — a text file, a parked draft,
// or an Office document not saved yet (Task 8) — and the refusal shows that window's list.
// (The Office save-before-close handshake these tests used to cover is gone: Task 8's recovery
// journal keeps what a closing window had not saved — tests/office/office-recovery.test.ts.)
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  OFFICE_DISMISS, OFFICE_OTHER_UNSAVED, OFFICE_PROCEED, OFFICE_UNSAVED_PROMPT,
  refuseCloseForUnsaved, refuseQuitForUnsaved, watchUnsavedEdits,
} from '../src/main/unsaved-quit';
import { gatedQuit, onWillQuit, quitAfterTeardown, requestRestart, resetRestartForTests } from '../src/main/app-restart';

/** A window, its main-side reports of unsaved files, and the prompts main sent it. */
function editing(id: number) {
  const ipc = new EventEmitter();
  watchUnsavedEdits(ipc as never);
  const pushes: unknown[] = [];
  const webContents = { id, isDestroyed: () => false, send: vi.fn((channel: string, p: unknown) => { if (channel === OFFICE_UNSAVED_PROMPT) pushes.push(p); }) };
  const focus = vi.fn();
  const win = { webContents, destroyed: false, isDestroyed() { return this.destroyed; }, close: vi.fn(), focus };
  const sender = Object.assign(new EventEmitter(), { id });
  const report = (names: string[] | boolean) => ipc.emit(OFFICE_OTHER_UNSAVED, { sender }, names);
  return { ipc, win, pushes, focus, report, sender };
}
const notHung = () => false;

describe('quitting while a file has unsaved changes', () => {
  it('refuses the quit with no teardown, and says so in that window', () => {
    const t = editing(21);
    t.report(['plan.docx']);
    expect(refuseQuitForUnsaved([t.win], notHung, { ipc: t.ipc as never })).toBe(true);
    expect(t.pushes).toEqual([{ mode: 'quit', afterTeardown: false, restartDropped: false }]);
    expect(t.focus).toHaveBeenCalled();
    t.report([]); // saved: the next quit goes ahead
    expect(refuseQuitForUnsaved([t.win], notHung, { ipc: t.ipc as never })).toBe(false);
    t.sender.emit('destroyed');
  });

  it('a restart is refused the same way, and never relaunches later', async () => {
    resetRestartForTests();
    const t = editing(22);
    t.report(true);
    requestRestart(() => {});
    const d = {
      gate: () => !refuseQuitForUnsaved([t.win], notHung, { ipc: t.ipc as never }),
      shutdown: vi.fn(async () => {}), relaunch: vi.fn(), quit: vi.fn(), openWindows: () => 1, exit: vi.fn(), setTimer: vi.fn(),
    };
    await gatedQuit(d);
    expect(d.shutdown).not.toHaveBeenCalled();
    const relaunch = vi.fn();
    onWillQuit(relaunch);
    expect(relaunch).not.toHaveBeenCalled();
    t.sender.emit('destroyed');
  });

  it('a file edited during teardown: the quit that follows is refused in that window, not forced', async () => {
    resetRestartForTests();
    const t = editing(24);
    requestRestart(() => {});
    const d = {
      gate: () => !refuseQuitForUnsaved([t.win], notHung, { ipc: t.ipc as never }),
      shutdown: vi.fn(async () => { t.report(true); }), // typed into a file while teardown ran
      relaunch: vi.fn(), quit: vi.fn(), openWindows: () => 1, exit: vi.fn(), setTimer: vi.fn(), clearTimer: vi.fn(),
      refuseForUnsaved: (o: { afterTeardown: boolean; restartDropped: boolean }) => refuseQuitForUnsaved([t.win], notHung, { ...o, ipc: t.ipc as never }),
    };
    await gatedQuit(d);
    expect(d.shutdown).toHaveBeenCalled();
    expect(quitAfterTeardown(d)).toBe(false); // the quit gatedQuit re-issued
    expect(d.exit).not.toHaveBeenCalled();
    expect(t.pushes).toEqual([{ mode: 'quit', afterTeardown: true, restartDropped: true }]);
    // "Discard and quit" goes on: main quits again (the prompt's proceed).
    const quits = vi.fn();
    expect(refuseQuitForUnsaved([t.win], notHung, { ipc: t.ipc as never, act: quits })).toBe(true);
    t.ipc.emit(OFFICE_PROCEED, { sender: { id: 24 } });
    expect(quits).toHaveBeenCalledTimes(1);
    const relaunch = vi.fn();
    onWillQuit(relaunch); // the restart was dropped
    expect(relaunch).not.toHaveBeenCalled();
    t.sender.emit('destroyed');
  });

  it("the last window's close is refused while it has unsaved changes; Discard closes it; another window's is not", () => {
    const t = editing(27);
    t.report(['notes.md']);
    const other = editing(28);
    const floater = editing(29);
    const isFloater = (w: unknown) => w === floater.win;
    expect(refuseCloseForUnsaved(t.win, isFloater, { ipc: t.ipc as never, windows: [t.win, other.win, floater.win], hung: notHung })).toBe(false);
    expect(refuseCloseForUnsaved(t.win, isFloater, { ipc: t.ipc as never, windows: [t.win, floater.win], hung: notHung })).toBe(true);
    expect(t.pushes).toEqual([{ mode: 'close', afterTeardown: false, restartDropped: false }]);
    t.ipc.emit(OFFICE_PROCEED, { sender: { id: 27 } }); // Discard and close
    expect(t.win.close).toHaveBeenCalledTimes(1);
    [t, other, floater].forEach((x) => x.sender.emit('destroyed'));
  });

  it('a dismissed refusal is forgotten: a later proceed does not quit', () => {
    const t = editing(31);
    t.report(true);
    const act = vi.fn();
    refuseQuitForUnsaved([t.win], notHung, { ipc: t.ipc as never, act });
    t.ipc.emit(OFFICE_DISMISS, { sender: { id: 31 } });
    t.ipc.emit(OFFICE_PROCEED, { sender: { id: 31 } });
    expect(act).not.toHaveBeenCalled();
    t.sender.emit('destroyed');
  });

  it('a hung last window is not asked about its changes (the hang question must be reachable)', () => {
    const t = editing(30);
    t.report(true);
    expect(refuseCloseForUnsaved(t.win, () => false, { ipc: t.ipc as never, windows: [t.win], hung: () => true })).toBe(false);
    expect(t.pushes).toEqual([]);
    expect(refuseCloseForUnsaved(t.win, () => false, { ipc: t.ipc as never, windows: [t.win], hung: notHung })).toBe(true);
    t.sender.emit('destroyed');
  });

  it('ignores a hung window, and forgets one whose page crashed', () => {
    const hung = editing(25);
    hung.report(true);
    expect(refuseQuitForUnsaved([hung.win], () => true, { ipc: hung.ipc as never })).toBe(false);
    hung.sender.emit('destroyed');
    const crashed = editing(26);
    crashed.report(true);
    crashed.sender.emit('render-process-gone');
    expect(refuseQuitForUnsaved([crashed.win], notHung, { ipc: crashed.ipc as never })).toBe(false);
    crashed.sender.emit('destroyed');
  });

  it('forgets a window once its page reloads or it is gone, and never keeps a folder', () => {
    const t = editing(23);
    t.report(['/home/you/secret/plan.docx']);
    t.sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    expect(refuseQuitForUnsaved([t.win], notHung, { ipc: t.ipc as never })).toBe(false);
    t.sender.emit('destroyed');
  });
});
