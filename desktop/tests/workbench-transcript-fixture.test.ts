// The workbench's fake transcript must produce what the real reader produces:
// pages of transcript events that the preview replays through the chat
// reducer (2026-09-16), including a real tool group — the shape a reviewer
// most needs to see, and the one the old flat preview got wrong.
//
// Same family as tests/workbench-event-contract.test.ts (2026-09-09), where the
// fake dispatched an event the product never sent: a fake that disagrees with
// the product is worse than no fake, because it is what everyone reviews.
import { describe, it, expect } from 'vitest';
import { createStore } from '../src/renderer/dev/workbench/mock-store';
import { createMockShim, setLatency } from '../src/renderer/dev/workbench/mock-shim';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import type { ChatState } from '../src/renderer/state/chat-types';
import type { TranscriptEvent, TranscriptPageResult } from '../src/shared/types';

setLatency(0);

const ID = 'wb-past-0';
const KEY = `preview:${ID}`;

async function allPages(): Promise<TranscriptPageResult[]> {
  const shim = createMockShim(createStore('default')) as any;
  const pages: TranscriptPageResult[] = [];
  let before: number | undefined;
  for (let n = 0; n < 20; n++) {
    const res = await shim.chatsearch.read({ provider: 'claude', id: ID, ...(before === undefined ? {} : { before }) });
    expect(res.ok).toBe(true);
    pages.push(res);
    if (!res.hasMore) break;
    before = res.cursor.offset;
  }
  return pages;
}

// Exactly what SessionPreviewPane does with each page.
function replay(pages: TranscriptPageResult[]) {
  let state: ChatState = chatReducer(new Map(), { type: 'SESSION_INIT', sessionId: KEY });
  for (const p of pages) {
    state = chatReducer(state, { type: 'HISTORY_PAGE_LOADED', sessionId: KEY, events: p.events, cursor: p.cursor, hasMore: p.hasMore });
  }
  return state.get(KEY)!;
}

describe('the workbench transcript fixture', () => {
  it('pages back to the start without repeating anything', async () => {
    const pages = await allPages();
    expect(pages.length).toBeGreaterThan(1);
    const uuids = pages.flatMap((p) => p.events.map((e: TranscriptEvent) => e.uuid));
    expect(new Set(uuids).size).toBe(uuids.length);
    expect(pages.every((p) => p.events.every((e: TranscriptEvent) => e.sessionId === KEY))).toBe(true);
  });

  it('replays into a chat with a real tool group inside an assistant turn', async () => {
    const s = replay(await allPages());
    expect(s.toolGroups.size).toBeGreaterThan(0);
    expect([...s.toolCalls.values()].every((t) => t.status === 'complete')).toBe(true);
    expect(s.timeline.filter((e) => e.kind === 'user').length).toBe(24);
  });

  it('reads as a conversation, not as counters', async () => {
    const texts = (await allPages()).flatMap((p) => p.events)
      .filter((e) => e.type === 'user-message' || e.type === 'assistant-text')
      .map((e) => String(e.data.text));
    expect(texts.some((t) => /step \d+|question number \d+/i.test(t))).toBe(false);
    expect(texts.every((t) => t.trim().length > 0)).toBe(true);
  });
});
