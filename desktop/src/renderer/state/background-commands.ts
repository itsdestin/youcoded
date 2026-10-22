// The per-session list of background COMMANDS (2026-10-22 status audit) — what
// the "Background" status-bar chip reads. One record per command or watcher,
// independent of whether the card that launched it is loaded: the cards are
// paged in and out, but a command a person started is still running (or failed)
// whether or not its card is on screen.
//
// Helpers (Claude Code Agent / native Task) are NOT here — they have the
// Subagents chip. A helper's OWN background commands are, marked `ownerHelper`.
//
// Perf (rule 3/4): the list lives in SessionChatState.backgroundCommands as a
// plain record that is replaced ONLY when a launch or an end lands — never per
// streamed word, never for a shell's tail update — and every function here hands
// back the SAME object when nothing changed, so a selector can compare by identity.
import type { ShellRunView, ToolCallState } from '../../shared/types';
import type { SessionChatState } from './chat-types';
import { shellEndKind, shellFacts } from './native-run-facts';

type BackgroundCommandStatus = 'running' | 'completed' | 'failed' | 'stopped';

export interface BackgroundCommand {
  /** Stable for the life of the command: `<provider>:<launching toolUseId>`. */
  id: string;
  provider: 'claude-code' | 'native';
  /** 'watcher' = a Claude Code Monitor (it reports events, it is not a one-shot job). */
  kind: 'command' | 'watcher';
  /** The launching tool call (the card that shows it, when loaded). */
  toolUseId: string;
  /** Claude Code's task id — what a notice or TaskStop names. */
  taskId?: string;
  /** Native only: the shell id Stop needs (native:kill-shell). */
  shellId?: string;
  /** What a person reads: the call's description, else the command (shortened). */
  label: string;
  /** The full command text, when known. */
  command?: string;
  status: BackgroundCommandStatus;
  exitCode?: number;
  /** Native: why it stopped ('user' | 'app-quit' | …). */
  stopReason?: string;
  /** Native: the signal that ended it, when main reports one. */
  signal?: string;
  /** Claude Code's one-line account of how it ended. */
  summary?: string;
  startedAt?: number;
  endedAt?: number;
  /** A Monitor started `persistent`: it runs until stopped or the session exits,
   *  with no timeout of its own (audit C5). */
  persistent?: boolean;
  /** Native: the record was restored from disk after a restart (output no longer streams). */
  restored?: boolean;
  /** Native: it ended while the app was not watching, so its exit code is unknown. */
  exitUnknown?: boolean;
  /** Native, with exitUnknown: the process may still be alive. Stop is NOT possible. */
  maybeStillRunning?: boolean;
  /** Native: shown from disk for a conversation not live here — no Stop (review F1). */
  viewOnly?: boolean;
  /** Set when the command belongs to a helper rather than to the conversation itself. */
  ownerHelper?: { toolUseId: string; agentId?: string };
}

export type BackgroundCommands = Record<string, BackgroundCommand>;

const MAX_LABEL = 80;

