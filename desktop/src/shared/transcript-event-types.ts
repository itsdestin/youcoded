// Transcript event types (M5, one-core R4-4): the nested payload types, one payload
// interface per event type, and the `TranscriptEvent` union keyed on `type`. Split out
// of shared/types.ts to keep that file inside its line budget; types.ts re-exports all
// of it (`export *`), so every importer keeps using '../shared/types'.
import type { TranscriptEventType, InjectedMeta, StructuredPatchHunk, CcBackgroundRun } from './types';

/**
 * Token + cache usage as it rides transcript events (message.usage). Named, not
 * inline, so `usageProgress` and the typed producers can refer to it without
 * reaching back through TranscriptEvent['data'] (M5: that self-reference stops
 * compiling once `data` becomes a union).
 */
export interface TranscriptUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Native runtime only: output tokens / stream seconds. CC never reports this. */
  tokensPerSecond?: number;
  /** Native runtime only: the session's REAL context window (resolved in main,
   *  Task 4/5). Carried on the per-turn payload so the renderer's StatusBar can
   *  compute context % without a separate IPC. Constant per session; CC omits it. */
  contextLength?: number | null;
  /** Native runtime only: tokens OCCUPYING the window after this turn — the
   *  last step's prompt plus its output. Distinct from inputTokens, which
   *  sums every step and therefore re-counts the history once per step. */
  contextUsedTokens?: number;
  /** Transient native progress only: no legacy in+out context fallback.
   *  Not set on completed turns (including old transcript records). */
  liveProgress?: true;
  /** Native runtime only (cache follow-ups item 8, 2026-09-10): true when a
   *  request in this turn followed something the harness itself did to the
   *  prompt prefix — a prune commit, a summary compaction, a model swap — so
   *  a low cache-read figure on this turn is the known price of that event,
   *  not a regression. Low reads WITHOUT this flag are the thing to
   *  investigate. */
  expectedRebuild?: boolean;
  /** Native runtime only: USD for THIS turn, priced at the model that ran
   *  it. `null` means the model has no published price — distinct from
   *  absent, which means no pricing information at all (a Claude Code turn).
   *  The renderer sums these; it never multiplies tokens by a rate itself. */
  costUsd?: number | null;
  /** Native runtime only: this turn ran on a model that costs nothing to
   *  run — a local engine, or a metered model published at a rate of zero.
   *  Deliberately NOT the same as `costUsd: null`, which means "metered,
   *  but no published rate": the status bar words the two differently
   *  ("runs on your machine" vs "no published price"). Only main can tell
   *  them apart — it is the only side that knows the provider type. */
  free?: boolean;
  /** Native runtime only, and only where the provider reports one: the USD
   *  figure the PROVIDER ITSELF charged for this turn's requests. Today only
   *  OpenRouter-shaped providers report a cost, so this is ABSENT on a local
   *  model, an Anthropic or OpenAI key, and a plain OpenAI-compatible
   *  endpoint.
   *
   *  Absent means "the provider told us nothing" — never $0, and never
   *  "we checked and it matched". A reported 0 (a genuinely free model) is
   *  a real reading and is kept as 0, which is why this is `number` and not
   *  `number | null`: unlike costUsd there is no third state to spell.
   *
   *  Present ONLY when every step of the turn reported one, so it always
   *  covers exactly the same steps as `costUsd` and the two can be compared
   *  honestly. Diagnostic: main compares them and logs a gap; nothing in
   *  the UI reads this. */
  providerCostUsd?: number;
}

/** A portable compaction checkpoint (see `compact-summary`): references cite persisted parts, never copied text. */
interface CompactionRecord {
  v: 1;
  generation: number;
  sourceRevision: number;
  /** Hash of the source transcript plus the claimed cut; no copied text. */
  sourceDigest?: string;
  resumeFrom: { eventUuid: string; anchorUuid: string; type: TranscriptEventType; partId?: string; start: number; end: number };
  coveredThrough: { eventUuid: string; anchorUuid: string; type: TranscriptEventType; partId?: string; start: number; end: number };
}

