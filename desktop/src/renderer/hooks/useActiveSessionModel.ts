import { useCallback, useRef, useSyncExternalStore } from 'react';
import { useChatStore } from '../state/chat-context';
import { type ModelAlias } from '../components/StatusBar';
import { claudeAliasForModelId, isPlaceholderModelId } from '../../shared/model-ids';

// Cached selector: the ModelAlias of the most recent assistant turn with a
// known model in the ACTIVE session's timeline (or null — no session, no
// turns yet, or an unrecognized model string).
//
// Why this exists (tranche 1): the passive drift-reconciliation effect in
// AppInner needs TWO triggers — a transcript event that reveals a new model
// for the active session, AND a session switch (so switching INTO a session
// that drifted while backgrounded reconciles its pill). The old effect got
// both by depending on the whole `[sessionId, chatStateMap, ...]`, but the
// chatStateMap dep forced AppInner to re-render on EVERY dispatch. This hook
// subscribes to the store and, via useSyncExternalStore's Object.is compare on
// the returned primitive, re-renders the host ONLY when the active session's
// alias actually changes — preserving both triggers without the per-dispatch
// cost. See docs/active/plans/2026-07-17-appinner-tranche1-perf.md (Task 9,
// option c: the dispatch-only subscription form dropped the switch trigger and
// left a switched-into idle session's pill stale — this restores it).
export function useActiveSessionModel(sessionId: string | null): ModelAlias | null {
  const store = useChatStore();
  // Render-phase mirror so getSnapshot sees the current sessionId. A sessionId
  // change is a React state change that re-renders AppInner anyway, and this
  // assignment runs before useSyncExternalStore reads getSnapshot on that same
  // render — so the switch path recomputes against the new session (R8 pattern,
  // same as useSessionAttention's argsRef).
  const sidRef = useRef(sessionId);
  sidRef.current = sessionId;

  const getSnapshot = useCallback((): ModelAlias | null => {
    const sid = sidRef.current;
    if (!sid) return null;
    const session = store.getState().get(sid);
    if (!session) return null;

    // The model the computer announced for this session (a /model typed or picked on ANY screen) until a later reply proves otherwise.
    // WHY first (one-core R5-4a): the walk below only learns of a switch from the next assistant turn, so a screen that did not make the
    // switch kept the old model on its chip until the next reply (roadmap: "model label corrects only on the next reply").
    if (session.modelAnnounced) {
      const announced = claudeAliasForModelId(session.modelAnnounced.model);
      if (announced) return announced;
    }

    // Walk backward through the timeline for the most recent assistant-turn
    // with a known model. turn.model is null until the first assistant-text
    // arrives, so new/empty sessions return null here.
    //
    // Fix: skip CC's `<synthetic>` placeholder turns (limit / out-of-credits /
    // auth notices). They are stamped onto real assistant turns by the reducer
    // like any other model, and they are the LAST thing in the timeline exactly
    // when you hit a limit — so stopping on one returned null from this hook,
    // which makes AppInner's drift-reconciliation effect bail at its
    // `if (!activeSessionModel) return` guard. A pill sitting on the red
    // 'unknown' sentinel then stayed stuck there instead of self-healing.
    let latestModel: string | null = null;
    for (let i = session.timeline.length - 1; i >= 0; i--) {
      const entry = session.timeline[i];
      if (entry.kind === 'assistant-turn') {
        const turn = session.assistantTurns.get(entry.turnId);
        if (turn?.model && !isPlaceholderModelId(turn.model)) { latestModel = turn.model; break; }
      }
    }
    if (!latestModel) return null;

    // Match the raw transcript model (e.g. 'claude-opus-4-7') → ModelAlias via
    // the shared matcher. Returns a primitive, so useSyncExternalStore's
    // Object.is compare handles identity — no manual cache needed (unlike
    // useSessionAttention, which returns a Map).
    return claudeAliasForModelId(latestModel);
  }, [store]);

  const subscribe = useCallback((cb: () => void) => store.subscribeAll(cb), [store]);
  return useSyncExternalStore(subscribe, getSnapshot);
}
