import { ChatMessage, ToolCallState, ToolGroupState, type AttentionState, type SpecialistRunView, type ShellRunView, type PageCursor, type TranscriptEvent } from '../../shared/types';
import { emptyTotals, type SessionTotals } from './session-totals';
// Re-export so test files and future consumers can import these types from
// chat-types directly, without reaching into the shared/types boundary.
export type { ToolCallState, AttentionState };

export interface InteractivePrompt {
  promptId: string;
  title: string;
  description?: string; // Contextual text explaining the prompt (e.g., resume trade-offs)
  // `input` is the keystroke(s) that pick this option — a bare digit for CC's
  // numbered menus. `submitInput` is a rare SECOND write (arrow fallback only);
  // arrows and `\r` must never share one write. See parser/ink-select-parser.
  buttons: { label: string; input: string; submitInput?: string }[];
  completed?: string; // label of the selected option, if completed
}

// Sentinel promptId for the "See previous messages" affordance. It rides the
// `prompt` timeline kind so ChatView can render it, but it is NOT an interactive
// menu waiting on the user — so the pty-input send gate must NOT treat it as a
// pending interaction (see hasPendingInteraction). One constant, four call
// sites (chat-reducer push + filter, ChatView render, pty-input-gate skip), so
// the magic string can't drift. Fix 2026-07-17: it was silently locking chat on
// every resumed session.
export const HISTORY_EXPAND_PROMPT_ID = '_history_expand';

// --- Assistant turn types ---

export type AssistantTurnSegment =
  | { type: 'text'; content: string; messageId: string;
      // Native runtime streams text as per-token deltas merged by partId
      // (same semantics as reasoning). CC's transcript path sends whole
      // blocks with no partId — those keep appending as separate segments.
      partId?: string }
  // Reasoning / extended-thinking content with a text payload. The native
  // harness (Phase 2) streams these for thinking models; CC's transcript
  // path may also carry thinking text in future. Rendered as a collapsible
  // disclosure attached to the next text bubble. Reasoning streams as
  // per-token deltas merged into one segment by partId — UNLIKE the text
  // path, which appends each whole block as its own segment.
  | { type: 'reasoning'; content: string; messageId: string; partId?: string }
  | { type: 'tool-group'; groupId: string }
  // Plan mode: ExitPlanMode tool's `input.plan` surfaced as its own bubble so
  // users see the full plan markdown in chat, not just the approval buttons.
  // Linked to the tool via toolUseId so the reducer can dedup across re-emits.
  | { type: 'plan'; messageId: string; toolUseId: string; content: string; planFilePath?: string; allowedPrompts?: unknown };

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Native runtime only: output tokens / stream seconds (from turn-complete).
   *  Absent for CC turns. Feeds the StatusBar native speed chip (Task 12). */
  tokensPerSecond?: number;
  /** Native runtime only: the session's REAL context window (resolved in main,
   *  Task 4/5), carried on the turn-complete payload. Feeds the StatusBar native
   *  context % chip (Task 12). Constant per session; absent for CC turns. */
  contextLength?: number | null;
  /** Native runtime only: tokens OCCUPYING the window after this turn (last
   *  step's prompt + its output). Drives the context pill; inputTokens cannot,
   *  because it sums across steps and re-counts history each time. */
  contextUsedTokens?: number;
  /** Native runtime only: USD for THIS turn, priced in main at the model that
   *  ran it (spec §5). null = the model has no published price; ABSENT = no
   *  pricing information at all (a CC turn). Without this field a priced turn
   *  could not reach the session totals at all — App.tsx forwards the whole
   *  usage object, so widening the TYPE is what lets the number through. */
  costUsd?: number | null;
  /** Native runtime only: the turn ran on a model that costs nothing (a local
   *  engine, or a rate card of zeroes). Distinct from an absent costUsd —
   *  see session-totals.ts's anyFree/anyUnpriced. */
  free?: boolean;
}

export interface AssistantTurn {
  id: string;
  segments: AssistantTurnSegment[];
  /** Epoch ms — captured from the first segment's transcript event */
  timestamp?: number;
  /** Only set when stop_reason is non-end_turn (max_tokens, refusal, etc.). Null for normal completions. */
  stopReason: string | null;
  /** Model ID from the transcript (e.g. 'claude-opus-4-7'). Drives per-turn model chip + drift detection. */
  model: string | null;
  /** Token + cache usage from message.usage. Rendered in the opt-in metadata strip. */
  usage: TurnUsage | null;
  /** Anthropic API request ID (req_…). Surfaced in error banners for support correlation. */
  anthropicRequestId: string | null;
}

/** The single definition of "a stopReason worth surfacing" — `end_turn` is the
 *  normal completion and carries no signal. Lives HERE (not in a component) so
 *  the reducer's turn-complete mint gate and the render gates below share one
 *  predicate: a minted turn the gates drop, or a droppable turn that mints,
 *  is exactly the divergence that shipped the empty_response footer as dead
 *  code once (PR #324 review). */
export function abnormalStopReason(reason: string | null | undefined): boolean {
  return !!reason && reason !== 'end_turn';
}

/** Timeline render gate shared by ChatView and the buddy BubbleFeed (which
 *  MUST mirror each other): a segment-less turn renders only when it carries
 *  an abnormal stopReason — its footer row is the whole fix for the
 *  empty_response bug (a fully-contentless turn must not end in unexplained
 *  silence). All other segment-less turns drop. */
export function shouldRenderAssistantTurn(turn: AssistantTurn | undefined): turn is AssistantTurn {
  if (!turn) return false;
  return turn.segments.length > 0 || abnormalStopReason(turn.stopReason);
}

