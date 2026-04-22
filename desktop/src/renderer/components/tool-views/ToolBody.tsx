import React, { useMemo, useState, useRef, useEffect } from 'react';
import { StructuredPatchHunk, ToolCallState } from '../../../shared/types';
import MarkdownContent from '../MarkdownContent';
import { useChatState } from '../../state/chat-context';
import { buildTasksById, TASK_LIFECYCLE, TaskState, TaskStatus } from '../../state/task-state';
import { SubagentTimeline } from './SubagentTimeline';
import { ChevronIcon } from '../Icons';
import { useExpandAllToggle, getInitialExpanded, isExpandModeActive } from '../../hooks/useExpandAllToggle';

// Parsed views for expanded tool cards. One dispatcher + inline view functions;
// splitting per-file only becomes worthwhile if a single view grows past ~80
// lines. Falls back to a polished raw view for anything we haven't specialized.

// --- Shared helpers ---

function basename(fp: string): string {
  const parts = fp.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || fp;
}

function parentDir(fp: string): string {
  const parts = fp.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.slice(0, -1).join('/');
}

// Reveal literal \n / \" that JSON.stringify would otherwise hide, and collapse
// very long string values so raw fallback stays scannable.
function unescapeForDisplay(s: string): string {
  return s.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\t/g, '\t');
}

// Strip CR-prefixed progress lines ("\rUpdating files: 42%…\rUpdating files: 91%…")
// and keep just the final state of each line group. Common in git / npm output.
function stripCarriageReturns(s: string): string {
  return s.split('\n').map(line => {
    const parts = line.split('\r');
    return parts[parts.length - 1];
  }).join('\n');
}

function CollapsibleBlock({ children, maxLines = 20, className = '' }: { children: string; maxLines?: number; className?: string }) {
  const [open, setOpen] = useState(() => getInitialExpanded());
  useExpandAllToggle(() => setOpen(true), () => setOpen(false));
  const lines = children.split('\n');
  const overflow = lines.length > maxLines;
  const shown = open || !overflow ? children : lines.slice(0, maxLines).join('\n');
  return (
    <div className="relative">
      <pre className={`text-xs text-fg-dim bg-panel rounded-sm p-2 overflow-auto whitespace-pre-wrap font-mono ${className}`}>
        {shown}
        {overflow && !open && <span className="text-fg-muted">{'\n'}…</span>}
      </pre>
      {overflow && (
        <button
          onClick={() => setOpen(o => !o)}
          className="mt-1 text-[10px] uppercase tracking-wider text-fg-muted hover:text-fg-2"
        >
          {open ? 'Show less' : `Show ${lines.length - maxLines} more lines`}
        </button>
      )}
    </div>
  );
}

function PathHeader({ fp, extra }: { fp: string; extra?: React.ReactNode }) {
  const dir = parentDir(fp);
  return (
    <div className="flex items-center gap-1.5 text-[11px] font-mono">
      {dir && <span className="text-fg-muted">{dir}/</span>}
      <span className="text-fg-2 font-medium">{basename(fp)}</span>
      {extra}
    </div>
  );
}

