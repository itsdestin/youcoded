import React, { useState } from 'react';
import type { SubagentSegment, ToolCallState } from '../../../shared/types';
import MarkdownContent from '../MarkdownContent';
import ToolBody from './ToolBody';
import { friendlyToolDisplay } from '../ToolCard';

/**
 * Renders a subagent's inline timeline inside the parent AgentView card.
 *
 * Mirrors the main chat view's structure: consecutive tool calls bundle
 * into a tool group rendered as compact one-line rows with the same
 * natural-language titles the main ChatView uses (via `friendlyToolDisplay`
 * — so "Read" becomes "Reading config.ts", "Grep" becomes "Searching for
 * 'pattern'", etc.). Text segments between groups render as prose,
 * including the subagent's final message at the tail. Each tool row
 * click-expands to reveal its full ToolBody output on demand.
 *
 * The left vertical border frames the nested work visually so a dense
 * subagent (20+ tool calls) doesn't dominate the parent AgentView card.
 */
export function SubagentTimeline({ segments }: { segments: SubagentSegment[] }) {
  if (!segments || segments.length === 0) return null;
  const groups = groupSegments(segments);
  return (
    <div className="subagent-timeline border-l border-edge-dim pl-3 ml-1 mt-1 space-y-2 text-xs">
      {groups.map(g =>
        g.kind === 'text'
          ? <SubagentText key={g.id} content={g.content} />
          : <SubagentToolGroup key={g.id} tools={g.tools} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Grouping — bundle consecutive tool segments so they render together,
// matching how the main chat timeline groups tool calls.
// ---------------------------------------------------------------------------

type RenderGroup =
  | { kind: 'text'; id: string; content: string }
  | { kind: 'tools'; id: string; tools: ToolSegment[] };

type ToolSegment = Extract<SubagentSegment, { type: 'tool' }>;

function groupSegments(segments: SubagentSegment[]): RenderGroup[] {
  const groups: RenderGroup[] = [];
  let currentTools: ToolSegment[] | null = null;
  for (const seg of segments) {
    if (seg.type === 'tool') {
      if (!currentTools) {
        currentTools = [];
        groups.push({ kind: 'tools', id: `tg-${seg.id}`, tools: currentTools });
      }
      currentTools.push(seg);
    } else {
      currentTools = null;
      groups.push({ kind: 'text', id: seg.id, content: seg.content });
    }
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Text bubble — subagent narration between tool groups.
// ---------------------------------------------------------------------------

function SubagentText({ content }: { content: string }) {
  return (
    <div className="text-fg-dim">
      <MarkdownContent content={content} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool group — one card containing compact rows, click-to-expand per row.
// ---------------------------------------------------------------------------

function SubagentToolGroup({ tools }: { tools: ToolSegment[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  return (
    <div className="rounded-sm border border-edge-dim bg-inset/40 overflow-hidden">
      {tools.map((t, i) => (
        <SubagentToolRow
          key={t.id}
          segment={t}
          expanded={expanded.has(t.id)}
          onToggle={() => toggle(t.id)}
          separatorAbove={i > 0}
        />
      ))}
    </div>
  );
}

function SubagentToolRow({
  segment, expanded, onToggle, separatorAbove,
}: {
  segment: ToolSegment;
  expanded: boolean;
  onToggle: () => void;
  separatorAbove: boolean;
}) {
  const tool = segmentToToolState(segment);
  // Reuse the same natural-language title derivation the main ChatView uses
  // for its ToolCards, so subagent rows read like "Reading config.ts" instead
  // of "READ /path/to/config.ts".
  const { label, detail } = friendlyToolDisplay(tool);

  const statusIndicator =
    segment.status === 'running' ? <StatusDot color="amber" pulse /> :
    segment.status === 'failed'  ? <StatusDot color="red" /> :
                                   <StatusDot color="green" />;

  return (
    <div
      className={separatorAbove ? 'border-t border-edge-dim/60' : ''}
      style={{ contentVisibility: 'auto' }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="w-full flex items-baseline gap-2 px-2 py-1 hover:bg-panel/40 text-left"
      >
        <span className="translate-y-[2px]">{statusIndicator}</span>
        <span className="text-xs text-fg-2 font-medium truncate">{label}</span>
        {detail && (
          <span className="text-[11px] text-fg-muted truncate">{detail}</span>
        )}
        <span className="ml-auto text-[10px] text-fg-muted shrink-0">
          {expanded ? '▾' : '▸'}
        </span>
      </button>
      {expanded && (
        <div className="px-2 pb-2 pt-1 border-t border-edge-dim/40">
          <ToolBody tool={tool} />
        </div>
      )}
    </div>
  );
}

function StatusDot({ color, pulse }: { color: 'amber' | 'red' | 'green'; pulse?: boolean }) {
  const fill =
    color === 'amber' ? 'bg-amber-400' :
    color === 'red'   ? 'bg-red-500' :
                        'bg-green-500';
  return (
    <span
      aria-hidden
      className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${fill} ${pulse ? 'animate-pulse' : ''}`}
    />
  );
}

// ---------------------------------------------------------------------------

function segmentToToolState(segment: ToolSegment): ToolCallState {
  return {
    toolUseId: segment.toolUseId,
    toolName: segment.toolName,
    input: segment.input,
    status: segment.status,
    response: segment.response,
    error: segment.error,
    structuredPatch: segment.structuredPatch,
    // requestId and permissionSuggestions intentionally omitted: subagents
    // run in auto-accept mode and never hit the permission hook flow.
  };
}
