import React, { useCallback } from 'react';
import { useChatState, useChatDispatch } from '../state/chat-context';
import { InteractivePrompt } from '../state/chat-types';
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
function findTrustPrompt(sessionId: string, state: ReturnType<typeof useChatState>): InteractivePrompt | null {
  for (const entry of state.timeline) {
    if (entry.kind === 'prompt' && !entry.prompt.completed) {
      const title = entry.prompt.title.toLowerCase();
      if (title.includes('trust')) {
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

  const trustPrompt = findTrustPrompt(sessionId, state);

  const handleSelect = useCallback(
    (input: string, label: string) => {
      if (!trustPrompt) return;
      window.claude.session.sendInput(sessionId, input);
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
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-canvas">
      <ThemeMascot variant="idle" fallback={AppIcon} className="w-16 h-16 text-fg-dim mb-6" />
      <p className="text-sm text-fg font-medium mb-1">{trustPrompt.title}</p>
      <p className="text-xs text-fg-muted mb-6 max-w-sm text-center">
        Claude needs your permission before working in this directory.
      </p>
      <div className="flex gap-3">
        {trustPrompt.buttons.map((btn) => (
          <button
            key={btn.label}
            onClick={() => handleSelect(btn.input, btn.label)}
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
  return findTrustPrompt(sessionId, state) !== null;
}