// Snapshot of session stats + rate limits captured when /cost or /usage was typed.
// Point-in-time — never auto-updates. The live view lives in the status bar.
export interface UsageSnapshot {
  entryId: string;              // stable id so re-renders don't duplicate
  timestamp: number;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  contextTokens: number | null;
  contextPercent: number | null;
  duration: number | null;
  apiDuration: number | null;
  linesAdded: number | null;
  linesRemoved: number | null;
  /** Utilization of the Claude SUBSCRIPTION, as a PERCENT (0-100) — the unit
   *  the cache file uses (~/.claude/.usage-cache.json → "utilization": 42) and
   *  the unit the status bar prints. NOT a 0-1 ratio. */
  fiveHourUtilization: number | null;
  fiveHourResetsAt: string | null;
  sevenDayUtilization: number | null;
  sevenDayResetsAt: string | null;
  /** Plan windows that are neither 5 hours nor 7 days long, each with its
   *  length in minutes (a free ChatGPT plan reports one 30-day window and no
   *  others — words deck W-2 = a, 2026-09-05). Absent, not empty, when the
   *  plan has none; the card draws them after the two bars above. */
  otherWindows?: Array<{ utilization: number; resets_at: string; minutes: number }>;
  /** Whose windows the four fields above are: the Claude subscription (the
   *  default, and the only plan before 2026-09-04) or the ChatGPT plan a
   *  native session is bound to. The card names the plan in its scope line. */
  subscriptionPlan?: 'claude' | 'chatgpt';

  // --- Native (YouCoded-runtime) sessions (spec §10) ---
  // A native session runs no Claude Code statusline, so the fields above are
  // filled from this app's own per-turn accounting instead. These three say
  // where the numbers came from and how complete they are, so the card can be
  // honest about both rather than guessing.

  /** True when the session figures above came from this app's own per-turn
   *  totals rather than from Claude Code's statusline. Gates the "Counts this
   *  session so far, including specialists." sentence — a promise this app can
   *  only make about numbers it counted itself. */
  countsFromSessionTotals?: boolean;
  /** True when some counted work ran on a METERED model whose provider
   *  publishes no rate, so the cost above (if any) leaves that work out.
   *  Distinct from work that is FREE to run — a local model has nothing to
   *  charge, which is not the same as a missing price and must never be
   *  worded as one. */
  costIsPartial?: boolean;
  /** How many specialist runs are folded into the session figures. */
  specialistRuns?: number;
}

// Step 3 (2026-08-17, broadened "context transparency"): what the native harness
// began the session with — a full accounting of the assistant's starting
// context, truncated or not. The session-start panel renders this at the top of
// every session (local or cloud), so the user can see the system prompt,
// project instructions (as truncated), skills, and tools the assistant was
// given — with outlinks to the real files.
//
// Every "was there a truncation" question is answered by a sub-field: an
// all-null record is a session that started with everything fully loaded.
//
// This REPLACES the truncation-only record (2026-08-17 v1): the banner could
// only say "something was cut". The panel can account for everything, and
// truncation falls out naturally as the difference between the raw file and the
// truncated copy shown.
export interface SessionContext {
  /** The model this session is bound to, e.g. "qwen2.5-coder:14b". */
  modelLabel?: string | null;
  /** The model's context window in tokens, when known. */
  contextWindowTokens?: number | null;
  /** Summary line for the top of the panel — "Started with the full project
   *  context" or "Context was trimmed to fit {model}". */
  summary?: string | null;
  /** The system prompt the assistant began with (host-assembled). */
  systemPrompt?: string | null;
  /** The same prompt split into the parts the host assembled it from — identity,
   *  the chosen preset, the environment snapshot, the shared doctrine, and the
   *  steering overlay a small model gets. WHY split: Destin, review-5 G-2 — "we
   *  should make this tab include both preset instructions and general system
   *  instructions. i want to be fully transparent about what models load in
   *  with." One wall of text answers "how much" but not "what".
   *  Optional: a host that cannot split them still sends `systemPrompt`, and the
   *  panel shows it whole rather than showing nothing. */
  systemPromptSections?: Array<{ id: string; label: string; text: string }> | null;
  /** Project instructions (CLAUDE.md / AGENTS.md): the OUTLINE received by the
   *  model, as-truncated. When untruncated this is the full file. */
  projectInstructions?: {
    /** Path to the root instruction file (CLAUDE.md), even when truncated. */
    path: string;
    /** The text the model actually received. */
    text: string;
    /** The FULL original text, for the truncation diff. Present when the host
     *  can supply it (the file is on disk); the diff view falls back to the
     *  outlink when absent. */
    fullText?: string | null;
    /** True when the file was outlined/truncated to fit the window. */
    truncated: boolean;
    /** Human line when truncated — "3 of 12 sections kept (headings only)". */
    note?: string | null;
  } | null;
  /** Skills loaded at session start, and whether each was truncated. */
  skills?: Array<{
    id: string;
    label: string;
    /** Path to the skill's SKILL.md — the outlink target. */
    path?: string | null;
    /** True when the skill body was truncated to fit the window. */
    truncated?: boolean;
    /** The FULL original skill body, for the truncation diff. */
    fullText?: string | null;
    note?: string | null;
  }> | null;
  /** Tools available to the assistant this session. */
  tools?: string[] | null;
  /** MCP servers dropped at session start to fit the tools budget. */
  droppedMcpServers?: string[] | null;
}

// Thin divider entry — shown when a slash command produced a side-effect
// worth marking in the conversation history (e.g. /clear, /compact).
// Permanent so the user can scroll back and see that "these messages end here."
export interface SystemMarker {
  id: string;
  timestamp: number;
  label: string;                                // e.g. "Conversation cleared"
  variant?: 'clear' | 'compact' | 'info'; // For styling hooks
  // Optional long-form text the marker can reveal on click. Currently only
  // set on compact markers — the actual conversation summary CC produced.
  summary?: string;
}

// /copy [N] picker — shown inline when the Nth assistant turn has multiple
// copyable units (full response + code blocks). Temporary; removed on click or cancel.
export interface CopyPickerOption {
  id: string;
  label: string;       // e.g. "Full response", "Code block 1 (python)"
  preview: string;     // First ~80 chars for button subtitle
  content: string;     // The actual text to copy
}