/** A `background-task` event's payload: which task(s) ended and how. `taskIds` is a list because Claude Code reports several orphaned commands in one notice on resume. */
interface BackgroundTaskEnd { taskIds: string[]; status: Exclude<CcBackgroundRun['status'], 'running'>; summary?: string; result?: string }

/** One coalesced-part UUID/range witness (see `assistant-text`.deltaReferences). */
interface DeltaRef { eventUuid: string; start: number; end: number }

interface StallWarning { retryInMs: number; willRetry: boolean }

interface PromptProcessing { promptTokens: number; budgetMs: number; source?: 'prompt' | 'tool-output'; processed?: number; cached?: number; etaMs?: number | null; timeMs?: number }

interface ToolPreparing { toolCallId: string; toolName: string; chars: number; cleared?: boolean }

// --- Transcript event payloads, one shape per event type (M5, one-core R4-4) ---
//
// WHY a union keyed on `type` instead of one bag of optional fields: the old
// `data` bag let any producer put any field on any event and let any consumer
// read any field off any event, so a typo or a field nobody sends compiled fine
// and read `undefined` at runtime. Now each type carries exactly its own fields
// and the compiler checks producers and consumers. Fields that only SOME
// producers set (Claude Code vs the native runtime vs Kotlin's subset) stay
// optional on purpose — see each field's note.

/** Stamped by the subagent watchers onto the events a specialist's own JSONL
 *  produces, so the reducer can thread them under the Agent card that started
 *  the specialist. Absent on every top-level event. */
interface SubagentStamp {
  /** The parent Agent tool_use this subagent's work threads into. */
  parentAgentToolUseId?: string;
  /** Stable subagent ID — matches the filename agent-<agentId>.jsonl on disk. */
  agentId?: string;
}

/** Native streaming parts: deltas of one part share a `partId` and are merged
 *  in the reducer and coalesced in the session store. */
interface StreamPart {
  /** Streaming-part id used to merge chunks; emitted by the native harness, not CC's watcher. */
  partId?: string;
  /** Persisted coalesced-part UUID/range witness; no duplicate text or private metadata. */
  deltaReferences?: DeltaRef[];
}

interface UserMessageData extends SubagentStamp {
  text: string;
  /** A slash command read from its command tags. The chat starts no turn for
   *  it, because many commands get no reply (2026-09-11). */
  slashCommand?: boolean;
  /** Native: absolute composer attachment paths, persisted so resume can
   *  re-read the pixels (events carry no binary). #290 follow-up fix 2. */
  attachments?: string[];
  /**
   * Task 4 (native specialists, background execution) — marks this as a
   * SYNTHETIC turn the host injected (a background specialist's finished
   * report, or its typed failure notice), not something the user actually
   * typed. The reducer stamps it on the timeline entry, and ChatView/BubbleFeed
   * draw it as a compact card instead of a user bubble — the text is what the
   * PARENT MODEL reads, and showing it as the user's own words put text in the
   * chat nobody actually said (Destin, 1b hands-on).
   * Values today: 'specialist-report', 'shell-running' (a background command
   * still going at a 5/15-minute mark — a plain note, never a card) and
   * 'shell-complete' (G-1: a background command finished or was stopped); a
   * plain `string` so a future injected kind never needs a schema change.
   */
  injected?: string;
  /** Structured companion to `injected` (2026-08-16): who finished, what they
   *  were asked, how it ended — so the card header is exact rather than parsed
   *  back out of the prose the model reads. */
  injectedMeta?: InjectedMeta;
  /** Byte offset of this JSONL line's start in the transcript file, stamped by
   *  the paged-history reader (transcript-page.ts). The seed for a future
   *  eviction cursor (cycle 3); unused today. Absent on live-tailer events,
   *  which never know their own offset. */
  offset?: number;
}

