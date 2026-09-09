// NativeSessionHost (Phase 1 Plan A, Task 9) — the registry of live
// HarnessSessions plus the persistence glue that turns their transcript-event
// stream into (a) forwarded renderer/remote events and (b) coalesced on-disk
// records. It is the ONE place the two serialization contracts from earlier
// tasks are honored:
//   1. HarnessSession.send() is not re-entrant — the host only calls send()
//      once per user turn and never overlaps turns for a session.
//   2. SessionStore.append() must be serialized per session — the host runs
//      appends on a per-session promise chain (never fire-and-forget), so two
//      events for the same session can't interleave their file writes.
//
// KEY DESIGN CHOICE — persist-alongside, not persist-before-forward: when an
// event arrives we forward it to the renderer SYNCHRONOUSLY (UI latency must
// not wait on disk) AND enqueue the append on the per-session chain. A renderer
// crash losing an unpersisted event is acceptable; a stuttering UI is not.
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import * as path from 'path';
import type { TranscriptEvent, NativeSendResult, SpecialistsEvent, HookEvent, DelegatedModelsView, SpecialistRunView, ShellEvent, ShellRunView, InjectedMeta } from '../../shared/types';
import { ShellRegistry, formatFinishedNotice, NOTICE_TAIL_LINES, type ShellRun } from './shell-registry';
import type { ModelBinding } from '../../shared/provider-types';
import { HarnessSession, rememberedRuleFor, type ModelFactory, type HarnessSessionOpts } from './harness-session';
import { rebuildHistory } from './history-rebuild';
import { PAGE_TURNS } from '../transcript-page';
import { readImageFromDisk } from './image-support';
import { SessionStore, type NativeSessionListEntry } from './session-store';
import { PermissionBroker, type AskDecision, type LateResponseEntry } from './permission-broker';
import { resolvePreset, type ResolvedPreset } from './preset-registry';
import { decidePermission } from './permission-engine';
import { rulesForMode, sameRule, isCrossProjectRule, CROSS_PROJECT_SLUG, DESTRUCTIVE_DENY_LIST, type NativePermissionMode, type PermissionRule } from '../../shared/permission-types';
import { assembleSystemPrompt } from './prompt-assembly';
import { resolveProfile, effectiveContextForModel, type CapabilityProfile, type ProfileProviderType } from './capability-profile';
import { CORE_TOOLS } from './tools';
import type { ToolServices, SpecialistReservation, SpecialistSpawnOpts, SpecialistManageOutcome, SpecialistResumeOutcome } from './tools/types';
import { createSkillCatalog, SkillNotFound, type SkillCatalog } from './skills/skill-catalog';
import { canonicalize, resolveP } from './tools/guards';
import { isUnderRoot } from '../artifacts/read-binary-access';
import type { SpecialistDefinition } from './specialists/registry';
import { SpecialistCatalog } from './specialists/catalog';
import { buildChildDecide } from './specialists/child-permissions';
import { childAskRouter, BUDGET_ASK_TOOL_NAMES } from './specialists/child-ask-router';
import { assignSpecialistName } from './specialists/names';
import { HOSTED_MAX_CONCURRENT_SPECIALISTS, SPECIALIST_SPAWN_BUDGET_PER_SESSION, SPECIALIST_IDLE_STALE_MS, SPECIALIST_IN_TOOL_STALE_MS, SPECIALIST_ASK_HOLD_MS, SPECIALIST_NOTE_MAX_CHARS } from './specialists/limits';
import { DelegationLedger, OWNER, RAW_REPORT_CAP_CHARS, isOwnerAlive, toRunView, type DelegationRecord } from './specialists/delegation-ledger';
import { DelegatedModels, delegatedModelsView, type DelegatedTier } from './specialists/delegated-models';
import type { NativeHome } from '../native-home';
import { computeReportBudget } from './specialists/report-budget';
import { truncateOutput, composeNotice } from './tools/truncate';
import { APPROX_CHARS_PER_TOKEN } from './message-size';
import { fitInjection } from './injection/injection-budget';
import { frameSkillInvocation } from './skills/skill-invocation';
import { buildTriggerIndex } from './injection/path-triggers';
import { costForUsage, isFreePricing, type ModelPricing } from './pricing';
import { log } from '../logger';
// Same import PermissionStore uses, for the same reason: the project slug MUST
// come from ONE function everywhere, or the host and the store would disagree
// about which live sessions a stored entry belongs to. nativeStoreSlug (NOT
// ccProjectSlug): this is app-private permissions.json keying, not a CC
// mirror — see slug-encoding.ts.
import { nativeStoreSlug } from '../slug-encoding';
import type { McpLease } from './mcp/mcp-manager';

export interface CreateNativeSessionOpts {
  sessionId: string;
  cwd: string;
  binding: ModelBinding;
  presetId?: string;
}

/** The two PermissionStore methods the host consumes. Declared structurally so
 *  tests can inject a real PermissionStore (which satisfies this shape) OR rely
 *  on the no-op default below without pulling in the NativeHome dependency. */
export interface RememberedRuleStore {
  rulesFor(cwd: string): Promise<PermissionRule[]>;
  remember(cwd: string, rule: PermissionRule): Promise<void>;
  // Removal keys by project SLUG, not cwd: the slug is what is actually on disk,
  // and nativeStoreSlug is lossy (see revokeRule), so an entry written before
  // the management UI existed has no recoverable cwd to pass. Both return
  // whether anything actually matched, so the caller can tell the user their
  // on-screen list was stale instead of claiming a success that never happened.
  remove(slug: string, rule: PermissionRule): Promise<boolean>;
  removeProject(slug: string): Promise<boolean>;
}
const NOOP_REMEMBERED_STORE: RememberedRuleStore = {
  async rulesFor() { return []; },
  async remember() { /* no-op */ },
  async remove() { return false; },
  async removeProject() { return false; },
};

// M1 send queue: bounded per program §2.1 — past this many FIFO'd sends, send()
// refuses honestly (status 'failed', reason 'queue-full') instead of accepting
// input the user has no way to know is piling up unseen.
/** One unit of work for the turn drain: the message text plus any composer
 *  attachments that must ride with it. */
type SendUnit = { text: string; attachments: string[] };

const SEND_QUEUE_LIMIT = 10;

// Specialists (Task 7) — the ONLY child transcript event types that are
// re-emitted as stamped DISPLAY copies under the parent's session id.
//
// WHY exactly these three and nothing else: they are precisely what the
// renderer's applySubagentEvent consumes (chat-reducer.ts) to fill the subagent
// card's segments. Every OTHER type is persisted to the child's own file and
// stops there, because a display copy is an event that LOOKS like the parent's
// own — a stamped `turn-complete` would reach the conversation-record IPC
// listener (noteModelUsed) and the conversation-title feeder under the PARENT's
// id, ending the parent's turn in the reducer and attributing the child's model
// usage to the parent. A stamped `session-error` would render the parent's
// session as failed when only the child failed. `user-message` would put the
// child's brief in the parent's timeline as if the user had typed it.
// Exported (Task 9) so restart-recovery card replay can filter against the
// exact same set the live path uses, and so tests can assert against it
// directly rather than duplicating the literal list.
//
// Plan 1c adds ONE more shape — assistant-thinking with text — because a
// helper's reasoning belongs in ITS card's Thinking row (R6), never in the
// parent's bubble. Heartbeats/stall/preparing payloads stay out: they would
// render as the parent's own status. That widening lives in
// isSubagentDisplayEvent below, NOT as a fourth Set entry — the frozen
// TranscriptEventType surface means assistant-thinking must stay one Set
// member that sometimes re-emits, rather than the Set growing a type whose
// membership is conditional on payload. Anything checking "does this type
// always re-emit" still reads SUBAGENT_DISPLAY_TYPES directly; anything
// deciding whether ONE event re-emits must call isSubagentDisplayEvent.
export const SUBAGENT_DISPLAY_TYPES = new Set<TranscriptEvent['type']>(['tool-use', 'tool-result', 'assistant-text']);

/**
 * The single predicate for "does this child event re-emit as a display copy
 * on the parent" — used at BOTH sites (the live wireChildLive listener below
 * and mergeChildEvents' replay filter) so the two can never drift apart.
 * True for the three always-on types in SUBAGENT_DISPLAY_TYPES, or for an
 * assistant-thinking event that carries non-empty data.text (a helper's
 * actual reasoning, per the WHY above). A payload-less heartbeat, a
 * stallWarning countdown, or a toolPreparing notice all fail this — none
 * carries data.text — and stay child-only.
 */
export function isSubagentDisplayEvent(e: TranscriptEvent): boolean {
  return SUBAGENT_DISPLAY_TYPES.has(e.type)
    || (e.type === 'assistant-thinking' && typeof e.data.text === 'string' && e.data.text.length > 0);
}

/**
 * Card replay (Task 9) — pure splice function, exported for direct testing.
 * For each ledger record, filters its child's own events to the display-safe
 * subset and stamps them EXACTLY the way the live child listener does below
 * (createChild's 'transcript-event' subscription: same sessionId override,
 * same parentAgentToolUseId/agentId shape) — a resumed parent's history must
 * be indistinguishable from one that was live the whole time. The stamped block
 * is spliced immediately after the parent event whose `data.toolUseId`
 * matches the record's `parentToolCallId`, because the renderer's
 * applySubagentEvent (chat-reducer.ts) bails out (returns state unchanged) on
 * any subagent event that arrives before the parent's own Task tool-use event
 * has created the card it attaches to — ordering here is not cosmetic, it's
 * load-bearing for the reducer.
 *
 * A record whose parentToolCallId has no matching tool-use event in
 * `parentEvents` is skipped defensively rather than guessed at: that shape
 * happens when the app dies in the narrow window after a child is minted but
 * before the parent's own Task tool-use event is appended to its transcript —
 * there is no parent card for it to attach to, ever, so splicing "somewhere"
 * or dropping other parent events to make room would both be worse than
 * simply not replaying that one child's segments.
 *
 * Pure and side-effect-free: computed fresh from each `getHistory()` call
 * rather than written back to the parent's own file, so calling it (or
 * resuming) more than once can never accumulate duplicate entries — there is
 * nothing on disk for a second call to duplicate.
 */
export function mergeChildEvents(
  parentId: string,
  parentEvents: TranscriptEvent[],
  children: Array<{ record: DelegationRecord; events: TranscriptEvent[] }>,
): TranscriptEvent[] {
  const merged = [...parentEvents];
  for (const { record, events } of children) {
    const idx = merged.findIndex((e) => e.type === 'tool-use' && e.data.toolUseId === record.parentToolCallId);
    if (idx === -1) continue; // defensive skip — see the function's own WHY above
    const stamped = events
      .filter(isSubagentDisplayEvent)
      .map((e) => ({
        ...e,
        sessionId: parentId,
        data: { ...e.data, parentAgentToolUseId: record.parentToolCallId, agentId: record.childId },
      } satisfies TranscriptEvent));
    merged.splice(idx + 1, 0, ...stamped);
  }
  return merged;
}

// The ONE reminder a silent specialist gets before its run is called a failure
// (retry budget 1, spec §3). Deliberately a single short sentence: it is sent
// as an ordinary user turn, so anything longer competes with the brief for the
// child's attention.
const EMPTY_REPORT_NUDGE = 'Your final message is your report — reply with your findings now.';

// Fix (Important 5, final review): the SUBDIRECTORY every specialist-report
// spill file (writeSessionArtifact) lands in, under a project's
// sessions/<slug>/ directory — and the ONLY thing toolWiring's
// internalReadRoots exemption is scoped to (see its own comment). Before this
// fix the exemption covered the ENTIRE sessions/<slug>/ directory, which also
// holds every OTHER conversation's transcript .jsonl and the delegation
// ledger sidecars — a truncated report's footer names a path under
// sessions/<slug>/, and the model could then Read/Grep/Glob anything else in
// that same directory (other conversations included) without the
// external_directory ask it would need for any other path outside its own
// session. Narrowing writeSessionArtifact's target AND the exemption to this
// one subdirectory closes that without touching what the exemption exists
// for: a spilled report is still readable, nothing else in the project's
// session storage is.
const SPECIALIST_REPORT_SPILL_SUBDIR = 'specialist-reports';

// Task 1 (plan 1b) — the placeholder value activeWriterChild holds for a
// writer reservation between reserveSpecialist() (which must set the lock
// SYNCHRONOUSLY, before the real child exists) and bindReservation() (which
// swaps it for the real childId once createChild mints one, a few awaits
// later in spawnSpecialist). Never a valid session id, so it can't collide.
const RESERVED_WRITER = '__reserved__';

// Task 7: poll cadence for the staleness check in runSpecialist. Deliberately
// much finer than either threshold (SPECIALIST_IDLE_STALE_MS/
// SPECIALIST_IN_TOOL_STALE_MS, 120s/300s) so a crossing is caught within
// seconds, not up to a whole threshold late. Not exported: nothing outside
// runSpecialist needs to know how often this checks, only what it checks.
const STALE_CHECK_INTERVAL_MS = 5_000;

/** What one specialist run produced. `usage` is summed across the run's turns
 *  (the brief turn plus a nudge turn, if one was needed). */
export interface SpecialistRunResult {
  report: string;
  /** Tool calls the child made, plus its final answering step. The transcript
   *  has no per-step event, so this is counted from `tool-use` events rather
   *  than read off the driver — good enough for a progress/telemetry number,
   *  and it over-counts a step that emitted parallel tool calls. */
  steps: number;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number };
}

interface LiveEntry {
  session: HarnessSession;
  cwd: string;
  // This generation's MCP lease (undefined when no manager is wired, or when
  // acquireMcp() caught a whole-registry failure). It lives HERE, on the live
  // entry, rather than in a sessionId-keyed map on the host.
  //
  // BE HONEST ABOUT WHY. This is structural insurance, NOT a fix for a bug
  // observable today — a sessionId-keyed side map was tried as a mutation and
  // no test could tell the difference, because it genuinely behaves the same
  // right now. Two things make it equivalent: resume() awaits any live
  // destroy() for the same id before acquiring, and destroy() has no await
  // between `this.live.delete()` and the release call below, so nothing can
  // interleave and swap the lease out. Both are properties of code that could
  // change. Reading the lease off the entry destroy() already captured — at
  // its top, before any await — makes "release the generation you are tearing
  // down" true by construction rather than by that pair of coincidences, which
  // is the same discipline McpLease applies inside the manager (where the
  // equivalent bug WAS reachable and is mutation-tested).
  mcpLease?: McpLease;
  // Per-session append serialization: each transcript event extends this chain
  // (append(prev).then(next)) so the SessionStore contract (serialized appends)
  // holds. Starts resolved; a failed append is logged but never breaks the
  // chain (a later append must still run).
  appendChain: Promise<void>;
  // M1 send queue: FIFO of user messages that arrived while a turn was in
  // flight. Drained one at a time by runTurns; dropped with the entry on destroy.
  // Task 11 (cancel/edit queued messages): each entry carries a host-minted id
  // (send()'s randomUUID()) so removeQueued() can target one entry precisely —
  // the id is opaque to the drain loop, which only ever consumes the FRONT via
  // shift() (see runTurns), so a removed entry can never be shifted out and sent.
  // `attachments` are absolute composer file paths; image ones become image
  // parts on the user message. Carried through the QUEUE too, or a message sent
  // while a turn was in flight would silently lose its pictures.
  queue: { id: string; text: string; attachments: string[] }[];
  // True from dispatch until runTurns finishes the last queued turn. Host-owned
  // (HarnessSession's in-flight state is private); safe because Node is single-threaded.
  inFlight: boolean;
  // Awaitable handle on the CURRENT drain (the dispatched turn + any queued
  // follow-ups it drains). Set by send() at dispatch; resolves when runTurns
  // exits (runTurns try/catches its send() so this never rejects). undefined
  // when no turn has ever been dispatched, or resolved after the last one ended.
  // quiesce()/teardown await this to know the in-flight turn has actually settled
  // — the host has no other awaitable handle on the fire-and-forget runTurns.
  running?: Promise<void>;
  // Specialists (plan 1a): set ONLY on a child minted by createChild. It is the
  // back-pointer that lets destroy() de-register this child from its parent's
  // childrenOf set without re-reading the header off disk (see childrenOf).
  parentSessionId?: string;
  // WHY (2026-09-09, Destin: "when I interrupt that should pause or end the
  // turn without a new message immediately starting the turn back up again"):
  // Stop used to be the exact moment a parked background report was delivered.
  // isIdle() is "no turn in flight", the Stop button ends the turn, and
  // drainDeliveries runs at the tail of every turn regardless of how it ended
  // — so pressing Stop CAUSED a fresh model turn on whatever had finished in
  // the background (transcript audit: 10 of 15 stops were followed within a
  // minute by an auto-started turn). This flag is set by interrupt() and
  // cleared by the next USER-started turn; while it is set, nothing is
  // delivered as a turn. The held reports are then spliced into history
  // silently, right before that next user message, so the model still sees
  // them — as context for what the user asked, not as a reason to speak.
  holdDeliveries?: boolean;
}

// The no-op opener kickIdleDeliveryPass dispatches purely to reach runTurns'
// delivery tail. A named constant so runTurns can tell "a user started this
// pass" (a typed message, a queued message, a skill) from "the host did".
const IDLE_PASS = async (): Promise<void> => {};

export class NativeSessionHost extends EventEmitter {
  private live = new Map<string, LiveEntry>();
  // Reverse index: modelId → sessionIds currently bound to it. The ONLY
  // session→model usage tracking in the app. Drives "unload a model when no
  // session is using it" (#1) — when a model's set empties, onModelReleased
  // fires so the engine can free it immediately (ahead of the 5-min sleep).
  private modelRefs = new Map<string, Set<string>>();
  private onModelReleased?: (modelId: string) => void;

  // One broker for all native sessions (spec §2.4). Its 'hook-event's are
  // re-emitted on this host so ipc-handlers forwards them on the SAME channel
  // as native transcript events (which is the SAME channel CC hook events ride).
  private broker = new PermissionBroker();

  // Per-session permission mode (spec §2.4 layer 2). In-memory, per session,
  // default 'ask' — NOT persisted (a fresh app session starts back at 'ask').
  // decide() reads this fresh on every tool, so setPermissionMode() takes effect
  // on the NEXT gated call without disturbing an in-flight ask.
  private modeFor = new Map<string, NativePermissionMode>();

  // Per-session in-memory copy of "Always allow" rules remembered THIS session.
  // WHY memory is the source of session-truth: the disk persist (PermissionStore)
  // is async fire-and-forget, so relying on it alone means (a) a failed persist
  // silently never sticks — the user re-asks forever — and (b) a fast model's
  // next tool can race the write and re-ask once. Updated SYNCHRONOUSLY in the
  // remember-rule handler (before the async persist kicks off) and unioned into
  // decide(), so an Always-allow always sticks for the rest of this session.
  // Disk remains the cross-session record; this is per-run and dropped on destroy.
  private rememberedFor = new Map<string, PermissionRule[]>();

  // Specialists (plan 1a): parent session id → its live specialist children.
  // Maintained by createChild() and by destroy() (which de-registers a child as
  // it tears it down). WHY a map rather than re-reading headers at teardown:
  // destroy()/interrupt()/quiesce() must find a session's children WITHOUT disk
  // I/O — interrupt() is synchronous and cannot read files at all, and a
  // teardown that depended on a readable header would silently leak a running
  // child if the read failed.
  private childrenOf = new Map<string, Set<string>>();

  // Task 8 — the naming easter egg's per-parent draw-without-replacement
  // state: parent session id → first names already handed out to ITS
  // children. Scoped per parent (not global) for the same reason childrenOf
  // is: an unrelated conversation's specialists must not shrink this one's
  // name pool. Cleared alongside childrenOf in destroyChildrenOf() — a fresh
  // delegation under a torn-down-and-reused parent id (there isn't one in
  // practice, but nothing should assume it) would otherwise start with a
  // phantom set of "already used" names.
  private takenNamesOf = new Map<string, Set<string>>();

  // Task 6 — the Task tool's per-parent state (spec §5 Global Constraints
  // scope decision: PER-PARENT, never host-global — one session's specialist
  // fan-out must not be capped, or blocked, by an UNRELATED session's
  // children). Both are keyed by PARENT session id, never by child id.
  //   specialistSlots: how many children this parent currently has running,
  //     against maxSpecialistsFor(parentId) (Task 13: profile-derived — see
  //     capability-profile.ts's maxConcurrentSpecialists; HOSTED_MAX_CONCURRENT_SPECIALISTS,
  //     specialists/limits.ts, remains the value for a hosted profile AND the
  //     defensive fallback below when no live profile is available).
  //   activeWriterChild: the single write-capable (charter: 'read-write')
  //     child currently running under this parent, if any — the single-writer
  //     invariant (two concurrent write-capable children could race edits to
  //     the same files). Absent = no writer active.
  private specialistSlots = new Map<string, number>();
  private activeWriterChild = new Map<string, string>();
  // Task 12, item 3: per-parent LIFETIME spawn count against
  // SPECIALIST_SPAWN_BUDGET_PER_SESSION — never decremented (unlike
  // specialistSlots above), because it is a runaway-loop backstop, not a
  // concurrency gate. In-memory only: a fresh conversation gets a fresh budget.
  private specialistSpawnCounts = new Map<string, number>();

  // Task 2 (plan 1b) — the durable delegation-ledger sidecar
  // (delegation-ledger.ts). undefined whenever no NativeHome was injected
  // (most existing test constructions, which have no reason to touch disk for
  // this) — every call site below guards on `this.ledger` and no-ops in that
  // case, so recording is best-effort in tests but MANDATORY in production
  // (ipc-handlers.ts always injects the shared nativeHome).
  private ledger?: DelegationLedger;
  // Task 4 (plan 1b) — the same NativeHome the ledger wraps, held directly too
  // for writeSessionArtifact (the oversized-report spill file), which is
  // outside DelegationLedger's own persistence contract (JSON sidecars only).
  // undefined under the identical condition `ledger` is.
  private nativeHome?: NativeHome;

  // Task 4 (plan 1b) — parent session ids with at least one background
  // specialist report waiting to be injected. Drained by runTurns' own tail
  // (after its queue-drain loop, before entry.inFlight = false) and by
  // queueDelivery() itself when the parent is already idle. A Set, not a
  // counter: membership is all that matters — the delivery loop re-reads the
  // real count from the ledger every time it runs.
  private pendingDeliveryParents = new Set<string>();

  // Task 4 fix-pass 2 — in-memory fallback delivery lane. WHY this exists:
  // runDelegation's own completion write is deliberately log-only on failure
  // (a bookkeeping failure must never relabel a real run 'failed'), and fix
  // pass 1's answer was a SECOND ledger write fired synchronously right after
  // the first failed. Re-review rejected that: DelegationLedger.update() and
  // .updateIfRunning() both bottom out in the SAME NativeHome.mutateJson call
  // against the SAME sidecar file, so a systemic cause (disk full,
  // permissions, corrupt file, lock exhaustion) reproduces on the retry
  // identically — it raised the illusion of resilience, not the fact of it.
  // This map is what replaces that retry: when the completion write is
  // confirmed NOT to have landed (see the read-back in spawnSpecialistBackground's
  // .then handlers), the report the child actually produced is held here,
  // keyed by childId, until the delivery loop injects it. WHAT THIS DOES NOT
  // GIVE YOU: durability. If the app restarts before the delivery loop drains
  // this entry, the report is gone — nothing durable was ever written for it.
  // That loss is accepted ONLY because the parent already receives the report
  // in THIS session, at the very next idle boundary, same as a normal
  // ledger-backed delivery — see the delivery loop in runTurns below.
  private inMemoryFallback = new Map<string, { parentId: string; rec: DelegationRecord }>();

  // Plan 1b Task 8 — plain-text notices for a parent that are NOT a specialist
  // RUN outcome (a DelegationRecord): today the only producer is a late answer
  // to a routed permission ask that arrived after the child that raised it had
  // already ended (onLateResponse below). Kept as its own, much simpler lane
  // rather than shoehorned into DelegationRecord's completed/failed status
  // machine — a late answer isn't a run the ledger models, it's a one-line
  // follow-up. It still lands through the SAME idle-boundary injection
  // mechanism Task 4 built for background completions (kickIdleDeliveryPass +
  // drainDeliveries' runNotice call) rather than a second delivery path.
  // Purely in-memory, like inMemoryFallback above: an app restart losing an
  // unread late-answer notice is an accepted loss, not a durability promise
  // this lane makes.
  // G-1: notices now carry the structured meta the renderer folds into a
  // card; shell notices ready in one drain are concatenated into ONE turn (D8).
  private pendingHostNotices = new Map<string, Array<{ text: string; meta?: InjectedMeta }>>();
  /** G-1: one ShellRegistry per session id, HOST-owned. Why not on the
   *  HarnessSession: a remote takeover and the session-exit backstop destroy
   *  the session but must leave its commands running (D2) — those runs still
   *  need an owner that can kill them at app quit and re-attach them if the
   *  same conversation is resumed in this process. */
  private shellRegistries = new Map<string, ShellRegistry>();
  /** G-1: registries whose conversation was closed and whose kill is still in
   *  flight. Why a second collection: a close sends SIGTERM and escalates to
   *  SIGKILL two seconds later, but the registry leaves shellRegistries at
   *  once — so quitting the app inside that window left a process that ignores
   *  SIGTERM alive with nothing left to reach it. destroyAll sweeps this too. */
  private drainingShellRegistries = new Set<ShellRegistry>();

  // Plan 1b Task 8 — a routed ask's late APPROVE, recorded once the child that
  // raised it has already ended, keyed by childId.
  //
  // Final-review fix: this used to say "nothing in this file reads it back
  // yet" / "honestly inert" — true when Task 8 first wrote it, false now.
  // resumeSpecialist (below, around the `childApprovedAsks.get(opts.childId)`
  // call) is its consumer: it folds any late approval into the resumed
  // child's steer lines and clears the entry, so a later resume of the same
  // child never repeats an ask the user already answered. A maintainer
  // trusting the old wording could delete this write believing nothing reads
  // it, which would silently break that ask-skipping on resume.
  private childApprovedAsks = new Map<string, { tool: string }[]>();

  /** Pop (remove) the first in-memory fallback report belonging to `parentId`,
   *  if any — the delivery loop's second-choice lane, tried only after the
   *  ledger has nothing more claimable. Removing on read (not just on
   *  successful delivery) would risk losing it to a runNotice failure with no
   *  way to retry, so callers that fail to actually deliver must put it back;
   *  see the delivery loop's own catch for that half. */
  private takeInMemoryFallback(parentId: string): { childId: string; rec: DelegationRecord } | undefined {
    for (const [childId, entry] of this.inMemoryFallback) {
      if (entry.parentId === parentId) {
        this.inMemoryFallback.delete(childId);
        return { childId, rec: entry.rec };
      }
    }
    return undefined;
  }

  /** Stash a background completion/failure into the in-memory fallback lane
   *  — but only if the parent might still come back to read it.
   *
   *  WHY this guard exists (Task 4 fix pass 4, Finding 4): destroy()'s own
   *  inMemoryFallback sweep only removes entries present AT THE MOMENT it
   *  runs — it has no way to see an entry stashed by THIS chain's `.then`
   *  handler landing AFTER a plain (non-shutdown) destroy() has already
   *  dropped `parentId` from `this.live`. That is the exact ordering a
   *  background run's own completion produces: the child keeps running for
   *  a while after its parent could, independently, be destroyed. Without
   *  this check, such an entry would sit in the map — reachable by nothing,
   *  since drainDeliveries only ever drains a LIVE parent's queue — until
   *  destroyAll()'s own belt-and-suspenders `.clear()` at app quit: a real
   *  leak for the rest of the app's run, not just a delayed delivery.
   *  Checking HERE, at the write site, closes it at the source instead of
   *  reactively: a torn-down parent can never come back to read this
   *  either way (see the field's own WHY above), so there is nothing to
   *  gain by holding it — the report is honestly logged as undeliverable
   *  rather than silently leaked in memory. */
  private stashFallbackIfParentAlive(parentId: string, childId: string, rec: DelegationRecord): void {
    if (!this.live.has(parentId)) {
      log('WARN', 'NativeSessionHost', 'a background specialist finished after its parent session was already destroyed — the report has nowhere left to be delivered', { childId, parentId });
      return;
    }
    this.inMemoryFallback.set(childId, { parentId, rec });
  }

  // Task 14 — the on-disk budget/frontier tiers (delegated-models.ts). Same
  // "undefined whenever no NativeHome was injected" contract as `ledger`
  // above: existing test constructions get no delegated-tier resolution
  // (their sessions never see ToolServices.models), and ipc-handlers.ts
  // always injects the shared nativeHome in production.
  private delegatedModels?: DelegatedModels;

  /** Task 13 — the parent's own resolved CapabilityProfile now carries its
   *  concurrency ceiling (maxConcurrentSpecialists): the spec's flat hosted
   *  constant for a cloud/hosted session, an engine-measured (clamped 1-4)
   *  number for a known local model, 1 for an unrecognized one — see
   *  capability-profile.ts. Falls back to HOSTED_MAX_CONCURRENT_SPECIALISTS
   *  only when the parent isn't live to ask (reserveSpecialist is only ever
   *  called against a live parent in production, so this branch shouldn't be
   *  reachable there — but a missing snapshot must degrade to the
   *  conservative hosted number, never silently allow unbounded fan-out). */
  private maxSpecialistsFor(parentId: string): number {
    return this.live.get(parentId)?.session.profileSnapshot.maxConcurrentSpecialists
      ?? HOSTED_MAX_CONCURRENT_SPECIALISTS;
  }

