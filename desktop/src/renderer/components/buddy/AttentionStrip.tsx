import type { AttentionSummary, AttentionState } from '../../../shared/types';
import { attentionDotColor } from '../../hooks/useSessionAttention';

// Classes for the two dot colors. The DECISION of which one to use is NOT made
// here — attentionDotColor() is the app's single source of truth for that, and
// the strip now defers to it (see the comment on `color` below).
// WHY classes, not hex (guide principle 2): the main session strip's own dot classes
// (`DOT_BG` in SessionStrip.tsx), so red and amber here are the app's one red and amber.
const DOT_HEX = { red: 'bg-red-400', amber: 'bg-amber-400' } as const;

// User-facing text per state. Only 'stalled' is spelled out today; 'stuck',
// 'session-died' and 'error' fall through to the raw state name, which is what
// this component has always rendered for every state. Humanising those three
// is real copy work and is deliberately NOT bundled into the stall feature —
// they would be label changes Destin could not trace back to the stall work he
// asked for.
const LABEL: Partial<Record<AttentionState, string>> = {
  // Same words as the main card (AttentionBanner's COPY.stalled), lowercased to
  // match this strip's one existing prose label, 'awaiting approval'.
  stalled: 'provider may have stalled',
};

interface Props {
  sessionId: string | null;
  summary: AttentionSummary | null;
}

/**
 * Slim glass pill rendered below the buddy input when the viewed session's
 * attention state is anything other than 'ok'. Consumes the AttentionSummary
 * already subscribed to by BuddyChat (hoisted there in E2) to avoid a
 * duplicate listener.
 */
export function AttentionStrip({ sessionId, summary }: Props) {
  if (!sessionId || !summary) return null;
  const state = summary.perSession[sessionId];
  if (!state) return null;

  const label =
    state.awaitingApproval ? 'awaiting approval'
    : state.attentionState === 'ok' ? null
    : LABEL[state.attentionState] ?? state.attentionState;
  if (!label) return null;

  // Fix (M10, whole-branch review 2026-08-16): this component used to carry its
  // OWN colour table, which had drifted from every other dot in the app — it
  // painted 'stuck' RED (the rule reserves red for "definitely needs your
  // attention"; amber is "may be wrong, I don't know"), 'session-died' grey and
  // 'error' blue, and the new 'stalled' state fell through to that same blue
  // even though a parked turn is the clearest "act now" state there is.
  // Deferring to attentionDotColor() — the function the sidebar dots and the
  // attention reporter already use — removes the duplicate table rather than
  // adding a fifth entry to it, so the strip can never disagree again.
  // Consequence, stated so it is traceable: stalled blue→red, session-died
  // grey→red, error blue→red, stuck red→amber. awaitingApproval keeps its own
  // amber branch, unchanged.
  const color =
    state.awaitingApproval ? DOT_HEX.amber
    : DOT_HEX[attentionDotColor(state.attentionState) ?? 'amber'];

  return (
    <div
      className="layer-surface"
      style={{
        alignSelf: 'center',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 12px',
        borderRadius: 999,
        fontSize: 11,
        color: 'var(--fg-dim)',
      }}
    >
      <span className={color} style={{ width: 6, height: 6, borderRadius: '50%' }} />
      <span>{label}</span>
    </div>
  );
}
