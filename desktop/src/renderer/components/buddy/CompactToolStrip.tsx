import { useState, useCallback, useEffect } from 'react';
import { useChatDispatch } from '../../state/chat-context';
import type { ToolCallState } from '../../../shared/types';

interface Props {
  tools: ToolCallState[];
  sessionId: string;
}

// Maps tool status to a color dot — hardcoded per project convention
// (status colors stay theme-independent, matching the rule in CLAUDE.md).
const toolDot = (status: ToolCallState['status']): string => {
  switch (status) {
    case 'running': return '#60a5fa';        // blue
    case 'complete': return '#4ade80';       // green
    case 'failed': return '#ef4444';         // red
    case 'awaiting-approval': return '#f5a623'; // amber
    default: return '#888';
  }
};

const approveStyle: React.CSSProperties = {
  fontSize: 10,
  padding: '2px 8px',
  borderRadius: 999,
  background: 'var(--accent)',
  color: 'var(--on-accent)',
  border: 'none',
  cursor: 'pointer',
};

const denyStyle: React.CSSProperties = {
  fontSize: 10,
  padding: '2px 8px',
  borderRadius: 999,
  background: 'transparent',
  color: 'var(--fg)',
  border: '1px solid var(--edge)',
  cursor: 'pointer',
};

const alwaysStyle: React.CSSProperties = {
  ...approveStyle,
  background: 'transparent',
  color: 'var(--fg-dim)',
  border: '1px solid var(--edge)',
};

/**
 * Compact tool strip rendered inline in the buddy chat when tools in the
 * active turn need user attention. Auto-expands when anything is
 * awaiting-approval; otherwise shows a slim "N tools used" pill.
 *
 * Permission responses go through the same IPC path as the main app's
 * <ToolCard>: window.claude.session.respondToPermission(requestId, decision)
 * followed by PERMISSION_RESPONDED / PERMISSION_EXPIRED reducer dispatches.
 * This keeps buddy and main on a single code path with no divergence.
 */
export function CompactToolStrip({ tools, sessionId }: Props) {
  const dispatch = useChatDispatch();
  const awaiting = tools.filter((t) => t.status === 'awaiting-approval');
  // Auto-expand when any tool needs approval so user sees prompts immediately
  const [expanded, setExpanded] = useState(awaiting.length > 0);

  // Fix: Reactive auto-expand — if a new tool transitions to awaiting-approval after mount,
  // auto-open the strip so the user sees the new approval prompt
  useEffect(() => {
    if (awaiting.length > 0) setExpanded(true);
  }, [awaiting.length]);

  if (tools.length === 0) return null;

  // Derive a short display "target" from input for common tools (Read/Edit/Grep/Bash etc.)
  const targetFor = (t: ToolCallState): string => {
    const input = t.input ?? {};
    if (typeof input.file_path === 'string') return input.file_path;
    if (typeof input.path === 'string') return input.path;
    if (typeof input.pattern === 'string') return input.pattern;
    if (typeof input.command === 'string') return input.command;
    if (typeof input.url === 'string') return input.url;
    return '';
  };

  // Collapsed: show a slim count pill. Only shown when nothing needs approval.
  if (!expanded && awaiting.length === 0) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="layer-surface"
        style={{
          alignSelf: 'center',
          padding: '4px 14px',
          borderRadius: 999,
          fontFamily: 'Cascadia Code, monospace',
          fontSize: 10.5,
          letterSpacing: 0.3,
          cursor: 'pointer',
          border: 'none',
          color: 'var(--fg-dim)',
        }}
      >
        {tools.length} tool{tools.length === 1 ? '' : 's'} used ▾
      </button>
    );
  }

  return (
    <div className="layer-surface" style={{ padding: 6, borderRadius: 10, alignSelf: 'stretch' }}>
      {/* Collapse toggle */}
      <button
        onClick={() => { if (awaiting.length === 0) setExpanded((e) => !e); }}
        disabled={awaiting.length > 0}
        style={{
          display: 'block',
          width: '100%',
          textAlign: 'center',
          background: 'transparent',
          border: 'none',
          fontSize: 10,
          color: 'var(--fg-dim)',
          cursor: awaiting.length > 0 ? 'default' : 'pointer',
          opacity: awaiting.length > 0 ? 0.5 : 1,
          marginBottom: 4,
        }}
      >
        {tools.length} tool{tools.length === 1 ? '' : 's'} used {awaiting.length > 0 ? '▴' : '▾'}
      </button>

      {tools.map((t) => (
        <ToolRow
          key={t.toolUseId}
          tool={t}
          sessionId={sessionId}
          target={targetFor(t)}
          dotColor={toolDot(t.status)}
          dispatch={dispatch}
        />
      ))}
    </div>
  );
}