// Tinted chips keep the semantic signal but use hardcoded status text colors
// (text-green-400 etc. are defined in globals.css and stay consistent across
// themes) instead of pastels like text-green-300 which wash out on high-chroma
// theme canvases (e.g. Hello Kitty's pink). info falls back to bg-inset because
// there's no hardcoded blue token — translucent blue on pink goes muddy.
function Chip({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'add' | 'remove' | 'warn' | 'info' }) {
  const toneClass =
    tone === 'add' ? 'bg-green-600/15 text-green-400 border-green-600/40'
    : tone === 'remove' ? 'bg-red-600/15 text-red-400 border-red-600/40'
    : tone === 'warn' ? 'bg-amber-600/15 text-amber-700 border-amber-600/40'
    : tone === 'info' ? 'bg-inset text-fg-2 border-edge'
    : 'bg-inset text-fg-muted border-edge';
  return (
    <span className={`px-1.5 py-px text-[10px] uppercase tracking-wider rounded-sm border font-medium ${toneClass}`}>
      {children}
    </span>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handle = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard may be blocked — silently ignore */ }
  };
  return (
    <button
      onClick={handle}
      className="text-[10px] uppercase tracking-wider text-fg-muted hover:text-fg-2 px-1 rounded-sm"
      title="Copy"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function ErrorBlock({ error }: { error: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-red-500 mb-1">Error</div>
      <pre className="text-xs text-red-400 bg-panel rounded-sm p-2 overflow-auto max-h-48 whitespace-pre-wrap">
        {error}
      </pre>
    </div>
  );
}

// --- Edit / Write ---

// Tinted row backgrounds carry the semantic signal (kept per design intent),
// but code text uses text-fg (theme-adaptive) instead of pastel text-red-200 /
// text-green-200 which washed out on high-chroma theme canvases like Hello
// Kitty's pink. The solid left bar + colored gutter glyph stay hardcoded so
// the add/remove signal is visible even if the tint blends into the bubble.
//
// Long diffs cap the container height to DIFF_PREVIEW_LINES rows and scroll
// internally; an Expand button removes the cap for full inline view. Matches
// ReadView's preview-then-expand pattern.
const DIFF_ROW_PX = 20;
const DIFF_PREVIEW_LINES = 15;

// Unified-diff row: del = removed line (old side only), add = inserted line
// (new side only), ctx = unchanged (shown on both sides, dimmed). Line numbers
// reflect the line's real position within old_string / new_string rather than
// restarting at 1 for each side.
type DiffRow =
  | { kind: 'ctx'; oldN: number; newN: number; text: string }
  | { kind: 'del'; oldN: number; text: string }
  | { kind: 'add'; newN: number; text: string };

// LCS-based line diff. Small inputs (Edit old/new blocks) make O(m*n) fine.
// Produces rows in source order so deletions and insertions interleave with
// context instead of being dumped into two separate contiguous blocks.
function diffLines(oldLines: string[], newLines: string[]): DiffRow[] {
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      rows.push({ kind: 'ctx', oldN: i + 1, newN: j + 1, text: oldLines[i] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ kind: 'del', oldN: i + 1, text: oldLines[i] });
      i++;
    } else {
      rows.push({ kind: 'add', newN: j + 1, text: newLines[j] });
      j++;
    }
  }
  while (i < m) { rows.push({ kind: 'del', oldN: i + 1, text: oldLines[i] }); i++; }
  while (j < n) { rows.push({ kind: 'add', newN: j + 1, text: newLines[j] }); j++; }
  return rows;
}

// Walk a jsdiff-style hunk into DiffRows with ABSOLUTE file line numbers. The
// hunk's `lines` array is already interleaved ([' ctx', '-del', '+add', ...]).
// oldStart/newStart are 1-indexed file line numbers for the first line of the
// hunk. Context advances both counters; '-' advances only old; '+' advances
// only new.
function rowsFromHunk(hunk: StructuredPatchHunk): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldN = hunk.oldStart;
  let newN = hunk.newStart;
  for (const raw of hunk.lines) {
    const prefix = raw.charAt(0);
    const text = raw.slice(1);
    if (prefix === '-') {
      rows.push({ kind: 'del', oldN, text });
      oldN++;
    } else if (prefix === '+') {
      rows.push({ kind: 'add', newN, text });
      newN++;
    } else {
      rows.push({ kind: 'ctx', oldN, newN, text });
      oldN++;
      newN++;
    }
  }
  return rows;
}

