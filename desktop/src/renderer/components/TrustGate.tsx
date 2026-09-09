import { useCallback } from 'react';
import { useChatState, useChatDispatch } from '../state/chat-context';
import { InteractivePrompt } from '../state/chat-types';
import { TRUST_PROMPT_TITLE } from '../parser/ink-select-parser';
import { sendPromptInput } from '../state/prompt-input';
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

  const handleSelect = useCallback(
    (button: PromptCardButton, label: string) => {
      if (!trustPrompt) return;
      // Deliberate menu-driving write: this answers the live Ink trust dialog.
      // Before the 2026-07-26 fix this sent arrows + `\r` in ONE write, which CC
      // collapses to a bare Enter — so clicking "No, exit" confirmed the
      // highlighted option and TRUSTED the folder. Now it types the option digit.
      sendPromptInput(sessionId, button);
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
            onClick={() => handleSelect(btn, btn.label)}
            className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${intentStyles[buttonIntent(btn.label)]}`}
          >
            {btn.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Hook for App.tsx to check if the trust gate is active for a session.
 */
export function useTrustGateActive(sessionId: string | null): boolean {
  const state = useChatState(sessionId || '');
  if (!sessionId) return false;
  return findTrustPrompt(state) !== null;
}
