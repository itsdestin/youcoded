import type { CatalogMeta } from './catalog-types';
import type { ProjectInstructionSummary } from './project-instruction-summary';
import type { TranscriptEvent } from './transcript-event-types';
// WHY a re-export: every importer keeps using '../shared/types' for the transcript event
// types; they live in transcript-event-types.ts only to keep this file inside its budget.
export * from './transcript-event-types';

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
/** Why a native Bash ask was forced below every stored rule, so no saved grant
 *  could ever skip it (and the card offers no "Always allow"):
 *  - 'removal': the command would remove the workspace, home folder, disk root
 *    or a system folder (harness/tools/rm-target.ts); 'removal-if-empty': only
 *    if a variable in the path is empty; 'removal-unknown': the folder is a
 *    command's output or reached by a cd the text cannot follow;
 *  - 'secret-path': the command reads a secret or credential file — the same
 *    list the file tools refuse (harness/tools/bash-secret-paths.ts);
 *    'secret-maybe': it could (a glob, a find with no usable filter).
 *  The card's wording comes from this, so it never claims more than the check
 *  knows (review N11). */
export type FloorStop = 'removal' | 'removal-if-empty' | 'removal-unknown' | 'secret-path' | 'secret-maybe' | 'admin';

/** A running Bash call whose `sudo` is waiting for the computer password
 *  (admin-password design, 2026-09-25). The card asks for it; the password
 *  itself never enters this state, a transcript or the model's view. */
export interface PasswordAsk {
  requestId: string;
  /** The exact admin step sudo will run, read from the sudo process itself —
   *  never the prompt text the command supplied (a command can choose its own
   *  prompt, e.g. "Enter your Google password"). */
  command: string;
  /** Set when the admin step is inside another command (an install script):
   *  that command's name, so the card can say who is asking. */
  via?: string;
  /** Set after a wrong password: how many tries sudo has left. */
  triesLeft?: number;
}

export type NativeSendResult =
  | { status: 'sent' }
  | { status: 'queued'; queueId: string }
  // 'starting' vs 'not-live' are DIFFERENT SITUATIONS and must never be merged
  // back into one code: 'not-live' is a session that has ended or was never
  // created, 'starting' is one that has not finished starting yet (a big local
  // model can take a minute to load). One code for both is what told Destin a
  // brand-new session was "no longer running" — see NativeSessionHost.startingSends.
  | { status: 'failed'; reason: 'not-live' | 'queue-full' | 'starting' | 'compacting' };

/** U11 — the model picker's native switch (`native:switch-model`). 'needs-summary'
 *  means nothing changed yet: the chat is too long for the chosen model and the
 *  renderer asks before summarizing. Every failure leaves the current model. */
export type NativeSwitchFailure =
  | 'not-live' | 'turn-in-flight' | 'nothing-to-compact' | 'summary-failed'
  | 'interrupted' | 'cannot-fit' | 'too-small' | 'error';
export type NativeSwitchResult =
  // `summarized`: a summary committed first, so its marker ends the chat's card.
  | { status: 'switched'; summarized?: true }
  | { status: 'needs-summary' }
  | { status: 'failed'; reason: NativeSwitchFailure; detail?: string };

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
  /** The saved conversation this session resumed, when it resumed one. Lets a
   *  pending handoff tab recognise its own session's creation push exactly. */
  resumeSessionId?: string;
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
  /** Claude Code session that has NOT yet run its first hook — it is still on
   *  its startup dialogs (trust, bypass, MCP approval). The HOST knows this; a
   *  window or phone that connects mid-startup must not assume "already
   *  running" and open the chat box onto a live dialog (dev-instance finding,
   *  2026-09-24). Absent = started (older hosts). */
  awaitingStart?: boolean;
}

// A refused resume creates no session. Keep it distinct from both startup
// errors and offline access (which may still produce a real SessionInfo).
export type SessionCreateResult = (SessionInfo & { reused?: true }) | { status: 'lease-denied'; device?: string };

// WHY: only admitted attempts carry a real session; saved-copy is explicit consent, not confirmation.
export type HandoffAttemptResult =
  | { id: string; status: 'waiting' | 'incomplete' | 'cancelled' | 'failed'; cause?: string;
      holder?: { deviceId: string; device: string } }
  | { id: string; status: 'admitted'; source: 'confirmed' | 'saved-copy'; session: SessionInfo };