function DiffView({
  oldStr,
  newStr,
  structuredPatch,
}: {
  oldStr: string;
  newStr: string;
  structuredPatch?: StructuredPatchHunk[];
}) {
  // Prefer Claude Code's pre-computed hunks (absolute file line numbers).
  // Fall back to LCS diff of old_string/new_string when the tool is still
  // running / hasn't produced a structured result yet.
  const { rows, hunkBoundaries, maxLineNum } = useMemo(() => {
    if (structuredPatch && structuredPatch.length > 0) {
      const out: DiffRow[] = [];
      const boundaries = new Set<number>();
      let max = 0;
      structuredPatch.forEach((hunk, i) => {
        if (i > 0) boundaries.add(out.length);
        const hunkRows = rowsFromHunk(hunk);
        out.push(...hunkRows);
        max = Math.max(max, hunk.oldStart + hunk.oldLines, hunk.newStart + hunk.newLines);
      });
      return { rows: out, hunkBoundaries: boundaries, maxLineNum: max };
    }
    const oldLines = oldStr.split('\n');
    const newLines = newStr.split('\n');
    return {
      rows: diffLines(oldLines, newLines),
      hunkBoundaries: new Set<number>(),
      maxLineNum: Math.max(oldLines.length, newLines.length),
    };
  }, [oldStr, newStr, structuredPatch]);

  const total = rows.length;
  const [open, setOpen] = useState(() => getInitialExpanded());
  useExpandAllToggle(() => setOpen(true), () => setOpen(false));
  const overflow = total > DIFF_PREVIEW_LINES;
  const containerStyle = open || !overflow
    ? undefined
    : { maxHeight: `${DIFF_PREVIEW_LINES * DIFF_ROW_PX}px` };

  // Single line-number gutter matching Claude Code's native diff convention:
  // deleted rows show the old-file number, context + added rows show the
  // new-file number. Pad to the widest number so the column stays aligned —
  // with structuredPatch, numbers can be large (e.g. line 2854).
  const gutterWidth = Math.max(2, String(maxLineNum).length);
  const gutterCh = `${gutterWidth}ch`;

  return (
    <>
      <div
        className="text-xs font-mono rounded-sm border border-edge overflow-auto"
        style={containerStyle}
      >
        {rows.map((row, idx) => {
          const showSeparator = hunkBoundaries.has(idx);
          // Single-number gutter: del → old-file number (the line being removed),
          // add/ctx → new-file number (what the file will look like post-edit).
          const lineNum = row.kind === 'del' ? String(row.oldN) : String(row.newN);
          const rowClass =
            row.kind === 'del'
              ? 'bg-red-600/10 border-l-[3px] border-red-500'
              : row.kind === 'add'
                ? 'bg-green-600/10 border-l-[3px] border-green-400'
                : 'border-l-[3px] border-transparent';
          const glyph = row.kind === 'del' ? '−' : row.kind === 'add' ? '+' : ' ';
          const glyphClass =
            row.kind === 'del'
              ? 'text-red-400 font-bold'
              : row.kind === 'add'
                ? 'text-green-400 font-bold'
                : 'text-fg-muted';
          const textClass = row.kind === 'ctx' ? 'text-fg-dim' : 'text-fg';
          return (
            <React.Fragment key={idx}>
              {showSeparator && (
                <div className="flex items-center text-fg-faint text-[10px] border-y border-edge-dim bg-inset/40 select-none">
                  <span className="px-2 py-0.5">⋯</span>
                </div>
              )}
              <div className={`flex items-start ${rowClass}`}>
                <span
                  className="text-right px-1.5 py-0.5 text-fg-muted select-none shrink-0"
                  style={{ width: gutterCh }}
                >
                  {lineNum}
                </span>
                <span className={`w-4 select-none shrink-0 ${glyphClass}`}>{glyph}</span>
                <span className={`py-0.5 pr-2 whitespace-pre-wrap break-all flex-1 ${textClass}`}>{row.text || ' '}</span>
              </div>
            </React.Fragment>
          );
        })}
      </div>
      {overflow && (
        <button
          onClick={() => setOpen(o => !o)}
          className="mt-1 text-[10px] uppercase tracking-wider text-fg-muted hover:text-fg-2"
        >
          {open ? 'Collapse' : `Expand (${total} lines)`}
        </button>
      )}
    </>
  );
}

function EditView({ tool }: { tool: ToolCallState }) {
  const fp = (tool.input.file_path as string) || '';
  const oldStr = (tool.input.old_string as string) || '';
  const newStr = (tool.input.new_string as string) || '';
  const replaceAll = tool.input.replace_all as boolean | undefined;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <PathHeader fp={fp} />
        {replaceAll && <Chip tone="warn">Replace all</Chip>}
      </div>
      {(oldStr || newStr) ? (
        <DiffView oldStr={oldStr} newStr={newStr} structuredPatch={tool.structuredPatch} />
      ) : (
        <div className="text-xs text-fg-muted italic">No change content.</div>
      )}
      {tool.error && <ErrorBlock error={tool.error} />}
    </div>
  );
}

function WriteView({ tool }: { tool: ToolCallState }) {
  const fp = (tool.input.file_path as string) || '';
  const content = (tool.input.content as string) || '';
  const lineCount = content ? content.split('\n').length : 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <PathHeader fp={fp} />
        <Chip tone="add">New file</Chip>
        {lineCount > 0 && <span className="text-[10px] text-fg-muted">{lineCount} lines</span>}
      </div>
      {content ? (
        <div className="rounded-sm overflow-hidden border border-green-600/30 bg-green-600/10">
          <CollapsibleBlock maxLines={20}>{content}</CollapsibleBlock>
        </div>
      ) : (
        <div className="text-xs text-fg-muted italic">Empty file.</div>
      )}
      {tool.error && <ErrorBlock error={tool.error} />}
    </div>
  );
}

// --- Bash / PowerShell ---