  // WHY: 1a checked writer-busy in task.ts and set the lock after an await in
  // spawnSpecialist — a check-then-set race the 1a comment explicitly deferred to
  // this plan. Reserve slot AND writer in one synchronous step; the token is the
  // only way to release, so a throw between reserve and spawn can't leak either.
  reserveSpecialist(parentId: string, opts: { writer: boolean }):
    { ok: true; token: SpecialistReservation }
    | { ok: false; reason: 'at-capacity'; max: number }
    | { ok: false; reason: 'writer-busy' } {
    if (opts.writer && this.activeWriterChild.has(parentId)) return { ok: false, reason: 'writer-busy' };
    const current = this.specialistSlots.get(parentId) ?? 0;
    const max = this.maxSpecialistsFor(parentId);
    // Task 13: carry the RESOLVED ceiling on the refusal itself — tools/task.ts
    // renders `max` straight into the at-capacity message, so a local
    // session's real (possibly smaller) ceiling is what the model reads,
    // never a hardcoded hosted constant that doesn't match what was enforced.
    if (current >= max) return { ok: false, reason: 'at-capacity', max };
    this.specialistSlots.set(parentId, current + 1);
    const token: SpecialistReservation = { parentId, writer: opts.writer };
    if (opts.writer) this.activeWriterChild.set(parentId, RESERVED_WRITER); // placeholder until a childId binds
    return { ok: true, token };
  }

  /** Swap the RESERVED_WRITER placeholder for the real childId once
   *  createChild mints one (spawnSpecialist calls this right after createChild
   *  resolves, before the run starts) — a no-op for a reader reservation,
   *  which never touched activeWriterChild. Mutates `token.childId` too, so
   *  releaseReservation's owner check below can tell whether it's clearing
   *  THIS reservation's entry or a later one under the same parent. */
  bindReservation(token: SpecialistReservation, childId: string): void {
    token.childId = childId;
    if (token.writer && this.activeWriterChild.get(token.parentId) === RESERVED_WRITER) {
      this.activeWriterChild.set(token.parentId, childId);
    }
  }

  /** Release a reservation made by reserveSpecialist. Decrements the slot
   *  (deleting the map entry at zero, same as 1a's releaseSpecialistSlot, so a
   *  parent that never delegates again doesn't linger in the map) and, for a
   *  writer reservation, clears the writer lock — but ONLY if it still points
   *  at THIS token's identity (the bound childId, or the RESERVED_WRITER
   *  placeholder if release() runs before bindReservation ever did, e.g. a
   *  spawn that threw before createChild resolved). Fix 5's owner-check (1a
   *  review) carried forward: an unconditional delete would clear whichever
   *  child currently holds parentId's writer lock, including one a LATER
   *  parallel Task call under the same parent reserved after this one. */
  releaseReservation(token: SpecialistReservation): void {
    const current = this.specialistSlots.get(token.parentId) ?? 0;
    if (current <= 1) this.specialistSlots.delete(token.parentId);
    else this.specialistSlots.set(token.parentId, current - 1);
    if (token.writer) {
      const holder = token.childId ?? RESERVED_WRITER;
      if (this.activeWriterChild.get(token.parentId) === holder) this.activeWriterChild.delete(token.parentId);
    }
  }

  /** Spend one unit of this parent's lifetime specialist-spawn budget (Task
   *  12, item 3). false = budget exhausted; the caller (tools/task.ts) must
   *  not spawn. Never released — a runaway-loop backstop, not a resource
   *  limit that frees up as children finish (see specialistSlots for that). */
  trySpendSpecialistSpawnBudget(parentId: string): boolean {
    const used = this.specialistSpawnCounts.get(parentId) ?? 0;
    if (used >= SPECIALIST_SPAWN_BUDGET_PER_SESSION) return false;
    this.specialistSpawnCounts.set(parentId, used + 1);
    return true;
  }

  /** Task 6 — the own-children-only check the whole task_id management
   *  surface (steerSpecialist/interruptSpecialist/resumeSpecialist) is built
   *  on. `childrenOf` only ever holds a parent's CURRENTLY LIVE children
   *  (destroy() removes an entry the moment it tears one down), so a hit
   *  there is authoritative for "running". A miss falls back to the ledger —
   *  the durable record of every delegation this parent ever made, which
   *  outlives the child's own teardown — so a FINISHED own child is still
   *  found (and returned `live: false`) rather than read as foreign. `null`
   *  covers BOTH "no such child anywhere" and "belongs to a different
   *  parent" identically on purpose: every caller must refuse the same way
   *  either way, or the refusal itself would leak which case it was (spec §5
   *  own-children-only). */
  private locateOwnChild(
    parentId: string, childId: string,
  ): { live: true; entry: LiveEntry; record?: DelegationRecord } | { live: false; record: DelegationRecord } | null {
    const parentCwd = this.live.get(parentId)?.cwd;
    const record = this.ledger && parentCwd ? this.ledger.listFor(parentCwd, parentId).find((r) => r.childId === childId) : undefined;
    if (this.childrenOf.get(parentId)?.has(childId)) {
      return { live: true, entry: this.live.get(childId)!, record };
    }
    return record ? { live: false, record } : null;
  }

  /** Task 6 — the specialist's own name/brief, needed so a steer/interrupt
   *  result can NAME who was affected rather than reciting a bare task_id
   *  back at the model. Ledger-first (it carries both `title` AND the
   *  parent's real delegated `description` — recordStart stamps both at
   *  spawn time); falls back to the persisted header's `title` alone when no
   *  ledger record is available (a host built with no NativeHome, or a race
   *  the ledger lookup lost) — `description` genuinely isn't recoverable
   *  without the ledger, so this never invents one. */
  private titleAndDescriptionFor(childId: string, childCwd: string, record?: DelegationRecord): { title: string; description?: string } {
    if (record) return { title: record.title, description: record.description };
    return { title: this.store.readHeader(childId, childCwd)?.title ?? childId };
  }

  /** Task 6 — steer a RUNNING own child (`task_id` management surface).
   *  'not-yours' refuses identically whether `childId` belongs to a
   *  different parent or doesn't exist at all (see locateOwnChild). A live
   *  child that ISN'T currently mid-turn (postSteer returns false — the gap
   *  between one turn ending and a possible retry/nudge turn starting) still
   *  returns 'ok': the miss is recorded to the ledger's `missedSteers`
   *  instead of being silently lost, so a later resumeSpecialist call can
   *  fold it into the resumed brief (see runDelegation's own drain for the
   *  child-torn-down case this doesn't cover — that one is genuinely gone,
   *  by design; this one is a real between-turns miss). Best-effort when no
   *  ledger is wired: the steer attempt itself (postSteer) still happens
   *  either way, only the "record the miss so it isn't lost forever" half
   *  needs the ledger.
   *
   *  Fix (external review — the clobber race): this used to read `record`
   *  (a snapshot `locateOwnChild` took OUTSIDE any lock) and compute
   *  `[...record.missedSteers, text]` itself, then fire that fixed array off
   *  as an update() patch. If the child's run completed in the same narrow
   *  window, runDelegation's own completion write (its `missedSteers` drained
   *  from a completely different source — the session's live pendingSteers
   *  queue) could land AFTER this one and silently overwrite it back to
   *  whatever it drained, erasing the steer this method just recorded.
   *  appendMissedSteers reads-and-appends from INSIDE the ledger's own lock,
   *  so two concurrent writers to the same record's `missedSteers` commute
   *  instead of one clobbering the other — see its own WHY.
   *
   *  `from` (plan 1c, default 'assistant' so the Task tool's own task_id
   *  steer call — which never names a `from` — keeps its existing behavior
   *  unchanged): the note is recorded when it is ACCEPTED, whichever way it
   *  travels, so the card learns of it from the run record the ledger emits
   *  (spec §2) rather than a separate message type. A LIVE delivery is one
   *  ledger write (appendNote); a PARKED steer's note rides in the SAME write
   *  as the parked steer itself (appendMissedSteers' own `note` param) — the
   *  global "one ledger write per related change" rule, so a throw between
   *  two writes can never park the steer while dropping the note the user
   *  saw, or the reverse. */
  steerSpecialist(parentId: string, childId: string, text: string, from: 'user' | 'assistant' = 'assistant'): SpecialistManageOutcome {
    const loc = this.locateOwnChild(parentId, childId);
    if (!loc) return { status: 'not-yours' };
    if (!loc.live) return { status: 'not-running', agentType: loc.record.agentType };
    const { entry, record } = loc;
    // `text` (unclamped) is what the helper actually receives — delivery and
    // ledger-recording are separate concerns, and clamping delivery would
    // silently cut what the helper was told to do, which nobody asked for.
    const delivered = entry.session.postSteer(text);
    const parentCwd = this.live.get(parentId)?.cwd;
    if (this.ledger && parentCwd) {
      // Review finding fix (Task 5): the Global Constraints' flat 2,000-char
      // note cap was only checked in steerFromUser (the human's send-a-note
      // box). The model's own task_id steer call reaches this method
      // directly via `from: 'assistant'` with nothing bounding it, and EVERY
      // accepted steer is now a permanent ledger entry (read-modify-write
      // WHOLE on every access, spec Task 5) — so a model that writes a huge
      // steer grows that file without limit, forever, the same cost class
      // RAW_REPORT_CAP_CHARS already guards on the report side. The cap is
      // applied HERE, inside steerSpecialist itself, so it holds no matter
      // which caller reaches this method.
      //
      // Reject vs. clamp differ ON PURPOSE by `from`: a user who typed too
      // much gets told so (steerFromUser's own error, above this method) and
      // can shorten it and resend — silently cutting their words would be
      // confusing. A model can't "retype" a rejected steer without another
      // round trip that itself risks looping, and the delivered text (what
      // the helper actually acts on) is never touched anyway — only the
      // saved copy is shortened, with a visible marker so nobody mistakes a
      // clamped note for the model's whole message.
      const CLAMP_MARK = ' … (cut short — the note was too long to save in full)';
      const recordedText = text.length > SPECIALIST_NOTE_MAX_CHARS
        ? text.slice(0, SPECIALIST_NOTE_MAX_CHARS - CLAMP_MARK.length) + CLAMP_MARK
        : text;
      const note = { text: recordedText, from, at: Date.now() };
      if (delivered) {
        void this.ledger.appendNote(parentCwd, parentId, childId, note).catch((err) => {
          log('ERROR', 'NativeSessionHost', 'failed to record a steer note in the ledger', { childId, parentId, error: String(err) });
        });
      } else {
        void this.ledger.appendMissedSteers(parentCwd, parentId, childId, [text], note).catch((err) => {
          log('ERROR', 'NativeSessionHost', 'failed to record a missed steer in the ledger', { childId, parentId, error: String(err) });
        });
      }
    }
    const { title, description } = this.titleAndDescriptionFor(childId, entry.cwd, record);
    return { status: 'ok', title, description };
  }

  /** Task 5 (plan 1c) — the user-facing "send a note" surface (mid-run steer
   *  from the card, not the model's own task_id steer). Never throws: every
   *  refusal is a plain-English string the renderer shows verbatim, so it
   *  must read as a sentence a non-developer would understand, never a status
   *  code or a guessed cause (error-message-standards.md). Validation runs
   *  BEFORE steerSpecialist so an empty/oversized note never reaches the
   *  ledger at all — trimmed here once, and the trimmed text is what actually
   *  gets recorded (steerSpecialist sees `t`, not the raw `text`). */
  steerFromUser(parentId: string, childId: string, text: string): { ok: true } | { ok: false; error: string } {
    const t = text.trim();
    if (!t) return { ok: false, error: 'The note is empty.' };
    if (t.length > SPECIALIST_NOTE_MAX_CHARS) {
      return {
        ok: false,
        error: `Notes are limited to ${SPECIALIST_NOTE_MAX_CHARS.toLocaleString()} characters — this one is ${t.length.toLocaleString()}.`,
      };
    }
    const outcome = this.steerSpecialist(parentId, childId, t, 'user');
    if (outcome.status === 'not-yours') return { ok: false, error: 'That helper isn’t part of this conversation.' };
    if (outcome.status === 'not-running') return { ok: false, error: 'This helper has already finished, so a note can’t reach it.' };
    return { ok: true };
  }

  /** Task 5 (plan 1c) — the user-facing "stop this helper" surface, the same
   *  outcome-to-plain-English mapping as steerFromUser above (see its own
   *  comment for why this never throws). No length/emptiness to validate —
   *  interruptSpecialist itself has no input beyond the child to act on. */
  interruptFromUser(parentId: string, childId: string): { ok: true } | { ok: false; error: string } {
    const outcome = this.interruptSpecialist(parentId, childId);
    if (outcome.status === 'not-yours') return { ok: false, error: 'That helper isn’t part of this conversation.' };
    if (outcome.status === 'not-running') return { ok: false, error: 'This helper has already finished.' };
    return { ok: true };
  }

  /** Task 8 (plan 1c) — Settings' two model-tier rows. `delegatedModels` is
   *  only wired when this host was built with a real NativeHome (ipc-handlers'
   *  production wiring always does; a bare test construction gets neither
   *  tiers to designate nor a store to read them from) — that case reads as
   *  "nothing designated" rather than throwing. Labels come from
   *  toolServices.modelCatalog, the SAME closure the Task tool's own
   *  ModelSearch/resolveDelegatedBinding already read (Finding 1 fix pass) —
   *  one catalog source for every specialists surface. */
  async getDelegatedModels(): Promise<DelegatedModelsView> {
    if (!this.delegatedModels) return { budget: null, frontier: null };
    const catalog = (await this.toolServices?.modelCatalog?.()) ?? null;
    return delegatedModelsView(this.delegatedModels, catalog);
  }

