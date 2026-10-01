// Scripted sessions for the "one way to fill any window" equivalence gate (one-core R5-2).
//
// WHY this exists: before R5-2 a phone, a torn-off window and a reconnecting phone each caught up through different
// machinery (a snapshot of one window's reducer, a page plus a live-state replay, a 10,000-event hook replay). The gate
// is that a screen filled through the ONE new path shows what the old paths showed. So each scenario here is a whole
// session, scripted once, that both generations of the machinery can be driven from:
//   - the LIVE ground truth: what a window that watched the session from the start shows (the old phone's snapshot is a
//     copy of exactly this);
//   - the DISK: what the transcript on the computer holds (a real Claude Code JSONL file, or a native session written
//     through the real SessionStore with its delta coalescing), which a page is read from;
//   - the MEMORY ONLY state: asks waiting for an answer, a native turn's unflushed text.
//
// Nothing in a scenario is a timestamp or a generated id: `screenOf` reduces a chat state to the words and statuses a
// person would read, so two runs compare equal when the screens do.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { chatReducer } from '../../src/renderer/state/chat-reducer';
import type { ChatAction, ChatState } from '../../src/renderer/state/chat-types';
import { eventToAction } from '../../src/renderer/state/transcript-event-actions';
import { hookEventToAction } from '../../src/renderer/state/hook-dispatcher';
import { parseTranscriptLine } from '../../src/main/transcript-watcher';
import { readTranscriptPage } from '../../src/main/transcript-page';
import { NativeHome } from '../../src/main/native-home';
import { SessionStore } from '../../src/main/harness/session-store';
import type { HookEvent, TranscriptEvent, TranscriptPageResult } from '../../src/shared/types';
import { ev } from './transcript-events';

export const SID = 's1';
export type Kind = 'cc' | 'native';

// --- steps -----------------------------------------------------------------------------------------------------------
export type Step =
  /** A transcript event reaches the screens (and, for native, the disk through the store). */
  | { t: TranscriptEvent }
  /** A Claude Code transcript line is appended to the file; the watcher then emits its events. */
  | { line: Record<string, unknown> }
  /** A hook event (an ask raised, answered, expired). Memory-only: no transcript records it. */
  | { hook: HookEvent }
  /** `claude --resume` spawned here: everything above is history the new process never ran. */
  | { resumeBoundary: true }
  /** A renderer-only action the typing screen takes (never reaches the record or the disk). */
  | { local: ChatAction };

export interface Scenario {
  name: string;
  kind: Kind;
  steps: Step[];
  /** Native only: steps AFTER the last one that is flushed to disk, i.e. an open part still streaming. */
  note?: string;
}

let n = 0;
const uid = (p = 'u') => `${p}${++n}`;
const hook = (type: string, id: string, extra: Record<string, unknown> = {}): HookEvent =>
  ({ type, sessionId: SID, payload: { _requestId: id, ...extra }, timestamp: 1 } as unknown as HookEvent);

// --- Claude Code line builders ---------------------------------------------------------------------------------------
let ts = 1_700_000_000_000;
const stamp = () => new Date((ts += 1000)).toISOString();
const ccUser = (text: string) => ({ type: 'user', uuid: uid('cu'), promptId: uid('p'), isMeta: false, timestamp: stamp(), message: { role: 'user', content: text } });
const ccText = (text: string, stop: string | null = 'end_turn') => ({ type: 'assistant', uuid: uid('ca'), timestamp: stamp(), message: { role: 'assistant', model: 'claude-test', stop_reason: stop, content: [{ type: 'text', text }] } });
const ccToolUse = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'assistant', uuid: uid('ct'), timestamp: stamp(), message: { role: 'assistant', model: 'claude-test', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] } });
const ccToolResult = (id: string, text: string) => ({ type: 'user', uuid: uid('cr'), promptId: uid('p'), timestamp: stamp(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: false }] } });
const ccCompact = (summary: string) => ({ type: 'user', uuid: uid('cc'), isCompactSummary: true, timestamp: stamp(), message: { role: 'user', content: summary } });

const T = (type: any, data: any, over: Record<string, unknown> = {}) => ev(type, data, { uuid: uid('n'), sessionId: SID, timestamp: ++ts, ...over } as any) as TranscriptEvent;

