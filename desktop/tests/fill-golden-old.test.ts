// The OLD fill paths, run over scripted sessions, against a golden recorded before R5-2 replaced them.
//
// WHY (one-core R5-2): the replacement is only safe if a screen filled by the new path shows what the old ones showed.
// This file drives the machinery that is being deleted - the remote snapshot (serialize a window's chat state, apply it
// with HYDRATE_CHAT_STATE) and the torn-off window's fill (one page to the end of the file, then the memory-only state
// replayed by sendLiveOnlyState) - and records what each screen shows. tests/fixtures/fill-golden.json is that record,
// written from the old code before anything moved. tests/fill-equivalence.test.ts then compares the new path to it.
//
// This test is deleted with the old paths it exercises; the golden stays.
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import { serializeChatState } from '../src/renderer/state/chat-types';
import { eventToAction } from '../src/renderer/state/transcript-event-actions';
import { hookEventToAction } from '../src/renderer/state/hook-dispatcher';
import { readTranscriptPage } from '../src/main/transcript-page';
import type { TranscriptEvent } from '../src/shared/types';
import { SCENARIOS, SID, runScenario, openAsksOf, applyPush, newState, screenOf, type Run, type Scenario } from './helpers/fill-scenarios';

const GOLDEN = path.join(__dirname, 'fixtures', 'fill-golden.json');

/** What the window that watched the session from its start shows. For a resumed Claude Code session its first page
 *  stopped at the resume boundary (the watcher's start) and carried the interrupted-tool reconcile. */
async function groundTruth(sc: Scenario, run: Run) {
  let state = newState();
  let from = 0;
  if (sc.kind === 'cc' && run.boundaryIndex !== null) {
    const page = await readTranscriptPage({ jsonlPath: run.diskPath!, sessionId: SID, endOffset: run.resumeOffset });
    state = chatReducer(state, { type: 'HISTORY_PAGE_REQUESTED', sessionId: SID });
    state = chatReducer(state, {
      type: 'HISTORY_PAGE_LOADED', sessionId: SID, events: page.events, cursor: page.cursor, hasMore: page.hasMore,
      reconcileInterrupted: false,
      reconcileInterruptedToolIds: [...new Set(page.events.filter((e) => e.type === 'tool-use').map((e) => e.data.toolUseId as string))],
    });
    from = run.boundaryIndex;
  }
  for (const p of run.pushes.slice(from)) state = applyPush(state, p);
  return state;
}

/** The old remote snapshot: a copy of that window's reducer, serialized and applied on a blank phone. */
function oldPhone(truth: ReturnType<typeof newState>) {
  const blank = newState();
  return chatReducer(blank, { type: 'HYDRATE_CHAT_STATE', sessions: serializeChatState(truth) });
}

/** The old torn-off window: one page read to the end of the file, then what only memory holds. */
async function oldWindow(sc: Scenario, run: Run, truth: ReturnType<typeof newState>) {
  let state = newState();
  state = chatReducer(state, { type: 'HISTORY_PAGE_REQUESTED', sessionId: SID });
  let events: TranscriptEvent[]; let cursor = null; let hasMore = false; let reconcileInterruptedToolIds: string[] | undefined;
  if (sc.kind === 'native') {
    events = run.nativeDisk!;
  } else {
    const page = await readTranscriptPage({ jsonlPath: run.diskPath!, sessionId: SID, endOffset: null });
    events = page.events; cursor = page.cursor; hasMore = page.hasMore;
    if (run.resumeOffset != null) {
      const old = await readTranscriptPage({ jsonlPath: run.diskPath!, sessionId: SID, endOffset: run.resumeOffset });
      reconcileInterruptedToolIds = [...new Set(old.events.filter((e) => e.type === 'tool-use').map((e) => e.data.toolUseId as string))];
    }
  }
  state = chatReducer(state, { type: 'HISTORY_PAGE_LOADED', sessionId: SID, events, cursor, hasMore, reconcileInterrupted: false, reconcileInterruptedToolIds });
  // replayLiveState: open asks (native only: "CC sessions have no broker-held asks"), then the replay-complete marker.
  if (sc.kind === 'native') for (const ask of openAsksOf(run)) { const a = hookEventToAction(ask); if (a) state = chatReducer(state, a); }
  const idle = sc.kind === 'native' && !truth.get(SID)!.isThinking;
  for (const a of eventToAction({ type: 'replay-complete', sessionId: SID, uuid: `replay-complete-${SID}`, timestamp: 1, data: { sessionIdle: idle } } as TranscriptEvent, { live: true })) state = chatReducer(state, a);
  return state;
}

async function collect() {
  const out: Record<string, { truth: unknown; phone: unknown; window: unknown }> = {};
  for (const sc of SCENARIOS) {
    const run = await runScenario(sc);
    try {
      const truth = await groundTruth(sc, run);
      out[sc.name] = { truth: screenOf(truth), phone: screenOf(oldPhone(truth)), window: screenOf(await oldWindow(sc, run, truth)) };
    } finally { run.cleanup(); }
  }
  return out;
}

describe('the old fill paths, over scripted sessions', () => {
  it('match the golden recorded before R5-2 (UPDATE_FILL_GOLDEN=1 rewrites it, from the OLD code only)', async () => {
    const got = await collect();
    if (process.env.UPDATE_FILL_GOLDEN === '1') fs.writeFileSync(GOLDEN, JSON.stringify(got, null, 2) + '\n');
    expect(got).toEqual(JSON.parse(fs.readFileSync(GOLDEN, 'utf8')));
  });

  it('the old phone copy equals what the watching window showed (a snapshot is a copy of it)', async () => {
    const got = await collect();
    for (const [name, v] of Object.entries(got)) expect(v.phone, name).toEqual(v.truth);
  });
});
