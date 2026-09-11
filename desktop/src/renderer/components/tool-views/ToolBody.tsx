import React, { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import { ToolCallState, type ShellRunView } from '../../../shared/types';
import { UnifiedDiff } from '../diff/UnifiedDiff';
import MarkdownContent from '../MarkdownContent';
import { useChatState } from '../../state/chat-context';
import { buildTasksById, TASK_LIFECYCLE, TaskState, TaskStatus } from '../../state/task-state';
import { SubagentTimeline } from './SubagentTimeline';
import { ChevronIcon } from '../Icons';
import { useExpandAllToggle, getInitialExpanded, isExpandModeActive } from '../../hooks/useExpandAllToggle';
import { useArtifactOptional } from '../../state/ArtifactContext';
import { ArtifactThumbnail } from '../ArtifactThumbnail';
import { matchSessionArtifact } from '../filepath-match';
import { DeliverablesCard } from '../DeliverablesCard';
import type { ArtifactRecord } from '../../../shared/artifacts/types';
// Chatsearch session cards: same parser ToolCard uses for the header label,
// so the collapsed header and expanded body always agree on what the call is.
import { describeChatsearchCall, COPY } from '../../../shared/chatsearch-refs';
import ChatsearchFindCard from './ChatsearchFindCard';
import ChatsearchShowCard from './ChatsearchShowCard';
// Fix: tool inputs are unknown-typed JSON from the model/provider. Every
// `input.x as string` below was a lie-cast guarded only by truthiness — an
// object survives `|| ''` (objects are truthy) and then crashes basename() /
// string methods / React child rendering, or renders "[object Object]".
// asString (from the PR #295 ToolCard fix) treats non-strings as absent.
import { asString } from '../../utils/tool-input';
// G-1: the running-in-the-background strip and its Stop button.
import { StatusStrip, Button, Tooltip } from '../ui';
import { useSpecialistRunByChild, useSpecialistDefinition } from '../../hooks/useSpecialists';
import { hasNestedAsk } from '../../utils/specialist-cards';
import { SpecialistActions } from '../specialists/SpecialistActions';
import { RunStatusLine } from '../specialists/RunStatusLine';
import { CLAUDE_CODE_LINK_TOOL, SEND_USER_LINK_TOOL } from '../../../shared/send-user-link';

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
          className="mt-1 text-3xs text-fg-muted tracking-wider uppercase hover:text-fg-2"
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
    // data-file-path carries the absolute path so the chat right-click menu can
    // offer View in folder / Copy as path (the DOM otherwise only has display labels).
    <div className="flex items-center gap-1.5 text-2xs font-mono" data-file-path={fp || undefined}>
      {dir && <span className="text-fg-muted">{dir}/</span>}
      <span className="text-fg-2 font-medium">{basename(fp)}</span>
      {extra}
    </div>
  );
}

// Match a tool's absolute file_path to one of the session's tracked artifacts.
// Mirrors FilepathToken's suffix matching: internal artifacts store a
// project-relative path, so the tool's absolute path ends with it.
// Derive the project root for the thumbnail's content fetch by stripping the
// artifact's relative path off the tool's absolute file_path. Only internal
// artifacts can be derived this way; external ones return '' (the thumbnail
// then falls back to its ext-letter glyph — fine, since opening only needs the
// artifact id, which the drawer resolves against its own project root).
function deriveProjectRoot(absPath: string, artifact: ArtifactRecord): string {
  if (artifact.kind !== 'internal') return '';
  const abs = absPath.replace(/\\/g, '/');
  const rel = artifact.path.replace(/\\/g, '/').replace(/^\/+/, '');
  if (abs.endsWith('/' + rel)) return abs.slice(0, abs.length - rel.length - 1);
  if (abs.endsWith(rel)) return abs.slice(0, abs.length - rel.length).replace(/\/+$/, '');
  return '';
}