export const SCENARIOS: Scenario[] = [
  {
    name: 'cc: two plain turns',
    kind: 'cc',
    steps: [
      { line: ccUser('hello') }, { line: ccText('hi there') },
      { line: ccUser('what is 2+2') }, { line: ccText('four') },
    ],
  },
  {
    name: 'cc: tool run, an ask raised before anyone connected, still open',
    kind: 'cc',
    steps: [
      { line: ccUser('list the files') }, { line: ccText('Looking.', 'tool_use') },
      { line: ccToolUse('tool-1', 'Bash', { command: 'ls' }) },
      { hook: hook('PermissionRequest', 'cc-ask-1', { tool_name: 'Bash', tool_input: { command: 'ls' } }) },
    ],
  },
  {
    name: 'cc: an ask answered on the computer, tool finished, turn over',
    kind: 'cc',
    steps: [
      { line: ccUser('list the files') }, { line: ccToolUse('tool-1', 'Bash', { command: 'ls' }) },
      { hook: hook('PermissionRequest', 'cc-ask-1', { tool_name: 'Bash', tool_input: { command: 'ls' } }) },
      { hook: hook('PermissionResolved', 'cc-ask-1') },
      { line: ccToolResult('tool-1', 'a.txt') }, { line: ccText('There is one file.') },
    ],
  },
  {
    name: 'cc: compaction in the middle',
    kind: 'cc',
    steps: [
      { line: ccUser('first question') }, { line: ccText('first answer') },
      { line: ccUser('/compact') }, { line: ccCompact('Summary of the conversation so far.') },
      { line: ccUser('after compaction') }, { line: ccText('still here') },
    ],
  },
  {
    name: 'cc: resumed session (a tool left running by the old process) with new work after',
    kind: 'cc',
    steps: [
      { line: ccUser('start a build') }, { line: ccToolUse('old-tool', 'Bash', { command: 'make' }) },
      { resumeBoundary: true },
      { line: ccUser('are you still there') }, { line: ccText('Yes, I am back.') },
    ],
  },
  {
    name: 'native: streamed answer, a tool and an ask answered, turn over',
    kind: 'native',
    steps: [
      { t: T('user-message', { text: 'fix the bug' }) },
      { t: T('assistant-text', { text: 'Let me ', partId: 'text-0', model: 'm1' }) },
      { t: T('assistant-text', { text: 'look at it', partId: 'text-0' }) },
      { t: T('tool-use', { toolUseId: 'tool-1', toolName: 'Bash', toolInput: { command: 'ls' } }) },
      { hook: hook('PermissionRequest', 'native-r1', { tool_name: 'Bash', tool_input: { command: 'ls' } }) },
      { hook: hook('PermissionResolved', 'native-r1') },
      { t: T('tool-result', { toolUseId: 'tool-1', toolResult: 'ok', isError: false }) },
      { t: T('assistant-text', { text: 'Done.', partId: 'text-1' }) },
      { t: T('turn-complete', { stopReason: 'end_turn', model: 'm1' }) },
    ],
  },
  {
    name: 'native: a retry drops the half-written answer (dropPart)',
    kind: 'native',
    steps: [
      { t: T('user-message', { text: 'explain it' }) },
      { t: T('assistant-text', { text: 'HALF-ANSWER-TO-BE-DISCARDED', partId: 'text-0' }) },
      { t: T('assistant-thinking', { dropPart: { partIds: ['text-0'] } }) },
      { t: T('assistant-text', { text: 'REPLACEMENT', partId: 'text-0' }) },
      { t: T('turn-complete', { stopReason: 'end_turn' }) },
    ],
  },
  {
    name: 'native: a provider error ends the turn',
    kind: 'native',
    steps: [
      { t: T('user-message', { text: 'go' }) },
      { t: T('assistant-text', { text: 'Starting', partId: 'text-0' }) },
      { t: T('session-error', { text: 'the provider said no' } as any) },
    ],
  },
  {
    name: 'native: a turn parked by a stall (the stalled card)',
    kind: 'native',
    steps: [
      { t: T('user-message', { text: 'go' }) },
      { t: T('assistant-thinking', { stalled: true } as any) },
    ],
  },
  {
    name: 'native: compaction summary lands mid-conversation',
    kind: 'native',
    steps: [
      { t: T('user-message', { text: 'one' }) }, { t: T('assistant-text', { text: 'answer one', partId: 'text-0' }) },
      { t: T('turn-complete', { stopReason: 'end_turn' }) },
      { t: T('user-message', { text: 'compact please' }) },
      { t: T('compact-summary', { summary: 's', contextUsedBefore: 100, contextUsedAfter: 10, autoCompaction: true } as any) },
      { t: T('turn-complete', { stopReason: 'end_turn' }) },
    ],
  },
  {
    name: 'native: connected mid-answer (the text so far exists only in memory) with a tool waiting on an ask',
    kind: 'native',
    note: 'the open part is never flushed to disk, exactly as in a live session',
    steps: [
      { t: T('user-message', { text: 'refactor it' }) },
      { t: T('assistant-text', { text: 'First paragraph.', partId: 'text-0' }) },
      { t: T('tool-use', { toolUseId: 'tool-9', toolName: 'Write', toolInput: { path: 'a.ts' } }) },
      { hook: hook('PermissionRequest', 'native-r9', { tool_name: 'Write', tool_input: { path: 'a.ts' } }) },
    ],
  },
  {
    name: 'native: connected mid-answer, text still streaming',
    kind: 'native',
    note: 'two deltas of one open part, never flushed',
    steps: [
      { t: T('user-message', { text: 'write a poem' }) },
      { t: T('assistant-text', { text: 'Roses are ', partId: 'text-0' }) },
      { t: T('assistant-text', { text: 'red, ', partId: 'text-0' }) },
      { t: T('assistant-text', { text: 'violets are blue', partId: 'text-0' }) },
    ],
  },
];

