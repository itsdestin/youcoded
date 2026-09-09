// Contract for SessionStore — native session JSONL persistence (Phase 1 Task 7).
// Line 1 = header, lines 2+ = transcript events, per-partId delta coalescing.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { NativeHome } from '../src/main/native-home';
import { SessionStore, type NativeSessionHeader } from '../src/main/harness/session-store';

const HEADER: NativeSessionHeader = {
  v: 1,
  sessionId: 's-1',
  harnessId: 'chat',
  binding: { providerId: 'openrouter', modelId: 'meta-llama/llama-3-8b' },
  cwd: 'C:/Users/x/proj',
  createdAt: 1720600000000,
};
const ev = (type: string, data: any, uuid: string) => ({
  type,
  sessionId: 's-1',
  uuid,
  timestamp: 1720600001000,
  data,
});

describe('SessionStore', () => {
  let root: string;
  let store: SessionStore;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-sstore-'));
    store = new SessionStore(new NativeHome(root));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('create writes the header as line 1; readHeader round-trips', async () => {
    await store.create(HEADER);
    expect(store.readHeader('s-1', HEADER.cwd)).toEqual(HEADER);
  });

  it('normalizes malformed stepGuard on every header read path', async () => {
    await store.create({ ...HEADER, stepGuard: 'bad' as any });
    expect(store.readHeader('s-1', HEADER.cwd)).toEqual(HEADER);
    expect(store.list()).toEqual([expect.objectContaining({ sessionId: 's-1' })]);
    expect(store.list()[0]).not.toHaveProperty('stepGuard');
  });

  it('coalesces same-partId text deltas into ONE persisted event with concatenated text', async () => {
    await store.create(HEADER);
    await store.append(HEADER.cwd, ev('user-message', { text: 'hi' }, 'u1') as any);
    await store.append(HEADER.cwd, ev('assistant-text', { text: 'Hel', partId: 'p1' }, 'a1') as any);
    await store.append(HEADER.cwd, ev('assistant-text', { text: 'lo!', partId: 'p1' }, 'a2') as any);
    await store.append(HEADER.cwd, ev('turn-complete', { stopReason: 'end_turn' }, 't1') as any); // flushes the open part
    const events = store.readEvents('s-1', HEADER.cwd);
    expect(events.map((e: any) => e.type)).toEqual(['user-message', 'assistant-text', 'turn-complete']);
    expect((events[1] as any).data).toMatchObject({ text: 'Hello!', partId: 'p1' });
  });

  it('never persists session-error events', async () => {
    await store.create(HEADER);
    await store.append(HEADER.cwd, ev('session-error', { text: 'boom' }, 'e1') as any);
    expect(store.readEvents('s-1', HEADER.cwd)).toEqual([]);
  });

  // session-error is a turn boundary: it must flush the open part (the partial
  // assistant text the user already saw live) even though its own line is
  // display-only and never hits disk.
  it('session-error flushes the open part but is not itself persisted', async () => {
    await store.create(HEADER);
    await store.append(HEADER.cwd, ev('assistant-text', { text: 'Hel', partId: 'p1' }, 'a1') as any);
    await store.append(HEADER.cwd, ev('assistant-text', { text: 'lo!', partId: 'p1' }, 'a2') as any);
    await store.append(HEADER.cwd, ev('session-error', { text: 'boom' }, 'e1') as any);
    const events = store.readEvents('s-1', HEADER.cwd);
    expect(events.map((e: any) => e.type)).toEqual(['assistant-text']);
    expect((events[0] as any).data).toMatchObject({ text: 'Hello!', partId: 'p1' });
  });

  it('never persists a watchdog stall-warning heartbeat (text-less, partId-less assistant-thinking)', async () => {
    await store.create(HEADER);
    await store.append(HEADER.cwd, ev('user-message', { text: 'hi' }, 'u1') as any);
    await store.append(HEADER.cwd, ev('assistant-thinking', { stallWarning: { retryInMs: 15000, willRetry: true } }, 'w1') as any);
    await store.append(HEADER.cwd, ev('assistant-thinking', {}, 'w2') as any); // the clear heartbeat
    const events = store.readEvents('s-1', HEADER.cwd);
    // Only the user message survives — both watchdog heartbeats are display-only.
    expect(events.map((e: any) => e.type)).toEqual(['user-message']);
  });

  // A watchdog heartbeat is display-only but — unlike session-error — is NOT a
  // turn boundary, so it must leave the open streaming part buffered (the stream
  // may resume the same partId), not flush it early.
  it('a stall-warning heartbeat does NOT flush the open streaming part', async () => {
    await store.create(HEADER);
    await store.append(HEADER.cwd, ev('assistant-text', { text: 'Hel', partId: 'p1' }, 'a1') as any);
    await store.append(HEADER.cwd, ev('assistant-thinking', { stallWarning: { retryInMs: 15000, willRetry: false } }, 'w1') as any);
    await store.append(HEADER.cwd, ev('assistant-text', { text: 'lo!', partId: 'p1' }, 'a2') as any);
    await store.append(HEADER.cwd, ev('turn-complete', { stopReason: 'end_turn' }, 't1') as any);
    const events = store.readEvents('s-1', HEADER.cwd);
    // The heartbeat did not split the part — both deltas coalesced into one.
    expect(events.map((e: any) => e.type)).toEqual(['assistant-text', 'turn-complete']);
    expect((events[0] as any).data).toMatchObject({ text: 'Hello!', partId: 'p1' });
  });

  // The parked-turn card is display-only in exactly the same way the stall
  // warning is: not persisted, and NOT a turn boundary. This matters more than
  // it did before — a parked turn's stream may still resume into the same part.
  it('a stalled card heartbeat is not persisted and does NOT flush the open part', async () => {
    await store.create(HEADER);
    await store.append(HEADER.cwd, ev('assistant-text', { text: 'Hel', partId: 'p1' }, 'a1') as any);
    await store.append(HEADER.cwd, ev('assistant-thinking', { stalled: true }, 'w1') as any);
    await store.append(HEADER.cwd, ev('assistant-text', { text: 'lo!', partId: 'p1' }, 'a2') as any);
    await store.append(HEADER.cwd, ev('turn-complete', { stopReason: 'end_turn' }, 't1') as any);
    const events = store.readEvents('s-1', HEADER.cwd);
    expect(events.map((e: any) => e.type)).toEqual(['assistant-text', 'turn-complete']);
    expect((events[0] as any).data).toMatchObject({ text: 'Hello!', partId: 'p1' });
  });

  it('dropPart discards the buffered open part instead of writing it', async () => {
    // Manual Retry: the abandoned half-sentence must never reach the JSONL, or
    // a resume would replay text the user watched disappear.
    await store.create(HEADER);
    await store.append(HEADER.cwd, ev('assistant-text', { text: 'Now I will', partId: 'p1' }, 'a1') as any);
    await store.append(HEADER.cwd, ev('assistant-thinking', { dropPart: { partIds: ['p1'] } }, 'd1') as any);
    await store.append(HEADER.cwd, ev('assistant-text', { text: 'recovered', partId: 'p2' }, 'a2') as any);
    await store.append(HEADER.cwd, ev('turn-complete', { stopReason: 'end_turn' }, 't1') as any);
    const events = store.readEvents('s-1', HEADER.cwd);
    expect(events.map((e: any) => e.type)).toEqual(['assistant-text', 'turn-complete']);
    expect((events[0] as any).data).toMatchObject({ text: 'recovered', partId: 'p2' });
  });

  it('dropPart for a DIFFERENT partId leaves the open part alone', async () => {
    await store.create(HEADER);
    await store.append(HEADER.cwd, ev('assistant-text', { text: 'keep me', partId: 'p1' }, 'a1') as any);
    await store.append(HEADER.cwd, ev('assistant-thinking', { dropPart: { partIds: ['other'] } }, 'd1') as any);
    await store.append(HEADER.cwd, ev('turn-complete', { stopReason: 'end_turn' }, 't1') as any);
    const events = store.readEvents('s-1', HEADER.cwd);
    expect(events.map((e: any) => e.type)).toEqual(['assistant-text', 'turn-complete']);
    expect((events[0] as any).data).toMatchObject({ text: 'keep me', partId: 'p1' });
  });

  // Reproduces the LIVE defect verbatim: a manual Retry re-runs the stalled
  // step, and the SDK's fallback partId ('text-0') means the re-run's first
  // delta usually arrives with the SAME partId as the abandoned attempt. Before
  // the fix, dropPart hit the display-only early return without clearing the
  // buffer, so this same-partId delta matched the stale buffered entry and got
  // CONCATENATED onto it — on this commit, that persisted
  // "Now I will dispatchrecovered" to disk. The buffer must be gone by the
  // time this delta arrives, so the new delta starts a fresh part instead of
  // merging into the abandoned one.
  it('a same-partId delta after dropPart persists only the new text, not the concatenation (live defect repro)', async () => {
    await store.create(HEADER);
    await store.append(HEADER.cwd, ev('assistant-text', { text: 'Now I will dispatch', partId: 'p1' }, 'a1') as any);
    await store.append(HEADER.cwd, ev('assistant-thinking', { dropPart: { partIds: ['p1'] } }, 'd1') as any);
    await store.append(HEADER.cwd, ev('assistant-text', { text: 'recovered', partId: 'p1' }, 'a2') as any);
    await store.append(HEADER.cwd, ev('turn-complete', { stopReason: 'end_turn' }, 't1') as any);
    const events = store.readEvents('s-1', HEADER.cwd);
    expect(events.map((e: any) => e.type)).toEqual(['assistant-text', 'turn-complete']);
    expect((events[0] as any).data).toMatchObject({ text: 'recovered', partId: 'p1' });
  });

  it('never persists a toolPreparing heartbeat, and does not flush the open part', async () => {
    // Partial tool arguments must not reach the JSONL — a resume would replay a
    // half-written file. The filter this relies on keys off "assistant-thinking
    // with no text and no partId", so ADDING A FIELD to that event is exactly
    // how it would silently regress.
    await store.create(HEADER);
    await store.append(HEADER.cwd, ev('assistant-text', { text: 'Writing', partId: 'p1' }, 'u-1') as any);
    await store.append(HEADER.cwd, ev('assistant-thinking', {
      toolPreparing: { toolCallId: 'c1', toolName: 'Write', chars: 512 },
    }, 'u-2') as any);
    await store.append(HEADER.cwd, ev('assistant-text', { text: ' a file', partId: 'p1' }, 'u-3') as any);
    await store.append(HEADER.cwd, ev('turn-complete', {}, 'u-4') as any);

    const events = store.readEvents('s-1', HEADER.cwd);
    expect(events.some((e: any) => e.data?.toolPreparing)).toBe(false);
    // The open p1 part was NOT flushed by the heartbeat: both halves coalesced
    // into ONE persisted assistant-text.
    const texts = events.filter((e: any) => e.type === 'assistant-text');
    expect(texts).toHaveLength(1);
    expect((texts[0] as any).data.text).toBe('Writing a file');
  });

  it('a new partId flushes the previous open part', async () => {
    await store.create(HEADER);
    await store.append(HEADER.cwd, ev('assistant-thinking', { text: 'thi', partId: 'r1' }, 'r1a') as any);
    await store.append(HEADER.cwd, ev('assistant-text', { text: 'Answer', partId: 'p1' }, 'a1') as any);
    await store.append(HEADER.cwd, ev('turn-complete', {}, 't1') as any);
    const types = store.readEvents('s-1', HEADER.cwd).map((e: any) => e.type);
    expect(types).toEqual(['assistant-thinking', 'assistant-text', 'turn-complete']);
  });

  it('readEvents dedups by uuid', async () => {
    await store.create(HEADER);
    await store.append(HEADER.cwd, ev('user-message', { text: 'hi' }, 'u1') as any);
    await store.append(HEADER.cwd, ev('user-message', { text: 'hi' }, 'u1') as any); // double-append
    expect(store.readEvents('s-1', HEADER.cwd)).toHaveLength(1);
  });

  it('list surfaces sessions with header metadata for the Resume Browser', async () => {
    await store.create(HEADER);
    await store.append(HEADER.cwd, ev('user-message', { text: 'hi' }, 'u1') as any);
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ sessionId: 's-1', cwd: 'C:/Users/x/proj', harnessId: 'chat' });
  });

  it('derives a title from the first user message when the header has none', async () => {
    await store.create(HEADER);
    await store.append(HEADER.cwd, ev('user-message', { text: 'explain quantum tunneling to me' }, 'u1') as any);
    expect(store.list()[0].title).toBe('explain quantum tunneling to me');
  });

  it('dispose flushes the in-flight part and clears the open buffer', async () => {
    await store.create(HEADER);
    await store.append(HEADER.cwd, ev('assistant-text', { text: 'partial', partId: 'p1' }, 'a1') as any);
    await store.dispose('s-1'); // graceful mid-stream teardown — must persist the part
    // The part is now on disk...
    expect(store.readEvents('s-1', HEADER.cwd)).toMatchObject([{ type: 'assistant-text', data: { text: 'partial' } }]);
    // ...and the open map no longer holds it: a follow-up delta with the SAME
    // partId opens a FRESH part instead of concatenating onto the disposed one.
    await store.append(HEADER.cwd, ev('assistant-text', { text: 'second', partId: 'p1' }, 'a2') as any);
    await store.append(HEADER.cwd, ev('turn-complete', {}, 't1') as any);
    const texts = store.readEvents('s-1', HEADER.cwd).filter((e: any) => e.type === 'assistant-text').map((e: any) => e.data.text);
    expect(texts).toEqual(['partial', 'second']); // two separate parts, not 'partialsecond'
  });

  it('flushAll flushes open parts across multiple sessions', async () => {
    const HEADER2: NativeSessionHeader = { ...HEADER, sessionId: 's-2' };
    const ev2 = (type: string, data: any, uuid: string) => ({ type, sessionId: 's-2', uuid, timestamp: 1720600001000, data });
    await store.create(HEADER);
    await store.create(HEADER2);
    await store.append(HEADER.cwd, ev('assistant-text', { text: 'one', partId: 'p1' }, 'a1') as any);
    await store.append(HEADER2.cwd, ev2('assistant-text', { text: 'two', partId: 'p1' }, 'b1') as any);
    await store.flushAll();
    expect(store.readEvents('s-1', HEADER.cwd)).toMatchObject([{ data: { text: 'one' } }]);
    expect(store.readEvents('s-2', HEADER2.cwd)).toMatchObject([{ data: { text: 'two' } }]);
  });

  it('preserves ordering across multiple turns', async () => {
    await store.create(HEADER);
    // Turn 1
    await store.append(HEADER.cwd, ev('user-message', { text: 'q1' }, 'u1') as any);
    await store.append(HEADER.cwd, ev('assistant-text', { text: 'a1', partId: 'p1' }, 'a1') as any);
    await store.append(HEADER.cwd, ev('turn-complete', {}, 't1') as any);
    // Turn 2
    await store.append(HEADER.cwd, ev('user-message', { text: 'q2' }, 'u2') as any);
    await store.append(HEADER.cwd, ev('assistant-text', { text: 'a2', partId: 'p2' }, 'a2') as any);
    await store.append(HEADER.cwd, ev('turn-complete', {}, 't2') as any);
    const types = store.readEvents('s-1', HEADER.cwd).map((e: any) => e.type);
    expect(types).toEqual(['user-message', 'assistant-text', 'turn-complete', 'user-message', 'assistant-text', 'turn-complete']);
  });

  it('coalesces interleaved reasoning/text parts within one turn, in order', async () => {
    await store.create(HEADER);
    await store.append(HEADER.cwd, ev('assistant-thinking', { text: 'think-a', partId: 'r1' }, 'r1a') as any);
    await store.append(HEADER.cwd, ev('assistant-thinking', { text: '-b', partId: 'r1' }, 'r1b') as any);
    await store.append(HEADER.cwd, ev('assistant-text', { text: 'answer', partId: 'p1' }, 'a1') as any);
    await store.append(HEADER.cwd, ev('assistant-thinking', { text: 'more-think', partId: 'r2' }, 'r2a') as any);
    await store.append(HEADER.cwd, ev('turn-complete', {}, 't1') as any);
    const events = store.readEvents('s-1', HEADER.cwd);
    expect(events.map((e: any) => e.type)).toEqual(['assistant-thinking', 'assistant-text', 'assistant-thinking', 'turn-complete']);
    expect((events[0] as any).data).toMatchObject({ text: 'think-a-b', partId: 'r1' });
    expect((events[1] as any).data).toMatchObject({ text: 'answer', partId: 'p1' });
    expect((events[2] as any).data).toMatchObject({ text: 'more-think', partId: 'r2' });
  });

  // Passthrough pin (Task 10): tool-use / tool-result are NON-delta events, so
  // append persists them VERBATIM (no coalescing) — a resume rebuild depends on
  // reading them back byte-for-byte, INCLUDING the Edit/MultiEdit structuredPatch
  // hunks that the ToolCard diff view renders. This is the store half of the
  // resume contract (rebuildHistory is the other half).
  it('round-trips a tool-use/tool-result pair through append→readEvents unchanged (incl. structuredPatch)', async () => {
    await store.create(HEADER);
    const useEvent = ev('tool-use', {
      toolUseId: 'call-1', toolName: 'Edit', toolInput: { file_path: 'a.ts', old_string: 'x', new_string: 'y' },
    }, 'tu1') as any;
    const structuredPatch = [
      { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [' ctx', '-x', '+y'] },
    ];
    const resultEvent = ev('tool-result', {
      toolUseId: 'call-1', toolName: 'Edit', toolResult: 'Edited a.ts', isError: false, structuredPatch,
    }, 'tr1') as any;
    await store.append(HEADER.cwd, useEvent);
    await store.append(HEADER.cwd, resultEvent);
    const events = store.readEvents('s-1', HEADER.cwd);
    // Deep-equal both events verbatim — nothing coalesced, nothing dropped, and
    // the nested structuredPatch survives the JSON round-trip intact.
    expect(events).toEqual([useEvent, resultEvent]);
    expect((events[1] as any).data.structuredPatch).toEqual(structuredPatch);
  });

  // Clone-semantics pin (Task 7 self-review requirement): the buffered open
  // part must be a CLONE — mutating the caller's event object after append()
  // returns must not change what ends up on disk.
  it('buffered deltas are clones — caller mutation after append does not leak into the file', async () => {
    await store.create(HEADER);
    const delta = ev('assistant-text', { text: 'Hel', partId: 'p1' }, 'a1') as any;
    await store.append(HEADER.cwd, delta);
    delta.data.text = 'CORRUPTED';
    delta.data.partId = 'poisoned';
    await store.append(HEADER.cwd, ev('assistant-text', { text: 'lo!', partId: 'p1' }, 'a2') as any);
    await store.append(HEADER.cwd, ev('turn-complete', {}, 't1') as any);
    const events = store.readEvents('s-1', HEADER.cwd);
    expect((events[0] as any).data).toMatchObject({ text: 'Hello!', partId: 'p1' });
  });

  // has() backs the phantom-record gate (2026-07-18): ipc-handlers asks "is this
  // id native?" before letting a flag/note seed a conversation-store record.
  // It must answer for PERSISTED sessions, not just live ones — a past native
  // session opened from the Resume Browser is not live but must still be
  // recognized, which is the case isNative()/this.live cannot answer.
  describe('has', () => {
    it('finds a persisted session regardless of which project it lives under', async () => {
      await store.create(HEADER);
      expect(store.has('s-1')).toBe(true);
    });

    it('is false for an unknown id, and does not require the session to be live', async () => {
      await store.create(HEADER);
      expect(store.has('never-existed')).toBe(false);
      // Nothing here is "live" — the store has no concept of liveness — so a
      // true answer above proves the check is disk-backed, not registry-backed.
    });

    it('is false when no sessions directory exists at all', () => {
      expect(store.has('s-1')).toBe(false); // no create() call in this test
    });
  });

  describe('specialist child headers (plan 1a)', () => {
    const CHILD: NativeSessionHeader = {
      ...HEADER, sessionId: 'child-1',
      parentSessionId: 'root-1', sessionKind: 'specialist', agentType: 'explorer',
    };
    it('round-trips the additive child fields through create() and readHeader', async () => {
      await store.create(CHILD);
      const back = store.readHeader('child-1', HEADER.cwd);
      expect(back?.parentSessionId).toBe('root-1');
      expect(back?.agentType).toBe('explorer');
    });
    it('list() hides specialist children by default and includes them on request', async () => {
      await store.create({ ...HEADER, sessionId: 'root-1' });
      await store.create(CHILD);
      const defaults = await store.list();
      expect(defaults.map(e => e.sessionId)).toEqual(['root-1']);
      const all = await store.list({ includeChildren: true });
      expect(all.map(e => e.sessionId).sort()).toEqual(['child-1', 'root-1']);
    });
    it('a v1 header WITHOUT the new fields still validates (no migration)', async () => {
      await store.create({ ...HEADER, sessionId: 'old-1' });   // exactly the pre-plan-1a field set
      const back = store.readHeader('old-1', HEADER.cwd);
      expect(back?.sessionId).toBe('old-1');
      expect(back?.parentSessionId).toBeUndefined();
      expect(back?.sessionKind).toBeUndefined();
    });
  });
});

// Task 3 (M2 plan) — pins the DELIBERATE divergence documented at the top of
// slug-encoding.ts: native sessions use the FROZEN nativeStoreSlug, while the
// CC mirror (ccProjectSlug) additionally uppercases a lowercase Windows drive
// letter before slugifying. This is NOT a bug to unify — see that file's
// comment for why (it would orphan existing native transcripts).
describe('native/CC slug divergence — FREEZE PIN, do not delete', () => {
  it('native uses the frozen rule; the CC mirror drive-normalizes', async () => {
    const { nativeStoreSlug, ccProjectSlug } = await import('../src/main/slug-encoding');
    expect(nativeStoreSlug('c:\\Users\\d\\proj')).toBe('c--Users-d-proj');
    expect(ccProjectSlug('c:\\Users\\d\\proj')).toBe('C--Users-d-proj');   // NOT equal — pinned
  });
});
