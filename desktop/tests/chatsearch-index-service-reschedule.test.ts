// index-service: a metadata change that lands while a refresh cycle is running.
// WHY a separate file from chatsearch-index-service.test.ts: the vi.mock below
// replaces conversations/service for the whole file, and that file's
// onConversationMetaChanged cases need the real one.
//
// requestChatsearchRefresh's 3s debounce
// coalesces BURSTS of triggers before it fires, but a cycle that's still
// genuinely running when the timer fires used to have that trigger silently
// dropped — a tag/note applied mid-cycle stayed invisible to the CLI until the
// next session-end or app-launch refresh, while refreshedAt kept reporting the
// index as current. This test forces exactly that interleaving.
//
// index-service.ts's live-state gather goes through getConversationStore()
// (conversations/service) and getTagRegistry() (tag-registry-service) — both
// mocked here (never the fs module) so the test can hold the FIRST cycle
// suspended on a controlled promise and deterministically fire the debounce
// timer while it is still in flight. Everything refreshChatsearchIndex itself
// touches (the build lock, the meta file) still goes through real fs, scoped
// to os.homedir()'s test sandbox (see vitest.config.ts) and cleaned up below —
// no other test touches .youcoded/chatsearch/, so there's nothing to collide with.
import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';

// vi.hoisted: index-service.ts's static import of conversations/service is
// itself hoisted above this file's top-level code, so the mock factory below
// would otherwise run before a plain `const` had initialized — vi.hoisted
// forces this state to exist first.
const state = vi.hoisted(() => ({
  listCalls: [] as string[],
  deferredClaudeList: null as null | { resolve: (v: unknown[]) => void },
}));

vi.mock('../src/main/conversations/service', () => ({
  getConversationStore: () => ({
    // Read by refreshFromLiveState's synced-space backstop (see the
    // chatsearch-paths transcript-resolution fix) before store.list() is
    // called — the mock must supply it or that read throws and the cycle
    // never reaches list() at all. Its value is never exercised here since
    // every list() call in this test resolves to [], so resolveTranscriptPath
    // is never invoked.
    root: () => os.homedir(),
    list: (provider: string) => {
      state.listCalls.push(provider);
      // Only the FIRST 'claude' call is held open — later calls (the
      // rescheduled cycle) resolve immediately so the test can tell them apart.
      if (provider === 'claude' && state.listCalls.filter((p) => p === 'claude').length === 1) {
        return new Promise((resolve) => { state.deferredClaudeList = { resolve }; });
      }
      return Promise.resolve([]);
    },
  }),
  onConversationMetaChanged: () => () => {},
}));
vi.mock('../src/main/conversations/tag-registry-service', () => ({ getTagRegistry: () => null }));

import {
  requestChatsearchRefresh, startChatsearchIndex, stopChatsearchIndex,
} from '../src/main/chatsearch-index/index-service';
import { chatsearchDir } from '../src/main/chatsearch-index/index-store';

const claudeCalls = () => state.listCalls.filter((p) => p === 'claude').length;

// Drains whatever microtasks the currently-suspended async chain needs without
// advancing real wall-clock time — `advanceTimersByTimeAsync(0)` still pumps
// the microtask queue between checks, which is all that's needed to let
// `refreshFromLiveState` walk forward to its next await point.
const settle = async () => { await vi.advanceTimersByTimeAsync(0); await vi.advanceTimersByTimeAsync(0); };

describe('chatsearch metadata-change reschedule', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    state.listCalls.length = 0;
    state.deferredClaudeList = null;
  });

  afterEach(() => {
    stopChatsearchIndex();
    vi.useRealTimers();
    try { fs.rmSync(chatsearchDir(os.homedir()), { recursive: true, force: true }); } catch {}
  });

  it('runs one more cycle after a trigger arrives mid-cycle, instead of dropping it', async () => {
    startChatsearchIndex(); // startup scan: first store.list('claude') call, suspended on our deferred promise
    await settle();
    expect(claudeCalls()).toBe(1);
    expect(state.deferredClaudeList).not.toBeNull();

    // A tag/note change arrives while cycle 1 is still in flight.
    requestChatsearchRefresh();
    await vi.advanceTimersByTimeAsync(3_000); // debounce timer fires here
    await settle();

    // The fired trigger must be REMEMBERED, not started as a concurrent second
    // cycle (that would race the same build lock) and not silently dropped.
    expect(claudeCalls()).toBe(1);

    // Let cycle 1 finish.
    state.deferredClaudeList!.resolve([]);
    await settle();
    await settle();

    // The remembered trigger ran as a second cycle once the first finished.
    expect(claudeCalls()).toBe(2);
  });

  it('does not queue a rerun when no trigger arrives during the cycle', async () => {
    startChatsearchIndex();
    await settle();
    expect(claudeCalls()).toBe(1);

    state.deferredClaudeList!.resolve([]);
    await settle();
    await settle();

    // Nothing requested a refresh mid-cycle, so there is nothing to catch up on.
    expect(claudeCalls()).toBe(1);
  });
});
