// The visible half of the /clear fix. Entries above a `clear` marker must render
// faded and archived, exactly as entries above a `compact` marker already did —
// keeping the timeline is pointless if nothing signals those messages are out of
// the model's context.
//
// This imports the SAME function ChatView renders with. An earlier draft of this
// test re-implemented the loop locally and passed against its own copy; that is
// the trap this branch has already hit three times (a stored-but-never-compared
// key, an exported-but-never-called monotonic, a five-green-test helper nothing
// invoked), so the logic lives in a module both sides import.
import { describe, it, expect } from 'vitest';
import { findArchiveBoundary } from '../src/renderer/state/archive-boundary';
import type { TimelineEntry } from '../src/renderer/state/chat-types';

const user = { kind: 'user', message: { id: 'm', role: 'user', content: 'x', timestamp: 1 } } as TimelineEntry;
const marker = (variant: 'clear' | 'compact' | 'info') =>
  ({ kind: 'system-marker', marker: { id: variant, timestamp: 1, label: variant, variant } }) as TimelineEntry;

describe('findArchiveBoundary', () => {
  it('a clear marker archives everything above it', () => {
    expect(findArchiveBoundary([user, user, marker('clear'), user]))
      .toEqual({ index: 2, kind: 'clear' });
  });

  it('a compact marker still does, unchanged', () => {
    expect(findArchiveBoundary([user, marker('compact'), user]).kind).toBe('compact');
  });

  it('the LAST boundary wins when both are present', () => {
    // Compact then clear: only what is above the CLEAR is out of context.
    expect(findArchiveBoundary([user, marker('compact'), user, marker('clear'), user]))
      .toEqual({ index: 3, kind: 'clear' });
  });

  it('an ordinary info marker is NOT a boundary', () => {
    // Only compact and clear reset the model's context; a divider does not.
    expect(findArchiveBoundary([user, marker('info'), user]).index).toBe(-1);
  });

  it('no marker means nothing is faded', () => {
    expect(findArchiveBoundary([user, user])).toEqual({ index: -1, kind: null });
  });

  it('entries BELOW the boundary are never archived', () => {
    const tl = [user, marker('clear'), user, user];
    const { index } = findArchiveBoundary(tl);
    expect(tl.map((_, i) => index >= 0 && i < index)).toEqual([true, false, false, false]);
  });

  it('an empty timeline is not a crash', () => {
    expect(findArchiveBoundary([])).toEqual({ index: -1, kind: null });
  });

  // A native compaction keeps a recent tail ABOVE its marker (the marker is
  // appended after the tail). Only the part above the tail's first user message
  // is out of the model's context.
  const u = (uuid: string) => ({ kind: 'user', uuid, message: { id: uuid, role: 'user', content: uuid, timestamp: 1 } }) as TimelineEntry;
  const native = (retainedFromUuid: string | null) =>
    ({ kind: 'system-marker', marker: { id: 'n', timestamp: 1, label: 'c', variant: 'compact', retainedFromUuid } }) as TimelineEntry;

  it('native compaction fades only above the kept tail', () => {
    expect(findArchiveBoundary([u('a'), u('b'), u('c'), native('b'), u('d')]))
      .toEqual({ index: 1, kind: 'compact' });
  });

  it('native kept-tail message missing from the timeline: this marker dims nothing new', () => {
    expect(findArchiveBoundary([u('c'), native('paged-out'), u('d')])).toEqual({ index: -1, kind: null });
  });

  it('native marker with an unknown tail falls back to the previous boundary', () => {
    expect(findArchiveBoundary([u('a'), marker('clear'), u('b'), native(null)]))
      .toEqual({ index: 1, kind: 'clear' });
  });

  it('a second native compaction moves the line to its own kept tail', () => {
    expect(findArchiveBoundary([u('a'), u('b'), native('b'), u('c'), u('d'), native('d')]).index).toBe(4);
  });

  it('the buddy passes compact-only and ignores a later clear', () => {
    expect(findArchiveBoundary([u('a'), marker('compact'), u('b'), marker('clear')], ['compact']))
      .toEqual({ index: 1, kind: 'compact' });
  });

  it('a kept turn that opens with a /skill card fades above that card', () => {
    const skill = { kind: 'skill-invocation', id: 'skill-s1', skillId: 'x', displayName: 'X', timestamp: 1 } as TimelineEntry;
    expect(findArchiveBoundary([u('a'), skill, u('b'), native('s1')]).index).toBe(1);
  });
});
