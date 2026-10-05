// Typed builders for transcript events in tests (M5, one-core R4-4).
//
// WHY: `TranscriptEvent` is a union keyed on `type`, so a test that builds one
// from a bare `{ type: 'tool-use', data: {...} }` literal gets `type: string` and
// no check that `data` belongs to that type. `ev` ties the two together exactly
// like the producers' `emitEvent<T>` does, so a fixture with a wrong field is a
// compile error here too instead of a test that passes on a shape nobody sends.
import type { TranscriptEvent, TranscriptEventType, DataOf, EventOf } from '../../src/shared/types';

/** Envelope fields a test may override (everything except the type/data pair). */
export type EventEnvelope = Partial<Omit<TranscriptEvent, 'type' | 'data'>>;

/** One well-formed event. Defaults: session 's1', uuid `u-<type>`, timestamp 1700. */
export function ev<T extends TranscriptEventType>(type: T, data: DataOf<T>, over: EventEnvelope = {}): EventOf<T> {
  // The cast folds a generic type/data pair into the union — TypeScript cannot prove it.
  return { type, sessionId: 's1', uuid: `u-${type}`, timestamp: 1700, ...over, data } as EventOf<T>;
}

/** A DELIBERATELY wrong-shaped event, for tests that pin how a screen or reader
 *  copes with a malformed line off disk or the wire (a missing `text`, a string
 *  where a boolean belongs, an unknown type). Named so the intent shows at the call. */
export function malformedEv(type: string, data: unknown, over: EventEnvelope = {}): TranscriptEvent {
  // WHY the cast: the whole point is that this does not satisfy the union.
  return { type, sessionId: 's1', uuid: `u-${type}`, timestamp: 1700, ...over, data } as unknown as TranscriptEvent;
}
