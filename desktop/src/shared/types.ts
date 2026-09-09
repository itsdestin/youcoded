import type { CatalogMeta } from './catalog-types';

// 'auto' is Claude Code's classifier-backed mode (CC v2.1.83+, March 2026).
// Sits between 'auto-accept' (only file edits + 7 safe bash) and 'bypass'
// (no checks): a background classifier blocks risky actions like mass deletion
// or curl|bash. Plan-gated by Anthropic — only surfaced in the Shift+Tab cycle
// when the session is running on Opus 4.7 1M.
export type PermissionMode = 'normal' | 'auto-accept' | 'plan' | 'auto' | 'bypass';

// Advanced permission overrides for bypass mode. Controls which PermissionRequest
// categories are auto-approved when --dangerously-skip-permissions is active.
// These only affect the small set of requests that bypass mode still fires:
// protected path writes, compound cd commands, etc.
export interface PermissionOverrides {
  approveAll: boolean;            // Blanket approve everything (except AskUserQuestion)
  protectedConfigFiles: boolean;  // .bashrc, .gitconfig, .mcp.json, etc.
  protectedDirectories: boolean;  // .git/, .claude/ (non-exempt paths)
  compoundCdRedirect: boolean;    // cd + output redirection (path resolution bypass)
  compoundCdGit: boolean;         // cd + git (bare repository attack protection)
}

export const PERMISSION_OVERRIDES_DEFAULT: PermissionOverrides = {
  approveAll: false,
  protectedConfigFiles: false,
  protectedDirectories: false,
  compoundCdRedirect: false,
  compoundCdGit: false,
};

// Which runtime backend powers a session — defaults to 'claude'.
// 'claude'  = Claude Code CLI over PTY (the original path).
// 'native'  = YouCoded's first-party harness (Phase 1+ of the platform
//             roadmap; dormant until window.claude.native.supported is true).
// 'shell'   = a plain terminal — the user's own $SHELL (Windows:
//             powershell.exe) with NO AI in it at all: no hook pipe, no
//             transcript watcher, no model. It exists so the app can offer
//             "Run in terminal" for a set-up command (engine:run-in-terminal)
//             instead of sending the user off to find a terminal themselves.
//             Never offered in the new-session form — only that button makes
//             one, and it selects the session it made, so every renderer branch
//             that reads a provider CAN see 'shell'.
// 'gemini' was removed 2026-07-10 — Google discontinued the Gemini CLI
// (June 2026); Gemini models are reachable through the native runtime via
// OpenRouter or a direct Google key instead.
export type SessionProvider = 'claude' | 'native' | 'shell';

// A model reference portable ACROSS devices — persisted on a Conversation Store
// record (conversations/store-core.ts) so the resume selector can pre-fill
// without a round-trip. Deliberately NOT the device-local providerId ULID: that
// ULID only resolves via THIS device's ~/.youcoded/providers.json, so
// persisting it would silently break resume on every OTHER synced device.
// modelId/providerType/providerLabel are the portable identity a peer device
// can re-resolve (or just display).
//
// Lives here (shared/types.ts), not conversations/store-core.ts, because
// PastSession below needs it and shared/ must never import FROM main/ (main →
// shared is the only legal direction — see SessionProvider above for the same
// pattern). store-core.ts re-exports this type so its existing importers
// (conversation-store.ts, service.ts, portable-model.ts, ipc-handlers.ts)
// didn't need to change their import paths.
export interface PortableModelRef {
  modelId: string;
  providerType: string;
  providerLabel: string;
}

// M1: ack shape for native:send — 'sent' = turn dispatched now, 'queued' = FIFO'd
// behind the in-flight turn, 'failed' = refused (reason says why, exactly).
// Task 11 (cancel/edit queued messages): the 'queued' arm carries the host-
// minted queueId (NativeSessionHost.send()'s randomUUID()) so the renderer can
// target this exact entry later with native:queue-remove.
export type NativeSendResult =
  | { status: 'sent' }
  | { status: 'queued'; queueId: string }
  // 'starting' vs 'not-live' are DIFFERENT SITUATIONS and must never be merged
  // back into one code: 'not-live' is a session that has ended or was never
  // created, 'starting' is one that has not finished starting yet (a big local
  // model can take a minute to load). One code for both is what told Destin a
  // brand-new session was "no longer running" — see NativeSessionHost.startingSends.
  | { status: 'failed'; reason: 'not-live' | 'queue-full' | 'starting' };

export interface SessionInfo {
  id: string;
  name: string;
  cwd: string;
  permissionMode: PermissionMode;
  skipPermissions: boolean;
  status: 'active' | 'idle' | 'destroyed';
  createdAt: number;
  /** Which runtime backend this session runs — 'claude' (default), 'native' or 'shell' */
  provider: SessionProvider;
  /** provider='shell' only: the shell that was actually spawned, already
   *  display-shaped ('fish', 'zsh', 'powershell'). The session strip and the
   *  header label the session with this — a shell session has no model and no
   *  harness preset, so it would otherwise wear Claude Code's runtime label. */
  shellName?: string;
  /** Native runtime only: the RESOLVED harness preset id ('assistant' | 'coder',
   *  post legacy-mapping — a stored 'chat' header resolves to 'assistant'). Drives
   *  the renderer's preset badge. Absent for Claude sessions. */
  harnessId?: string;
  /** Model alias the session was started with (e.g. 'claude-sonnet-4-6') */
  model?: string;
  /** Native runtime only: which KIND of provider the bound model runs on
   *  ('chatgpt' | 'openrouter' | 'local-engine' | …), as main already resolves
   *  it in conversations/portable-model.ts.
   *
   *  WHY the renderer needs it rather than looking the model up itself: two
   *  providers can offer the same model id — a personal OpenAI API key and the
   *  ChatGPT plan both list `gpt-5.5`. Looked up by id alone, a conversation
   *  spending API credit can be shown the ChatGPT plan's usage numbers and told
   *  they are "measured across your whole ChatGPT plan". Only the session knows
   *  which one it is actually billed to. Absent for Claude sessions, and for
   *  any native session main has not stamped yet — the renderer then falls back
   *  to the catalog lookup and reports nothing when the id is ambiguous. */
  providerType?: string;
  /** Optional text to prefill into the input bar after this session is selected.
   *  Consumed once by InputBar on first render after session switch; cleared via
   *  a consumed-set ref so it never re-fires on re-renders. */
  initialInput?: string;
}

