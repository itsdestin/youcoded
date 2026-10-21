/** Live, per-generation startup facts. Never persisted as conversation messages. */
interface NativeStartupIssue { id: string; label: string; error: string }
export type NativeStartupBody =
  | { phase: 'opening' }
  | { phase: 'connecting'; attemptId: string }
  | { phase: 'failed'; attemptId: string; cause: 'tools' | 'preparation'; issues: NativeStartupIssue[]; canContinue: boolean }
  | { phase: 'ready'; skippedTools?: string[] };
/** The monotonic revision fences a stale page-fill snapshot arriving after a live ready push. */
export type NativeStartupState = NativeStartupBody & { hostId: string; generation: number; revision: number };
export type NativeStartupAction = 'retry' | 'continue';

export function isNativeStartupState(value: unknown): value is NativeStartupState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Record<string, unknown>;
  if (typeof state.hostId !== 'string' || !state.hostId || !Number.isSafeInteger(state.generation) || !Number.isSafeInteger(state.revision)) return false;
  if (state.phase === 'opening' || state.phase === 'ready') return true;
  if (typeof state.attemptId !== 'string' || !state.attemptId) return false;
  if (state.phase === 'connecting') return true;
  return state.phase === 'failed' && (state.cause === 'tools' || state.cause === 'preparation') && typeof state.canContinue === 'boolean'
    && Array.isArray(state.issues) && state.issues.every(issue => issue && typeof issue.id === 'string' && typeof issue.label === 'string' && typeof issue.error === 'string');
}
export function nativeStartupBlocked(state: NativeStartupState | undefined): boolean { return !!state && state.phase !== 'ready'; }
