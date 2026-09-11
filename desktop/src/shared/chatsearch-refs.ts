// Shared contract for "session references": the two IPC channels the renderer
// uses to turn a chatsearch tool call into Preview / Resume cards, every piece
// of user-facing copy the feature shows, and the PURE parser that decides
// whether a Bash call is a chatsearch call at all.
//
// WHY the parser lives in shared/ and not the renderer: ToolCard (header label,
// expanded default) and ToolBody (card body) both need the same answer, and a
// unit test must run it without React. One function, two consumers — they can
// never disagree about what a call is.
import type { ToolCallState } from './types';

export type ChatsearchProvider = 'claude' | 'native';

/** Lane names are developer jargon; users see these. */
export function providerLabel(p: string): string {
  return p === 'native' ? 'YouCoded assistant' : 'Claude Code';
}

/** Every sentence this feature shows. Rendered in the workbench at the gate. */
export const COPY = {
  preview: 'Preview',
  resume: 'Resume',
  resumeNative: 'Resume…',
  previewHint: 'Read this conversation in the side pane',
  resumeHint: 'Continue this conversation in a new tab',
  resumeNativeHint: 'Pick a model, then continue this conversation in a new tab',
  // Verbatim from ResumeBrowser.tsx:978 — the Resume Browser already teaches
  // users these two sentences; the card must not invent a third.
  resumeMissingProject: 'Project folder not on this device',
  resumeNotSynced: 'Not synced to this device yet',
  previewTombstone: 'Transcript is no longer on this device',
  unknownId: 'Not in the index on this device',
  ambiguousId: (n: number) => `Matches ${n} conversations`,
  lookingUp: (n: number) => `Looking up ${n} conversation${n === 1 ? '' : 's'}…`,
  headerFind: (n: number) => `Found ${n} past conversation${n === 1 ? '' : 's'}`,
  headerShow: 'Past conversation',
  // Destin (2026-08-27 gate, M-caption): "remove 'past conversation'. put
  // read-only to the right of the assistant." The drawer's own title bar
  // already names the conversation, so repeating "Past conversation" here said
  // nothing the row above hadn't.
  paneSubtitle: (p: string) => `${providerLabel(p)} · read-only`,
  untitled: 'Untitled conversation',
  noProject: '(no project)',
  // Reads like a real tool group's own header ("4 tools (Bash ×2) — all
  // complete") because Destin asked for it to LOOK like one (2026-08-27 gate,
  // M-toolgap). We don't know which tools ran — the reader dropped them — so
  // the parenthetical every real group carries is honestly absent here.
  toolsNotShown: (n: number) => `${n} tool${n === 1 ? '' : 's'} — not shown`,
  startOfConversation: 'start of conversation',
  loadOlder: 'Load older',
  // SessionPreviewPane's first-load spinner text. Deliberately terse (unlike
  // states.tsx's LoadingState, which names what's loading) — the pane's header
  // already shows the conversation title, so "Loading…" isn't ambiguous here.
  loading: 'Loading…',
  // Destin (2026-08-27 gate, M-row): the raw output disclosure was dead weight
  // — nobody opens it. What is worth saying is what Claude actually asked for.
  // Printed ONLY when the query parses out of the command; a search whose words
  // we cannot read prints nothing rather than a guess.
  searchedFor: (q: string) => `Searched for “${q}”`,
  readConversation: 'Claude read this conversation',
  // The footnote that keeps the header honest once unresolvable rows are
  // hidden: the card's header counts what the search returned, so without this
  // a hidden row would make the card show fewer conversations than it claims.
  hiddenNotHere: (n: number) => `${n} more not on this device`,
  // The reference block the assistant writes into its own message (compare
  // Round 8, candidate A). Heading is deliberately absent: the sentence above
  // the block is what introduces it, and a heading would say the same thing
  // twice — the whole point of the round was how the block attaches to prose.
  refBlockEmpty: 'No conversations named here',
  referencedHeading: 'Referenced conversations',
  // The overflow chip a presented conversation's tag row shows once more than
  // two tags would crowd out the project name or the buttons next to them —
  // e.g. "+2" standing in for two tags not shown. Kept terse on purpose: it
  // sits inside a chip-sized space next to real tag chips.
  presentTagsMore: (n: number) => `+${n}`,
  // present-expand-in-place (Round 7): the collapsed row's own <button> title
  // hint — this row shows only a title at rest; these two strings are the
  // only text that says what clicking it does.
  presentShowDetails: 'Show details',
  presentHideDetails: 'Hide details',
  // present-one-at-a-time (Round 7): the pager that steps through conversations
  // shown one at a time. Accessible names for the prev/next arrows and the
  // dot buttons — with only one conversation on screen at once, these are the
  // only way a screen reader user finds out there are others.
  presentPagerPrev: 'Previous conversation',
  presentPagerNext: 'Next conversation',
  presentPagerLabel: 'Conversations',
  presentPagerGoTo: (n: number, total: number) => `Go to conversation ${n} of ${total}`,
  presentPagerPosition: (n: number, total: number) => `${n} / ${total}`,
  // Phase B error strings (main process). Listed here so the gate can show them.
  errNotAnId: 'Not a conversation id',
  errNotIndexed: 'This conversation is not in the index on this device',
  errNotAConversation: 'This file is a helper transcript, not a conversation',
  errOutsideRoots: 'Transcript is stored outside the folders YouCoded may read',
  errReadPrefix: "Couldn't read this transcript: ",
  // Fix (2026-08-27): the case (b) general-error card SessionPreviewPane
  // shows when chatsearch:read fails without giving a reason — never guess
  // one. Shared between the first-load failure and a failed "Load older"
  // page; both are the same operation (reading this transcript) so the same
  // wording is honest for either.
  errReadUnknownTitle: 'Unable to read this transcript.',
  errReadUnknownExplainer: "The read didn't report a reason. Diagnosing will collect the app's logs so the assistant can look at what happened.",
  // The tag/note popover's dialog role needs an accessible name (a
  // screen-reader user hears it) — every user-facing sentence for this
  // feature lives in COPY, aria-label included.
  tagsAndNoteLabel: 'Tags and note',
  // A3 (2026-08-26 preview-header spec): right-clicking inside a previewed
  // past conversation prefixes the normal "Ask about this" lead with this
  // clause, naming the conversation the quote came from. Unlike the live
  // chat — which IS the conversation, so a bare "you said" is unambiguous —
  // the assistant answering a preview quote has no other way to know which
  // past conversation to `show`/`turns` through the chatsearch plugin. Kept
  // as a plain parenthetical (not a bare id) so a message sent with nothing
  // else typed still reads as an unfinished sentence, not a stray token.
  // Wording is NOT yet signed off by Destin (spec C4) — flag any change here.
  askPreviewContext: (title: string, id: string) =>
    `(from the past conversation "${title || COPY.untitled}", id ${id})`,
} as const;

