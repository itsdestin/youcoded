// Before a window with Office documents closes, main asks it to send its editors' newest edits to
// the recovery journal and waits — for the answer, or 1.5 s for a page that cannot answer.
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OFFICE_JOURNAL_DONE, OFFICE_JOURNAL_REQUEST, syncJournals } from '../../src/main/office/office-journal-sync';

afterEach(() => { vi.useRealTimers(); });

function windowOf(id: number, answers: boolean) {
  const ipc = new EventEmitter();
  const target = {
    id, isDestroyed: () => false,
    send: vi.fn((channel: string, reqId: string) => {
      if (channel === OFFICE_JOURNAL_REQUEST && answers) queueMicrotask(() => ipc.emit(OFFICE_JOURNAL_DONE, { sender: { id } }, reqId));
    }),
  };
  return { ipc, target };
}

describe('journaling the last edits before a window closes', () => {
  it("resolves on that window's answer to its own request", async () => {
    const { ipc, target } = windowOf(4, true);
    await syncJournals(target, ipc as never, 60_000);
    expect(target.send).toHaveBeenCalledWith(OFFICE_JOURNAL_REQUEST, expect.any(String));
    expect(ipc.listenerCount(OFFICE_JOURNAL_DONE)).toBe(0);
  });

  it("ignores another window's answer, and lets go after its cap when nothing answers", async () => {
    vi.useFakeTimers();
    const { ipc, target } = windowOf(5, false);
    let done = false;
    const p = syncJournals(target, ipc as never, 1_500).then(() => { done = true; });
    const id = target.send.mock.calls[0][1];
    ipc.emit(OFFICE_JOURNAL_DONE, { sender: { id: 99 } }, id);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(done).toBe(true);
  });
});
