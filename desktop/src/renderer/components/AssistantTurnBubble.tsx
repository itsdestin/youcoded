import React, { useState } from 'react';
import { AssistantTurn } from '../state/chat-types';
import { ToolCallState, ToolGroupState } from '../../shared/types';
import MarkdownContent from './MarkdownContent';
import ToolCard from './ToolCard';
import { CheckIcon, FailIcon, ChevronIcon } from './Icons';
import BrailleSpinner from './BrailleSpinner';

interface Props {
  turn: AssistantTurn;
  toolGroups: Map<string, ToolGroupState>;
  toolCalls: Map<string, ToolCallState>;
  sessionId: string;
}

/** Renders a collapsed summary for 3+ tools in a group. */
function CollapsedToolGroup({ tools, sessionId }: { tools: ToolCallState[]; sessionId: string }) {
  const [expanded, setExpanded] = useState(false);

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
        <div className="px-2 pb-1.5 space-y-0.5 bg-inset rounded-b-lg">
          {tools.map((tool) => (
            <ToolCard key={tool.toolUseId} tool={tool} sessionId={sessionId} />
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

export default React.memo(function AssistantTurnBubble({ turn, toolGroups, toolCalls, sessionId }: Props) {
  const bubbles = splitIntoBubbles(turn);

  return (
    <>
      {bubbles.map((bubble) => {
        const hasTools = bubble.toolGroupIds.length > 0;
        const toolsOnly = hasTools && !bubble.text;
        return (
          <div key={bubble.key} className="flex justify-start px-4 py-0.5">
            <div className={`assistant-bubble max-w-[85%] rounded-2xl rounded-bl-sm bg-inset text-sm text-fg px-5 ${toolsOnly ? 'py-2.5' : hasTools ? 'pt-4 pb-3' : 'py-3.5'}`}>
              {bubble.text && (
                <MarkdownContent content={bubble.text.content} />
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
            </div>
          </div>
        );
      })}
    </>
  );
});

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
    .filter((t): t is ToolCallState => t !== undefined);

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