// Extracted to avoid creating inline callbacks inside map()
function ToolRow({
  tool,
  sessionId,
  target,
  dotColor,
  dispatch,
}: {
  tool: ToolCallState;
  sessionId: string;
  target: string;
  dotColor: string;
  dispatch: ReturnType<typeof useChatDispatch>;
}) {
  const [responding, setResponding] = useState(false);

  // Mirrors ToolCard's PermissionButtons.handleRespond — same IPC call + same
  // reducer dispatches so both paths are functionally identical.
  const respond = useCallback(
    async (decision: object) => {
      if (!tool.requestId) return;
      setResponding(true);
      try {
        const delivered = await (window as any).claude.session.respondToPermission(
          tool.requestId,
          decision,
        );
        if (delivered === false) {
          // Fix: Socket already closed — mark expired so the UI unsticks.
          // Reset responding so user can retry if needed.
          setResponding(false);
          const action = {
            type: 'PERMISSION_EXPIRED' as const,
            sessionId,
            requestId: tool.requestId,
          };
          dispatch(action);
          (window as any).claude?.remote?.broadcastAction(action);
          return;
        }
        // Success — dismiss the approval card via reducer
        const action = {
          type: 'PERMISSION_RESPONDED' as const,
          sessionId,
          requestId: tool.requestId,
        };
        dispatch(action);
        (window as any).claude?.remote?.broadcastAction(action);
      } catch (err) {
        console.error('CompactToolStrip: failed to respond to permission:', err);
        // Treat as expired so the card doesn't get stuck
        if (tool.requestId) {
          const action = {
            type: 'PERMISSION_EXPIRED' as const,
            sessionId,
            requestId: tool.requestId,
          };
          dispatch(action);
          (window as any).claude?.remote?.broadcastAction(action);
        }
      }
    },
    [tool.requestId, sessionId, dispatch],
  );

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '5px 8px',
        borderRadius: 6,
        fontSize: 11,
      }}
    >
      {/* Status dot */}
      <span
        style={{
          width: 5,
          height: 5,
          borderRadius: '50%',
          background: dotColor,
          flexShrink: 0,
        }}
      />
      {/* Tool name */}
      <span
        style={{
          fontFamily: 'Cascadia Code, monospace',
          color: 'var(--fg)',
          flexShrink: 0,
        }}
      >
        {tool.toolName}
      </span>
      {/* Truncated target path / command */}
      <span
        style={{
          flex: 1,
          color: 'var(--fg-dim)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {target}
      </span>
      {/* Inline Allow / Deny / Always buttons only for awaiting-approval tools */}
      {tool.status === 'awaiting-approval' && tool.requestId ? (
        <span style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
          <button
            disabled={responding}
            onClick={() => respond({ decision: { behavior: 'allow' } })}
            style={{ ...approveStyle, opacity: responding ? 0.5 : 1 }}
          >
            ✓ Allow
          </button>
          <button
            disabled={responding}
            onClick={() => respond({ decision: { behavior: 'deny' } })}
            style={{ ...denyStyle, opacity: responding ? 0.5 : 1 }}
          >
            ✕ Deny
          </button>
          <button
            disabled={responding}
            onClick={() =>
              respond({
                decision: { behavior: 'allow' },
                updatedPermissions: tool.permissionSuggestions?.[0]
                  ? [tool.permissionSuggestions[0]]
                  : undefined,
              })
            }
            style={{ ...alwaysStyle, opacity: responding ? 0.5 : 1 }}
          >
            ∞ Always
          </button>
        </span>
      ) : null}
    </div>
  );
}
