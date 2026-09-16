// PermissionBroker (Phase 2 Plan A, Task 8) — owns pending native permission
// asks. Emits 'hook-event' with the SAME shape hook-relay produces (type +
// sessionId + payload + timestamp; payload uses CC's snake_case field names
// tool_name / tool_input / _requestId) so hook-dispatcher → ToolCard render a
// native ask UNCHANGED. Request ids are 'native-' prefixed so the shared
// permission:respond channel routes by id: ipc-handlers tries the broker first,
// and a non-native id falls through to hookRelay. An interrupt → cancelSession
// resolves every pending ask for that session as 'canceled' (spec pending-ask
// ruling — a paused loop can then unwind) and emits PermissionExpired so the
// renderer clears the approval card.
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { log } from '../logger';
import type { GrantScope } from '../../shared/bash-grant-shapes';
import type { HookEvent } from '../../shared/types';

export interface AskRequest {
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  /** Winning rule came from the destructive deny-list → renderer shows the
   *  consequence warning on Always-allow (Task 13 consumes this). */
  denyListed: boolean;
  /** The ask was FORCED by a path outside the session cwd, which also skips the
   *  permission rules on every future call — so a remembered rule could never
   *  fire. Renderer hides "Always allow" rather than promising a grant the
   *  engine will not honor. Optional (unlike denyListed) because it only means
   *  anything for path-subject tool asks; budget gates never set it.
   *  See spec 2026-08-11 (permissions management UI), finding 3. */
  external?: boolean;
  /** The session's permission mode at ask time. Full-auto + denyListed is the
   *  renderer's cue to swap the generic row for the safety-stop footer
   *  (spec 2026-08-12, M5 2b). Optional: CC-path asks never carry it. */
  permissionMode?: 'ask' | 'auto-edit' | 'full-auto';
  /** Plan 1b Task 8: set by childAskRouter when this ask is being ROUTED from a
   *  specialist child rather than raised directly by `sessionId`'s own turn.
   *  `sessionId` above is already the PARENT's id by the time this reaches
   *  `ask()` (the router rewrites it before calling in — the renderer only
   *  ever looks a card up by sessionId, and no window owns the child's raw
   *  id) — `raisedBy` keeps the CHILD's real id alongside it so
   *  `cancelSession(childId)` (a child destroy/teardown) can still find and
   *  cancel an ask it raised, and so a late answer can be routed back to the
   *  right child (or reported against the right child if it has since ended). */
  raisedBy?: string;
  /** Rides the hook-event payload so the permission card can label which
   *  specialist raised the ask. Consuming this on the renderer side is a
   *  follow-up task — this one only threads the data through structurally.
   *  `parentToolCallId` (Task 6, 1c) is the Task-tool call that spawned this
   *  specialist — the renderer needs it to nest the routed row under the
   *  right specialist card instead of just labelling it. */
  specialist?: {
    childId: string; agentType: string; title: string; parentToolCallId: string;
    /** Task 4 review item 6: set when the specialist belongs to a plan — the
     *  renderer places the ask in that plan step's specialist row. */
    plan?: { planId: string; stepId: string; attemptId: string };
  };
  /** Task 11: the exact permission-engine SUBJECT this ask is about (e.g. a
   *  Bash command string) — harness-session.ts already computes this via
   *  tool.permissionSubject(args) before calling askUser, but only THREADS it
   *  through here for the ONE call site that gates on decide() (never for the
   *  max_steps/doom_loop budget asks, which have no such concept). Not
   *  forwarded to the renderer via the emitted hook-event payload — it is
   *  read directly off this object by child-ask-router.ts, which needs the
   *  exact pattern to persist a specialist-keyed "Always allow" as the right
   *  rule rather than an overbroad one. */
  subject?: string;
}
export interface AskDecision {
  behavior: 'allow' | 'deny' | 'canceled';
  /** True when the user chose "Always allow" — caller persists the remembered rule. */
  always?: boolean;
  /** AskUserQuestion answers ride the SAME channel inside decision.updatedInput
   *  (ToolCard's AskUserQuestionCard shape) — dropped for ordinary permission
   *  asks, load-bearing for interactive tools. */
  updatedInput?: Record<string, unknown>;
  /** Task 8: model-facing copy carried through a deny. A REAL user decline
   *  leaves this unset — harness-session.ts falls back to its own generic
   *  "the user declined" copy, which is accurate for that case. A specialist
   *  ask that TIMED OUT sets this to ASK_REDIRECT_MESSAGE (child-ask-router.ts)
   *  so the model reads the true reason (still pending, not refused) instead
   *  of a sentence that blames a user who never actually answered. */
  message?: string;
  /** Which grant width the user picked, when they picked "Always allow".
   *  A SELECTOR, never a pattern: the renderer must not be able to name the rule
   *  it is granting itself — remembered rules are the top precedence layer, above
   *  the destructive deny-list. Always populated on a resolved ask; defaults to
   *  the narrow option. */
  grantScope?: GrantScope;
  /** A HUMAN answered "no" on a card — set ONLY by respond() below, which is
   *  the only path a person's decision travels (renderer and remote WS
   *  clients both land there), on ANY real deny it produces, in time or
   *  late. The driver reads it on interactive asks: a dismissed
   *  AskUserQuestion ends the turn, because closing the card is the user
   *  taking the turn back. This also reaches a SPECIALIST child's own driver
   *  on a routed, IN-TIME deny: childAskRouter's broker.ask() call returns
   *  this exact decision object untouched, so the child's own turn ends the
   *  same way a root session's would — a human closing the routed card is
   *  still a human taking the turn back, just on the parent's screen instead
   *  of the child's. A LATE deny (after the entry's own timeout already fired
   *  the redirect) still carries `dismissed: true` for honesty, but nothing
   *  reads it there: the original awaited promise already settled via the
   *  redirect, so the late answer reaches onLateResponse instead
   *  (native-session-host.ts), which steers or notifies off `.behavior`
   *  alone — there is no turn left to end synchronously.
   *
   *  WHY this is not just `behavior === 'deny'`: every OTHER askUser path with
   *  no human behind it must keep a bare deny meaning "you may not do this,
   *  carry on and finish", NOT "stop" — child-ask-router.ts's two instant-deny
   *  branches (AskUserQuestion, external-directory), its 5-minute timeout
   *  redirect (a timeout is not a dismissal — the human never closed anything,
   *  they just haven't answered yet), and the harness evaluator's fixture jail
   *  (eval/run-case.ts). The evaluator depends on that: its wrap-up turn denies
   *  AskUserQuestion precisely so the model answers instead of asking, and
   *  ending the turn there loses the review entirely (caught by
   *  harness-review-runner.test.ts). */
  dismissed?: boolean;
}