// M2 preview card for Edit / Write / Read. Replaces the plain PathHeader with a
// clickable card — thumbnail + filename + folder + Open — so the user can open
// the artifact in the session drawer while still seeing how the tool changed it
// (the diff / content renders below). Falls back to the lightweight PathHeader
// when the file isn't a tracked session artifact (e.g. a Read of an untracked
// file): only tracked artifacts can be opened in the drawer, so we don't show a
// misleading Open affordance otherwise.
function ToolFilePreview({ fp, sessionId, chips }: { fp: string; sessionId?: string; chips?: React.ReactNode }) {
  // Optional: the buddy window / sandbox / tests render ToolCard without
  // ArtifactProvider. When absent, sessionArts is undefined → no match → we
  // fall back to the plain PathHeader below (no crash).
  const artifactCtx = useArtifactOptional();
  const sessionArts = artifactCtx?.state.sessionArtifacts;
  const artifact = useMemo(
    () => matchSessionArtifact(sessionArts?.[sessionId ?? ''] ?? [], fp),
    [sessionArts, sessionId, fp],
  );

  if (!artifact) {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <PathHeader fp={fp} />
        {chips}
      </div>
    );
  }

  // For internal artifacts, prefer the project-relative path for the labels so
  // the folder line stays short (e.g. "docs/specs/") instead of the full
  // absolute path. External artifacts use the absolute path as-is.
  const labelPath = artifact.kind === 'internal' ? artifact.path : fp;
  const name = basename(labelPath);
  const dir = parentDir(labelPath);
  const projectRoot = deriveProjectRoot(fp, artifact);

  const open = () => {
    if (!sessionId) return; // per-session drawer needs a session to scope to
    artifactCtx?.dispatch({ type: 'DRAWER_OPENED', sessionId });
    artifactCtx?.dispatch({ type: 'ACTIVE_ARTIFACT_SET', sessionId, artifactId: artifact.id });
  };

  return (
    <div className="space-y-2">
      <Tooltip text={`Open ${name}`}>
      <button
        type="button"
        onClick={open}
        // data-file-path (absolute) lets the chat right-click menu recover the
        // real path for View in folder / Copy as path — left-click still opens
        // the in-app artifact drawer.
        data-file-path={fp || undefined}
        className="group flex items-center gap-3 w-full p-2 rounded-lg bg-inset border border-edge hover:border-fg-muted text-left transition-colors"
      >
        <ArtifactThumbnail
          artifact={artifact}
          projectPath={projectRoot}
          bgClass="bg-canvas"
          className="w-11 h-11 rounded-md border border-edge shrink-0"
        />
        <span className="flex-1 min-w-0">
          <span className="block text-sm-tight font-semibold text-fg truncate">{name}</span>
          {dir && <span className="block text-2xs font-mono text-fg-muted truncate">{dir}/</span>}
        </span>
        <span className="shrink-0 inline-flex items-center gap-1 text-2xs font-semibold text-fg-2 border border-edge group-hover:border-fg-muted rounded-md px-2 py-1 transition-colors">
          Open
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 7h10v10" />
            <path d="M7 17 17 7" />
          </svg>
        </span>
      </button>
      </Tooltip>
      {chips && <div className="flex items-center gap-2 flex-wrap">{chips}</div>}
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
    <span className={`px-1.5 py-px text-3xs uppercase tracking-wider rounded-sm border font-medium ${toneClass}`}>
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
    <Tooltip text="Copy">
    <button
      onClick={handle}
      className="text-3xs text-fg-muted tracking-wider uppercase hover:text-fg-2 px-1 rounded-sm"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
    </Tooltip>
  );
}

function ErrorBlock({ error }: { error: string }) {
  return (
    <div>
      <div className="text-3xs uppercase tracking-wider text-red-500 mb-1">Error</div>
      <pre className="text-xs text-red-400 bg-panel rounded-sm p-2 overflow-auto max-h-48 whitespace-pre-wrap">
        {error}
      </pre>
    </div>
  );
}

// --- Edit / Write ---

// The unified diff renderer (rows, gutter, hunk separators, preview cap) moved
// to components/diff/UnifiedDiff so the artifact-pane conflict view renders the
// SAME diff (spec 2026-07-20 §6); the old hand-rolled LCS fallback is now jsdiff.