export type TimelineEntry =
  // pending: true means the bubble was added optimistically by USER_PROMPT and
  // is waiting for a matching TRANSCRIPT_USER_MESSAGE to confirm. When transcript
  // catches up, it consumes the oldest matching pending entry (clears the flag)
  // rather than dedup'ing via content-match against the last 10 entries (which
  // silently dropped legitimate rapid-fire duplicates like "yes yes yes").
  // Task 12: a queued send NO LONGER writes a timeline entry at all (see
  // SessionChatState.queuedMessages below) — a queued message only ever joins
  // the timeline via TRANSCRIPT_USER_MESSAGE's no-pending-match fallback, which
  // appends it at the true (end-of-timeline) position once the host actually
  // drains it. This replaces the Task 3/11 `queued`/`queueId` fields, which
  // let a queued bubble render mid-timeline at enqueue time — landing above
  // content from the still-streaming prior turn ("assistant responding to
  // itself"). See docs/active — Task 12 brief.
  // `injected` (2026-08-16): set when the host, not the user, wrote this
  // user-role turn — today only 'specialist-report' (a background specialist's
  // delivered report, or a host follow-up note, harness-session.ts runNotice).
  // ChatView/BubbleFeed draw such an entry as a compact, collapsed
  // SpecialistReportCard — never as the user's own bubble and never as a
  // full-width message: the text is what the PARENT MODEL reads, and putting
  // it in the chat as anyone's words showed text nobody actually said
  // (Destin, 1b hands-on: "these reports just shouldn't be rendering at all
  // in chat … should only register as a task completion toolcard").
  // `injectedMeta` is the structured header (who/what/status/steps).
  | { kind: 'user'; message: ChatMessage; pending?: boolean; injected?: string; injectedMeta?: InjectedMeta }
  | { kind: 'assistant-turn'; turnId: string }
  | { kind: 'prompt'; prompt: InteractivePrompt }
  // /cost and /usage render a snapshot card inline. Permanent (not dismissible).
  | { kind: 'usage-card'; snapshot: UsageSnapshot }
  // Thin "Conversation cleared" / "Compacted" dividers
  | { kind: 'system-marker'; marker: SystemMarker }
  // A user-invoked skill (/skill-name). Renders as the compact card the assistant
  // side already uses for the Skill tool — NOT as a user bubble, because the
  // instructions can run to tens of thousands of characters. `skillPath` makes
  // the card open the real SKILL.md in the artifact viewer.
  | { kind: 'skill-invocation'; id: string; skillId: string; displayName: string; args?: string; skillPath?: string; timestamp: number }
  // Spinner card while /compact (or resume-from-summary) is running
  | { kind: 'compacting'; id: string; startedAt: number }
  // /copy picker when the target turn has multiple copyable blocks
  | { kind: 'copy-picker'; id: string; options: CopyPickerOption[] };

