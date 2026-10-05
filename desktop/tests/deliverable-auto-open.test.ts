// Spec 2026-08-25 §3.1: a SendUserFile result with display:"render" opens the
// FIRST file, once per reply, only when seven guards hold. Each guard is pinned
// alone. The replay pin is the one that matters most: every old conversation
// replays its tool calls through this handler, and a wrong gate would yank
// the file panel open on every session switch.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDeliverableAutoOpen, FRESH_WINDOW_MS } from '../src/renderer/state/deliverable-auto-open';
import { ev } from './helpers/transcript-events';

const NOW = Date.parse('2026-08-25T12:00:00.000Z');

function makeDeps(overrides: Partial<Parameters<typeof createDeliverableAutoOpen>[0]> = {}) {
  const open = vi.fn();
  const deps = {
    getFocusedSessionId: () => 's1',
    canAutoOpen: () => true,
    guard: (action: () => void) => action(),
    open,
    ...overrides,
  };
  return { ao: createDeliverableAutoOpen(deps), open };
}

const use = (id: string, input: Record<string, unknown>, sessionId = 's1') =>
  ev('tool-use', { toolName: 'SendUserFile', toolUseId: id, toolInput: input }, { sessionId, uuid: `u-${id}`, timestamp: NOW });
// A live result: recorded just now (CC carries recordedAt; native carries a fresh timestamp).
const result = (id: string, opts: { isError?: boolean; recordedAt?: number; timestamp?: number; sessionId?: string } = {}) =>
  ev('tool-result', { toolUseId: id, toolResult: 'Sent 1 file to the user.', isError: opts.isError ?? false, ...(opts.recordedAt !== undefined ? { recordedAt: opts.recordedAt } : {}) },
    { sessionId: opts.sessionId ?? 's1', uuid: `r-${id}`, timestamp: opts.timestamp ?? NOW });
const userMessage = (sessionId = 's1') => ev('user-message', { text: 'next' }, { sessionId, uuid: 'um', timestamp: NOW });

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

describe('deliverable auto-open', () => {
  it('opens the FIRST file of a fresh, successful render call', () => {
    const { ao, open } = makeDeps();
    ao.handle(use('t1', { files: ['/p/a.html', '/p/b.md'], display: 'render' }));
    ao.handle(result('t1'));
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('s1', '/p/a.html');
  });

  it('never opens for attach or an omitted display', () => {
    const { ao, open } = makeDeps();
    ao.handle(use('t1', { files: ['/p/a.html'], display: 'attach' }));
    ao.handle(result('t1'));
    ao.handle(use('t2', { files: ['/p/a.html'] }));
    ao.handle(result('t2'));
    expect(open).not.toHaveBeenCalled();
  });

  it('REPLAY: a result recorded long ago never opens (CC recordedAt, native timestamp, and no recordedAt at all)', () => {
    const { ao, open } = makeDeps();
    ao.handle(use('cc', { files: ['/p/a.html'], display: 'render' }));
    ao.handle(result('cc', { recordedAt: NOW - 10 * 60_000 }));            // old line, fresh parse time
    ao.handle(use('nat', { files: ['/p/a.html'], display: 'render' }));
    ao.handle(result('nat', { timestamp: NOW - 10 * 60_000 }));            // native replay keeps its stamp
    ao.handle(use('none', { files: ['/p/a.html'], display: 'render' }));
    ao.handle(result('none', { recordedAt: 0 }));                          // watcher failed closed
    expect(open).not.toHaveBeenCalled();
  });

  it('a result just inside the freshness window opens; just outside does not', () => {
    const { ao, open } = makeDeps();
    ao.handle(use('a', { files: ['/p/a.html'], display: 'render' }));
    ao.handle(result('a', { recordedAt: NOW - FRESH_WINDOW_MS + 1000 }));
    expect(open).toHaveBeenCalledTimes(1);
    ao.handle(userMessage());
    ao.handle(use('b', { files: ['/p/b.html'], display: 'render' }));
    ao.handle(result('b', { recordedAt: NOW - FRESH_WINDOW_MS - 1000 }));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('one auto-open per reply; a user message starts the next reply', () => {
    const { ao, open } = makeDeps();
    ao.handle(use('t1', { files: ['/p/a.html'], display: 'render' }));
    ao.handle(result('t1'));
    ao.handle(use('t2', { files: ['/p/b.html'], display: 'render' }));
    ao.handle(result('t2'));
    expect(open).toHaveBeenCalledTimes(1);
    ao.handle(userMessage());
    ao.handle(use('t3', { files: ['/p/c.html'], display: 'render' }));
    ao.handle(result('t3'));
    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenLastCalledWith('s1', '/p/c.html');
  });

  it('an error result never opens', () => {
    const { ao, open } = makeDeps();
    ao.handle(use('t1', { files: ['/p/a.html'], display: 'render' }));
    ao.handle(result('t1', { isError: true }));
    expect(open).not.toHaveBeenCalled();
  });

  it('only the focused conversation opens', () => {
    const { ao, open } = makeDeps({ getFocusedSessionId: () => 'other' });
    ao.handle(use('t1', { files: ['/p/a.html'], display: 'render' }));
    ao.handle(result('t1'));
    expect(open).not.toHaveBeenCalled();
  });

  it('Android / narrow / non-Electron never open', () => {
    const { ao, open } = makeDeps({ canAutoOpen: () => false });
    ao.handle(use('t1', { files: ['/p/a.html'], display: 'render' }));
    ao.handle(result('t1'));
    expect(open).not.toHaveBeenCalled();
  });

  it('routes the open through the unsaved-edits guard', () => {
    const held: Array<() => void> = [];
    const { ao, open } = makeDeps({ guard: (action) => { held.push(action); } });
    ao.handle(use('t1', { files: ['/p/a.html'], display: 'render' }));
    ao.handle(result('t1'));
    expect(open).not.toHaveBeenCalled();     // parked behind the dialog
    held[0]();
    expect(open).toHaveBeenCalledWith('s1', '/p/a.html');
  });

  it('ignores results with no pending render call and malformed inputs', () => {
    const { ao, open } = makeDeps();
    ao.handle(result('nothing'));
    ao.handle(use('bad', { files: 'x', display: 'render' }));
    ao.handle(result('bad'));
    expect(open).not.toHaveBeenCalled();
  });

  it('REPLAY: the same toolUseId never opens twice even while its result is still fresh (switch away and back, re-dock)', () => {
    const { ao, open } = makeDeps();
    ao.handle(use('t1', { files: ['/p/a.html'], display: 'render' }));
    ao.handle(result('t1'));
    // A session switch replays the whole conversation: the turn boundary
    // resets the per-reply slot, then the identical call + result arrive again.
    ao.handle(userMessage());
    ao.handle(use('t1', { files: ['/p/a.html'], display: 'render' }));
    ao.handle(result('t1'));
    expect(open).toHaveBeenCalledTimes(1);
  });
});