// --- the live transcript events a scenario produces ------------------------------------------------------------------
export interface Run {
  /** Everything that reached the screens, in order: transcript events and hook events. */
  pushes: Array<{ type: 'transcript:event'; payload: TranscriptEvent } | { type: 'hook:event'; payload: HookEvent } | { type: 'local'; payload: ChatAction }>;
  /** Where the page boundary sits for a resumed Claude Code session: events before it are history. */
  boundaryIndex: number | null;
  /** The Claude Code file or the native session's disk events. */
  diskPath?: string;
  nativeDisk?: TranscriptEvent[];
  cleanup(): void;
  /** Tool ids that began before the resume spawned (the page reconciles those). */
  preResumeToolIds: string[];
  /** Byte offset of the resume boundary in the Claude Code file. */
  resumeOffset: number | null;
}

export async function runScenario(sc: Scenario): Promise<Run> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fill-sc-'));
  const pushes: Run['pushes'] = [];
  let boundaryIndex: number | null = null;
  let resumeOffset: number | null = null;
  const preResumeToolIds: string[] = [];
  let diskPath: string | undefined;
  let nativeDisk: TranscriptEvent[] | undefined;

  if (sc.kind === 'cc') {
    diskPath = path.join(dir, 'cc.jsonl');
    fs.writeFileSync(diskPath, '');
    for (const step of sc.steps) {
      if ('line' in step) {
        const text = JSON.stringify(step.line);
        fs.appendFileSync(diskPath, text + '\n');
        // The watcher emits what the real parser reads from the line: the same events a page would hold.
        for (const e of parseTranscriptLine(text, SID)) {
          pushes.push({ type: 'transcript:event', payload: e });
          if (boundaryIndex === null && e.type === 'tool-use' && e.data?.toolUseId) preResumeToolIds.push(e.data.toolUseId);
        }
      } else if ('hook' in step) pushes.push({ type: 'hook:event', payload: step.hook });
      else if ('resumeBoundary' in step) {
        boundaryIndex = pushes.length;
        resumeOffset = fs.statSync(diskPath).size;
      } else if ('local' in step) pushes.push({ type: 'local', payload: step.local });
    }
    // Tools launched after the boundary are not "before spawn".
    if (boundaryIndex === null) preResumeToolIds.length = 0;
  } else {
    const home = new NativeHome(dir);
    const store = new SessionStore(home);
    await store.create({ v: 1, sessionId: SID, harnessId: 'native', binding: { providerId: 'p', modelId: 'm' } as any, cwd: dir, createdAt: 1 });
    for (const step of sc.steps) {
      if ('t' in step) {
        pushes.push({ type: 'transcript:event', payload: step.t });
        await store.append(dir, step.t);
      } else if ('hook' in step) pushes.push({ type: 'hook:event', payload: step.hook });
      else if ('local' in step) pushes.push({ type: 'local', payload: step.local });
    }
    // NOT flushed: an open streaming part stays in memory, as in a live session. A finished turn already flushed itself.
    nativeDisk = await store.readEventsAsync(SID, dir);
  }
  return { pushes, boundaryIndex, diskPath, nativeDisk, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }), preResumeToolIds, resumeOffset };
}

