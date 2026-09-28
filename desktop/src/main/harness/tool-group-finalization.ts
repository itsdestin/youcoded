// WHY: a permission callback may fail after the assistant has announced an entire
// group. Tag only pre-execution callback failures; a started action is not retried
// or silently reclassified as an approval/denial.
export class PermissionCallbackFailure {
  constructor(readonly cause: unknown) {}
}

export async function permissionCallback<T>(call: () => Promise<T>): Promise<T> {
  try { return await call(); }
  catch (err) { throw new PermissionCallbackFailure(err); }
}

/** Emit exactly one result for each not-yet-recorded call; the caller retains
 * completed results and commits the complete tool message and event origins. */
export function finalizeRemainingCalls<TCall, TPart>(
  calls: readonly TCall[], start: number, textFor: (index: number) => string,
  emit: (call: TCall, text: string) => string, part: (call: TCall, text: string) => TPart,
): { parts: TPart[]; origins: string[] } {
  const parts: TPart[] = [];
  const origins: string[] = [];
  for (let i = start; i < calls.length; i++) {
    const text = textFor(i);
    origins.push(emit(calls[i], text));
    parts.push(part(calls[i], text));
  }
  return { parts, origins };
}
