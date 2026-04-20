import React, { useState } from 'react';
import type { SubagentSegment, ToolCallState } from '../../../shared/types';
import MarkdownContent from '../MarkdownContent';
import ToolBody from './ToolBody';

/**
 * Renders a subagent's inline timeline inside the parent AgentView card.
 *
 * Mirrors the chat view's structure: consecutive tool calls are bundled
 * into a tool group that renders compact one-line summaries; text
 * segments between groups render as prose (including the subagent's
 * final message, which is the tail of the timeline). Each tool row
 * click-expands to show its full ToolBody on demand.
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
// Tool group — compact one-line summary per tool, click-to-expand.
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
  const { label, detail } = toolSummary(segment);
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
        className="w-full flex items-center gap-2 px-2 py-1 hover:bg-panel/40 text-left"
      >
        {statusIndicator}
        <span className="text-[10px] uppercase tracking-wider text-fg-muted font-medium shrink-0">
          {label}
        </span>
        {detail && (
          <span className="text-xs text-fg-dim truncate">{detail}</span>
        )}
        <span className="ml-auto text-[10px] text-fg-muted shrink-0">
          {expanded ? '▾' : '▸'}
        </span>
      </button>
      {expanded && (
        <div className="px-2 pb-2 pt-1 border-t border-edge-dim/40">
          <ToolBody tool={segmentToToolState(segment)} />
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
// Per-tool summary — compact one-line label for the row header.
// Keeps the timeline scannable; full output is revealed on expand.
// ---------------------------------------------------------------------------

function toolSummary(seg: ToolSegment): { label: string; detail?: string } {
  const input = seg.input || {};
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined);

  switch (seg.toolName) {
    case 'Read':          return { label: 'Read',    detail: shortPath(str('file_path')) };
    case 'Write':         return { label: 'Write',   detail: shortPath(str('file_path')) };
    case 'Edit':          return { label: 'Edit',    detail: shortPath(str('file_path')) };
    case 'MultiEdit':     return { label: 'Edit*',   detail: shortPath(str('file_path')) };
    case 'NotebookEdit':  return { label: 'NbEdit',  detail: shortPath(str('notebook_path')) };
    case 'Grep': {
      const pattern = str('pattern');
      const path    = str('path');
      const glob    = str('glob');
      const where   = path ? ` in ${shortPath(path)}` : (glob ? ` (${glob})` : '');
      return { label: 'Grep', detail: pattern ? `"${truncate(pattern, 40)}"${where}` : undefined };
    }
    case 'Glob':          return { label: 'Glob',    detail: str('pattern') };
    case 'Bash':          return { label: 'Bash',    detail: truncate(str('command') || '', 70) };
    case 'WebFetch':      return { label: 'Fetch',   detail: str('url') };
    case 'WebSearch':     return { label: 'Search',  detail: str('query') };
    case 'Agent':
    case 'Task': {
      const sub  = str('subagent_type');
      const desc = str('description');
      const detail = [sub, desc].filter(Boolean).join(': ');
      return { label: 'Agent', detail: detail || undefined };
    }
    default:              return { label: seg.toolName };
  }
}

function shortPath(p: string | undefined): string | undefined {
  if (!p) return undefined;
  // Keep last two path segments so long absolute paths don't eat the row.
  const parts = p.split(/[\/\\]/);
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join('/')}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
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