/** Task 8: the shape handed to a late-response handler — everything about the
 *  original ask EXCEPT the resolver (already spent) and the timer (already
 *  cleared). */
export type LateResponseEntry = {
  sessionId: string;
  toolName: string;
  raisedBy?: string;
  specialist?: AskRequest['specialist'];
  /** Task 11 fix pass (Finding 2): the original ask's permission-engine
   *  SUBJECT, carried through so a LATE "Always allow" can persist the same
   *  rule the in-time path (child-ask-router.ts) would have written. Before
   *  this field existed, `onLateResponse` had no way to name what was being
   *  approved — it could only steer or notify, never remember. */
  subject?: string;
};
export type LateResponseHandler = (entry: LateResponseEntry, decision: AskDecision) => void;

interface PendingAsk {
  sessionId: string;
  toolName: string;
  raisedBy?: string;
  specialist?: AskRequest['specialist'];
  /** Task 11 fix pass (Finding 2): carried from AskRequest.subject through to
   *  a late response — see LateResponseEntry.subject's own WHY. */
  subject?: string;
  resolve: (d: AskDecision) => void;
  timer?: ReturnType<typeof setTimeout>;
  /** Task 8: true once the hold timeout has fired and already resolved the
   *  ask's promise with onTimeout()'s decision. The entry is DELIBERATELY
   *  left in `pending` after that — "the ask stays answerable" means a real
   *  user decision can still arrive later. `respond()` reads this flag to
   *  route a late decision to `lateResponseHandler` instead of calling
   *  `resolve` again (which would silently no-op on an already-settled
   *  promise and lose the real answer). */
  timedOut: boolean;
  /** The exact PermissionRequest this ask emitted, minus its timestamp, kept so
   *  the heartbeat re-announces something byte-identical. Rebuilding it from
   *  the fields above would silently drift from the emit in `ask()`. */
  announcement: { sessionId: string; type: 'PermissionRequest'; payload: Record<string, unknown> };
}