/**
 * The reference block: how the assistant names past conversations inside its
 * own message, and how the renderer finds them again.
 *
 * A fenced code block with this language, one short id per line:
 *
 *     ```conversations
 *     a3f2
 *     9c14
 *     ```
 *
 * WHY a fence rather than an inline token: the block is a GROUP sitting between
 * paragraphs (Destin picked that shape), and a fence is already block-level in
 * every markdown renderer. It also fails safely — anywhere this parser does not
 * run (an older client, copied text, a plain-text export) it degrades to a
 * short code block listing the ids, which is ugly but not misleading.
 */
export const CONVERSATIONS_FENCE = 'conversations';

/**
 * Short ids out of a reference block's body. Tolerates the shapes a model
 * actually writes: bare ids, `- ` bullets, and several on one line separated by
 * commas or spaces. Anything that is not id-shaped is dropped rather than
 * passed on to a lookup — the block is written by a model, so it is input, not
 * a contract.
 */
export function parseConversationRefs(body: string): string[] {
  const out: string[] = [];
  for (const raw of body.split('\n')) {
    for (const tok of raw.replace(/^[\s>*-]+/, '').split(/[\s,]+/)) {
      const t = tok.trim().toLowerCase();
      if (/^[0-9a-f-]{4,36}$/.test(t) && !out.includes(t)) out.push(t);
    }
  }
  return out;
}

/** What `chatsearch:resolve` returns per requested id. */
export type ResolvedConversation =
  | {
      status: 'ok';
      id: string;
      provider: ChatsearchProvider;
      /** '' when untitled. */
      title: string;
      projectName: string;
      originalPath: string;
      lastActive: string;
      createdAt: string;
      tags: string[];
      complete: boolean;
      tombstone: boolean;
      /** Resume prerequisites — same computation as the Resume Browser. */
      projectSlug: string;
      projectPath: string;
      missingProject: boolean;
      notSyncedYet: boolean;
    }
  | { status: 'unknown'; query: string }
  | { status: 'ambiguous'; query: string; candidates: string[] };

export type ChatsearchResolveResponse =
  | { ok: true; results: ResolvedConversation[] }
  | { ok: false; error: string };

/** One transcript message as the preview renders it. */
export interface TranscriptMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  /** Byte offset of this message's line in its transcript: increasing through
   *  the conversation and unique within it, so it keys a bubble and
   *  `before: seq` pages backwards. Not a message count — reading only the end
   *  of a large file (transcript-reader.ts) means nobody counted from the top. */
  seq: number;
  /** Tool calls that ran between the previous kept message and this one. */
  droppedToolCalls: number;
}

