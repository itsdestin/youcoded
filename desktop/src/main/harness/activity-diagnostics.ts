/** Optional laboratory observer: no transcript events, payloads, clocks or I/O in the runtime. */
export type ActivityDiagnostic = (receipt: {
  kind: 'execution-start' | 'execution-end' | 'ask-start' | 'ask-end';
  id: string; sessionId: string; scope: 'parent' | 'child';
  toolCallId?: string; status?: 'completed' | 'failed' | 'interrupted';
}) => void;

// WHY: diagnostics cannot alter execution, hide a tool error, or become a permission decision.
export function activitySpan<T>(observer: ActivityDiagnostic | undefined,
  meta: {id: string; sessionId: string; scope: 'parent' | 'child'; toolCallId?: string},
  phase: 'execution' | 'ask', run: () => Promise<T>, interrupted: () => boolean): Promise<T> {
  if (!observer) return run();
  const emit = (edge: 'start' | 'end', status?: 'completed' | 'failed' | 'interrupted') => {
    try { observer({...meta, kind: `${phase}-${edge}`, ...(status ? {status} : {})}); } catch { /* Observation is not control flow. */ }
  };
  emit('start');
  return (async () => {
    try {
      const result = await run();
      const failed = phase === 'execution' && result !== null && typeof result === 'object' && 'isError' in result && result.isError === true;
      emit('end', interrupted() ? 'interrupted' : failed ? 'failed' : 'completed'); return result;
    }
    catch (error) { emit('end', interrupted() ? 'interrupted' : 'failed'); throw error; }
  })();
}
