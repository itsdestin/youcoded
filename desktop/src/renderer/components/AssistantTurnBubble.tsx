import React, { useState } from 'react';
import { AssistantTurn } from '../state/chat-types';
import { ToolCallState, ToolGroupState } from '../../shared/types';
import MarkdownContent from './MarkdownContent';
import ToolCard from './ToolCard';
import { CheckIcon, FailIcon, ChevronIcon } from './Icons';
import BrailleSpinner from './BrailleSpinner';
import { formatBubbleTime } from '../utils/format-time';
import { useTheme } from '../state/theme-context';
import { useExpandAllToggle, getInitialExpanded } from '../hooks/useExpandAllToggle';

interface Props {
  turn: AssistantTurn;
  toolGroups: Map<string, ToolGroupState>;
  toolCalls: Map<string, ToolCallState>;
  sessionId: string;
  showTimestamps: boolean;
}

// Non-end_turn stop reasons rendered inline under the affected turn.
// `tool_use` is filtered upstream at transcript-watcher.ts (it means "awaiting
// tool result", not a real completion). `end_turn` — the normal completion —
// reaches the reducer but is filtered at the render gate below, because it
// carries no abnormal signal worth surfacing. The four keys below are the
// ones that ARE worth surfacing (truncation / refusal / etc.).
const STOP_REASON_COPY: Record<string, string> = {
  max_tokens: 'Response truncated — Claude hit the output token limit.',
  stop_sequence: 'Response stopped at a configured stop sequence.',
  refusal: 'Claude declined to respond.',
  pause_turn: 'Extended thinking paused mid-turn.',
  interrupted: 'Interrupted.',
};

function StopReasonFooter({ reason }: { reason: string }) {
  const copy = STOP_REASON_COPY[reason] ?? `Response ended: ${reason}.`;
  return (
    <div className="text-xs text-fg-muted italic mt-1 pl-1 border-l-2 border-edge-dim" role="status">
      {copy}
    </div>
  );
}

// Opt-in per-turn transcript metadata. Gated in the bubble render by
// `showTurnMetadata` (default false) — most users never see it. Mono for
// scannable numbers; muted tokens only so it stays unobtrusive across themes.
function TurnMetadataStrip({ turn }: { turn: AssistantTurn }) {
  if (!turn.usage && !turn.model) return null;
  const u = turn.usage;
  const total = u ? u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens : 0;
  const cacheHitPct = u && total > 0
    ? Math.round((u.cacheReadTokens / total) * 100)
    : null;

  return (
    <div
      className="text-[10.5px] text-fg-muted mt-1 pl-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono select-text"
      title="Per-turn metadata from transcript"
    >
      {turn.model && <span>{turn.model}</span>}
      {u && (
        <>
          <span>in {u.inputTokens.toLocaleString()}</span>
          <span>out {u.outputTokens.toLocaleString()}</span>
          {cacheHitPct !== null && <span>cache {cacheHitPct}%</span>}
        </>
      )}
    </div>
  );
}

/** Renders a collapsed summary for 2+ tools in a group. Exported so the dev
 * sandbox at /tool-sandbox can render fixtures with the same grouping
 * treatment real chat uses (single visual unit + shared bg-inset on cards). */
