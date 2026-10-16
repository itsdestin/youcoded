// @vitest-environment jsdom
//
// A permission ask for the NEXT tool call must never split the bubble of the
// sentence currently streaming. Found 2026-09-28: the UI Workbench's
// `permission-approve.json` journey intermittently rendered one reply
// ("Draft is in Reports/Q3-draft.md for your review. Now the invites.") as
// TWO chat bubbles, split mid-sentence at a different word each time —
// Destin confirmed the same split in the real app, not just the workbench.
//
// Root cause: App.tsx dispatches hook-derived actions (PermissionRequest, …)
// straight to the chat store, but TRANSCRIPT_ASSISTANT_TEXT deltas wait for
// the transcript batcher's next animation frame (state/transcript-batch.ts).
// PERMISSION_REQUEST's "hook arrived before the matching tool_use" branch
// (chat-reducer.ts) creates a synthetic placeholder tool and unconditionally
// appends a tool-group segment onto the CURRENT assistant turn. If that runs
// while the tail of an in-progress same-partId text stream is still queued
// in the batcher (not yet applied), the tool-group lands ahead of those
// queued deltas. When they flush, the turn's last segment is that tool-group
// rather than the matching text segment, so they open a SECOND text segment
// instead of merging into the first — one sentence, two bubbles
// (AssistantTurnBubble.tsx `splitIntoBubbles`: a second stretch of speech
// always gets its own bubble).
//
// This drives the REAL App.tsx + REAL chat reducer + REAL transcript batcher
// (tests/helpers/busy-app.tsx) under a hand-stepped fake clock, so the race
// is reproduced by construction rather than by wall-clock luck.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

vi.mock('@xterm/xterm', async () => (await import('./helpers/busy-app-probes')).fakeXtermModule());
vi.mock('@xterm/addon-fit', async () => (await import('./helpers/busy-app-probes')).fakeAddonModule('FitAddon'));
vi.mock('@xterm/addon-unicode11', async () => (await import('./helpers/busy-app-probes')).fakeAddonModule('Unicode11Addon'));
vi.mock('@xterm/addon-webgl', async () => (await import('./helpers/busy-app-probes')).fakeAddonModule('WebglAddon'));
// mountBusyApp's visibleId()/switchTo() read this probe's `visible` prop —
// without it every session reads as invisible (see busy-app-render-budget.test.tsx).
vi.mock('../src/renderer/components/ChatView', async (importOriginal) => {
  const real = await importOriginal<any>();
  return { ...real, default: (await import('./helpers/busy-app-probes')).probe(real.default, 'chat') };
});
vi.mock('../src/renderer/components/TerminalView', async (importOriginal) => {
  const real = await importOriginal<any>();
  return { ...real, default: (await import('./helpers/busy-app-probes')).probe(real.default, 'terminal') };
});

import { mountBusyApp, FAKE_TIMERS, FRAME_MS, type BusyApp } from './helpers/busy-app';

// Importing App.tsx transforms the whole renderer graph — pay it once
// (test-suite-hygiene.md: a file's one-time cost is warmed in beforeAll under
// its own named budget, never inside the first test).
const WARM_IMPORT_BUDGET_MS = 120_000;
beforeAll(async () => { await import('../src/renderer/App'); }, WARM_IMPORT_BUDGET_MS);

let app: BusyApp;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
  app = await mountBusyApp({ sessions: 1 });
});
afterEach(() => {
  expect(app?.crashes() ?? []).toEqual([]);
  vi.useRealTimers();
});

/** Rendered chat bubbles whose text mentions either streamed word. */
function bubblesWithReplyText(): string[] {
  return [...document.querySelectorAll('.assistant-bubble')]
    .map((el) => el.textContent ?? '')
    .filter((t) => t.includes('word') || t.includes('tail'));
}

describe('a permission ask arriving mid-stream', () => {
  it('does not split the in-progress reply into two bubbles', async () => {
    const id = app.visibleId();
    const reply = await app.beginReply(id);
    // One delta of the reply's single partId streams and flushes normally —
    // there is now one open text segment.
    await reply.words(1);
    // A second delta of the SAME partId is pushed but deliberately not
    // flushed: it sits in the transcript batcher's queue, exactly as a real
    // delta would while waiting for the next animation frame.
    reply.pushWord('tail');
    // The ask for an unrelated, not-yet-seen tool call arrives now — hook
    // events dispatch immediately, so without the fix this lands its
    // synthetic tool-group segment on the turn AHEAD of the still-queued
    // delta above.
    app.permissionRequest(id, 'req-1', 'mcp__google_calendar__create_event', { title: 'Team sync' });
    // Now let the queued delta's frame fire.
    await app.wait(FRAME_MS);

    const bubbles = bubblesWithReplyText();
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]).toContain('word tail');
  });
});