/** How often an open ask re-announces itself to the renderer.
 *
 *  WHY the heartbeat exists at all (2026-08-16 stuck-session investigation): a
 *  ROOT ask has no timeout — harness-session awaits it and the turn is simply
 *  paused until someone answers. So ANY delivery failure between here and a
 *  rendered card is a permanently hung turn that looks exactly like a slow
 *  model: no error, no banner, nothing to click. Three such failures are known
 *  (a card overwritten by the later tool-use event — the bug behind Destin's
 *  hung local session, `cd6fb766`; a card lost to a transcript replay after a
 *  reload or session switch; a hook event dropped when every target
 *  webContents is gone). Rather than chase each, main keeps SAYING the ask is
 *  open, and the renderer heals on the next beat. PERMISSION_REQUEST is
 *  idempotent-on-repeat for exactly this reason (see chat-reducer.ts).
 *
 *  3s: below the point where a missing card reads as broken, and negligible —
 *  a repeat with an unchanged requestId costs the reducer one early return. */
export const ASK_REANNOUNCE_MS = 3_000;

export class PermissionBroker extends EventEmitter {
  private pending = new Map<string, PendingAsk>();
  private lateResponseHandler?: LateResponseHandler;
  /** One interval for ALL open asks — started when `pending` gains its first
   *  answerable entry, stopped when it has none. Never per-ask. */
  private reannounceTimer?: ReturnType<typeof setInterval>;

  /** Task 8: the ONE handler invoked when a real response arrives for an ask
   *  that already timed out. A setter rather than a constructor arg because
   *  NativeSessionHost wires this after constructing both itself and the
   *  broker (the handler closes over the host's live-session map). */
  setLateResponseHandler(handler: LateResponseHandler): void {
    this.lateResponseHandler = handler;
  }

  /** `opts` (Task 8) lets a caller hold this ask open only up to `timeoutMs`
   *  before deciding it FOR the model via `onTimeout()` — the entry stays in
   *  `pending` afterward (see PendingAsk.timedOut) so a real answer is never
   *  lost, only redirected once the deadline has passed. */
  ask(req: AskRequest, opts?: { timeoutMs?: number; onTimeout?: () => AskDecision }): Promise<AskDecision> {
    const requestId = `native-${randomUUID()}`;
    return new Promise<AskDecision>((resolve) => {
      // Payload field names MUST match what hook-dispatcher extracts
      // (src/renderer/state/hook-dispatcher.ts): tool_name, tool_input,
      // _requestId. denyListed rides along for the Task 13 warning, `external`
      // the same way so ToolCard can hide Always-allow, and `specialist`
      // (Task 8) so a future card revision can label which child raised it.
      const announcement = {
        sessionId: req.sessionId,
        type: 'PermissionRequest' as const,
        payload: {
          _requestId: requestId,
          tool_name: req.toolName,
          tool_input: req.toolInput,
          denyListed: req.denyListed,
          external: req.external === true,
          ...(req.specialist ? { specialist: req.specialist } : {}),
          // Spread-omitted (not `undefined`-valued) so the CC-path payload
          // shape is byte-identical to before this field existed.
          ...(req.permissionMode ? { permissionMode: req.permissionMode } : {}),
        },
      };
      const entry: PendingAsk = {
        sessionId: req.sessionId,
        toolName: req.toolName,
        raisedBy: req.raisedBy,
        specialist: req.specialist,
        subject: req.subject,
        resolve,
        timedOut: false,
        announcement,
      };
      this.pending.set(requestId, entry);
      if (opts?.timeoutMs !== undefined && opts.onTimeout) {
        const onTimeout = opts.onTimeout;
        entry.timer = setTimeout(() => {
          entry.timer = undefined;
          entry.timedOut = true;
          resolve(onTimeout());
          // WHY: the renderer's nested row must SAY the helper carried on
          // (spec R3) — before 1c the flip was silent and the card looked
          // unchanged. Emitted AFTER the PermissionRequest this same entry
          // already sent (at ask()-time and every heartbeat since), so a
          // listener sees the request before it sees the hold.
          this.emit('hook-event', this.hookEventFor(entry, 'PermissionHeld'));
          // NOT deleted from `pending` — see PendingAsk.timedOut's own WHY.
          // It IS now unanswerable-by-the-turn though, so it stops heartbeating.
          this.syncReannounceTimer();
        }, opts.timeoutMs);
      }
      this.syncReannounceTimer();
      this.emitAnnouncement(entry);
    });
  }