// Shared renderer for shell-like tools (Bash, MCP PowerShell, etc.). Shows the
// command prominently, routes output through CR-strip + collapse, and promotes
// error state to a pill at the top.
function ShellView({ tool, commandField }: {
  tool: ToolCallState;
  commandField: string;
}) {
  const cmd = (tool.input[commandField] as string) || '';
  const bg = tool.input.run_in_background as boolean | undefined;
  const response = tool.response ? stripCarriageReturns(tool.response) : '';
  const failed = tool.status === 'failed';

  // Description is already shown as the collapsed-header label (see
  // friendlyToolDisplay in ToolCard.tsx); don't repeat it in the expanded body.
  // Status chips (Background / Failed) sit above the command so they don't
  // squeeze the code block horizontally. "Done" was dropped — the header
  // status icon already covers success. Copy button is absolutely positioned
  // inside the code block's top-right corner (visible on hover).
  const chips: React.ReactNode[] = [];
  if (bg) chips.push(<Chip key="bg" tone="info">Background</Chip>);
  if (failed) chips.push(<Chip key="failed" tone="remove">Failed</Chip>);

  return (
    <div className="space-y-2">
      {chips.length > 0 && <div className="flex items-center gap-1.5">{chips}</div>}
      <div className="relative group">
        <pre className="text-xs font-mono bg-canvas border border-edge rounded-sm px-2 py-1 pr-14 overflow-auto whitespace-pre-wrap break-all text-fg">
          {cmd || <span className="text-fg-muted italic">(no command)</span>}
        </pre>
        {cmd && (
          <div className="absolute top-1 right-1 opacity-70 group-hover:opacity-100 transition-opacity">
            <CopyButton text={cmd} />
          </div>
        )}
      </div>
      {response && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-fg-muted mb-1">Output</div>
          <CollapsibleBlock maxLines={20} className="bg-canvas">{response}</CollapsibleBlock>
        </div>
      )}
      {tool.error && <ErrorBlock error={tool.error} />}
    </div>
  );
}

// --- TodoWrite / TaskCreate / TaskUpdate ---

interface TodoItem {
  content?: string;
  activeForm?: string;
  status?: 'pending' | 'in_progress' | 'completed';
}

function TodoIcon({ status }: { status: TodoItem['status'] }) {
  if (status === 'completed') return <span className="text-green-400 select-none">●</span>;
  if (status === 'in_progress') return <span className="text-blue-400 select-none">◐</span>;
  return <span className="text-fg-muted select-none">○</span>;
}

