// desktop/src/renderer/components/xray/xray-model.ts
//
// Turns classified saved lines into what X-ray draws: TURNS (each starting with a
// message from you), each holding STEPS in exact saved order. A tool call and its
// result are ONE step, because "what did it ask for, and what came back" is one
// question (review 1, A-2: the separate rows and jump buttons were confusing).
//
// Every step says, in plain words, which way it went — sent to the model, came
// from the model, or kept by the app and never sent — and whether normal chat
// shows it (review 1, Q-filters: "unclear what inputs/outputs for the model are").
import type { XrayChatFate } from '../../../shared/xray-types';
import { findRepeats, GAP_MS, type XrayLine } from './xray-lines';

/** Which way a step went.
 *  to-model: part of what the model reads (your messages, tool results, reminders,
 *            loaded instructions). from-model: what the model wrote (replies,
 *            thinking, tool requests). app-only: notes Claude Code or the app keeps
 *            for itself; never sent. */
export type XrayDirection = 'to-model' | 'from-model' | 'app-only';

export type XrayStepKind =
  | 'you' | 'reply' | 'thinking' | 'tool' | 'reminder' | 'instructions'
  | 'hook' | 'summary' | 'interrupt' | 'note';

export interface XrayStep {
  /** The first saved line of this step — its identity. */
  id: number;
  kind: XrayStepKind;
  direction: XrayDirection;
  /** Plain-language name of the step: "You", "Ran Bash", "Claude Code added a reminder". */
  title: string;
  /** The one line under the title. */
  gist: string;
  /** How normal chat treats it; for a tool, the call's (results ride with it). */
  chat: XrayChatFate;
  at: number | null;
  /** The saved lines behind this step, in order (a tool step has its call and result). */
  lines: XrayLine[];
  // Tool steps only:
  tool?: string;
  /** undefined = no result saved yet (still running, or stuck). */
  outcome?: 'worked' | 'failed';
  /** 2+ = the same request made again since your last message. */
  repeat?: number;
  /** Time since the previous saved line, when it was a long pause. */
  pauseBefore?: number;
}

export interface XrayTurn {
  /** Step id of the turn's opening message, or 0 for what came before it. */
  id: number;
  /** "What you asked", cut short; empty for the opening stretch. */
  ask: string;
  at: number | null;
  steps: XrayStep[];
  /** Totals the turn's header shows at a glance. */
  toolCount: number;
  failed: number;
  repeats: number;
  pauses: number;
  hidden: number;
  /** First to last saved time in the turn, when both are known. */
  durationMs: number | null;
}

const ASK_MAX = 120;