export interface HookEvent {
  type: string;
  sessionId: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

// --- Transcript watcher types ---

export type TranscriptEventType =
  | 'user-message'
  | 'assistant-text'
  | 'tool-use'
  | 'tool-result'
  | 'thinking'
  // Extended-thinking models emit `thinking` blocks between tool calls that
  // carry no chat text — the watcher surfaces them as heartbeats so the
  // attention classifier doesn't misread the silence as 'stuck'.
  | 'assistant-thinking'
  | 'turn-complete'
  // Emitted when Claude Code writes a {type:"user", isCompactSummary:true}
  // entry — the canonical "compaction finished" signal. In-session /compact
  // appends to the SAME file (no shrink), so we can't use file-size heuristics.
  | 'compact-summary'
  // Emitted when Claude Code writes a user-interrupt marker ("[Request
  // interrupted by user]" / "...for tool use"), produced when the user
  // presses ESC during a turn. The reducer uses this to end the turn
  // without rendering the marker as a user bubble.
  | 'user-interrupt'
  // Terminal marker appended by the TRANSCRIPT_REPLAY handler after the last
  // historical event — NEVER parsed from a transcript, so it is not persisted
  // and cannot be replayed twice. A transcript ends wherever the process died,
  // so a tool_use with no result replays as a card that spins forever after a
  // resume (Destin, 2026-08-09 dogfood). This event is the "history is over"
  // barrier the reducer needs to reap those orphans.
  // `data.sessionIdle` says whether main can AFFIRM nothing is in flight: the
  // same replay also fires when a window re-docks a live, mid-turn session,
  // where the running tool is real and must not be failed.
  | 'replay-complete'
  // Native-runtime only: a provider/stream failure ended the turn. Carries the
  // human-readable message in data.text. Never emitted by CC's transcript
  // watcher and never persisted to the native session store (stale on resume).
  | 'session-error'
  // Native-runtime only: /clear's CONTEXT BARRIER (M3 item 2). The native
  // session log is append-only with a write-once header, so "clear" cannot
  // erase anything — it appends this marker instead, and everything before it
  // is ignored when history is rebuilt. The conversation therefore keeps its
  // identity and stays fully readable on disk while the model's memory resets.
  // Unlike session-error this IS persisted: a barrier that vanished on resume
  // would silently resurrect the context the user deliberately dropped.
  | 'context-clear'
  // Native-runtime only: a user-invoked skill (/skill-name, M3 item 1). Persisted
  // because the skill's instructions ARE part of the model's history — a resume
  // that dropped them would replay a conversation whose first move makes no sense.
  // `data.body` carries those instructions for history rebuild; the UI renders
  // only `skillId`/`displayName`/`args` as a compact card, because a 26k-character
  // SKILL.md as a user bubble is unreadable (Destin, 2026-07-28). `skillPath`
  // makes the card open the real file in the artifact viewer.
  | 'skill-invoked'
  // Native-runtime only: one finished specialist's TOTAL spend, reported to the
  // PARENT session so the parent's status bar can count work it delegated
  // (spec §2/§8). Carries the child's summed `usage` (with its own costUsd/free),
  // its `model`, the `parentAgentToolUseId` of the Task call that started it, and
  // its `agentId`. Persisted on the parent, so replay restores it exactly like a
  // tool card — the totals are rebuilt from the record, so a resumed session must
  // not forget the specialists it ran.
  // NOT a forwarded child turn-complete: SUBAGENT_DISPLAY_TYPES deliberately
  // withholds that copy, because a stamped one would end the PARENT's turn in the
  // reducer and attribute the child's model to the parent. Bookkeeping only — it
  // never enters the timeline and never enters model history (history-rebuild.ts's
  // default branch drops it).
  | 'subagent-usage';

/**
 * Opaque-to-the-renderer handle for "the page before this one". `offset` is the
 * byte at which the page it came from STARTS, so the next (older) page is read
 * with `endOffset = offset`. For NATIVE sessions the same field carries an array
 * index instead of a byte offset — the renderer never inspects it either way.
 * `sizeAtRead` lets the reader notice a /clear or /compact rewrite.
 */
/** Payload for the TRANSCRIPT_PAGE request. `beforeCursor: null` = newest page. */
export interface TranscriptPageRequest {
  sessionId: string;
  beforeCursor: PageCursor | null;
  /**
   * Fallback locator, used ONLY when the transcript watcher does not know this
   * session yet. A just-resumed Claude Code session has no watched entry until
   * CC's hook reports its transcript path, which is after the renderer wants to
   * paint history — so the resume path passes the ids it already has and the
   * handler resolves ~/.claude/projects/<slug>/<claudeSessionId>.jsonl itself.
   */
  claudeSessionId?: string;
  projectSlug?: string;
}

export interface PageCursor {
  path: string;
  offset: number;
  sizeAtRead: number;
}

/** One page of conversation history, oldest -> newest within the page. */
export interface TranscriptPageResult {
  events: TranscriptEvent[];
  /** The handle for the NEXT (older) page; null when hasMore is false. */
  cursor: PageCursor | null;
  hasMore: boolean;
  /**
   * "I could not locate this session's transcript", as distinct from "you have
   * reached the beginning of the conversation" — which is what an empty page
   * with hasMore:false otherwise means, and which the renderer treats as final.
   *
   * These two were the same answer until 2026-09-07, so a transcript that was
   * merely not locatable YET (a just-resumed CC session before its hook lands,
   * a session whose process has exited, the buddy floater) permanently ended
   * the conversation's scroll-back in that window. A caller must RETRY on this,
   * never record it. Absent means the answer is real.
   */
  unresolved?: true;
}

export interface TranscriptEvent {
  type: TranscriptEventType;
  sessionId: string; // desktop session ID
  /** The JSONL line's uuid — used for deduplication */
  uuid: string;
  timestamp: number;
  data: {
    text?: string;
    toolUseId?: string;
    toolName?: string;
    toolInput?: Record<string, unknown>;
    toolResult?: string;
    isError?: boolean;
    stopReason?: string;
    /** Edit/MultiEdit tool-result payloads carry structuredPatch hunks. */
    structuredPatch?: StructuredPatchHunk[];
    /** Native user-message events: absolute composer attachment paths, persisted so
     *  resume can re-read the pixels (events carry no binary). #290 follow-up fix 2. */
    attachments?: string[];
    /** Native tool-result events: absolute paths of images the tool delivered
     *  (Read on an image). Resume re-reads them; the UI may render a chip. */
    images?: string[];
    /** Claude Code tool-result events only: the JSONL line's OWN timestamp
     *  (epoch ms), 0 when the line has none. `timestamp` above is stamped at
     *  PARSE time, which is "now" for a whole transcript read from offset 0 on
     *  resume — so it cannot tell replayed history from a live result. The
     *  Deliverables auto-open rule (deliverable-auto-open.ts) reads this; native
     *  events keep their original `timestamp` through replay and need no field. */
    recordedAt?: number;
    /** Byte offset of this JSONL line's start in the transcript file, stamped by
     *  the paged-history reader (transcript-page.ts) on user-message events.
     *  The seed for a future eviction cursor (cycle 3); unused today. Absent on
     *  live-tailer events, which never know their own offset. */
    offset?: number;
    // Task 1.1: widened turn-complete payload so the reducer can attach the
    // per-turn model, token/cache usage, and the Anthropic requestId to the
    // completing AssistantTurn for UI surfacing. All optional — the field is
    // shared across event types, and turn-complete is the only current writer.
    /** Model ID used for the completing turn (e.g. "claude-opus-4-7"). */
    model?: string;
    /** Anthropic API request id from the JSONL line's top-level `requestId`. */
    anthropicRequestId?: string;
    /** Token + cache usage snapshot from message.usage. */
    usage?: {
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
    };
    /**
     * Populated only on events emitted from a subagent JSONL — identifies
     * the parent Agent tool_use that this subagent's work threads into.
     */
    parentAgentToolUseId?: string;
    /**
     * Task 4 (native specialists, background execution) — marks a `user-message`
     * event as a SYNTHETIC turn the host injected (a background specialist's
     * finished report, or its typed failure notice), not something the user
     * actually typed. Data-field extension, not a new TranscriptEventType — the
     * frozen emit surface stays frozen.
     *
     * CONSUMED by the renderer since 2026-08-16: App.tsx/BubbleFeed.tsx forward
     * it onto TRANSCRIPT_USER_MESSAGE, the reducer stamps it on the timeline
     * entry, and ChatView/BubbleFeed draw such an entry as a compact
     * SpecialistReportCard (a collapsed "task finished" row, tool-card style)
     * instead of a user bubble — the text is what the PARENT MODEL reads, and
     * showing it as the user's own words, or even as a big notice, put text in
     * the chat nobody actually said (Destin, 1b hands-on).
     * Values today: 'specialist-report' (a background helper's report) and
     * 'shell-complete' (G-1: a background command finished or was stopped by
     * the user); a plain `string` (not a union) so a future injected kind never
     * needs a TranscriptEvent schema change.
     */
    injected?: string;
    /**
     * Structured companion to `injected: 'specialist-report'` (2026-08-16):
     * who finished, what they were asked, how it ended — so the card header
     * is exact rather than parsed back out of the prose the model reads.
     * `parentToolCallId` names the Task card that started this child.
     */
    injectedMeta?: InjectedMeta;
    /** Stable subagent ID — matches the filename agent-<agentId>.jsonl on disk. */
    agentId?: string;
    /** Streaming-part id used to merge reasoning chunks; emitted by the native harness, not CC's watcher. */
    partId?: string;
    /**
     * Native runtime only. Set on an `assistant-thinking` heartbeat when the
     * streaming watchdog has seen NO chunk for STALL_WARNING_MS. Drives the
     * ThinkingIndicator's "taking a while… retrying" countdown. `willRetry` =
     * the harness will auto-retry the step when the countdown ends (nothing had
     * streamed yet, first attempt). false ends the countdown one of two ways:
     * on Clock 1 alone (nothing ever streamed, first attempt) with a
     * session-error; on Clock 2 (something already streamed) or a turn that
     * has already parked once, the turn PARKS instead — see `stalled` below.
     * A heartbeat WITHOUT this field means activity resumed and clears the
     * warning.
     */
    stallWarning?: { retryInMs: number; willRetry: boolean };
    /**
     * Native runtime only. The mid-stream watchdog gave up waiting and the turn
     * is now PARKED: the stream reader is still open, nothing has been torn
     * down, and the turn ends only when a chunk arrives or the user presses
     * Retry / Stop. Display-only (no text, no partId) so SessionStore drops it.
     *
     * Deliberately a bare `true` and not a timestamp: the renderer stamps its
     * own clock on first receipt, so a remote client counting up never inherits
     * clock skew from the host.
     */
    stalled?: true;
    /**
     * Native runtime only. Discard these streaming parts — the attempt that
     * wrote them is being abandoned by a manual Retry, and the re-run would
     * otherwise APPEND to the same bubble (the SDK's part id falls back to the
     * literal 'text-0', so a repeat is the likely case, not a corner case).
     * This is why the automatic retry has always refused to run after content
     * streamed; the manual one is allowed to, because it erases first.
     * Display-only (no text, no partId) — never persisted.
     */
    dropPart?: { partIds: string[] };
    /**
     * Native runtime only. Emitted on `assistant-thinking` the moment a step's
     * stream opens, BEFORE any token arrives, so the UI can say the model is
     * reading the prompt rather than showing an idle spinner. Local models take
     * minutes to prefill a long prompt and there is otherwise nothing to tell
     * that apart from a hang — which is what made the 75s stall watchdog's false
     * alarm so alarming (2026-07-26). `budgetMs` is how long prefill is allowed
     * to take before the watchdog treats the silence as a real stall.
     */
    promptProcessing?: { promptTokens: number; budgetMs: number; source?: 'prompt' | 'tool-output'; processed?: number; cached?: number; etaMs?: number | null; timeMs?: number };
    /**
     * Native runtime only. The model is GENERATING a tool call's arguments —
     * nothing has executed yet. This is what makes a "preparing" ToolCard
     * appear instead of minutes of bare thinking spinner on a big Write.
     *
     * Rides `assistant-thinking` with NO text and NO partId so
     * SessionStore.append drops it (session-store.ts): partial arguments must
     * never reach the JSONL, or a resume would replay a half-written file.
     *
     * `toolCallId` is the provider's REAL id — identical to the one the
     * completed `tool-call` stream part carries — which is what lets the card
     * transition in place instead of being swapped.
     *
     * `cleared: true` means "remove this preparing card": the stall auto-retry
     * re-runs a step WITHOUT ending the turn, so its cards must be withdrawn
     * explicitly (every other death path ends the turn, where endTurn reaps).
     */
    toolPreparing?: { toolCallId: string; toolName: string; chars: number; cleared?: boolean };
    /**
     * Populated only on `user-interrupt` events. Distinguishes the two exact
     * marker strings Claude Code writes: `[Request interrupted by user]`
     * (plain) vs `[Request interrupted by user for tool use]` (tool-use).
     */
    kind?: 'plain' | 'tool-use';
    /**
     * Populated on `compact-summary` events. The full text of the compaction
     * summary CC wrote into the JSONL — pre-stripped of system tags. The
     * reducer attaches it to the SystemMarker so the user can click-to-expand
     * the otherwise-thin "Compacted" divider.
     */
    summary?: string;
    /**
     * Native runtime only: set on a `compact-summary` emitted by the harness's
     * SPONTANEOUS two-stage compaction (spec §4.4). CC's transcript-watcher
     * compact-summary events never carry it. The renderer renders the marker for
     * an auto-compaction without the manual-/compact `compactionPending` flag —
     * without it a native auto-compaction would replace ~all history and show
     * NOTHING. Kept off CC's path so manual /compact and resume-from-summary are
     * unchanged.
     */
    autoCompaction?: boolean;
    /** `skill-invoked` only (M3 item 1). `skillId` is the resolved, qualified id
     *  (wecoded-themes-plugin:theme-builder); `body` is the SKILL.md text that
     *  enters model history on rebuild and is deliberately NOT rendered;
     *  `skillPath` lets the card open the real file in the artifact viewer. */
    skillId?: string;
    displayName?: string;
    args?: string;
    body?: string;
    skillPath?: string;
    /**
     * `replay-complete` only. Whether main could AFFIRM the session has no work
     * in flight, which is what gates the reducer's orphan reap — the same replay
     * fires when a window re-docks a genuinely mid-turn session, where the
     * running tool is real and must not be failed. Only NativeSessionHost can
     * answer (`entry.inFlight`); CC sessions report false.
     *
     * DECLARED, not just commented, because producer (ipc-handlers.ts) and
     * consumer (App.tsx, BubbleFeed.tsx) are otherwise linked by nothing but a
     * matching string literal through an `any`-typed `evt.sender.send`. A typo
     * on either side reads undefined → false, silently disabling the reap with
     * the whole suite still green (found reviewing PR #287, 2026-08-10).
     */
    sessionIdle?: boolean;
  };
}

// --- Chat view types ---

export type ToolCallStatus = 'running' | 'complete' | 'failed' | 'awaiting-approval';

// jsdiff-style hunk. Claude Code's Edit/MultiEdit tool results include
// `toolUseResult.structuredPatch`: pre-computed hunks with absolute file
// line numbers + interleaved context/add/del rows. Preferred over
// reconstructing a diff from old_string/new_string because line numbers
// reflect the real file position.
export interface StructuredPatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Each string begins with ' ' (context), '-' (deletion), or '+' (addition). */
  lines: string[];
}

/**
 * One entry in a subagent's nested timeline rendered inside AgentView.
 * Narrower than ToolCallState — no tool groups, no turn tracking.
 *
 * Specialists 1c (2026-08-16): a NATIVE specialist's ask now reaches a real
 * user (plan 1b's child-ask-router routes it to the parent's own card), so a
 * tool segment CAN be 'awaiting-approval' and carries the same ask fields the
 * top-level ToolCallState does — the ask renders INSIDE the launching Task
 * card's Activity, buttons and all (Destin's 1b hands-on directive: a
 * background hire looks exactly like a foreground one). CC subagents still
 * never hit the ask flow; their segments never take that status.
 */
export type SubagentSegment =
  | {
      type: 'text';
      id: string;
      content: string;
      // Native runtime: per-token delta id, mirrors the main-timeline text
      // segment's partId (chat-types.ts TRANSCRIPT_ASSISTANT_TEXT). Lets the
      // reducer coalesce same-partId deltas into one segment instead of one
      // per delta — see chat-reducer.ts applySubagentEvent. CC events never
      // set this, so its absence preserves today's one-segment-per-event.
      partId?: string;
      /** When this happened (epoch ms, the transcript event's own stamp).
       *  Optional on every non-note segment because it exists for ONE reason:
       *  placing a mid-run 'note' (below, which always has a time) among the
       *  rows that happened before and after it, instead of at the bottom of
       *  the trail on replay (chat-reducer.ts reconcileNoteSegments). A
       *  segment without one is never ordered against — it just keeps its
       *  place. Nothing else reads it. */
      timestamp?: number;
    }
  | {
      type: 'tool';
      id: string;
      toolUseId: string;
      toolName: string;
      input: Record<string, unknown>;
      status: 'running' | 'complete' | 'failed' | 'awaiting-approval';
      /** See the 'text' variant's `timestamp` — same field, same one reason. */
      timestamp?: number;
      response?: string;
      error?: string;
      structuredPatch?: StructuredPatchHunk[];
      /** Set while status is 'awaiting-approval' — the broker request the
       *  nested Yes/No/Always buttons answer. Same fields as ToolCallState. */
      requestId?: string;
      denyListed?: boolean;
      external?: boolean;
      permissionMode?: 'ask' | 'auto-edit' | 'full-auto';
      /** The 5-minute hold elapsed (child-ask-router's ASK_REDIRECT): the
       *  specialist was told to carry on without this and the ask is STILL
       *  answerable — a late answer becomes a follow-up. The row says so. */
      askHeld?: boolean;
    }
  | {
      /** A steer — "send a note" — from the user (card action) or the parent
       *  model (Task tool, task_id). Shown in the Activity trail so the user
       *  can see what the helper was told mid-run. */
      type: 'note';
      id: string;
      content: string;
      from: 'user' | 'assistant';
      timestamp: number;
    }
  | {
      /** The specialist's own reasoning (local reasoning models emit it with
       *  text). Rendered as a collapsed "Thinking" row inside the card — never
       *  in the parent's own thinking bubble. */
      type: 'thinking';
      id: string;
      content: string;
      partId?: string;
      /** See the 'text' variant's `timestamp` — same field, same one reason. */
      timestamp?: number;
    };

