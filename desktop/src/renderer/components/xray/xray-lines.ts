// desktop/src/renderer/components/xray/xray-lines.ts
//
// X-ray's reading of one saved session line: what kind of line it is, a one-line
// summary, its time, and — for tool calls — a fingerprint used to spot repeats.
//
// WHY the renderer classifies and main only reads: main hands over each line
// exactly as saved plus what normal chat did with it (Destin's deck 2026-10-04,
// Q-xray-source "saved file, marked"). Everything here is a pure function of
// that text, so it is the same on desktop and remote, and testable without a file.
//
// Two file formats are read: Claude Code's (`type: user|assistant|system|…`,
// `message.content` blocks) and the app's own sessions (`type: user-message|
// tool-use|…`, `data`). An unrecognised line is still shown, as "Other".

import type { XrayChatFate, XrayRawLine } from '../../../shared/xray-types';
export type { XrayChatFate, XrayRawLine };

export type XrayKind =
  | 'you' | 'assistant' | 'thinking' | 'tool-call' | 'tool-result'
  | 'reminder' | 'injected' | 'hook' | 'system' | 'summary' | 'interrupt'
  | 'turn-end' | 'bookkeeping' | 'other';

/** Filter groups the toolbar offers. Kinds map onto exactly one group. */
export type XrayGroup = 'conversation' | 'tools' | 'behind-scenes' | 'app';

export const KIND_LABEL: Record<XrayKind, string> = {
  you: 'You',
  assistant: 'Assistant',
  thinking: 'Thinking',
  'tool-call': 'Tool call',
  'tool-result': 'Tool result',
  reminder: 'Reminder',
  injected: 'Injected text',
  hook: 'Hook',
  system: 'System',
  summary: 'Summary',
  interrupt: 'Interrupted',
  'turn-end': 'Turn end',
  bookkeeping: 'Bookkeeping',
  other: 'Other',
};

export const KIND_GROUP: Record<XrayKind, XrayGroup> = {
  you: 'conversation',
  assistant: 'conversation',
  thinking: 'conversation',
  interrupt: 'conversation',
  'tool-call': 'tools',
  'tool-result': 'tools',
  reminder: 'behind-scenes',
  injected: 'behind-scenes',
  hook: 'behind-scenes',
  summary: 'behind-scenes',
  system: 'app',
  'turn-end': 'app',
  bookkeeping: 'app',
  other: 'app',
};

export interface XrayLine {
  n: number;
  raw: string;
  chat: XrayChatFate;
  kind: XrayKind;
  /** Tool name for calls/results; empty otherwise. */
  tool: string;
  /** One line of plain text, cut to SUMMARY_MAX. */
  summary: string;
  /** ms since epoch, or null when the line has no time. */
  at: number | null;
  /** Tool-use id joining a call to its result; empty when none. */
  callId: string;
  /** Name + input, for tool calls only — two calls with the same fingerprint
   *  asked for exactly the same thing. */
  fingerprint: string;
  /** Size of the saved line in bytes (UTF-16 length is close enough for a gauge). */
  bytes: number;
}

const SUMMARY_MAX = 220;

function oneLine(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > SUMMARY_MAX ? flat.slice(0, SUMMARY_MAX - 1) + '…' : flat;
}

function toTime(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isNaN(t) ? null : t; }
  return null;
}

/** The first meaningful words of a tool input, for the summary column. */
function inputGist(input: unknown): string {
  if (!input || typeof input !== 'object') return typeof input === 'string' ? input : '';
  const o = input as Record<string, unknown>;
  for (const k of ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'skill', 'description', 'prompt']) {
    if (typeof o[k] === 'string' && o[k]) return String(o[k]);
  }
  try { return JSON.stringify(input); } catch { return ''; }
}

function stableJson(v: unknown): string {
  try { return JSON.stringify(v, v && typeof v === 'object' ? Object.keys(v as object).sort() : undefined); } catch { return ''; }
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => {
    if (!b || typeof b !== 'object') return '';
    const blk = b as Record<string, unknown>;
    if (typeof blk.text === 'string') return blk.text;
    if (typeof blk.content === 'string') return blk.content;
    if (Array.isArray(blk.content)) return textOfContent(blk.content);
    return '';
  }).join(' ');
}

