// Coming back to a local chat after a break: load its model and read the chat again in the background.
//
// WHY (review deck Q-6, Destin 2026-11-12: "read again when you return"): after 15 idle minutes the
// engine unloads a local model to free memory, and everything it had read for this chat goes with it.
// Nothing read it again, so the next message waited the full one to three minutes on a laptop chip —
// and coming back after a break is how most people use a chat. Clicking back into the chat, or
// starting to type in it, now asks main to load the model and re-read this chat (models:load with the
// chat's id → EngineManager.loadModel + NativeSessionHost.prewarmLocal), so the reply is quick again by
// the time the message is sent. The loading bar already on screen shows it happening.
//
// Cost Destin accepted with this choice: the chip works for a minute or more each time you come back.
//
// Asked ONCE per sleep: the request is not repeated until the model has been resident again. Hidden
// means idle (rule performance.md 2): the listeners exist only while this chat is visible AND its
// model is unloaded, which is rarely.
import { useEffect, useRef, type RefObject } from 'react';
import type { EngineModelState } from '../../shared/engine-types';

export interface ReturnWarmInput {
  rootRef: RefObject<HTMLElement | null>;
  sessionId: string;
  visible: boolean;
  modelId: string | null | undefined;
  modelState: EngineModelState | null;
  /** The model has been loaded during this chat — so "not loaded" means it went to sleep, not that
   *  the chat is brand new (a new chat is warmed by main as it opens). */
  everResident: boolean;
  /** A reply is running: the turn itself loads the model. */
  isThinking: boolean;
  load: (modelId: string, sessionId: string) => void;
}

export function useReturnWarm(input: ReturnWarmInput): void {
  const { rootRef, sessionId, visible, modelId, modelState, everResident, isThinking, load } = input;
  const away = visible && !!modelId && everResident && !isThinking
    && (modelState === 'sleeping' || modelState === 'unloaded');
  // Which sleep was already answered. Cleared when the model is resident again.
  const asked = useRef(false);
  const wasVisible = useRef(visible);
  const shownAt = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (modelState === 'loaded' || modelState === 'loading') asked.current = false;
  }, [modelState]);

  useEffect(() => {
    // WHY a short window and not only the exact switch: a hidden chat's state is paused and catches up
    // a moment after it is shown (useChatState), so "asleep" can arrive just after "visible".
    if (visible && !wasVisible.current) shownAt.current = Date.now();
    wasVisible.current = visible;
    const cameIntoView = visible && Date.now() - shownAt.current < 2_000;
    if (!away || !modelId) return;
    const go = () => {
      if (asked.current) return;
      asked.current = true;
      loadRef.current(modelId, sessionId);
    };
    // Switching to this chat IS clicking back into it.
    if (cameIntoView) { go(); return; }
    const root = rootRef.current;
    if (!root) return;
    root.addEventListener('pointerdown', go, { passive: true });
    root.addEventListener('focusin', go);
    root.addEventListener('keydown', go);
    return () => {
      root.removeEventListener('pointerdown', go);
      root.removeEventListener('focusin', go);
      root.removeEventListener('keydown', go);
    };
  }, [away, visible, modelId, sessionId, rootRef]);
}