export interface SessionChatState {
  timeline: TimelineEntry[];
  toolCalls: Map<string, ToolCallState>;
  toolGroups: Map<string, ToolGroupState>;
  assistantTurns: Map<string, AssistantTurn>;
  isThinking: boolean;
  streamingText: string;
  /** ID of the current tool group (tools are appended here until next message) */
  currentGroupId: string | null;
  /** ID of the current assistant turn (text + tool groups accumulate here) */
  currentTurnId: string | null;
  /** Timestamp of last activity from Claude — used to reset the thinking timeout */
  lastActivityAt: number;
  /** Tool IDs belonging to the current active turn — cleared on turn end */
  activeTurnToolIds: Set<string>;
  /**
   * Drives the chat-view "is something wrong?" banner. Default 'ok' means
   * render the normal ThinkingIndicator (when isThinking). Anything else
   * surfaces an AttentionBanner with state-specific copy. Set by the PTY
   * buffer classifier (useAttentionClassifier) or by SESSION_PROCESS_EXITED.
   * Reset to 'ok' on any transcript activity or endTurn().
   */
  attentionState: AttentionState;
  /**
   * Human-readable provider error backing the 'error' AttentionBanner —
   * native sessions only. Set by NATIVE_SESSION_ERROR (from a 'session-error'
   * transcript event), cleared by endTurn() and by the next USER_PROMPT.
   */
  errorMessage: string | null;
  /**
   * Native sessions only. Set when the streaming watchdog detects the provider
   * has gone silent (no chunk for ~60s). Drives ThinkingIndicator's "This is
   * taking a while… Retrying in Ns" countdown. `willRetry` is true when the
   * harness will auto-retry the stalled step at countdown-end (nothing had
   * streamed yet), false when it will surface a session-error instead. Set by a
   * `stallWarning`-bearing TRANSCRIPT_THINKING_HEARTBEAT; cleared (→ null) by any
   * subsequent activity (a plain heartbeat, reasoning/text delta) and by endTurn().
   */
  stallWarning: { retryInMs: number; willRetry: boolean } | null;
  /** When the stalled card was first shown, on THIS client's clock — the
   *  count-up's origin. Null whenever the turn is not parked. Stamped on the
   *  first `stalled` heartbeat and left alone by later ones, so the elapsed
   *  time never resets while the card is up. */
  stalledSince: number | null;
  /**
   * Native runtime: the model is READING the prompt (prefill), not hanging. Set
   * by a `promptProcessing`-bearing heartbeat and cleared the moment prefill ends
   * — by the first assistant text or reasoning, by a new user turn, and by
   * endTurn() — so it lives exactly as long as the pre-first-token wait. It
   * deliberately SURVIVES a stall-warning heartbeat, because that warning is
   * about this prefill and nulling it would blank the progress readout at the
   * moment the user most needs to see it advancing.
   *
   * (This comment used to claim "cleared by any other event", which was never
   * true: only two reducer cases ever wrote the field. The stale value resurfaced
   * mid-generation. Corrected with the fix, 2026-07-28.) Local models can spend
   * minutes here on a long prompt, and an idle spinner is indistinguishable from
   * a hang — which is what made the stall watchdog's false alarm so alarming.
   */
  promptProcessing: { promptTokens: number; budgetMs: number; source?: 'prompt' | 'tool-output'; processed?: number; cached?: number; etaMs?: number | null; timeMs?: number } | null;
  /**
   * When visible assistant OUTPUT last arrived (text or reasoning delta) — as
   * distinct from lastActivityAt, which any event bumps. The thinking indicator
   * hides while this is fresh: a bubble filling with tokens already proves the
   * model is alive, and a spinner next to it is noise. null until the first
   * output of the session.
   */
  lastOutputAt: number | null;
  /**
   * Wall-clock of the last non-spinner buffer change (set by classifier).
   * Used to distinguish "spinner is ticking but nothing else is changing"
   * from "buffer is actively producing new output."
   */
  lastBufferActivityAt: number;
  /**
   * Compaction in flight — set by /compact (typed or resume-from-summary click),
   * cleared by transcript-shrink event OR first turn-complete after pending was set
   * (resume-from-summary writes to a NEW file, so shrink on the old file never fires).
   * Holds the pre-compaction contextTokens count so COMPACTION_COMPLETE can compute
   * how much was freed.
   */
  compactionPending: { startedAt: number; beforeContextTokens: number | null } | null;
  /**
   * Native (local-model) sessions only. Residency of the session's bound model,
   * pushed from main (native:model-state). Drives ChatView's ModelLoadingBar:
   * 'sleeping'/'unloaded' → "Model unloaded to save memory · [Reload Model]";
   * 'loading' → the loading indicator (size + spinner). null = not a native
   * session (or state not yet known). Separate from attentionState on purpose —
   * this is engine model residency, not turn/thinking state.
   */
  modelState: import('../../shared/engine-types').EngineModelState | null;
  /** Bound model id + size for the banner copy (from native:model-state). */
  modelInfo: { modelId: string; sizeBytes: number | null } | null;
  /** While modelState==='loading': bytes resident in RAM so far, for the
   *  "N GB / M GB" progress bar. null when not loading / progress unavailable. */
  modelLoadedBytes: number | null;
  /** True once this session's model has been seen fully 'loaded' at least once.
   *  Distinguishes "unloaded because it slept after use" (→ show the Reload
   *  prompt) from "unloaded because it hasn't finished its FIRST load yet" (a
   *  fresh session eager-loading → show the loading bar, never a reload prompt).
   *  Without this, a brand-new session flashes "Model unloaded · Reload" in the
   *  race window before the eager load flips the poll to 'loading'. */
  modelEverResident: boolean;
  /**
   * UUIDs of transcript lines already applied to the timeline — the dedup key
   * for the two append-prone event types (TRANSCRIPT_USER_MESSAGE and
   * TRANSCRIPT_ASSISTANT_TEXT). A renderer-crash reload replays every session's
   * transcript from disk WHILE the live transcript:event stream is still
   * delivering; an event present in both streams must collapse to one entry.
   * (tool-use/result/turn-complete are absorbed by Map.set on toolUseId and
   * don't need this.) CC lines carry a stable uuid; native events each get a
   * fresh randomUUID, so this never collapses distinct native streaming deltas
   * — only a genuine replay/live overlap of the identical event.
   */
  /**
   * Perf cycle 2 — paged history. `cursor` is the opaque handle for the NEXT
   * (older) page; `hasMore` false means the beginning of the conversation is on
   * screen; `loading` is the one-in-flight-page guard that makes paging
   * idempotent (a second request for the same page can never start).
   */
  history: { cursor: PageCursor | null; hasMore: boolean; loading: boolean };
  seenUuids: Set<string>;
  /**
   * Task 12: messages the native host FIFO'd behind an in-flight turn
   * (NativeSendResult status 'queued'), rendered by QueuedMessagesStrip
   * docked at the bottom of the chat area — NOT in the timeline (see
   * TimelineEntry's 'user' arm WHY comment for the bug this replaces).
   * A queued message leaves this list one of two ways: (1) the host drains
   * it and TRANSCRIPT_USER_MESSAGE's no-pending-match fallback removes the
   * oldest content-matching entry as it appends the confirmed timeline entry
   * (chat-reducer.ts), or (2) the strip's Cancel/Edit invokes
   * native:queue-remove and dispatches QUEUED_MESSAGE_REMOVED directly (on
   * both the success AND too-late paths — see App.tsx handleCancelQueued/
   * handleEditQueued). content is the same display string the bubble would
   * have shown, so the drain-side removal can content-match it.
   */
  queuedMessages: Array<{ queueId: string; content: string; timestamp: number }>;

  /** Session-so-far totals for the status bar and /usage (spec §2). Accumulated
   *  as events arrive rather than walked on demand — see session-totals.ts for
   *  why, and for exactly what is counted. */
  totals: SessionTotals;
  /**
   * Step 3 (2026-08-17, broadened): the session's STARTING context — model,
   * window, system prompt, project instructions (as truncated), skills, tools,
   * dropped MCP servers. Null = the host hasn't reported it yet. Lives here
   * (not a timeline entry) so it survives resume — the accounting is a fact
   * about the session's prompt, which is rebuilt on resume. Set by the
   * SESSION_CONTEXT action (native session start / resume). Drives the
   * session-start context panel + the "Context was trimmed" banner.
   */
  sessionContext: SessionContext | null;
}

export function createSessionChatState(): SessionChatState {
  return {
    timeline: [],
    toolCalls: new Map(),
    toolGroups: new Map(),
    assistantTurns: new Map(),
    isThinking: false,
    streamingText: '',
    currentGroupId: null,
    currentTurnId: null,
    lastActivityAt: 0,
    activeTurnToolIds: new Set(),
    attentionState: 'ok',
    errorMessage: null,
    stallWarning: null,
    stalledSince: null,
    promptProcessing: null,
    lastOutputAt: null,
    lastBufferActivityAt: 0,
    compactionPending: null,
    modelState: null,
    modelInfo: null,
    modelLoadedBytes: null,
    modelEverResident: false,
    seenUuids: new Set(),
    queuedMessages: [],
    history: { cursor: null, hasMore: false, loading: false },
    totals: emptyTotals(),
    sessionContext: null,
  };
}