export type HandoffCreateParams = { name: string; cwd: string; skipPermissions: boolean; resumeSessionId: string; provider: 'claude' | 'native'; model?: string; binding?: { providerId: string; modelId: string }; cols?: number; rows?: number; preset?: string };

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
  | 'subagent-usage'
  // Claude Code only: a background helper/command ended — parsed from its
  // <task-notification>. The launching card's tool result is only "launched",
  // so this is the ONLY signal the work is over (2026-09-24). Carries
  // `data.backgroundTask`, and `data.toolUseId` when Claude Code names the call.
  | 'background-task';

/** A Claude Code background task's end state, as its <task-notification> says.
 *  Claude Code writes 'completed' | 'failed' | 'killed' | 'stopped'; 'killed'
 *  (the user or the model stopped it) is folded into 'stopped' here. */
type CcBackgroundStatus = 'running' | 'completed' | 'failed' | 'stopped';

/** See ToolCallState.ccBackground. `result` is a helper's final report;
 *  `summary` is Claude Code's one-line account of how it ended. */
export interface CcBackgroundRun {
  taskId: string;
  status: CcBackgroundStatus;
  summary?: string;
  result?: string;
}

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
  /** First page only: read to EOF, not the tailer's start — a renderer rebuilt while the
   *  session ran missed the live stream, so recent messages vanished (2026-09-27). */
  toEnd?: boolean;
}

export interface PageCursor {
  path: string;
  offset: number;
  sizeAtRead: number;
}