  /** The ONE place any hook-event about a pending ask is BUILT — the live
   *  PermissionRequest announcement, its pendingEventsFor() replay, and the
   *  PermissionHeld hold-flip all route through this so the four-field shape
   *  (sessionId/type/payload/timestamp) is defined in exactly one place. WHY:
   *  before this helper the same object literal was hand-built twice (once
   *  per emit site) and this task would otherwise have made it a third —
   *  a reviewer flagged that as the exact way the two would drift apart.
   *  `payload` is a fresh copy per call: the stored announcement is reused
   *  indefinitely, so handing every listener the same object would let one
   *  in-process consumer's mutation rewrite what all later beats say. */
  private hookEventFor(entry: PendingAsk, type: 'PermissionRequest' | 'PermissionHeld'): HookEvent {
    const payload = type === 'PermissionRequest'
      ? entry.announcement.payload
      : { _requestId: entry.announcement.payload._requestId };
    return {
      sessionId: entry.announcement.sessionId,
      type,
      payload: { ...payload },
      timestamp: Date.now(),
    };
  }

  /** The ONE place a PermissionRequest goes out, first time and every beat. */
  private emitAnnouncement(entry: PendingAsk): void {
    this.emit('hook-event', this.hookEventFor(entry, 'PermissionRequest'));
  }

  /** Task 0 (ROADMAP #permissions, 2026-08-16): a renderer reload rebuilds
   *  every card from the on-disk transcript (TRANSCRIPT_REPLAY), but an open
   *  ask lives ONLY here — nothing on disk records that it is still awaiting
   *  an answer. Without this, the rebuilt card comes back with no buttons and
   *  a root ask (which has no timeout) hangs the turn forever. Re-sending the
   *  stored `announcement` is the same "just say it again" trick the
   *  heartbeat above already relies on, one-shot instead of on an interval —
   *  and, unlike the heartbeat, it deliberately includes TIMED-OUT entries:
   *  those are still "the ask stays answerable" (see PendingAsk.timedOut), so
   *  the reloaded window must show a card a late human answer can still hit,
   *  even though nothing is stuck waiting on it. A timed-out entry gets its
   *  PermissionHeld pushed right after its PermissionRequest (Task 6) — WHY:
   *  held is a state the row shows (R3); the replay has to restore the
   *  state, not just the buttons, or a held ask comes back looking fresh. */
  pendingEventsFor(sessionId: string): HookEvent[] {
    const events: HookEvent[] = [];
    for (const entry of this.pending.values()) {
      if (entry.sessionId !== sessionId) continue;
      events.push(this.hookEventFor(entry, 'PermissionRequest'));
      if (entry.timedOut) events.push(this.hookEventFor(entry, 'PermissionHeld'));
    }
    return events;
  }

