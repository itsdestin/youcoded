import React from 'react';
import type { SubagentSegment, ToolCallState } from '../../../shared/types';
import MarkdownContent from '../MarkdownContent';
import ToolBody from './ToolBody';

/**
 * Renders a subagent's inline timeline inside the parent AgentView card.
 * The vertical left border visually frames the nested work so 20+ rows
 * remain scannable rather than dominating the card.
 *
 * Tool rows reuse ToolBody — all per-tool views read from input/response/
 * status/error/structuredPatch, so a SubagentSegment of type:'tool' shaped
 * as a lightweight ToolCallState works without changes to those views.
 */
export function SubagentTimeline({ segments }: { segments: SubagentSegment[] }) {
  if (!segments || segments.length === 0) return null;
  return (
    <div className="subagent-timeline border-l border-edge-dim pl-3 ml-1 mt-1 space-y-1.5 text-xs">
      {segments.map(seg =>
        seg.type === 'text'
          ? (
              <div key={seg.id} className="text-fg-dim">
                <MarkdownContent content={seg.content} />
              </div>
            )
          : <SubagentToolRow key={seg.id} segment={seg} />
      )}
    </div>
  );
}

function SubagentToolRow({ segment }: { segment: Extract<SubagentSegment, { type: 'tool' }> }) {
  // Shape the segment into an ad-hoc ToolCallState so ToolBody's dispatch
  // can pick the right per-tool view (ReadView, GrepView, BashView, etc.).
  const tool: ToolCallState = {
    toolUseId: segment.toolUseId,
    toolName: segment.toolName,
    input: segment.input,
    status: segment.status,
    response: segment.response,
    error: segment.error,
    structuredPatch: segment.structuredPatch,
  };
  return (
    <div className="subagent-tool-row" style={{ contentVisibility: 'auto' }}>
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-fg-muted">
        <span>{segment.toolName}</span>
        {segment.status === 'running' && <span>·</span>}
        {segment.status === 'running' && <span className="animate-pulse">running</span>}
      </div>
      <ToolBody tool={tool} />
    </div>
  );
}