interface UserInterruptData extends SubagentStamp {
  /** Claude Code only. Distinguishes the two marker strings it writes:
   *  `[Request interrupted by user]` (plain) vs `... for tool use` (tool-use).
   *  The native runtime omits it, so it MUST stay optional. */
  kind?: 'plain' | 'tool-use';
  /** Native only: the abandoned turn's usage, when any tokens were measured. */
  usage?: TranscriptUsage;
}

interface AssistantTextData extends SubagentStamp, StreamPart {
  text: string;
  /** Model ID that wrote it (CC and Kotlin; the native runtime puts it on turn-complete). */
  model?: string;
}

interface ToolUseData extends SubagentStamp {
  toolUseId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}

interface ToolResultData extends SubagentStamp {
  toolUseId: string;
  toolResult: string;
  isError: boolean;
  /** Native only: the tool's name (CC's result line does not carry it). */
  toolName?: string;
  /** Edit/MultiEdit tool-result payloads carry structuredPatch hunks. */
  structuredPatch?: StructuredPatchHunk[];
  /** Claude Code only: this call started work that keeps going in the
   *  background (an Agent's `agentId`, or a Bash command's `backgroundTaskId`),
   *  so the result is a launch receipt, not the outcome. The outcome arrives
   *  later as a 'background-task' event. */
  backgroundTaskId?: string;
  /** Claude Code SendMessage only: the finished helper it resumed
   *  (`toolUseResult.resumedAgentId`) — that helper's card works again. */
  resumedTaskId?: string;
  /** Native only: absolute paths of images the tool delivered (Read on an
   *  image). Resume re-reads them; the UI may render a chip. */
  images?: string[];
  /** Claude Code only: the JSONL line's OWN timestamp (epoch ms), 0 when the
   *  line has none. `timestamp` on the event is stamped at PARSE time, which is
   *  "now" for a whole transcript read from offset 0 on resume — so it cannot
   *  tell replayed history from a live result. The Deliverables auto-open rule
   *  (deliverable-auto-open.ts) reads this; native events keep their original
   *  `timestamp` through replay and need no field. */
  recordedAt?: number;
}

/**
 * `assistant-thinking` is deliberately ONE variant with optional fields, not one
 * per payload (the native-session-host emit surface is frozen on this type).
 * The payloads that ride it, each with no other field set:
 *   reasoning {text, partId} · heartbeat {} · {stallWarning} · {stalled} ·
 *   {promptProcessing} · {toolPreparing} · {dropPart} · {usageProgress}
 */
interface AssistantThinkingData extends SubagentStamp, StreamPart {
  text?: string;
  /** Native only. Set on a heartbeat when the streaming watchdog has seen NO
   *  chunk for STALL_WARNING_MS. Drives the ThinkingIndicator's "taking a
   *  while… retrying" countdown. `willRetry` = the harness will auto-retry the
   *  step when the countdown ends; false ends it with a session-error on Clock 1
   *  alone, or PARKS the turn (see `stalled`). A heartbeat WITHOUT this field
   *  means activity resumed and clears the warning. */
  stallWarning?: StallWarning;
  /** Native root-turn measured, cumulative usage after a completed request.
   *  Transient, never a transcript line. Unlike turn-complete,
   *  contextUsedTokens is absent without a measured prompt. */
  usageProgress?: TranscriptUsage;
  /** Native only. The mid-stream watchdog gave up waiting and the turn is now
   *  PARKED: the stream reader is still open and the turn ends only when a
   *  chunk arrives or the user presses Retry / Stop. Display-only. A bare
   *  `true`, not a timestamp: the renderer stamps its own clock on first
   *  receipt, so a remote client never inherits clock skew from the host. */
  stalled?: true;
  /** Native only. Discard these streaming parts — the attempt that wrote them
   *  is being abandoned by a manual Retry, and the re-run would otherwise
   *  APPEND to the same bubble (the SDK's part id falls back to the literal
   *  'text-0'). This is why the automatic retry refuses to run after content
   *  streamed; the manual one erases first. Display-only on the wire, but the
   *  session store DOES persist it as a tombstone so a part already flushed to
   *  disk is excluded on restart (session-store.ts append). */
  dropPart?: { partIds: string[] };
  /** Native only. Emitted the moment a step's stream opens, BEFORE any token
   *  arrives, so the UI can say the model is reading the prompt rather than
   *  showing an idle spinner. `budgetMs` is how long prefill is allowed to
   *  take before the watchdog treats the silence as a real stall. */
  promptProcessing?: PromptProcessing;
  /** Native only. The model is GENERATING a tool call's arguments — nothing has
   *  executed yet. Rides with NO text and NO partId so SessionStore.append
   *  drops it: partial arguments must never reach the JSONL. */
  toolPreparing?: ToolPreparing;
}

