import React, { useState } from 'react';
import type { SubagentSegment, ToolCallState } from '../../../shared/types';
import MarkdownContent from '../MarkdownContent';
import ToolBody from './ToolBody';
import { friendlyToolDisplay } from '../ToolCard';
import { CheckIcon, FailIcon, ChevronIcon } from '../Icons';
import BrailleSpinner from '../BrailleSpinner';
import { useExpandAllToggle, getInitialExpanded } from '../../hooks/useExpandAllToggle';

/**
 * Renders a subagent's inline timeline inside the parent AgentView card.
 *
 * Mirrors the main chat view's structure: consecutive tool calls bundle
 * into a tool group rendered as compact rows with the same natural-language
 * titles the main ChatView uses (via `friendlyToolDisplay`) and mini
 * versions of the same status / chevron icons (CheckIcon, FailIcon,
 * BrailleSpinner, ChevronIcon at xs size). Text segments between groups
 * render as prose. Each tool row click-expands to reveal its full
 * ToolBody output on demand.
 *
 * The left vertical border frames the nested work visually so a dense
 * subagent (20+ tool calls) doesn't dominate the parent AgentView card.
 */
export function SubagentTimeline({ segments }: { segments: SubagentSegment[] }) {
  if (!segments || segments.length === 0) return null;
  const groups = groupSegments(segments);
  return (
    <div className="subagent-timeline space-y-2 text-xs">
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
// Tool group — one bordered card containing compact rows, click-to-expand
// per row. Mimics the ToolCard shell (border + rounded-lg + hover header)
// at a smaller scale suited to a nested timeline.
// ---------------------------------------------------------------------------

function SubagentToolGroup({ tools }: { tools: ToolSegment[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    getInitialExpanded() ? new Set(tools.map(t => t.id)) : new Set()
  );
  const toggle = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  // Ctrl+O: expand opens every row in this group; collapse empties the set.
  useExpandAllToggle(
    () => setExpanded(new Set(tools.map(t => t.id))),
    () => setExpanded(new Set()),
  );
  return (
    <div className="rounded-lg border border-edge bg-inset overflow-hidden">
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
  // Same natural-language title derivation the main ChatView uses for its
  // ToolCards, so subagent rows read like "Reading config.ts" rather than
  // "READ /path/to/config.ts".
  const { label, detail } = friendlyToolDisplay(tool);

  return (
    <div
      className={separatorAbove ? 'border-t border-edge/60' : ''}
      style={{ contentVisibility: 'auto' }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="w-full flex items-center gap-1.5 px-3 py-1 text-left hover:bg-inset/50 transition-colors"
      >
        <StatusIcon status={segment.status} />
        <span className="text-fg-faint text-xs select-none">|</span>
        <span className="text-xs font-medium text-fg-2">{label}</span>
        {detail && (
          <span className="text-xs text-fg-muted truncate flex-1 min-w-0">{detail}</span>
        )}
        <ChevronIcon className="w-3 h-3 shrink-0 text-fg-muted ml-auto" expanded={expanded} />
      </button>
      {expanded && <ToolBody tool={tool} />}
    </div>
  );
}

function StatusIcon({ status }: { status: ToolSegment['status'] }) {
  if (status === 'running') return <BrailleSpinner size="xs" />;
  if (status === 'failed')  return <FailIcon  className="w-3 h-3 shrink-0 text-fg-dim" />;
  return <CheckIcon className="w-3 h-3 shrink-0 text-fg-dim" />;
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