/** Specialists 1c — one mid-run steering message, kept on the ledger record so
 *  a card replay (reattach, restart) shows the same steer history the live
 *  run saw, not just whatever survived in the model's own transcript. */
export interface SpecialistNote {
  text: string;
  from: 'user' | 'assistant';
  at: number;
}

/**
 * Specialists 1c — what the renderer knows about one hire, keyed by the Task
 * call that started it. Mirrors the host's DelegationRecord (delegation-
 * ledger.ts) minus the delivery/lease bookkeeping the UI never needs. Pushed
 * over `specialists:event` on every ledger write and replayed on
 * session (re)attach, so a card's status never depends on the model's prose.
 */
export interface SpecialistRunView {
  childId: string;
  parentToolCallId: string;
  /** Definition id (explorer / worker / a custom file's id). */
  agentType: string;
  /** "Nadia the Rambling Researcher" — minted at spawn. */
  title: string;
  description?: string;
  background: boolean;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  startedAt: number;
  endedAt?: number;
  steps?: number;
  /** Heartbeat watchdog flagged no activity past the idle/in-tool threshold. */
  stale?: boolean;
  /** Which model actually ran it, once resolved (tier fallback stated honestly). */
  model?: { label: string; via?: 'budget' | 'frontier' | 'named' | 'parent'; fallback?: boolean };
  /** Mid-run steers sent to this hire, in order. Absent on a pre-1c record —
   *  the ledger reads that as []. */
  notes?: SpecialistNote[];
  /** ROADMAP L259 — a monotonic stamp the reducer compares before applying an
   *  update, so a stale push that arrives AFTER a newer one for the same run
   *  cannot flip a finished card back to "running". Stamped by `toRunView`
   *  (the single projection), NOT persisted in the ledger file: it orders the
   *  pushes, it does not describe the run. OPTIONAL because a card replayed
   *  from a pre-L259 build has none — a missing stamp on either side means
   *  "cannot order these", and the reducer falls back to its old behaviour
   *  rather than dropping the update. */
  seq?: number;
}

/** Task 5 (plan 1c) — the push event `specialists:event` carries: one
 *  ledger write, one event, one changed hire. `kind` is a discriminant with
 *  exactly ONE member today ('run') — kept, rather than dropped down to a
 *  bare `SpecialistRunView`, so a later kind (e.g. a one-off toast) can be
 *  added without every existing listener's shape changing underneath it.
 *  There is no separate "note" event: a note is a field ON the run record
 *  (SpecialistRunView.notes), so the SAME 'run' event that carries a status
 *  change also carries a newly-added note — the card never needs to merge
 *  two event kinds to know what a hire's note history looks like. */
export type SpecialistsEvent = { kind: 'run'; sessionId: string; run: SpecialistRunView };

/** A background specialist's delivered report, folded into its Task card. */
export interface SpecialistReportView {
  text: string;
  status: 'completed' | 'failed';
  steps?: number;
  timestamp: number;
}

/**
 * Specialists 1c — one row of the roster the renderer shows (Settings →
 * Specialists, and the Task card's consent block). Comes from
 * `specialists:list`; the CHARTER and TOOLS are the MAPPED result the child
 * will actually get, never what a source file claimed (spec §2: CC-format
 * compatibility is safety-relevant).
 */
export interface SpecialistDefinitionView {
  id: string;
  displayName: string;
  description: string;
  charter: 'read-only' | 'read-write';
  allowedTools: string[];
  modelPreference?: 'parent' | 'budget' | 'frontier';
  // Task 8 fix: narrowed from the earlier 'builtin' | 'personal' | 'project' |
  // 'claude-code' — SpecialistCatalog (harness/specialists/catalog.ts) tags a
  // PROJECT'S .claude/agents/ file the same 'claude-code' source as the
  // user-level folder (only `path` tells them apart); 'project' was never a
  // source the catalog actually produced.
  source: 'builtin' | 'personal' | 'claude-code';
  /** D2: how wide an "Always allow" on this specialist may be — 'user' grants
   *  travel across projects, 'project' grants are pinned to one work dir.
   *  Distinct from `source` because 'claude-code' spans BOTH the user's folder
   *  and a project's; see SpecialistDefinition.grantScope for the full why. The
   *  card reads this only to LABEL the grant honestly; the width itself is
   *  decided in the main process (tools/task.ts's permissionSubject). */
  grantScope: 'builtin' | 'user' | 'project';
  /** Absolute path of the defining file (absent for built-ins). */
  path?: string;
  /** Tool grants the file asked for that were stripped as unmappable/unknown,
   *  plus any other narrowing the loader applied. Empty = loaded verbatim. */
  warnings: string[];
  // Task 8 fix: `shadows` REMOVED — the catalog's load-order rule is "first
  // loaded wins, a later colliding id is SKIPPED" (resolveOffered's own WHY),
  // never a layering one definition displaces another. A collision now shows
  // up in SpecialistsListResult.skipped, not as a per-definition flag here.
  /** False past the offered cap (MAX_OFFERED_SPECIALISTS) — still listed in
   *  Settings, with a warning, but never handed to the Task tool. Built-ins
   *  are always true. */
  offered: boolean;
  /** The file's full, unclamped description — Settings shows this; the
   *  Task-tool-facing `description` above is clamped to MAX_DESCRIPTION_CHARS. */
  fullDescription?: string;
}

/** Specialists 1c — `specialists:list`'s exact response shape: the resolved
 *  roster (every definition, offered or not) plus what the loader could NOT
 *  place (parse failure or id collision) and the three folder paths an "Open
 *  folder" control needs. Mirrors SpecialistCatalog's CatalogSnapshot
 *  (harness/specialists/catalog.ts) field-for-field on purpose — one shape,
 *  never two that could drift. */
export interface SpecialistsListResult {
  definitions: SpecialistDefinitionView[];
  skipped: { path: string; source: 'personal' | 'claude-code'; error: string }[];
  folders: { personal: string; claudeUser: string; project?: string };
}

/** Specialists 1c — the two user-designated model tiers (spec §2 amendment,
 *  Destin 2026-08-12). `null` = unset → falls back to the conversation's model. */
export interface DelegatedModelsView {
  budget: { providerId: string; modelId: string; label: string } | null;
  frontier: { providerId: string; modelId: string; label: string } | null;
}

export interface ToolCallState {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  status: ToolCallStatus;
  requestId?: string;
  permissionSuggestions?: string[];
  /** Native broker only: winning rule came from the destructive deny-list →
   *  the "Always allow" button shows a consequence-gated confirm. Task 13. */
  denyListed?: boolean;
  /** Native broker only: the ask was forced by a path outside the session
   *  folder → the "Always allow" button is HIDDEN. The engine forces an ask on
   *  every external path and never consults the stored rules there, so a
   *  remembered rule could not fire. Spec 2026-08-11, finding 3. */
  external?: boolean;
  /** Native broker only: the session's permission mode when the ask fired.
   *  'full-auto' + denyListed swaps the generic button row for the safety-stop
   *  footer (spec 2026-08-12, M5 2b). Absent on CC asks. */
  permissionMode?: 'ask' | 'auto-edit' | 'full-auto';
  /** Specialists 1c: set on a TOP-LEVEL card only when a child's routed ask
   *  could not be nested (its Task card is not on this timeline) — the card
   *  then labels who asked instead of reading as the parent's own ask. */
  specialist?: { childId: string; agentType: string; title: string };
  /**
   * Native runtime only. The model is still GENERATING this call's arguments —
   * nothing has executed, and `input` is an empty object until the real
   * tool-use event supersedes this entry in place.
   *
   * A FLAG on a 'running' entry rather than a fifth ToolCallStatus, so every
   * existing status consumer (endTurn, ChatView's hasRunningTools, ToolCard's
   * spinner, AssistantTurnBubble's awaiting-approval hiding) keeps working
   * untouched. Exactly two places opt in: ToolCard's body and reaping.
   *
   * Display-only and NEVER persisted — a preparing entry is DELETED on turn
   * end, never failed and never given a result, so the tool-call/result pairing
   * invariant is not involved.
   */
  preparing?: boolean;
  /** Argument characters generated so far — the preparing card's liveness
   *  counter. Meaningless once `preparing` is gone. */
  preparingChars?: number;
  response?: string;
  error?: string;
  /** Set when the tool result carries a structuredPatch (Edit/MultiEdit). */
  structuredPatch?: StructuredPatchHunk[];
  // Populated for Agent tools only (toolName === 'Agent'):
  // - subagentSegments: appended to as the subagent's JSONL streams in; drives AgentView timeline
  // - agentType: copied from meta.json once the subagent is bound (e.g. 'Explore', 'Plan')
  // - agentId: stable subagent ID, matches the filename agent-<agentId>.jsonl on disk
  subagentSegments?: SubagentSegment[];
  agentType?: string;
  agentId?: string;
  /**
   * Native specialists (1c): the live run record for the hire THIS Task call
   * started, keyed to the card by parentToolCallId. Drives the card's real
   * status — a background hire's tool result is only the launch acknowledgment,
   * so `status: 'complete'` alone would read "done" while the child still
   * works (Destin's 1b hands-on, Test 4). Absent on CC Agent cards.
   */
  specialistRun?: SpecialistRunView;
  /**
   * Native specialists (1c): a BACKGROUND hire's delivered report, folded back
   * into the launching card so background and foreground render alike (the
   * foreground report is simply `response`). The parent model still reads the
   * report as its next turn; only the bubble moved here.
   */
  specialistReport?: SpecialistReportView;
  /**
   * Native Bash in the background (G-1, 2026-08-28 design): the live record of
   * a command that outlived its call — started with `run_in_background`, or
   * moved to the background when it hit its time limit. Drives the card's real
   * state the way `specialistRun` does for a hire: the tool result of a
   * background start is only the launch acknowledgment. Absent on foreground
   * Bash calls and on CC cards.
   */
  shellRun?: ShellRunView;
}

/** Why a background command is no longer running — the card names it. */
export type ShellStopReason = 'user' | 'assistant' | 'conversation-closed' | 'app-quit';

export interface ShellRunView {
  /** The Bash tool call this run belongs to (the card it renders on). */
  toolUseId: string;
  /** Short id the model uses with BashOutput/KillShell. */
  shellId: string;
  status: 'running' | 'exited' | 'stopped';
  /** Set once the process ended on its own. */
  exitCode?: number;
  /** Set when status is 'stopped'. */
  stopReason?: ShellStopReason;
  /** True when the command was moved to the background at its time limit
   *  rather than started there — the card says so. */
  detached?: boolean;
  startedAt: number;
  endedAt?: number;
  /** The last lines of output so far (the full log lives at logPath). */
  tail: string;
  logPath: string;
}

/** Structured companion to `injected: 'specialist-report'` (2026-08-16): who
 *  finished, what they were asked, how it ended — so the card header is exact
 *  rather than parsed back out of the prose the model reads.
 *  `parentToolCallId` names the Task card that started this child. */
export interface SpecialistInjectedMeta {
  /** G-1: the union's discriminant, declared here as always-absent so every
   *  reader can write `meta.kind === 'shell'`. Without it TypeScript refuses to
   *  read `.kind` off the union at all, and the code has to alternate between
   *  `'kind' in meta` and `.kind`. Optional and undefined, so no persisted
   *  specialist record changes shape. */
  kind?: undefined;
  childId: string;
  title: string;
  agentType: string;
  description?: string;
  status: 'completed' | 'failed';
  steps?: number;
  parentToolCallId?: string;
}

/** Companion to `injected: 'shell-complete'` (G-1): the background commands
 *  this ONE injected turn reports. A list, not a single run, because every
 *  notice ready at the same idle boundary goes out as one turn (D8) and the
 *  renderer folds each entry into its own Bash card. */
export interface ShellInjectedMeta {
  kind: 'shell';
  runs: Array<{
    shellId: string;
    toolUseId: string;
    exitCode?: number;
    stopReason?: ShellStopReason;
    elapsedMs: number;
    logPath: string;
  }>;
}

export type InjectedMeta = SpecialistInjectedMeta | ShellInjectedMeta;

/** The push event `native:shell-event` carries (G-1): one run record changed. */
export type ShellEvent = { sessionId: string; run: ShellRunView };

export interface ToolGroupState {
  id: string;
  toolIds: string[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  // Exact file paths the user attached with this message (from InputBar's file
  // picker). Carried alongside content — which space-joins them — so
  // UserMessage can render each as a clickable pill even when the path
  // contains spaces (regex detection can't recover those from the joined
  // string). Live-bubble only: transcript-confirmed entries don't carry it.
  attachments?: string[];
}

// --- Command drawer / marketplace types ---

export interface SkillEntry {
  // Existing
  id: string;
  displayName: string;
  description: string;
  category: 'personal' | 'work' | 'development' | 'admin' | 'other';
  prompt: string;
  source: 'youcoded-core' | 'self' | 'project' | 'plugin' | 'marketplace';
  pluginName?: string;