export interface ChatsearchReadRequest {
  provider: ChatsearchProvider;
  id: string;
  /** Messages to return, counted back from the end (or from `before`). 1..200. */
  tail: number;
  /** Return messages with seq < before. Omit for the newest slice. */
  before?: number;
  /** The project folder's slug when the caller already knows it (a Resume
   *  list row does). Lets main open the file directly instead of looking the id
   *  up in the search index; validated there, and a wrong or stale hint only
   *  falls back to that lookup. */
  projectSlug?: string;
}

export type ChatsearchReadResponse =
  | { ok: true; messages: TranscriptMessage[]; hasMore: boolean }
  | { ok: false; error: string };

export const READ_TAIL_MAX = 200;
export const READ_TAIL_DEFAULT = 40;

/**
 * Output that reached us may be partial. Three producers, three markers:
 * the native harness (main/harness/tools/truncate.ts) by chars and by lines,
 * and Claude Code, which truncates long tool results in the transcript.
 */
export const TRUNCATION_MARKERS = ['[...]', '[... ', 'characters truncated]'] as const;

export type ChatsearchCall =
  | { cmd: 'find'; shortIds: string[]; query: string }
  | { cmd: 'show'; id: string; provider: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// A find row: <short id>  <yyyy-mm-dd | ---------->  … — the id is a uuid
// prefix (hex and dashes, ≥4 chars, chatsearch.js MIN_SHORT_ID); the CLI prints
// ten dashes when the date is unknown (chatsearch.js:63). formatRows() pads
// every column with padEnd(widestInColumn) and joins columns with TWO spaces
// (chatsearch.js:341), so real rows always carry >=2 spaces after the id —
// this must stay \s{2,}, not \s+, or the regex would start matching prose.
const FIND_ROW_RE = /^([0-9a-f-]{4,36})\s{2,}(?:\d{4}-\d{2}-\d{2}|-{10})\s{2,}/;

export function parseFindShortIds(output: string): string[] {
  const ids: string[] = [];
  for (const line of output.split('\n')) {
    const m = FIND_ROW_RE.exec(line);
    if (m) ids.push(m[1]);
  }
  return ids;
}

export function parseShowId(output: string): { id: string; provider: string } | null {
  const lines = output.split('\n');
  // WHY scan instead of reading lines[0]: cmdShow (chatsearch.js:782) pushes a
  // staleness banner and then index.problems onto the output BEFORE the
  // metadata block, so the uuid line is frequently NOT the first line of real
  // output. Scan for the first line whose first token is a full uuid instead.
  const idLineIdx = lines.findIndex((l) => UUID_RE.test(l.trim().split(/\s+/)[0] ?? ''));
  if (idLineIdx < 0) return null;
  const id = lines[idLineIdx].trim().split(/\s+/)[0];
  const provLine = lines.slice(idLineIdx + 1).find((l) => l.startsWith('provider:'));
  return { id, provider: provLine ? provLine.slice('provider:'.length).trim() : '' };
}

/**
 * The words the model searched for, read off the request it sent the CLI.
 * The request is JSON — on the command line or in a heredoc — so this looks for
 * the `query` field in either. Returns '' when it cannot read one, and the card
 * then shows no line at all: an invented search term would misrepresent what
 * Claude did.
 */
export function parseFindQuery(command: string): string {
  const m = /"query"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(command);
  if (!m) return '';
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return m[1];
  }
}

/** Does this command run chatsearch with its stdout intact? Decidable from the
 *  command alone, so ToolCard can expand the card before the output exists. */
export function isChatsearchCommand(command: string): boolean {
  const idx = command.indexOf('chatsearch.js');
  if (idx < 0) return false;
  // Anything after the script that pipes or redirects stdout means the output
  // we hold may be partial — never build a card on it. `2>&1` loses nothing.
  // The stdin heredoc form (`cat <<'JSON' | node …chatsearch.js`) pipes INTO
  // the script, which is fine, so only the text AFTER the script is inspected.
  const after = command.slice(idx + 'chatsearch.js'.length).replace(/2>&1/g, '');
  return !/[|>]/.test(after);
}

/**
 * Is this tool call a finished chatsearch invocation whose output can be
 * turned into a card? Returns null for "render it as plain Bash".
 */
export function describeChatsearchCall(tool: ToolCallState): ChatsearchCall | null {
  if (tool.toolName !== 'Bash') return null;
  const command = typeof tool.input?.command === 'string' ? tool.input.command : '';
  if (!isChatsearchCommand(command)) return null;
  if (tool.status !== 'complete') return null;
  const output = tool.response ?? '';
  if (!output.trim()) return null;
  if (TRUNCATION_MARKERS.some((m) => output.includes(m))) return null;
  // The subcommand is read from the OUTPUT, never the command line: `cmd`
  // defaults to find when absent and the request may arrive on stdin.
  const show = parseShowId(output);
  if (show) return { cmd: 'show', ...show };
  const shortIds = parseFindShortIds(output);
  return shortIds.length ? { cmd: 'find', shortIds, query: parseFindQuery(command) } : null;
}