export function CollapsedToolGroup({ tools, sessionId }: { tools: ToolCallState[]; sessionId: string }) {
  const [expanded, setExpanded] = useState(() => getInitialExpanded());
  useExpandAllToggle(() => setExpanded(true), () => setExpanded(false));

  const runningCount = tools.filter((t) => t.status === 'running').length;
  const completedCount = tools.filter((t) => t.status === 'complete').length;
  const failedCount = tools.filter((t) => t.status === 'failed').length;

  // Build name summary: "Read, Grep, Grep" → "Read, Grep ×2"
  const nameCounts = new Map<string, number>();
  for (const t of tools) {
    nameCounts.set(t.toolName, (nameCounts.get(t.toolName) || 0) + 1);
  }
  const nameList = [...nameCounts.entries()]
    .map(([name, count]) => count > 1 ? `${name} \u00d7${count}` : name)
    .join(', ');

  return (
    <div className="border border-edge rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-1.5 px-3 py-1.5 text-left hover:bg-inset/50 transition-colors"
      >
        {runningCount > 0 ? (
          <BrailleSpinner size="sm" />
        ) : failedCount > 0 ? (
          <FailIcon className="w-3.5 h-3.5 shrink-0 text-fg-dim" />
        ) : (
          <CheckIcon className="w-3.5 h-3.5 shrink-0 text-fg-dim" />
        )}
        <span className="text-fg-faint text-xs select-none">|</span>
        <span className="text-xs text-fg-dim flex-1">
          {tools.length} tools ({nameList})
          {completedCount === tools.length && ' — all complete'}
          {runningCount > 0 && ` — ${runningCount} running`}
          {failedCount > 0 && ` — ${failedCount} failed`}
        </span>
        <ChevronIcon className="w-3.5 h-3.5 shrink-0 text-fg-muted" expanded={expanded} />
      </button>
      {expanded && (
        // Fix: no bg — lets bubble color show through so header + body share
        // one seamless background. Each ToolCard carries its own bg-inset
        // to give tools a distinct "lifted" color vs the group wrapper.
        <div className="px-2 pb-1.5 space-y-0.5 rounded-b-lg">
          {tools.map((tool) => (
            <ToolCard key={tool.toolUseId} tool={tool} sessionId={sessionId} inGroup />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Splits a turn's segments into visual bubbles.
 * Each bubble = one text segment + the tool-group segments that follow it.
 * Leading tool-groups (before any text) get their own tools-only bubble.
 */
interface VisualBubble {
  key: string;
  text?: { content: string; messageId: string };
  plan?: { content: string; messageId: string; planFilePath?: string; allowedPrompts?: unknown };
  toolGroupIds: string[];
}

function splitIntoBubbles(turn: AssistantTurn): VisualBubble[] {
  const bubbles: VisualBubble[] = [];
  let current: VisualBubble | null = null;

  for (const seg of turn.segments) {
    if (seg.type === 'text') {
      // Start a new bubble for this text
      if (current) bubbles.push(current);
      current = {
        key: seg.messageId,
        text: { content: seg.content, messageId: seg.messageId },
        toolGroupIds: [],
      };
    } else if (seg.type === 'plan') {
      // Plan bubble: its own distinct bubble, rendered differently from text.
      // The following ExitPlanMode tool-group naturally attaches below.
      if (current) bubbles.push(current);
      current = {
        key: seg.messageId,
        plan: {
          content: seg.content,
          messageId: seg.messageId,
          planFilePath: seg.planFilePath,
          allowedPrompts: seg.allowedPrompts,
        },
        toolGroupIds: [],
      };
    } else {
      // tool-group: attach to current bubble, or create a tools-only bubble
      if (!current) {
        current = { key: `tools-${seg.groupId}`, toolGroupIds: [] };
      }
      current.toolGroupIds.push(seg.groupId);
    }
  }
  if (current) bubbles.push(current);
  return bubbles;
}

// Walks the turn's tool-group segments and returns every Skill ToolCallState
// in invocation order. Used by the bubble render to pull Skills OUT of their
// groups (where ToolGroupInline now filters them) and render them as a
// trailing row of standalone cards on the last bubble of the turn.
function collectTurnSkills(
  turn: AssistantTurn,
  toolGroups: Map<string, ToolGroupState>,
  toolCalls: Map<string, ToolCallState>,
): ToolCallState[] {
  const skills: ToolCallState[] = [];
  for (const seg of turn.segments) {
    if (seg.type !== 'tool-group') continue;
    const group = toolGroups.get(seg.groupId);
    if (!group) continue;
    for (const id of group.toolIds) {
      const t = toolCalls.get(id);
      if (t && t.toolName === 'Skill') skills.push(t);
    }
  }
  return skills;
}

export default React.memo(function AssistantTurnBubble({ turn, toolGroups, toolCalls, sessionId, showTimestamps }: Props) {
  // Read opt-in metadata preference here so the strip below only renders when
  // the user has explicitly turned it on in PreferencesPopup (default false).
  const { showTurnMetadata } = useTheme();
  const bubbles = splitIntoBubbles(turn);
  // Skills are reordered to the end of the turn's last bubble (view-layer only).
  // ToolGroupInline filters Skills out of their groups; this list backs the
  // trailing standalone-card row below.
  const turnSkills = React.useMemo(
    () => collectTurnSkills(turn, toolGroups, toolCalls),
    [turn, toolGroups, toolCalls],
  );

  return (
    <>
      {bubbles.map((bubble, i) => {
        const hasTools = bubble.toolGroupIds.length > 0;
        const hasContent = !!(bubble.text || bubble.plan);
        const toolsOnly = hasTools && !hasContent;
        const isLastBubble = i === bubbles.length - 1;
        return (
          <div key={bubble.key} className="flex justify-start px-4 py-0.5">
            <div className={`assistant-bubble max-w-[85%] rounded-2xl rounded-bl-sm bg-inset text-sm text-fg px-5 ${toolsOnly ? 'py-2.5' : hasTools ? 'pt-4 pb-3' : 'py-3.5'}`}>
              {bubble.text && (
                <MarkdownContent content={bubble.text.content} />
              )}
              {bubble.plan && (
                <PlanBubbleContent
                  content={bubble.plan.content}
                  planFilePath={bubble.plan.planFilePath}
                  allowedPrompts={bubble.plan.allowedPrompts}
                />
              )}
              {hasTools && (
                <div className={bubble.text ? 'mt-1' : ''}>
                  {bubble.toolGroupIds.map((groupId) => (
                    <ToolGroupInline
                      key={groupId}
                      groupId={groupId}
                      toolGroups={toolGroups}
                      toolCalls={toolCalls}
                      sessionId={sessionId}
                    />
                  ))}
                </div>
              )}
              {/* Trailing-Skills row: Skills are reordered to the end of the turn's
                  last bubble so they read as a status footer rather than co-mingled
                  with substantive tool output. ToolGroupInline filters Skills out
                  upstream so this is the only place they render. */}
              {isLastBubble && turnSkills.length > 0 && (
                <div className="mt-1 space-y-0.5">
                  {turnSkills.map((skill) => (
                    <ToolCard key={skill.toolUseId} tool={skill} sessionId={sessionId} />
                  ))}
                </div>
              )}
              {/* Opt-in metadata strip. Renders once per turn (last bubble only) and
                  only when the user has enabled `showTurnMetadata`. Placed above the
                  stopReason footer so a truncated turn still shows both, in that order. */}
              {isLastBubble && showTurnMetadata && <TurnMetadataStrip turn={turn} />}
              {/* Render stopReason explainer only once per turn — on the last bubble.
                  Gate out `end_turn` (normal completion) — it reaches the reducer but
                  carries no abnormal signal worth surfacing to the user. */}
              {isLastBubble && turn.stopReason && turn.stopReason !== 'end_turn' && <StopReasonFooter reason={turn.stopReason} />}
              {showTimestamps && isLastBubble && turn.timestamp && (
                <div className="bubble-timestamp text-[9px] text-fg-muted/60 text-right mt-1 -mb-0.5 select-none leading-none">
                  {formatBubbleTime(turn.timestamp)}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
});

/**
 * Renders a plan-mode plan (from ExitPlanMode tool input) as a distinct section
 * inside an assistant bubble. Shows a "Plan" header, the markdown body, and
 * (collapsed by default) the list of allowedPrompts Claude intends to run.
 */
function PlanBubbleContent({
  content,
  planFilePath,
  allowedPrompts,
}: {
  content: string;
  planFilePath?: string;
  allowedPrompts?: unknown;
}) {
  const [showPrompts, setShowPrompts] = useState(() => getInitialExpanded());
  useExpandAllToggle(() => setShowPrompts(true), () => setShowPrompts(false));
  const prompts = Array.isArray(allowedPrompts) ? allowedPrompts : [];
  const fileName = planFilePath
    ? planFilePath.replace(/\\/g, '/').split('/').pop()
    : undefined;

  return (
    <div className="border border-accent/40 rounded-md bg-accent/5 px-3 py-2 my-0.5">
      <div className="flex items-center gap-2 mb-1 text-xs font-medium text-fg-2">
        <span>📋 Plan</span>
        {fileName && (
          <span className="text-fg-muted font-normal truncate">{fileName}</span>
        )}
      </div>
      <MarkdownContent content={content} />
      {prompts.length > 0 && (
        <div className="mt-2 pt-2 border-t border-edge-dim">
          <button
            onClick={() => setShowPrompts((v) => !v)}
            className="text-[11px] text-fg-muted hover:text-fg-dim flex items-center gap-1"
          >
            <ChevronIcon className="w-3 h-3" expanded={showPrompts} />
            {prompts.length} allowed {prompts.length === 1 ? 'action' : 'actions'} if approved
          </button>
          {showPrompts && (
            <pre className="mt-1 text-[11px] text-fg-dim bg-panel rounded-sm p-2 overflow-auto max-h-40">
              {JSON.stringify(prompts, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/** Renders a tool group inline within the assistant bubble. */
function ToolGroupInline({
  groupId,
  toolGroups,
  toolCalls,
  sessionId,
}: {
  groupId: string;
  toolGroups: Map<string, ToolGroupState>;
  toolCalls: Map<string, ToolCallState>;
  sessionId: string;
}) {
  const group = toolGroups.get(groupId);
  if (!group || group.toolIds.length === 0) return null;

  const tools = group.toolIds
    .map((id) => toolCalls.get(id))
    // Skip undefined AND skip Skill tools — Skills render as a trailing
    // standalone row outside any group via AssistantTurnBubble (see
    // collectTurnSkills + the trailing-skills div on the last bubble).
    // View-layer reorder; reducer state untouched.
    .filter((t): t is ToolCallState => t !== undefined && t.toolName !== 'Skill');

  if (tools.length === 0) return null;

  // Skip awaiting-approval tools — they render as standalone bubbles at the bottom of the timeline
  const restTools = tools.filter((t) => t.status !== 'awaiting-approval');
  if (restTools.length === 0) return null;

  return (
    <div className="my-0.5 space-y-0.5">
      {restTools.length === 1 ? (
        <ToolCard tool={restTools[0]} sessionId={sessionId} />
      ) : (
        <CollapsedToolGroup tools={restTools} sessionId={sessionId} />
      )}
    </div>
  );
}