/** "Dev server" (the call's own description) or the command's first line, shortened. */
function commandLabel(input: Record<string, unknown> | undefined, fallback = 'Background command'): string {
  const desc = typeof input?.description === 'string' ? input.description.trim() : '';
  const cmd = typeof input?.command === 'string' ? input.command.trim() : '';
  const text = desc || cmd.split('\n')[0] || fallback;
  return text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL - 1)}…` : text;
}

/** Merge `patch` into the record under `c.id` (creating it). Undefined patch
 *  fields never erase a known value. Returns the SAME object when nothing changed. */
export function putCommand(cmds: BackgroundCommands, c: BackgroundCommand): BackgroundCommands {
  const prev = cmds[c.id];
  const merged: BackgroundCommand = { ...(prev ?? {}), ...c };
  for (const k of Object.keys(c) as Array<keyof BackgroundCommand>) {
    if (c[k] === undefined && prev && prev[k] !== undefined) (merged as any)[k] = prev[k];
  }
  // A run that already ended is not revived by a late "launch" (a repeated receipt, a re-sent run record).
  // Native records are the host's own state and always win (a restored record legitimately
  // replaces the "stopped when the app quit" stand-in); only Claude Code's launch receipts can repeat.
  if (prev && c.provider === 'claude-code' && prev.status !== 'running' && c.status === 'running') {
    merged.status = prev.status;
    merged.exitCode = prev.exitCode;
    merged.endedAt = prev.endedAt;
    merged.stopReason = prev.stopReason;
    merged.summary = prev.summary;
  }
  if (prev) {
    const keys = new Set([...Object.keys(prev), ...Object.keys(merged)]) as Set<keyof BackgroundCommand>;
    let same = true;
    for (const k of keys) {
      if (k === 'ownerHelper') { if (JSON.stringify(prev.ownerHelper) !== JSON.stringify(merged.ownerHelper)) same = false; }
      else if (prev[k] !== merged[k]) same = false;
      if (!same) break;
    }
    if (same) return cmds;
  }
  return { ...cmds, [c.id]: merged };
}

export interface CommandEnd {
  status: Exclude<BackgroundCommandStatus, 'running'>;
  exitCode?: number;
  summary?: string;
  stopReason?: string;
  endedAt?: number;
}

/** Ends every STILL-RUNNING command `which` selects. An end already recorded is
 *  kept: the first end is the true one (a notice re-read from another line, or a
 *  TaskStop after the command finished, must not rewrite it). SAME object when
 *  nothing changed. */
export function settleCommands(cmds: BackgroundCommands, which: (c: BackgroundCommand) => boolean, end: CommandEnd): BackgroundCommands {
  let out = cmds;
  for (const c of Object.values(cmds)) {
    if (c.status !== 'running' || !which(c)) continue;
    if (out === cmds) out = { ...cmds };
    out[c.id] = {
      ...c, status: end.status,
      ...(end.exitCode !== undefined ? { exitCode: end.exitCode } : {}),
      ...(end.summary ? { summary: end.summary } : {}),
      ...(end.stopReason ? { stopReason: end.stopReason } : {}),
      ...(end.endedAt ? { endedAt: end.endedAt } : {}),
    };
  }
  return out;
}

/** The record a Claude Code launch receipt starts (Bash background / auto-backgrounded / Monitor). */
export function ccCommandFromLaunch(args: {
  toolUseId: string; toolName: string; input: Record<string, unknown>; taskId: string;
  persistent?: boolean; startedAt?: number; owner?: { toolUseId: string; agentId?: string };
}): BackgroundCommand {
  const watcher = args.toolName === 'Monitor';
  const cmd = typeof args.input.command === 'string' ? args.input.command : undefined;
  return {
    id: `claude-code:${args.toolUseId}`, provider: 'claude-code', kind: watcher ? 'watcher' : 'command',
    toolUseId: args.toolUseId, taskId: args.taskId,
    label: commandLabel(args.input, watcher ? 'Watcher' : 'Background command'),
    ...(cmd ? { command: cmd } : {}),
    status: 'running',
    ...(args.startedAt ? { startedAt: args.startedAt } : {}),
    ...(args.persistent ? { persistent: true } : {}),
    ...(args.owner ? { ownerHelper: args.owner } : {}),
  };
}

/** The record for a native shell run. `card` (the Bash card, when loaded) supplies
 *  the label and command text; main's own `command` / `description` (additive
 *  fields on ShellRunView, owned by the native-engine work) win when present, so a
 *  run whose card is not on screen still has a name. */
export function nativeCommandFromRun(run: ShellRunView, card?: ToolCallState): BackgroundCommand {
  // `command` / `description` / `signal` / `restored` / `exitUnknown` / `maybeStillRunning` are the
  // native engine's additive fields (native-run-facts.ts).
  const extra = shellFacts(run);
  const input = { ...(card?.input ?? {}), ...(extra.command ? { command: extra.command } : {}), ...(extra.description ? { description: extra.description } : {}) };
  const command = typeof input.command === 'string' ? input.command : undefined;
  return {
    id: `native:${run.toolUseId}`, provider: 'native', kind: 'command', toolUseId: run.toolUseId, shellId: run.shellId,
    label: commandLabel(input), ...(command ? { command } : {}),
    status: shellEndKind(run),
    ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
    ...(run.stopReason ? { stopReason: run.stopReason } : {}),
    ...(extra.signal ? { signal: extra.signal } : {}),
    ...(extra.restored ? { restored: true } : {}),
    ...(extra.exitUnknown ? { exitUnknown: true } : {}),
    ...(extra.maybeStillRunning ? { maybeStillRunning: true } : {}),
    ...(run.viewOnly ? { viewOnly: true } : {}),
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    ...(run.endedAt ? { endedAt: run.endedAt } : {}),
  };
}

// ── The cached selector ────────────────────────────────────────────────────────
// useSyncExternalStore compares snapshots by identity, so the array is built ONCE
// per record object and handed back until a launch or an end replaces the record.
const listCache = new WeakMap<BackgroundCommands, BackgroundCommand[]>();

/** The session's background commands, oldest launch first. Same array until something changes. */
export function backgroundCommandList(session: Pick<SessionChatState, 'backgroundCommands'>): BackgroundCommand[] {
  const rec = session.backgroundCommands;
  let list = listCache.get(rec);
  if (!list) { list = Object.values(rec); listCache.set(rec, list); }
  return list;
}

export interface BackgroundCommandCounts { running: number; completed: number; failed: number; stopped: number; total: number }

export function summarizeBackgroundCommands(list: BackgroundCommand[]): BackgroundCommandCounts {
  const n: BackgroundCommandCounts = { running: 0, completed: 0, failed: 0, stopped: 0, total: list.length };
  for (const c of list) n[c.status]++;
  return n;
}