  // New — marketplace fields
  type: 'prompt' | 'plugin';
  author?: string;
  version?: string;
  rating?: number;
  ratingCount?: number;
  installs?: number;
  visibility: 'private' | 'shared' | 'published';
  installedAt?: string;
  updatedAt?: string;
  repoUrl?: string;
  // Phase 3c: optional config schema — when present, the detail view renders
  // a settings form for this entry. Anthropic plugins using native config.json
  // should NOT set this field.
  configSchema?: ConfigSchema;

  // Marketplace redesign Phase 1 — soft filter/curation fields populated from
  // overrides/<id>.json; all optional so pre-extension cache reads still work.
  tags?: string[];
  tagline?: string;
  longDescription?: string;
  lifeArea?: string[];
  audience?: 'general' | 'developer';

  // Marketplace redesign Phase 1 — component inventory from extract-components.
  // `null` means extraction failed (see componentsError). UI should hide the
  // "What's inside" peek for null; empty object {} means the plugin genuinely
  // has no components.
  components?: SkillComponents | null;
  componentsError?: string;

  // Propagated from sync.js for UI "deprecated" badges. Present only when true.
  deprecated?: boolean;
  deprecatedAt?: string;

  // When true, the plugins grid should hide this entry because it is surfaced
  // through the dedicated Integrations tile instead (e.g. google-services,
  // imessage). The entry is still installable — just not double-listed.
  integrationOnly?: boolean;

  // Source info from index.json — needed by the in-app file viewer to fetch
  // raw SKILL.md/commands/agents content when the plugin isn't installed.
  // 'local' = subdir in wecoded-marketplace repo (sourceRef is that subdir).
  // 'url' = git URL (sourceRef is the clone URL).
  // 'git-subdir' = git URL with a subdir (sourceRef is clone URL, sourceSubdir is the subdir).
  sourceType?: string;
  sourceRef?: string;
  sourceSubdir?: string;
  // WHY: reconcileBundledPlugins (Task B3) needs the entry's marketplace to
  // pick the right cache clone / repo when refreshing and upgrading a
  // bundled plugin — 'youcoded' vs 'youcoded-core' vs upstream Anthropic.
  sourceMarketplace?: string;

  // Marketplace overhaul (2026-08-27): type / origin / scan / capabilities /
  // membership for the new catalog. Optional — today's registry has none of
  // it, and the UI treats an absent block as "a plugin, community, unchecked".
  catalog?: CatalogMeta;

  // Absolute path to the skill's own directory (the one holding SKILL.md).
  // Populated by scanSkills for filesystem-discovered skills. The native harness
  // needs it because `prompt` is only the slash-command string — it carries no
  // instructions — and the scanner otherwise discards the path it already knew
  // in order to read the frontmatter. Absent for registry-only entries the user
  // has not installed.
  skillDir?: string;
}

export interface SkillDetailView extends SkillEntry {
  fullDescription?: string;
  tags?: string[];
  publishedAt?: string;
  authorGithub?: string;
  sourceRegistry?: string;
}

// Command drawer entry — represents a slash command that can appear
// in the CommandDrawer's search results. Distinct from SkillEntry
// because commands may be unclickable (e.g. CC built-ins without a
// native UI in YouCoded).
export type CommandEntry = {
  name: string;                   // '/compact', '/superpowers:brainstorm'
  description: string;
  source: 'youcoded' | 'filesystem' | 'cc-builtin';
  clickable: boolean;
  disabledReason?: string;        // populated when clickable=false
  aliases?: string[];             // e.g. /clear → ['/reset', '/new']
};

export interface SkillFilters {
  type?: 'prompt' | 'plugin';
  category?: SkillEntry['category'];
  sort?: 'popular' | 'newest' | 'rating' | 'name';
  query?: string;
}

export interface ChipConfig {
  skillId?: string;  // optional — chips can exist without a backing skill (e.g., "Git Status" is just a prompt)
  label: string;
  prompt: string;
}

export interface MetadataOverride {
  displayName?: string;
  description?: string;
  category?: SkillEntry['category'];
}

// Component of an installed marketplace package (plugin, theme, etc.)
export interface PackageComponent {
  type: 'plugin' | 'theme';
  path: string;
}

export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  author?: { name?: string } | string;
  license?: string;
  recommends?: string[];   // soft recommendation — package works without these
  provides?: Record<string, { description: string; skill: string }>;
  optionalIntegrations?: Record<string, { whenAvailable: string; whenUnavailable: string }>;
  postInstall?: string;    // shell command run after install (trusted-org only)
}

// Tracked marketplace package — records what the marketplace installed
export interface PackageInfo {
  version: string;
  source: 'marketplace' | 'user';
  installedAt: string;
  removable: boolean;
  components: PackageComponent[];
  // Marketplace overhaul Task 17: the exact upstream commit this install landed
  // on, recorded only when the catalog listed one (`catalog.sourceCommit`).
  // The marketplace Update check compares it against the catalog's current value,
  // alongside the version compare. Absent on every pre-Task-17 install, which is
  // why the compare must treat "no commit recorded" as "nothing to say".
  commit?: string;
  // Decomposition v3 §9.8: cross-device sync can surface a package that's
  // present in config but not yet on disk (e.g., Android pulled a desktop
  // config but hasn't installed the package yet). "pending" UIs can show an
  // Install CTA without confusing the user about whether it's really there.
  status?: 'installed' | 'pending';
}

export interface UserSkillConfig {
  version: 1 | 2;
  favorites: string[];
  /** Slugs of themes the user has pinned as favorites. Drives the Appearance
   *  panel (favorites-only) and the "My favorite themes" section in Library.
   *  Seeded with the four built-ins on first read; see SkillConfigStore.getThemeFavorites(). */
  themeFavorites?: string[];
  chips: ChipConfig[];
  overrides: Record<string, MetadataOverride>;
  privateSkills: SkillEntry[];
  // v2: unified package tracking (replaces installed_plugins)
  packages?: Record<string, PackageInfo>;
}

export interface SkillProvider {
  listMarketplace(filters?: SkillFilters): Promise<SkillEntry[]>;
  getSkillDetail(id: string): Promise<SkillDetailView>;
  search(query: string): Promise<SkillEntry[]>;
  getInstalled(): Promise<SkillEntry[]>;
  getFavorites(): Promise<string[]>;
  getChips(): Promise<ChipConfig[]>;
  getOverrides(): Promise<Record<string, MetadataOverride>>;
  install(id: string): Promise<any>;
  uninstall(id: string): Promise<void | { type: 'plugin' | 'prompt' }>;
  setFavorite(id: string, favorited: boolean): Promise<void>;
  setChips(chips: ChipConfig[]): Promise<void>;
  setOverride(id: string, override: MetadataOverride): Promise<void>;
  createPromptSkill(skill: Omit<SkillEntry, 'id'>): Promise<SkillEntry>;
  deletePromptSkill(id: string): Promise<void>;
  publish(id: string): Promise<{ prUrl: string }>;
  generateShareLink(id: string): Promise<string>;
  importFromLink(encoded: string): Promise<SkillEntry>;
  getFeatured?(): Promise<FeaturedData>;
}

// Marketplace redesign Phase 1 — discovery curation. Driven by featured.json
// in the wecoded-marketplace repo; edited via /feature admin skill.
export interface FeaturedHeroSlot {
  id: string;
  blurb: string;
  accentColor?: string;
}

export interface FeaturedRail {
  title: string;
  description?: string;
  slugs: string[];
}

export interface FeaturedData {
  hero?: FeaturedHeroSlot[];
  rails?: FeaturedRail[];
  // Legacy shape — passed through for older clients; to be dropped in Phase 2.
  skills?: Array<{ id: string; tagline?: string }>;
  themes?: Array<{ slug: string; tagline?: string }>;
}

// Marketplace redesign Phase 3 — integrations as a first-class kind.
// 'plugin' kind wraps an existing marketplace plugin + optional post-install
// slash command, avoiding a second install pipeline.
export type IntegrationKind = 'mcp' | 'shell' | 'http' | 'plugin';
export type IntegrationStatusValue =
  | 'not-installed'
  | 'installing'
  | 'needs-auth'
  | 'connected'
  | 'error';

export interface IntegrationSetup {
  type: 'script' | 'api-key' | 'macos-only' | 'plugin';
  path?: string;
  requiresOAuth?: boolean;
  oauthProvider?: string;
  keyName?: string;
  // setup.type === 'plugin' — the marketplace plugin id to install and an
  // optional slash command the app runs in a fresh session after install.
  pluginId?: string;
  postInstallCommand?: string;
}

export interface IntegrationEntry {
  slug: string;
  displayName: string;
  tagline: string;
  longDescription?: string;
  kind: IntegrationKind;
  setup: IntegrationSetup;
  status: 'available' | 'planned' | 'deprecated';
  accentColor?: string;
  lifeArea?: string[];
  // Relative path under integrations/icons/ in the marketplace repo; the UI
  // resolves this against the raw.githubusercontent.com base URL.
  iconUrl?: string;
  // Human tags for search and the detail-page chip row. Freeform strings;
  // the detail overlay renders each as a "#tag" pill.
  tags?: string[];
  // Platforms where this integration can run. When present and the current
  // platform isn't listed, the card shows a "<platform>-only" affordance.
  platforms?: Array<'darwin' | 'linux' | 'win32'>;
}

export interface IntegrationIndex {
  version: string;
  integrations: IntegrationEntry[];
}

export interface IntegrationState {
  slug: string;
  installed: boolean;
  connected: boolean;
  lastSync?: string;
  error?: string;
}

// AttentionState drives the UI decision between ThinkingIndicator (ok) and
// the AttentionBanner (everything else). A classifier reads the PTY buffer
// and maps its conclusions onto these states; process-exit events also
// transition to 'session-died' directly. See docs/chat-reducer.md.
//
// Narrowed 2026-04-26: 'awaiting-input' / 'shell-idle' / 'error' were
// removed because nothing in the codebase ever dispatched them — the
// classifier was simplified to spinner-only signals back in the April
// rewrite, but the type and the AttentionBanner copy table still carried
// the dead branches. Reducer tests that used them have been switched to
// 'stuck' (the only buffer-driven non-ok state). If we ever need finer
// distinctions, reintroduce them along with the dispatching code path.
//
// 2026-07-10: 'error' reintroduced WITH a writer for the native runtime
// (Phase 1 Plan A) — see the union member's comment for the dispatcher.
export type AttentionState =
  | 'ok'              // Default — indicator renders if isThinking
  | 'stuck'           // Spinner glyph stale ≥ 10s OR no spinner ≥ 20s while thinking
  | 'session-died'    // Process exited mid-turn
  // Native-runtime provider/stream failure (dispatcher: NATIVE_SESSION_ERROR,
  // fed by the 'session-error' transcript event). CC sessions never enter it.
  | 'error'
  // Native runtime only. The mid-stream watchdog gave up waiting but the turn
  // is STILL ALIVE and still holding its stream open — unlike every other
  // non-ok state here, which are all endings. The user chooses: Retry, Stop,
  // or wait. Dispatcher: TRANSCRIPT_THINKING_HEARTBEAT with `stalled: true`.
  | 'stalled';

// Red | green | blue | gray — mirrors SessionStatusColor in renderer.
// Duplicated as a string literal type here (not imported) so main-process
// code in Node can consume this interface without dragging renderer
// imports across the main/renderer boundary.
// Mirrored in renderer as SessionStatusColor (StatusDot.tsx). Duplicated as a
// string literal here (not imported) so main-process Node code can consume
// this interface without crossing the main/renderer boundary. Keep the two
// unions in sync — adding a color in one place without the other will make
// the AttentionSummary IPC payload reject valid renderer values.
export type SessionStatusDotColor = 'green' | 'red' | 'amber' | 'blue' | 'gray';

export interface AttentionSummary {
  anyNeedsAttention: boolean;
  perSession: Record<string, {
    attentionState: AttentionState;
    awaitingApproval: boolean;
    // Derived dot color from the main window's reducer (matches what the
    // main session switcher renders). Pushed to buddy surfaces so the
    // SessionPill's dot is visually identical to the same session's dot
    // in the main window. Absent for sessions that haven't reported yet.
    status?: SessionStatusDotColor;
  }>;
}