function cut(s: string, n: number): string { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

function directionOf(l: XrayLine): XrayDirection {
  switch (l.kind) {
    case 'assistant': case 'thinking': case 'tool-call': return 'from-model';
    case 'system': case 'turn-end': case 'bookkeeping': case 'other': return 'app-only';
    default: return 'to-model';
  }
}

const SIMPLE: Partial<Record<XrayLine['kind'], { kind: XrayStepKind; title: string }>> = {
  you: { kind: 'you', title: 'You' },
  assistant: { kind: 'reply', title: 'Assistant replied' },
  thinking: { kind: 'thinking', title: 'Assistant thought' },
  reminder: { kind: 'reminder', title: 'Reminder added for the model' },
  injected: { kind: 'instructions', title: 'Instructions loaded for the model' },
  hook: { kind: 'hook', title: 'A hook ran' },
  summary: { kind: 'summary', title: 'Earlier conversation summarised' },
  interrupt: { kind: 'interrupt', title: 'You stopped the assistant' },
  system: { kind: 'note', title: 'App note' },
  'turn-end': { kind: 'note', title: 'Turn finished' },
  bookkeeping: { kind: 'note', title: 'App note' },
  other: { kind: 'note', title: 'Unrecognised line' },
};

export function buildTurns(lines: readonly XrayLine[]): XrayTurn[] {
  const repeats = findRepeats(lines);
  const steps: XrayStep[] = [];
  const openCalls = new Map<string, XrayStep>();
  let prevAt: number | null = null;

  for (const l of lines) {
    const pause = l.at != null && prevAt != null && l.at - prevAt >= GAP_MS ? l.at - prevAt : undefined;
    if (l.at != null) prevAt = l.at;

    if (l.kind === 'tool-result') {
      const call = l.callId ? openCalls.get(l.callId) : undefined;
      if (call) {
        call.lines.push(l);
        call.outcome = l.summary.startsWith('Error:') ? 'failed' : 'worked';
        // A result that lands after a long wait is a stall INSIDE the tool —
        // marked on the step, since there is no gap between steps to draw it in.
        if (pause && !call.pauseBefore) call.pauseBefore = pause;
        openCalls.delete(l.callId);
        continue;
      }
      // A result with no call in view (an earlier page): its own step.
      steps.push({ id: l.n, kind: 'tool', direction: 'to-model', title: l.tool ? `Result from ${l.tool}` : 'Tool result',
        gist: l.summary, chat: l.chat, at: l.at, lines: [l], tool: l.tool,
        outcome: l.summary.startsWith('Error:') ? 'failed' : 'worked', pauseBefore: pause });
      continue;
    }
    if (l.kind === 'tool-call') {
      const step: XrayStep = { id: l.n, kind: 'tool', direction: 'from-model', title: `Ran ${l.tool || 'a tool'}`,
        gist: l.summary, chat: l.chat, at: l.at, lines: [l], tool: l.tool,
        repeat: repeats.get(l.n), pauseBefore: pause };
      if (l.callId) openCalls.set(l.callId, step);
      steps.push(step);
      continue;
    }
    const s = SIMPLE[l.kind] ?? SIMPLE.other!;
    steps.push({ id: l.n, kind: s.kind, direction: directionOf(l), title: s.title, gist: l.summary,
      chat: l.chat, at: l.at, lines: [l], pauseBefore: pause });
  }

  const turns: XrayTurn[] = [];
  let cur: XrayTurn | null = null;
  const start = (id: number, ask: string, at: number | null): XrayTurn =>
    ({ id, ask, at, steps: [], toolCount: 0, failed: 0, repeats: 0, pauses: 0, hidden: 0, durationMs: null });
  for (const s of steps) {
    if (s.kind === 'you' || !cur) {
      cur = s.kind === 'you' ? start(s.id, cut(s.gist, ASK_MAX), s.at) : start(0, '', s.at);
      turns.push(cur);
    }
    cur.steps.push(s);
  }
  for (const t of turns) {
    let first: number | null = null; let last: number | null = null;
    for (const s of t.steps) {
      if (s.kind === 'tool') { t.toolCount += 1; if (s.outcome === 'failed') t.failed += 1; if ((s.repeat ?? 0) > 1) t.repeats += 1; }
      if (s.pauseBefore) t.pauses += 1;
      if (s.chat !== 'shown') t.hidden += 1;
      for (const l of s.lines) if (l.at != null) { if (first == null) first = l.at; last = l.at; }
    }
    t.durationMs = first != null && last != null ? last - first : null;
  }
  return turns;
}

/** Whether a step counts as a "problem" for the Problems view and the summary. */
export function isProblem(s: XrayStep): boolean {
  return s.outcome === 'failed' || (s.repeat ?? 0) > 1 || !!s.pauseBefore
    || (s.kind === 'tool' && s.outcome === undefined && s.direction === 'from-model');
}

/** Labelled fields of a tool request, for the opened step. Strings stay whole;
 *  anything else is shown as compact text. */
export function inputFields(call: XrayLine): Array<{ label: string; value: string }> {
  let input: unknown;
  try {
    const d = JSON.parse(call.raw) as Record<string, unknown>;
    const msg = d.message as { content?: Array<Record<string, unknown>> } | undefined;
    input = msg?.content?.find((b) => b?.type === 'tool_use')?.input
      ?? (d.data as Record<string, unknown> | undefined)?.toolInput;
  } catch { return []; }
  if (!input || typeof input !== 'object') return input == null ? [] : [{ label: 'Input', value: String(input) }];
  return Object.entries(input as Record<string, unknown>).map(([k, v]) => ({
    label: k.replace(/_/g, ' '),
    value: typeof v === 'string' ? v : JSON.stringify(v),
  }));
}

/** The full text a step carries: a message's words, or a tool result's output. */
export function fullText(l: XrayLine): string {
  try {
    const d = JSON.parse(l.raw) as Record<string, unknown>;
    const data = d.data as Record<string, unknown> | undefined;
    if (data) return String(data.text ?? data.toolResult ?? data.summary ?? '');
    if (d.type === 'summary') return String(d.summary ?? '');
    if (d.type === 'attachment') { const a = d.attachment as Record<string, unknown>; return String(a?.content ?? ''); }
    if (d.type === 'system') return String(d.content ?? '');
    const content = (d.message as { content?: unknown } | undefined)?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map((b: Record<string, unknown>) => {
        if (typeof b.text === 'string') return b.text;
        if (typeof b.thinking === 'string') return b.thinking;
        if (typeof b.content === 'string') return b.content;
        if (Array.isArray(b.content)) return (b.content as Array<Record<string, unknown>>).map((x) => String(x.text ?? '')).join('\n');
        return '';
      }).filter(Boolean).join('\n\n');
    }
  } catch { /* fall through */ }
  return l.raw;
}