export type ChatAction =
  | { type: 'RESET' }
  // Replaces the entire ChatState Map with a deserialized snapshot. Fired once
  // per remote-access connect so browser clients get the full chat history
  // immediately rather than rebuilding it from replayed transcript events.
  | { type: 'HYDRATE_CHAT_STATE'; sessions: SerializedChatState }
  | { type: 'SESSION_INIT'; sessionId: string }
  | { type: 'SESSION_REMOVE'; sessionId: string }
  | {
      type: 'USER_PROMPT';
      sessionId: string;
      content: string;
      timestamp: number;
      // Exact attached-file paths (see ChatMessage.attachments) — lets the
      // bubble render pills for paths with spaces that regex detection misses.
      attachments?: string[];
    }
  | {
      // Task 12: a native send came back 'queued' (host FIFO'd it behind an
      // in-flight turn). Adds to SessionChatState.queuedMessages — NEVER
      // touches the timeline or turn state (that's exactly the Task 3/11 bug
      // this replaces: an enqueue-time timeline bubble could land above
      // content the still-streaming prior turn hadn't emitted yet). content
      // is the same display string USER_PROMPT would have used for the
      // bubble, so TRANSCRIPT_USER_MESSAGE's drain-side removal can
      // content-match it.
      type: 'QUEUED_MESSAGE_ADDED';
      sessionId: string;
      queueId: string;
      content: string;
      timestamp: number;
    }
  | {
      // Task 12 (replaces QUEUED_PROMPT_CANCELED): removes a queuedMessages
      // entry by queueId. Dispatched from the strip's Cancel/Edit handlers on
      // BOTH outcomes of native:queue-remove — true (the id was found and
      // removed on the host) and false (too late: the host already drained
      // it) — so the strip row doesn't linger once removeQueued has run
      // either way; on the false path the row's counterpart timeline entry is
      // about to be (or already was) appended by TRANSCRIPT_USER_MESSAGE.
      // No-op if the id isn't present (already removed, or never existed).
      type: 'QUEUED_MESSAGE_REMOVED';
      sessionId: string;
      queueId: string;
    }
  | {
      type: 'SHOW_PROMPT';
      sessionId: string;
      promptId: string;
      title: string;
      description?: string;
      buttons: { label: string; input: string; submitInput?: string }[];
    }
  | {
      type: 'COMPLETE_PROMPT';
      sessionId: string;
      promptId: string;
      selection: string;
    }
  | {
      type: 'DISMISS_PROMPT';
      sessionId: string;
      promptId: string;
    }
  | {
      // Process exited — main-process session-exit event forwarded via IPC.
      // Reducer decides whether to surface 'session-died' based on exitCode
      // and whether a turn was in flight.
      type: 'SESSION_PROCESS_EXITED';
      sessionId: string;
      exitCode: number;
    }
  | {
      // Native runtime only: the session's bound model's residency changed
      // (loaded/loading/sleeping/unloaded), pushed from main. Drives the
      // ModelLoadingBar (unloaded-to-save-memory + [Reload Model], loading UI).
      type: 'NATIVE_MODEL_STATE_CHANGED';
      sessionId: string;
      state: import('../../shared/engine-types').EngineModelState;
      modelId: string;
      sizeBytes: number | null;
      loadedBytes?: number | null;
    }
  | {
      // Native runtime only: a provider/stream failure ended the turn.
      // Reducer runs endTurn() then overrides attentionState to 'error' and
      // stashes the message for the AttentionBanner. Fired from a
      // 'session-error' transcript event (App.tsx / BubbleFeed.tsx).
      type: 'NATIVE_SESSION_ERROR';
      sessionId: string;
      message: string;
    }
  | {
      // Step 3 (2026-08-17, broadened): the session's STARTING context, reported
      // by the native harness on session start/resume. Sets
      // SessionChatState.sessionContext — the session-start panel + the
      // "Context was trimmed" banner both render from it. null = host hasn't
      // reported yet (or reported a fully-loaded session).
      type: 'SESSION_CONTEXT';
      sessionId: string;
      context: SessionContext | null;
    }
  | {
      // Plan 2b: another device took over this session's lease. The holder side
      // ends the local turn cleanly (endTurn — attention resets to 'ok', NOT a
      // terminal error state). As of the "Moved Gate" follow-up (2026-07-14) this
      // no longer appends a timeline marker — the session is destroyed immediately
      // after, which would wipe any marker. The user-facing surface is App.tsx's
      // MovedGate, driven off the enriched 'session:moved' push. `device` is the
      // new holder's label (may be absent → generic "another device").
      type: 'SESSION_MOVED';
      sessionId: string;
      device?: string;
    }
  | {
      // Classifier-driven attention state change. Pure state write; no
      // side effects. Dispatched by useAttentionClassifier only when the
      // classifier's decision differs from the current state.
      type: 'ATTENTION_STATE_CHANGED';
      sessionId: string;
      state: AttentionState;
    }
  | {
      // Heartbeat fired when the transcript watcher sees an assistant
      // thinking block (extended-thinking models) WITHOUT a text payload —
      // a lifecycle marker only. No UI; just bumps lastActivityAt and
      // clears attentionState back to 'ok'.
      type: 'TRANSCRIPT_THINKING_HEARTBEAT';
      sessionId: string;
      // Native watchdog: present → the stream has stalled; drives the
      // ThinkingIndicator countdown. Absent → a normal heartbeat that CLEARS any
      // active stall warning (activity resumed).
      stallWarning?: { retryInMs: number; willRetry: boolean };
      // Native watchdog stage 2: the turn is PARKED. Absent → a normal
      // heartbeat that clears the park (the stream resumed).
      stalled?: true;
      promptProcessing?: { promptTokens: number; budgetMs: number; source?: 'prompt' | 'tool-output'; processed?: number; cached?: number; etaMs?: number | null; timeMs?: number };
    }
  | {
      // Native runtime only. A manual stall Retry abandoned an attempt: remove
      // the segments it wrote from the current turn, or the re-run's deltas
      // merge into the same bubble and the user reads the sentence twice.
      type: 'NATIVE_PARTS_DROPPED';
      sessionId: string;
      partIds: string[];
    }
  | {
      // Native runtime only. The model is generating a tool call's arguments.
      // Creates (or updates) a display-only "preparing" tool card keyed by the
      // provider's REAL tool call id, so the later TRANSCRIPT_TOOL_USE — which
      // is already idempotent by toolUseId — supersedes it in place rather than
      // adding a second card.
      type: 'NATIVE_TOOL_PREPARING';
      sessionId: string;
      toolCallId: string;
      toolName: string;
      chars: number;
      // The step is being retried; withdraw this card. No-op if the id already
      // became a real tool.
      cleared?: boolean;
    }
  | {
      // Streaming reasoning chunk WITH text payload. Per-token deltas are
      // merged into a single reasoning segment by partId (UNLIKE the text
      // path, which appends whole blocks), rendered as a collapsible
      // disclosure in AssistantTurnBubble. Bumps lastActivityAt + clears
      // attentionState.
      type: 'TRANSCRIPT_ASSISTANT_REASONING';
      sessionId: string;
      uuid: string;
      text: string;
      timestamp: number;
      partId?: string;
      // Specialists 1c: set when the reasoning belongs to a specialist child
      // (stamped by the host like its text/tool events). The reducer routes it
      // into the launching Task card as a 'thinking' segment instead of the
      // parent's own reasoning bubble.
      parentAgentToolUseId?: string;
    }
  | {
      type: 'PERMISSION_REQUEST';
      sessionId: string;
      toolName: string;
      input: Record<string, unknown>;
      requestId: string;
      permissionSuggestions?: string[];
      // Specialists 1c: the ask was raised by a specialist CHILD and routed to
      // this (parent) session by child-ask-router. The reducer nests it under
      // the launching Task card (found by parentToolCallId, else by childId)
      // instead of minting a top-level card. Absent on the parent's own asks.
      specialist?: { childId: string; agentType: string; title: string; parentToolCallId?: string };
      // Native broker only: winning rule came from the destructive deny-list →
      // ToolCard shows the consequence-gated "Always allow" warning. Task 13.
      denyListed?: boolean;
      // Native broker only: the ask was forced by a path outside the session
      // folder → ToolCard HIDES "Always allow", because the engine skips the
      // rules on every later external call and could never honor the grant.
      external?: boolean;
      // Native broker only: the session's mode at ask time. 'full-auto' +
      // denyListed → ToolCard renders the safety-stop footer (spec 2026-08-12).
      permissionMode?: 'ask' | 'auto-edit' | 'full-auto';
    }
  | {
      type: 'PERMISSION_EXPIRED';
      sessionId: string;
      requestId: string;
    }
  | {
      // Specialists 1c: the child-ask-router's 5-minute hold elapsed. The ask
      // stays answerable (the broker keeps the entry); the specialist was told
      // to continue without it. Flags the nested segment so the row can say so.
      type: 'PERMISSION_HELD';
      sessionId: string;
      requestId: string;
    }
  | {
      // Specialists 1c: the host's delegation ledger changed for one hire
      // (`specialists:event`, also replayed on attach). Lands on the Task
      // card keyed by run.parentToolCallId. A steer ("send a note") rides on
      // `run.notes` — there is no separate note action; the reducer derives
      // the Activity-trail 'note' segments from the run record itself
      // (chat-reducer.ts's SPECIALIST_RUN_CHANGED case).
      type: 'SPECIALIST_RUN_CHANGED';
      sessionId: string;
      run: SpecialistRunView;
    }
  | {
      // Background Bash (G-1): the live shell-run record lands on its Bash card
      // (chat-reducer.ts's SHELL_RUN_CHANGED case). Same contract as
      // SPECIALIST_RUN_CHANGED — a record for an unknown card is dropped.
      type: 'SHELL_RUN_CHANGED';
      sessionId: string;
      run: ShellRunView;
    }
  | {
      type: 'PERMISSION_RESPONDED';
      sessionId: string;
      requestId: string;
    }
  | {
      type: 'TRANSCRIPT_USER_MESSAGE';
      sessionId: string;
      uuid: string;
      text: string;
      timestamp: number;
      // Host-injected user-role turn (TranscriptEvent.data.injected, e.g.
      // 'specialist-report') + its structured header. Carried onto the
      // timeline entry so the renderer draws a compact report card, not a bubble.
      injected?: string;
      injectedMeta?: InjectedMeta;
      // Present when this event came from a subagent's JSONL (the briefing
      // Claude Code writes as the subagent's first user-role line). Reducer
      // uses these to drop it from the main chat timeline — the briefing is
      // already shown inside the parent Agent card's Briefing section.
      parentAgentToolUseId?: string;
      agentId?: string;
    }
  | {
      type: 'TRANSCRIPT_ASSISTANT_TEXT';
      sessionId: string;
      uuid: string;
      text: string;
      timestamp: number;
      // Task 2.4: model from the transcript's `message.model` field, captured
      // on the first assistant-text of a turn so the model pill/metadata is
      // visible on in-flight turns (before turn-complete stamps it definitively).
      model?: string;
      // Native runtime: per-token delta id. Same partId → merge into the last
      // text segment (mirrors reasoning). CC omits it → whole-block append.
      partId?: string;
      parentAgentToolUseId?: string;
      agentId?: string;
    }
  | {
      type: 'TRANSCRIPT_TOOL_USE';
      sessionId: string;
      uuid: string;
      toolUseId: string;
      toolName: string;
      toolInput: Record<string, unknown>;
      // The transcript event's own stamp (epoch ms). Optional because the
      // top-level card never needed it; a CHILD tool row (parentAgentToolUseId
      // set) carries it onto its segment so a specialist's mid-run note can be
      // placed among the tool calls by time (chat-reducer.ts
      // reconcileNoteSegments) instead of at the bottom of the trail.
      timestamp?: number;
      parentAgentToolUseId?: string;
      agentId?: string;
    }
  | {
      type: 'TRANSCRIPT_TOOL_RESULT';
      sessionId: string;
      uuid: string;
      toolUseId: string;
      result: string;
      isError: boolean;
      structuredPatch?: import('../../shared/types').StructuredPatchHunk[];
      parentAgentToolUseId?: string;
      agentId?: string;
    }
  | {
      // /skill-name in a native session. Appends the compact invocation card;
      // the instructions themselves never reach the timeline.
      type: 'TRANSCRIPT_SKILL_INVOKED';
      sessionId: string;
      uuid: string;
      timestamp: number;
      skillId: string;
      displayName: string;
      args?: string;
      skillPath?: string;
    }
  | {
      // End of a transcript replay. Reaps tool cards the replayed history left
      // 'running' — a transcript stops wherever the process died, so its last
      // tool_use may have no result. Only acts when `sessionIdle` is true; the
      // same replay fires on a live re-dock, where the running tool is real.
      type: 'TRANSCRIPT_REPLAY_COMPLETE';
      sessionId: string;
      sessionIdle: boolean;
    }
  | {
      type: 'TRANSCRIPT_TURN_COMPLETE';
      sessionId: string;
      uuid: string;
      timestamp: number;
      stopReason: string | null;
      model: string | null;
      anthropicRequestId: string | null;
      usage: TurnUsage | null;
      // Stamped by SubagentWatcher onto turn-complete events that originate
      // in a sub-agent JSONL. Reducer must drop these so a sub-agent's
      // end_turn doesn't pollute parent state — see chat-reducer.ts.
      parentAgentToolUseId?: string;
      agentId?: string;
    }
  | {
      // One finished specialist's TOTAL spend, folded into the parent session's
      // totals (spec §2). Deliberately NOT a turn event: it must not end a turn,
      // create a timeline entry, or touch the subagent card. The child's own
      // turn-complete is never counted, precisely so this event can be — see the
      // WHY block on TRANSCRIPT_TURN_COMPLETE in chat-reducer.ts.
      type: 'TRANSCRIPT_SUBAGENT_USAGE';
      sessionId: string;
      uuid: string;
      timestamp: number;
      usage: TurnUsage | null;
      parentAgentToolUseId?: string;
      agentId?: string;
    }
  // Dispatched when the transcript watcher detects Claude Code's
  // user-interrupt markers ("[Request interrupted by user]" / "...for tool
  // use"). Task 5 consumes this in the reducer to end the in-flight turn
  // without rendering the marker as a user bubble.
  | {
      type: 'TRANSCRIPT_INTERRUPT';
      sessionId: string;
      uuid: string;
      timestamp: number;
      kind: 'plain' | 'tool-use';
    }
  // Perf cycle 2 — paged history. HISTORY_LOADED (whole-file replay behind a
  // "See previous messages" button) is retired; a page is fetched automatically
  // when the top of the list scrolls into view.
  | { type: 'HISTORY_PAGE_REQUESTED'; sessionId: string }
  | { type: 'HISTORY_PAGE_FAILED'; sessionId: string }
  | {
      type: 'HISTORY_PAGE_LOADED';
      sessionId: string;
      /** Parsed events for this page, oldest -> newest. */
      events: TranscriptEvent[];
      /** Handle for the page OLDER than this one; null when hasMore is false. */
      cursor: PageCursor | null;
      hasMore: boolean;
    }
  // Snapshot card shown when user runs /cost or /usage. Point-in-time —
  // doesn't auto-update even as live stats change (see status bar for live view).
  | {
      type: 'SHOW_USAGE_CARD';
      sessionId: string;
      snapshot: UsageSnapshot;
    }
  // /clear wipes the visible timeline and inserts a thin divider. Claude Code's
  // own context reset is handled separately by forwarding /clear to the PTY.
  // Reducer uses endTurn() to fail any tools orphaned mid-turn.
  | {
      type: 'CLEAR_TIMELINE';
      sessionId: string;
      markerId: string;       // Stable id so the divider survives re-renders
      timestamp: number;
    }
  // Spinner card shown during /compact. Sets compactionPending flag + inserts
  // a 'compacting' timeline entry so users see *something* is happening.
  | {
      type: 'COMPACTION_PENDING';
      sessionId: string;
      cardId: string;
      beforeContextTokens: number | null;
    }
  // Compaction finished — remove spinner, clear timeline, add marker with diff.
  // Triggered by transcript-shrink OR first turn-complete (resume-from-summary).
  | {
      type: 'COMPACTION_COMPLETE';
      sessionId: string;
      markerId: string;
      afterContextTokens: number | null;
      aborted?: boolean;       // true when watchdog fires — marker text differs
      summary?: string;        // Full compaction summary, surfaced as expandable section under the marker
      // Native spontaneous compaction (no manual /compact): there is no
      // compactionPending flag to satisfy the stale-event guard, so this bypasses
      // it to insert the marker. CC's paths never set it.
      auto?: boolean;
    }
  // /copy picker for multi-block turns
  | {
      type: 'SHOW_COPY_PICKER';
      sessionId: string;
      id: string;
      options: CopyPickerOption[];
    }
  // Clicked an option or dismissed the picker
  | {
      type: 'DISMISS_COPY_PICKER';
      sessionId: string;
      id: string;
    };