// Payload sent by renderer → main via the attention:report IPC channel.
// Main aggregates these across all windows and broadcasts an AttentionSummary.
// The 'clear' variant fires when a session is removed from the renderer.
export type AttentionReport =
  | {
      sessionId: string;
      attentionState: AttentionState;
      awaitingApproval: boolean;
      status?: SessionStatusDotColor;
    }
  | { sessionId: string; clear: true };

export interface AttentionApi {
  report(payload: AttentionReport): void;
  /**
   * Snapshot of main's cross-window aggregate, pulled once on mount. The
   * matching push (`buddy.onAttentionSummary`) only fires on change, so a
   * newly opened window has no colours for peer sessions until one of them
   * next flips. Resolves to an empty summary where aggregation doesn't run
   * (remote browsers, Android).
   */
  getSummary(): Promise<AttentionSummary>;
}

/**
 * What the desktop answers when the settings screen asks about the Linux/KDE
 * buddy helper (docs/active/design/2026-09-04-linux-buddy-helper/ §4).
 *
 * THREE facts, not two, and the first one is the one that keeps a working buddy
 * working. `needed` says "this app cannot move its own windows here" — true only
 * on a native-Wayland Linux session. On Windows, macOS, Linux/X11 and Linux
 * Wayland that is really running through XWayland it is false, and there the
 * buddy already works exactly as it always has: no helper, no consent card, no
 * mention of any of this. `supported` is the separate question of whether a
 * helper could work here at all (KDE 6 on Wayland), and it is only ever asked
 * once `needed` is true.
 *
 * `installed` is reported TRUTHFULLY whatever `needed` says, because a user can
 * add the helper on Wayland and then log into X11: the script is still sitting
 * in their KDE settings, and the Remove helper button is the only way back out.
 */
export interface BuddyHelperStatus {
  /** The app cannot position its own windows here, so a helper is required. */
  needed: boolean;
  /** A helper can work on this desktop at all (KDE Plasma 6 on Wayland). */
  supported: boolean;
  /** The helper script is loaded in the compositor right now. */
  installed: boolean;
  /** Why this desktop is unsupported — shown, never guessed at. */
  reason?: string;
}

/**
 * What `show()` answers. `ok: false` means MAIN REFUSED to put the buddy on
 * screen — see design §5: the refusal is enforced in the main process, because
 * the settings screen is not the only thing that switches the buddy on.
 */
export interface BuddyShowResult {
  ok: boolean;
  /** Main's own words for the refusal. Surfaced as-is; never re-worded. */
  reason?: string;
}

export interface BuddyApi {
  // The Linux/KDE helper (docs/active/design/2026-09-04-linux-buddy-helper/).
  // These had no backend while the popup was being designed; the real one landed
  // 2026-09-04 (kwin-helper.ts + three channels on preload, remote-shim and the
  // workbench mock), so they are no longer MOCK_ONLY.
  //
  // They keep the `?` because every caller optional-chains them anyway: the
  // settings screen runs inside remote browsers and Android too, where the whole
  // buddy surface is a set of stubs, and a `?.()` call site that silently does
  // nothing is the behaviour we want there.
  helperStatus?(): Promise<BuddyHelperStatus>;
  installHelper?(): Promise<{ ok: boolean }>;
  // Added 2026-09-04 (decide-uninstall#D-1). The consent card used to promise the
  // helper was "removed when you uninstall YouCoded", which is false: the AppImage
  // build has no uninstall step at all. Destin chose a Remove helper control the
  // user owns instead, so the app needs a channel that takes the helper back out
  // of KDE's settings — see design §6 for the order the main side must use.
  removeHelper?(): Promise<{ ok: boolean }>;
  /**
   * Widened 2026-09-04 (design §5): this used to resolve to nothing, and now
   * reports whether the buddy was actually shown. A Wayland user without the
   * helper is REFUSED, and the settings switch must not sit in the "on"
   * position after a refusal — that would be a switch that lies.
   */
  show(): Promise<BuddyShowResult | void>;
  hide(): Promise<void>;
  toggleChat(): Promise<void>;
  setSession(sessionId: string): Promise<void>;
  subscribe(sessionId: string): Promise<void>;
  unsubscribe(sessionId: string): Promise<void>;
  getViewedSession(): Promise<string | null>;
  // Fire-and-forget. Called by BuddyMascot during pointer drag; main
  // places the mascot at the supplied target (clamped to visible workArea).
  // Anchor-based, not delta-based, so per-move rounding on HiDPI displays
  // cannot accumulate drift between the cursor and the mascot.
  moveMascot(target: { localDx: number; localDy: number }): void;
  onAttentionSummary(cb: (summary: AttentionSummary) => void): () => void;
  // Pre-existing preload methods that were missing from this interface —
  // added while typing the buddy-upgrades members so call sites don't need
  // `(window as any)` casts. Main does the hide/capture/restore dance and
  // pushes the PNG path to the chat renderer on BUDDY_ATTACH_FILE.
  captureDesktop(): Promise<string | null>;
  onAttachFile(cb: (filePath: string) => void): () => void;
  // ── Buddy upgrades (action bar, dismiss, dock/peek) ──
  // Typed centrally here (instead of `as any` casts at call sites) so the
  // preload, remote-shim, and renderer callers all agree on one contract.
  /** Fire-and-forget: mascot renderer signals drag release (edge-snap check). */
  dragEnded(): void;
  /** Restore + focus the main window, switching to the buddy's viewed session. */
  openMain(): Promise<void>;
  /** Hide the buddy for this app run only (preference stays enabled). */
  dismiss(): Promise<void>;
  // WHY keepAbove rides on getStatus() rather than a dedicated getter: Task
  // 8 only adds one new channel (setKeepAbove, for the write); reusing the
  // existing getStatus() round-trip for the read keeps that true instead of
  // growing a second buddy:* channel just to answer "what's it set to now".
  // Optional (not just boolean) because the remote-shim stub throws before
  // ever constructing a payload, so no caller can assume the field exists.
  getStatus(): Promise<{ dismissed: boolean; visible: boolean; keepAbove?: boolean }>;
  onStatusChanged(cb: (s: { dismissed: boolean; visible: boolean }) => void): () => void;
  onBarState(cb: (s: { visible: boolean }) => void): () => void;
  onMascotState(cb: (s: { mode: 'free' | 'docked' | 'peeking'; edge: string | null }) => void): () => void;
  onChatState(cb: (s: { visible: boolean }) => void): () => void;
  onFocusSession(cb: (sessionId: string) => void): () => void;
  // ── Linux Wayland overlay (Task 3+4) — only the overlay renderer calls
  // these; other buddy surfaces (three-window model) never mount them.
  /** Renderer → main pull, called once on overlay mount: returns the
   *  window-local workArea/mascot/dock the overlay's DOM mascot needs, or
   *  null when the caller isn't the live overlay window. WHY pull, not a
   *  main→renderer push (2026-07-23 dead-floater lesson): a push sent at
   *  did-finish-load races React's mount — in dev, Vite loads the module
   *  graph AFTER did-finish-load, so the one-shot push was gone before the
   *  subscription existed and the overlay rendered nothing forever. A pull
   *  cannot lose that race by construction. */
  overlayReady(): Promise<{
    workArea: { x: number; y: number; width: number; height: number };
    mascot: { x: number; y: number } | null;
    dock: string | null;
  } | null>;
  /** Main → overlay push: external (tray/menu) chat toggle request. */
  onOverlayToggleChat(cb: () => void): () => void;
  /** Fire-and-forget, hover-hot path: overlay renderer reports whether the
   *  pointer is over an interactive element (mascot/bar/chat) so main can
   *  flip the click-through window between ignore/accept mouse events. */
  overlaySetInteractive(interactive: boolean): void;
  /** Fire-and-forget: overlay renderer's own drag/dock logic (DOM-side)
   *  reports the final mascot position + dock edge to persist. */
  overlayPersist(state: { mascot: { x: number; y: number }; dock: string | null }): void;
  // ── Task 8: opt-in KDE keep-above (Settings toggle, Linux only) ──
  /** Persists `enabled` to the buddy positions file and applies it live via
   *  a KWin scripting DBus call (see kwin-keep-above.ts). The toggle itself
   *  is a saved PREFERENCE, not a live-state indicator — it displays and
   *  persists the user's request in both directions regardless of this
   *  result (controller ruling 2026-07-22: a symmetric OR asymmetric
   *  reconcile against this boolean both produced contradictions — see
   *  SettingsPanel.tsx's toggleKeepAbove WHY comment). The resolved boolean
   *  reports only whether the KWin apply actually ran just now — true on
   *  KDE Plasma where the script ran, false everywhere else (GNOME/wlroots/
   *  no qdbus, or a transient DBus failure) — and is used solely to drive
   *  Settings' inline "couldn't reach KWin" hint. Never rejects. */
  setKeepAbove(enabled: boolean): Promise<boolean>;
}

// Marketplace redesign Phase 1 — per-entry component inventory for the
// "What's inside" peek on cards and detail overlays. Extracted at sync time
// by scripts/extract-components.js; `null` on the entry signals extraction
// failure and the UI should hide the peek.
export interface SkillComponents {
  skills: string[];
  hooks: string[];
  commands: string[];
  agents: string[];
  mcpServers: string[];
  hasHooksManifest: boolean;
  hasMcpConfig: boolean;
}

// Known session flag names. Add new flags here + in the renderer's pill list.
// Server-side validation rejects any flag name not in this union.
export type SessionFlagName = 'complete' | 'priority';
export const SESSION_FLAG_NAMES: SessionFlagName[] = ['complete', 'priority'];

/** Generic fallback shown when a host answers session:get-meta with
 *  `supported: false` but no `unsupportedReason` of its own. As of Task 5
 *  (2026-07-2x) native sessions are real Conversation Store records and no
 *  longer answer this way — Android still can (tags/notes aren't built there
 *  yet), so this stays as the renderer's host-neutral catch-all rather than
 *  naming a cause it hasn't verified. Formerly NATIVE_META_UNSUPPORTED, which
 *  named native sessions specifically — renamed when that was no longer true.
 *  Shared by the ipcMain handlers, the remote WS handlers, and the renderer's
 *  disabled-state tooltip so all three say the same thing. */
export const META_UNSUPPORTED_FALLBACK =
  "Tags and notes aren't available for this session.";

/** session:get-meta result. `supported: false` means writes will be REFUSED for
 *  this session — render the controls disabled rather than accepting edits. */
export interface SessionMetaResult {
  tags: string[];
  note: string;
  /** Reserved flags (SESSION_FLAG_NAMES) currently set on the conversation.
   *  OPTIONAL: an older remote peer or Android answers without it, and the
   *  renderer must treat missing as "none set" rather than as an error. Added
   *  2026-07-31 so the in-session tag chip can offer Priority the same way the
   *  Resume Browser does — as a built-in tag rather than a separate control. */
  flags?: Partial<Record<SessionFlagName, boolean>>;
  /** OPTIONAL on purpose: any remote peer running an older build answers get-meta
   *  without this field. Callers must treat a MISSING value as supported — only an
   *  explicit `false` disables the UI. */
  supported?: boolean;
  /** Why writes are unsupported, supplied by whichever backend answered. Hosts
   *  differ (a desktop native session vs. Android, where tags/notes simply aren't
   *  built yet), and showing one host's reason on another would be a misleading
   *  error message. Renderers display this and fall back to the generic constant. */
  unsupportedReason?: string;
}