interface TurnCompleteData extends SubagentStamp {
  stopReason?: string;
  /** Model ID used for the completing turn (e.g. "claude-opus-4-7"). */
  model?: string;
  /** Anthropic API request id from the JSONL line's top-level `requestId`. */
  anthropicRequestId?: string;
  usage?: TranscriptUsage;
}

interface CompactSummaryData extends SubagentStamp {
  /** The full text of the compaction summary, pre-stripped of system tags. The
   *  reducer attaches it to the SystemMarker so the user can click-to-expand. */
  summary?: string;
  /** Native only: set on a SPONTANEOUS two-stage compaction (spec §4.4). CC
   *  never sets it. Without it a native auto-compaction would replace ~all
   *  history and show NOTHING. */
  autoCompaction?: boolean;
  /** Native only: the user-message event opening the kept tail's turn (null =
   *  unknown). Its PRESENCE tells the renderer this compaction kept a tail. */
  retainedFromUuid?: string | null;
  /** Native only: tokens OCCUPYING the window once the rewrite has landed, and
   *  what it occupied just before. Their OWN fields rather than inside `usage`:
   *  that block is the summarize REQUEST's bill, a different measurement. These
   *  are the measured count re-based by the estimated size of what the rewrite
   *  removed (harness-session.ts → reprojectContextUsed). The status bar's
   *  context gauge re-bases on `contextUsedAfter`; the compaction marker
   *  subtracts the pair. `contextUsedBefore` is absent when the session had
   *  never measured a window. */
  contextUsedAfter?: number;
  contextUsedBefore?: number;
  /** Native only: the summary call's OWN bill (a separate request). */
  usage?: TranscriptUsage;
  compactionRecord?: CompactionRecord;
}

/** Terminal marker appended by the TRANSCRIPT_REPLAY handler — never parsed from
 *  a transcript, never persisted. DECLARED (not just commented) because producer
 *  (ipc-handlers.ts) and consumers (App.tsx, BubbleFeed.tsx) were otherwise
 *  linked by nothing but a matching string literal through an `any`: a typo read
 *  undefined → false and silently disabled the orphan reap (PR #287, 2026-08-10). */
interface ReplayCompleteData {
  /** Whether main could AFFIRM the session has no work in flight. Gates the
   *  reducer's orphan reap — a re-docked mid-turn session's running tool is
   *  real and must not be failed. Only NativeSessionHost can answer; CC reports false. */
  sessionIdle: boolean;
}

interface SessionErrorData {
  /** The human-readable failure message. */
  text: string;
  /** Which known failure `text` is (e.g. 'openrouter-key-rejected'), so the
   *  error card can offer the one action that fixes it. Absent = show text as is. */
  errorCode?: string;
  /** The abandoned turn's usage, when any tokens were measured. */
  usage?: TranscriptUsage;
}