function EditView({ tool, sessionId }: { tool: ToolCallState; sessionId?: string }) {
  // Fix: an object file_path crashed basename() in PathHeader; object old/new
  // strings crashed the diff (jsdiff expects strings).
  const fp = asString(tool.input.file_path);
  const oldStr = asString(tool.input.old_string);
  const newStr = asString(tool.input.new_string);
  const replaceAll = tool.input.replace_all as boolean | undefined;

  return (
    <div className="space-y-2">
      <ToolFilePreview
        fp={fp}
        sessionId={sessionId}
        chips={replaceAll ? <Chip tone="warn">Replace all</Chip> : null}
      />
      {(oldStr || newStr) ? (
        <UnifiedDiff oldStr={oldStr} newStr={newStr} structuredPatch={tool.structuredPatch} />
      ) : (
        <div className="text-xs text-fg-muted italic">No change content.</div>
      )}
      {tool.error && <ErrorBlock error={tool.error} />}
    </div>
  );
}

function WriteView({ tool, sessionId }: { tool: ToolCallState; sessionId?: string }) {
  // Fix: an object file_path crashed basename(); an object content crashed .split().
  const fp = asString(tool.input.file_path);
  const content = asString(tool.input.content);
  const lineCount = content ? content.split('\n').length : 0;

  return (
    <div className="space-y-2">
      <ToolFilePreview
        fp={fp}
        sessionId={sessionId}
        chips={
          <>
            <Chip tone="add">New file</Chip>
            {lineCount > 0 && <span className="text-3xs text-fg-muted">{lineCount} lines</span>}
          </>
        }
      />
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
// G-1 (background Bash): a ticking "2m 14s" for a running command, frozen at
// its end time once it exits or is stopped. One interval per running card.
function useElapsed(startedAt: number | undefined, endedAt: number | undefined): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt == null || endedAt != null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt, endedAt]);
  if (startedAt == null) return '';
  const ms = Math.max(0, (endedAt ?? now) - startedAt);
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  // Whole minutes read as "40m", not "40m 0s".
  return h > 0 ? `${h}h ${m}m` : m > 0 ? (sec ? `${m}m ${sec}s` : `${m}m`) : `${sec}s`;
}

// Why a background command stopped, in the user's words. 'assistant' is the
// model calling KillShell; 'user' is the card's own Stop button.
const STOP_REASON: Record<NonNullable<ShellRunView['stopReason']>, string> = {
  user: 'Stopped by you',
  assistant: 'Stopped by the assistant',
  'conversation-closed': 'Stopped when the conversation closed',
  'app-quit': 'Stopped when the app quit',
};