export interface PastSession {
  /** Claude Code's internal session ID (JSONL filename without extension) */
  sessionId: string;
  /** Human-readable name from topic file, or 'Untitled' */
  name: string;
  /** Project directory slug (e.g. 'C--Users-alice') */
  projectSlug: string;
  /** Display-friendly project path derived from slug */
  projectPath: string;
  /** Last modified timestamp (epoch ms) */
  lastModified: number;
  /** File size in bytes — proxy for conversation length */
  size: number;
  /** User-set flags. `complete` hides from resume menu; `priority` pins to top.
   *  Multiple flags per session are allowed. */
  flags?: Partial<Record<SessionFlagName, boolean>>;
  /** Which runtime owns this past session: `'claude'` (a Claude Code JSONL
   *  transcript — the historical default) or `'native'` (a YouCoded
   *  native-harness session persisted by NativeSessionHost). Drives the Resume
   *  Browser badge + which resume path App uses. Also populated on
   *  Conversation-Store rows (Phase 2a). Typed `string` (not the `'claude' |
   *  'native'` union) because store-fed rows assign it from a stored string. */
  provider?: string;
  /** Native runtime only: the stored harness preset id from the session header
   *  ('assistant' | 'coder' | legacy 'chat'). Drives the Resume Browser's preset
   *  label. Absent for Claude transcripts. */
  harnessId?: string;
  /** Applied custom-tag ids (from the conversation store's `tag:<id>` flag
   *  keys). Resolved to labels/colors by the renderer via the tag registry. */
  tags?: string[];
  /** User's freeform note for this session ('' / absent = none). */
  note?: string;
  /** Last device that ran a turn. Populated on store-fed rows (Conversation
   *  Store, Phase 2a) so the Resume Browser can show where a conversation ran. */
  device?: string;
  /** True when the conversation's project folder is not present on THIS device
   *  (a conversation synced in from another device). Resume is disabled for
   *  these rows — the working directory to resume into doesn't exist here. */
  missingProject?: boolean;
  /** True when the project folder IS on this device but the transcript hasn't
   *  been materialized into ~/.claude/projects yet (sync in flight). Resume is
   *  disabled — `claude --resume` would error on the missing JSONL. Distinct
   *  from missingProject so the renderer can word the note accurately. */
  notSyncedYet?: boolean;
  /** Portable reference to the model this conversation last ran a turn with —
   *  read straight off the Conversation Store record (Task 4 writes it via
   *  noteModelUsed). Absent for legacy-only rows and for a store record no
   *  turn has landed on yet. Task 6 uses it to pre-fill the resume selector. */
  lastUsedModel?: PortableModelRef;
}

export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

// Phase 3c: per-entry config schema for marketplace packages. Entries
// that declare configSchema get a settings form in the detail view.
// Anthropic plugins using their own native config.json are left alone.
export interface ConfigField {
  name: string;
  type: 'string' | 'boolean' | 'number' | 'select';
  label: string;
  description?: string;
  default?: string | boolean | number;
  required?: boolean;
  options?: { value: string; label: string }[]; // for 'select' type
}

export interface ConfigSchema {
  fields: ConfigField[];
}

// Decomposition v3 §9.9: what SkillDetail needs to render integration badges.
// Populated by skill-provider.getIntegrationInfo() which reads the plugin's
// own plugin.json (if installed) or the marketplace entry (if not).
export interface IntegrationInfo {
  // Capabilities the package says it needs (with fallback behavior)
  optionalIntegrations: Array<{
    capability: string;
    installed: boolean;                 // does any installed plugin provide this?
    providerPackageId?: string;         // which one, if installed
    whenAvailable?: string;
    whenUnavailable?: string;
  }>;
  // Capabilities the package itself provides
  provides: Array<{ capability: string; description: string; skill: string }>;
}