/** One page of conversation history, oldest -> newest within the page. */
export interface TranscriptPageResult {
  events: TranscriptEvent[];
  /** Handle for the next older page. */ cursor: PageCursor | null;
  hasMore: boolean;
  /** Native page is idle. */ reconcileInterrupted?: boolean;
  /** CC tool calls before the pre-spawn cutoff; new calls on this page stay live. */ reconcileInterruptedToolIds?: string[];
  /**
   * "I could not locate this session's transcript", as distinct from "you have
   * reached the beginning of the conversation" — which is what an empty page
   * with hasMore:false otherwise means, and which the renderer treats as final.
   *
   * These two were the same answer until 2026-09-07, so a transcript that was
   * not locatable YET (resume before CC's hook, process exit, buddy) permanently ended
   * the conversation's scroll-back in that window. A caller must RETRY on this,
   * never record it. Absent means the answer is real.
   */
  unresolved?: true;
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
      floorStop?: FloorStop;
      permissionMode?: 'ask' | 'auto-edit' | 'full-auto';
      /** Remote access batch 2: the request id a resolution cleared this row of, kept so a
       *  later expiry (a parent's cancel sends Resolved, then Expired) still finds it. */
      resolvedRequestId?: string;
      /** admin-password design §2.5/§2.6: this nested Bash call's sudo is
       *  waiting for the computer password — mirrors ToolCallState.passwordAsk
       *  so a specialist's own sudo nests under its Task card exactly like a
       *  permission ask does, instead of showing at the top level. */
      passwordAsk?: PasswordAsk;
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

/** The two specialist model overrides. `null` means use the reviewed
 *  provider-matched automatic model; it never authorizes parent inheritance. */
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
  /** A Claude Code ask whose hook socket died while Claude Code's own menu may
   *  still be on screen ('hook-closed' expiry). The card STAYS awaiting-approval
   *  so the session dot and the send gates keep holding — the bug this fixes was
   *  the card flipping to 'failed' so the session looked idle while Claude Code
   *  was still blocked. requestId is cleared (the socket is gone). Settled by
   *  the tool's transcript result, the prompt detector's menu-gone rule, or
   *  Dismiss (PERMISSION_CARD_RESOLVED). */
  expired?: true;
  /** Native broker only: the ask was forced by a path outside the session
   *  folder → the "Always allow" button is HIDDEN. The engine forces an ask on
   *  every external path and never consults the stored rules there, so a
   *  remembered rule could not fire. Spec 2026-08-11, finding 3. */
  external?: boolean;
  /** Native broker only: the ask was forced by a floor below every stored rule
   *  → the "Always allow" button is HIDDEN (for the same reason as `external`)
   *  and Full auto's stop band names which floor. See FloorStop. */
  floorStop?: FloorStop;
  /** Native runtime only: this command's sudo is waiting for the computer
   *  password. Status flip (Destin, 2026-09-26 dogfood: while the password
   *  card waits, the card looked like it was still running, with nothing
   *  marking the session as needing input): the card's own `status` flips to
   *  'awaiting-approval' for as long as this is set (chat-reducer.ts
   *  PASSWORD_REQUEST/PASSWORD_RESOLVED) — exactly like a permission ask,
   *  so it can't be mistaken for a running command. A password ask has no
   *  `requestId` of its own on this field (only nested inside `passwordAsk`
   *  itself), so a consumer that used to gate on `!!requestId` alone must
   *  use `needsUserAnswer()` (specialist-cards.ts) instead. */
  passwordAsk?: PasswordAsk;
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
  /** Remote access batch 2 (§7): the ask on this card was answered on another
   *  device — the computer, or a phone — while this client could not see it.
   *  The card returns to 'running' (never 'failed', never a claim about a
   *  socket) and ToolCard shows a neutral note until the result lands. */
  answeredElsewhere?: boolean;
  /** The request id the host said was resolved elsewhere, kept after `requestId` is
   *  cleared, so an expiry or this device's own answer that arrives AFTER the
   *  resolution still finds the card (T2 review: the broker emits Resolved, then
   *  Expired, for a cancelled ask — without this the card read "Answered on the
   *  computer" for an ask nobody answered). */
  resolvedRequestId?: string;
  /** One-core R6-2: a phone answered this card and drew the answer BEFORE the computer confirmed it (state/permission-answer.ts). The card is shown as
   *  answered (`running`) with `requestId` cleared; this keeps the id so the answer can be put back if the computer refuses, and so a re-announce of
   *  the same ask that was sent before the answer landed does not draw the card a second time. `inFlight` = the answer's reply has not come back. */
  answerPending?: { requestId: string; inFlight: boolean };
  /** The card was put back after an answer got no reply: it says so, and stays answerable (the same sentence a card says on the computer). */
  answerUnconfirmed?: boolean;
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
   * Claude Code only: this call started work that outlives it — an Agent
   * (every CC Agent call runs in the background as of 2026-09) or a Bash
   * `run_in_background` command. Its tool result is only the launch receipt,
   * so `status: 'complete'` alone read "done" the instant the helper started.
   * This record is the work's real state: 'running' from the receipt until the
   * 'background-task' notice says how it ended. The CC counterpart of
   * `specialistRun` / `shellRun` below, and drives the card the same way.
   */
  ccBackground?: CcBackgroundRun;
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

// ── What the assistant was given ────────────────────────────────────────────
//
// The session-start accounting behind the line above every conversation and the
// "What the assistant was given" panel. Lives in shared/types.ts (rather than the
// renderer's chat-types.ts, where it was designed) because main BUILDS it —
// see NativeSessionHost.buildSessionContext.
//
// Every "was something left out" question is answered by a sub-field: a record
// with no truncation and nothing dropped is a session that started with
// everything it was offered.
//
// NO FILE BODIES RIDE HERE. 47 installed skills are 619 KB of SKILL.md on this
// machine (measured 2026-09-10) and this record is pushed for every session,
// held in renderer state, and re-sent over a phone's WebSocket. The panel asks
// for one file's text when the user opens that row instead.

/** One skill this session may reach.
 *
 *  Deliberately thin: this is what `SkillCatalog.list()` already knows, which is
 *  what rides in the model's own tool schema. A skill's path, size and whether it
 *  would be shortened all require READING it, so they arrive with the text when
 *  the user opens that row — session start reads no skill files at all. */
export interface SessionContextSkill {
  id: string;
  /** The name a person recognises — the last segment of the id. */
  label: string;
  /** The one-liner the model itself is given. */
  description?: string;
}

export interface SessionContext {
  /** Who assembled this session's instructions.
   *
   *  'youcoded' — the native harness built the prompt, read the files and did any
   *  shortening, so every field here is a record of what it did.
   *
   *  'claude-code' — the Claude Code CLI runs the session and assembles its own
   *  instructions. YouCoded can still name, accurately, the files Claude Code
   *  reads and the skills it can reach, because both live on this machine and the
   *  app manages them. It CANNOT report Claude Code's system prompt, its tool set,
   *  or whether Claude Code shortened anything — so those are absent rather than
   *  guessed, and the panel says which is which. Never present one as the other.
   *
   *  Absent on a record written before this field existed; the panel treats that
   *  as 'youcoded', which is what every such record was. */
  assembledBy?: 'youcoded' | 'claude-code';
  /** The model this session is bound to, e.g. "qwen2.5-coder:14b". */
  modelLabel?: string | null;
  /** The model's context window in tokens, when known. */
  contextWindowTokens?: number | null;
  /** Summary line for the top of the panel. */
  summary?: string | null;
  /** The system prompt split into the parts the host assembled it from. WHY split
   *  (Destin, review-5 G-2): "i want to be fully transparent about what models
   *  load in with." One wall of text answers "how much" but not "what". */
  systemPromptSections?: Array<{ id: string; label: string; text: string }> | null;
  /** The whole assembled prompt. Kept as the fallback the panel shows when a host
   *  cannot split it — showing it whole beats showing nothing. */
  systemPrompt?: string | null;
  /** Legacy single-file summary (also present on Claude Code records). */
  projectInstructions?: {
    path: string;
    /** True when the file was outlined to fit the window. */
    truncated: boolean;
    /** Human line when truncated — "3 of 12 sections shown as headings". */
    note?: string | null;
  } | null;
  projectInstructionFiles?: ProjectInstructionSummary[]; // Captured chain; bodies on demand.
  /** Your own instructions, the ones that apply in every project
   *  (`~/.claude/CLAUDE.md`). Claude Code reads this file; the native harness
   *  does NOT — it only walks up from the working folder — which is a real
   *  difference between the two, and worth showing rather than hiding. */
  userInstructions?: {
    path: string;
    truncated: boolean;
    note?: string | null;
  } | null;
  skills?: SessionContextSkill[] | null;
  /** Whether the model was TOLD its skills exist. False below the catalog
   *  threshold, where the Skill tool is never attached — the user can still start
   *  one by typing /name, but the assistant cannot reach for one itself, and
   *  before this field nothing anywhere said so. */
  skillsOffered?: boolean;
  /** Tools available to the assistant this session. */
  tools?: string[] | null;
  /** MCP servers dropped at session start to fit the tools budget. */
  droppedMcpServers?: string[] | null;
}

/** One file's text, fetched when the user opens its row in the panel.
 *  `text` is what the model receives; `full` is the file on disk. Equal when
 *  nothing was cut. */
export interface SessionContextText {
  path: string;
  text: string;
  full: string;
  truncated: boolean;
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
  /** Something this command started is still running with admin rights (it
   *  passed the admin password card). The card keeps a "Running as admin"
   *  strip with Stop in view until it ends (admin-password design, Q-still-running). */
  admin?: boolean;
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

/** Companion to `injected: 'shell-running'` (2026-09-16): a background command
 *  that is STILL running at one of the LONG_RUN_NOTICE_MS marks. Not a
 *  completion — deliberately a different kind from ShellInjectedMeta so the
 *  chat reducer never folds it into a Bash card as a finished run; the
 *  renderer shows it as a plain system note. */
export interface ShellRunningInjectedMeta {
  kind: 'shell-running';
  /** A list for the same reason ShellInjectedMeta's is: every mark ready at
   *  one idle boundary goes out as ONE turn (D8), never one turn per build. */
  runs: Array<{ shellId: string; toolUseId: string; elapsedMs: number }>;
}

export type InjectedMeta = SpecialistInjectedMeta | ShellInjectedMeta | ShellRunningInjectedMeta;

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
  // NOTE (round 2, doc-comments mockup): a "Ask about this" / "Send to
  // assistant" reference no longer needs a field here — it rides inside
  // `content` itself as an inline marker (compose-ref.ts) that UserMessage
  // decodes back into the same pill the composer showed. See compose-ref.ts's
  // own header comment for why (a round-1 `references` array + separate chip
  // row above the composer is gone).
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

// The skill marketplace backend is typed as the class itself —
// `LocalSkillProvider` in main/skill-provider.ts. The `SkillProvider` interface
// that used to sit here had exactly one implementation, nothing was typed
// against it polymorphically, and its name collided with the unrelated React
// `<SkillProvider>` context component (simplification audit M7, 2026-09-16).

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
  /** Restore + focus main; a buddy resume is re-resolved through main's admission flow. */
  openMain(request?: { resume: string }): Promise<void>;
  /** Hide the buddy for this app run only (preference stays enabled). */
  dismiss(): Promise<void>;
  getStatus(): Promise<{ dismissed: boolean; visible: boolean }>;
  onStatusChanged(cb: (s: { dismissed: boolean; visible: boolean }) => void): () => void;
  onBarState(cb: (s: { visible: boolean }) => void): () => void;
  onMascotState(cb: (s: { mode: 'free' | 'docked' | 'peeking'; edge: string | null }) => void): () => void;
  onChatState(cb: (s: { visible: boolean }) => void): () => void;
  onFocusSession(cb: (sessionId: string) => void): () => void;
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
  /** Set when the tags and note could NOT be read — the store is missing or the read
   *  failed — with the reason. Absent means they were read (possibly as none).
   *  WHY separate from `supported` (error inventory 2026-09-10, false message 12): a
   *  failed read is not a refusal to store. Without this field it was identical to a
   *  conversation with no note, which the close prompt showed as "No note" and then
   *  used as the baseline for a note write that replaced the real one. */
  unreadable?: string;
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

// IPC channel names live in backend-contract.ts (one list for the desktop door, the phone door
// and the bridges). Re-exported so the ~130 existing `import { IPC } from '.../shared/types'`
// call sites keep working unchanged.
export { IPC } from './backend-contract';

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
