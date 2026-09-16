// A fake chatsearch:read answer in the shape the preview takes since
// 2026-09-16: one page of transcript events, keyed to the preview. Each text
// becomes a user message, so a test can find it on screen.
import { previewSessionKey } from '../../src/shared/chatsearch-refs';
import type { TranscriptEvent } from '../../src/shared/types';

export function previewPage(id: string, texts: string[], hasMore = false) {
  const sessionId = previewSessionKey(id);
  const events = texts.map((text, i) => ({
    type: 'user-message', sessionId, uuid: `${id}-u${i}`, timestamp: i + 1, data: { text },
  })) as TranscriptEvent[];
  return {
    ok: true as const,
    events,
    cursor: hasMore ? { path: '/x.jsonl', offset: 100, sizeAtRead: 1 } : null,
    hasMore,
  };
}