// IPC channel names
export const IPC = {
  // Renderer -> Main
  SESSION_CREATE: 'session:create',
  SESSION_DESTROY: 'session:destroy',
  SESSION_INPUT: 'session:input',
  SESSION_RESIZE: 'session:resize',
  SESSION_LIST: 'session:list',
  SESSION_SWITCH: 'session:switch',
  SKILLS_LIST: 'skills:list',
  COMMANDS_LIST: 'commands:list',
  SKILLS_LIST_MARKETPLACE: 'skills:list-marketplace',
  SKILLS_GET_DETAIL: 'skills:get-detail',
  SKILLS_SEARCH: 'skills:search',
  SKILLS_INSTALL: 'skills:install',
  SKILLS_UNINSTALL: 'skills:uninstall',
  SKILLS_GET_FAVORITES: 'skills:get-favorites',
  SKILLS_SET_FAVORITE: 'skills:set-favorite',
  SKILLS_GET_CHIPS: 'skills:get-chips',
  SKILLS_SET_CHIPS: 'skills:set-chips',
  SKILLS_GET_OVERRIDE: 'skills:get-override',
  SKILLS_SET_OVERRIDE: 'skills:set-override',
  SKILLS_CREATE_PROMPT: 'skills:create-prompt',
  SKILLS_DELETE_PROMPT: 'skills:delete-prompt',
  SKILLS_PUBLISH: 'skills:publish',
  SKILLS_GET_SHARE_LINK: 'skills:get-share-link',
  SKILLS_IMPORT_FROM_LINK: 'skills:import-from-link',
  SKILLS_GET_CURATED_DEFAULTS: 'skills:get-curated-defaults',
  // Marketplace redesign Phase 1: featured (hero/rails) for the redesigned
  // discovery UI.
  SKILLS_GET_FEATURED: 'skills:get-featured',
  // Marketplace redesign Phase 3: integrations as a first-class content kind.
  INTEGRATIONS_LIST: 'integrations:list',
  INTEGRATIONS_INSTALL: 'integrations:install',
  INTEGRATIONS_UNINSTALL: 'integrations:uninstall',
  INTEGRATIONS_STATUS: 'integrations:status',
  INTEGRATIONS_CONFIGURE: 'integrations:configure',
  // Re-runs postInstallCommand for an already-installed integration; used
  // by the detail overlay's Connect button when state is installed-but-not-
  // connected (e.g. OAuth expired).
  INTEGRATIONS_CONNECT: 'integrations:connect',
  // Static-per-session lookup — returns 'darwin' | 'win32' | 'linux' | 'android'.
  // Used by the integration cards to gate UI by platform before the user
  // clicks (backend integration-installer.ts also re-checks).
  PLATFORM_GET: 'platform:get',
  // Decomposition v3 §9.9: used by SkillDetail to render integration badges
  SKILLS_GET_INTEGRATION_INFO: 'skills:get-integration-info',
  // Decomposition v3 §9.10: onboarding bulk install + output-style apply
  SKILLS_INSTALL_MANY: 'skills:install-many',
  SKILLS_APPLY_OUTPUT_STYLE: 'skills:apply-output-style',
  TERMINAL_READY: 'session:terminal-ready',
  // Main -> Renderer
  SESSION_CREATED: 'session:created',
  SESSION_DESTROYED: 'session:destroyed',
  // Plan 2b Task 8: pushed to the renderer + remote when another device took over
  // a conversation this device held — the holder-side takeover ends the local
  // session and the UI shows a "moved to <device>" banner.
  SESSION_MOVED: 'session:moved',
  PTY_OUTPUT: 'pty:output',
  HOOK_EVENT: 'hook:event',
  SESSION_RENAMED: 'session:renamed',
  DIALOG_OPEN_FILE: 'dialog:open-file',
  DIALOG_OPEN_FOLDER: 'dialog:open-folder',
  DIALOG_OPEN_SOUND: 'dialog:open-sound',
  CLIPBOARD_SAVE_IMAGE: 'clipboard:save-image',
  STATUS_DATA: 'status:data',
  READ_TRANSCRIPT_META: 'transcript:read-meta',
  OPEN_CHANGELOG: 'shell:open-changelog',
  UPDATE_CHANGELOG: 'update:changelog',
  UPDATE_DOWNLOAD: 'update:download',
  UPDATE_CANCEL: 'update:cancel',
  UPDATE_LAUNCH: 'update:launch',
  UPDATE_PROGRESS: 'update:progress',
  UPDATE_GET_CACHED_DOWNLOAD: 'update:get-cached-download',
  OPEN_EXTERNAL: 'shell:open-external',
  SHOW_ITEM_IN_FOLDER: 'shell:show-item-in-folder',
  // Open a local file with the OS default app (HTML→browser, .docx→Word, etc.).
  // Desktop-only: Android has no desktop shell; remote-shim no-ops it.
  OPEN_PATH: 'shell:open-path',
  PERMISSION_RESPOND: 'permission:respond',
  // Remote settings
  REMOTE_GET_CONFIG: 'remote:get-config',
  REMOTE_SET_PASSWORD: 'remote:set-password',
  REMOTE_SET_CONFIG: 'remote:set-config',
  REMOTE_DETECT_TAILSCALE: 'remote:detect-tailscale',
  REMOTE_GET_CLIENT_COUNT: 'remote:get-client-count',
  REMOTE_GET_CLIENT_LIST: 'remote:get-client-list',
  REMOTE_DISCONNECT_CLIENT: 'remote:disconnect-client',
  REMOTE_INSTALL_TAILSCALE: 'remote:install-tailscale',
  REMOTE_AUTH_TAILSCALE: 'remote:auth-tailscale',
  UI_ACTION_BROADCAST: 'ui:action:broadcast',
  UI_ACTION_RECEIVED: 'ui:action:received',
  TRANSCRIPT_EVENT: 'transcript:event',
  // JSONL truncation — fired on /clear or /compact rewrite. App uses to
  // detect /compact completion (see slash-command-dispatcher).
  TRANSCRIPT_SHRINK: 'transcript:shrink',
  // Session browser
  SESSION_BROWSE: 'session:browse',
  SESSION_HISTORY: 'session:history',
  // Mark/unmark a session flag (complete, priority, helpful, …)
  SESSION_SET_FLAG: 'session:set-flag',
  // Broadcast when session metadata changes (carries a flag + value)
  SESSION_META_CHANGED: 'session:meta-changed',
  // Custom session tags (registry CRUD + application) and per-session notes.
  SESSION_SET_TAG: 'session:set-tag',   // (sessionId, tagId, value)
  SESSION_SET_NOTE: 'session:set-note', // (sessionId, note)
  SESSION_GET_META: 'session:get-meta', // (sessionId) → { tags, note, supported }
  TAGS_LIST: 'tags:list',
  TAGS_CREATE: 'tags:create',           // (label, color)
  TAGS_UPDATE: 'tags:update',           // (id, { label?, color?, archived? })
  TAGS_DELETE: 'tags:delete',           // (id)
  TAGS_CHANGED: 'tags:changed',         // push: registry mutated
  // Folder switcher
  FOLDERS_LIST: 'folders:list',
  FOLDERS_ADD: 'folders:add',
  FOLDERS_REMOVE: 'folders:remove',
  FOLDERS_RENAME: 'folders:rename',
  // Local-only description on a saved folder — sibling of FOLDERS_RENAME, same
  // store (saved-folders.ts), never syncs (see SavedFolder.description).
  FOLDERS_SET_DESCRIPTION: 'folders:set-description',
  // Theme system
  THEME_RELOAD: 'theme:reload',   // Main -> Renderer: a theme file changed
  THEME_LIST: 'theme:list',       // Renderer -> Main: get list of user theme slugs
  THEME_READ_FILE: 'theme:read-file', // Renderer -> Main: read a user theme JSON by slug
  THEME_WRITE_FILE: 'theme:write-file',
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE: 'window:maximize',
  WINDOW_CLOSE: 'window:close',
  WINDOW_SET_ICON: 'window:set-icon', // theme-driven window + dock icon hot-swap
  // Repositions macOS traffic lights so they sit inside the floating chrome's
  // rounded header; null restores OS default. Called from theme-engine.
  WINDOW_SET_TRAFFIC_LIGHT_POS: 'window:set-traffic-light-pos',
  // Zoom controls
  ZOOM_IN: 'zoom:in',
  ZOOM_OUT: 'zoom:out',
  ZOOM_RESET: 'zoom:reset',
  ZOOM_GET: 'zoom:get',
  // Theme marketplace
  THEME_MARKETPLACE_LIST: 'theme-marketplace:list',
  THEME_MARKETPLACE_DETAIL: 'theme-marketplace:detail',
  THEME_MARKETPLACE_INSTALL: 'theme-marketplace:install',
  THEME_MARKETPLACE_UNINSTALL: 'theme-marketplace:uninstall',
  THEME_MARKETPLACE_UPDATE: 'theme-marketplace:update',
  THEME_MARKETPLACE_PUBLISH: 'theme-marketplace:publish',
  THEME_MARKETPLACE_GENERATE_PREVIEW: 'theme-marketplace:generate-preview',
  THEME_MARKETPLACE_RESOLVE_PUBLISH_STATE: 'theme-marketplace:resolve-publish-state',
  THEME_MARKETPLACE_REFRESH_REGISTRY: 'theme-marketplace:refresh-registry',
  // Unified marketplace — packages + update + config (Phase 3)
  MARKETPLACE_GET_PACKAGES: 'marketplace:get-packages',
  SKILLS_UPDATE: 'skills:update',
  MARKETPLACE_GET_CONFIG: 'marketplace:get-config',
  MARKETPLACE_SET_CONFIG: 'marketplace:set-config',
  // Phase 4 — force-refresh the featured/index caches without waiting for
  // the 24h TTL. Useful right after /feature curation lands.
  MARKETPLACE_INVALIDATE_CACHE: 'marketplace:invalidate-cache',
  // In-app file viewer — reads a plugin's SKILL.md / command / agent markdown.
  // Tries the local install dir first, falls back to a raw GitHub URL derived
  // from the marketplace entry's sourceType/sourceRef.
  MARKETPLACE_READ_COMPONENT: 'marketplace:read-component',
  // First-run
  FIRST_RUN_STATE: 'first-run:state',
  FIRST_RUN_RETRY: 'first-run:retry',
  FIRST_RUN_START_AUTH: 'first-run:start-auth',
  FIRST_RUN_SUBMIT_API_KEY: 'first-run:submit-api-key',
  FIRST_RUN_DEV_MODE_DONE: 'first-run:dev-mode-done',
  FIRST_RUN_SKIP: 'first-run:skip',
  // Sync management
  SYNC_GET_STATUS: 'sync:get-status',
  SYNC_GET_CONFIG: 'sync:get-config',
  SYNC_SET_CONFIG: 'sync:set-config',
  SYNC_FORCE: 'sync:force',
  SYNC_GET_LOG: 'sync:get-log',
  SYNC_DISMISS_WARNING: 'sync:dismiss-warning',
  // Cross-device sync spaces (spec 2026-07-03) — distinct from the legacy sync:* above
  SYNC_SPACES_STATUS: 'syncspaces:status',
  SYNC_SPACES_ENABLE: 'syncspaces:enable',
  SYNC_SPACES_SYNC_NOW: 'syncspaces:sync-now',
  SYNC_SPACES_CREATE_PROJECT: 'syncspaces:create-project',
  SYNC_SPACES_IMPORT_PROJECT: 'syncspaces:import-project',
  SYNC_SPACES_RENAME_PROJECT: 'syncspaces:rename-project',
  // Synced project description (Task 3). preload.ts keeps its own inlined copy
  // of this constant (sandboxed preload can't import); this is the copy
  // ipc-handlers.ts resolves IPC.SYNC_SPACES_SET_PROJECT_DESCRIPTION against.
  SYNC_SPACES_SET_PROJECT_DESCRIPTION: 'syncspaces:set-project-description',
  SYNC_SPACES_STOP_PROJECT: 'syncspaces:stop-project',
  // Conversation-lease takeover (Plan 2b Task 9). query = who holds this session;
  // takeover = ask-hand-off-then-poll-and-acquire; force = overwrite a stale lease.
  SYNC_SPACES_LEASE_QUERY: 'syncspaces:lease-query',
  SYNC_SPACES_LEASE_TAKEOVER: 'syncspaces:lease-takeover',
  SYNC_SPACES_LEASE_FORCE: 'syncspaces:lease-force',
  // Device registry (Plan 2b spec §10a) — the "Your devices" list + rename.
  SYNC_SPACES_LIST_DEVICES: 'syncspaces:list-devices',
  SYNC_SPACES_RENAME_DEVICE: 'syncspaces:rename-device',
  SYNC_SPACES_REMOVE_DEVICE: 'syncspaces:remove-device',
  SYNC_SPACES_EVENT: 'syncspaces:event',
  // Connect-GitHub modal (device-flow auth) — lets non-developers connect GitHub
  // in-app so enabling Sync never dead-ends on "gh not installed / not signed in".
  // status/install are plain request-response; connect-start kicks off main-side
  // device-flow polling and pushes GITHUB_CONNECT_DONE when it settles.
  GITHUB_STATUS: 'github:status',
  GITHUB_CONNECT_START: 'github:connect-start',
  GITHUB_CONNECT_CANCEL: 'github:connect-cancel',
  GITHUB_INSTALL_GH: 'github:install-gh',
  GITHUB_DISCONNECT: 'github:disconnect', // clears the app's stored token (Connected accounts)
  GITHUB_CONNECT_DONE: 'github:connect-done', // push: {ok, login?, error?}
  // Multi-window detach subsystem (Renderer <-> Main)
  WINDOW_GET_ID: 'window:get-id',
  WINDOW_DIRECTORY_UPDATED: 'window:directory-updated',
  WINDOW_GET_DIRECTORY: 'window:get-directory',
  WINDOW_LEADER_CHANGED: 'window:leader-changed',
  WINDOW_OPEN_DETACHED: 'window:open-detached',
  WINDOW_FOCUS_AND_SWITCH: 'window:focus-and-switch',
  SESSION_OWNERSHIP_ACQUIRED: 'session:ownership-acquired',
  SESSION_OWNERSHIP_LOST: 'session:ownership-lost',
  // Pull half of SESSION_OWNERSHIP_ACQUIRED. A window created BY a tear-off is
  // handed its session before its renderer can subscribe, and Electron drops
  // (never queues) a send with no listener — so the renderer asks for what it
  // inherited once mounted. Returns SessionOwnershipAcquired[] and clears it.
  DETACH_CLAIM_PENDING: 'detach:claim-pending',
  // Re-send the parts of a session's state that live ONLY in main's memory and
  // have no record in the transcript on disk: open permission asks, specialist
  // run records, background shell run records, and the replay-complete marker
  // that reaps tool cards the history left 'running'. Split out of
  // TRANSCRIPT_REPLAY so an ownership handoff can hydrate from one PAGE of
  // history instead of a whole-transcript replay.
  SESSION_REPLAY_LIVE_STATE: 'session:replay-live-state',
  SESSION_DETACH_START: 'session:detach-start',
  // Chrome-style live tear-off: spawn the peer window mid-drag (before pointerup)
  // once the pill has moved far enough from the header. Source window then
  // streams cursor positions via SESSION_DRAG_WINDOW_MOVE so the new window
  // tracks the cursor until the user releases.
  SESSION_DETACH_LIVE: 'session:detach-live',
  SESSION_DRAG_WINDOW_MOVE: 'session:drag-window-move',
  SESSION_DRAG_STARTED: 'session:drag-started',
  SESSION_DRAG_ENDED: 'session:drag-ended',
  SESSION_DRAG_DROPPED: 'session:drag-dropped',
  SESSION_DRAG_ADOPT: 'session:drag-adopt',
  SESSION_DROP_RESOLVE: 'session:drop-resolve',
  CROSS_WINDOW_CURSOR: 'session:cross-window-cursor',
  // Request the full transcript history for a session — used when a window
  // acquires ownership and needs to hydrate its reducer from disk.
  TRANSCRIPT_REPLAY: 'transcript:replay-from-start',
  // Perf cycle 2: request/response. Returns the last page of history (the most
  // recent PAGE_TURNS turns), or the page before a cursor. Replaces
  // TRANSCRIPT_REPLAY for first load — replay stays only for the ownership
  // handoff, which also re-sends broker-held asks and specialist runs.
  TRANSCRIPT_PAGE: 'transcript:page',
  // Appearance sync across peer windows — Renderer → Main broadcasts, Main
  // → other Renderers applies without re-broadcasting. Lets a theme change
  // in window 2 propagate to window 1 without a reload.
  APPEARANCE_BROADCAST: 'appearance:broadcast',
  APPEARANCE_SYNC: 'appearance:sync',
  APPEARANCE_GET_FAVORITE_THEMES: 'appearance:get-favorite-themes',
  APPEARANCE_FAVORITE_THEME: 'appearance:favorite-theme',
  // Buddy floater (desktop-only MVP)
  BUDDY_SHOW: 'buddy:show',
  BUDDY_HIDE: 'buddy:hide',
  BUDDY_TOGGLE_CHAT: 'buddy:toggle-chat',
  BUDDY_SET_SESSION: 'buddy:set-session',
  BUDDY_SUBSCRIBE: 'buddy:subscribe',
  BUDDY_UNSUBSCRIBE: 'buddy:unsubscribe',
  BUDDY_GET_VIEWED_SESSION: 'buddy:get-viewed-session',
  // Renderer → main drag events. Fire-and-forget because drag generates
  // ~60 events/sec while the pointer moves; invoke() round-trips would
  // starve the renderer's event loop. Main clamps and calls setPosition.
  BUDDY_MOVE_MASCOT: 'buddy:move-mascot',
  // Capture the desktop with buddy windows excluded, write to a temp PNG,
  // and push the file path to the chat renderer on BUDDY_ATTACH_FILE.
  // Invoked from the capture-icon renderer; main does the hide/capture/
  // restore sequence because the renderer can't hide Electron windows.
  BUDDY_CAPTURE_DESKTOP: 'buddy:capture-desktop',
  // Main → chat-renderer push. Chat renderer's InputBar listens and adds
  // the file as an attachment (same pipeline as clipboard-image paste).
  BUDDY_ATTACH_FILE: 'buddy:attach-file',
  // ── Buddy upgrades (action bar, dismiss, dock/peek) ──
  // Fire-and-forget: mascot + bar renderers report pointer enter/leave; main
  // coalesces with a grace timeout to decide bar visibility.
  // Fire-and-forget: mascot renderer signals drag release so main can run
  // edge-snap detection against the window's final bounds.
  BUDDY_DRAG_ENDED: 'buddy:drag-ended',
  // Restore + focus the main window and switch it to the buddy's viewed session.
  BUDDY_OPEN_MAIN: 'buddy:open-main',
  // Hide the buddy for this app run only (preference stays enabled).
  BUDDY_DISMISS: 'buddy:dismiss',
  BUDDY_GET_STATUS: 'buddy:get-status',
  // Main → all windows: { dismissed, visible } so open Settings panels update live.
  BUDDY_STATUS_CHANGED: 'buddy:status-changed',
  // Main → bar renderer: fade the action bar in/out (window stays shown; CSS animates).
  BUDDY_BAR_STATE: 'buddy:bar-state',
  // Main → mascot renderer: dock/peek state for the sink animation + peek pose.
  BUDDY_MASCOT_STATE: 'buddy:mascot-state',
  // Main → chat renderer: entrance/exit animation cue around show/hide.
  BUDDY_CHAT_STATE: 'buddy:chat-state',
  // Linux Wayland overlay (Task 3+): main → overlay renderer, sent once on
  // did-finish-load with window-local workArea/mascot/dock (BuddyOverlayManager's
  // overlayInitPayload). External toggle-chat push for the same overlay
  // window. The rest of the overlay IPC surface (renderer→main channels,
  // BuddyApi, preload wiring) lands in the next commit (Task 4) — these two
  // are added now only so this commit's manager code type-checks.
  BUDDY_OVERLAY_READY: 'buddy:overlay-ready',
  BUDDY_OVERLAY_TOGGLE_CHAT: 'buddy:overlay-toggle-chat',
  // Task 4: renderer → main, fire-and-forget. Hover-hot path (mousemove over
  // the mascot/bar/chat toggles hit-testing many times/sec) so this is `send`,
  // not `invoke` — same reasoning as BUDDY_MOVE_MASCOT above.
  BUDDY_OVERLAY_SET_INTERACTIVE: 'buddy:overlay-set-interactive',
  // Task 4: renderer → main, fire-and-forget. Renderer owns drag/dock state
  // (DOM-side for the overlay model) and pushes the final position here to
  // persist — main never computes it, just writes it to BUDDY_POS_FILE.
  BUDDY_OVERLAY_PERSIST: 'buddy:overlay-persist',
  // Task 8: renderer → main, invoke/handle (unlike the fire-and-forget
  // overlay channels above — this one returns a result, and toggling is
  // rare/user-driven, not a hover-hot path). Settings' keep-above toggle:
  // persists to BUDDY_POS_FILE and runs the KWin script live.
  BUDDY_OVERLAY_KEEP_ABOVE: 'buddy:overlay-keep-above',
  // ── The Linux/KDE buddy helper (docs/active/design/2026-09-04-linux-buddy-helper/) ──
  // On a native-Wayland desktop an app is not allowed to move its own windows,
  // so the buddy appears but cannot be dragged. A small script that runs inside
  // KDE's window manager can move it. These three channels are the app's side
  // of that script: ask whether it is needed/possible/present, put it in the
  // user's KDE settings, and take it back out again.
  //
  // Deliberately three surfaces, not five: buddy has NO Android (SessionService.kt)
  // or remote-server presence today, and adding one would turn this feature into
  // a platform-parity sweep (design §4). ipc-channels.test.ts's `buddy:*` block
  // records that omission so it does not read as an oversight.
  BUDDY_HELPER_STATUS: 'buddy:helper-status',
  BUDDY_INSTALL_HELPER: 'buddy:install-helper',
  BUDDY_REMOVE_HELPER: 'buddy:remove-helper',
  // Main → main window: switch active session (sent by buddy:open-main).
  SESSION_FOCUS_REQUEST: 'session:focus-request',
  SESSION_ATTENTION_SUMMARY: 'session:attention-summary',
  ATTENTION_REPORT: 'attention:report',
  ATTENTION_GET_SUMMARY: 'attention:get-summary',
  // Settings → Development feature (bug report, contribute, known issues)
  DEV_LOG_TAIL: 'dev:log-tail',
  DEV_DIAGNOSTICS: 'dev:diagnostics',
  DEV_SUMMARIZE_ISSUE: 'dev:summarize-issue',
  DEV_SUBMIT_ISSUE: 'dev:submit-issue',
  DEV_INSTALL_WORKSPACE: 'dev:install-workspace',
  DEV_INSTALL_PROGRESS: 'dev:install-progress',
  DEV_OPEN_SESSION_IN: 'dev:open-session-in',
  // Performance / GPU settings — not app:restart because future restart-required
  // settings (e.g. renderer process changes) can reuse the same generic channel.
  PERFORMANCE_GET_CONFIG: 'performance:get-config',
  PERFORMANCE_SET_CONFIG: 'performance:set-config',
  APP_RESTART: 'app:restart',
  // System namespace — hardware back button bridge (Android only)
  SYSTEM_NOTIFY_STACK_STATE: 'system:notify-stack-state',
  SYSTEM_BACK: 'system:back',
  // ---- Native runtime (YouCoded first-party harness — platform roadmap Phase 1+) ----
  // Capability probe: false everywhere until Phase 1 ships the engine.
  NATIVE_SUPPORTED: 'native:supported',
  // ---- Native runtime Plan A (Phase 1): session I/O + provider management ----
  NATIVE_SEND: 'native:send',
  // Task 11: cancel/edit a queued-but-not-yet-sent message. invoke →
  // NativeSessionHost.removeQueued(sessionId, queueId): boolean.
  NATIVE_QUEUE_REMOVE: 'native:queue-remove',
  NATIVE_INTERRUPT: 'native:interrupt',
  // Stalled-turn Retry (fire-and-forget like interrupt above). Re-runs the ONE
  // parked step; unlike interrupt it never cascades to specialist children or
  // cancels pending permission asks.
  NATIVE_RETRY: 'native:retry',
  // M3 item 2 — user-initiated /compact for a native session. invoke (not send):
  // the caller needs the {ok, reason} result to explain a refusal.
  NATIVE_COMPACT: 'native:compact',
  // M3 item 2 — /clear as a context barrier. invoke: the caller needs {ok, reason}.
  NATIVE_CLEAR: 'native:clear',
  NATIVE_INVOKE_SKILL: 'native:invoke-skill',
  NATIVE_SET_BINDING: 'native:set-binding',
  NATIVE_SET_PERMISSION_MODE: 'native:set-permission-mode',
  // Read the session's current native permission mode. Seeds the StatusBar chip
  // on create/resume so a fresh Coder session shows AUTO EDIT (not the default ASK).
  NATIVE_GET_PERMISSION_MODE: 'native:get-permission-mode',
  NATIVE_GET_STEP_GUARD: 'native:get-step-guard',
  NATIVE_SET_STEP_GUARD: 'native:set-step-guard',
  NATIVE_SESSIONS_LIST: 'native:sessions-list',
  NATIVE_KILL_SHELL: 'native:kill-shell',   // G-1: the Bash card's Stop button
  PROVIDER_LIST: 'provider:list',
  PROVIDER_UPSERT: 'provider:upsert',
  PROVIDER_REMOVE: 'provider:remove',
  PROVIDER_TEST: 'provider:test',
  PROVIDER_SET_KEY: 'provider:set-key',
  PROVIDER_CATALOG: 'provider:catalog',
  // ---- Sign in with ChatGPT (design 2026-09-04, backend design 2026-09-05 §5) ----
  // status → ChatGptAccountStatus (shared/chatgpt-types.ts); the three verbs →
  // boolean, or a THROWN sentence the card renders verbatim. Kill switch
  // YOUCODED_CHATGPT=0: the handlers stay registered (parity) and answer
  // signed-out / false.
  CHATGPT_STATUS: 'chatgpt:status',
  CHATGPT_SIGN_IN: 'chatgpt:sign-in',
  CHATGPT_CANCEL_SIGN_IN: 'chatgpt:cancel-sign-in',
  CHATGPT_SIGN_OUT: 'chatgpt:sign-out',
  // ---- WebSearch providers (Phase 2 Plan B): keyed Tavily/Exa upgrades ----
  // list = the fixed upgradeable-backend rows (hasKey flags); set/remove-key
  // manage the encrypted key; test = never-throws connectivity check.
  SEARCH_LIST: 'search:list',
  SEARCH_SET_KEY: 'search:set-key',
  SEARCH_REMOVE_KEY: 'search:remove-key',
  SEARCH_TEST: 'search:test',
  // ---- Remembered "Always allow" rules (M5 2a: permissions management UI) ----
  // list = every project's stored grants; remove/remove-project revoke them.
  // Keyed by PROJECT SLUG, not cwd — permissions.json never stored the cwd for
  // pre-existing entries and nativeStoreSlug is lossy, so the slug is the only
  // stable handle the renderer can send back.
  // ---- fs:read-head — first bytes of a user-chosen file for a preview tile ----
  // Capped in main at READ_HEAD_MAX_BYTES (shared/read-head.ts) whatever the
  // renderer asks for; sensitive paths refused. See main/fs-read-head.ts.
  FS_READ_HEAD: 'fs:read-head',
  PERMISSIONS_LIST: 'permissions:list',
  PERMISSIONS_REMOVE: 'permissions:remove',
  PERMISSIONS_REMOVE_PROJECT: 'permissions:remove-project',
  // ---- Specialists 1c (Task 8): roster + tier reads/writes + card actions ----
  // list ALWAYS re-reads the three definition folders (never a cached
  // snapshot) so a file dropped in a moment ago shows up without a Refresh
  // click; delegated-get/set are the two model-tier reads/writes; steer/
  // interrupt are the card's user-facing "send a note" / "stop" actions.
  // specialists:event is a PUSH (no request) — the delegation ledger's own
  // write is what triggers it, never a direct emit from a handler here.
  SPECIALISTS_LIST: 'specialists:list',
  SPECIALISTS_DELEGATED_GET: 'specialists:delegated-get',
  SPECIALISTS_DELEGATED_SET: 'specialists:delegated-set',
  SPECIALISTS_STEER: 'specialists:steer',
  SPECIALISTS_INTERRUPT: 'specialists:interrupt',
  SPECIALISTS_EVENT: 'specialists:event',
  // ---- Native runtime Plan B (Phase 1): local llama.cpp engine ----
  ENGINE_STATUS: 'engine:status',
  ENGINE_INSTALL: 'engine:install',
  ENGINE_RESTART: 'engine:restart',
  // Push events (no id): install progress + run-state transitions.
  ENGINE_INSTALL_PROGRESS: 'engine:install-progress',
  ENGINE_STATUS_CHANGED: 'engine:status-changed',
  // ---- Native runtime Plan C (Phase 1): model manager ----
  ENGINE_SET_BACKEND: 'engine:set-backend',
  ENGINE_SET_CONTEXT: 'engine:set-context',   // context-length knob (Task 9)
  // One write for every engine-wide setting — { contextSize?, speed? } (design
  // §B). Both are applied only once no reply is streaming, so a switch flipped
  // mid-answer cannot kill the answer. ENGINE_SET_CONTEXT above is now a thin
  // alias onto this for the callers already wired to it.
  ENGINE_SET_CONFIG: 'engine:set-config',
  // Open a plain-shell session (SessionProvider 'shell') in the folder the
  // calling window is working in and TYPE the command onto its prompt —
  // invoke(command) → { sessionId }. Nothing is executed: the user presses
  // Enter. The renderer that made the call selects the session it gets back.
  ENGINE_RUN_IN_TERMINAL: 'engine:run-in-terminal',
  // What a faster engine build needs installed before it can be offered
  // (Linux ROCm) — 2026-09-05 local-engine upgrades §A3/§A5.
  ENGINE_PREREQS: 'engine:prereqs',
  MODELS_CURATED: 'models:curated',
  MODELS_SEARCH: 'models:search',
  MODELS_QUANTS: 'models:quants',
  MODELS_DOWNLOAD: 'models:download',
  MODELS_DOWNLOAD_CANCEL: 'models:download-cancel',
  MODELS_DOWNLOAD_PROGRESS: 'models:download-progress',  // push
  MODELS_DELETE: 'models:delete',
  MODELS_INSTALLED: 'models:installed',
  // Resume an interrupted download from its manifest (2026-08-26) — invoke(modelId)
  // → { downloadId }. Replaces MODELS_ORPHANED_PARTIALS, removed the same day.
  MODELS_RESUME: 'models:resume',
  // ---- Per-model settings + vision (2026-09-05 local-engine upgrades) ----
  // Read one model's stored settings — invoke(modelId) -> StoredModelSettings.
  // The READ is the stored shape, not the four fields the dialog writes: the
  // dialog also has to show `pendingApply` ("Applies after the current reply")
  // and `lastLoadError`, and neither of those is anything the user can set.
  MODELS_SETTINGS: 'models:settings',
  // Save one model's settings — invoke(modelId, patch) -> StoredModelSettings.
  // The patch is `ModelSettingsWrite`: the four user-settable fields, plus the
  // `dismissMemoryWarning` SIGNAL. It is a signal and not a value because the
  // number that gets stored is the resolved effective context length, and only
  // main knows how the per-model setting and the engine-wide default combine.
  MODELS_SET_SETTINGS: 'models:set-settings',
  // Fetch the vision projector for a model already on disk and move both into a
  // folder of its own — invoke(modelId) -> { downloadId }. Progress arrives on
  // the ordinary models:download-progress stream.
  MODELS_ADD_VISION: 'models:add-vision',
  ENDPOINTS_DETECT: 'endpoints:detect',
  // ---- Model memory lifecycle (2026-07-14): per-model residency + guards ----
  ENGINE_MODELS: 'engine:models',                 // invoke → EngineModel[] with live state
  ENGINE_MODELS_CHANGED: 'engine:models-changed', // push → EngineModel[] on any state change
  NATIVE_MODEL_STATE: 'native:model-state',       // push → per-session bound-model state
  NATIVE_SHELL_EVENT: 'native:shell-event',       // push → one background command's run record changed (G-1)
  MODELS_MEMORY_CHECK: 'models:memory-check',     // invoke(modelId) → MemoryVerdict
  MODELS_LOAD: 'models:load',                     // invoke(modelId) → true ([Reload Model])
  // ---- Voice prompting (design 2026-09-05) ----
  // Mirrors preload.ts. Added here when the buddy-helper branch's channel-map
  // guard caught them as preload-only: the voice work declared them on one side
  // of the pair only, which is exactly the drift that guard exists to name.
  VOICE_STATUS: 'voice:status',
  VOICE_DOWNLOAD: 'voice:download',
  VOICE_START: 'voice:start',
  VOICE_STOP: 'voice:stop',
  VOICE_CANCEL: 'voice:cancel',
  VOICE_MIC_ACCESS: 'voice:mic-access',
  VOICE_AUDIO: 'voice:audio',
  VOICE_EVENT: 'voice:event',   // push
} as const;