function TodoWriteView({ tool }: { tool: ToolCallState }) {
  const todos = (tool.input.todos as TodoItem[] | undefined) || [];
  if (todos.length === 0) {
    return <div className="text-xs text-fg-muted italic">No todos.</div>;
  }
  return (
    <ul className="space-y-1">
      {todos.map((t, i) => {
        const inProg = t.status === 'in_progress';
        const done = t.status === 'completed';
        const label = inProg && t.activeForm ? t.activeForm : (t.content || '');
        return (
          <li key={i} className="flex items-start gap-2 text-xs">
            <TodoIcon status={t.status} />
            <span className={
              done ? 'line-through text-fg-muted'
              : inProg ? 'font-medium text-fg'
              : 'text-fg-2'
            }>
              {label}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function TaskCreateView({ tool }: { tool: ToolCallState }) {
  const subject = (tool.input.subject as string) || '';
  const body = (tool.input.body as string) || '';
  const priority = tool.input.priority as string | undefined;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        {subject && <span className="text-sm font-medium text-fg">{subject}</span>}
        {priority && <Chip tone="info">{priority}</Chip>}
        <Chip tone="add">Created</Chip>
      </div>
      {body && <div className="text-xs text-fg-dim whitespace-pre-wrap">{body}</div>}
      {tool.error && <ErrorBlock error={tool.error} />}
    </div>
  );
}

// Lifecycle pill: pending → in_progress → completed (or deleted).
// Current step is bold + filled; earlier steps are dim filled; future steps are
// outlined muted. Driven purely by the status — works for any Task* view.
function LifecyclePill({ status }: { status?: TaskStatus }) {
  if (!status || status === 'deleted') {
    return status === 'deleted' ? <Chip tone="remove">Deleted</Chip> : null;
  }
  const currentIdx = TASK_LIFECYCLE.indexOf(status);
  return (
    <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider">
      {TASK_LIFECYCLE.map((s, i) => {
        const done = i < currentIdx;
        const active = i === currentIdx;
        return (
          <React.Fragment key={s}>
            <span className={
              active ? 'text-fg font-bold'
              : done ? 'text-fg-muted'
              : 'text-fg-faint'
            }>
              <span className={
                active ? 'inline-block w-2 h-2 rounded-full bg-fg mr-1 align-middle'
                : done ? 'inline-block w-2 h-2 rounded-full bg-fg-muted mr-1 align-middle'
                : 'inline-block w-2 h-2 rounded-full border border-fg-faint mr-1 align-middle'
              } />
              {s.replace('_', ' ')}
            </span>
            {i < TASK_LIFECYCLE.length - 1 && <span className="text-fg-faint">→</span>}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function TaskUpdateView({ tool, task }: { tool: ToolCallState; task?: TaskState }) {
  const taskId = (tool.input.taskId as string) || '';
  const newStatus = tool.input.status as TaskStatus | undefined;
  const subject = (tool.input.subject as string | undefined) ?? task?.subject;
  const description = (tool.input.description as string | undefined) ?? task?.description;
  const priority = (tool.input.priority as string | undefined) ?? task?.priority;

  // Previous status = whatever the task was at the event just before this one.
  // task.events is insertion-ordered; find our toolUseId and look one back.
  let prevStatus: TaskStatus | undefined;
  if (task) {
    const idx = task.events.findIndex(e => e.toolUseId === tool.toolUseId);
    if (idx > 0) {
      for (let i = idx - 1; i >= 0; i--) {
        if (task.events[i].status) { prevStatus = task.events[i].status; break; }
      }
    }
  }

  // What the task looked like at the moment of this update (for the pill).
  const displayStatus = newStatus ?? task?.status;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        {subject ? (
          <span className="text-sm font-medium text-fg">{subject}</span>
        ) : (
          <span className="text-xs font-mono text-fg-muted">#{taskId}</span>
        )}
        {priority && <Chip tone="info">{priority}</Chip>}
      </div>
      {newStatus && prevStatus && prevStatus !== newStatus && (
        <div className="text-xs text-fg-dim">
          <span className="text-fg-muted">{prevStatus.replace('_', ' ')}</span>
          <span className="text-fg-faint mx-1.5">→</span>
          <span className="text-fg font-medium">{newStatus.replace('_', ' ')}</span>
        </div>
      )}
      <LifecyclePill status={displayStatus} />
      {description && <div className="text-xs text-fg-dim whitespace-pre-wrap">{description}</div>}
      {task && task.events.length > 1 && (
        <div className="text-[10px] text-fg-muted">
          event {task.events.findIndex(e => e.toolUseId === tool.toolUseId) + 1} of {task.events.length}
        </div>
      )}
      {tool.error && <ErrorBlock error={tool.error} />}
    </div>
  );
}

// --- Read ---

// Strip the `cat -n` prefix and build gutter + code rows. Response format is:
//   "     1\tfirst line\n     2\tsecond line\n..."
function parseCatN(resp: string): { lineNo: number; text: string }[] {
  const rows: { lineNo: number; text: string }[] = [];
  for (const line of resp.split('\n')) {
    const m = line.match(/^\s*(\d+)\t(.*)$/);
    if (m) {
      rows.push({ lineNo: parseInt(m[1], 10), text: m[2] });
    } else if (rows.length > 0) {
      // Continuation (wrapped line) — append to previous row
      rows[rows.length - 1].text += '\n' + line;
    }
  }
  return rows;
}

// Approximate line height for the xs mono rows — keeps the initial viewport
// capped at ~15 lines (text-xs ≈ 12px + py-0.5 padding ≈ 20px per row).
const READ_ROW_PX = 20;
const READ_PREVIEW_LINES = 15;

function ReadView({ tool }: { tool: ToolCallState }) {
  const fp = (tool.input.file_path as string) || '';
  const offset = tool.input.offset as number | undefined;
  const limit = tool.input.limit as number | undefined;
  const rows = tool.response ? parseCatN(tool.response) : [];
  const [open, setOpen] = useState(() => getInitialExpanded());
  useExpandAllToggle(() => setOpen(true), () => setOpen(false));
  const overflow = rows.length > READ_PREVIEW_LINES;

  let rangeLabel = '';
  if (rows.length > 0) {
    rangeLabel = `lines ${rows[0].lineNo}–${rows[rows.length - 1].lineNo}`;
  } else if (offset != null && limit != null) {
    rangeLabel = `lines ${offset}–${offset + limit}`;
  }

  // Collapsed: cap container height to 15 rows and let it scroll internally.
  // Expanded: remove the cap so everything flows inline. All rows always
  // render (no virtualization needed — Read responses are bounded by the
  // tool's limit param).
  const containerStyle = open
    ? undefined
    : { maxHeight: `${READ_PREVIEW_LINES * READ_ROW_PX}px` };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <PathHeader fp={fp} />
        {rangeLabel && <Chip>{rangeLabel}</Chip>}
      </div>
      {rows.length > 0 ? (
        <>
          <div
            className="text-xs font-mono rounded-sm border border-edge bg-panel overflow-auto"
            style={containerStyle}
          >
            {rows.map(r => (
              <div key={r.lineNo} className="flex items-start">
                <span className="w-10 text-right px-1.5 py-0.5 text-fg-muted select-none shrink-0 border-r border-edge">{r.lineNo}</span>
                <span className="py-0.5 px-2 text-fg-dim whitespace-pre-wrap break-all flex-1">{r.text || ' '}</span>
              </div>
            ))}
          </div>
          {overflow && (
            <button
              onClick={() => setOpen(o => !o)}
              className="text-[10px] uppercase tracking-wider text-fg-muted hover:text-fg-2"
            >
              {open ? 'Collapse' : `Expand (${rows.length} lines)`}
            </button>
          )}
        </>
      ) : tool.response ? (
        <CollapsibleBlock maxLines={40}>{tool.response}</CollapsibleBlock>
      ) : null}
      {tool.error && <ErrorBlock error={tool.error} />}
    </div>
  );
}

// --- Agent / Task subagent ---

const SUBAGENT_TONE: Record<string, 'neutral' | 'add' | 'info' | 'warn'> = {
  general: 'neutral',
  'general-purpose': 'neutral',
  Explore: 'info',
  Plan: 'warn',
  'claude-code-guide': 'add',
};

function AgentView({ tool }: { tool: ToolCallState }) {
  const desc = (tool.input.description as string) || '';
  const subagent = (tool.input.subagent_type as string) || 'general-purpose';
  const prompt = (tool.input.prompt as string) || '';
  const segments = tool.subagentSegments || [];

  // Auto-expand the activity section while running; auto-collapse once the
  // parent Agent tool has a response (subagent completed). User toggles
  // stick for the rest of the session.
  const [showTimeline, setShowTimeline] = useState(() => getInitialExpanded(!tool.response));
  // Start userToggled=true when the shortcut is already in effect so the
  // auto-collapse-on-response effect below doesn't fight the user's intent.
  const [userToggled, setUserToggled] = useState(() => isExpandModeActive());
  const prevHadResponse = useRef(!!tool.response);
  useEffect(() => {
    if (userToggled) return;
    const hasResponse = !!tool.response;
    if (!prevHadResponse.current && hasResponse) setShowTimeline(false);
    prevHadResponse.current = hasResponse;
  }, [tool.response, userToggled]);
  // Ctrl+O: mark userToggled so the auto-collapse-on-response effect doesn't
  // fight the shortcut back closed as soon as the subagent completes.
  useExpandAllToggle(
    () => { setShowTimeline(true); setUserToggled(true); },
    () => { setShowTimeline(false); setUserToggled(true); },
  );

  const tone = SUBAGENT_TONE[subagent] || 'neutral';

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <Chip tone={tone}>{subagent}</Chip>
        {desc && <span className="text-xs font-medium text-fg-2">{desc}</span>}
      </div>
      {prompt && (
        <AgentSection title="Briefing" defaultOpen={false}>
          <div className="text-sm text-fg-dim">
            <MarkdownContent content={prompt} />
          </div>
        </AgentSection>
      )}
      {segments.length > 0 && (
        <AgentSection
          title={`Activity (${segments.length})`}
          open={showTimeline}
          onToggle={() => { setShowTimeline(s => !s); setUserToggled(true); }}
        >
          <SubagentTimeline segments={segments} />
        </AgentSection>
      )}
      {tool.response && (
        <AgentSection title="Response" defaultOpen={true}>
          <div className="text-sm text-fg-dim">
            <MarkdownContent content={tool.response} />
          </div>
        </AgentSection>
      )}
      {tool.error && <ErrorBlock error={tool.error} />}
    </div>
  );
}

/**
 * Expandable card styled to match the main ChatView ToolCard shell
 * (`border border-edge rounded-lg`, same header padding, same ChevronIcon).
 * Controlled or uncontrolled — `open`/`onToggle` takes precedence over
 * `defaultOpen`. Used for the three AgentView sections: Briefing, Activity,
 * Response.
 */
function AgentSection({
  title, children, defaultOpen = false, open, onToggle,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onToggle?: () => void;
}) {
  const [internalOpen, setInternalOpen] = useState(() => getInitialExpanded(defaultOpen));
  // Uncontrolled AgentSections (Briefing, Response) respond to Ctrl+O; the
  // controlled Activity section reflects whatever AgentView's showTimeline
  // says — isOpen prefers the `open` prop, so this is a harmless no-op there.
  useExpandAllToggle(() => setInternalOpen(true), () => setInternalOpen(false));
  const isOpen = open ?? internalOpen;
  const handleToggle = () => {
    if (onToggle) onToggle();
    else setInternalOpen(v => !v);
  };
  return (
    <div className="border border-edge rounded-lg overflow-hidden">
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={handleToggle}
        className="w-full flex items-center gap-1.5 px-3 py-1.5 text-left hover:bg-inset/50 transition-colors"
      >
        <span className="text-xs font-medium text-fg-2">{title}</span>
        <ChevronIcon className="w-3.5 h-3.5 shrink-0 text-fg-muted ml-auto" expanded={isOpen} />
      </button>
      {isOpen && (
        <div className="px-3 py-2 border-t border-edge">
          {children}
        </div>
      )}
    </div>
  );
}

// --- Grep / Glob ---

function GrepView({ tool }: { tool: ToolCallState }) {
  const pattern = (tool.input.pattern as string) || '';
  const mode = (tool.input.output_mode as string) || 'files_with_matches';
  const glob = tool.input.glob as string | undefined;
  const path = tool.input.path as string | undefined;
  const resp = tool.response || '';
  const lines = resp ? resp.split('\n').filter(l => l.trim()) : [];

  // Parse `file:line:match` for content mode; treat everything else as a flat
  // list. For content mode we group by file so the eye can scan.
  let body: React.ReactNode;
  if (mode === 'content' && lines.length > 0) {
    const byFile = new Map<string, { line: string; text: string }[]>();
    for (const l of lines) {
      const m = l.match(/^(.+?):(\d+):(.*)$/);
      if (m) {
        const [, file, ln, text] = m;
        if (!byFile.has(file)) byFile.set(file, []);
        byFile.get(file)!.push({ line: ln, text });
      }
    }
    body = (
      <div className="space-y-2">
        {Array.from(byFile.entries()).map(([file, matches]) => (
          <div key={file} className="text-xs font-mono">
            <div className="text-fg-2 font-medium">{file}</div>
            <div className="pl-3 space-y-0.5 text-fg-dim">
              {matches.slice(0, 10).map((m, i) => (
                <div key={i} className="flex gap-2">
                  <span className="text-fg-muted shrink-0">{m.line}:</span>
                  <span className="whitespace-pre-wrap break-all">{m.text}</span>
                </div>
              ))}
              {matches.length > 10 && (
                <div className="text-fg-muted italic">…{matches.length - 10} more in this file</div>
              )}
            </div>
          </div>
        ))}
      </div>
    );
  } else if (lines.length > 0) {
    body = (
      <ul className="text-xs font-mono space-y-0.5">
        {lines.slice(0, 30).map((l, i) => (
          <li key={i} className="text-fg-dim">{l}</li>
        ))}
        {lines.length > 30 && (
          <li className="text-fg-muted italic">…{lines.length - 30} more</li>
        )}
      </ul>
    );
  } else {
    body = <div className="text-xs text-fg-muted italic">No matches.</div>;
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <span className="text-fg-muted">Pattern</span>
        <code className="text-fg bg-panel px-1.5 py-0.5 rounded-sm font-mono">{pattern}</code>
        {glob && <Chip>glob: {glob}</Chip>}
        {path && <Chip>in: {basename(path)}/</Chip>}
        <Chip tone="info">{mode}</Chip>
        {lines.length > 0 && <span className="text-fg-muted">{lines.length} result{lines.length === 1 ? '' : 's'}</span>}
      </div>
      {body}
      {tool.error && <ErrorBlock error={tool.error} />}
    </div>
  );
}

function GlobView({ tool }: { tool: ToolCallState }) {
  const pattern = (tool.input.pattern as string) || '';
  const path = tool.input.path as string | undefined;
  const resp = tool.response || '';
  const paths = resp ? resp.split('\n').filter(l => l.trim()) : [];

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <code className="text-fg bg-panel px-1.5 py-0.5 rounded-sm font-mono">{pattern}</code>
        {path && <Chip>in: {basename(path)}/</Chip>}
        {paths.length > 0 && <span className="text-fg-muted">{paths.length} file{paths.length === 1 ? '' : 's'}</span>}
      </div>
      {paths.length > 0 ? (
        <ul className="text-xs font-mono space-y-0.5">
          {paths.slice(0, 30).map((p, i) => (
            <li key={i} className="text-fg-dim">{p}</li>
          ))}
          {paths.length > 30 && (
            <li className="text-fg-muted italic">…{paths.length - 30} more</li>
          )}
        </ul>
      ) : (
        <div className="text-xs text-fg-muted italic">No matches.</div>
      )}
      {tool.error && <ErrorBlock error={tool.error} />}
    </div>
  );
}

// --- WebFetch / WebSearch ---

function WebFetchView({ tool }: { tool: ToolCallState }) {
  const url = (tool.input.url as string) || '';
  const prompt = tool.input.prompt as string | undefined;
  let domain = '';
  try { domain = url ? new URL(url).hostname : ''; } catch { domain = url; }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap text-xs">
        {domain && <Chip tone="info">{domain}</Chip>}
        {url && (
          <a href={url} target="_blank" rel="noopener noreferrer" className="text-link hover:text-link-hover truncate max-w-full">
            {url}
          </a>
        )}
      </div>
      {prompt && <div className="text-xs text-fg-dim italic">“{prompt}”</div>}
      {tool.response && (
        <div className="text-sm text-fg-dim border-t border-edge/60 pt-2">
          <MarkdownContent content={tool.response} />
        </div>
      )}
      {tool.error && <ErrorBlock error={tool.error} />}
    </div>
  );
}

// --- Raw fallback ---

function RawFallbackView({ tool }: { tool: ToolCallState }) {
  // ExitPlanMode renders its plan in a separate bubble — strip to avoid dupe.
  const input = tool.toolName === 'ExitPlanMode'
    ? Object.fromEntries(Object.entries(tool.input).filter(([k]) => k !== 'plan'))
    : tool.input;

  const formatted = Object.entries(input).length
    ? JSON.stringify(input, null, 2).replace(/"([^"\\]*(?:\\.[^"\\]*)*)"/g, (match, str) => {
        if (!str.includes('\\n') && !str.includes('\\"')) return match;
        return '"' + unescapeForDisplay(str) + '"';
      })
    : '';

  return (
    <div className="space-y-2">
      {formatted && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-fg-muted mb-1">Input</div>
          <CollapsibleBlock maxLines={15}>{formatted}</CollapsibleBlock>
        </div>
      )}
      {tool.response && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-fg-muted mb-1">Response</div>
          <CollapsibleBlock maxLines={20}>{tool.response}</CollapsibleBlock>
        </div>
      )}
      {tool.error && <ErrorBlock error={tool.error} />}
    </div>
  );
}

// --- Dispatcher ---

export default function ToolBody({ tool, sessionId }: { tool: ToolCallState; sessionId?: string }) {
  // Look up the per-session task map once per render — memoized on the
  // toolCalls Map reference (preserved across text streaming). Only
  // TaskUpdate consumes this right now, but TaskGet/Stop could later.
  // `Task` (capital T) is the sub-agent launcher and is UNRELATED to the
  // TaskCreate/TaskUpdate agent-lifecycle tools despite the name overlap.
  const chatState = useChatState(sessionId || '');
  const tasksById = useMemo(
    () => buildTasksById(chatState.toolCalls),
    [chatState.toolCalls],
  );

  const inner = (() => {
    switch (tool.toolName) {
      case 'Edit':
        return <EditView tool={tool} />;
      case 'Write':
        return <WriteView tool={tool} />;
      case 'Bash':
        return <ShellView tool={tool} commandField="command" />;
      case 'TodoWrite':
        return <TodoWriteView tool={tool} />;
      case 'TaskCreate':
        return <TaskCreateView tool={tool} />;
      case 'TaskUpdate': {
        const tid = tool.input.taskId as string | undefined;
        return <TaskUpdateView tool={tool} task={tid ? tasksById.get(tid) : undefined} />;
      }
      case 'Read':
        return <ReadView tool={tool} />;
      case 'Agent':
      case 'Task':
        return <AgentView tool={tool} />;
      case 'Grep':
        return <GrepView tool={tool} />;
      case 'Glob':
        return <GlobView tool={tool} />;
      case 'WebFetch':
        return <WebFetchView tool={tool} />;
      default: {
        // MCP PowerShell is shell-like — reuse ShellView. Other MCP tools fall
        // through to the raw view.
        if (tool.toolName === 'mcp__windows-control__PowerShell') {
          return <ShellView tool={tool} commandField="command" />;
        }
        return <RawFallbackView tool={tool} />;
      }
    }
  })();

  return <div className="px-3 pb-3 border-t border-edge pt-2">{inner}</div>;
}