  /** Re-emit every ask whose turn is still WAITING on it. A timed-out entry is
   *  skipped: its promise already settled via onTimeout, so nothing is stuck —
   *  it lingers in `pending` only so a late human answer still lands. */
  private reannounce(): void {
    for (const entry of this.pending.values()) {
      if (entry.timedOut) continue;
      this.emitAnnouncement(entry);
    }
  }

  /** Idempotent: run after any change to `pending` or to an entry's timedOut. */
  private syncReannounceTimer(): void {
    let answerable = false;
    for (const entry of this.pending.values()) {
      if (!entry.timedOut) { answerable = true; break; }
    }
    if (answerable && !this.reannounceTimer) {
      this.reannounceTimer = setInterval(() => this.reannounce(), ASK_REANNOUNCE_MS);
      // Unref'd: an unanswered permission ask must never be the reason the main
      // process refuses to exit.
      this.reannounceTimer.unref?.();
    } else if (!answerable && this.reannounceTimer) {
      clearInterval(this.reannounceTimer);
      this.reannounceTimer = undefined;
    }
  }

  /** Returns false when the id isn't ours — caller falls through to hookRelay. */
  respond(requestId: string, decision: Record<string, unknown>): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    // ToolCard's PermissionButtons send { decision: { behavior }, updatedPermissions? }
    // (see src/renderer/components/ToolCard.tsx). Unwrap that nested shape;
    // fall back to a flat { behavior } for direct callers/tests. "Always allow"
    // is signaled by a non-empty updatedPermissions array.
    const inner = (decision.decision as Record<string, unknown> | undefined) ?? decision;
    const behavior = inner.behavior === 'allow' ? 'allow' : 'deny';
    // "Always allow" is signaled by a non-empty updatedPermissions array — but
    // ONLY meaningful on an allow. A deny+updatedPermissions must NOT become an
    // allow-always rule (Task 12 persists on `always`), so gate on behavior.
    const always =
      behavior === 'allow' &&
      Array.isArray(decision.updatedPermissions) &&
      decision.updatedPermissions.length > 0;
    // AskUserQuestion answers ride inside decision.updatedInput (the same nested
    // shape the card sends). Thread it through UNTOUCHED — it is NOT
    // updatedPermissions and must never influence `always`.
    const updatedInput = inner.updatedInput && typeof inner.updatedInput === 'object'
      ? (inner.updatedInput as Record<string, unknown>) : undefined;
    // Validate to the two literals and FAIL NARROW on anything else. This value
    // is PERSISTED (unlike permissionMode, which is display-only), so it is
    // checked here AND re-derived at the session rather than trusted.
    const grantScope: GrantScope = decision.grantScope === 'wide' ? 'wide' : 'exact';
    // Stamp a human "no" so the driver can tell it from a policy refusal (see
    // AskDecision.dismissed) — true whether this arrives IN TIME (resolves
    // the still-open ask below) or LATE (entry.timedOut already fired the
    // redirect, so this reaches lateResponseHandler instead, further down).
    // Both are a person closing the card; only where the decision goes
    // differs, never whether a human actually answered it.
    const resolved: AskDecision = { behavior, always, grantScope, ...(behavior === 'deny' ? { dismissed: true } : {}), ...(updatedInput ? { updatedInput } : {}) };

    if (entry.timedOut) {
      // Task 8: the entry's own promise already settled (with the redirect,
      // via onTimeout) — this respond() call IS the "later answer" the spec
      // requires never gets silently dropped. There is nothing left to
      // resolve, so route it to whoever is tracking this ask's real outcome
      // instead (NativeSessionHost.onLateResponse) rather than calling
      // `entry.resolve` again, which would just no-op.
      this.removeEntry(requestId, entry);
      if (this.lateResponseHandler) {
        this.lateResponseHandler(
          {
            sessionId: entry.sessionId, toolName: entry.toolName, raisedBy: entry.raisedBy,
            specialist: entry.specialist, subject: entry.subject,
          },
          resolved,
        );
      } else {
        // No handler wired — real production wiring always calls
        // setLateResponseHandler once at construction (native-session-host.ts),
        // so this only fires for a broker built without that wiring (a test,
        // or a future caller that forgot). Logged rather than thrown so a
        // renderer response can never crash the main process; still visible
        // rather than a silent loss.
        log('WARN', 'PermissionBroker', 'a late response arrived for a timed-out ask with no lateResponseHandler wired — the answer was not delivered anywhere', { requestId, sessionId: entry.sessionId, toolName: entry.toolName });
      }
      return true;
    }