// Performance / GPU configuration snapshot — returned by performance:get-config.
// multiGpuDetected: false means the Performance section in Settings is hidden.
export interface PerformanceConfigSnapshot {
  preferPowerSaving: boolean;
  appliedAtLaunch: boolean;
  multiGpuDetected: boolean;
  gpuList: string[];
}

// --- Window registry / detach types ---

export interface WindowInfo {
  id: number;           // BrowserWindow webContentsId
  label: string;        // e.g. "window 2" (creation order)
  createdAt: number;
}

export interface WindowDirectoryEntry {
  window: WindowInfo;
  sessions: SessionInfo[];
}

export interface WindowDirectory {
  leaderWindowId: number;
  windows: WindowDirectoryEntry[];
}

export interface SessionOwnershipAcquired {
  sessionId: string;
  sessionInfo: SessionInfo;
  /** True when the window was just created for this session (skip replay delay UI). */
  freshWindow: boolean;
}

export interface SessionOwnershipLost {
  sessionId: string;
}

export interface DetachStartPayload {
  sessionId: string;
  screenX: number;
  screenY: number;
}

export interface DragDroppedPayload {
  sessionId: string;
  targetWindowId: number;
  insertIndex: number;
}

export interface CrossWindowCursor {
  screenX: number;
  screenY: number;
}

// Discriminator for development-flow IPC payloads.
export type DevIssueKind = 'bug' | 'feature';
