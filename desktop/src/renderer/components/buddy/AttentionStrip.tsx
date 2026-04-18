import type { AttentionSummary } from '../../../shared/types';

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
    : state.attentionState;
  if (!label) return null;

  const color =
    state.awaitingApproval ? '#f5a623'
    : state.attentionState === 'error' || state.attentionState === 'stuck' ? '#ef4444'
    : state.attentionState === 'awaiting-input' ? '#f5a623'
    : state.attentionState === 'session-died' ? '#6b7280'
    : '#60a5fa';

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
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: color }} />
      <span>{label}</span>
    </div>
  );
}