export type ChatState = Map<string, SessionChatState>;

// ───────────────────────── Serialization ─────────────────────────
// Maps and Sets are not JSON-safe. These helpers flatten a ChatState
// into tuple arrays for transport over IPC / WebSocket, and restore
// the live structure on the other side. Used by remote-access hydration
// so a newly-connected browser can receive the desktop's full chat state
// in a single message.

export interface SerializedSessionChatState {
  timeline: TimelineEntry[];
  toolCalls: Array<[string, ToolCallState]>;
  toolGroups: Array<[string, ToolGroupState]>;
  assistantTurns: Array<[string, AssistantTurn]>;
  isThinking: boolean;
  streamingText: string;
  currentGroupId: string | null;
  currentTurnId: string | null;
  lastActivityAt: number;
  activeTurnToolIds: string[];
  attentionState: AttentionState;
  errorMessage: string | null;
  // Optional so a pre-field snapshot from an older host still deserializes.
  stallWarning?: { retryInMs: number; willRetry: boolean } | null;
  // Optional so a pre-field snapshot from an older host still deserializes.
  // Serialized (unlike promptProcessing) because a parked turn is a condition
  // of the HOST that outlives any one client — a phone reconnecting to a
  // stalled desktop session must still see the card. Cross-device clock skew
  // makes the elapsed number approximate on remote; that is accepted.
  stalledSince?: number | null;
  lastBufferActivityAt: number;
  compactionPending: { startedAt: number; beforeContextTokens: number | null } | null;
  modelState?: import('../../shared/engine-types').EngineModelState | null;
  modelInfo?: { modelId: string; sizeBytes: number | null } | null;
  modelLoadedBytes?: number | null;
  modelEverResident?: boolean;
  // Optional so a pre-field snapshot from an older host still deserializes.
  seenUuids?: string[];
  // Task 12: renderer-local by design (see queuedMessages' WHY comment) — a
  // remote client's own queue state doesn't come through here, but the field
  // is still serialized so a same-origin reload doesn't silently drop rows
  // mid-session. Optional so a pre-field snapshot from an older host still
  // deserializes.
  queuedMessages?: Array<{ queueId: string; content: string; timestamp: number }>;
  // Optional so a pre-field snapshot from an older host still deserializes.
  history?: { cursor: PageCursor | null; hasMore: boolean; loading: boolean };
  // Optional so a pre-field snapshot from an older host still deserializes —
  // it comes back as empty totals, which read as "nothing counted yet" rather
  // than as a crash or a wrong number.
  totals?: SessionTotals;
  // Step 3 (2026-08-17): survives resume — the accounting is a fact about the
  // session's prompt, which IS rebuilt on resume. Optional so a pre-field
  // snapshot from an older host still deserializes.
  sessionContext?: SessionContext | null;
}