interface ContextClearData {
  /** Tokens occupying the window once /clear landed (see CompactSummaryData.contextUsedAfter). Old lines are `{}`. */
  contextUsedAfter?: number;
}

interface SkillInvokedData {
  /** The resolved, qualified id (wecoded-themes-plugin:theme-builder). */
  skillId: string;
  displayName: string;
  args?: string;
  /** The SKILL.md text that enters model history on rebuild; deliberately NOT rendered. */
  body: string;
  /** Lets the card open the real file in the artifact viewer. */
  skillPath?: string;
}

interface SubagentUsageData {
  /** The child's summed usage (with its own costUsd/free). */
  usage: TranscriptUsage;
  model: string;
  parentAgentToolUseId: string;
  agentId: string;
}

interface BackgroundTaskData extends SubagentStamp {
  /** The launching call, when Claude Code names it. */
  toolUseId?: string;
  backgroundTask: BackgroundTaskEnd;
}

/** The one place each event type is tied to its payload. */
interface TranscriptDataMap {
  'user-message': UserMessageData;
  'user-interrupt': UserInterruptData;
  'assistant-text': AssistantTextData;
  'tool-use': ToolUseData;
  'tool-result': ToolResultData;
  'assistant-thinking': AssistantThinkingData;
  'turn-complete': TurnCompleteData;
  'compact-summary': CompactSummaryData;
  'replay-complete': ReplayCompleteData;
  'session-error': SessionErrorData;
  'context-clear': ContextClearData;
  'skill-invoked': SkillInvokedData;
  'subagent-usage': SubagentUsageData;
  'background-task': BackgroundTaskData;
}

/** The payload for event type `T`. */
export type DataOf<T extends TranscriptEventType> = TranscriptDataMap[T];

/** The whole event for type `T`, for helpers that handle one kind. */
export type EventOf<T extends TranscriptEventType> = Extract<TranscriptEvent, { type: T }>;

/** Every event type as its own `{type, data}` member, so `switch (event.type)` narrows `data`. */
export type TranscriptEvent = {
  [K in TranscriptEventType]: {
    type: K;
    sessionId: string; // desktop session ID
    /** The JSONL line's uuid — used for deduplication */
    uuid: string;
    timestamp: number;
    data: TranscriptDataMap[K];
  };
}[TranscriptEventType];

/** The event types a specialist's own JSONL can produce, i.e. the ones that carry
 *  the SubagentStamp. Excludes the types only the host/main mints at the top
 *  level (replay-complete, session-error, context-clear, skill-invoked,
 *  subagent-usage), which is how a stamped one of THOSE becomes a type error. */
type StampableEventType = Exclude<TranscriptEventType,
  'replay-complete' | 'session-error' | 'context-clear' | 'skill-invoked' | 'subagent-usage'>;
export type StampableEvent = EventOf<StampableEventType>;

/** Tag a specialist's event with the Agent call that started it (and which
 *  specialist spoke), as a COPY — the original is never mutated. ONE place for
 *  the stamp so SubagentWatcher (Claude Code) and NativeSessionHost's
 *  mergeChildEvents/wireChildLive (native) cannot drift apart. */
export function stampSubagent<E extends StampableEvent>(event: E, parentAgentToolUseId: string, agentId: string): E {
  return { ...event, data: { ...event.data, parentAgentToolUseId, agentId } };
}

type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I : never;

/** Every payload field of every event type, all optional — for the DELIBERATELY
 *  type-blind readers (the chat-search indexer, the session namer, the session
 *  store's generic paths, eventText) that look at whichever fields happen to be
 *  there without caring which event type they came from. Assigning a typed
 *  payload to this needs no cast. */
export type LooseTranscriptData = Partial<UnionToIntersection<TranscriptDataMap[TranscriptEventType]>>;

/** Upcast a typed payload to the loose view. No cast: each member is a subtype. */
export function looseData(event: Pick<TranscriptEvent, 'data'>): LooseTranscriptData {
  return event.data;
}
