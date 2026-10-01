import type { SessionLive } from '../../shared/session-live-types';
import { routeSessionLive, type TranscriptBatcher } from './transcript-batch';
import { CLAUDE_ALIASES } from '../../shared/model-ids';

export interface SessionLiveDeps {
  batcher: Pick<TranscriptBatcher, 'push'>;
  /** This screen's own reading of the context window, for the compaction note. */
  contextTokens(sessionId: string): number | null;
  /** Is this a native session (its model is a binding id, not a Claude alias)? */
  isNative(sessionId: string): boolean;
  /** The status-bar chip's model for a Claude Code session. */
  setChipModel(sessionId: string, alias: string): void;
  /** The session's own record of its model (the All Sessions menu labels from it). */
  setSessionModel(sessionId: string, model: string): void;
}

/**
 * Everything a screen does with one `session:live` push (one-core R5-4a): the reducer actions go through the frame batcher, and a model
 * announcement also moves the chip and the session's own model. Pulled out of App so a test can drive it without mounting App.
 */
export function applySessionLive(live: SessionLive, deps: SessionLiveDeps): void {
  if (!live?.sessionId) return;
  routeSessionLive(live, { batcher: deps.batcher, contextTokens: deps.contextTokens });
  if (live.kind !== 'model') return;
  const native = deps.isNative(live.sessionId);
  const alias = native ? live.model : CLAUDE_ALIASES.find((m) => live.model.includes(m.replace(/\[.*\]/, '')));
  if (!alias) return;
  if (!native) deps.setChipModel(live.sessionId, alias);
  deps.setSessionModel(live.sessionId, alias);
}
