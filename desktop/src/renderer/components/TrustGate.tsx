import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useChatState, useChatDispatch, useChatStore } from '../state/chat-context';
import { InteractivePrompt, TimelineEntry, HISTORY_EXPAND_PROMPT_ID } from '../state/chat-types';
import { TRUST_PROMPT_TITLE } from '../parser/ink-select-parser';
import { sendPromptInput, PROMPT_FAILURE_COPY } from '../state/prompt-input';
import type { PromptCardButton } from './PromptCard';
import { AppIcon, ThemeMascot } from './Icons';

interface Props {
  sessionId: string;
}

function buttonIntent(label: string): 'accept' | 'reject' | 'neutral' {
  const l = label.toLowerCase();
  if (/^(yes|allow|accept|trust|approve)\b/.test(l)) return 'accept';
  if (/always allow/.test(l)) return 'accept';
  if (/^(no|deny|reject|decline|skip|cancel|abort)\b/.test(l)) return 'reject';
  if (/don.t trust/.test(l)) return 'reject';
  return 'neutral';
}

const intentStyles = {
  accept: 'bg-[#2E7D32] hover:bg-[#388E3C] text-white',
  reject: 'bg-inset hover:bg-edge text-fg',
  neutral: 'bg-accent hover:bg-accent text-on-accent',
};

/**
 * Finds the active trust prompt in a session's timeline.
 * Returns null if no trust prompt is pending.
 */
// WHY: `sessionId` parameter removed — findTrustPrompt searches the timeline
// for an uncompleted trust prompt; the sessionId was accepted but never used
// in the filter. The caller already scoped the state to the right session.
function findTrustPrompt(state: ReturnType<typeof useChatState>): InteractivePrompt | null {
  for (const entry of state.timeline) {
    if (entry.kind === 'prompt' && !entry.prompt.completed) {
      // Exact match on the parser's canonical trust title. A substring match
      // on 'trust' let this full-screen takeover (with its hardcoded
      // folder-permission body text) hijack ANY prompt whose title contained
      // the word — e.g. the Fable 5 safeguard prompt when the parser
      // mislabeled it (2026-07-16).
      if (entry.prompt.title === TRUST_PROMPT_TITLE) {
        return entry.prompt;
      }
    }
  }
  return null;
}

/**
 * Full-screen overlay that blocks interaction until the user answers
 * the "Do you trust this folder?" prompt at session start.
 */
export default function TrustGate({ sessionId }: Props) {
  const state = useChatState(sessionId);
  const dispatch = useChatDispatch();

  const trustPrompt = findTrustPrompt(state);
  // A verified answer in flight, and why the last one was refused (if it was).
  const [sending, setSending] = useState(false);
  // The guard is a ref: two clicks in one frame both run before the re-render
  // that disables the buttons, and each would start its own cursor walk.
  const sendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const handleSelect = useCallback(
    async (button: PromptCardButton, label: string) => {
      if (!trustPrompt || sendingRef.current) return;
      sendingRef.current = true;
      // Deliberate menu-driving write: this answers the live Ink trust dialog.
      // Before the 2026-07-26 fix this sent arrows + `\r` in ONE write, which CC
      // collapses to a bare Enter — so clicking "No, exit" confirmed the
      // highlighted option and TRUSTED the folder. A numbered dialog gets the
      // option digit; CC 2.1.281's unnumbered one is answered by verified
      // navigation, and the gate only closes once Claude Code has taken it — a
      // refused answer (the dialog changed) leaves the gate up and says why.
      setSending(true);
      setError(null);
      const r = await sendPromptInput(sessionId, button);
      sendingRef.current = false;
      if (!mounted.current) return;
      setSending(false);
      if (!r.ok) { setError(PROMPT_FAILURE_COPY[r.reason]); return; }
      const action = {
        type: 'COMPLETE_PROMPT' as const,
        sessionId,
        promptId: trustPrompt.promptId,
        selection: label,
      };
      dispatch(action);
      // Broadcast to other devices so their UI updates too
      (window as any).claude?.remote?.broadcastAction(action);
    },
    [sessionId, trustPrompt, dispatch],
  );

  if (!trustPrompt) return null;

  return (
    // z-10: must stay below glassmorphism chrome (z-20) so header/bottom bars remain accessible
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-canvas">
      <ThemeMascot small={false} variant="idle" fallback={AppIcon} className="w-16 h-16 text-fg-dim mb-6" />
      <p className="text-sm text-fg font-medium mb-1">{trustPrompt.title}</p>
      <p className="text-xs text-fg-muted mb-6 max-w-sm text-center">
        Claude needs your permission before working in this directory.
      </p>
      <div className="flex gap-3">
        {trustPrompt.buttons.map((btn) => (
          <button
            key={btn.label}
            disabled={sending}
            onClick={() => { void handleSelect(btn, btn.label); }}
            className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${intentStyles[buttonIntent(btn.label)]}`}
          >
            {btn.label}
          </button>
        ))}
      </div>
      {error && <p role="alert" className="mt-4 text-xs text-fg-muted max-w-sm text-center">{error}</p>}
    </div>
  );
}

/**
 * Hook for App.tsx to check if the trust gate is active for a session.
 */
export function useTrustGateActive(sessionId: string | null): boolean {
  return useTimelineFlag(sessionId, trustPending);
}

type SessionView = ReturnType<typeof useChatState>;
const trustPending = (s: SessionView) => findTrustPrompt(s) !== null;
const anyPromptPending = (s: SessionView) => s.timeline.some((e) =>
  e.kind === 'prompt' && !e.prompt.completed && e.prompt.promptId !== HISTORY_EXPAND_PROMPT_ID);

/** Any unanswered Claude Code prompt card in this session's chat (the "See
 *  previous messages" marker is not one). App hides the "Initializing
 *  session…" cover while one is up: that cover sits OVER the chat, so a
 *  startup card for the bypass warning or an MCP server was drawn but
 *  invisible behind it (2026-09-24). */
export function usePendingPromptActive(sessionId: string | null): boolean {
  return useTimelineFlag(sessionId, anyPromptPending);
}

function useTimelineFlag(
  sessionId: string | null,
  test: (session: SessionView) => boolean,
): boolean {
  // WHY a cached selector (2026-09-16 A1): this ran in AppInner through a
  // whole-state subscription, so every streamed word re-rendered the entire
  // shell to re-scan the timeline for a prompt that is almost never there.
  // The scan is keyed on the timeline array's identity: a prompt entry (or
  // its completion) always produces a new array, a streamed word never does —
  // text deltas update assistantTurns, not the timeline. getSnapshot therefore
  // rescans only when an entry was added or replaced, and returns a boolean so
  // useSyncExternalStore re-renders the host only when the answer flips.
  const store = useChatStore();
  const cache = useRef<{ timeline: TimelineEntry[] | null; active: boolean }>({ timeline: null, active: false });
  const subscribe = useCallback(
    (cb: () => void) => store.subscribeSession(sessionId ?? '', cb),
    [store, sessionId],
  );
  const getSnapshot = useCallback((): boolean => {
    if (!sessionId) return false;
    const session = store.getSession(sessionId);
    if (cache.current.timeline !== session.timeline) {
      cache.current = { timeline: session.timeline, active: test(session) };
    }
    return cache.current.active;
  }, [store, sessionId, test]);
  return useSyncExternalStore(subscribe, getSnapshot);
}
