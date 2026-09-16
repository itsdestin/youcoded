import { useState } from 'react';
import type { SubagentSegment, SpecialistRunView } from '../../../shared/types';
import MarkdownContent from '../MarkdownContent';
import ToolBody from './ToolBody';
import { friendlyToolDisplay } from '../ToolCard';
import { SpecialistAskBlock } from '../specialists/SpecialistAskBlock';
import { CheckIcon, FailIcon, ChevronIcon, QuestionIcon, NoteIcon } from '../Icons';
import BrailleSpinner from '../BrailleSpinner';
import { useExpandAllToggle, getInitialExpanded } from '../../hooks/useExpandAllToggle';
import { segmentToToolState } from '../../utils/specialist-cards';

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
 * Specialists 1c: a NATIVE specialist's routed permission ask renders HERE —
 * the row flips to the question glyph and grows the same Yes / No / Always
 * buttons a top-level card has — so everything about one helper lives in its
 * Task card (Destin's 1b directive). Steers show as 'note' rows and the
 * child's own reasoning as a collapsed 'thinking' row.
 *
 * The left vertical border frames the nested work visually so a dense
 * subagent (20+ tool calls) doesn't dominate the parent AgentView card.
 */
export function SubagentTimeline({ segments, sessionId, specialistName, suppressAsk = false, runStatus }: {
  segments: SubagentSegment[];
  /** Needed only for a nested ask's response dispatch + folder name. */
  sessionId?: string;
  /** First name of the helper, for the ask/note copy ("Wren wants to…"). */
  specialistName?: string;
  /** Host already renders the ask's buttons elsewhere (the specialists popup's
   *  band): keep the ? row, drop the buttons, so one ask never shows twice
   *  in one card. */
  suppressAsk?: boolean;
  /** Task 12: the parent card's specialistRun.status, threaded down to a
   *  nested SpecialistAskBlock so a held ask can say whether the helper that
   *  asked is still running or has already finished. */
  runStatus?: SpecialistRunView['status'];
}) {
  if (!segments || segments.length === 0) return null;
  const groups = groupSegments(segments);
  return (
    <div className="subagent-timeline space-y-2 text-xs">
      {groups.map(g =>
        g.kind === 'text' ? <SubagentText key={g.id} content={g.content} />
        : g.kind === 'thinking' ? <SubagentThinking key={g.id} content={g.content} />
        : g.kind === 'note' ? <SubagentNote key={g.id} content={g.content} from={g.from} specialistName={specialistName} />
        : <SubagentToolGroup key={g.id} tools={g.tools} sessionId={sessionId} specialistName={specialistName} suppressAsk={suppressAsk} runStatus={runStatus} />
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
  | { kind: 'thinking'; id: string; content: string }
  | { kind: 'note'; id: string; content: string; from: 'user' | 'assistant' }
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
    } else if (seg.type === 'note') {
      currentTools = null;
      groups.push({ kind: 'note', id: seg.id, content: seg.content, from: seg.from });
    } else if (seg.type === 'thinking') {
      currentTools = null;
      groups.push({ kind: 'thinking', id: seg.id, content: seg.content });
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

// The child's reasoning — collapsed by default (same disclosure the main
// chat's reasoning bubble uses), so a chatty local model doesn't bury the
// tool rows. Never rendered in the parent's own thinking bubble.
function SubagentThinking({ content }: { content: string }) {
  const [open, setOpen] = useState(() => getInitialExpanded());
  useExpandAllToggle(() => setOpen(true), () => setOpen(false));
  return (
    <div className="rounded-lg border border-dashed border-edge-dim/60 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-1.5 px-3 py-1 text-left hover:bg-inset/50 transition-colors"
      >
        <span className="text-xs italic text-fg-muted">Thinking</span>
        <ChevronIcon className="w-3 h-3 shrink-0 text-fg-muted ml-auto" expanded={open} />
      </button>
      {open && (
        <div className="px-3 pb-2 text-fg-muted italic">
          <MarkdownContent content={content} />
        </div>
      )}
    </div>
  );
}

// A steer — the note the user or the assistant sent mid-run. Reads as an
// aside in the trail: who sent it, then the text.
function SubagentNote({ content, from, specialistName }: { content: string; from: 'user' | 'assistant'; specialistName?: string }) {
  const who = from === 'user' ? 'You' : 'The assistant';
  return (
    <div className="flex items-start gap-1.5 px-3 py-1 rounded-lg bg-inset/40 border border-edge-dim/60">
      <NoteIcon className="w-3 h-3 shrink-0 text-fg-muted mt-0.5" />
      <div className="min-w-0 text-fg-dim">
        <span className="font-medium text-fg-2">{who}</span>
        <span className="text-fg-muted"> sent {specialistName ?? 'the specialist'} a note: </span>
        <span>{content}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool group — one bordered card containing compact rows, click-to-expand
// per row. Mimics the ToolCard shell (border + rounded-lg + hover header)
// at a smaller scale suited to a nested timeline.
// ---------------------------------------------------------------------------

function SubagentToolGroup({ tools, sessionId, specialistName, suppressAsk, runStatus }: { tools: ToolSegment[]; sessionId?: string; specialistName?: string; suppressAsk?: boolean; runStatus?: SpecialistRunView['status'] }) {
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
          sessionId={sessionId}
          specialistName={specialistName}
          suppressAsk={suppressAsk}
          runStatus={runStatus}
        />
      ))}
    </div>
  );
}

function SubagentToolRow({
  segment, expanded, onToggle, separatorAbove, sessionId, specialistName, suppressAsk, runStatus,
}: {
  segment: ToolSegment;
  expanded: boolean;
  onToggle: () => void;
  separatorAbove: boolean;
  sessionId?: string;
  specialistName?: string;
  suppressAsk?: boolean;
  runStatus?: SpecialistRunView['status'];
}) {
  const tool = segmentToToolState(segment);
  // Same natural-language title derivation the main ChatView uses for its
  // ToolCards, so subagent rows read like "Reading config.ts" rather than
  // "READ /path/to/config.ts".
  const { label, detail } = friendlyToolDisplay(tool);
  const awaiting = segment.status === 'awaiting-approval' && !!segment.requestId;

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
        <span className="text-xs font-medium text-fg-2">
          {awaiting ? `${specialistName ?? 'The specialist'} wants to: ` : ''}{label}
        </span>
        {detail && (
          <span className="text-xs text-fg-muted truncate flex-1 min-w-0">{detail}</span>
        )}
        <ChevronIcon className="w-3 h-3 shrink-0 text-fg-muted ml-auto" expanded={expanded} />
      </button>
      {awaiting && !suppressAsk && (
        <SpecialistAskBlock segment={segment} sessionId={sessionId} specialistName={specialistName} runStatus={runStatus} />
      )}
      {expanded && <ToolBody tool={tool} sessionId={sessionId} />}
    </div>
  );
}

function StatusIcon({ status }: { status: ToolSegment['status'] }) {
  if (status === 'running') return <BrailleSpinner size="xs" />;
  if (status === 'awaiting-approval') return <QuestionIcon className="w-3 h-3 shrink-0 text-fg-dim" />;
  if (status === 'failed')  return <FailIcon  className="w-3 h-3 shrink-0 text-fg-dim" />;
  return <CheckIcon className="w-3 h-3 shrink-0 text-fg-dim" />;
}

// ---------------------------------------------------------------------------