function ShellView({ tool, commandField, sessionId }: {
  tool: ToolCallState;
  commandField: string;
  sessionId?: string;
}) {
  // Fix: an object command rendered as a React child crashed the card.
  const cmd = asString(tool.input[commandField]);
  // G-1: the run record is the truth for a background command — the tool
  // result of a background start is only the launch acknowledgment.
  const run = tool.shellRun;
  const bg = run != null || (tool.input.run_in_background as boolean | undefined);
  const response = tool.response ? stripCarriageReturns(tool.response) : '';
  const failed = tool.status === 'failed' || (run?.status === 'exited' && run.exitCode !== 0);
  // A rebuilt record (app quit) has no start time — show no timer rather than "0s".
  const elapsed = useElapsed(run?.startedAt || undefined, run?.endedAt);
  const [stopping, setStopping] = useState(false);
  const stop = useCallback(async () => {
    if (!run || !sessionId) return;
    setStopping(true);
    try {
      const r = await window.claude.native.killShell(sessionId, run.shellId);
      // A refusal (already ended, unknown id) must not leave "Stopping…" up forever.
      if (!r.ok) setStopping(false);
    } catch (err) { console.error('KillShell failed:', err); setStopping(false); }
  }, [run, sessionId]);

  // Description is already shown as the collapsed-header label (see
  // friendlyToolDisplay in ToolCard.tsx); don't repeat it in the expanded body.
  // Status chips (Background / Failed) sit above the command so they don't
  // squeeze the code block horizontally. "Done" was dropped — the header
  // status icon already covers success. Copy button is absolutely positioned
  // inside the code block's top-right corner (visible on hover).
  const chips: React.ReactNode[] = [];
  // G-1: while the command runs, the status strip below carries the state, so
  // the chip row only speaks once it has ended. "Exit N · 3m 12s" says how it
  // ended; a stopped run names who stopped it.
  if (bg && run?.status !== 'running') chips.push(<Chip key="bg" tone="info">{run?.detached ? 'Moved to background at its time limit' : 'Background'}</Chip>);
  if (run?.status === 'exited') {
    chips.push(<Chip key="exit" tone={run.exitCode === 0 ? 'add' : 'remove'}>Exit {run.exitCode ?? '?'}{elapsed ? ` · ${elapsed}` : ''}</Chip>);
  } else if (run?.status === 'stopped') {
    chips.push(<Chip key="stopped" tone="warn">{STOP_REASON[run.stopReason ?? 'user']}{elapsed ? ` · after ${elapsed}` : ''}</Chip>);
  } else if (failed) chips.push(<Chip key="failed" tone="remove">Failed</Chip>);
  // The output shown is the run's own tail once a run record exists (it keeps
  // growing while the command runs); the tool result only for foreground calls.
  const output = run ? run.tail : response;

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
      {run?.status === 'running' && (
        // G-1: the state in motion and the one action that resolves it. Stop
        // ends the command AND everything it launched (process family), so a
        // stopped `npm run dev` never leaves the real server behind.
        <StatusStrip
          tone="busy"
          detail={run.detached ? 'Hit its time limit and kept running in the background — you\'ll be told when it finishes.' : 'The assistant carries on meanwhile and is told when it finishes.'}
          action={<Button size="sm" variant="danger-outline" disabled={stopping} onClick={stop}>{stopping ? 'Stopping…' : 'Stop'}</Button>}
        >
          Running in the background{elapsed ? ` · ${elapsed}` : ''}
        </StatusStrip>
      )}
      {output && (
        <div>
          <div className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-1">{run?.status === 'running' ? 'Live output' : 'Output'}</div>
          <CollapsibleBlock maxLines={20} className="bg-canvas">{output}</CollapsibleBlock>
        </div>
      )}
      {run?.logPath && (
        // The full log outlives the card's tail; the path is the model's and the
        // user's way back to all of it. Empty on a record rebuilt after a
        // restart — nothing honest to show, so the line is dropped.
        <div className="text-3xs text-fg-muted font-mono truncate" title={run.logPath}>Full log: {run.logPath}</div>
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
  // Fix: a non-array todos crashed .map() (an object survives `|| []` — it's truthy).
  const todos = Array.isArray(tool.input.todos) ? (tool.input.todos as TodoItem[]) : [];
  if (todos.length === 0) {
    return <div className="text-xs text-fg-muted italic">No todos.</div>;
  }
  return (
    <ul className="space-y-1">
      {todos.map((t, i) => {
        const inProg = t.status === 'in_progress';
        const done = t.status === 'completed';
        // Fix: an object content/activeForm rendered as a React child crashed
        // the card — coerce both; an object activeForm falls back to content.
        const activeForm = asString(t.activeForm);
        const label = inProg && activeForm ? activeForm : asString(t.content);
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
  // Fix: object subject/body/priority rendered as React children crashed the card.
  const subject = asString(tool.input.subject);
  const body = asString(tool.input.body);
  const priority = asString(tool.input.priority);
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
    <div className="flex items-center gap-1 text-3xs uppercase tracking-wider">
      {TASK_LIFECYCLE.map((s, i) => {
        const done = i < currentIdx;
        const active = i === currentIdx;
        return (
          <React.Fragment key={s}>
            <span className={
              active ? 'text-fg font-bold'
              : done ? 'text-fg-muted'
              : 'text-fg-muted'
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
  // Fix: an object taskId rendered "#[object Object]"; an object status crashed
  // .replace() / the lifecycle pill; and the `?? task?.x` fallbacks only catch
  // nullish, so object subject/description/priority sailed through to React
  // children. asString + `||` treats non-strings (and '') as absent instead.
  const taskId = asString(tool.input.taskId);
  const newStatus = typeof tool.input.status === 'string' ? (tool.input.status as TaskStatus) : undefined;
  const subject = asString(tool.input.subject) || task?.subject;
  const description = asString(tool.input.description) || task?.description;
  const priority = asString(tool.input.priority) || task?.priority;

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
        <div className="text-3xs text-fg-muted">
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

function ReadView({ tool, sessionId }: { tool: ToolCallState; sessionId?: string }) {
  // Fix: an object file_path crashed basename(); non-number offset/limit
  // interpolated as "lines [object Object]–NaN". typeof (never truthiness) so a
  // legitimate offset of 0 survives.
  const fp = asString(tool.input.file_path);
  const offset = typeof tool.input.offset === 'number' ? tool.input.offset : undefined;
  const limit = typeof tool.input.limit === 'number' ? tool.input.limit : undefined;
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
      <ToolFilePreview
        fp={fp}
        sessionId={sessionId}
        chips={rangeLabel ? <Chip>{rangeLabel}</Chip> : null}
      />
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
              className="text-3xs text-fg-muted tracking-wider uppercase hover:text-fg-2"
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

function AgentView({ tool, sessionId }: { tool: ToolCallState; sessionId?: string }) {
  // Fix: object description/subagent_type rendered as React children crashed
  // the card; MarkdownContent requires a string prompt.
  const desc = asString(tool.input.description);
  // `subagent_type` is Claude Code's Agent-tool arg; `agent` is the native
  // harness Task tool's (tools/task.ts). Both render the same card (see the
  // 'Agent'/'Task' cases below), so read whichever this call carries — without
  // the second name a native `explorer` specialist rendered a chip that said
  // "general-purpose", which is a wrong label, not just a missing one.
  const subagent = asString(tool.input.subagent_type) || asString(tool.input.agent) || 'general-purpose';

  // Specialists 1c — a native Task card knows more than a CC Agent card: its
  // run record (title, real status, background flag, model), the roster entry
  // for its consent block, and — for a `task_id` call — the OTHER child it
  // names. Everything below that reads `run`/`isNative` is 1c; the CC path
  // is unchanged.
  const isNative = tool.toolName === 'Task';
  const run = isNative ? tool.specialistRun : undefined;
  const taskId = isNative ? asString(tool.input.task_id) : '';
  const target = useSpecialistRunByChild(sessionId, taskId || undefined);
  // Task 10: same per-cwd lookup ToolCard/TaskConsentBlock use — a project's
  // OWN specialists only resolve here if this card's session cwd is passed.
  const artifacts = useArtifactOptional();
  const cwd = sessionId ? artifacts?.state.sessionCwd?.[sessionId] : undefined;
  const definition = useSpecialistDefinition(cwd, isNative ? subagent : undefined);
  const title = run?.title;
  const tone = SUBAGENT_TONE[subagent] || 'neutral';
  const charter = definition?.charter;
  // The consent envelope for an awaiting Task call renders in ToolCard (above
  // the buttons, visible without expanding) — not here, or it would double.
  const awaiting = tool.status === 'awaiting-approval';

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <Chip tone={tone}>{subagent}</Chip>
        {title && <span className="text-xs font-medium text-fg-2">{title}</span>}
        {!title && taskId && target?.title && <span className="text-xs font-medium text-fg-2">{target.title}</span>}
        {charter && !taskId && (
          <Chip tone={charter === 'read-write' ? 'warn' : 'info'}>
            {charter === 'read-write' ? 'can edit & run commands' : 'read-only'}
          </Chip>
        )}
        {run?.model && (
          <span className="text-4xs text-fg-muted" title={run.model.via === 'parent' ? "This conversation's model" : run.model.via === 'named' ? 'A model the assistant named' : `The ${run.model.via} model from Settings`}>
            on {run.model.label}{run.model.fallback ? ' (fallback)' : ''}
          </span>
        )}
        {desc && !title && <span className="text-xs font-medium text-fg-2">{desc}</span>}
      </div>
      {desc && title && <div className="text-xs text-fg-dim">{desc}</div>}
      {run && <RunStatusLine run={run} report={tool.specialistReport} />}
      <AgentSections tool={tool} sessionId={sessionId} targetTitle={target?.title}>
        {run && run.status === 'running' && !awaiting && sessionId && (
          <SpecialistActions sessionId={sessionId} run={run} />
        )}
      </AgentSections>
      {tool.error && <ErrorBlock error={tool.error} />}
    </div>
  );
}

/**
 * The three collapsible sections of an Agent/Task card — Briefing, Activity,
 * Report — as ONE component, so the specialists popup (SpecialistsChip) shows
 * a helper's work with exactly the chat card's rendering instead of a second
 * summary of it that could drift (Destin, 1c round 9). `children` slots
 * between Activity and Report (the chat card puts Send-a-note / Stop there).
 * `suppressAsk` hides the Yes/No buttons inside Activity where the host
 * already shows the ask elsewhere (the popup's amber band).
 */
export function AgentSections({ tool, sessionId, targetTitle, suppressAsk = false, accordion = false, children }: {
  tool: ToolCallState;
  sessionId?: string;
  /** For a task_id call: the other child's title (first name feeds the ask/note copy). */
  targetTitle?: string;
  suppressAsk?: boolean;
  /** Popup mode (Destin, round 10): every section starts COLLAPSED and at most
   *  one is open at a time. The chat card keeps its own behaviour (Activity
   *  open while running, Report open when it lands, Ctrl+O expand-all). */
  accordion?: boolean;
  children?: React.ReactNode;
}) {
  const prompt = asString(tool.input.prompt);
  const segments = tool.subagentSegments || [];
  const isNative = tool.toolName === 'Task';
  const run = isNative ? tool.specialistRun : undefined;
  const taskId = isNative ? asString(tool.input.task_id) : '';
  const title = run?.title;
  const firstName = title ? title.split(' ')[0] : (targetTitle ? targetTitle.split(' ')[0] : undefined);
  // "Settled" is what auto-collapses Activity. For a background hire the tool
  // result is only the launch ack, so keying on `response` collapsed a card
  // whose child was still streaming (Test 4) — the run record is the truth.
  const settled = run ? run.status !== 'running' : !!tool.response;

  // Auto-expand the activity section while running; auto-collapse once
  // settled. User toggles stick for the rest of the session.
  const [showTimeline, setShowTimeline] = useState(() => getInitialExpanded(!settled));
  // Start userToggled=true when the shortcut is already in effect so the
  // auto-collapse-on-settle effect below doesn't fight the user's intent.
  const [userToggled, setUserToggled] = useState(() => isExpandModeActive());
  const prevSettled = useRef(settled);
  useEffect(() => {
    if (userToggled) return;
    if (!prevSettled.current && settled) setShowTimeline(false);
    prevSettled.current = settled;
  }, [settled, userToggled]);
  // Specialists 1c: a helper's ask lives in Activity — open it when one
  // arrives, even on a settled card (a held ask outlives the run). Not when
  // the host shows the ask itself (suppressAsk): then Activity is just history.
  const nestedAsk = hasNestedAsk(tool);
  useEffect(() => { if (nestedAsk && !suppressAsk) setShowTimeline(true); }, [nestedAsk, suppressAsk]);
  // Ctrl+O: mark userToggled so the auto-collapse effect doesn't fight the
  // shortcut back closed as soon as the subagent completes.
  useExpandAllToggle(
    () => { setShowTimeline(true); setUserToggled(true); },
    () => { setShowTimeline(false); setUserToggled(true); },
  );

  // The report section. Foreground: the tool result IS the report. Background:
  // the delivered report folded into this card (specialistReport). A task_id
  // call's result is the management outcome ("Steer delivered…") — a Response.
  const report = tool.specialistReport
    ? { title: tool.specialistReport.status === 'failed' ? 'Report — failed' : 'Report', text: displayReport(tool.specialistReport.text) }
    : tool.response && !taskId && (run ? run.background === false : isNative)
      ? { title: 'Report', text: displayReport(tool.response) }
      : tool.response
        ? { title: 'Response', text: tool.response }
        : null;
  // A background hire's launch ack is not worth a section: the header + status
  // line already say "working in the background". Hide it while the report is
  // pending; the folded report replaces it.
  const hideLaunchAck = !!run && run.background && !tool.specialistReport && !!tool.response
    && /is now working in the background/.test(tool.response);

  // Accordion (popup) state: which ONE section is open, if any.
  const [openOne, setOpenOne] = useState<'briefing' | 'activity' | 'report' | null>(null);
  const acc = (key: 'briefing' | 'activity' | 'report') => accordion
    ? { open: openOne === key, onToggle: () => setOpenOne(o => (o === key ? null : key)) }
    : {};

  return (
    <>
      {prompt && (
        <AgentSection title={taskId ? 'Message' : 'Briefing'} defaultOpen={false} {...acc('briefing')}>
          <div className="text-sm text-fg-dim">
            <MarkdownContent content={prompt} />
          </div>
        </AgentSection>
      )}
      {segments.length > 0 && (
        <AgentSection
          title={`Activity (${segments.length})`}
          {...(accordion
            ? acc('activity')
            : { open: showTimeline, onToggle: () => { setShowTimeline(s => !s); setUserToggled(true); } })}
        >
          {/* Task 12: `run` (specialistRun) is already resolved above for this
              card — its status is what lets a nested held ask tell a finished
              helper apart from a running one. */}
          <SubagentTimeline segments={segments} sessionId={sessionId} specialistName={firstName} suppressAsk={suppressAsk} runStatus={run?.status} />
        </AgentSection>
      )}
      {children}
      {report && !hideLaunchAck && (
        <AgentSection title={report.title} defaultOpen={true} {...acc('report')}>
          <div className="text-sm text-fg-dim">
            <MarkdownContent content={report.text} />
          </div>
        </AgentSection>
      )}
    </>
  );
}

// What the Report section shows. The text the MODEL reads carries framing
// the card header already states — the injected "[Background specialist
// finished] Kai (explorer) completed …" sentence, the "## Report from Kai
// (explorer)" heading, and the trailing "[specialist session <id>]" tag — so
// the section starts at the report body itself. Display-only: the model's
// copy is untouched.
function displayReport(text: string): string {
  let t = text;
  if (/^\[Background specialist/.test(t)) {
    const idx = t.indexOf('\n\n');
    t = idx === -1 ? t : t.slice(idx + 2);
  }
  t = t.replace(/^## Report from [^\n]*\n+/, '');
  t = t.replace(/\n*\[specialist session [^\]]+\]\s*$/, '');
  return t;
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
  // Fix: an object pattern/glob/mode rendered as a React child crashed the
  // card; an object path crashed basename().
  const pattern = asString(tool.input.pattern);
  const mode = asString(tool.input.output_mode) || 'files_with_matches';
  const glob = asString(tool.input.glob);
  const path = asString(tool.input.path);
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
  // Fix: same hardening as GrepView — object pattern crashed React child
  // rendering; object path crashed basename().
  const pattern = asString(tool.input.pattern);
  const path = asString(tool.input.path);
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
  // Fix: an object url threw in new URL(), and the catch branch then set
  // domain = url — an object React child, which crashed the card anyway.
  const url = asString(tool.input.url);
  const prompt = asString(tool.input.prompt);
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

// WebSearch results are a markdown string (native + CC both) — render like
// WebFetchView rather than the raw JSON fallback so the card stays readable.
function WebSearchView({ tool }: { tool: ToolCallState }) {
  // Fix: an object query rendered as a React child crashed the card.
  const query = asString(tool.input.query);
  return (
    <div className="space-y-2">
      {query && <div className="text-xs text-fg-dim italic">“{query}”</div>}
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
          <div className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-1">Input</div>
          <CollapsibleBlock maxLines={15}>{formatted}</CollapsibleBlock>
        </div>
      )}
      {tool.response && (
        <div>
          <div className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-1">Response</div>
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
  // Fix: this must sit above the `inner` IIFE's switch, not inside the Bash
  // case — hooks are unconditional, and the case only runs when toolName is
  // 'Bash'. Sticky per card: once resolve reports Android/IPC unavailable we
  // never retry the card view for this tool call, we just show plain Bash.
  const [chatsearchUnavailable, setChatsearchUnavailable] = useState(false);

  const inner = (() => {
    // No arguments exist yet — every view below would render an empty shell.
    if (tool.preparing) {
      return (
        <div className="px-3 py-2 text-xs text-fg-muted">
          {`Still preparing tool call… ${(tool.preparingChars ?? 0).toLocaleString()} characters so far`}
        </div>
      );
    }
    switch (tool.toolName) {
      case 'Edit':
        return <EditView tool={tool} sessionId={sessionId} />;
      case 'Write':
        return <WriteView tool={tool} sessionId={sessionId} />;
      case 'Bash': {
        // chatsearch calls render as session cards; anything else — and any
        // chatsearch call whose output can't be parsed, was piped, or was
        // truncated — stays the plain shell view. Android answers resolve with
        // not-implemented; the card reports that back and we swap to shell.
        const cs = describeChatsearchCall(tool);
        if (cs && !chatsearchUnavailable) {
          return (
            <div className="space-y-2">
              {cs.cmd === 'find'
                ? <ChatsearchFindCard shortIds={cs.shortIds} onUnavailable={() => setChatsearchUnavailable(true)} />
                : <ChatsearchShowCard id={cs.id} provider={cs.provider} onUnavailable={() => setChatsearchUnavailable(true)} />}
              {/* Destin (2026-08-27 gate, M-row): the "Raw output" disclosure is
                  gone — it hid the CLI's own text behind a click nobody made.
                  In its place, one quiet line saying what Claude actually asked
                  for. A find whose query cannot be read prints nothing at all
                  rather than inventing a search term. */}
              {cs.cmd === 'find'
                ? cs.query ? <div className="px-1 text-3xs text-fg-muted">{COPY.searchedFor(cs.query)}</div> : null
                : <div className="px-1 text-3xs text-fg-muted">{COPY.readConversation}</div>}
            </div>
          );
        }
        return <ShellView tool={tool} commandField="command" sessionId={sessionId} />;
      }
      case 'TodoWrite':
        return <TodoWriteView tool={tool} />;
      case 'TaskCreate':
        return <TaskCreateView tool={tool} />;
      case 'TaskUpdate': {
        // Fix: asString so a non-string taskId can't reach the task map lookup.
        const tid = asString(tool.input.taskId);
        return <TaskUpdateView tool={tool} task={tid ? tasksById.get(tid) : undefined} />;
      }
      case 'Read':
        return <ReadView tool={tool} sessionId={sessionId} />;
      // 'Agent' is Claude Code's subagent launcher; 'Task' is the native
      // harness's (tools/task.ts). The subagent card is selected by toolName,
      // so WITHOUT the 'Task' case the stamped child events would accumulate in
      // reducer state (applySubagentEvent fills subagentSegments regardless) and
      // the timeline would still show a raw JSON card. Pinned by
      // tests/task-subagent-card.test.tsx.
      case 'Agent':
      case 'Task':
        return <AgentView tool={tool} sessionId={sessionId} />;
      case 'Grep':
        return <GrepView tool={tool} />;
      case 'Glob':
        return <GlobView tool={tool} />;
      case 'WebFetch':
        return <WebFetchView tool={tool} />;
      case 'WebSearch':
        return <WebSearchView tool={tool} />;
      // SendUserFile/SendUserLink normally render as the in-bubble
      // DeliverablesCard (pulled out of their tool group by
      // AssistantTurnBubble). This case covers the places that still render a
      // bare ToolCard for them — the tool gallery, the buddy window's strip —
      // so they never fall to the raw JSON view.
      case 'SendUserFile':
      case SEND_USER_LINK_TOOL:
      case CLAUDE_CODE_LINK_TOOL:
        return <DeliverablesCard tools={[tool]} sessionId={sessionId ?? ''} />;
      default: {
        // MCP PowerShell is shell-like — reuse ShellView. Other MCP tools fall
        // through to the raw view.
        if (tool.toolName === 'mcp__windows-control__PowerShell') {
          return <ShellView tool={tool} commandField="command" sessionId={sessionId} />;
        }
        return <RawFallbackView tool={tool} />;
      }
    }
  })();

  return <div className="px-3 pb-3 border-t border-edge pt-2">{inner}</div>;
}