    if (entry.timer) clearTimeout(entry.timer); // exit path: respond() before the deadline
    this.removeEntry(requestId, entry);
    entry.resolve(resolved);
    return true;
  }

  cancelSession(sessionId: string): void {
    for (const [id, entry] of [...this.pending]) {
      // Task 8: `sessionId` (the card's HOME session) always cancels,
      // regardless of timeout state — a parent interrupt/destroy must clear
      // a routed ask off its own screen even after the redirect already
      // fired. `raisedBy` (the CHILD that raised a routed ask) only cancels
      // while the ask is STILL WITHIN its window: once it has timed out, the
      // ask now belongs to the PARENT's screen, and tearing down the CHILD —
      // which runDelegation's finally does on EVERY run, success or failure —
      // must not also erase an ask a real user might still answer. Without
      // this guard, every specialist run's own normal teardown would cancel
      // its own already-timed-out ask the instant the child finished,
      // breaking the "a later answer is not thrown away" guarantee.
      const raisedByMatch = entry.raisedBy === sessionId && !entry.timedOut;
      if (entry.sessionId !== sessionId && !raisedByMatch) continue;
      this.cancelOne(id, entry);
    }
  }

  /** Cancel EVERY pending ask (app-shutdown / destroyAll). Unconditional —
   *  app shutdown has no "someone might still answer this" case to protect. */
  cancelAll(): void {
    for (const [id, entry] of [...this.pending]) {
      this.cancelOne(id, entry);
    }
  }

  private cancelOne(id: string, entry: PendingAsk): void {
    if (entry.timer) clearTimeout(entry.timer); // exit path: cancel
    this.removeEntry(id, entry);
    // PermissionExpired clears the approval card; _requestId matches the field
    // hook-dispatcher reads for the expired branch. Emitted AFTER removeEntry's
    // PermissionResolved (below) so a RemoteServer buffer purge keyed on the
    // resolved id clears the now-stale Request/Held first, THEN this terminal
    // Expired lands fresh — reversing the order would purge the Expired event
    // it just buffered too.
    this.emit('hook-event', {
      sessionId: entry.sessionId,
      type: 'PermissionExpired',
      payload: { _requestId: id },
      timestamp: Date.now(),
    });
    entry.resolve({ behavior: 'canceled' });
  }

  /** The ONE place a `PendingAsk` stops being pending — whichever route
   *  triggered it. Before this, `respond()` (both its in-time and late
   *  branches) and `cancelOne()` each called `pending.delete` directly, and
   *  `respond()` emitted NOTHING on resolution (2026-08-16 review finding:
   *  "the catch-up replays asks that were already answered"). A phone
   *  reconnecting after answering a card in two seconds was replayed that
   *  same PermissionRequest out of RemoteServer's buffer — a dead question
   *  with live-looking Yes/No buttons; tapping either returned false and the
   *  card showed a "socket closed" message that was simply untrue. Routing
   *  every removal through here means RemoteServer only has to listen for
   *  ONE signal (`PermissionResolved`) to purge its buffer, instead of a
   *  per-route emit risking exactly the kind of miss this finding was about.
   *  Not built via hookEventFor() — that helper only knows the two LIVE
   *  card states (Request/Held); this is a new, renderer-invisible type
   *  (hook-dispatcher.ts's switch defaults to null on an unknown type) whose
   *  only consumer is RemoteServer.bufferHookEvent's purge branch. */
  private removeEntry(id: string, entry: PendingAsk): void {
    this.pending.delete(id);
    this.syncReannounceTimer();
    this.emit('hook-event', {
      sessionId: entry.sessionId,
      type: 'PermissionResolved',
      payload: { _requestId: id },
      timestamp: Date.now(),
    });
  }
}
