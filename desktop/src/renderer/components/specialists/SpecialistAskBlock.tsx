import type React from 'react';
import type { SubagentSegment, SpecialistRunView } from '../../../shared/types';
import { PermissionButtons } from '../ToolCard';
import { useChatDispatch } from '../../state/chat-context';
import { useArtifactOptional } from '../../state/ArtifactContext';

type ToolSegment = Extract<SubagentSegment, { type: 'tool' }>;

/**
 * A helper's permission ask: the SAME PermissionButtons the top-level card
 * uses (same decisions, same "Always allow" derivation, same keyboard
 * handling) — a helper's ask is not a lesser ask. Two additions over the
 * top-level row: an "external" (outside-the-folder) note, and the held-state
 * line once the 5-minute redirect has fired.
 *
 * Rendered in TWO places from one component (Destin, 1c round 1: buttons deep
 * inside a card are impossible to navigate): inside the Task card's Activity
 * row, AND in the specialists popup (SpecialistsChip), which is where asks
 * are managed centrally. Same requestId → answering in either place clears both.
 */
export function SpecialistAskBlock({ segment, sessionId, specialistName, compact = false, leading, runStatus }: {
  segment: ToolSegment;
  sessionId?: string;
  specialistName?: string;
  /** Popup rows: no border/background chrome, tighter notes — the row supplies the frame. */
  compact?: boolean;
  /** Compact only: the request text, laid out on the SAME line as the buttons
   *  (buttons right-aligned; the line wraps when the request is long). */
  leading?: React.ReactNode;
  /** The card's specialistRun.status as of render (Task 12 / spec R3): the
   *  held-ask line below reads differently once the helper has actually
   *  finished — a live run can still be redirected mid-step, but a finished
   *  one cannot, so a late "Yes" does something different (it reaches the
   *  assistant as new information, not a resume) and the copy has to say so.
   *  Undefined (run record not loaded yet) falls back to the running copy —
   *  the more common case, and the one that never claims "finished" without
   *  evidence. */
  runStatus?: SpecialistRunView['status'];
}) {
  const dispatch = useChatDispatch();
  const artifacts = useArtifactOptional();
  const sessionCwd = sessionId ? artifacts?.state.sessionCwd?.[sessionId] : undefined;
  const requestId = segment.requestId!;
  const who = specialistName ?? 'The specialist';
  // Destin's 2026-08-26/27 copy review: the outside-the-folder note is now a
  // full sentence, so the name lands MID-sentence — "The specialist" would
  // read as a capitalised stranger there. Same name, sentence-case default.
  const whoMid = specialistName ?? 'the specialist';
  const onResponded = () => {
    if (!sessionId) return;
    const action = { type: 'PERMISSION_RESPONDED' as const, sessionId, requestId };
    dispatch(action);
    (window as any).claude?.remote?.broadcastAction(action);
  };
  const onFailed = () => {
    if (!sessionId) return;
    const action = { type: 'PERMISSION_EXPIRED' as const, sessionId, requestId };
    dispatch(action);
    (window as any).claude?.remote?.broadcastAction(action);
  };
  const note = compact ? 'text-2xs leading-snug' : 'px-3 pt-2 text-xs';
  const buttons = (
    <PermissionButtons
      requestId={requestId}
      denyListed={segment.denyListed}
      permissionMode={segment.permissionMode}
      command={typeof segment.input?.command === 'string' ? (segment.input.command as string) : undefined}
      folderName={sessionCwd ? sessionCwd.split(/[\\/]/).filter(Boolean).pop() : undefined}
      suppressAlwaysAllow={segment.external === true}
      onResponded={onResponded}
      onFailed={onFailed}
      bare={compact}
    />
  );
  return (
    <div data-testid="nested-ask" className={compact ? 'space-y-1' : 'border-t border-edge/60 bg-canvas/40'}>
      {compact && leading && (
        <div className="flex items-center gap-3 flex-wrap">
          <div className="min-w-0 flex-1">{leading}</div>
          <div className="shrink-0 ml-auto">{buttons}</div>
        </div>
      )}
      {segment.external && (
        <p className={`${note} text-fg-muted`}>
          {/* Destin's 2026-08-26/27 copy review: a sentence, not a fragment.
              The "no Always allow" clause went because the button is simply
              absent here (suppressAlwaysAllow) — naming a control that is not
              on screen was the noise. */}
          This is outside the project folder, so {whoMid} has to ask every time.
        </p>
      )}
      {segment.askHeld && (
        <p className={`${note} text-amber-700`} data-testid="nested-ask-held">
          {/* Two branches (Task 12): a still-running helper was already told
              to carry on, so "Yes" is a follow-up it will pick up mid-run.
              A finished helper cannot resume — "Yes" instead reaches the
              assistant, which decides what to do with it. Telling a user
              nothing here is how someone answers a 10-minute-old ask for a
              helper that's long gone without knowing that's what they did. */}
          {/* Destin's 2026-08-26/27 copy review: both branches lead with the
              helper's name and say what answering now actually does. */}
          {runStatus !== undefined && runStatus !== 'running'
            ? <>{who} has already finished. Answering Yes tells the assistant, which can send {whoMid} back out with your answer.</>
            : <>{who} waited 5 minutes, then carried on without this. Answering Yes now sends it as a follow-up.</>}
        </p>
      )}
      {!(compact && leading) && buttons}
    </div>
  );
}

