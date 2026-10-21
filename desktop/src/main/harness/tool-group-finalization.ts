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

/** The answer for a tool call whose pre-execution checks threw something other
 *  than a PermissionCallbackFailure (2026-10-20: an uncompilable glob in the
 *  secret-path check). WHY not rethrow: that escaped the turn with the call
 *  announced but unanswered, and the provider then refused every later request
 *  ("Tool result is missing for tool call …") — the conversation could never
 *  send again. An abort is still an interrupt. Tool bodies have their own catch
 *  (defineTool), so this is the pre-execution path; "may not have run" is honest. */
export function unexpectedToolThrowResult(err: unknown, toolName: string, aborted: boolean): { text: string; isError: true } | 'interrupted' {
  if (aborted) return 'interrupted';
  const detail = err instanceof Error ? err.message : String(err);
  return { text: `The ${toolName} call failed with an internal error and may not have run: ${detail}`, isError: true };
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