/** Drops the wrapper tags so the summary starts with what the text says. */
function stripTags(s: string): string { return s.replace(/<\/?[a-z][a-z-]*>/g, ' '); }

const REMINDER_ONLY_RE = /^\s*(<(system-reminder|task-notification|local-command-stdout|local-command-caveat)>[\s\S]*?<\/\2>\s*)+$/;

type Classified = Pick<XrayLine, 'kind' | 'tool' | 'summary' | 'callId' | 'fingerprint'>;

function classifyClaudeCode(d: Record<string, unknown>): Classified | null {
  const type = d.type;
  const msg = (d.message ?? {}) as Record<string, unknown>;
  const content = msg.content;
  const base = { tool: '', callId: '', fingerprint: '' };

  if (type === 'assistant') {
    const blocks = Array.isArray(content) ? content as Record<string, unknown>[] : [];
    const call = blocks.find((b) => b?.type === 'tool_use');
    if (call) {
      const name = String(call.name ?? '');
      return { kind: 'tool-call', tool: name, callId: String(call.id ?? ''),
        summary: oneLine(inputGist(call.input)), fingerprint: name + ' ' + stableJson(call.input) };
    }
    const thinking = blocks.find((b) => b?.type === 'thinking' || b?.type === 'redacted_thinking');
    if (thinking && !blocks.some((b) => b?.type === 'text')) {
      return { ...base, kind: 'thinking', summary: oneLine(String(thinking.thinking ?? '(hidden by the provider)')) };
    }
    return { ...base, kind: 'assistant', summary: oneLine(textOfContent(content)) };
  }

  if (type === 'user') {
    const blocks = Array.isArray(content) ? content as Record<string, unknown>[] : [];
    const result = blocks.find((b) => b?.type === 'tool_result');
    if (result) {
      return { kind: 'tool-result', tool: '', callId: String(result.tool_use_id ?? ''), fingerprint: '',
        summary: oneLine((result.is_error ? 'Error: ' : '') + textOfContent(result.content ?? '')) };
    }
    const text = textOfContent(content);
    if (d.isMeta) return { ...base, kind: REMINDER_ONLY_RE.test(text) ? 'reminder' : 'injected', summary: oneLine(stripTags(text)) };
    if (/^\s*\[Request interrupted/.test(text)) return { ...base, kind: 'interrupt', summary: oneLine(text) };
    if (REMINDER_ONLY_RE.test(text)) return { ...base, kind: 'reminder', summary: oneLine(stripTags(text)) };
    return { ...base, kind: 'you', summary: oneLine(text) };
  }

  if (type === 'system') {
    const sub = String(d.subtype ?? '');
    const kind: XrayKind = /hook/i.test(sub) ? 'hook' : 'system';
    return { ...base, kind, summary: oneLine([sub, String(d.content ?? '')].filter(Boolean).join(' — ')) };
  }
  if (type === 'attachment') {
    const att = (d.attachment ?? {}) as Record<string, unknown>;
    const kind: XrayKind = /hook/i.test(String(att.type ?? '')) ? 'hook' : 'injected';
    return { ...base, kind, summary: oneLine(`${String(att.type ?? 'attachment')} ${String(att.content ?? att.hookName ?? '')}`) };
  }
  if (type === 'summary') return { ...base, kind: 'summary', summary: oneLine(String(d.summary ?? '')) };
  if (typeof type === 'string') return { ...base, kind: 'bookkeeping', summary: oneLine(type) };
  return null;
}

function classifyNative(d: Record<string, unknown>): Classified | null {
  const data = (d.data ?? {}) as Record<string, unknown>;
  const base = { tool: '', callId: '', fingerprint: '' };
  switch (d.type) {
    case 'user-message': return { ...base, kind: 'you', summary: oneLine(String(data.text ?? '')) };
    case 'assistant-text': return { ...base, kind: 'assistant', summary: oneLine(String(data.text ?? '')) };
    case 'assistant-thinking': return { ...base, kind: 'thinking', summary: oneLine(String(data.text ?? '')) };
    case 'tool-use': {
      const name = String(data.toolName ?? '');
      return { kind: 'tool-call', tool: name, callId: String(data.toolUseId ?? ''),
        summary: oneLine(inputGist(data.toolInput)), fingerprint: name + ' ' + stableJson(data.toolInput) };
    }
    case 'tool-result':
      return { kind: 'tool-result', tool: String(data.toolName ?? ''), callId: String(data.toolUseId ?? ''), fingerprint: '',
        summary: oneLine((data.isError ? 'Error: ' : '') + String(data.toolResult ?? '')) };
    case 'turn-complete': return { ...base, kind: 'turn-end', summary: oneLine(String(data.stopReason ?? 'turn finished')) };
    case 'compact-summary': return { ...base, kind: 'summary', summary: oneLine(String(data.summary ?? data.text ?? '')) };
    case 'user-interrupt': return { ...base, kind: 'interrupt', summary: 'Interrupted' };
    default:
      if (typeof d.type === 'string') return { ...base, kind: 'bookkeeping', summary: oneLine(String(d.type)) };
      // The header line (`v`, binding, cwd) has no type.
      if (d.v != null) return { ...base, kind: 'system', summary: oneLine(`Session started · ${stableJson(d.binding)}`) };
      return null;
  }
}

const NATIVE_TYPES = new Set(['user-message', 'assistant-text', 'assistant-thinking', 'tool-use', 'tool-result',
  'turn-complete', 'compact-summary', 'user-interrupt', 'subagent-usage']);

export function classifyLine(line: XrayRawLine): XrayLine {
  let d: Record<string, unknown> | null = null;
  try { const parsed = JSON.parse(line.raw); if (parsed && typeof parsed === 'object') d = parsed; } catch { /* shown as Other */ }
  const c = d
    ? (NATIVE_TYPES.has(String(d.type)) || (d.v != null && d.type == null) ? classifyNative(d) : classifyClaudeCode(d))
    : null;
  return {
    n: line.n,
    raw: line.raw,
    chat: line.chat,
    bytes: line.raw.length,
    at: d ? toTime(d.timestamp ?? d.createdAt) : null,
    ...(c ?? { kind: 'other', tool: '', callId: '', fingerprint: '', summary: oneLine(line.raw) }),
  };
}

/** A tool call is a repeat when the SAME call (name + input) was already made
 *  within the last REPEAT_WINDOW tool calls since your last message. Returns line number → how many
 *  times that call has been made so far (2 = second time). Only repeats are in
 *  the map.
 *
 *  WHY a window rather than "anywhere in the session": re-reading a file an
 *  hour later is normal work; asking for it again three calls later is the
 *  loop the repeat finder exists to point at. And a message from you starts
 *  over: re-running a test because you said what to change is not a loop. */
export const REPEAT_WINDOW = 8;

export function findRepeats(lines: readonly XrayLine[]): Map<number, number> {
  const out = new Map<number, number>();
  const recent: string[] = [];
  const counts = new Map<string, number>();
  for (const l of lines) {
    if (l.kind === 'you') { recent.length = 0; counts.clear(); continue; }
    if (l.kind !== 'tool-call' || !l.fingerprint) continue;
    if (recent.includes(l.fingerprint)) {
      const c = (counts.get(l.fingerprint) ?? 1) + 1;
      counts.set(l.fingerprint, c);
      out.set(l.n, c);
    } else {
      counts.set(l.fingerprint, 1);
    }
    recent.push(l.fingerprint);
    if (recent.length > REPEAT_WINDOW) recent.shift();
  }
  return out;
}

/** A pause worth marking: nothing was written for at least this long. */
export const GAP_MS = 60_000;

export function formatGap(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60 ? `${s % 60} s` : ''}`.trim();
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
}

export function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(b < 10240 ? 1 : 0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

/** Pretty-prints a saved line for the open row; falls back to the raw text. */
export function prettyRaw(raw: string): string {
  try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
}
