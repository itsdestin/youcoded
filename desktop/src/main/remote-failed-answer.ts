import { TABLE_ERROR_FLAG } from '../shared/table-error-flag';

/** What to send back when a remote message handler THREW (card #134, error inventory Backend row 11).
 *  Before this, the older `switch` cases without their own try/catch left the phone or browser waiting
 *  its full 30 s and then showing "Request <type> timed out", hiding the host's real reason and making the
 *  'did it run?' check answer "unknown". The table path already answers a throw this way
 *  (ipc/channel-table.ts); this gives the `switch` cases the same: an awaited request (one with an id) is
 *  answered at once with the failure flag, which the page turns into a rejection carrying the host's own
 *  sentence. A message with no id (a push) has no one waiting, so it only returns null (logged). */
export function failedMessageAnswer(
  raw: Buffer | string,
  err: unknown,
): { type: string; id: string; payload: { ok: false; error: string; tableHandlerFailed: true } } | null {
  const message = err instanceof Error ? err.message : String(err);
  let type: unknown; let id: unknown;
  try { ({ type, id } = JSON.parse(raw.toString())); } catch { /* unparseable: nothing to answer */ }
  console.warn(`[remote-server] handler for ${String(type)} failed:`, message);
  if (typeof type !== 'string' || typeof id !== 'string' || !id) return null;
  return { type, id, payload: { ok: false, error: message, [TABLE_ERROR_FLAG]: true } as { ok: false; error: string; tableHandlerFailed: true } };
}