export interface SerializedChatState {
  sessions: Array<[string, SerializedSessionChatState]>;
  // Set when the host could not produce a real snapshot (renderer export timed
  // out, or serialization threw) and fell back to an empty payload. Lets the
  // client tell "the host has no sessions" apart from "the host failed" —
  // without it, both look like a valid empty snapshot. Optional so a payload
  // from a pre-field host still deserializes.
  degraded?: true;
}

export function serializeChatState(state: ChatState): SerializedChatState {
  const sessions: Array<[string, SerializedSessionChatState]> = [];
  for (const [sessionId, s] of state) {
    sessions.push([
      sessionId,
      {
        timeline: s.timeline,
        toolCalls: Array.from(s.toolCalls.entries()),
        toolGroups: Array.from(s.toolGroups.entries()),
        assistantTurns: Array.from(s.assistantTurns.entries()),
        isThinking: s.isThinking,
        streamingText: s.streamingText,
        currentGroupId: s.currentGroupId,
        currentTurnId: s.currentTurnId,
        lastActivityAt: s.lastActivityAt,
        activeTurnToolIds: Array.from(s.activeTurnToolIds),
        attentionState: s.attentionState,
        errorMessage: s.errorMessage,
        stallWarning: s.stallWarning,
        stalledSince: s.stalledSince,
        lastBufferActivityAt: s.lastBufferActivityAt,
        compactionPending: s.compactionPending,
        modelState: s.modelState,
        modelInfo: s.modelInfo,
        modelLoadedBytes: s.modelLoadedBytes,
        modelEverResident: s.modelEverResident,
        seenUuids: Array.from(s.seenUuids),
        queuedMessages: s.queuedMessages,
        // `loading` is normalised to false on the way out: an in-flight fetch
        // belongs to the client that started it, and a hydrating client that
        // inherited loading:true would never fetch again.
        history: { ...s.history, loading: false },
        totals: s.totals,
        sessionContext: s.sessionContext,
      },
    ]);
  }
  return { sessions };
}