/** Every ask this run raised and nothing has closed. */
export function openAsksOf(run: Run): HookEvent[] {
  const open = new Map<string, HookEvent>();
  for (const p of run.pushes) {
    if (p.type !== 'hook:event') continue;
    const id = (p.payload.payload as Record<string, unknown>)?._requestId as string;
    if (p.payload.type === 'PermissionRequest') open.set(id, p.payload);
    else if (p.payload.type === 'PermissionResolved' || p.payload.type === 'PermissionExpired') open.delete(id);
  }
  return [...open.values()];
}

// --- folding ---------------------------------------------------------------------------------------------------------
export function newState(): ChatState {
  return chatReducer(new Map(), { type: 'SESSION_INIT', sessionId: SID });
}
export function applyPush(state: ChatState, p: Run['pushes'][number]): ChatState {
  if (p.type === 'transcript:event') {
    for (const a of eventToAction(p.payload, { live: true })) state = chatReducer(state, a);
  } else if (p.type === 'hook:event') {
    const a = hookEventToAction(p.payload);
    if (a) state = chatReducer(state, a);
  } else state = chatReducer(state, p.payload);
  return state;
}

/** The page a window gets for this scenario from the disk, to the end of the file. */
export async function diskPage(run: Run, opts: { endOffset?: number | null; reconcile?: boolean } = {}): Promise<TranscriptPageResult> {
  if (run.nativeDisk) return { events: run.nativeDisk, cursor: null, hasMore: false };
  const page = await readTranscriptPage({ jsonlPath: run.diskPath!, sessionId: SID, endOffset: opts.endOffset ?? null });
  return page;
}

// --- the screen ------------------------------------------------------------------------------------------------------
export interface Screen {
  timeline: string[];
  thinking: boolean;
  attention: string;
  error: string | null;
  awaiting: string[];
  hasMore: boolean;
}

export function screenOf(state: ChatState, sid = SID): Screen | null {
  const s = state.get(sid);
  if (!s) return null;
  const tool = (id: string) => {
    const t = s.toolCalls.get(id);
    return t ? `${t.toolName}:${t.status}${t.requestId ? `#${t.requestId}` : ''}${t.answeredElsewhere ? '*elsewhere' : ''}${t.expired ? '*expired' : ''}` : `?${id}`;
  };
  const seg = (g: any): string => {
    if (g.type === 'text' || g.type === 'reasoning') return `${g.type}(${g.content})`;
    if (g.type === 'tool-group') return `tools[${(s.toolGroups.get(g.groupId)?.toolIds ?? []).map(tool).join(',')}]`;
    return g.type;
  };
  const timeline = s.timeline.map((e): string => {
    switch (e.kind) {
      case 'user': return `user${e.pending ? '(pending)' : ''}: ${e.message.content}`;
      case 'assistant-turn': {
        const t = s.assistantTurns.get(e.turnId);
        return `assistant: ${t ? t.segments.map(seg).join(' | ') : '<missing>'}${t?.stopReason ? ` [stop=${t.stopReason}]` : ''}`;
      }
      case 'system-marker': return `marker: ${e.marker.label}`;
      case 'skill-invocation': return `skill: ${e.skillId}`;
      default: return e.kind;
    }
  });
  const awaiting: string[] = [];
  for (const [id, t] of s.toolCalls) {
    if (t.status === 'awaiting-approval') awaiting.push(`${id}#${t.requestId ?? ''}`);
    for (const sg of t.subagentSegments ?? []) if (sg.type === 'tool' && sg.status === 'awaiting-approval') awaiting.push(`${id}>${sg.requestId ?? ''}`);
  }
  return { timeline, thinking: s.isThinking, attention: s.attentionState, error: s.errorMessage, awaiting: awaiting.sort(), hasMore: s.history.hasMore };
}