  /** Task 8 — the tier picker's write path. A specific binding must resolve
   *  to a REAL row in the live catalog (matched on providerId + modelId, not
   *  modelId alone — a tier names one exact provider/model pair, not "any
   *  provider that happens to have this id") or the write is refused
   *  entirely; a stale/unconfirmed binding would let a helper silently spawn
   *  on a model that no longer exists, with nothing on screen explaining why.
   *  `binding: null` always clears the tier — no catalog lookup needed, since
   *  clearing can never be "wrong". */
  async setDelegatedModel(tier: DelegatedTier, binding: ModelBinding | null): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.delegatedModels) return { ok: false, error: 'Specialists aren’t available in this session.' };
    if (binding !== null) {
      const catalog = (await this.toolServices?.modelCatalog?.()) ?? null;
      const found = catalog?.find((m) => m.id === binding.modelId && m.providerId === binding.providerId);
      if (!found) {
        return { ok: false, error: `"${binding.modelId}" isn’t in the model list right now — pick it from the list.` };
      }
    }
    await this.delegatedModels.set(tier, binding);
    return { ok: true };
  }

  /** Task 6 — cancel a RUNNING own child outright (`task_id` management
   *  surface, `interrupt: true`). Writes `status: 'interrupted'` to the
   *  ledger BEFORE aborting the stream — the same "interrupted wins" ordering
   *  destroyChildrenOf already relies on for a whole-parent teardown
   *  (updateIfRunning, in runDelegation's own catch, is a no-op once status
   *  has left 'running'), applied here to one explicit task_id cancel
   *  instead. interrupt(childId) then aborts the child's in-flight stream —
   *  runDelegation's own `finally` tears the child down once that abort
   *  propagates; this method does not destroy it directly, and does not
   *  release the reservation either (that ownership stays with whichever
   *  caller — spawnSpecialist's `finally`, or spawnSpecialistBackground/
   *  resumeSpecialist's own detached chain — reserved it). */
  interruptSpecialist(parentId: string, childId: string): SpecialistManageOutcome {
    const loc = this.locateOwnChild(parentId, childId);
    if (!loc) return { status: 'not-yours' };
    if (!loc.live) return { status: 'not-running', agentType: loc.record.agentType };
    const { entry, record } = loc;
    const { title, description } = this.titleAndDescriptionFor(childId, entry.cwd, record);
    const parentCwd = this.live.get(parentId)?.cwd;
    if (this.ledger && parentCwd) {
      // Fix (Critical 3, final review): updateUnlessCompleted, not update() —
      // this write is fire-and-forget (no await below), so it can still be
      // in flight when runDelegation's OWN completion write lands first (the
      // child finishes on its own in the gap between this call starting and
      // its ledger write actually committing). A 'completed' record already
      // has a real report waiting on claimUndelivered; update() would
      // silently clobber it to 'interrupted', which claimUndelivered never
      // looks at, stranding the report forever. See updateUnlessCompleted's
      // own comment for why 'failed' stays unprotected (interrupted must
      // still win over a merely-symptomatic failure).
      void this.ledger.updateUnlessCompleted(parentCwd, parentId, childId, { status: 'interrupted', endedAt: Date.now() })
        .catch((err) => log('ERROR', 'NativeSessionHost', 'failed to record an explicit specialist interrupt in the ledger', { childId, parentId, error: String(err) }));
    }
    this.interrupt(childId);
    return { status: 'ok', title, description };
  }

  /** Task 6 — resume a FINISHED or INTERRUPTED own child (`task_id`
   *  management surface). Cold rebuild, mirroring createChild minus the
   *  header create: read the persisted header (never rewritten — it's still
   *  the pre-resume header written at the original spawn), re-resolve
   *  `agentType` against the CURRENT specialist registry (a specialist
   *  removed from the roster since this child was spawned throws a typed
   *  error naming it, same as an unknown id would), rebuild the
   *  HarnessSession via buildSpecialistSession (the exact construction
   *  createChild uses), then seedHistory from the child's OWN transcript
   *  (spec §2.5 — cold state, never live in-memory state carried across).
   *
   *  `opts.reservation` MUST already be bound to nothing (tools/task.ts calls
   *  `reserve()` fresh for a resume, exactly like a new spawn) — bindReservation
   *  below claims it for this childId. The ledger's EXISTING record for this
   *  childId is flipped back to 'running' rather than recordStart-ing a
   *  second row (this.ledger's own lookups assume one row per childId — a
   *  second row would make every later `.find(r => r.childId === childId)`
   *  ambiguous); `description`/`agentType`/`workDir`/`title` all stay exactly
   *  as the ORIGINAL delegation recorded them, because a resume is a
   *  CONTINUATION of that same delegation, not a new one. */
  async resumeSpecialist(parentId: string, opts: {
    childId: string; prompt: string; background?: boolean; parentToolCallId: string; reservation: SpecialistReservation;
  }): Promise<SpecialistResumeOutcome> {
    const parent = this.live.get(parentId);
    // Belt-and-suspenders (mirrors createChild's own "no live parent" throw):
    // the Task tool can only ever call this against a live parent (it's the
    // session driving the tool call), so this should be unreachable in
    // production — but "shouldn't happen" still needs a real answer here
    // rather than a crash a few lines down on `parent.cwd`.
    if (!parent) throw new Error(`Cannot resume a specialist: parent session ${parentId} is not live.`);

    const loc = this.locateOwnChild(parentId, opts.childId);
    if (!loc) return { status: 'not-yours' };
    if (loc.live) return { status: 'still-running' };
    const { record } = loc;
    const workDir = record.workDir;
    const header = this.store.readHeader(opts.childId, workDir);
    if (!header) throw new Error(`Cannot resume specialist ${opts.childId}: its transcript could not be read.`);
    const agentType = header.agentType ?? record.agentType;
    // Task 4 (plan 1c) — resolved against the PARENT's own per-cwd roster
    // (never the bare built-in lookup): the parent's cwd is where its
    // specialists folders live, and ensureFresh(parent.cwd) has already run
    // at least once by the time any session is live (create()/resume() both
    // await it before wiring).
    const specialist = this.specialistCatalog.roster(parent.cwd).resolve(agentType);
    if (!specialist) throw new Error(`Cannot resume specialist ${opts.childId}: its specialist type "${agentType}" is no longer available (it may have been removed from the roster).`);

    // D2 fix (2026-08-26, review Critical) — a resume rebuilds the child from
    // the specialist as it is RIGHT NOW (buildSpecialistSession below reads
    // specialist.allowedTools / charter / systemPrompt), while the consent the
    // user gave was for the file as it was at spawn. A resume call carries no
    // work_dir, so it has no permission subject, so no card can be shown for
    // it — under auto-edit the pattern-less Task allow answers first. That made
    // resume a way to run an edited definition with no consent at all. Compare
    // fingerprints and refuse instead. Both sides absent (built-ins, and rows
    // written before this field existed) means "no claim to check" — never a
    // mismatch, or every pre-existing hire would become unresumable.
    if (record.definitionFingerprint && specialist.fingerprint
        && record.definitionFingerprint !== specialist.fingerprint) {
      return { status: 'definition-changed', agentType };
    }

    const preset = resolvePreset(this.presetIdFor.get(parentId));
    const binding = header.binding;
    const { contextLength, profile, pricing, free } = await this.resolveContextAndProfile(binding);
    const title = header.title ?? record.title;

    const session = this.buildSpecialistSession(
      parentId, opts.childId, workDir, title, specialist, binding, contextLength, profile, pricing, free, opts.parentToolCallId, preset, parent,
    );
    // Cold state rebuilt from the child's OWN transcript — seedHistory resets
    // readRegistry + todos too (the same reset-on-resume contract root
    // sessions get in resume() above); readImageFromDisk re-reads any
    // persisted attachment paths so images survive the resume.
    session.seedHistory(rebuildHistory(this.store.readEvents(opts.childId, workDir), readImageFromDisk));
    this.bindReservation(opts.reservation, opts.childId);
    this.wireChildLive(parentId, opts.childId, workDir, session, binding, opts.parentToolCallId);

    // A steer posted while this child was still running but missed its
    // window (steerSpecialist's own between-turns case, or one drained
    // unapplied at the very end of the ORIGINAL run — see runDelegation's own
    // drain) folds into the resumed brief as <steer> lines, the same wire
    // format postSteer itself uses — the child reads a course-correction it
    // missed identically whether it arrives live or at resume.
    //
    // Fix pass 3 (external review — the split-write gap survives here too):
    // fix pass 2 folded the read-and-clear into ONE atomic takeMissedSteers()
    // call, but the status flip that used to follow it stayed a SEPARATE,
    // later `update()` — two lock acquisitions. If the take landed (steers
    // cleared on disk) and that following update() then threw, the catch
    // below tore the freshly-wired child down and rethrew before this child
    // ever got a turn — the resume never delivered the brief carrying those
    // steers, and they were already wiped from the ledger by the take. Lost,
    // with no retry: exactly the split-write shape fix pass 2 closed for
    // runDelegation's own completion/failure writes, left open here.
    //
    // Fix: takeMissedSteers now accepts the same status-flip patch update()
    // used to carry, applied INSIDE the same mutateJson callback that reads
    // and clears missedSteers (see its own WHY). mutateFileUnderLock only
    // calls atomicWrite AFTER computing the full next value, so a throw from
    // this one call means NEITHER the clear NOR the patch reached disk — the
    // record is untouched. This resume attempt still fails and the catch
    // below still tears the freshly-wired child down (nothing else has taken
    // ownership of it), but the steers remain exactly where they were,
    // recoverable by a later resume, instead of vanishing. Read AFTER
    // wireChildLive (rather than before) so a steer that manages to land in
    // the moments before this call still gets folded into THIS resumed brief
    // instead of only the next one. Best-effort fallback to the pre-lock
    // snapshot when no ledger is wired, matching every other "no ledger"
    // fallback in this file — that path was never split, so it needs no fix.
    let missedSteers: string[];
    if (this.ledger && parent.cwd) {
      try {
        missedSteers = await this.ledger.takeMissedSteers(parent.cwd, parentId, opts.childId, {
          status: 'running', startedAt: Date.now(), endedAt: undefined, failureText: undefined,
          delivered: false, background: !!opts.background,
          // Fix (Critical 2, final review): this patch merges onto the SAME
          // ledger row RUN 1 left behind (resume never recordStart's a second
          // row — see this method's own header comment) — every field RUN 1's
          // completion write stamped that only makes sense for THAT run must
          // be reset here, or RUN 2 silently inherits it:
          //  - injectionAttempted is the loss-bearing one. Left true (RUN 1
          //    delivered successfully, so fix pass 5's marker is stamped),
          //    claimUndelivered's `!d.injectionAttempted` bar
          //    (delegation-ledger.ts) can never pass again for this childId —
          //    RUN 2's real completion is claimed by nobody, ever: not the
          //    ledger lane, not the in-memory fallback (never stashed, since
          //    RUN 2's own completion write succeeds), not reconcile, not a
          //    restart. The status block repeats "report delivery pending"
          //    forever, falsely.
          //  - reportPath/rawReport, if RUN 1 spilled an oversized body,
          //    survive untouched; if RUN 2's shorter report never spills
          //    again, delivery reads the STALE file and hands the parent RUN
          //    1's body labeled as RUN 2's report.
          //  - steps is read straight into the delivery preamble — also RUN
          //    1's, not RUN 2's, until reset.
          //  - claimedBy/claimedAt/stale are RUN 1's stale lease/idle
          //    bookkeeping; a lease held over from a run that already
          //    confirmDelivered'd has no meaning for a run that hasn't
          //    started yet, and STALE must not carry over onto a session that
          //    just went active again.
          // Explicit `undefined` (not omitted) so the patch merge
          // (`{...d, ...patch}` in delegation-ledger.ts) actually overwrites
          // whatever RUN 1 left on disk — same convention releaseClaim() uses
          // for the identical reason (delegation-ledger.ts's own comment).
          injectionAttempted: undefined, reportPath: undefined, rawReport: undefined,
          steps: undefined, stale: undefined, claimedBy: undefined, claimedAt: undefined,
        });
      } catch (err) {
        // Mirrors recordDelegationStart's own leak guard: if this write
        // throws, nothing else has taken ownership of the freshly re-wired
        // child yet (runDelegation, which owns teardown from here on, was
        // never entered) — so this tears it down itself before rethrowing.
        // Safe unconditionally: the throw above means the ledger record
        // itself was never touched (see the WHY above), so this teardown
        // only ever discards the live child construction this call just did
        // — it never discards bookkeeping, because none of it committed.
        try { await this.destroy(opts.childId); } catch (destroyErr) {
          log('ERROR', 'NativeSessionHost', 'specialist teardown failed after a resume ledger-flip failure', { childId: opts.childId, parentId, error: String(destroyErr) });
        }
        throw err;
      }
    } else {
      missedSteers = record.missedSteers ?? [];
    }

    // childApprovedAsks (Task 8's forward-looking storage — this is its FIRST
    // consumer): an approval that landed on a routed ask AFTER this child had
    // already ended is otherwise invisible to the resumed run, which would
    // have to re-ask something the user already answered. Folded in and
    // cleared here, once, so a later resume of the SAME child never repeats it.
    const approvals = this.childApprovedAsks.get(opts.childId) ?? [];
    this.childApprovedAsks.delete(opts.childId);
    const steerLines = [
      ...missedSteers.map((s) => `<steer>\n${s}\n</steer>`),
      ...approvals.map((a) => `<steer>\nThe user has now approved your earlier blocked request (${a.tool}) — you may do it now.\n</steer>`),
    ];
    const prompt = steerLines.length > 0 ? `${steerLines.join('\n')}\n\n${opts.prompt}` : opts.prompt;

    const spawnOptsLike: SpecialistSpawnOpts = {
      specialist, binding, prompt, workDir, parentToolCallId: opts.parentToolCallId,
      token: opts.reservation, description: record.description,
    };

    if (opts.background) {
      this.runBackgroundDelegation(parentId, opts.childId, title, spawnOptsLike, opts.reservation);
      return { status: 'ok-background', childId: opts.childId, title };
    }

    const run = await this.runDelegation(parentId, opts.childId, title, spawnOptsLike, opts.reservation);
    // Merge note (Tasks 6 + 10): formatSpecialistReport returns { text, reportPath }
    // since Task 10 — a truncated report spills its full body to a file. The
    // resumed-child path records that path the same way the fresh-spawn path
    // does, so a resumed run's footer points at a file the ledger knows about.
    const { text: report, reportPath } = this.formatSpecialistReport({ parentId, childId: opts.childId, specialist, title, body: run.report });
    if (this.ledger && parent.cwd) {
      if (reportPath) {
        try {
          await this.ledger.update(parent.cwd, parentId, opts.childId, { reportPath });
        } catch (ledgerErr) {
          log('ERROR', 'NativeSessionHost', 'failed to record a truncation-time spill path for a resumed specialist — the report is still returned to the caller', { childId: opts.childId, parentId, error: String(ledgerErr) });
        }
      }
      try {
        await this.ledger.confirmDelivered(parent.cwd, parentId, opts.childId);
      } catch (ledgerErr) {
        log('ERROR', 'NativeSessionHost', 'failed to mark a resumed specialist delivered in the ledger — the report is still returned to the caller', { childId: opts.childId, parentId, error: String(ledgerErr) });
      }
    }
    return { status: 'ok', childId: opts.childId, report };
  }

  /** recordStart + Task 2's leak guard, shared by the foreground and
   *  background spawn paths below (the only thing that differs between them
   *  is the `background` flag on the record itself). If recordStart itself
   *  throws (mutateJson can throw on lock exhaustion), nothing else has taken
   *  ownership of the just-minted child yet — runDelegation, which owns
   *  teardown from here on, was never entered — so this tears it down itself
   *  before rethrowing (Task 2 review round 2, Finding 2's leak guard,
   *  preserved exactly, just relocated). No-ops (and never throws) when no
   *  ledger is wired, matching every other ledger call site in this file. */
  private async recordDelegationStart(
    parentId: string, childId: string, title: string, opts: SpecialistSpawnOpts, background: boolean,
  ): Promise<void> {
    const parentCwd = this.live.get(parentId)?.cwd;
    if (!this.ledger || !parentCwd) return;
    try {
      // Stamp the delegation into the durable ledger the moment the child
      // exists (childId + title known). A crash right after this line still
      // leaves a 'running' row a later pass can see — never silently losing
      // track of a delegation that genuinely started.
      await this.ledger.recordStart(parentCwd, parentId, {
        childId,
        parentToolCallId: opts.parentToolCallId,
        agentType: opts.specialist.id,
        // D2 fix: pin WHICH VERSION of the definition file was consented to,
        // so a later resume can refuse if the file has changed underneath it.
        definitionFingerprint: opts.specialist.fingerprint,
        title,
        workDir: opts.workDir,
        // Task 4: the Task tool's own per-call `description` argument — the
        // parent's real brief, not the specialist's static registered blurb
        // (which is all this could fall back to before SpecialistSpawnOpts
        // carried it). A background completion's preamble interpolates this
        // to remind the parent what it delegated; the static blurb would make
        // that interpolation useless.
        description: opts.description,
        background,
        status: 'running',
        startedAt: Date.now(),
        delivered: false,
        owner: OWNER,
        missedSteers: [],
        // Task 5 (plan 1c) — whatever task.ts resolved this run's model to
        // (or undefined, for a bare test/one-off construction that never
        // wires ctx.binding). Stamped at spawn time so it's on the record
        // from the child's very first ledger row, not backfilled later.
        model: opts.model,
      });
    } catch (err) {
      try {
        await this.destroy(childId);
      } catch (destroyErr) {
        log('ERROR', 'NativeSessionHost', 'specialist teardown failed after a recordStart failure', { childId, parentId, error: String(destroyErr) });
      }
      throw err;
    }
  }

  /** Run one specialist child's delegation to completion: drive the run
   *  (runSpecialist), record its outcome in the ledger, and tear the child
   *  down — always, success or failure (Task 2's leak guard, Task 7's run
   *  loop). Shared by the foreground path (spawnSpecialist awaits this
   *  directly) and the background path (spawnSpecialistBackground lets this
   *  run un-awaited); `reservation` is threaded through for parity with a
   *  future resumed-child caller (Task 6's resumeSpecialist) — this method
   *  itself never releases it, by design: release ownership belongs to
   *  whichever caller reserved it (tools/task.ts for foreground,
   *  spawnSpecialistBackground's own `.finally` for background).
   *
   *  Ledger writes intentionally do NOT set `delivered` — recordStart already
   *  left it `false`, and it is the CALLER's job to decide when this run's
   *  result actually reached the parent: spawnSpecialist confirms delivery
   *  immediately (the tool result IS the delivery), while the background path
   *  leaves it for the idle-boundary delivery loop's confirmDelivered() to
   *  flip once the injected turn has actually run. */
  private async runDelegation(
    parentId: string, childId: string, title: string, opts: SpecialistSpawnOpts, reservation: SpecialistReservation,
  ): Promise<SpecialistRunResult> {
    void reservation; // not consumed here — see the WHY above; kept for signature parity with future resume callers
    const parentCwd = this.live.get(parentId)?.cwd;
    try {
      // PRODUCE THE REPORT FIRST (Task 6 review handoff note 1): once the run
      // has finished, `run` is a value this method owns, so a bookkeeping
      // failure below can no longer discard work the child genuinely produced.
      const run = await this.runSpecialist(childId, opts.prompt);
      // The child's spend is the parent's spend (spec §2). runSpecialist has
      // summed `usage` across the child's turns since plan 1b — until now it
      // was returned and thrown away, which is why a session that delegated all
      // its work reported almost nothing.
      //
      // Priced with the CHILD's own price card, which can name a different
      // model from the parent's (specialists/delegated-models.ts): a free local
      // parent that delegates to a metered specialist really is spending money
      // and has to say so, and the reverse — a metered parent delegating to a
      // local specialist — is why `free` rides along too.
      //
      // Emitted HERE, before the ledger write and before the `finally`
      // teardown, because the child must still be in `this.live` for its price
      // card to be readable. Log-only try/catch, the same contract every other
      // bookkeeping call in this method follows: a failed usage report must
      // never discard the report the child actually produced.
      try {
        const parentSession = this.live.get(parentId)?.session;
        const childSession = this.live.get(childId)?.session;
        if (parentSession && childSession) {
          const { pricing, free } = childSession.priceCard;
          parentSession.emitSubagentUsage({
            // `free` WINS over any rate card (Task 23 item 1 — the specialist
            // twin of the same fix Task 22 made for turn-complete in
            // harness-session.ts). The two facts come from independent
            // sources: `free` from the provider TYPE, the number from the
            // catalog, which keys on the model id and has no idea where the
            // model runs. A specialist delegated to a local model whose id
            // happens to carry a published rate would otherwise report
            // {"costUsd": 0.027, "free": true} — a run billed AND free. Free
            // means free, and free is reported as null, never as a $0.00 bill.
            usage: { ...run.usage, costUsd: free ? null : costForUsage(run.usage, pricing), free },
            model: childSession.binding.modelId,
            parentAgentToolUseId: opts.parentToolCallId,
            agentId: childId,
          });
        } else {
          // Task 23 item 2. This `if` used to have no `else`, so a teardown
          // race that removed either session between the run finishing and its
          // spend being priced dropped a whole delegated run's tokens and cost
          // with ZERO log output — the parent's totals silently went short and
          // nothing anywhere said so. A cost figure that is quietly short is
          // worse than one that is visibly missing: the user has no way to know
          // not to trust it.
          //
          // The message states ONLY what was just looked up and found absent —
          // never a guessed cause (docs/error-message-standards.md). We know
          // which half was missing; we do NOT know why, so we don't say.
          const missing = !parentSession && !childSession ? 'neither session was still live'
            : !parentSession ? 'the parent session was no longer live'
            : 'the specialist session was no longer live';
          log('ERROR', 'NativeSessionHost', `could not report a finished specialist's spend to its parent (${missing}) — the parent's session totals will be short by this run`, { childId, parentId });
        }
      } catch (usageErr) {
        log('ERROR', 'NativeSessionHost', 'failed to report a finished specialist\'s spend to its parent — the parent\'s session totals will be short by this run', { childId, parentId, error: String(usageErr) });
      }
      // WHY drain HERE, not at turn start (folded Task 3 concern): pendingSteers
      // is not reset per-turn by design (harness-session.ts), so anything left
      // in the CHILD's queue at this point is a steer that arrived too late to
      // ever apply — the child is about to be torn down in this method's own
      // finally, so this is the LAST moment it's readable. Draining it here
      // (rather than leaving it silently discarded) is what lets a future
      // reader of `missedSteers` know a steer was genuinely lost, not just
      // that none was ever sent.
      const missedSteers = this.live.get(childId)?.session.drainUnappliedSteers() ?? [];
      let reportPath: string | undefined;
      // Completion-time spill for oversized bodies (external review
      // 2026-08-12): DelegationLedger.update() caps rawReport at
      // RAW_REPORT_CAP_CHARS on EVERY write — for a background run nothing
      // else ever sees the uncapped body again (the child is torn down right
      // below), so the FULL body must be spilled to disk BEFORE that cap
      // silently discards it, not later when a delivery-time formatter might
      // want to read it back. Log-only on failure: a spill failure must not
      // discard the report or fail the run — the ledger still gets the capped
      // copy either way.
      if (this.nativeHome && parentCwd && run.report.length > RAW_REPORT_CAP_CHARS) {
        try {
          reportPath = this.nativeHome.writeSessionArtifact(nativeStoreSlug(parentCwd), path.join(SPECIALIST_REPORT_SPILL_SUBDIR, `${childId}.report.md`), run.report);
        } catch (spillErr) {
          log('ERROR', 'NativeSessionHost', 'failed to spill an oversized specialist report to disk — the ledger copy will be capped', { childId, parentId, error: String(spillErr) });
        }
      }
      if (this.ledger && parentCwd) {
        // Fix (review round 2, Finding 1), preserved: its own try/catch,
        // log-only, never fatal — a bookkeeping failure on the way out must
        // never discard the report or relabel this run a failure.
        //
        // Fix (external review — the clobber race): `missedSteers` used to
        // ride inside this SAME patch as a blind overwrite — but this run's
        // `missedSteers` is drained from the CHILD's own live pendingSteers
        // queue (see the WHY above), a source that never saw a steer
        // steerSpecialist recorded to the ledger directly while this child
        // was between turns. If that recording landed first and this write
        // landed after, `missedSteers: []` here would erase it. append (not
        // overwrite) so this write can only ADD what it genuinely drained,
        // never discard what another writer already recorded.
        //
        // Fix pass 2 (external review — the split-write gap): `update()` and
        // the append USED to be two separate awaited calls, i.e. two
        // independent lock acquisitions. If the first (status) landed and
        // the second (append) then threw, the record was durably 'completed'
        // while this run's own drained steers were silently dropped —
        // log-only below, never retried: a NEW steer-loss mode introduced by
        // the very fix meant to stop steer loss. Passing `missedSteers` as
        // `update()`'s own `appendSteers` argument folds both into ONE
        // mutateJson call (see update()'s own WHY) — they now commit
        // together or, on a lock failure, neither commits, same as before
        // this field existed.
        try {
          await this.ledger.update(parentCwd, parentId, childId, {
            status: 'completed', endedAt: Date.now(), steps: run.steps, rawReport: run.report,
            ...(reportPath ? { reportPath } : {}),
          }, missedSteers);
        } catch (ledgerErr) {
          log('ERROR', 'NativeSessionHost', 'failed to record specialist completion (including any steers missed during this run) in the ledger — the report is still returned to the caller', { childId, parentId, error: String(ledgerErr) });
        }
      }
      return run;
    } catch (err: any) {
      const missedSteers = this.live.get(childId)?.session.drainUnappliedSteers() ?? [];
      if (this.ledger && parentCwd) {
        // Fix (review round 2, Finding 4), preserved: updateIfRunning (not
        // update) — a teardown-driven 'interrupted' write (destroyChildrenOf)
        // may already have landed on this record by the time this catch runs.
        // 'interrupted' names the true cause; this catch's 'failed' is only
        // that cause's symptom, so it must not clobber a record that already
        // reached a terminal status. Own try/catch: a failure here must not
        // replace the real error `err` this catch has to rethrow.
        // Fix pass 2 (external review — the split-write gap), same fix as
        // the success path above: `missedSteers` used to ride a SEPARATE
        // awaited `appendMissedSteers()` call after this one — two lock
        // acquisitions, so a throw on the second silently dropped a steer
        // this run's own catch had just drained, even though the status
        // write right before it had already landed. Passed as
        // `updateIfRunning`'s own `appendSteers` argument, both are now one
        // mutateJson call: they commit together or, on failure, neither
        // does (see updateIfRunning's own WHY for why the append half still
        // isn't gated on `status === 'running'` the way the patch half is).
        try {
          await this.ledger.updateIfRunning(parentCwd, parentId, childId, {
            // Specific and accurate (error-message-standards.md): the real
            // thrown message, never a guessed cause.
            status: 'failed', endedAt: Date.now(), failureText: err?.message ?? String(err),
          }, missedSteers);
        } catch (ledgerErr) {
          log('ERROR', 'NativeSessionHost', 'failed to record specialist failure (including any steers missed during this run) in the ledger', { childId, parentId, error: String(ledgerErr) });
        }
      }
      throw err;
    } finally {
      // Fix 1 (review round 1), preserved: LEAK GUARD. The child is a
      // one-shot worker — its report is the only thing that outlives it (its
      // transcript stays on disk) — so it is torn down on EVERY exit path.
      // SWALLOW-AND-LOG, never rethrow: a throw out of `finally` would either
      // discard a report the child already produced, or bury the real failure
      // reason under a teardown error.
      try {
        await this.destroy(childId);
      } catch (err) {
        log('ERROR', 'NativeSessionHost', 'specialist teardown failed after the run finished', { childId, parentId, error: String(err) });
      }
    }
  }

  /** Mint a specialist child, run it to completion, and return its report
   *  (Task 6's gate + bookkeeping, Task 7's run loop; Task 4 split the run
   *  itself out into runDelegation, shared with the background path below).
   *
   *  The whole foreground delegation flow lives here: createChild mints the
   *  cold-started child (Task 5), runDelegation delivers `opts.prompt` as its
   *  first user turn and returns its last message, and this method wraps that
   *  message with a header + transcript pointer after capping it against the
   *  parent's remaining headroom. The Task tool (tools/task.ts) is what the
   *  MODEL calls; it has already resolved the specialist and reserved the slot
   *  (Task 1, plan 1b: via reserveSpecialist — this method BINDS that
   *  reservation to the real childId once one exists, it does not make one)
   *  before reaching here, and it renders a throw from this method as an
   *  `isError` tool result rather than a dangling call. */
  // Task 14: opts.binding (part of the shared SpecialistSpawnOpts type, see
  // tools/types.ts) is passed straight through to createChild below.
  async spawnSpecialist(parentId: string, opts: SpecialistSpawnOpts): Promise<{ childId: string; report: string }> {
    const { childId, title } = await this.createChild(parentId, opts);
    // Task 1 (plan 1b): the writer lock (if this reservation asked for one)
    // was already SET synchronously by reserveSpecialist, before tools/task.ts
    // ever awaited this call — this just swaps the RESERVED_WRITER placeholder
    // for the real childId now that one exists. Ownership of the RELEASE moved
    // to tools/task.ts's `finally` (services.release(token)); this method no
    // longer sets OR clears the lock itself, only binds it (single owner: the
    // tool reserves, this binds, the tool releases).
    this.bindReservation(opts.token, childId);
    await this.recordDelegationStart(parentId, childId, title, opts, false);
    const run = await this.runDelegation(parentId, childId, title, opts, opts.token);
    // Minor (external review 2026-08-13): deliberately NOT plumbing
    // runDelegation's own reportPath (if it already spilled run.report for
    // exceeding RAW_REPORT_CAP_CHARS, a few lines up its own call stack) in
    // here — when that AND the specialist's much smaller report budget both
    // trip, this writes the identical full body to the identical path a
    // second time. Harmless (deterministic overwrite, same bytes) and the
    // rare case, so left as an accepted inefficiency rather than threading an
    // extra return value through runDelegation for it.
    const { text: report, reportPath } = this.formatSpecialistReport({ parentId, childId, specialist: opts.specialist, title, body: run.report });
    const parentCwd = this.live.get(parentId)?.cwd;
    if (this.ledger && parentCwd) {
      // Task 10: the ledger's reportPath should reflect a truncation-time
      // spill the same way it already reflects runDelegation's own
      // completion-time one — best-effort, log-only: a bookkeeping failure
      // here must never discard the report already produced above.
      if (reportPath) {
        try {
          await this.ledger.update(parentCwd, parentId, childId, { reportPath });
        } catch (ledgerErr) {
          log('ERROR', 'NativeSessionHost', 'failed to record a truncation-time spill path in the ledger — the report is still returned to the caller', { childId, parentId, error: String(ledgerErr) });
        }
      }
      // Foreground delivery IS the tool result returned right below — confirm
      // it through the SAME ledger call the background delivery loop uses
      // (confirmDelivered), rather than leaving a 'completed' row that reads
      // as still-undelivered forever. Own try/catch, log-only: a bookkeeping
      // failure here must never discard the report already produced above.
      try {
        await this.ledger.confirmDelivered(parentCwd, parentId, childId);
      } catch (ledgerErr) {
        log('ERROR', 'NativeSessionHost', 'failed to mark a foreground specialist delivered in the ledger — the report is still returned to the caller', { childId, parentId, error: String(ledgerErr) });
      }
    }
    return { childId, report };
  }

  /** Task 4 — background execution. Mints the child and records its 'running'
   *  ledger row SYNCHRONOUSLY with respect to the caller (both awaited here),
   *  then hands the actual run to runDelegation UN-AWAITED — this method
   *  returns the instant the child exists, not once it finishes.
   *
   *  Ownership of `opts.token` (the reservation) and of driving the run to a
   *  terminal ledger state BOTH transfer to the detached chain below the
   *  moment this method returns successfully: tools/task.ts does NOT release
   *  in its own `finally` on this path (see its own comment) — only a THROWN
   *  launch (this method itself rejecting, before the chain below ever
   *  starts) leaves ownership with the caller, which is exactly the case
   *  recordDelegationStart's own leak guard covers.
   *
   *  The chain below must NEVER produce an unhandled rejection: runDelegation
   *  can reject (a failed run), so both branches of `.then` are mandatory,
   *  not optional. */
  async spawnSpecialistBackground(
    parentId: string, opts: SpecialistSpawnOpts,
  ): Promise<{ childId: string; title: string }> {
    const { childId, title } = await this.createChild(parentId, opts);
    this.bindReservation(opts.token, childId);
    await this.recordDelegationStart(parentId, childId, title, opts, true);
    this.runBackgroundDelegation(parentId, childId, title, opts, opts.token);
    return { childId, title };
  }

  /** The detached run chain shared by spawnSpecialistBackground (a BRAND NEW
   *  child, Task 4) and resumeSpecialist's own `background: true` branch (an
   *  EXISTING child, Task 6) — everything AFTER the child exists and its
   *  ledger row is 'running' is identical between the two: drive the run
   *  un-awaited, read back whether runDelegation's own completion write
   *  landed, stash an in-memory fallback if it didn't, then release the
   *  reservation and kick a delivery pass either way. Fire-and-forget by
   *  design (the caller has already returned its launch ack by the time this
   *  chain settles) — see spawnSpecialistBackground's own class-level WHY for
   *  why the chain below must never produce an unhandled rejection. */
  private runBackgroundDelegation(
    parentId: string, childId: string, title: string, opts: SpecialistSpawnOpts, reservation: SpecialistReservation,
  ): void {
    // Captured HERE, synchronously, while the parent session is known live —
    // by the time the handlers below run (after the child's whole turn has
    // played out), the parent may have gone idle, ended its own turn, or even
    // been torn down, so `this.live.get(parentId)` is no longer a reliable
    // source for the cwd its ledger record lives under (Task 4 fix-pass,
    // finding 2).
    const parentCwd = this.live.get(parentId)?.cwd;
    // The specialist's own static fields, captured HERE (not read back from
    // the ledger later) — everything the eventual fallback record needs
    // besides the run outcome itself is already in scope as plain local
    // variables, so no extra read is needed to build one.
    const startedAt = Date.now();
    void this.runDelegation(parentId, childId, title, opts, reservation)
      .then(
        async (run) => {
          // runDelegation's own completion write happens INSIDE its own
          // try/catch and is log-only on failure — correct for the
          // FOREGROUND caller (spawnSpecialist), which still has `run` in
          // hand and returns it to its caller regardless of whether that
          // write landed. The background path has no return value to fall
          // back on, so it must independently learn whether the write
          // actually landed.
          //
          // Fix pass 2 (re-review 2026-08-13): fix pass 1 answered this with
          // a SECOND write (ledger.updateIfRunning) fired synchronously right
          // after the first failed — rejected, because both methods bottom
          // out in the same NativeHome.mutateJson call against the same
          // file, so a systemic cause reproduces on the retry identically.
          // Instead: READ BACK the record we just tried to write. If it's
          // still 'running', the write never landed — no further attempt is
          // made against the same broken store; the report the child
          // actually produced is stashed in the in-memory fallback lane
          // instead, so the delivery loop below can still get it to the
          // parent THIS session (see the field's own WHY for what that
          // does/doesn't guarantee).
          if (this.ledger && parentCwd) {
            const stillRunning = this.ledger.listFor(parentCwd, parentId)
              .find((d) => d.childId === childId)?.status === 'running';
            if (stillRunning) {
              this.stashFallbackIfParentAlive(parentId, childId, {
                childId, parentToolCallId: opts.parentToolCallId, agentType: opts.specialist.id, title,
                workDir: opts.workDir, description: opts.description, background: true,
                status: 'completed', startedAt, endedAt: Date.now(), steps: run.steps, rawReport: run.report,
                delivered: false, owner: OWNER, missedSteers: [],
              });
            }
          }
        },
        (err: any) => {
          // runDelegation's own catch already attempted a 'failed' write
          // (updateIfRunning, log-only on failure) before rethrowing this
          // same error. Same read-back-then-fallback shape as the success
          // branch above, for the identical reason: a record stuck at
          // 'running' is never claimed, so the parent would never even learn
          // its specialist died.
          log('ERROR', 'NativeSessionHost', 'background specialist run failed', { childId, parentId, error: String(err?.message ?? err) });
          if (this.ledger && parentCwd) {
            const stillRunning = this.ledger.listFor(parentCwd, parentId)
              .find((d) => d.childId === childId)?.status === 'running';
            if (stillRunning) {
              this.stashFallbackIfParentAlive(parentId, childId, {
                childId, parentToolCallId: opts.parentToolCallId, agentType: opts.specialist.id, title,
                workDir: opts.workDir, description: opts.description, background: true,
                status: 'failed', startedAt, endedAt: Date.now(), failureText: err?.message ?? String(err),
                delivered: false, owner: OWNER, missedSteers: [],
              });
            }
          }
        },
      )
      .finally(() => {
        // Belt-and-suspenders against an unhandled-rejection risk: a
        // `.finally` callback that itself throws makes the chain's OWN
        // resulting promise reject, and nothing downstream awaits or catches
        // it (this whole chain is `void`-fired). Neither call is expected to
        // throw (both are synchronous Map/Set bookkeeping), but "not
        // expected to" is exactly the standard this method exists to raise
        // past — see the class-level WHY on this same chain. Both branches
        // above already catch their own ledger-write failures internally, so
        // this chain's overall promise cannot reject on their account either.
        try { this.releaseReservation(reservation); } catch (err) {
          log('ERROR', 'NativeSessionHost', 'failed to release a background specialist reservation', { childId, parentId, error: String(err) });
        }
        try { this.queueDelivery(parentId); } catch (err) {
          log('ERROR', 'NativeSessionHost', 'failed to queue a background specialist delivery', { childId, parentId, error: String(err) });
        }
      });
  }

  /** Task 4 — mark `parentId` as having a background report waiting, and kick
   *  a delivery pass immediately if the parent is ALREADY idle (nothing else
   *  is going to reach runTurns' own post-drain tail on its own in that case).
   *  When the parent is mid-turn, this only records the pending flag — that
   *  same tail (reached from the real, in-flight turn once it finishes) is
   *  what actually drains it; delivery happens ONLY at an idle boundary,
   *  never spliced mid-turn (role alternation + the local prompt cache both
   *  depend on it).
   *
   *  `entry.inFlight = true` claims the idle slot SYNCHRONOUSLY, in the same
   *  tick as the isIdle() check — mirroring send()'s own dispatch — so a
   *  send() racing in right after this call queues behind the delivery pass
   *  instead of racing HarnessSession's turn re-entrancy guard. The
   *  dispatched "first" turn is a no-op: it exists only to get INTO runTurns
   *  from an idle start — runTurns' own tail (the SAME delivery-loop code a
   *  real turn reaches too) is what actually injects the report(s). */
  private queueDelivery(parentId: string): void {
    this.pendingDeliveryParents.add(parentId);
    this.kickIdleDeliveryPass(parentId);
  }

  /** Shared by queueDelivery (the ledger lane) and queueHostNotice (Task 8's
   *  plain-notice lane, below): if the parent is ALREADY idle, nothing else
   *  is going to reach runTurns' own post-drain tail on its own, so dispatch
   *  a no-op "first" turn just to get INTO runTurns from an idle start —
   *  drainDeliveries (runTurns' own tail) is what actually injects whatever
   *  is now pending, and drains BOTH lanes in one pass regardless of which
   *  one triggered the kick. */
  private kickIdleDeliveryPass(parentId: string): void {
    const entry = this.live.get(parentId);
    if (!entry || !this.isIdle(parentId)) return;
    // Held after Stop (see LiveEntry.holdDeliveries): the report stays queued
    // and rides in with the user's next message instead of waking the model.
    if (entry.holdDeliveries) return;
    entry.inFlight = true;
    entry.running = new Promise<void>((resolve) => {
      setImmediate(() => { void this.runTurns(parentId, entry, IDLE_PASS).then(resolve, resolve); });
    });
  }

  /** Plan 1b Task 8 — queue a plain-text notice for `parentId`, delivered the
   *  same way a background completion is (see pendingHostNotices' own WHY).
   *  Guarded on parent liveness the same way stashFallbackIfParentAlive is:
   *  a torn-down parent can never come back to read this, so there is
   *  nothing to gain by holding it in memory forever — log it as
   *  undeliverable instead of silently leaking. */
  private queueHostNotice(
    parentId: string,
    text: string,
    meta?: InjectedMeta,
    // Why a caller-supplied message: this lane now carries shell completions
    // too, and "a late permission answer arrived" printed about a finished
    // build would be a false log line (review I5).
    whyDropped = 'a late permission answer arrived after its parent session was already destroyed — the notice has nowhere left to be delivered',
  ): void {
    if (!this.live.has(parentId)) {
      log('WARN', 'NativeSessionHost', whyDropped, { parentId });
      return;
    }
    const arr = this.pendingHostNotices.get(parentId) ?? [];
    arr.push({ text, meta });
    this.pendingHostNotices.set(parentId, arr);
    this.kickIdleDeliveryPass(parentId);
  }

  /** G-1: the registry for a session id — created on first use, kept across
   *  destroy({keepShells}) so a taken-over conversation's runs stay owned. */
  private shellsFor(sessionId: string): ShellRegistry {
    const existing = this.shellRegistries.get(sessionId);
    if (existing) return existing;
    const registry = new ShellRegistry(sessionId);
    // One event per change, straight to ipc-handlers' listener (same shape as
    // 'specialists-event'): sendForSession + remote buffer/broadcast live there.
    registry.on('change', (run: ShellRunView) => this.emit('shell-event', { sessionId, run } satisfies ShellEvent));
    registry.on('exit', (run: ShellRun) => this.onShellExit(sessionId, registry, run));
    this.shellRegistries.set(sessionId, registry);
    return registry;
  }

  /** G-1 (spec §4.4): a finished run becomes a notice at the next idle
   *  boundary. KillShell's own result is its notice (no second one);
   *  'conversation-closed' and 'app-quit' have no session left to tell. A
   *  user Stop IS reported — the model must learn its server is gone. */
  private onShellExit(sessionId: string, registry: ShellRegistry, run: ShellRun): void {
    if (run.reported) return;
    if (run.stopReason && run.stopReason !== 'user') return;
    run.reported = true;
    this.queueHostNotice(
      sessionId,
      formatFinishedNotice(run, registry.tailText(run, NOTICE_TAIL_LINES)),
      { kind: 'shell', runs: [{ shellId: run.shellId, toolUseId: run.toolUseId, exitCode: run.exitCode, stopReason: run.stopReason, elapsedMs: (run.endedAt ?? Date.now()) - run.startedAt, logPath: run.logPath }] },
      'a background command finished after its conversation was closed — the notice has nowhere left to be delivered',
    );
  }

  /** G-1: the card's Stop button (native:kill-shell). Not gated on a live
   *  session's turn state — a run outlives turns by design. */
  async killShell(sessionId: string, shellId: string): Promise<{ ok: true } | { ok: false; reason: 'not-live' | 'unknown-shell' | 'not-running' }> {
    const reg = this.shellRegistries.get(sessionId);
    if (!reg || !this.live.has(sessionId)) return { ok: false, reason: 'not-live' };
    const run = reg.get(shellId);
    if (!run) return { ok: false, reason: 'unknown-shell' };
    if (run.status !== 'running') return { ok: false, reason: 'not-running' };
    await reg.kill(shellId, 'user');
    return { ok: true };
  }

  /** G-1: every run record for a live session, for TRANSCRIPT_REPLAY — the
   *  transcript itself says nothing about a run's current state (same reason
   *  specialistRunsFor exists). */
  shellRunsFor(sessionId: string): ShellRunView[] {
    const reg = this.shellRegistries.get(sessionId);
    if (!reg || !this.live.has(sessionId)) return [];
    return reg.list().map((r) => reg.toView(r));
  }

  /** Plan 1b Task 8 — the ONE handler for a real response that arrives after
   *  its routed ask already timed out (wired to the broker in the
   *  constructor). Two cases, both honest about what "the entry stays
   *  answerable" actually delivers:
   *   - the child that raised the ask is STILL LIVE (it took the redirect and
   *     kept working, hasn't finished yet) → course-correct it directly with
   *     postSteer, naming the tool and the real decision. A `false` return
   *     (no turn in flight right this instant) is fine to ignore, same
   *     reasoning as the compaction steer above: the next turn-loop iteration
   *     boundary drains it, and if there never is one the child is about to
   *     end anyway with nothing left for a steer to change.
   *   - the child has ALREADY ended (destroy() already ran — runDelegation's
   *     finally tears every child down on every exit path) → there is no
   *     session left to steer, so the answer reaches the PARENT instead, via
   *     the same idle-boundary delivery path Task 4 built for background
   *     completions (queueHostNotice). On an approval, the decision is also
   *     recorded into childApprovedAsks — see that field's own WHY for what
   *     this does and does not wire up yet. */
  private onLateResponse(entry: LateResponseEntry, decision: AskDecision): void {
    const allowed = decision.behavior === 'allow';
    const childId = entry.raisedBy;

    // Task 11 fix pass (Finding 2): a LATE "Always allow" used to silently
    // drop the "and remember this" half — this handler only ever steered the
    // still-live child or notified the parent, never persisted anything,
    // even though decision.always rides the same AskDecision the in-time path
    // (child-ask-router.ts) reads. This handler is reached ONLY for a routed
    // (specialist) ask: a root session's own askUser is wired straight to
    // `this.broker.ask(req)` with no `opts.timeoutMs` (see the `askUser:
    // (req) => this.broker.ask(req)` root wiring below), so a root ask's
    // PendingAsk.timedOut never flips true and it never reaches
    // lateResponseHandler at all — only createChild's childAskRouter wiring
    // passes a timeout. So `entry.specialist` is always set here in
    // production; the `undefined` guard below is belt-and-suspenders for a
    // hand-built test entry, not a real production path. Persisted against
    // `entry.sessionId`, which childAskRouter already rewrote to the PARENT's
    // id before ever calling broker.ask() (see AskRequest.raisedBy's own
    // comment) — the same session/cwd pair the in-time path writes against.
    // The doom_loop synthetic budget ask never supports "Always allow" even
    // for a root session (child-ask-router.ts's BUDGET_ASK_TOOL_NAMES) —
    // excluded here for the same reason the in-time path excludes it.
    //
    // Fix (Important 6, final review): same fix as child-ask-router.ts's
    // in-time path, applied to the LATE path — this used to hand-build
    // `{tool, pattern: subject, action:'allow'}` itself instead of calling
    // the shared rememberedRuleFor() builder, discarding the grant WIDTH the
    // user picked (decision.grantScope) and skipping the builder's own
    // "never rememberable" cases. See child-ask-router.ts's own comment on
    // its now-identical call for the full reasoning; both sites must derive
    // the rule the SAME way or a late answer and an in-time answer to the
    // identical ask could persist two different rules.
    if (allowed && decision.always && entry.specialist && !BUDGET_ASK_TOOL_NAMES.has(entry.toolName)) {
      const parent = this.live.get(entry.sessionId);
      if (parent) {
        const rule = rememberedRuleFor(entry.toolName, entry.subject, decision.grantScope);
        if (rule) this.rememberRule(entry.sessionId, parent.cwd, { ...rule, specialist: entry.specialist.agentType });
      } else {
        // The parent session was torn down before the late answer arrived —
        // there is no live cwd left to persist against (the store is keyed by
        // project, not sessionId). Same accepted loss as queueHostNotice's own
        // WARN below: nothing durable was ever promised once the parent is gone.
        log('WARN', 'NativeSessionHost', 'a late "Always allow" arrived after its parent session was already destroyed — the rule could not be persisted', { sessionId: entry.sessionId, toolName: entry.toolName });
      }
    }

    if (childId && this.live.has(childId)) {
      this.live.get(childId)!.session.postSteer(
        `The user has now responded to your earlier blocked request (${entry.toolName}): ${allowed ? 'APPROVED — you may do it now.' : 'DENIED — do not attempt it.'}`,
      );
      return;
    }
    const title = entry.specialist?.title ?? entry.toolName;
    const idForNotice = entry.specialist?.childId ?? childId ?? 'unknown';
    this.queueHostNotice(
      entry.sessionId,
      `[Specialist follow-up] The user ${allowed ? 'approved' : 'denied'} ${title}'s blocked ${entry.toolName} request after the specialist finished. Use task_id ${idForNotice} to continue that work if needed.`,
    );
    if (allowed && childId) {
      const grants = this.childApprovedAsks.get(childId) ?? [];
      grants.push({ tool: entry.toolName });
      this.childApprovedAsks.set(childId, grants);
    }
  }

  /** Task 4 — format one claimed ledger record into the text runNotice()
   *  injects. Success wraps formatSpecialistReport (now concurrency-aware)
   *  with a preamble that reminds the parent what it delegated; failure is a
   *  short, typed notice built from the ledger's own failureText — never a
   *  guessed cause (error-message-standards.md). `concurrentReporters` is
   *  computed ONCE by the caller for the whole delivery pass (see runTurns),
   *  not per-record, because every report drained in the SAME pass is
   *  competing for the same slice of the parent's headroom regardless of
   *  delivery order within the pass. Returns `reportPath` alongside the text
   *  (Task 10) so the caller can persist a NEWLY-created truncation-time spill
   *  to the ledger — a failed/missing-specialist body has none to give.
   *
   *  `cwd` (Task 4, plan 1c): the LIVE parent entry's cwd, passed by the
   *  caller rather than re-derived here — resolves rec.agentType against the
   *  parent's OWN per-cwd roster (a project's specialists folders live at
   *  its cwd, not at some default), instead of the bare built-in lookup. */
  private formatDelivery(sessionId: string, cwd: string, rec: DelegationRecord, concurrentReporters: number): { text: string; reportPath?: string } {
    if (rec.status === 'failed') {
      return { text: `[Background specialist failed] ${rec.title} (${rec.agentType}): ${rec.failureText ?? 'unknown error'}. Partial transcript: specialist session ${rec.childId}.` };
    }
    const minutesAgo = Math.max(0, Math.round((Date.now() - rec.startedAt) / 60000));
    const preamble = `[Background specialist finished] ${rec.title} (${rec.agentType}) completed the task you delegated ("${rec.description}", started ${minutesAgo}m ago, ${rec.steps ?? 0} steps).\n\n`;
    const specialist = this.specialistCatalog.roster(cwd).resolve(rec.agentType);
    // Fix (Task 4 fix-pass, finding 1): rec.rawReport is the copy that rode in
    // the ledger file, already capped at RAW_REPORT_CAP_CHARS by
    // DelegationLedger.update() on every write — formatting from it alone
    // would understate the report's true size in formatSpecialistReport's own
    // truncation notice for anything the completion handler had to spill to
    // disk. When a spill file exists, read the FULL body back from disk so
    // that notice's totals are accurate; fall back to the capped ledger copy
    // only if the spill file itself can't be read (e.g. deleted out from
    // under us) — a missing spill file must never fail delivery outright.
    const spilledBody = rec.reportPath ? this.nativeHome?.readSessionArtifact(rec.reportPath) : undefined;
    const readSucceeded = typeof spilledBody === 'string';
    const rawBody = readSucceeded ? spilledBody : (rec.rawReport ?? '');
    if (!specialist) return { text: preamble + rawBody };
    // Critical fix pass 1 (external review 2026-08-13): reportPath is reused
    // ONLY when the read two lines up actually just proved the file is still
    // there — passing rec.reportPath through unconditionally (as before pass
    // 1) made formatSpecialistReport treat it as truthy and skip its own
    // write-guard, so a spill file deleted out from under us still got named
    // in the footer as "Full report saved to: <path>".
    //
    // Critical fix pass 2 (2026-08-13): pass 1 stopped there, but its OWN fix
    // still lied — when the read fails, `rawBody` above falls back to
    // `rec.rawReport`, the ledger's copy that DelegationLedger.update() caps
    // at RAW_REPORT_CAP_CHARS on every write. That capped copy is not the
    // full report. Passing it as `body` with `reportPath: undefined` sent it
    // into formatSpecialistReport's ordinary "no path yet, please spill"
    // branch, which dutifully wrote the CAPPED copy to the exact filename
    // the real full body might still legitimately live at — clobbering a
    // possibly-recoverable file with a strictly worse one, and then naming
    // that same path as "Full report saved to" once the overwrite succeeded.
    // `bodyIsFull` tells formatSpecialistReport the truth about what `body`
    // actually is: full (`readSucceeded`, real disk content) or, when there
    // was never a completion-time spill at all (`!rec.reportPath`), the
    // ledger copy that in that case genuinely IS the whole report because it
    // was never capped in the first place. Any other case (read failed AND a
    // spill path exists in the ledger) is neither — reportPath stays
    // undefined AND bodyIsFull stays false, so formatSpecialistReport must
    // neither reuse a path it can't prove is current NOR write a lesser body
    // over one that might still be.
    const bodyIsFull = readSucceeded || !rec.reportPath;
    const spilled = this.formatSpecialistReport({
      parentId: sessionId, childId: rec.childId, specialist, title: rec.title, body: rawBody, concurrentReporters,
      reportPath: readSucceeded ? rec.reportPath : undefined,
      bodyIsFull,
    });
    return { text: preamble + spilled.text, reportPath: spilled.reportPath };
  }

  /** Drive ONE specialist child to completion and return its last message.
   *
   *  Failure detection is EVENT-based, not promise-based: the child's turn
   *  drain (`entry.running`) never rejects — runTurns try/catches its send()
   *  (see send()) — so awaiting it only tells us the turn SETTLED, never
   *  whether it succeeded. The transcript stream is what says which: a
   *  `session-error` means the provider/stream failed, while `user-interrupt`
   *  means the user (or a parent teardown) stopped it.
   *
   *  Throws (typed, with the child id) on every no-report outcome; the Task
   *  tool renders that as an isError result for the parent model to read. */
  private async runSpecialist(childId: string, prompt: string): Promise<SpecialistRunResult> {
    const entry = this.live.get(childId);
    if (!entry) throw new Error(`the specialist session ${childId} was gone before its work could start.`);

    // Fix (review): parentId and parentCwd used to be passed in as two extra
    // parameters from spawnSpecialist, duplicating data createChild already
    // stamped onto this child's own live entry — a future second call site
    // could pass either out of sync with what's actually on `entry`. Both are
    // derived here instead: parentSessionId is set unconditionally by
    // createChild for every specialist child, and parentCwd is the one-hop
    // lookup spawnSpecialist itself does (this.live.get(parentId)?.cwd) — NOT
    // entry.cwd, which is this CHILD's own workDir, not its parent's.
    const parentId = entry.parentSessionId;
    const parentCwd = parentId ? this.live.get(parentId)?.cwd : undefined;

    // ---- Task 7 (plan 1b, spec §3): heartbeat staleness, flags-never-kills --
    // Liveness is heartbeat-based, not wall-clock: a slow local model doing a
    // long prefill emits text-less `assistant-thinking` heartbeats that count
    // as activity below (session-store.ts drops them from disk, but the
    // emitter still fires), so it is never flagged. `stale` only ever informs
    // the Task 5 status block and the ledger — nothing here aborts,
    // interrupts, or fails the child; the user's interrupt and the model's own
    // `interrupt: true` (Task 6) are the only things that ever end a run.
    let lastActivityAt = Date.now();
    const openTools = new Set<string>();      // toolUseIds with no tool-result yet
    let isStale = false;                      // mirrors the ledger's `stale` field
    const setStale = (next: boolean) => {
      if (isStale === next) return;           // write ONLY on transitions — not every poll tick
      isStale = next;
      if (this.ledger && parentCwd && parentId) {
        // Fire-and-forget, same log-only/never-fatal contract every other
        // ledger write in this method follows: a bookkeeping failure must
        // never disturb a run that is otherwise healthy. updateIfRunning (not
        // update) so a flag can't resurrect/overwrite a record that already
        // reached a terminal status (interrupted/failed/completed) elsewhere.
        // parentId's `&&` check here is belt-and-suspenders for the type
        // checker (entry.parentSessionId is optional on LiveEntry) — createChild
        // always sets it for a specialist child, so this method is only ever
        // reached with both defined.
        this.ledger.updateIfRunning(parentCwd, parentId, childId, { stale: next }).catch((err) => {
          log('ERROR', 'NativeSessionHost', 'failed to record specialist staleness in the ledger', { childId, parentId, error: String(err) });
        });
      }
    };
    const staleCheck = setInterval(() => {
      const threshold = openTools.size > 0 ? SPECIALIST_IN_TOOL_STALE_MS : SPECIALIST_IDLE_STALE_MS;
      if (Date.now() - lastActivityAt >= threshold) setStale(true);
    }, STALE_CHECK_INTERVAL_MS);

    // ---- Observation state, written by the listener below ----
    let errorText: string | null = null;      // a session-error ended a turn
    let interrupted = false;                  // Stop / parent teardown reached the child
    // Assistant text since the last tool-use. Text emitted BEFORE a tool call
    // is narration ("let me check X"), not the report — the report is whatever
    // the child says after its final tool call, so a tool-use resets this.
    let sinceLastTool = '';
    let steps = 0;
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    // Task 12, item 4 — compaction-finalize: counts SPONTANEOUS auto-compactions
    // (data.autoCompaction, harness-session.ts's maybeCompact) during this run.
    // A small local context window can force more than one across a long
    // delegated task (spec §3: a designed path, not an edge case) — on the
    // SECOND one, tell the child to wrap up rather than let it compact its way
    // through the whole window and still never report. `steered` caps this at
    // once per child even if a third compaction fires later in the same run.
    let autoCompactionCount = 0;
    let steered = false;

    const onEvent = (event: TranscriptEvent) => {
      // Task 7: ANY event is activity — including a text-less
      // assistant-thinking heartbeat, which is exactly what keeps a slow
      // local prefill from ever being flagged stale. Also the transition
      // point that unflags a child that WAS stale: its next event, whatever
      // type, proves it is alive again.
      lastActivityAt = Date.now();
      setStale(false);
      switch (event.type) {
        case 'assistant-text':
          sinceLastTool += String(event.data.text ?? '');
          break;
        case 'tool-use':
          if (event.data.toolUseId) openTools.add(event.data.toolUseId);
          steps += 1;
          sinceLastTool = '';
          break;
        case 'tool-result':
          // Task 7: closes the window the in-tool (longer) threshold covers —
          // once every open call has its result, silence reverts to the
          // shorter idle threshold. Everything else about this event type
          // (persisting the result) is handled elsewhere; the listener only
          // cares about the tool remaining "open" for staleness purposes.
          if (event.data.toolUseId) openTools.delete(event.data.toolUseId);
          break;
        case 'turn-complete': {
          const u = event.data.usage;
          if (u) {
            usage.inputTokens += u.inputTokens; usage.outputTokens += u.outputTokens;
            usage.cacheReadTokens += u.cacheReadTokens; usage.cacheCreationTokens += u.cacheCreationTokens;
          }
          break;
        }
        case 'session-error':
          errorText = String(event.data.text ?? '').trim() || null;
          break;
        case 'user-interrupt':
          interrupted = true;
          break;
        case 'compact-summary':
          if (event.data.autoCompaction) {
            autoCompactionCount += 1;
            if (autoCompactionCount === 2 && !steered) {
              steered = true;
              // Injection is a MESSAGE, never a prompt edit — postSteer (Task 3)
              // queues this as a <steer> user-role history entry drained at the
              // next turn-loop iteration boundary, same as any other course
              // correction. A false return (no turn in flight) is fine to
              // ignore here: the child's turn just ended on its own, in which
              // case there is nothing left for a steer to interrupt.
              entry.session.postSteer(
                'You are running low on room even after summarizing. Stop new exploration — '
                + 'write up what you have and finish with your report now.',
              );
            }
          }
          break;
        default:
          break;   // every other type is persistence-only for this purpose
      }
    };
    entry.session.on('transcript-event', onEvent);

    /** Run one turn and wait for its whole drain to settle. */
    const runTurn = async (text: string): Promise<void> => {
      sinceLastTool = '';
      const res = this.send(childId, text);
      // send() only refuses for reasons that cannot apply to a freshly-minted,
      // idle child (not live / queue full) — so this is a wiring bug, not a
      // model outcome, and it says exactly which refusal happened.
      if (res.status !== 'sent') throw new Error(`the specialist session ${childId} refused its turn (${res.status}${'reason' in res && res.reason ? `: ${res.reason}` : ''}).`);
      await entry.running;
    };

    /** The report this turn produced, or null when the child said nothing. */
    const reportSoFar = (): string | null => sinceLastTool.trim() || null;

    /** Turn the run's terminal conditions into a typed throw. Checked after
     *  EVERY turn, because the nudge turn can fail the same ways the first one
     *  can. */
    const throwIfEnded = (): void => {
      if (errorText) throw new Error(`${errorText} (specialist session ${childId})`);
      if (interrupted) throw new Error(`the specialist was stopped before it could report (specialist session ${childId}).`);
      // The parent was destroyed / quiesced mid-run, which cascade-destroys its
      // children — there is no session left to nudge or read from.
      if (!this.live.has(childId)) throw new Error(`the specialist session ${childId} was torn down before it could report.`);
    };

    try {
      await runTurn(prompt);
      throwIfEnded();

      let report = reportSoFar();
      if (report === null) {
        // ONE nudge, then accept or fail (retry budget 1, spec §3).
        await runTurn(EMPTY_REPORT_NUDGE);
        throwIfEnded();
        report = reportSoFar();
      }
      if (report === null) {
        throw new Error(`the specialist finished without producing a report — no final message, even after one reminder (specialist session ${childId}).`);
      }
      // +1 for the step that produced the final message (see SpecialistRunResult).
      return { report, steps: steps + 1, usage };
    } finally {
      // Detach BEFORE the caller tears the session down, so this listener can
      // never observe teardown-time events (and so a run that throws does not
      // leave a listener attached to a session the caller may keep alive).
      entry.session.off('transcript-event', onEvent);
      // Task 7: cleared on EVERY exit path (success, throw, or nudge) — a
      // leaked interval per child would keep the process awake and pile up
      // across every specialist ever spawned.
      clearInterval(staleCheck);
    }
  }

  /** Wrap a child's last message as the tool result the parent model reads.
   *
   *  Three jobs: say WHO reported (the parent asked for a specialist, not for
   *  an anonymous blob of text), cap the body against what the parent can still
   *  afford, and point somewhere real for anything that got cut. 1a's footer
   *  named the child's own session id — nothing in this harness can Read a
   *  transcript by session id, so a model told to "read" it hit a dead end.
   *  Task 10 (plan 1b) fixes that: when the cap truncates the body, the FULL
   *  text is spilled to sessions/<slug>/specialist-reports/<childId>.report.md
   *  (NativeHome.writeSessionArtifact, narrowed to this subdirectory — see
   *  SPECIALIST_REPORT_SPILL_SUBDIR's own WHY — by Important 5, final review)
   *  and the footer names that real,
   *  Readable path instead (internalReadRoots, wired by toolWiring below, is
   *  what lets the parent actually open it without an external_directory
   *  ask). The untruncated case still needs SOME pointer for 1c's card
   *  linking, so it keeps a short `[specialist session <id>]` tag.
   *
   *  Critical fix pass 2 (2026-08-13): `body` is not always the full report —
   *  formatDelivery can hand this a ledger's CAPPED copy when the real spill
   *  file can no longer be read (see `bodyIsFull` below). This method must
   *  never write that lesser copy to the spill path (it could overwrite a
   *  still-good full file there) and must never claim in the footer that a
   *  path holds the full report when it does not know that to be true. */
  private formatSpecialistReport(i: {
    parentId: string; childId: string; specialist: SpecialistDefinition; title: string; body: string;
    // Task 4: how many reports are landing in this parent TOGETHER — defaults
    // to 1 (1a's foreground assumption: the parent is blocked on exactly one
    // child). The background delivery loop (formatDelivery) passes the real
    // pending count so simultaneous reports split the parent's headroom
    // instead of each claiming the full single-reporter share.
    concurrentReporters?: number;
    // Task 10: a spill path the CALLER already knows is READABLE right now —
    // formatDelivery passes rec.reportPath only when it just confirmed (via
    // readSessionArtifact) that Task 4's completion-time spill is still on
    // disk. Reusing it means this method never writes the identical bytes to
    // the identical path a second time. Absent for the foreground path, for
    // any background report the completion handler never had to spill, AND
    // for a background report whose spill file WAS written but is gone by
    // delivery time — in that case the caller deliberately omits it so this
    // method does not blindly name a path it just failed to read.
    reportPath?: string;
    // Critical fix pass 2 (2026-08-13): is `body` actually the WHOLE report,
    // or a lesser stand-in (the ledger's RAW_REPORT_CAP_CHARS-capped copy,
    // substituted by formatDelivery when the real spill file couldn't be
    // read)? Defaults to true — every OTHER caller (the foreground path, and
    // background delivery whenever no completion-time spill ever happened)
    // really does hand over the complete body. When false, this method must
    // neither write `body` to the spill path (it would overwrite a
    // possibly-still-good full file with a worse copy) nor claim in the
    // footer that any path holds the full report — see the honest-shortfall
    // branch below.
    bodyIsFull?: boolean;
  }): { text: string; reportPath?: string } {
    const parent = this.live.get(i.parentId)?.session;
    const window = parent?.contextWindowTokens ?? null;
    const used = parent?.contextUsedTokens ?? null;
    // Infinity = "we cannot measure the parent's occupancy" (a parent that has
    // not completed a step, or a provider that reports no usage). That degrades
    // to the definition's static cap — see computeReportBudget.
    const remaining = window != null && used != null ? window - used : Infinity;
    const budgetTokens = computeReportBudget({
      staticCapTokens: i.specialist.reportBudgetTokens,
      parentRemainingTokens: remaining,
      concurrentReporters: i.concurrentReporters ?? 1,
    });
    const cut = truncateOutput(i.body, { maxChars: budgetTokens * APPROX_CHARS_PER_TOKEN });
    // Same notice vocabulary every other capped tool result uses, so a cut
    // report reads like a cut Bash/Grep result rather than a new dialect. The
    // hint has to be in the PARENT's vocabulary — it cannot re-read this child
    // (the session is torn down), so the advice is about the next delegation.
    const notice = cut.truncated
      ? composeNotice(undefined, { shown: cut.text.length, total: cut.totalChars },
        'delegate a narrower piece of work, or ask for a shorter report')
      : '';
    let reportPath = i.reportPath;
    let footer: string;
    // Critical fix pass 2 (2026-08-13): only attempt a spill when `body` is
    // actually the full report. Writing a lesser (capped) body to the spill
    // path would silently downgrade whatever was already there — the exact
    // data-loss bug this pass fixes (see the class doc comment above and
    // formatDelivery's caller comment).
    const bodyIsFull = i.bodyIsFull ?? true;
    if (cut.truncated) {
      if (!reportPath && bodyIsFull) {
        const parentCwd = this.live.get(i.parentId)?.cwd;
        if (this.nativeHome && parentCwd) {
          try {
            reportPath = this.nativeHome.writeSessionArtifact(nativeStoreSlug(parentCwd), path.join(SPECIALIST_REPORT_SPILL_SUBDIR, `${i.childId}.report.md`), i.body);
          } catch (err) {
            // Fix: a spill failure must degrade gracefully — the parent still
            // gets the truncated text above, and the footer below must NEVER
            // claim a file exists that isn't actually there
            // (error-message-standards.md: no misleading claims).
            log('ERROR', 'NativeSessionHost', 'failed to spill a truncated specialist report to disk — the footer will not name a file', { childId: i.childId, parentId: i.parentId, error: String(err) });
          }
        }
      }
      if (reportPath) {
        footer = `[Truncated to fit. Full report saved to: ${reportPath} — Read it if you need the rest.]`;
      } else if (!bodyIsFull) {
        // Honest-shortfall branch (critical fix pass 2): the true full body
        // is gone (a completion-time spill existed but couldn't be read back)
        // and `body` here is only the ledger's capped copy. No write was
        // attempted — see the `bodyIsFull` guard above — so there is no path
        // to name. General-but-non-committal per error-message-standards.md:
        // say plainly that the rest is unrecoverable, without naming a file
        // or guessing why the read failed.
        footer = '[Truncated to fit. The full report is no longer available; this is a shortened copy and the rest cannot be retrieved.]';
      } else {
        footer = '[Truncated to fit. The full report could not be saved to disk.]';
      }
    } else {
      // 1c's card linking reads this short tag for the child's session id —
      // deliberately NOT "full transcript:" wording, since nothing here can
      // actually open a transcript by session id (that phrasing is now
      // reserved for the truncated branch's real, Readable path above).
      footer = `[specialist session ${i.childId}]`;
    }
    // Task 8: the header uses the child's assigned (fun) title, not the bare
    // displayName — the role id stays alongside it either way, so the parent
    // can always tell WHICH kind of specialist answered even though the name
    // is per-run.
    return {
      text: `## Report from ${i.title} (${i.specialist.id})\n\n${cut.text}${notice}\n\n${footer}`,
      reportPath,
    };
  }

  // Per-session resolved preset id (POST legacy-mapping, e.g. a stored 'chat'
  // header resolves to 'assistant' here). Drives the renderer's preset chip and
  // is the read-side answer to "what personality is this session running as".
  private presetIdFor = new Map<string, string>();   // resolved (post-legacy-mapping) preset id

  /** This session's current permission mode (default 'ask' when not seeded). */
  getPermissionMode(sessionId: string): NativePermissionMode { return this.modeFor.get(sessionId) ?? 'ask'; }
  /** This session's resolved preset id (null if not live). */
  getHarnessId(sessionId: string): string | null { return this.presetIdFor.get(sessionId) ?? null; }

  constructor(
    private store: SessionStore,
    private modelFactory: ModelFactory,
    // Fix pass 2 (Task 13): ONE closure now answers both the context window
    // AND the engine's real parallel-slot count, from ONE call. Before this,
    // contextLengthFor and a separate slotCountFor closure shared one /props
    // reading through a variable scoped at the ipc-handlers.ts wiring site
    // (`lastLocalSlotReading`) — correct only if every caller awaited the two
    // closures back-to-back for the SAME binding with nothing else able to
    // run in between. Two local-engine sessions starting concurrently (or a
    // cloud binding's resolution landing between the two awaits, which resets
    // the shared variable to null) could silently read each other's slot
    // count, or read null instead of a real number — with no throw, just a
    // wrong cap. Collapsing to one return value removes the shared state
    // entirely: there is no ordering left to get wrong.
    private contextAndSlotsFor: (binding: ModelBinding) => Promise<{ contextLength: number | null; totalSlots: number | null }>,
    // Resolves a binding's provider TYPE (local-engine / openrouter / anthropic /
    // …) so the host can pick the right CapabilityProfile (Task 5). A binding
    // whose provider is unknown returns null → resolveContextAndProfile falls back
    // to a cloud-safe default. Positioned right after contextAndSlotsFor because
    // the two are resolved together for every create/resume/swap.
    private providerTypeFor: (binding: ModelBinding) => Promise<ProfileProviderType | null>,
    // Per-model vision fact read from the provider catalog's declared input
    // modalities (Task 6c; local models added by design §E5). TWO catalogs can
    // answer it, both from a field called `architecture.input_modalities`:
    // OpenRouter's, and the local engine's own GET /models (a local model reads
    // `["text","image"]` exactly when llama-server paired a vision projector
    // beside it). Everyone else (direct-key providers, openai-compatible) has
    // no such signal, so the real (ipc-handlers) wiring returns null for them
    // WITHOUT ever touching the catalog, same as a cache miss or fetch failure
    // returning null after touching it. null degrades to resolveProfile's
    // existing registry/provider-default behavior
    // (DiscoveredModel.supportsVision left undefined) — it is never allowed to
    // throw. It is also never allowed to block a session start it does not
    // apply to. For a binding it DOES apply to it awaits a catalog read, and
    // that read is this closure's alone — contextAndSlotsFor asks the engine
    // for a local binding and the catalog only for a hosted one, so on a local
    // start this is the first and only catalog call. It is bounded: the
    // catalog skips its upstream fetches entirely when no provider in the list
    // can consume them, so an offline local user waits on nothing (see the WHY
    // at ipc-handlers.ts's construction site and at ModelCatalog.get()).
    // Positioned right after providerTypeFor for the same reason that one sits
    // after contextAndSlotsFor: all three are resolved together for every
    // create/resume/swap.
    private visionSupportFor: (binding: ModelBinding) => Promise<boolean | null>,
    // Fourth per-binding catalog fact (Task 11), resolved at the same three
    // moments as its siblings above (create / resume / swap): what the bound
    // model costs. Returns null when the catalog has no published price for it
    // — never a zero, which would tell the user a metered turn was free.
    // Defaults to "no published price" so the ~70 existing five-argument test
    // constructions keep compiling, same rationale as permissionStore below;
    // the real wiring (ipc-handlers) injects the catalog lookup. A default of
    // null is not a guess — it is the honest "we don't know a rate", and the
    // cost chip stays absent rather than showing a made-up number.
    private pricingFor: (binding: ModelBinding) => Promise<ModelPricing | null> = async () => null,
    // Remembered "Always allow" rules, scoped per project (Task 12). Defaults to
    // a no-op so the many existing 5-arg test constructions (store, modelFactory,
    // contextAndSlotsFor, providerTypeFor, visionSupportFor — these five have no
    // defaults) still compile; the real wiring (ipc-handlers) injects a
    // PermissionStore over ~/.youcoded/.
    private permissionStore: RememberedRuleStore = NOOP_REMEMBERED_STORE,
    // Injected because electron's `app` is not importable in tests (mirrors the
    // other injected functions/values above). Feeds the <env> block of the
    // once-per-session assembled system prompt.
    private appVersion: string = '0.0.0-dev',
    // Runtime services threaded into every session's ToolContext (spec §3.2) —
    // WebSearch reads toolServices.search. Optional + LAST (of the pre-Task-6c
    // params) so existing 5/6/7-arg test constructions (the 5 required params,
    // optionally followed by permissionStore and/or appVersion) still compile;
    // the real wiring (ipc-handlers) injects { search: searchService }.
    private toolServices?: ToolServices,
    // Installed-skill source for /skill-name and the Skill tool (M3 item 1).
    // Injected + LAST so existing constructions still compile, and so a test can
    // supply a fake instead of scanning the real ~/.claude — which makes "no
    // skills installed" an expressible state rather than an environment accident.
    private skillCatalog?: SkillCatalog,
    // The process-level MCP connection pool (Task 4, mcp-manager.ts). Optional +
    // LAST so existing constructions still compile. Its destroyAll() was
    // already wired at this host's own app-quit path (destroyAll() below)
    // before this task; Task 6 adds the per-session acquire()/release() calls
    // (create/resume/destroy below). Typed structurally (McpManager's real
    // shape, not the imported class) so tests can inject a fake pool without
    // this file depending on the concrete class for a few method calls.
    // There is deliberately no `release(sessionId)` in this shape: a lease is
    // given back through the object acquire() returns, which is what keeps two
    // generations of one RESUMED session (same id, different lease) from
    // releasing each other's connections. See McpLease in mcp-manager.ts.
    private mcpManager?: { destroyAll(): Promise<void>; acquire(sessionId: string): Promise<McpLease> },
    // Task 2 (plan 1b) — backs the DelegationLedger this constructor builds
    // below. Takes a NativeHome rather than a pre-built DelegationLedger so
    // this file doesn't need to know delegation-ledger.ts's own construction
    // details beyond "give it a home". Optional + LAST, same reasoning as
    // toolServices/skillCatalog/mcpManager above: undefined here is what
    // every pre-existing 5..10-arg test construction gets for free (no
    // recording, not a NativeHome pointed at a real home dir by accident);
    // the real wiring (ipc-handlers.ts) always passes the shared nativeHome.
    nativeHome?: NativeHome,
    // Plan 1b Task 8: how long a routed specialist ask waits on the parent's
    // screen before the redirect fires. Optional + LAST, same reasoning as
    // every other trailing param here — defaults to the real 5-minute
    // production value (specialists/limits.ts) so every existing construction
    // is unaffected; tests that need the timeout to actually fire in a
    // reasonable wall-clock time override it with a small number instead of
    // fighting this file's setImmediate-heavy async machinery with fake timers.
    private specialistAskHoldMs: number = SPECIALIST_ASK_HOLD_MS,
    // Task 4 (plan 1c) — the per-cwd specialist catalog: three folders read
    // per project folder (personal, ~/.claude/agents, <cwd>/.claude/agents),
    // merged with the four built-ins into one roster. Optional + LAST, same
    // reasoning as every other trailing param above: the default here has no
    // `home` (so no personal source is ever read) and `claudeUserDir: null`
    // (so ~/.claude/agents is never read either) — a bare test construction
    // still only ever sees the four built-ins, exactly the pre-Task-4
    // behavior every existing test relies on. The real wiring (ipc-handlers)
    // passes a catalog built with the real home. Kept as ONE instance for
    // this host's whole life (not re-created per session) — its in-memory
    // per-source state is what makes ensureFresh()'s "unchanged folder costs
    // no re-read" fingerprint check work across turns and across sessions
    // sharing one project folder.
    private specialistCatalog: SpecialistCatalog = new SpecialistCatalog({ claudeUserDir: null }),
    // WHY inject once at the host boundary: create snapshots this preference,
    // while resume uses only its header, so call sites cannot make them diverge.
    private readStepGuard: () => number | null = () => null,
  ) {
    super();
    // Re-emit broker asks/expirations so ipc-handlers can forward them to the
    // renderer + remote clients (see the 'hook-event' listener there).
    this.broker.on('hook-event', (event) => this.emit('hook-event', event));
    // Plan 1b Task 8: the ONE handler for a real answer that arrives after its
    // ask already timed out — see onLateResponse's own comment for the
    // live-child-vs-ended-child split.
    this.broker.setLateResponseHandler((entry, decision) => this.onLateResponse(entry, decision));
    // Plan 1c — the ONE place a ledger write becomes a renderer-visible push.
    // The listener lives HERE, at construction, and nowhere else: the global
    // house rule is "emit in the ledger, never the host per method" — every
    // one of the ledger's own write methods (recordStart, update, appendNote,
    // appendMissedSteers, ...) already funnels through its single mutate()
    // chokepoint, so wiring the listener once here means a future write
    // method gets the push for free, with no call site in THIS file to
    // remember to add one to. `changed` is only the records a write actually
    // touched, so one steer/status/model change becomes exactly one event —
    // never a re-diff of the whole file. toRunView() strips the delivery
    // bookkeeping (delivered, claimedBy, missedSteers, rawReport, ...) the
    // card never needs; see its own comment for the full omitted list.
    this.ledger = nativeHome
      ? new DelegationLedger(nativeHome, (cwd, parentId, changed) => {
          for (const rec of changed) {
            this.emit('specialists-event', { kind: 'run', sessionId: parentId, run: toRunView(rec) } satisfies SpecialistsEvent);
          }
        })
      : undefined;
    this.nativeHome = nativeHome;
    this.delegatedModels = nativeHome ? new DelegatedModels(nativeHome) : undefined;
  }

  /** Route a renderer/remote permission response to the broker. Returns false
   *  when the id isn't a pending native ask so ipc-handlers falls through to
   *  hookRelay (CC asks share the permission:respond channel). */
  respondPermission(requestId: string, decision: Record<string, unknown>): boolean {
    return this.broker.respond(requestId, decision);
  }

  /** Task 0 (ROADMAP #permissions): lets ipc-handlers re-send a session's open
   *  asks after TRANSCRIPT_REPLAY, so a reloaded window's card gets its
   *  buttons back instead of coming back inert. Pure delegate — see
   *  PermissionBroker.pendingEventsFor for why this is needed at all. */
  pendingAskEventsFor(sessionId: string): HookEvent[] {
    return this.broker.pendingEventsFor(sessionId);
  }

  /** Wire the "no session uses model X anymore" callback (→ engine unload). */
  setModelReleasedHandler(fn: (modelId: string) => void): void {
    this.onModelReleased = fn;
  }

  private retainModel(sessionId: string, modelId: string): void {
    let set = this.modelRefs.get(modelId);
    if (!set) { set = new Set(); this.modelRefs.set(modelId, set); }
    set.add(sessionId);
  }

  private releaseModel(sessionId: string, modelId: string): void {
    const set = this.modelRefs.get(modelId);
    if (!set) return;
    set.delete(sessionId);
    if (set.size === 0) {
      this.modelRefs.delete(modelId);
      try { this.onModelReleased?.(modelId); } catch { /* best-effort */ }
    }
  }

  /** Live sessions currently bound to a model (for the state coordinator). */
  sessionsForModel(modelId: string): string[] {
    return [...(this.modelRefs.get(modelId) ?? [])];
  }

  /** The model a live session is bound to right now (null if not live). */
  modelForSession(sessionId: string): string | null {
    return this.live.get(sessionId)?.session.binding.modelId ?? null;
  }

  /** Set a session's permission mode (renderer chip → NATIVE_SET_PERMISSION_MODE).
   *  Validates LOUDLY: an unknown mode string is a renderer/wiring bug, so throw
   *  (rejecting the invoke() promise at the ipcMain.handle boundary) rather than
   *  silently storing garbage. Returns the applied mode as the authoritative
   *  value the chip renders. Pending asks are untouched — decide() re-reads the
   *  mode on the NEXT gated tool, so a flip never disturbs an in-flight ask. */
  setPermissionMode(sessionId: string, mode: NativePermissionMode): NativePermissionMode {
    const VALID: NativePermissionMode[] = ['ask', 'auto-edit', 'full-auto'];
    if (!VALID.includes(mode)) {
      throw new Error(`Unknown native permission mode: ${String(mode)} (expected one of ${VALID.join(', ')}).`);
    }
    this.modeFor.set(sessionId, mode);
    return mode;
  }

  /** Revoke ONE remembered "Always allow": disk first, then every live session's
   *  in-memory copy. Returns whether the store actually matched anything on disk
   *  — the renderer uses that to say "we couldn't find it" rather than reporting
   *  success against a list that had gone stale.
   *
   *  ONE ENTRY POINT ON PURPOSE. buildDecide() unions the on-disk rules with
   *  `rememberedFor` on EVERY decision, so a disk-only delete leaves a running
   *  session granting exactly what the user just revoked — the failure this whole
   *  feature exists to prevent. That is also why the naming differs from the
   *  store's: PermissionStore.remove / removeProject are DISK ONLY, while
   *  revokeRule / revokeProject are disk PLUS live memory. IPC handlers must call
   *  these, never the store's — "fixing the inconsistency" reintroduces the bug.
   *
   *  ONE SLUG IS NOT A FOLDER: CROSS_PROJECT_SLUG ('all projects') is the bucket
   *  holding grants on the user's OWN file-defined specialists, which apply in
   *  every project (shared/permission-types.ts → isCrossProjectRule). Revoking
   *  from it must reach every live session, not the ones whose cwd matches — see
   *  the branch below.
   *
   *  Matching is otherwise by SLUG, never by path equality: nativeStoreSlug collapses ':',
   *  '\', '/' AND spaces all to '-', so two differently-spelled cwds ('/home/d/my
   *  project' and '/home/d/my-project') genuinely share one entry on disk — and
   *  must therefore both be cleared in memory too.
   *
   *  The in-memory filter compares the (tool, pattern, action, match, specialist)
   *  QUINT via sameRule, not whole objects: a rule read back off disk carries a
   *  `grantedAt` key the in-memory copy never had, so an equality check would
   *  silently stop matching. `match` joined the identity when Bash grants gained
   *  a scoped wide shape — without it, "this exact command" and "any command of
   *  this kind" collapse into one row and Settings revokes the wrong one.
   *  `specialist` joined it in Task 11 — without it, revoking a root grant would
   *  also drop a same-triple SPECIALIST-keyed grant (or vice versa) still held
   *  by a live session. */
  async revokeRule(slug: string, rule: PermissionRule): Promise<boolean> {
    const hit = await this.permissionStore.remove(slug, rule);
    for (const [sessionId, entry] of this.live) {
      // The cross-project bucket is not a folder, so no session's cwd slugs to
      // it (its key contains a space, which nativeStoreSlug always collapses) —
      // a cwd comparison would clear it from NOBODY. It was granted everywhere,
      // so it has to be revoked everywhere: every live session, whatever its cwd.
      if (slug !== CROSS_PROJECT_SLUG && nativeStoreSlug(entry.cwd) !== slug) continue;
      const mem = this.rememberedFor.get(sessionId);
      if (!mem) continue;
      this.rememberedFor.set(sessionId, mem.filter((r) => !sameRule(r, rule)));
    }
    return hit;
  }

  /** Revoke EVERY remembered rule for a project (the "clear all for this folder"
   *  control). Same disk-plus-live-memory contract and same slug matching as
   *  revokeRule — see its comment for why both halves are mandatory.
   *
   *  CROSS_PROJECT_SLUG is the exception, in BOTH directions: it matches every
   *  live session (no cwd slugs to it), but it may only remove that session's
   *  cross-project rules — its own project grants are a different card in
   *  Settings and were not what the user cleared. */
  async revokeProject(slug: string): Promise<boolean> {
    const hit = await this.permissionStore.removeProject(slug);
    for (const [sessionId, entry] of this.live) {
      // "Clear all" on the cross-project bucket clears the CROSS-PROJECT grants
      // out of every live session — and nothing else. Dropping each session's
      // whole memory here would silently take that session's own project grants
      // with it, which the user never asked to revoke and Settings still shows
      // under its own folder card.
      if (slug === CROSS_PROJECT_SLUG) {
        const mem = this.rememberedFor.get(sessionId);
        if (mem) this.rememberedFor.set(sessionId, mem.filter((r) => !isCrossProjectRule(r)));
        continue;
      }
      // delete, not set([]): an absent entry and an empty one read identically in
      // buildDecide (`?? []`), and deleting keeps the map from accumulating empties.
      if (nativeStoreSlug(entry.cwd) === slug) this.rememberedFor.delete(sessionId);
    }
    return hit;
  }

  /** The per-session permission decision closure passed into each HarnessSession.
   *  Re-reads the session's current mode + remembered rules on EVERY call, so a
   *  mid-session mode flip (setPermissionMode) — and any newly-remembered rule —
   *  takes effect on the NEXT gated tool.
   *
   *  `opts.specialistScope` (Task 11): a child's parentDecide passes its own
   *  agentType here. A specialist-keyed remembered rule must never widen the
   *  ROOT session's own permissions, and must never apply to a DIFFERENT
   *  specialist type — that is the whole reason rule identity grew a
   *  `specialist` axis (PermissionRule.specialist, shared/permission-types.ts,
   *  one leg of the sameRule QUINT alongside tool/pattern/action/match).
   *  `scope === undefined` (every root-session call site) sees ONLY unscoped
   *  rules; a child's scope additionally sees rules tagged for that SAME
   *  agentType, never another's. */
  private buildDecide(sessionId: string, cwd: string, presetRules: PermissionRule[], opts?: { specialistScope?: string }) {
    const scope = opts?.specialistScope;
    const inScope = (r: PermissionRule) => (
      scope === undefined ? r.specialist === undefined : (r.specialist === undefined || r.specialist === scope)
    );
    return async (tool: string, subject: string | undefined) => decidePermission(tool, subject, {
      presetRules,                           // preset manifests contribute here — lowest layer, mode/deny/remembered all override
      modeRules: rulesForMode(this.modeFor.get(sessionId) ?? 'ask'),
      denyList: DESTRUCTIVE_DENY_LIST,
      // Union disk (cross-session record) with this session's in-memory rules
      // (session-truth). Disk first, in-memory appended after — a later match
      // wins in the engine, but the two are identical allow rules so the tie is
      // harmless. In-memory is what guarantees an Always-allow sticks even if the
      // async disk persist failed or hasn't landed yet (see rememberedFor above).
      // Filtered by scope LAST, after the union, so a rule freshly written by
      // EITHER source (disk or memory) is scoped identically.
      rememberedRules: [
        ...await this.permissionStore.rulesFor(cwd),
        ...(this.rememberedFor.get(sessionId) ?? []),
      ].filter(inScope),
    });
  }

  /** Resolve BOTH the clamped context window AND the capability profile for a
   *  binding, together (create/resume/swap all need the pair). The context is the
   *  engine's real loaded window (Task 4) clamped to a known model's trained
   *  ceiling (Task 5's registry clamp); the profile is resolved from the binding's
   *  provider type + model id + that clamped context. An unknown provider type
   *  falls back to 'openrouter' — the cloud-safe default (full posture). */
  private async resolveContextAndProfile(binding: ModelBinding): Promise<{ contextLength: number | null; profile: CapabilityProfile; pricing: ModelPricing | null; free: boolean }> {
    // Fix pass 2 (Task 13): ONE call gets both the context window and the
    // engine's real slot count — see the contextAndSlotsFor constructor
    // param's comment for why this replaces two separately-injected closures
    // that used to share one /props reading through a variable at the
    // ipc-handlers.ts wiring site. There is nothing left to order: this is
    // the single await that produces both values for this binding.
    const { contextLength: raw, totalSlots } = await this.contextAndSlotsFor(binding);
    const discoveredSlots = totalSlots ?? undefined;
    const type = (await this.providerTypeFor(binding)) ?? 'openrouter';     // unknown → cloud-safe default
    // The registry ceiling (effectiveContextForModel) is a LOCAL-model concern: it
    // caps a small GGUF loaded at a too-large -c to its real trained window. But
    // matchKnownModel keys ONLY on the model-id regex, so a HOSTED model whose id
    // happens to match a local family (e.g. OpenRouter `qwen/qwen3.5-9b` matching
    // the local Qwen entry) would be wrongly clamped, capping a cloud window that
    // may be far larger. So resolve the provider type FIRST and only clamp locals;
    // cloud/hosted bindings pass their real window through unchanged.
    const contextLength = type === 'local-engine' ? effectiveContextForModel(raw, binding.modelId) : raw;
    // null (no source could answer — the closure's convention, matching
    // contextAndSlotsFor/providerTypeFor above) becomes undefined on the
    // DiscoveredModel, which is visionFor()'s OWN "not discovered" sentinel —
    // it then falls through to the registry/provider-type default exactly as
    // it did before this closure existed.
    const discoveredVision = (await this.visionSupportFor(binding)) ?? undefined;
    const profile = resolveProfile({
      providerType: type, modelId: binding.modelId, contextLength, supportsVision: discoveredVision,
      // Threads the engine's real slot reading into the known-model overlay's
      // concurrency clamp (capability-profile.ts's localSlotCap). undefined
      // for every non-local-engine binding — the ipc-handlers wiring never
      // queries the engine for those.
      totalSlots: discoveredSlots,
    });
    // Task 11 (spec §5): the price this binding runs at, and whether it costs
    // anything at all. Resolved here so create/resume/swap all get it from the
    // one place that already resolves the binding's other catalog facts.
    const pricing = await this.pricingFor(binding);
    // Two ways to be free, and they must not be confused with "no published
    // price": the model runs on this machine (local-engine), or its published
    // rate card is all zeroes (an OpenRouter ':free' variant — see
    // pricing.ts's isFreePricing for why a zero rate is not a $0.00 bill).
    // `type` is post-fallback, so a provider we could not identify counts as
    // metered — we never claim free without knowing it.
    const free = type === 'local-engine' || isFreePricing(pricing);
    return { contextLength, profile, pricing, free };
  }

  /** Tool + permission + prompt wiring shared by create() and resume(). Both v1
   *  presets (Assistant, Coder) are personality profiles, not capability tiers
   *  (spec decisions 8/9): EVERY native session carries the full CORE_TOOLS
   *  suite — presets differ only in prompt body (preset.body) and permission
   *  posture (preset.presetRules + the seeded starting mode). The resolved
   *  `profile` is accepted here so Task 6 can add a prompt variant without another
   *  signature change; this task doesn't use it yet (the session itself carries it
   *  via opts.profile). */
  private toolWiring(sessionId: string, cwd: string, preset: ResolvedPreset, profile: CapabilityProfile): Pick<HarnessSessionOpts, 'tools' | 'decide' | 'askUser' | 'systemPrompt' | 'toolServices' | 'skillCatalog' | 'triggers' | 'internalReadRoots' | 'specialistRoster' | 'shells'> {
    return {
      // G-1: this session's background-command registry, host-owned.
      shells: this.shellsFor(sessionId),
      tools: CORE_TOOLS,
      // Task 4 (plan 1c) — this project folder's roster, read live off the
      // catalog's in-memory state at every roster()/list()/resolve() call
      // (catalog.ts's own contract), never a snapshot frozen here. Callers
      // (create()/resume()) must have already awaited
      // this.specialistCatalog.ensureFresh(cwd) before reaching toolWiring —
      // roster()'s own contract says it must not be called before that has
      // resolved at least once for this cwd.
      specialistRoster: this.specialistCatalog.roster(cwd),
      // Project rules + nested project instructions, indexed ONCE per session
      // (M3 item 3). Built here rather than in the session because it is
      // filesystem state scoped to the session's cwd, and re-statting the tree
      // per tool call would be a real cost on a large repo.
      triggers: buildTriggerIndex(cwd),
      // Task 10 (plan 1b): the ONE root a ROOT session is allowed to Read
      // without an external_directory ask — this PROJECT's
      // sessions/<slug>/specialist-reports/ subdirectory, the exact place
      // writeSessionArtifact spills an oversized specialist report to (Fix,
      // Important 5, final review: narrowed from the WHOLE sessions/<slug>/
      // directory, which also held every OTHER conversation's transcript
      // .jsonl and the delegation ledger sidecars — this project's own
      // harness storage that has nothing to do with a spilled report — see
      // SPECIALIST_REPORT_SPILL_SUBDIR's own comment). Not exclusive to this
      // one session (every session sharing this cwd writes into the same
      // slug's spill subdirectory, same as before) — it is scoped to "this
      // project's own specialist-report spill storage", not to secrets or
      // anything outside it. Only create()/resume() call toolWiring;
      // createChild (specialist children) builds its opts by hand and never
      // does, so a child never inherits this.
      ...(this.nativeHome ? { internalReadRoots: [path.join(this.nativeHome.root, 'sessions', nativeStoreSlug(cwd), SPECIALIST_REPORT_SPILL_SUBDIR)] } : {}),
      // Skill is NOT in CORE_TOOLS — it is attached per session by
      // buildAiTools when the profile can afford its catalog. Threading the
      // catalog (rather than letting the session scan on its own) means the host
      // and the session agree on one source, and a test can inject a fake.
      // Fix: project .claude/skills are session-scoped. Build their catalog from
      // this session's cwd so one workspace's workflows never appear in another.
      skillCatalog: this.skillCatalog ?? createSkillCatalog(undefined, cwd),
      decide: this.buildDecide(sessionId, cwd, preset.presetRules),
      // Stamp the CURRENT mode on every ask (read at call time, not wiring
      // time — a mid-session mode flip must show on the next ask). The
      // renderer's full-auto safety-stop footer keys on it.
      askUser: (req) => this.broker.ask({ ...req, permissionMode: this.modeFor.get(sessionId) ?? 'ask' }),
      // Thread injected runtime services (WebSearch's SearchService, Task 6's
      // specialists collaborators) into the HarnessSession opts. `specialists`
      // is ALWAYS present (unlike `search`, which depends on an optional
      // constructor arg) — syncTaskTool's own profile.canDelegate /
      // isSpecialistChild gate is what actually decides whether the Task tool
      // is ever attached to see it, so there is no "host built without
      // specialist support" case to leave unset the way `toolServices` itself
      // conditionally omits `search`.
      toolServices: {
        ...(this.toolServices ?? {}),
        specialists: {
          reserve: (parentId: string, reserveOpts: { writer: boolean }) => this.reserveSpecialist(parentId, reserveOpts),
          release: (token: SpecialistReservation) => this.releaseReservation(token),
          trySpendSpawnBudget: (parentId: string) => this.trySpendSpecialistSpawnBudget(parentId),
          spawn: (parentId: string, spawnOpts: Parameters<NativeSessionHost['spawnSpecialist']>[1]) =>
            this.spawnSpecialist(parentId, spawnOpts),
          // Task 4 — background execution.
          spawnBackground: (parentId: string, spawnOpts: Parameters<NativeSessionHost['spawnSpecialistBackground']>[1]) =>
            this.spawnSpecialistBackground(parentId, spawnOpts),
          // Task 6 — the task_id management surface: steer/interrupt/resume.
          // 2026-09-09 — replaces the per-turn status block: the model asks
          // once (Task list: true) instead of being reminded every turn.
          listStatus: (parentId: string) => {
            const e = this.live.get(parentId);
            return e ? this.buildSpecialistStatus(parentId, e.cwd) : null;
          },
          steerSpecialist: (parentId: string, childId: string, text: string) => this.steerSpecialist(parentId, childId, text),
          interruptSpecialist: (parentId: string, childId: string) => this.interruptSpecialist(parentId, childId),
          resumeSpecialist: (parentId: string, resumeOpts: Parameters<NativeSessionHost['resumeSpecialist']>[1]) =>
            this.resumeSpecialist(parentId, resumeOpts),
        },
        // Task 14 fix pass: `designated` is real (backed by NativeHome) whenever
        // this host was constructed with one — the same condition `this.ledger`
        // already depends on. `catalog` now threads through the `modelCatalog`
        // closure ipc-handlers.ts wires into `toolServices` at construction
        // (same precedent as the context/slots and vision-support closures it
        // builds the same way, a few params up from here). When no closure was
        // supplied — a test host, or any construction that skips it — this
        // still falls back to a `null` catalog, the same SAFE "not loaded"
        // default as before: task.ts and ModelSearch both treat a null catalog
        // as "cannot confirm this id", never a guess. Tier resolution
        // (budget/frontier/parent) never touches the catalog at all, so it
        // worked fully even before this fix pass.
        ...(this.delegatedModels
          ? { models: { designated: this.delegatedModels, catalog: this.toolServices?.modelCatalog ?? (async () => null) } }
          : {}),
      },
      // WHY assembleSystemPrompt is called synchronously here: it shells out to
      // git twice (execFileSync, 3s timeout each → ~6s worst case). It runs ONCE
      // per session create/resume — NEVER on the per-turn send() path — so the
      // accepted sync cost sits off the hot loop. Threading an await through here
      // would ripple through every construction site for no per-turn benefit
      // (Task 11 review ruling — the sync cost is deliberate and bounded).
      // profile.promptVariant selects the capability-steering overlay (local-small only in v1).
      // hasTools mirrors buildAiTools()'s gate: a tool-less profile (supportsTools === false)
      // gets NO tools attached, so the prompt must also drop the tool-guidance line + overlay.
      // instructionBudgetTokens reuses the profile's injection budget rather than
      // adding a fifth tunable: the root AGENTS.md/CLAUDE.md is the same KIND of
      // content as the nested instruction files and rules that budget already
      // sizes, so a second ladder would only be a second thing to drift.
      // NOTE this is fixed for the session's life — the system prompt is never
      // reassembled, not even by setBinding's mid-session model swap (that is what
      // keeps the KV-cache prefix stable). Sizing therefore follows the model the
      // session STARTED on. Deliberate; revisit only if prompt reassembly ever is.
      systemPrompt: assembleSystemPrompt({ presetBody: preset.body, cwd, appVersion: this.appVersion, promptVariant: profile.promptVariant, hasTools: profile.supportsTools, instructionBudgetTokens: profile.injectionBudgetTokens, supportsParallelToolCalls: profile.supportsParallelToolCalls, audience: 'user' }),
    };
  }

  /** Acquire this session's pooled MCP servers (Task 6) — the ONE production
   *  caller of McpManager.acquire(). undefined when no manager is wired (every
   *  existing test construction, which predates Task 6) or when acquisition
   *  itself fails: a registry-wide failure (a corrupt `~/.youcoded/mcp.json`,
   *  a secrets-store read error) must not block the session from opening at
   *  all — MCP is one optional capability layered onto the tool set, not a
   *  precondition for having a session at all. A single broken SERVER is
   *  already handled inside McpManager itself (excluded from the returned
   *  list, never a rejection) — this only guards the rarer whole-registry
   *  failure. */
  private async acquireMcp(sessionId: string): Promise<McpLease | undefined> {
    if (!this.mcpManager) return undefined;
    try {
      return await this.mcpManager.acquire(sessionId);
    } catch (err) {
      log('ERROR', 'NativeSessionHost', 'mcp acquire failed — session opens with no MCP servers', { sessionId, error: String(err) });
      return undefined;
    }
  }

  /** Task 5 (plan 1b): one line per NON-DELIVERED delegation for `sessionId`
   *  (its parent), or null when there's nothing to report. "Zero cost" here
   *  is about the MODEL's context window, not disk I/O: a null return injects
   *  nothing, so a session that never delegates never pays a status line —
   *  but reaching that null still costs one `listFor` read of the delegation
   *  sidecar (native-home.ts readJson's fast ENOENT path) on every turn, same
   *  as resume()'s reconcileDelegations and getHistory()'s card-replay merge
   *  (Task 9) each pay one more such read per call for the identical reason:
   *  correctness requires checking, and checking a missing sidecar is cheap
   *  but not free. A record with `delivered: true` never appears: its report
   *  already rode into the parent's history, so restating it here would be
   *  stale noise, not a status.
   *
   *  Fix pass, Finding 1: NO step count on the running line. `steps` is only
   *  ever written by the ledger's write path AT COMPLETION (see
   *  spawnSpecialist's `update(...steps: run.steps...)`) — recordStart never
   *  sets it, so a RUNNING record's `steps` is ALWAYS undefined; there is no
   *  live, per-child step counter surfaced anywhere a status line could read
   *  from without reaching into spawnSpecialist/createChild's own bookkeeping
   *  (out of scope here — a different in-flight lane owns those methods). The
   *  old `step ${r.steps ?? 0}` therefore rendered a permanently-wrong
   *  "step 0" for the ENTIRE life of every running child — a known-wrong
   *  number, not an approximation, and the never-mislead-the-model rule does
   *  not allow reporting it. Elapsed time (which IS live and real) is
   *  reported instead; nothing invented fills the gap.
   *
   *  `stale` likewise only ever surfaces the ledger's own boolean (Task 7 sets
   *  it) — this method never re-derives staleness. Fix pass, Finding 2: the
   *  "no activity for {m}m" minute count is worded as a FLOOR ("at least"),
   *  not a measurement — the ledger stores no last-activity TIMESTAMP, only
   *  the boolean, so there is no exact duration to surface, and the actual
   *  threshold that fired can be the 5m in-tool one, not the 2m idle one this
   *  reports. What IS true by construction (setStale below) is that `stale`
   *  never flips true before SPECIALIST_IDLE_STALE_MS has elapsed with no
   *  activity, so "at least" is always accurate even when it understates.
   *
   *  Fix pass, Finding 3 (original): 'interrupted' gets its OWN line, not the
   *  running-record's "finished — report delivery pending" wording — a parent
   *  teardown killed the child (see updateIfRunning's WHY comment above), so
   *  no claim ever gets made against this record and no report ever arrives.
   *
   *  Final-review fix (Finding 1): 'failed' used to get the SAME
   *  "no report will arrive" treatment as 'interrupted', on the reasoning
   *  that claimUndelivered() (delegation-ledger.ts) "only ever claims
   *  status === 'completed' records". That eligibility was later widened
   *  (Important 4, final review) to claim 'completed' OR 'failed' — a
   *  background run that dies still owes the parent a typed
   *  "[Background specialist failed] ..." notice, not silence — so telling
   *  the model no report is coming was, from that point on, actively wrong:
   *  the model would be told nothing is coming and then have one arrive a
   *  turn or two later. 'failed' now gets the SAME "delivery pending" framing
   *  as 'completed', with the real failureText named inline (never a guessed
   *  cause — error-message-standards.md). Only 'interrupted' still says "no
   *  report will arrive", because that one claim stayed true.
   *
   *  The final branch below is an explicit `switch`, not a trailing
   *  `if`/`else` — a plain `else` would silently render any FUTURE fifth
   *  DelegationRecord status as "interrupted" instead of failing to compile;
   *  the `never` assignment in `default` turns that into a typecheck error
   *  the day the status union grows. */
  // 2026-09-09: no longer injected every turn (that block kept helpers
  // top-of-mind and invited the "report now" steers the transcript audit
  // measured, and re-inserting it each turn threw away cached prompt prefix).
  // Now the text behind Task's `list: true` — read on demand, like Codex's
  // list_agents and Hermes's delegate_task(action='list').
  private buildSpecialistStatus(sessionId: string, cwd: string): string | null {
    if (!this.ledger) return null;
    const lines = this.ledger.listFor(cwd, sessionId)
      .filter((r) => !r.delivered)
      .map((r) => {
        switch (r.status) {
          case 'running': {
            const elapsedS = Math.max(0, Math.round((Date.now() - r.startedAt) / 1000));
            const staleNote = r.stale ? `, may be stuck — no activity for at least ${Math.round(SPECIALIST_IDLE_STALE_MS / 60_000)}m` : '';
            return `${r.title} (${r.agentType}): running — ${elapsedS}s${staleNote}`;
          }
          case 'completed':
            return `${r.title} (${r.agentType}): finished — report delivery pending`;
          case 'failed':
            return `${r.title} (${r.agentType}): failed${r.failureText ? ` — ${r.failureText}` : ''} — report delivery pending`;
          case 'interrupted':
            return `${r.title} (${r.agentType}): interrupted — no report will arrive`;
          default: {
            // Exhaustiveness guard: a status literal added to
            // DelegationRecord['status'] without a case here fails `tsc`
            // right here (assigning a non-`never` type to `never`), instead
            // of silently falling through and mislabeling the new status.
            const _exhaustive: never = r.status;
            return `${r.title} (${r.agentType}): ${_exhaustive}`;
          }
        }
      });
    return lines.length > 0 ? lines.join('\n') : null;
  }

  /** Record ONE remembered "Always allow" under `sessionId`'s in-memory bucket
   *  (synchronously, deduping on the full sameRule identity) and fire-and-forget
   *  persist it to disk. Shared by two callers (Task 11):
   *   - wire()'s 'remember-rule' listener, for a ROOT session's own grant
   *     (`rule.specialist` absent — HarnessSession has no concept of being a
   *     child, it just emits {tool, pattern?, action}).
   *   - createChild's childAskRouter wiring, for a routed CHILD ask's
   *     "Always allow" — `rule.specialist` is the child's agentType, and
   *     `sessionId`/`cwd` are deliberately the PARENT's: a specialist child is
   *     never wire()'d (see createChild's own "NOT wire()" comment), so
   *     nothing would ever persist a child's grant if the router didn't call
   *     this directly. buildDecide's scope filter is what then keeps that
   *     grant from leaking to the root session or a different specialist type
   *     — this method only WRITES the rule, it doesn't decide who can see it.
   *
   *  Dedup compares the sameRule QUINT (tool, pattern, action, match,
   *  specialist) — the same identity the store, the revoke matcher, and the
   *  UI's key use. A narrower compare would silently merge a specialist-keyed
   *  grant into an existing root grant (or vice versa), or collapse two grants
   *  that differ only in `match`, discarding one. */
  private rememberRule(sessionId: string, cwd: string, rule: PermissionRule): void {
    // (1) Record in-memory SYNCHRONOUSLY first — this is what makes the
    // Always-allow stick for the rest of the session regardless of whether the
    // disk write below succeeds or wins the race with the next tool call.
    const mem = this.rememberedFor.get(sessionId) ?? [];
    if (!mem.some((r) => sameRule(r, rule))) {
      mem.push(rule);
      this.rememberedFor.set(sessionId, mem);
    }
    // (2) Then persist the cross-session record. Fire-and-forget: a failed
    // persist must not break the turn, and (1) already covers this session.
    void this.permissionStore.remember(cwd, rule).catch((err) => {
      log('ERROR', 'NativeSessionHost', 'remember-rule persist failed', { sessionId, error: String(err) });
    });
  }

  /**
   * Messages typed BEFORE the session finished starting, keyed by session id.
   *
   * WHY THIS EXISTS (Destin, 2026-09-06). He made a session on a local model and
   * typed straight away. The app answered "This session is no longer running.
   * Start or resume it to send messages." Both halves were false: the session had
   * never run yet — the engine was still loading a 29 GB model — and there was
   * nothing to start or resume. A minute later the same session answered him
   * normally. `send()` looked the id up in `this.live`, found nothing, and had
   * exactly ONE reason code for "not in that map", which covers two opposite
   * situations: a session that has ENDED, and a session that has not STARTED yet.
   *
   * An id is in this map from the moment create()/resume() begins until wire()
   * makes it live. A send that lands in that window is held here and delivered
   * the instant the session exists, so the message the user typed is never
   * thrown away — which is the real harm; better wording alone still loses it.
   */
  private startingSends = new Map<string, { id: string; text: string; attachments: string[] }[]>();

  /** Mark an id as being built. Called at the TOP of create() and resume(), so
   *  the window a pre-live send can fall into is covered from its first tick. */
  private beginStarting(sessionId: string): void {
    if (!this.startingSends.has(sessionId)) this.startingSends.set(sessionId, []);
  }

  /** Stop holding sends for an id, returning whatever was held. Called by wire()
   *  on success, and by create()/resume() when they give up — a message held for
   *  a session that never came up must not sit in memory forever. */
  private endStarting(sessionId: string): { id: string; text: string; attachments: string[] }[] {
    const held = this.startingSends.get(sessionId) ?? [];
    this.startingSends.delete(sessionId);
    return held;
  }

  /** Subscribe a freshly-built HarnessSession: forward its events to the
   *  renderer immediately, and enqueue each on the session's append chain. */
  private wire(sessionId: string, cwd: string, session: HarnessSession, mcpLease?: McpLease): void {
    const entry: LiveEntry = { session, cwd, appendChain: Promise.resolve(), queue: [], inFlight: false, mcpLease };
    this.live.set(sessionId, entry);
    this.retainModel(sessionId, session.binding.modelId); // ref-count this model
    // Persist "Always allow" decisions for THIS session's project. The session
    // emits 'remember-rule' {tool, pattern?, action} — a plain EventEmitter
    // event, NOT a transcript event (the frozen transcript surface is untouched)
    // — whenever the user picks Always-allow. The host owns the cwd → project
    // slug scoping via PermissionStore. Fire-and-forget: a failed persist must
    // not break the turn (the rule is a convenience, re-asked next time).
    session.on('remember-rule', (rule: PermissionRule) => this.rememberRule(sessionId, cwd, rule));
    session.on('transcript-event', (event: TranscriptEvent) => {
      // (1) Forward NOW — not gated on the disk write (see module header).
      this.emit('transcript-event', event);
      // (2) Persist on the per-session chain so appends stay serialized.
      entry.appendChain = entry.appendChain
        .then(() => this.store.append(cwd, event))
        .catch((err) => {
          // Swallow so one failed append can't wedge the chain — the next
          // event's append must still run.
          log('ERROR', 'NativeSessionHost', 'append failed', {
            sessionId, type: event.type, error: String(err),
          });
        });
    });
    // Anything the user typed while this session was still being built goes now,
    // in the order they typed it. The FIRST one is dispatched through the normal
    // send() path (which sets inFlight and, when that turn ends, drains the rest);
    // the others are pushed onto the queue KEEPING the ids the renderer was already
    // given, so Cancel/Edit can still target them.
    const held = this.endStarting(sessionId);
    if (held.length > 0) {
      const [first, ...rest] = held;
      entry.queue.push(...rest);
      this.send(sessionId, first.text, first.attachments);
    }
  }

  /** Fresh session: write the header, build + wire a live HarnessSession. */
  async create(opts: CreateNativeSessionOpts): Promise<void> {
    // From here until wire(), a send for this id is HELD rather than refused —
    // see startingSends. Marked before the first await so there is no tick in
    // which a typed message would be told the session is "no longer running",
    // and released in the `finally` if the session never comes up, so a held
    // message cannot sit in memory for the life of the app.
    this.beginStarting(opts.sessionId);
    try {
      await this.createInner(opts);
    } finally {
      if (!this.live.has(opts.sessionId)) this.endStarting(opts.sessionId);
    }
  }

  private async createInner(opts: CreateNativeSessionOpts): Promise<void> {
    // Same single-writer guard as resume() — create() also ends in wire(), so an
    // id that is somehow still live would gain a second appending listener here
    // too. Cheap and idempotent; closes the class at BOTH wire() entry points
    // rather than only the one we know a caller reached.
    if (this.live.has(opts.sessionId)) {
      log('WARN', 'NativeSessionHost', 'create found a live session under the same id — destroying the orphan first', { sessionId: opts.sessionId });
      await this.destroy(opts.sessionId);
    }
    const preset = resolvePreset(opts.presetId);
    const stepGuard = this.readStepGuard();
    const harness = stepGuard === null
      ? preset.manifest
      : { ...preset.manifest, limits: { ...preset.manifest.limits, maxSteps: stepGuard } };
    const { contextLength, profile, pricing, free } = await this.resolveContextAndProfile(opts.binding);
    await this.store.create({
      v: 1,
      sessionId: opts.sessionId,
      harnessId: preset.manifest.id,
      binding: opts.binding,
      cwd: opts.cwd,
      createdAt: Date.now(),
      ...(stepGuard === null ? {} : { stepGuard }),
    });
    // The preset seeds the STARTING mode; an explicit setPermissionMode always
    // wins — modeFor is never overwritten here (plan decision 3).
    if (!this.modeFor.has(opts.sessionId)) this.modeFor.set(opts.sessionId, preset.defaultMode);
    // Task 4 (plan 1c) — read this project folder's specialist catalog BEFORE
    // toolWiring() ever calls this.specialistCatalog.roster(cwd) below: that
    // call reads live in-memory state, and roster()'s own contract says it
    // must not be called before ensureFresh() has resolved at least once for
    // this cwd. Awaited here so no session ever ships the model an empty
    // roster on its very first turn.
    await this.specialistCatalog.ensureFresh(opts.cwd);
    // Acquire this session's MCP servers (Task 6) BEFORE constructing the
    // session, so mcpServers is available for the very first buildAiTools().
    const mcpLease = await this.acquireMcp(opts.sessionId);
    const mcpServers = mcpLease?.servers;
    let session: HarnessSession;
    try {
      // Fix pass 1 / Finding 3: this whole block is fallible synchronous work
      // (toolWiring() calls assembleSystemPrompt(), buildTriggerIndex()) that
      // runs AFTER the mcp acquire() above but BEFORE wire() ever registers
      // this id in `this.live`. destroy() early-returns for a non-live id, so
      // a throw here — with no catch — would strand the acquired MCP hold
      // (and the pooled server's spawned child process) for the rest of the
      // app's lifetime. Release the hold and rethrow the ORIGINAL error
      // unchanged (never guess/replace a cause — error-message-standards.md).
      session = new HarnessSession(
        { sessionId: opts.sessionId, cwd: opts.cwd, harness, binding: opts.binding, contextLength, profile, pricing, free,
          ...(mcpServers ? { mcpServers } : {}),
          ...this.toolWiring(opts.sessionId, opts.cwd, preset, profile) },
        this.modelFactory,
      );
    } catch (err) {
      await mcpLease?.release();
      throw err;
    }
    this.presetIdFor.set(opts.sessionId, preset.manifest.id);
    this.wire(opts.sessionId, opts.cwd, session, mcpLease);
  }

  /** Mint a SPECIALIST CHILD of a live session (plan 1a, spec §1/§5).
   *
   *  A specialist is an ordinary HarnessSession, not a new kind of object: same
   *  driver, same transcript events, its own JSONL. What makes it a child is
   *  (a) the header's parentage fields, (b) a COLD start — its system prompt is
   *  the specialist definition plus the <env> block for its work directory, and
   *  nothing at all from the parent conversation, and (c) a capability surface
   *  that can only ever be narrower than the parent's.
   *
   *  `prompt` and `parentToolCallId` are accepted here but deliberately not
   *  consumed yet: this call mints the child IDLE. Task 7's runSpecialist()
   *  delivers the prompt as the child's first user turn and stamps display
   *  copies of its events with parentToolCallId. They sit in the signature now
   *  so the Task tool (Task 6), which is written against this contract, has one
   *  call site rather than two.
   *
   *  Returns the child's id; throws (never returns a half-built child) when the
   *  parent isn't live or the work directory escapes the parent's. */
  async createChild(parentId: string, opts: {
    specialist: SpecialistDefinition;
    prompt: string;
    workDir: string;
    parentToolCallId: string;
    // Task 14: the RESOLVED binding tools/task.ts already ran through
    // resolveDelegatedBinding, when a tier or specific model id was
    // requested. Absent (the pre-Task-14 default) means no override was
    // requested — falls back to the parent's own binding below, unchanged.
    binding?: ModelBinding;
  }): Promise<{ childId: string; title: string }> {
    const parent = this.live.get(parentId);
    // A child with no live parent has nobody to report to and nobody to tear it
    // down — refuse loudly rather than orphan a session.
    if (!parent) throw new Error(`Cannot start a specialist: parent session ${parentId} is not live.`);

    // Containment: the child may work in the parent's directory or a
    // subdirectory of it, never outside. Canonicalized through the SAME helper
    // the tool-layer guards use (forward slashes, `..` resolved, case-folded on
    // win32) so this check and checkPathGuard agree on what a path is; a raw
    // path.sep/startsWith comparison would disagree with the guards on Windows
    // and on any input containing `..`.
    const workDir = resolveP(opts.workDir, parent.cwd);
    if (!isUnderRoot(canonicalize(workDir, parent.cwd), canonicalize(parent.cwd, parent.cwd))) {
      throw new Error(`A specialist's work directory must be inside the parent session's directory (${parent.cwd}); got ${opts.workDir}.`);
    }

    const childId = randomUUID();
    // The child inherits the parent's preset (permission posture + manifest).
    // Its MODEL, since Task 14, is opts.binding when tools/task.ts resolved an
    // override (a designated tier, or a validated specific id) — falling back
    // to the parent's own binding exactly as every pre-Task-14 child did.
    const preset = resolvePreset(this.presetIdFor.get(parentId));
    const binding = opts.binding ?? parent.session.binding;
    const { contextLength, profile, pricing, free } = await this.resolveContextAndProfile(binding);

    // Task 8 (1a naming easter egg): drawn HERE, before the session is built,
    // rather than after as plan 1a originally had it — plan 1b's Task 8
    // (child asks route to the parent) needs `title` already in hand to wire
    // childAskRouter below, since the routed ask's card labels the specialist
    // by this same title. Purely in-memory (takenNamesOf), so moving it earlier
    // costs nothing and changes no observable behavior of the draw itself.
    let takenNames = this.takenNamesOf.get(parentId);
    if (!takenNames) { takenNames = new Set(); this.takenNamesOf.set(parentId, takenNames); }
    const { name, title } = assignSpecialistName(opts.specialist.id, takenNames);
    takenNames.add(name);

    // Build the session BEFORE writing the header: everything inside
    // buildSpecialistSession is fallible synchronous work (assembleSystemPrompt
    // shells out to git, buildTriggerIndex walks the tree), and a throw after
    // the header write would leave a session file on disk for a child that
    // never existed.
    const session = this.buildSpecialistSession(
      parentId, childId, workDir, title, opts.specialist, binding, contextLength, profile, pricing, free, opts.parentToolCallId, preset, parent,
    );

    // `title` was drawn earlier (before this session was built — see that
    // comment above) from the PARENT's taken-set (never global — see
    // takenNamesOf's own comment) and stamps into the header's existing
    // `title` field below. The transcript header/list machinery already reads
    // `title` for free (session-store.ts's list() title precedence), so this
    // needs no new plumbing beyond the header write below.
    await this.store.create({
      v: 1,
      sessionId: childId,
      harnessId: preset.manifest.id,
      binding,
      cwd: workDir,
      createdAt: Date.now(),
      title,
      parentSessionId: parentId,
      sessionKind: 'specialist',
      agentType: opts.specialist.id,
    });

    // NOT wire(). wire() re-emits the session's own events on the host emitter,
    // where ipc-handlers mints a conversation record and feeds the title feeder —
    // a child would surface as a conversation the user never started. The child
    // gets the persistence half only; the display half (stamped COPIES of the
    // display-safe events per isSubagentDisplayEvent, emitted under the
    // PARENT's id) is Task 7.
    this.wireChildLive(parentId, childId, workDir, session, binding, opts.parentToolCallId);
    return { childId, title };
  }

  /** Shared cold-start HarnessSession construction for a specialist child —
   *  used by createChild (a BRAND NEW child, Task 5) and resumeSpecialist (an
   *  EXISTING child rebuilt from its own JSONL, Task 6). Everything specific
   *  to "new vs resumed" (title draw + header WRITE vs. header READ + history
   *  rebuild, ledger recordStart vs. ledger status flip) stays in the two
   *  callers; this is only the tool/permission/prompt wiring both share,
   *  pulled out so the two paths cannot silently drift apart on allowlists,
   *  permission posture, or ask routing — the exact bug class a hand-copied
   *  second construction site would eventually reintroduce. */
  private buildSpecialistSession(
    parentId: string, childId: string, workDir: string, title: string, specialist: SpecialistDefinition,
    binding: ModelBinding, contextLength: number | null, profile: CapabilityProfile,
    // A specialist can run on a DIFFERENT model from its parent, so it carries
    // its own price — that is the whole reason a free local parent can still
    // ring up real money through a metered specialist (spec §5).
    pricing: ModelPricing | null, free: boolean,
    parentToolCallId: string, preset: ResolvedPreset, parent: LiveEntry,
  ): HarnessSession {
    const allowed = new Set(specialist.allowedTools);
    return new HarnessSession(
      {
        sessionId: childId, cwd: workDir, binding, contextLength, profile, pricing, free,
// WHY: specialist work is bounded by its narrow tool set, parent-managed
        // lifecycle controls, and the delegation spawn backstop—not an arbitrary
        // per-child action count, so root limits never flow into a child.
        harness: preset.manifest,
        // TOOLS: the definition's allowlist, filtered out of the same CORE_TOOLS
        // set every session is built from. The Task tool is structurally absent
        // because no definition lists it — that omission IS the depth-1 rule.
        // G-1: a helper allowed Bash gets the companions too — its own
        // background command would otherwise be unreadable and unstoppable.
        tools: CORE_TOOLS.filter((t) => allowed.has(t.name) || (allowed.has('Bash') && (t.name === 'BashOutput' || t.name === 'KillShell'))),
        // G-1: children get their OWN registry; their runs die with the child
        // under 'conversation-closed' when destroyChildrenOf tears them down.
        shells: this.shellsFor(childId),
        // COLD START (spec §1): the specialist body replaces the preset body, and
        // the <env> block describes the CHILD's work directory. Nothing from the
        // parent's conversation crosses over — the brief in the first user turn
        // is the entire context the child gets.
        systemPrompt: assembleSystemPrompt({
          presetBody: specialist.systemPrompt, cwd: workDir, appVersion: this.appVersion,
          promptVariant: profile.promptVariant, hasTools: profile.supportsTools,
          instructionBudgetTokens: profile.injectionBudgetTokens,
          // audience 'parent': the shared doctrine's writing-for-the-user block is
          // for the person; a specialist's reader is the parent model, and its
          // report rules live in specialists/builtins.ts.
          supportsParallelToolCalls: profile.supportsParallelToolCalls, audience: 'parent',
        }),
        // Project rules / nested instructions for the CHILD's directory. Project
        // state, not conversation state, so it does not violate the cold start —
        // and a Worker that edits files under rules the parent would have obeyed
        // must obey them too.
        triggers: buildTriggerIndex(workDir),
        // SKILL SUPPRESSION (cold-start contract): an explicit EMPTY catalog, not
        // an omission. syncSkillTool falls back to createSkillCatalog() — the full
        // installed catalog — whenever opts.skillCatalog is undefined, and it
        // re-syncs on every turn, so leaving this out would silently hand every
        // child the user's whole skill library.
        skillCatalog: { list: () => [], load: (id: string) => { throw new SkillNotFound(id, []); } },
        // MCP SUPPRESSION: create()/resume() call acquireMcp() at this point;
        // a specialist child (new OR resumed) deliberately never does, and
        // passes no mcpServers — so no MCP tools attach, and there is no lease
        // for destroy() to release.
        // PERMISSIONS: the parent's full configured stack, capped by the
        // definition. Built against the PARENT's id AND the PARENT's cwd, never
        // workDir — buildDecide keys the session's live permission mode by id and
        // remembered "Always allow" rules by cwd, and those grants follow the
        // project, not a subtree of it. `specialistScope` (Task 11) is this
        // child's OWN agentType — see buildDecide's own comment for why a
        // specialist-keyed rule must be scoped to this exact value.
        decide: buildChildDecide({
          parentDecide: this.buildDecide(parentId, parent.cwd, preset.presetRules, { specialistScope: specialist.id }),
          charter: specialist.charter,
          allowedTools: specialist.allowedTools,
          // envelopeGranted: true means the hire was PERMITTED, not that the user was necessarily
          // asked. Two ways that happens: (1) a Task-tool ask card (new spawn) or the original
          // spawn's ask card (resume) was answered — real consent; or (2) the active permission
          // mode allows Task outright with no pattern (auto-edit — see rulesForMode() in
          // permission-types.ts), so harness-session.ts resolves the hire straight to 'allow' and
          // no card is ever rendered. Path (2) has no explicit consent event; downstream
          // child-permissions.ts reads this flag to auto-allow the child's own tool calls either
          // way. Rewritten because this comment used to claim "the ask was the consent" as if
          // that were always true — it isn't on path (2).
          envelopeGranted: true,
        }),
        // ASKS (plan 1b Task 8): routed through the PARENT's broker under the
        // PARENT's sessionId — never the child's own (no window owns a raw
        // child id, so an ask emitted under it would never resolve; see
        // child-ask-router.ts). Held up to specialistAskHoldMs before the
        // child is unblocked with a scripted redirect; a later real answer
        // still reaches it (postSteer) or the parent (onLateResponse) either way.
        //
        // `remember` (Task 11, closes a review finding): a routed ask's own
        // "Always allow" makes HarnessSession emit 'remember-rule' on ITSELF,
        // exactly like a root session — but a specialist child is deliberately
        // never wire()'d (see wireChildLive's own "NOT wire()" comment), so
        // that event has no listener and the decision silently vanished.
        // The router persists it directly instead, through the SAME
        // rememberRule() helper wire()'s listener uses, against the PARENT's
        // id/cwd (never the child's own — buildDecide only ever reads
        // rememberedFor by the id it was BUILT with, which is parentId here).
        askUser: childAskRouter({
          broker: this.broker, parentId, childId, agentType: specialist.id, title,
          // Task 6: carried through so a routed ask's `specialist` payload
          // lets the renderer nest the row under the right specialist card.
          parentToolCallId,
          timeoutMs: this.specialistAskHoldMs,
          remember: (rule) => this.rememberRule(parentId, parent.cwd, rule),
        }),
        ...(this.toolServices ? { toolServices: this.toolServices } : {}),
        // BELT-AND-SUSPENDERS (Task 6): syncTaskTool's SECOND, independent
        // gate against depth-2 delegation. allowedTools filtering above
        // already keeps 'Task' out of a child's tool set structurally (no
        // SpecialistDefinition lists it) — this flag means a bug in that
        // filtering alone still cannot let a specialist spawn its own
        // specialists.
        isSpecialistChild: true,
      },
      this.modelFactory,
    );
  }

  /** Shared live-map wiring for a specialist child (new or resumed, Task 6) —
   *  the persistence + display half of standing a child up, split out of
   *  createChild so resumeSpecialist can reuse it exactly rather than
   *  hand-copying the append/stamp listener a second time.
   *
   *  NOT wire(). wire() re-emits the session's own events on the host emitter,
   *  where ipc-handlers mints a conversation record and feeds the title feeder
   *  — a child would surface as a conversation the user never started. This
   *  gives the child the persistence half only; the display half is the
   *  stamped COPY of the display-safe events (isSubagentDisplayEvent),
   *  emitted under the PARENT's id, below. */
  private wireChildLive(
    parentId: string, childId: string, workDir: string, session: HarnessSession, binding: ModelBinding, parentToolCallId: string,
  ): void {
    const entry: LiveEntry = {
      session, cwd: workDir, appendChain: Promise.resolve(), queue: [], inFlight: false,
      parentSessionId: parentId,
    };
    this.live.set(childId, entry);
    this.retainModel(childId, binding.modelId);
    let siblings = this.childrenOf.get(parentId);
    if (!siblings) { siblings = new Set(); this.childrenOf.set(parentId, siblings); }
    siblings.add(childId);
    session.on('transcript-event', (event: TranscriptEvent) => {
      // (1) PERSISTENCE — on the child's OWN chain, to the child's own JSONL,
      // with the ORIGINAL event (child sessionId) untouched. Same serialization
      // contract as wire()'s append, same swallow-and-log so one failed append
      // cannot wedge the chain. EVERY type lands here, including the ones that
      // are never re-emitted below: the child's file is the complete record the
      // report's "[full transcript: …]" pointer refers to.
      entry.appendChain = entry.appendChain
        .then(() => this.store.append(workDir, event))
        .catch((err) => {
          log('ERROR', 'NativeSessionHost', 'child append failed', {
            sessionId: childId, type: event.type, error: String(err),
          });
        });
      // (2) DISPLAY (Task 7) — a stamped COPY, for what the renderer's
      // subagent card consumes and NOTHING else (see isSubagentDisplayEvent /
      // SUBAGENT_DISPLAY_TYPES for what a stamped turn-complete would break,
      // and plan 1c's addition of text-bearing assistant-thinking).
      // The copy rides under the PARENT's session id, because that is the
      // session a window actually owns; `parentAgentToolUseId` threads it into
      // the parent's Task tool card and `agentId` identifies which child spoke.
      // The original is never mutated — the persisted event above and this copy
      // are two different objects on purpose.
      if (!isSubagentDisplayEvent(event)) return;
      this.emit('transcript-event', {
        ...event,
        sessionId: parentId,
        data: { ...event.data, parentAgentToolUseId: parentToolCallId, agentId: childId },
      } satisfies TranscriptEvent);
    });
  }

  /**
   * Restart recovery (Task 9) — reconcile this parent's delegation ledger
   * against reality the moment its session becomes live again. Three
   * independent passes, each individually guarded (a bookkeeping failure here
   * must never cost the user their session — the standing rule every other
   * ledger call in this file already follows):
   *
   *  1. A record still marked 'running' whose owner process is gone really
   *     did stop — nothing ever wrote its outcome, because the process that
   *     would have written it is the one that died. Marked 'interrupted'
   *     HONESTLY, never 'failed' or silently dropped: the child is an
   *     ordinary session the user can still pick back up by its task_id.
   *  2. A record holding a delivery LEASE (`claimedBy`) whose owner is dead
   *     has that lease released — delegation-ledger.ts's module comment: a
   *     claim is a lease, not a delivery, so a dead owner's lease must not
   *     block redelivery forever (the crash-between-claim-and-injection gap,
   *     external review 2026-08-12).
   *  3. A record that is 'completed' and undelivered is queued via the
   *     EXISTING delivery machinery (queueDelivery/drainDeliveries) so its
   *     report lands at the first idle boundary after resume — this never
   *     builds a second delivery path.
   *
   *  Only ever touches records whose owner FAILS isOwnerAlive — a lease or a
   *  'running' record belonging to a still-live process (including this
   *  process, mid-run) is left completely alone.
   */
  private async reconcileDelegations(parentId: string, cwd: string): Promise<void> {
    if (!this.ledger) return;
    let records: DelegationRecord[];
    try {
      records = this.ledger.listFor(cwd, parentId);
    } catch (err) {
      log('WARN', 'NativeSessionHost', 'reconcileDelegations: failed to read the ledger — skipping restart reconcile for this resume', { parentId, error: String((err as any)?.message ?? err) });
      return;
    }
    let hasUndelivered = false;
    for (const rec of records) {
      if (rec.status === 'running' && !isOwnerAlive(rec.owner)) {
        try {
          await this.ledger.update(cwd, parentId, rec.childId, { status: 'interrupted', endedAt: Date.now() });
        } catch (err) {
          log('WARN', 'NativeSessionHost', 'reconcileDelegations: failed to mark a dead-owner running child interrupted', { parentId, childId: rec.childId, error: String((err as any)?.message ?? err) });
        }
      }
      if (rec.claimedBy && !isOwnerAlive(rec.claimedBy)) {
        try {
          await this.ledger.releaseClaim(cwd, parentId, rec.childId);
        } catch (err) {
          log('WARN', 'NativeSessionHost', 'reconcileDelegations: failed to release a dead-owner delivery lease', { parentId, childId: rec.childId, error: String((err as any)?.message ?? err) });
        }
      }
      // Read from the ORIGINAL snapshot, not a re-fetch — a record just
      // marked 'interrupted' above can never also be 'completed'/'failed'
      // here, so there is no ordering hazard in checking the pre-reconcile
      // status.
      //
      // Fix (Important 4, final review): claimUndelivered's own eligibility
      // (delegation-ledger.ts) was deliberately widened to 'completed' OR
      // 'failed' — a dead background child still owes the parent a typed
      // failure notice, not silence. This flag stayed 'completed'-only, so a
      // parent whose ONLY undelivered record was 'failed' never got queued
      // after a restart: the ledger delivery lane was skipped entirely and
      // the failure notice never arrived, even though claimUndelivered itself
      // was perfectly willing to hand it over once asked.
      //
      // Fix (external review 2026-08-13, the foreground re-delivery finding):
      // `rec.background` gates this too, mirroring claimUndelivered's own new
      // gate — a foreground record can sit 'completed'/'failed' + undelivered
      // forever (delivery already happened inline as the tool result;
      // nothing ever calls confirmDelivered on the failure branch), and
      // that's expected, not a bug. Without this gate, reopening the
      // conversation would call queueDelivery() for a parent whose only
      // "undelivered" record claimUndelivered will now always refuse to
      // claim — harmless (the kicked pass would just find nothing), but a
      // wasted no-op turn on every resume, and untrue to this method's own
      // "queued ... so its report lands" class comment above.
      if (rec.background && (rec.status === 'completed' || rec.status === 'failed') && !rec.delivered) hasUndelivered = true;
    }
    // One call regardless of how many records are undelivered — queueDelivery
    // just marks the parent pending and kicks a pass if it's already idle;
    // drainDeliveries itself drains every eligible record in the ledger, not
    // just one.
    if (hasUndelivered) this.queueDelivery(parentId);
  }

  /** Rebuild a live session from its stored header + events. Returns false when
   *  no native session file exists for this id (caller should fall through).
   *  `bindingOverride` (Task 6 — resume-time model selector) wins over the
   *  persisted header binding when present. The stored header is NEVER
   *  rewritten (single-writer invariant, native-home.ts) — like the existing
   *  mid-session setBinding(), this override is in-memory only for the live
   *  session. It MUST be applied here, before returning, rather than via a
   *  post-resume setBinding: ipc-handlers.ts reads modelForSession() for the
   *  eager loadModel() the instant resume() resolves, and a later setBinding
   *  would race that read and load the header's (possibly wrong/absent) model
   *  first. */
  async resume(sessionId: string, cwd: string, bindingOverride?: ModelBinding): Promise<boolean> {
    // Same pre-live send holding as create() — resuming a big local model is
    // exactly as slow as creating one, and typing during it must not be told the
    // session is "no longer running".
    this.beginStarting(sessionId);
    try {
      return await this.resumeInner(sessionId, cwd, bindingOverride);
    } finally {
      if (!this.live.has(sessionId)) this.endStarting(sessionId);
    }
  }

  private async resumeInner(sessionId: string, cwd: string, bindingOverride?: ModelBinding): Promise<boolean> {
    // SINGLE-WRITER GUARD (2026-07-18): tear down any session already live under
    // this id BEFORE wiring a new one. Without this, resuming an id that is still
    // live leaves the old HarnessSession's transcript-event listener attached —
    // it closes over the OLD `entry`, so wire()'s `this.live.set` overwriting the
    // map entry does NOT stop it appending (see destroy()'s comment below). The
    // result was two writers on one JSONL, unordered against each other, breaking
    // the single-writer invariant at native-home.ts:5-7 that justifies the absence
    // of a file lock. Callers could orphan a session from several paths (takeover,
    // session-exit), so the guard lives HERE, at the one place a second writer can
    // actually be created, rather than in each caller.
    if (this.live.has(sessionId)) {
      log('WARN', 'NativeSessionHost', 'resume found a live session under the same id — destroying the orphan first', { sessionId });
      await this.destroy(sessionId);
    }
    const header = this.store.readHeader(sessionId, cwd);
    if (!header) return false;
    // Task 6 — a specialist child can never come back through the ROOT resume
    // path: it would get the resolved PRESET's prompt (never its own
    // specialist systemPrompt), no isSpecialistChild flag (so its Task-tool
    // depth-1 gate would be gone), and — because syncTaskTool only withholds
    // the Task tool FROM a flagged specialist child — could re-acquire the
    // Task tool it was deliberately built without. resumeSpecialist (the
    // task_id management surface, below) is the only door back in for a
    // specialist header.
    if (header.sessionKind === 'specialist') return false;
    // Read-side legacy mapping: a stored 'chat' header (or any unknown id)
    // resolves to Assistant. The stored header is NEVER rewritten (spec
    // decision 8) — the mapping lives only here + in presetIdFor.
    const preset = resolvePreset(header.harnessId);
    // MERGE RECONCILIATION (Plan C × M2): the capability profile must be resolved
    // for the binding we are ACTUALLY going to run, which is the resume-time
    // override when the user picked a model in the picker — not the one frozen in
    // the header. Profiling header.binding here would size the context window and
    // tool posture for the wrong model on every overridden resume.
    const binding = bindingOverride ?? header.binding;
    const { contextLength, profile, pricing, free } = await this.resolveContextAndProfile(binding);
    // Seed the STARTING mode from the resolved preset unless the caller already
    // set one for this id (an explicit setPermissionMode always wins).
    if (!this.modeFor.has(sessionId)) this.modeFor.set(sessionId, preset.defaultMode);
    // Task 4 (plan 1c) — same reasoning as create()'s own call: awaited BEFORE
    // toolWiring() reads this.specialistCatalog.roster(cwd) below, so a
    // resumed session's first turn never ships an empty roster either.
    await this.specialistCatalog.ensureFresh(cwd);
    // Acquire this session's MCP servers (Task 6). A RESUMED session reuses its
    // old sessionId, so this acquire() can overlap a release() still in flight
    // from a destroy() of the SAME id. That used to be the bug: both
    // generations wrote to one sessionId-keyed holder entry and the outgoing
    // destroy() closed the incoming session's connections. It is now safe
    // structurally — this acquire() mints its own lease, and the outgoing
    // destroy() can only release the lease on the LiveEntry it captured. See
    // McpLease in mcp-manager.ts.
    const mcpLease = await this.acquireMcp(sessionId);
    const mcpServers = mcpLease?.servers;
    const harness = header.stepGuard === undefined
      ? preset.manifest
      : { ...preset.manifest, limits: { ...preset.manifest.limits, maxSteps: header.stepGuard } };
    let session: HarnessSession;
    try {
      // Fix pass 1 / Finding 3 — same leak as create(): everything in this
      // block (construction, then the history rebuild) is fallible synchronous
      // work that runs after the mcp acquire() above but before wire() ever
      // registers this id in `this.live`. A throw anywhere in here — with no
      // catch — would strand the acquired MCP hold permanently (destroy()
      // early-returns for a non-live id). Release and rethrow the ORIGINAL
      // error unchanged (error-message-standards.md).
      session = new HarnessSession(
        // `binding` (not header.binding) — same override reason as above.
        { sessionId, cwd, harness, binding, contextLength, profile, pricing, free,
          ...(mcpServers ? { mcpServers } : {}),
          ...this.toolWiring(sessionId, cwd, preset, profile) },
        this.modelFactory,
      );
      // Full history rebuild (spec §2.5): rebuildHistory reconstructs the assistant
      // tool-call + tool-result pairs too (the old eventsToMessages dropped every
      // tool event, so a resumed tool turn lost its tool context). seedHistory
      // already clears readRegistry + todos (the reset-on-resume ruling) — those
      // are runtime state, never persisted. readImageFromDisk re-reads any
      // persisted attachment paths so images survive resume (#290 follow-up fix 2).
      session.seedHistory(rebuildHistory(this.store.readEvents(sessionId, cwd), readImageFromDisk));
    } catch (err) {
      await mcpLease?.release();
      throw err;
    }
    this.presetIdFor.set(sessionId, preset.manifest.id);
    this.wire(sessionId, cwd, session, mcpLease);
    // Task 9 — AFTER wire(), not before: reconcileDelegations's own
    // queueDelivery() call needs this.live.get(sessionId) to already resolve
    // (it reads/sets `entry.inFlight` to kick an immediate delivery pass when
    // the parent comes up idle), and wire() above is what puts the entry
    // there. A ledger/reconcile failure must never fail resume() itself —
    // reconcileDelegations already guards every fallible step internally, so
    // it is not wrapped in a try/catch here on top of that.
    await this.reconcileDelegations(sessionId, cwd);
    return true;
  }

  isNative(sessionId: string): boolean {
    return this.live.has(sessionId);
  }

  /** Is this id a native session AT ALL — live now, or persisted from any
   *  earlier run? isNative() only answers for LIVE sessions, which is the wrong
   *  question for the phantom-record gate: a past native session picked from the
   *  Resume Browser is not live, but must still never seed a CC store record. */
  isNativeSessionId(sessionId: string): boolean {
    return this.live.has(sessionId) || this.store.has(sessionId);
  }

  /** Send a user turn. SYNCHRONOUS and NEVER throws — the result says what
   *  happened to the CALL, not the turn: 'sent' means the turn was dispatched
   *  (not that it completed — a later provider/tool failure surfaces as a
   *  session-error transcript event, which the renderer already renders),
   *  'queued' means it was FIFO'd behind the in-flight turn (M1 send queue —
   *  a send during a live turn used to be silently dropped), 'failed' means it
   *  was refused outright (reason says why: unknown session, or the queue is
   *  already at SEND_QUEUE_LIMIT). HarnessSession.send() hard-throws on
   *  re-entrancy (a second send while a turn is in flight) — the host never
   *  calls it re-entrantly (inFlight gates that), so the only remaining throw
   *  surface is a provider-factory rejection, which runTurns catches. */
  send(sessionId: string, text: string, attachments: string[] = []): NativeSendResult {
    const entry = this.live.get(sessionId);
    if (!entry) {
      // Not live YET is not the same as not live any more. A session still being
      // built holds the message and delivers it the moment it is ready (see
      // startingSends). Only when that holding area is full does this refuse, and
      // it refuses with its own reason so the renderer can say "still starting"
      // instead of the flatly untrue "no longer running".
      const held = this.startingSends.get(sessionId);
      if (held) {
        if (held.length >= SEND_QUEUE_LIMIT) return { status: 'failed', reason: 'starting' };
        const queueId = randomUUID();
        held.push({ id: queueId, text, attachments });
        return { status: 'queued', queueId };
      }
      return { status: 'failed', reason: 'not-live' };
    }
    if (entry.inFlight) {
      if (entry.queue.length >= SEND_QUEUE_LIMIT) return { status: 'failed', reason: 'queue-full' };
      // Task 11: mint a stable id per queued entry so the renderer can target
      // this exact message later with removeQueued() (Cancel/Edit before send).
      const queueId = randomUUID();
      entry.queue.push({ id: queueId, text, attachments });
      return { status: 'queued', queueId };
    }
    entry.inFlight = true;
    // WHY: defer the turn dispatch one macrotask so the invoke reply (the renderer's
    // 'sent' ack) is flushed BEFORE HarnessSession emits the user-message transcript
    // event — otherwise the transcript confirm can beat the ack to the renderer and
    // duplicate the bubble (final-review finding, 2026-07-22). inFlight is set
    // synchronously above, so queueing semantics are unchanged. Edge: an interrupt
    // arriving inside this one-tick gap no-ops (abort doesn't exist yet) and the
    // turn still starts — same outcome as stopping a millisecond before sending.
    // Capture an awaitable handle on this turn's whole drain (current turn +
    // queued follow-ups) so quiesce()/teardown can await it settling. The
    // setImmediate defer is unchanged (see the WHY above); runTurns try/catches
    // its send() so this promise never rejects — .then(resolve, resolve) is
    // belt-and-suspenders against a future throw path.
    entry.running = new Promise<void>((resolve) => {
      setImmediate(() => { void this.runTurns(sessionId, entry, { text, attachments }).then(resolve, resolve); });
    });
    return { status: 'sent' };
  }

  /** Cancel/edit a queued-but-not-yet-sent message (Task 11). Sync findIndex +
   *  splice — the check-and-remove is atomic against the single-threaded drain
   *  loop, which only ever consumes the FRONT of `queue` via shift() (see
   *  runTurns): once splice() has run here, that entry can never be shifted
   *  out and sent, no matter how send()/runTurns interleave around it. Never
   *  throws; returns false (not true+error) for every "can't do that" case —
   *  the session isn't live, the id was never queued, or the drain already
   *  shift()'d it out (a real race the caller must handle, not a bug) — so the
   *  renderer's Cancel/Edit affordance can render a single "too late" toast
   *  without needing to distinguish the reason. */
  removeQueued(sessionId: string, queueId: string): boolean {
    // A message typed while the session was still starting is held OUTSIDE the
    // live entry (startingSends), and it is exactly the message a user is most
    // likely to want back — they have been staring at a spinner. Cancel/Edit has
    // to reach it there too, or it would report "too late" for a message that has
    // not been sent at all.
    const held = this.startingSends.get(sessionId);
    if (held) {
      const i = held.findIndex((q) => q.id === queueId);
      if (i !== -1) { held.splice(i, 1); return true; }
    }
    const entry = this.live.get(sessionId);
    if (!entry) return false;
    const idx = entry.queue.findIndex((q) => q.id === queueId);
    if (idx === -1) return false;
    entry.queue.splice(idx, 1);
    return true;
  }

  // Runs the dispatched turn, then drains the queue turn-by-turn. send() settling
  // is the ONLY drain trigger — it settles strictly after turn-complete /
  // session-error / user-interrupt, and stays unsettled across a permission ask
  // (an ask pauses the turn; draining on it would hard-throw re-entrancy).
  /** `first` is a plain string for an ordinary send, or a THUNK when the turn
   *  starts some other way — today only /skill-name, whose opener is
   *  `session.runSkill` (same turn machinery, different transcript event).
   *  Queued follow-ups are always plain sends, so queue semantics are unchanged. */
  private async runTurns(sessionId: string, entry: LiveEntry, first: SendUnit | (() => Promise<void>)): Promise<void> {
    // Fix (Task 4 fix pass 3): the WHOLE body is now wrapped in a single
    // try/finally so "every runTurns exit clears entry.inFlight" is true by
    // CONSTRUCTION — one statement, not a comment asserting a property the
    // code has to remember to uphold at every return/break/throw site. Before
    // this, `entry.inFlight = false` was a bare statement at the tail: a
    // throw from ANY of the unguarded `await this.ledger.*` calls inside the
    // delivery loop below (claimUndelivered at the top of the loop,
    // releaseClaim on either liveness-mismatch branch) propagated straight
    // out of this function, so that tail statement was never reached and the
    // session was permanently stuck "in flight" — the exact bug the loop
    // unification was meant to prevent, arriving by exception instead of by
    // `return`. The early `return` in the queue-drain loop below (destroy()
    // raced this turn) still runs this finally too, which is harmless: by
    // definition `this.live.get(sessionId) !== entry` there, so `entry` is
    // already a discarded object and setting its `inFlight` flag touches
    // nothing live.
    try {
      // Task 4 (plan 1c) — re-read this project folder's specialist catalog
      // before dispatching this pass's turn(s): a file dropped into a
      // specialists folder since the last turn is offered starting on THIS
      // turn, without a session restart. ONE call per runTurns invocation
      // (not per queued follow-up) — every turn drained in this same pass
      // shares the roster this one read resolved. ensureFresh()'s own
      // fingerprint check makes an unchanged folder cheap (a handful of
      // stat() calls, never a re-parse); it never throws (every fallible fs
      // call inside it is already individually guarded — see catalog.ts's
      // own WHY comments), so this is not wrapped in its own try/catch.
      // Fix (Task 4 review): gated on `!entry.parentSessionId` — ROOT sessions
      // ONLY. A specialist child DOES reach this function: runSpecialist's
      // runTurn() closure calls this.send(childId, ...), and send() dispatches
      // unconditionally into this.runTurns() for whatever id it's given, so
      // every child turn (the opening turn AND the empty-report nudge) used to
      // run this call too — an earlier comment here claimed otherwise, which
      // was simply wrong. The real reason to skip it for a child: its roster
      // is fixed at spawn (R12) and never read again — createChild builds a
      // child's tools by hand and never calls toolWiring(), so no child ever
      // consults this.specialistCatalog.roster(cwd) for ITS OWN cwd. Without
      // this gate, every child turn wrote a fresh entry into the catalog's
      // per-cwd cache (a Map with no eviction) for a cwd nothing will ever
      // read a roster for — often a work_dir narrowed to a subfolder nothing
      // else touches — so the cache grew forever across the process's life.
      if (!entry.parentSessionId) await this.specialistCatalog.ensureFresh(entry.cwd);
      let next: SendUnit | (() => Promise<void>) | undefined = first;
      while (next !== undefined) {
        // A user-started turn lifts the post-Stop hold: everything parked since
        // the Stop is spliced into history NOW, silently, so the model reads it
        // as context for this message rather than getting a turn of its own.
        // Checked per turn, not once per pass, because a message queued before
        // the Stop still runs after it (pinned: "the queue still drains").
        if (entry.holdDeliveries && next !== IDLE_PASS) {
          entry.holdDeliveries = false;
          await this.drainDeliveries(sessionId, entry, 'splice');
          if (this.live.get(sessionId) !== entry) return;
        }
        try {
          if (typeof next === 'function') await next();
          else await entry.session.send(next.text, next.attachments);
        } catch (err) {
          log('ERROR', 'NativeSessionHost', 'send failed', { sessionId, error: String(err) });
        }
        // Destroy() may have removed/replaced the entry mid-turn — stop draining then.
        if (this.live.get(sessionId) !== entry) return;
        // .text: queue entries are {id, text} (Task 11) — the id only matters to
        // removeQueued(); shift() here is what makes a removed entry unreachable.
        next = entry.queue.shift();
      }
      // Stop pressed during this pass: leave everything parked (holdDeliveries'
      // own WHY). The next user message drains it via the splice above.
      if (!entry.holdDeliveries) await this.drainDeliveries(sessionId, entry, 'turn');
    } finally {
      entry.inFlight = false;
    }
  }

  /** The idle-boundary delivery pass: drains both the durable ledger lane and
   *  the in-memory fallback lane for `sessionId` until neither has anything
   *  left, or a destroy() race stops the pass early. Split out of runTurns so
   *  the "no throw escapes, inFlight always clears" guarantee at that
   *  function's try/finally applies here as a BACKSTOP even though every
   *  ledger call below is already individually guarded — belt AND suspenders,
   *  not either/or: the per-call guards are what let a broken ledger lane
   *  still fall through to the fallback lane in the SAME pass (see below);
   *  the outer finally is what protects against a throw from anywhere this
   *  function didn't anticipate. */
  /** `mode` — 'turn': each notice is a real model turn (runNotice); 'splice':
   *  each notice is written into history and the transcript with NO model
   *  call (spliceNotice) — the post-Stop path, run right before the user's
   *  next message so the model reads the reports as that message's context. */
  private deliverNotice(entry: LiveEntry, mode: 'turn' | 'splice', text: string, meta?: InjectedMeta): Promise<void> {
    return mode === 'splice' ? entry.session.spliceNotice(text, meta) : entry.session.runNotice(text, meta);
  }

  private async drainDeliveries(sessionId: string, entry: LiveEntry, mode: 'turn' | 'splice'): Promise<void> {
    // Plan 1b Task 8: plain-text host notices drain FIRST, unconditionally —
    // no `this.ledger` gate, since this lane exists whether or not a
    // NativeHome/ledger was ever wired (see pendingHostNotices' own WHY).
    // Same destroy()-race shape as the ledger loop below: recheck liveness
    // before AND after the injecting await, and leave the text in place
    // (don't shift it off) on either a destroy race or a genuine runNotice
    // failure, so the next idle boundary retries it.
    const notices = this.pendingHostNotices.get(sessionId);
    if (notices) {
      while (notices.length > 0) {
        if (this.live.get(sessionId) !== entry) break;
        // D8: every shell notice already queued goes out as ONE turn — each
        // runNotice is a full model turn over the whole conversation, so three
        // builds finishing during one busy turn must not cost three turns.
        // Specialist follow-ups keep their one-per-turn shape.
        const head = notices[0];
        const headIsShell = head.meta?.kind === 'shell';
        const batch = headIsShell ? notices.filter((n) => n.meta?.kind === 'shell') : [head];
        const text = batch.map((n) => n.text).join('\n\n');
        const meta: InjectedMeta | undefined = headIsShell
          ? { kind: 'shell', runs: batch.flatMap((n) => (n.meta?.kind === 'shell' ? n.meta.runs : [])) }
          : head.meta;
        try {
          await this.deliverNotice(entry, mode, text, meta);
        } catch (err) {
          log('WARN', 'NativeSessionHost', 'host notice delivery failed — will retry at the next idle boundary', { sessionId, error: String((err as any)?.message ?? err) });
          break;
        }
        if (this.live.get(sessionId) !== entry) break; // destroy raced the notice itself
        for (const n of batch) { const i = notices.indexOf(n); if (i >= 0) notices.splice(i, 1); }
      }
      if (notices.length === 0) this.pendingHostNotices.delete(sessionId);
    }
    // WHY (spec §3, Task 4): background completions inject as a synthetic
    // user-role turn at an idle boundary — never spliced mid-turn (role
    // alternation + local prompt cache). A claim is a LEASE: delivered flips
    // only after the injected turn has run. A crash between claim and
    // injection leaves a dead-owner lease that Task 9's reconcile releases —
    // the report is re-delivered after restart, never lost. Guarded on
    // `pendingDeliveryParents.has(sessionId)` first (cheap, in-memory) so this
    // never pays for a ledger read on the common case (a session with no
    // specialists, ever).
    if (this.ledger && this.pendingDeliveryParents.has(sessionId)) {
      // Snapshotted ONCE, before the pass starts: every report drained in
      // THIS pass shares the parent's headroom together, so each is formatted
      // as if all of them are landing at once — not optimistically
      // re-measured smaller after an earlier one in the SAME pass has already
      // been confirmed delivered (the 1a arithmetic pin: computeReportBudget
      // splits headroom across CONCURRENT reporters, and everything queued
      // here became concurrent the moment it queued while the parent was busy).
      // Counts only 'completed' records: a 'failed' record's notice is a
      // short, fixed string built straight from failureText in formatDelivery
      // — it never goes through formatSpecialistReport's budget math, so it
      // isn't a "reporter" competing for headroom in the sense this count means.
      // Includes the in-memory fallback lane's own 'completed' entries for
      // this parent (Task 4 fix-pass 2) — those are just as much competing
      // for the same headroom in this pass as a ledger-backed one is.
      //
      // Fix (Task 4 fix pass 4, Finding 5): `this.ledger.listFor(...)` reads
      // the sidecar file straight off disk (NativeHome.readJson) and CAN
      // throw on a real I/O error (anything but ENOENT rethrows — see its
      // own comment) — unlike every ledger call inside the while loop below,
      // this one was unguarded, so a throw here escaped this whole function
      // before the loop even started, with nothing to log it: not a wedge
      // (runTurns' outer finally still clears inFlight) and not a lost
      // report (the pending flag is untouched, so the next idle boundary
      // retries) — but silent, unlike every other ledger failure in this
      // file. Guarded here the same way: log, then degrade to the
      // single-reporter default rather than let a purely cosmetic budget
      // computation abort a delivery pass that could otherwise still
      // succeed via claimUndelivered/takeInMemoryFallback below.
      let concurrentReporters = 1;
      try {
        const fallbackCompletedForParent = [...this.inMemoryFallback.values()]
          .filter((e) => e.parentId === sessionId && e.rec.status === 'completed').length;
        concurrentReporters = Math.max(1, fallbackCompletedForParent + this.ledger.listFor(entry.cwd, sessionId)
          .filter((d) => d.status === 'completed' && !d.delivered).length);
      } catch (err) {
        log('WARN', 'NativeSessionHost', 'failed to compute concurrentReporters for this delivery pass — defaulting to 1 (a report may be formatted as if it were the only one landing)', { sessionId, error: String((err as any)?.message ?? err) });
      }
      // ONE loop drains both lanes: the ledger (durable, tried first every
      // iteration) and the in-memory fallback (Task 4 fix-pass 2 — tried only
      // once the ledger has nothing left to claim). A single loop, rather
      // than two sequential ones, is what keeps every `break` below reaching
      // the SAME `entry.inFlight = false` at the bottom — an early `return`
      // here would leave a session permanently stuck "in flight".
      while (this.pendingDeliveryParents.has(sessionId)) {
        // Fix (Task 4 fix pass 3): claimUndelivered itself can throw under the
        // exact systemic failure (disk full, corrupt sidecar, lock
        // exhaustion) the in-memory fallback lane exists to survive — and it
        // runs at the TOP of every iteration, before the fallback lane below
        // gets a turn. Guarding it here (rather than leaving it unguarded, as
        // it was pre-fix) is what stops that throw from both wedging the
        // session (now also backstopped by runTurns' outer finally) AND, more
        // subtly, from stranding a report already sitting safely in
        // `inMemoryFallback` by never letting this pass reach it. Treat "the
        // ledger threw" the same as "the ledger has nothing claimable this
        // iteration" — `rec` stays null and control falls through to the
        // fallback lane below in the SAME iteration.
        let rec: DelegationRecord | null = null;
        try {
          rec = await this.ledger.claimUndelivered(entry.cwd, sessionId);   // lease, not delivery
        } catch (err) {
          log('WARN', 'NativeSessionHost', 'claimUndelivered failed — falling back to the in-memory lane for this pass', { sessionId, error: String((err as any)?.message ?? err) });
        }
        if (rec) {
          // Fix (Task 4 fix-pass, finding 3): destroy() (direct, or via
          // destroyAll() at app shutdown, which has no in-flight gate) can
          // land in the gap between any of this loop's awaits. destroy() sets
          // no "destroyed" flag anything here checks — it aborts the stream
          // and removeAllListeners()s the session (THAT is what actually
          // stops transcript appends being persisted), then drops it from
          // `this.live`. So `entry` can go on being a perfectly usable,
          // callable object pointing at an orphaned session that no longer
          // persists or emits anything — runNotice() on it would resolve
          // normally, having shown the report to nobody. The sibling
          // queue-drain loop above guards the exact same race with
          // `this.live.get(sessionId) !== entry`; this recheck is that same
          // guard, run before every remaining step so a destroy mid-delivery
          // releases the claimed lease (leaving the record claimable again
          // for the next real delivery pass) instead of either silently
          // confirming a report nobody saw or losing the lease forever.
          if (this.live.get(sessionId) !== entry) {
            await this.releaseClaimSafely(entry.cwd, sessionId, rec.childId);
            break;
          }
          // Fix pass 5: stamp the durable "about to inject" marker strictly
          // BEFORE calling runNotice() — never after. HarnessSession.beginTurn
          // (harness-session.ts) emits the transcript event SYNCHRONOUSLY,
          // before its own first await, so by the time runNotice()'s
          // returned promise has even begun its async work the injection has
          // either already happened or (only its re-entrancy guard, which
          // cannot fire here — this loop only calls runNotice() at an idle
          // boundary) never will. This is what lets claimUndelivered tell a
          // claim that never reached runNotice() apart from one that did.
          //
          // If THIS write itself throws, we can't learn afterward whether it
          // committed (see markInjectionAttempted's own comment for the full
          // reasoning) — logged, and deliberately NOT treated as a reason to
          // abandon this delivery attempt: proceeding to runNotice() anyway.
          // Tracked so the catch below can say something TRUE about whether
          // a later failure is retryable, instead of assuming it always is
          // (final-review fix — see that catch's own comment).
          let injectionMarkerStamped = true;
          try {
            await this.ledger.markInjectionAttempted(entry.cwd, sessionId, rec.childId);
          } catch (err) {
            injectionMarkerStamped = false;
            log('WARN', 'NativeSessionHost', 'markInjectionAttempted failed — proceeding with delivery anyway; see markInjectionAttempted\'s own comment for the residual duplicate risk this can leave', { childId: rec.childId, parentId: sessionId, error: String((err as any)?.message ?? err) });
          }
          try {
            const delivery = this.formatDelivery(sessionId, entry.cwd, rec, concurrentReporters);
            // Task 10: a NEWLY-created truncation-time spill (delivery.reportPath
            // absent from the claimed record) gets recorded in the ledger too —
            // own try/catch, log-only: a bookkeeping failure here must never
            // block the delivery itself, which already has the right path in
            // hand for THIS injection either way.
            if (delivery.reportPath && delivery.reportPath !== rec.reportPath) {
              try {
                await this.ledger.update(entry.cwd, sessionId, rec.childId, { reportPath: delivery.reportPath });
              } catch (err) {
                log('WARN', 'NativeSessionHost', 'failed to record a truncation-time spill path in the ledger', { childId: rec.childId, parentId: sessionId, error: String((err as any)?.message ?? err) });
              }
            }
            await this.deliverNotice(entry, mode, delivery.text, {
              // Header data for the renderer's compact SpecialistReportCard —
              // from the ledger record, the same source formatDelivery's prose
              // is written from, so header and body can never disagree.
              childId: rec.childId, title: rec.title, agentType: rec.agentType,
              description: rec.description, status: rec.status === 'failed' ? 'failed' : 'completed',
              ...(rec.steps !== undefined ? { steps: rec.steps } : {}),
              parentToolCallId: rec.parentToolCallId,
            });
            // Recheck AGAIN: destroy() can land during the runNotice() await
            // itself (no throw, per the WHY above), so confirmDelivered must
            // never be reached on a session that stopped being live while the
            // notice was in flight.
            if (this.live.get(sessionId) !== entry) {
              await this.releaseClaimSafely(entry.cwd, sessionId, rec.childId);
              break;
            }
            await this.ledger.confirmDelivered(entry.cwd, sessionId, rec.childId); // only now is it delivered
            // A ledger write CAN still land after all — the in-memory
            // fallback (Task 4 fix-pass 2) only exists for the window where
            // it didn't; clean up any leftover entry for the same child so it
            // can never be double-delivered by the fallback lane below.
            this.inMemoryFallback.delete(rec.childId);
            continue; // more ledger records may remain — try the ledger again before falling to the fallback lane
          } catch (err) {
            // Fix (Task 4 fix pass 3): releaseClaimSafely (not a bare await)
            // — this catch already fires from a genuine failure (runNotice or
            // confirmDelivered threw); a SECOND throw from the release call
            // itself must not escape and skip the `break` below, which is
            // what lets the fallback lane still run this same pass.
            await this.releaseClaimSafely(entry.cwd, sessionId, rec.childId);
            // Final-review fix: this used to unconditionally say "will retry
            // at the next idle boundary". That was false in the dominant
            // case — markInjectionAttempted (above) durably stamps
            // injectionAttempted BEFORE runNotice() is ever called, and
            // claimUndelivered's eligibility filter (delegation-ledger.ts)
            // excludes any record with injectionAttempted set, no matter
            // what releaseClaimSafely just did to the lease. Once that
            // marker landed, THIS record can never be reclaimed again — the
            // release above only frees a lease nothing is allowed to grab.
            // The message now says what's actually true given whether the
            // marker write above succeeded; it is internal-log-only, but
            // it's exactly the line a future session would trust while
            // debugging a "report never arrived" complaint.
            const retryNote = injectionMarkerStamped
              ? 'the injection marker was already stamped before this failure, so claimUndelivered will never reclaim this record again — this report will not be retried'
              : 'markInjectionAttempted itself failed above, so this record MAY still be reclaimed at the next idle boundary (not guaranteed — see markInjectionAttempted\'s own comment on the ambiguity when its own write fails)';
            log('WARN', 'NativeSessionHost', `background specialist delivery failed — ${retryNote}`, { childId: rec.childId, parentId: sessionId, error: String((err as any)?.message ?? err) });
            break;
          }
        }
        // Ledger has nothing more claimable this pass — second-choice lane:
        // a report whose completion write never landed on disk still needs
        // to reach the parent THIS session (see inMemoryFallback's own WHY
        // for what that guarantees and what it genuinely does not).
        //
        // Unlike claimUndelivered/confirmDelivered/releaseClaim above,
        // takeInMemoryFallback does no I/O — it's a synchronous for..of over
        // a plain in-memory Map plus a .delete(). Nothing here can throw
        // (short of an engine-level OOM, which no try/catch in this file
        // handles either), so it isn't wrapped like the disk-backed calls
        // are — a try/catch here would guard a path that cannot fire, not
        // add resilience (fix pass 5, replacing an earlier version of this
        // comment that argued for the guard on file-wide-consistency grounds
        // alone while admitting the same thing).
        const fallback = this.takeInMemoryFallback(sessionId);
        if (!fallback) { this.pendingDeliveryParents.delete(sessionId); break; }
        // Same destroy()-race guard as the ledger path above.
        if (this.live.get(sessionId) !== entry) {
          this.inMemoryFallback.set(fallback.childId, { parentId: sessionId, rec: fallback.rec }); // put it back — never delivered, so never drop it
          break;
        }
        try {
          // Task 10: no ledger persistence attempt here for a newly-spilled
          // reportPath — unlike the claimed-record path above, `fallback.rec`
          // has no live ledger row in a deliverable state to attach it to (see
          // this lane's own WHY, right above); the correct path is still what
          // lands in THIS injection's footer either way.
          await this.deliverNotice(entry, mode, this.formatDelivery(sessionId, entry.cwd, fallback.rec, concurrentReporters).text);
          if (this.live.get(sessionId) !== entry) {
            // destroy() landed mid-notice: runNotice on a torn-down session
            // resolves normally without showing the report to anyone (same
            // "no throw" shape the ledger path's own recheck guards against)
            // — put the entry back so a later pass can still try.
            this.inMemoryFallback.set(fallback.childId, { parentId: sessionId, rec: fallback.rec });
            break;
          }
          // Delivered — this was the ONLY copy (nothing durable backs it), so
          // it is intentionally NOT put back. There is no confirmDelivered to
          // call: there is no ledger record in a deliverable state for it.
        } catch (err) {
          // Delivery genuinely failed (not a destroy race) — put it back so
          // the next idle boundary retries it, same as the ledger path's
          // releaseClaim.
          this.inMemoryFallback.set(fallback.childId, { parentId: sessionId, rec: fallback.rec });
          log('WARN', 'NativeSessionHost', 'in-memory fallback specialist delivery failed — will retry at the next idle boundary', { childId: fallback.childId, parentId: sessionId, error: String((err as any)?.message ?? err) });
          break;
        }
      }
    }
    // No `entry.inFlight = false` here — that guarantee now lives ONLY in
    // runTurns' outer try/finally (the whole point of this fix pass: one
    // control-flow guarantee, not a statement duplicated at every function
    // that happens to precede it).
  }

  /** Best-effort release of a delivery-claim lease: swallows a throw from the
   *  ledger itself rather than letting it propagate.
   *
   *  WHY this needs to exist — NOT what an earlier version of this comment
   *  claimed. All three call sites in drainDeliveries `break` UNCONDITIONALLY
   *  right after calling this, regardless of whether the release itself
   *  succeeds: every one of them exits the delivery `while` loop outright: the
   *  fallback lane is only ever reached through the DIFFERENT branch at the
   *  top of that loop (where `rec` came back null), never by falling through
   *  from here. And runTurns' own outer try/finally (fix pass 3) already
   *  guarantees `entry.inFlight` clears even if this were a bare, unguarded
   *  `await this.ledger.releaseClaim(...)`. So this helper is not load-bearing
   *  for either of those.
   *
   *  What it DOES earn its place for: every other ledger call in this file
   *  logs its own failure on the way out (recordDelegationStart,
   *  runDelegation, spawnSpecialist above). Without this wrapper, a
   *  releaseClaim failure would be the one ledger call in the file that fails
   *  SILENTLY — the throw would propagate out of drainDeliveries and then out
   *  of runTurns with nothing left to log it, and it would never even surface
   *  as a rejection for anything to notice: both places that build
   *  `entry.running` resolve on rejection too (`.then(resolve, resolve)`), so
   *  the error would vanish with no record anywhere, not even a delayed one.
   *  Not releasing leaves the lease claimed by this (live) session's owner
   *  marker, so claimUndelivered won't reclaim it until this session dies
   *  (Task 9's dead-owner reconcile) or a later pass recognizes it as this
   *  same process's own stale lease (fix pass 4's self-claim branch in
   *  claimUndelivered) — an honest degradation, not a silent one; logged here
   *  so it's actually visible. */
  private async releaseClaimSafely(parentCwd: string, parentId: string, childId: string): Promise<void> {
    try {
      await this.ledger?.releaseClaim(parentCwd, parentId, childId);
    } catch (err) {
      log('WARN', 'NativeSessionHost', 'releaseClaim failed — the delivery lease may stay held until owner-liveness reconcile releases it', { parentId, childId, error: String((err as any)?.message ?? err) });
    }
  }

  /** User-initiated /compact for a native session (M3 item 2). Returns a coded
   *  result rather than a bare boolean so the renderer can say WHY nothing
   *  happened — this path exists specifically to replace a silent no-op.
   *
   *  Refuses while a turn is in flight (including one still draining the M1
   *  queue): compaction rewrites `history`, and doing that underneath a running
   *  turn would corrupt the tool-call/result pairing the whole driver depends on.
   *  The session's own re-entrancy guard is the backstop, but refusing here means
   *  the user gets a real explanation instead of a thrown error. */
  async compact(sessionId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const entry = this.live.get(sessionId);
    if (!entry) return { ok: false, reason: 'not-live' };
    if (entry.inFlight || entry.queue.length > 0) return { ok: false, reason: 'turn-in-flight' };
    return entry.session.compactNow();
  }

  /** User-initiated /clear for a native session (M3 item 2) — a context BARRIER,
   *  not a deletion. Same refusal discipline as compact(): a clear that landed
   *  mid-turn would drop the history the running turn is still appending to. */
  clear(sessionId: string): { ok: true } | { ok: false; reason: string } {
    const entry = this.live.get(sessionId);
    if (!entry) return { ok: false, reason: 'not-live' };
    if (entry.inFlight || entry.queue.length > 0) return { ok: false, reason: 'turn-in-flight' };
    return entry.session.clearHistory();
  }

  /** User-initiated /skill-name for a native session (M3 item 1).
   *
   *  The path that works on EVERY model: the Skill TOOL is withheld from small
   *  windows because its catalog would ride every turn, but one explicit
   *  invocation costs a single injection and is affordable anywhere.
   *
   *  Sends the skill's body as an ordinary turn, so it persists to the session
   *  JSONL through the normal `send` path — no new event type, and a resume
   *  replays it like any other message (Global Constraint 2).
   *
   *  Bounded by the profile's injection budget: a long SKILL.md on a small model
   *  would otherwise crowd out the conversation it is meant to act on. */
  async invokeSkill(sessionId: string, skill: string, args?: string): Promise<{ ok: true } | { ok: false; reason: string; detail?: string }> {
    const entry = this.live.get(sessionId);
    if (!entry) return { ok: false, reason: 'not-live' };
    // Same refusal discipline as compact/clear: queueing this would land the
    // instructions after work that was started without them.
    if (entry.inFlight || entry.queue.length > 0) return { ok: false, reason: 'turn-in-flight' };

    let loaded;
    try {
      // Match the session's Skill tool: a slash invocation must see this
      // project's .claude/skills too, including on smaller models without Skill.
      loaded = (this.skillCatalog ?? createSkillCatalog(undefined, entry.cwd)).load(skill);
    } catch (err: any) {
      // SkillNotFound is the ordinary case — the user typed a Claude Code command
      // or a skill they haven't installed — so it is a coded refusal, not an error.
      const reason = err?.name === 'SkillNotFound' ? 'not-a-skill'
        : err?.name === 'SkillUnreadable' ? 'unreadable'
        : err?.name === 'SkillAmbiguous' ? 'ambiguous'
        : 'error';
      return { ok: false, reason, detail: err?.message ?? String(err) };
    }

    const fitted = fitInjection(loaded.body, entry.session.profileSnapshot.injectionBudgetTokens);
    // runSkill, NOT send: the model needs the instructions but the TIMELINE needs
    // to show what the user did. Sending the body through send() rendered a 26k
    // character SKILL.md as a chat bubble (Destin, 2026-07-28).
    // frameSkillInvocation owns the wording, which IS the mechanism here — see
    // its header. It also places the user's own args last.
    const body = frameSkillInvocation(loaded.id, fitted.text, args);

    entry.inFlight = true;
    // Same setImmediate defer as send(): the IPC reply must flush BEFORE the
    // session emits its transcript event, or the confirm can beat the ack to the
    // renderer. runTurns owns inFlight teardown and queue draining from here.
    setImmediate(() => {
      void this.runTurns(sessionId, entry, () => entry.session.runSkill({
        skillId: loaded.id,
        displayName: loaded.displayName,
        body,
        // NOT passed to runSkill: frameSkillInvocation already placed them last
        // inside `body`. Passing them here too would repeat the user's words.
        skillPath: loaded.file,
      }));
    });
    return { ok: true };
  }

  interrupt(sessionId: string): boolean {
    // Cascade to this session's FOREGROUND specialist children only (plan 1b,
    // external review 2026-08-12 — deliberate change from 1a's unconditional
    // cascade): a foreground child's turn is work the parent is BLOCKED on
    // (the Task tool awaits it), so Stop has to reach it or the parent keeps
    // waiting on a run the user just cancelled. A BACKGROUND child is not
    // blocking anything — the Task call already returned — so stopping the
    // parent's TURN must not fire a researcher that is still working;
    // background survives the Stop button (destroy()/quiesce() teardown below
    // still takes every child down, foreground or background). Foreground/
    // background is read synchronously off the ledger (interrupt() cannot do
    // disk I/O — see childrenOf's own comment above); no record for a child
    // (an untracked child, or a test host with no ledger injected) defaults
    // to cascading, matching every child's behavior before this change.
    //
    // Interrupt only — NOT destroy: this method is synchronous (destroy() is
    // async, and a floating destroy promise in the main process is exactly the
    // bug class `npm run lint` gates on), and Stop means "abort the work", not
    // "delete the session". The child is torn down with its parent (destroy /
    // quiesce below, both async) or by the Task tool's own finalizer.
    const parentCwd = this.live.get(sessionId)?.cwd;
    // Fix (review round 2, Finding 3): hoisted OUT of the loop below. This
    // used to call listFor() — a synchronous file read + JSON parse of the
    // WHOLE sidecar — once PER CHILD, so a parent with N children did N
    // redundant reads of the identical file on every Stop press. One read,
    // shared by every iteration below via a childId lookup.
    const records = this.ledger && parentCwd ? this.ledger.listFor(parentCwd, sessionId) : [];
    for (const childId of this.childrenOf.get(sessionId) ?? []) {
      const rec = records.find((r) => r.childId === childId);
      if (rec?.background) continue; // still working — the Stop button doesn't touch it
      this.interrupt(childId);
    }
    const entry = this.live.get(sessionId);
    // Cancel pending asks FIRST (resolve them 'canceled') so a loop paused on a
    // permission await unwinds cleanly before the stream is aborted underneath
    // it (spec pending-ask ruling). Also expires the renderer's approval cards.
    this.broker.cancelSession(sessionId);
    entry?.session.interrupt();
    // Stop means quiet until the user speaks again (LiveEntry.holdDeliveries).
    // Root sessions only: a child's own deliveries go to its parent, not to it.
    if (entry && !entry.parentSessionId) entry.holdDeliveries = true;
    return !!entry;
  }

  /** Manual Retry from the stalled card. Unlike interrupt(), this does NOT
   *  cascade to specialist children and does NOT cancel pending asks: only the
   *  ONE parked step re-runs, and everything else about the turn is untouched.
   *  Returns false when nothing was parked (the stream resumed first). */
  retryStalledStep(sessionId: string): boolean {
    return this.live.get(sessionId)?.session.retryStalledStep() ?? false;
  }

  /** Takeover/teardown quiesce (Task 9). STRONGER than interrupt() and ONLY for
   *  takeover/teardown — never the user-facing Stop button (that's interrupt()).
   *
   *  WHY stronger: interrupt() aborts only the CURRENT turn and lets the M1 FIFO
   *  queue keep draining (pinned by native-session-host.test.ts "interrupt aborts
   *  the current turn only"). For a takeover that is WRONG — a queued message
   *  would start a NEW turn AFTER the flush and append PAST it, corrupting the
   *  transcript the requester is about to pull. quiesce guarantees the opposite:
   *  after it resolves, NO further appends happen for this session until a new send.
   *
   *  Order is load-bearing:
   *   1. Clear the queue SYNCHRONOUSLY so no queued message can start a post-flush
   *      turn. The queue-remove surface (removeQueued) tracks no promises — a
   *      queued send returned 'queued' synchronously with nothing awaiting it — so
   *      dropping the array IS the whole cancel; there is nothing to resolve/refuse.
   *   2. Await one macrotask so a send() issued in the SAME tick as this quiesce
   *      has run its setImmediate dispatch (send() defers runTurns one macrotask —
   *      see send()). Interrupting before that dispatch would MISS the turn: the
   *      AbortController doesn't exist until runTurns actually starts it.
   *   3. cancelSession (resolve a paused permission ask 'canceled', expire its
   *      card) + session.interrupt() (abort the in-flight stream) — same pair as
   *      interrupt(), so a loop paused on an ask unwinds before the stream aborts.
   *   4. Await the in-flight turn chain settling (entry.running): runTurns exits
   *      after the interrupted turn emits user-interrupt and the (now-empty) queue
   *      drains. This is the step interrupt() does NOT do — it is what makes the
   *      "no appends after quiesce" invariant hold.
   *   5. Await the append chain (drain) so every already-enqueued append lands on
   *      disk before the caller flushes the transcript to the space. */
  async quiesce(sessionId: string): Promise<void> {
    const entry = this.live.get(sessionId);
    if (!entry) return;
    entry.queue.length = 0;                        // (1) no post-flush turn can start
    // (1b) Tear down specialist children before quiescing this session: a
    // running child keeps appending to ITS file and keeps the parent's Task call
    // pending, both of which contradict what quiesce promises the caller (no
    // further work for this session once it resolves). Safe to await here —
    // the queue is already cleared, so nothing can start a new parent turn.
    await this.destroyChildrenOf(sessionId);
    await new Promise((r) => setImmediate(r));      // (2) let a same-tick send dispatch
    this.broker.cancelSession(sessionId);           // (3) unwind a paused permission ask
    entry.session.interrupt();                      //     abort the in-flight turn
    try { await entry.running; } catch { /* runTurns never rejects; belt-and-suspenders */ } // (4)
    await this.drain(sessionId);                    // (5) flush already-enqueued appends
  }

  /** Mid-session model swap (next turn uses the new binding). */
  async setBinding(sessionId: string, binding: ModelBinding): Promise<boolean> {
    const entry = this.live.get(sessionId);
    if (!entry) return false;
    const oldModelId = entry.session.binding.modelId;
    // Re-resolve BOTH context + profile on a swap: a cloud → small-local swap
    // (or vice versa) crosses capability tiers, so the driver must pick up the
    // new doom-loop window / tool posture on the next turn.
    const { contextLength, profile, pricing, free } = await this.resolveContextAndProfile(binding);
    entry.session.setBinding(binding, contextLength, profile, pricing, free);
    if (oldModelId !== binding.modelId) {
      // Swap the ref-count: releasing the old model may unload it if this was
      // its last session (#1); retain the new one so it isn't unloaded.
      this.retainModel(sessionId, binding.modelId);
      this.releaseModel(sessionId, oldModelId);
    }
    return true;
  }

  getBinding(sessionId: string): ModelBinding | null {
    return this.live.get(sessionId)?.session.binding ?? null;
  }

  /** Replay source for a native session. null for unknown/non-native ids so
   *  the caller (TRANSCRIPT_REPLAY) falls through to the CC transcript watcher.
   *
   *  Task 9 — card replay: any specialist this parent ever delegated to gets
   *  its display-safe events spliced back in via mergeChildEvents (see that
   *  function's own WHY), so a subagent card the user saw live still shows
   *  its work after an app restart. `this.ledger.listFor` reads the sidecar
   *  straight off disk and CAN throw on a real I/O error (same
   *  non-ENOENT-rethrows contract as every other ledger read in this file,
   *  e.g. drainDeliveries) — guarded the same way: log and fall back to the
   *  parent's own events alone, because a broken ledger read must degrade
   *  replay, never break it outright. */
  /**
   * Perf cycle 2: one page of a native session's history — the last PAGE_TURNS
   * user turns before `beforeIndex` (null = the end). Returns null for a
   * non-native id, exactly like getHistory.
   *
   * Windows the ALREADY-MERGED event array rather than paging the store's raw
   * lines: mergeChildEvents interleaves each delegated child's events into the
   * parent's, so slicing before the merge would drop a child whose parent card
   * is in the page. Native transcripts are small (<=3 MB), so a full read +
   * slice is cheap; a true byte-tail reader is a later optimisation.
   *
   * The "cursor" is an ARRAY INDEX, not a byte offset. The renderer treats the
   * cursor as opaque, so the two source kinds can disagree about what it means.
   */
  getHistoryPage(sessionId: string, beforeIndex: number | null): { events: TranscriptEvent[]; nextIndex: number | null; hasMore: boolean } | null {
    const all = this.getHistory(sessionId);
    if (all === null) return null;
    const end = beforeIndex == null ? all.length : Math.min(beforeIndex, all.length);
    if (end <= 0) return { events: [], nextIndex: null, hasMore: false };
    let boundaries = 0;
    let start = 0;
    for (let i = end - 1; i >= 0; i--) {
      if (all[i].type === 'user-message') {
        boundaries++;
        if (boundaries === PAGE_TURNS) { start = i; break; }
      }
    }
    const hasMore = start > 0;
    return { events: all.slice(start, end), nextIndex: hasMore ? start : null, hasMore };
  }

  getHistory(sessionId: string): TranscriptEvent[] | null {
    const entry = this.live.get(sessionId);
    if (!entry) return null;
    const parentEvents = this.store.readEvents(sessionId, entry.cwd);
    if (!this.ledger) return parentEvents;
    let records: DelegationRecord[];
    try {
      records = this.ledger.listFor(entry.cwd, sessionId);
    } catch (err) {
      log('WARN', 'NativeSessionHost', 'getHistory: failed to read the delegation ledger — replaying the parent\'s own events without card replay', { sessionId, error: String((err as any)?.message ?? err) });
      return parentEvents;
    }
    if (records.length === 0) return parentEvents;
    const children = records.map((record) => ({ record, events: this.store.readEvents(record.childId, record.workDir) }));
    return mergeChildEvents(sessionId, parentEvents, children);
  }

  /** Task 9 (plan 1c) — every run record for `sessionId`'s (as PARENT) live
   *  specialist delegations, projected through the SAME toRunView the
   *  ledger's own change listener uses to build the specialists:event push
   *  (see the 'specialists-event' emit in the constructor above). A renderer
   *  that just reloaded rebuilds its tool cards from the on-disk transcript
   *  (TRANSCRIPT_REPLAY), but nothing in that replay re-sends a helper's
   *  CURRENT status — the card's status IS its run record (R2) — so
   *  ipc-handlers replays these the same way it replays open permission asks
   *  just above (pendingAskEventsFor).
   *
   *  cwd comes from `this.live`, not a caller-supplied argument: getHistory()
   *  already returns null for a non-live session for the identical reason
   *  (see its own comment) — a dead session's specialists have no live turn
   *  left to act on their status, so this matches that same "only when it IS
   *  live" contract instead of inventing a second one.
   *
   *  Capped at SPECIALIST_SPAWN_BUDGET_PER_SESSION defensively: in
   *  production the ledger can never hold more than that many records for
   *  one parent — trySpendSpecialistSpawnBudget spends the budget BEFORE
   *  recordStart ever runs (see its own comment), so every recordStart call
   *  is already budget-gated. This slice is a belt-and-braces bound against
   *  replay ever growing past what a single turn could actually have
   *  spawned, not a correction for a real overflow. */
  specialistRunsFor(sessionId: string): SpecialistRunView[] {
    const entry = this.live.get(sessionId);
    if (!entry || !this.ledger) return [];
    return this.ledger.listFor(entry.cwd, sessionId)
      .slice(0, SPECIALIST_SPAWN_BUDGET_PER_SESSION)
      .map(toRunView);
  }

  /** True only when we can AFFIRM this native session has no work in flight —
   *  no turn running and nothing queued behind one. Consumed by the transcript
   *  replay handler: a replayed transcript ends wherever the process died, so
   *  its last tool_use may have no result, and the renderer needs to know
   *  whether that card is stale history or a genuinely running tool (the same
   *  replay fires when a window re-docks a live, mid-turn session).
   *  Unknown/non-native ids answer false — never claim idle we can't prove. */
  isIdle(sessionId: string): boolean {
    const entry = this.live.get(sessionId);
    if (!entry) return false;
    return !entry.inFlight && entry.queue.length === 0;
  }

  /** Await this session's pending appends — a real "flush the queue" affordance
   *  and the test hook that makes disk state deterministic after send(). */
  async drain(sessionId: string): Promise<void> {
    await this.live.get(sessionId)?.appendChain;
  }

  /** Resume Browser rows — every persisted native session, tagged 'native'. */
  list(): (NativeSessionListEntry & { provider: 'native' })[] {
    return this.store.list().map((r) => ({ ...r, provider: 'native' as const }));
  }

  /** Cascade-cancel: interrupt then destroy every live specialist child of this
   *  session. Called from destroy() and quiesce(). Reads the in-memory
   *  childrenOf map only — teardown never does disk I/O to find its children.
   *  Interrupt-then-destroy (rather than destroy alone) so a child paused
   *  mid-turn unwinds its loop before its stream is torn out from under it —
   *  the same order interrupt() and destroy() already use for one session. */
  private async destroyChildrenOf(sessionId: string): Promise<void> {
    const children = this.childrenOf.get(sessionId);
    if (!children) return;
    this.childrenOf.delete(sessionId);
    // Task 8: this parent's name-draw state dies with its children set — a
    // reused/new set of children under this parent id (there isn't one in
    // practice, but nothing here should assume it) starts the pool fresh.
    this.takenNamesOf.delete(sessionId);
    // Task 2 (plan 1b): captured before the loop below — `sessionId`'s live
    // entry is still present here (this is called from destroy()/quiesce()
    // BEFORE either drops the parent's own live entry).
    const parentCwd = this.live.get(sessionId)?.cwd;
    for (const childId of [...children]) {
      this.interrupt(childId);
      // A FOREGROUND child still in this set really is, by construction,
      // still 'running' in the ledger — a completed/failed foreground child
      // already tore itself down (and de-registered from childrenOf) in
      // spawnSpecialist's own finally, synchronously with its ledger write.
      // A BACKGROUND child does NOT have that guarantee (Critical 3, final
      // review): runDelegation's own completion write lands, then the child
      // is de-registered from childrenOf a few microtasks later — so this
      // loop's snapshot (`[...children]`, taken once above) can still name a
      // childId whose ledger row is ALREADY 'completed' by the time this
      // fires. Fixed by updateUnlessCompleted (see its own comment): a real,
      // already-reported outcome is never clobbered to 'interrupted', which
      // claimUndelivered never looks at — while a merely-running child still
      // gets marked 'interrupted' exactly as before. FIRE-AND-FORGET (not
      // awaited): destroy()/quiesce() (this method's only callers) can
      // themselves be invoked without an await from a sync caller, and a
      // lock-contended ledger write must never make an unrelated caller's
      // teardown appear to hang. .catch(log) turns a failed write into a log
      // line instead of an unhandled rejection.
      if (this.ledger && parentCwd) {
        this.ledger.updateUnlessCompleted(parentCwd, sessionId, childId, { status: 'interrupted', endedAt: Date.now() })
          .catch((e) => log('ERROR', 'NativeSessionHost', 'failed to record an interrupted delegation', { childId, parentId: sessionId, error: String(e) }));
      }
      await this.destroy(childId);
    }
  }

  /** Graceful teardown of one session. No-op for unknown ids (so the
   *  SESSION_DESTROY handler can call it for every session id blindly).
   *
   *  Order matters — STOP THE SOURCE FIRST:
   *   1. session.destroy() aborts the in-flight stream AND removeAllListeners()
   *      — removing our transcript-event listener is what actually stops new
   *      appends being enqueued (the listener closes over `entry`, so deleting
   *      the map entry alone would NOT stop re-enqueue mid-stream).
   *   2. await the appendChain — drain appends already enqueued before step 1.
   *   3. store.dispose() — flush the buffered open streaming part.
   *   4. drop the map entry. */
  async destroy(sessionId: string, opts: { keepShells?: boolean } = {}): Promise<void> {
    // Capture the entry SYNCHRONOUSLY, before the child cascade below awaits —
    // the MCP release at the bottom of this method depends on tearing down the
    // generation this call captured (see the comment there), and that property
    // must survive the new await, not just the ones that were already here.
    const entry = this.live.get(sessionId);
    // A session torn down while it was still starting has nowhere to deliver a
    // held message, so drop it here rather than leave it stranded in memory.
    this.endStarting(sessionId);
    // Specialist children go next, and unconditionally — before the not-live
    // early return, because a child must never outlive its parent even if the
    // parent's own entry is already gone (a double destroy, or a teardown
    // racing one).
    await this.destroyChildrenOf(sessionId);
    // G-1 (D2): closing the conversation kills its background commands and
    // says so on the card. The holder-takeover and session-exit paths pass
    // keepShells — the conversation is still open, just somewhere else — and
    // the registry stays in the map so destroyAll can still reach it. Placed
    // before the not-live early return so an orphaned registry is killed when
    // its conversation is finally closed on this device.
    if (!opts.keepShells) {
      const reg = this.shellRegistries.get(sessionId);
      if (reg) {
        this.shellRegistries.delete(sessionId);
        // Held until the kill settles so app-quit can still reach a process
        // that is ignoring SIGTERM inside the 2 s escalation window.
        this.drainingShellRegistries.add(reg);
        // Signals are sent synchronously; only the exit wait is deferred —
        // closing a tab must not stall on a stubborn process.
        void reg.killAll('conversation-closed')
          .catch((err) => log('WARN', 'NativeSessionHost', 'killAll on destroy failed', { sessionId, error: String(err) }))
          .finally(() => this.drainingShellRegistries.delete(reg));
      }
    }
    if (!entry) return;
    // De-register from the parent's child set (this session IS a child when
    // parentSessionId is set) so a destroyed child isn't chased again later.
    if (entry.parentSessionId) this.childrenOf.get(entry.parentSessionId)?.delete(sessionId);
    // Resolve any pending asks for this session ('canceled') + expire their
    // cards BEFORE tearing down the stream — same rationale as interrupt(); a
    // loop paused on a permission await must unwind, and the promise must not
    // leak past teardown.
    this.broker.cancelSession(sessionId);
    const modelId = entry.session.binding.modelId; // capture before teardown
    entry.session.destroy();             // abort stream + remove our listener → no new appends
    await entry.appendChain;             // drain already-enqueued appends
    await this.store.dispose(sessionId); // flush the buffered open part
    this.live.delete(sessionId);
    // Fix (Task 4 fix pass 3): drop any in-memory fallback reports still
    // queued for this parent. They can only ever be delivered by THIS
    // parent's own runTurns idle boundary (drainDeliveries reads
    // `this.live.get(sessionId)`, which is now gone) — leaving them in the
    // map after the parent is torn down would hold a full specialist report
    // in memory forever for a session that is never coming back to read it.
    for (const [childId, fb] of this.inMemoryFallback) {
      if (fb.parentId === sessionId) this.inMemoryFallback.delete(childId);
    }
    // Plan 1b Task 8: same reasoning as inMemoryFallback above — a host notice
    // is keyed directly by the PARENT id it's queued for, so if THIS destroy()
    // is tearing down that parent, nothing is ever coming back to read it.
    this.pendingHostNotices.delete(sessionId);
    // Drop per-session runtime state so it can't leak and so a destroy→resume of
    // the SAME sessionId within one app run starts clean: mode resets to the
    // default 'ask', and the in-memory remembered rules fall back to the disk
    // record (never carried across a teardown).
    this.modeFor.delete(sessionId);
    this.rememberedFor.delete(sessionId);
    this.presetIdFor.delete(sessionId);
    // Task 6 — drop this parent's specialist bookkeeping too, so a slot/writer
    // reservation can never outlive the session that made it (destroyChildrenOf
    // above already tore down any children BEFORE we get here, but a slot could
    // still be reserved from an in-flight Task call this destroy() interrupted).
    this.specialistSlots.delete(sessionId);
    this.activeWriterChild.delete(sessionId);
    this.releaseModel(sessionId, modelId); // last session gone → unload it (#1)
    // Release THIS generation's MCP lease (Task 6), LAST — orthogonal to the
    // transcript/live-map teardown above (releasing never touches either), so
    // ordering it after doesn't affect that invariant. `entry` was captured at
    // the top of this method, before any await, so a resume() for this same
    // sessionId racing us installs its own LiveEntry with its own lease and
    // this call cannot reach it. No-ops harmlessly when this session never
    // acquired anything (no manager wired, or acquireMcp caught a failure).
    await entry.mcpLease?.release();
  }

  /** App-shutdown path: destroy every live session, then flush any residue. */
  async destroyAll(): Promise<void> {
    // Cancel every pending ask up front (covers asks whose session is no longer
    // live, which the per-session destroy loop below would miss).
    this.broker.cancelAll();
    for (const id of [...this.live.keys()]) {
      // keepShells: the app-quit sweep below kills EVERY registry with the
      // honest reason, including orphans from earlier takeovers that no live
      // session still points at.
      await this.destroy(id, { keepShells: true });
    }
    // G-1 (D2): app quit stops every background command with the honest
    // reason. SIGKILL at once: the process is exiting and a deferred
    // escalation timer would never fire.
    for (const [id, reg] of this.shellRegistries) {
      void reg.killAll('app-quit', { graceMs: 0 }).catch((err) => log('WARN', 'NativeSessionHost', 'killAll on quit failed', { sessionId: id, error: String(err) }));
    }
    this.shellRegistries.clear();
    // A conversation closed seconds ago is still escalating SIGTERM->SIGKILL;
    // finish the job now rather than let the escalation timer die with us.
    for (const reg of this.drainingShellRegistries) {
      void reg.killAll('app-quit', { graceMs: 0 }).catch(() => { /* already gone */ });
    }
    this.drainingShellRegistries.clear();
    // Fix (Task 4 fix pass 3): belt-and-suspenders sweep on top of the
    // per-session cleanup destroy() now does above. Covers the one case that
    // loop can't: a fallback entry whose parent's destroy() already ran
    // BEFORE spawnSpecialistBackground's async `.then` handler got around to
    // stashing the report (the parent left `this.live` first, so destroy()'s
    // own cleanup found nothing for it yet). App shutdown is exactly the
    // moment such a stray entry can never be delivered anyway, so clearing
    // the whole map here is correct, not just convenient.
    this.inMemoryFallback.clear();
    await this.store.flushAll();
    // Tear down every pooled MCP server connection HERE too. Without this, an
    // MCP server's spawned subprocess (e.g. a stdio server) would outlive the
    // app instead of being closed alongside it.
    //
    // SCOPE OF THAT PROMISE, precisely: this runs via ipc-handlers.ts cleanup(),
    // which main.ts calls from its shutdownApp() teardown. As of 2026-08-05 that
    // teardown is reached from all three quit routes — window-all-closed,
    // before-quit (macOS Cmd+Q, dock quit, menu quit), and a SIGTERM/SIGINT from
    // an OS shutdown or logout — so this line can now be read as "covered at
    // every quit." Before that fix, window-all-closed was the app's only
    // quit-related listener and every other route leaked the subprocess.
    // What is still NOT covered, and cannot be: SIGKILL, a power loss, or a
    // main-process crash. Nothing in userland runs on those.
    await this.mcpManager?.destroyAll();
  }
}