export function deserializeChatState(s: SerializedChatState): ChatState {
  const result: ChatState = new Map();
  for (const [sessionId, ser] of s.sessions) {
    result.set(sessionId, {
      timeline: ser.timeline,
      toolCalls: new Map(ser.toolCalls),
      toolGroups: new Map(ser.toolGroups),
      assistantTurns: new Map(ser.assistantTurns),
      isThinking: ser.isThinking,
      streamingText: ser.streamingText,
      currentGroupId: ser.currentGroupId,
      currentTurnId: ser.currentTurnId,
      lastActivityAt: ser.lastActivityAt,
      activeTurnToolIds: new Set(ser.activeTurnToolIds),
      attentionState: ser.attentionState,
      // Older remote hosts predate errorMessage — default null so a
      // pre-field snapshot hydrates without an undefined leaking into state.
      errorMessage: ser.errorMessage ?? null,
      // Older hosts predate stallWarning — default null so a pre-field snapshot hydrates.
      stallWarning: ser.stallWarning ?? null,
      // Older hosts predate stalledSince — default null so a pre-field snapshot hydrates.
      stalledSince: ser.stalledSince ?? null,
      // Deliberately NOT serialized: prefill is an in-flight condition of THIS
      // client's stream. A hydrating client (remote reconnect, window restore) is
      // not mid-prefill, and restoring a stale "Reading your prompt…" would be a
      // lie that never clears — nothing would arrive to reset it.
      promptProcessing: null,
      // Transient like promptProcessing — a hydrating client is not mid-stream.
      lastOutputAt: null,
      lastBufferActivityAt: ser.lastBufferActivityAt,
      compactionPending: ser.compactionPending,
      // Older hosts predate these — default null so a pre-field snapshot hydrates.
      modelState: ser.modelState ?? null,
      modelInfo: ser.modelInfo ?? null,
      modelLoadedBytes: ser.modelLoadedBytes ?? null,
      modelEverResident: ser.modelEverResident ?? false,
      // Older hosts predate seenUuids — default to an empty Set (not undefined,
      // which would crash the reducer's .has() dedup check).
      seenUuids: new Set(ser.seenUuids ?? []),
      // Older hosts predate queuedMessages — default to an empty list.
      queuedMessages: ser.queuedMessages ?? [],
      // Older hosts predate paged history — default to "nothing older known",
      // which is what a hydrated snapshot already represents.
      history: ser.history
        ? { cursor: ser.history.cursor ?? null, hasMore: !!ser.history.hasMore, loading: false }
        : { cursor: null, hasMore: false, loading: false },
      // Older hosts (and a pre-field snapshot) predate totals — default to
      // empty totals rather than undefined.
      totals: ser.totals ?? emptyTotals(),
      // Older hosts predate sessionContext — default null (no panel/banner).
      sessionContext: ser.sessionContext ?? null,
    });
  }
  return result;
}

/** Structured header for a host-injected specialist report — mirrors TranscriptEvent.data.injectedMeta. */
export type InjectedMeta = NonNullable<NonNullable<import('../../shared/types').TranscriptEvent['data']>['injectedMeta']>;
