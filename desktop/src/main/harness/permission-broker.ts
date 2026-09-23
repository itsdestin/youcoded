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
  /** The ask was forced by the removal-target floor (tools/rm-target.ts): the
   *  command would remove the workspace, home folder, disk root or a system
   *  folder, and that check runs below every rule — so a remembered grant could
   *  never skip it. Renderer hides "Always allow"; nothing is remembered.
   *  Separate from `external` because a specialist's external ask is refused
   *  outright with outside-the-folder copy, while this one goes to the person. */
  noAlwaysAllow?: boolean;
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
   *  cancel an ask it raised. */
  raisedBy?: string;
  /** Rides the hook-event payload so the permission card can label which
   *  specialist raised the ask. Consuming this on the renderer side is a
   *  follow-up task — this one only threads the data through structurally.
   *  `parentToolCallId` (Task 6, 1c) is the Task-tool call that spawned this
   *  specialist — the renderer needs it to nest the routed row under the
   *  right specialist card instead of just labelling it. */
  specialist?: { childId: string; agentType: string; title: string; parentToolCallId: string };
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
   *  "the user declined" copy, which is accurate for that case. The policy
   *  denials in child-ask-router.ts (AskUserQuestion, external directory)
   *  set it so the model reads the true reason instead of a sentence that
   *  blames a user who never saw a card. */
  message?: string;
  /** Which grant width the user picked, when they picked "Always allow".
   *  A SELECTOR, never a pattern: the renderer must not be able to name the rule
   *  it is granting itself — remembered rules are the top precedence layer, above
   *  the destructive deny-list. Always populated on a resolved ask; defaults to
   *  the narrow option. */
  grantScope?: GrantScope;
  /** A HUMAN answered "no" on a card — set ONLY by respond() below, which is
   *  the only path a person's decision travels (renderer and remote WS
   *  clients both land there), on ANY real deny it produces. The driver reads it on interactive asks: a dismissed
   *  AskUserQuestion ends the turn, because closing the card is the user
   *  taking the turn back. This also reaches a SPECIALIST child's own driver
   *  on a routed deny: childAskRouter's broker.ask() call returns this exact
   *  decision object untouched, so the child's own turn ends the same way a
   *  root session's would — a human closing the routed card is still a human
   *  taking the turn back, just on the parent's screen instead of the child's.
   *
   *  WHY this is not just `behavior === 'deny'`: every OTHER askUser path with
   *  no human behind it must keep a bare deny meaning "you may not do this,
   *  carry on and finish", NOT "stop" — child-ask-router.ts's two instant-deny
   *  branches (AskUserQuestion, external-directory), and the harness
   *  evaluator's fixture jail
   *  (eval/run-case.ts). The evaluator depends on that: its wrap-up turn denies
   *  AskUserQuestion precisely so the model answers instead of asking, and
   *  ending the turn there loses the review entirely (caught by
   *  harness-review-runner.test.ts). */
  dismissed?: boolean;
}

// WHY there is no timeout, "held" state or late-answer route here any more
// (2026-09-16 decision): a specialist's routed ask used to be held for five
// minutes, then answered FOR the helper with a "still pending" redirect while
// the card stayed answerable. Every ask — the main assistant's or a
// specialist's — now simply waits for the person, so an entry is pending until
// it is answered or canceled, and nothing else.
interface PendingAsk {
  sessionId: string;
  /** The CHILD that raised a routed ask (see AskRequest.raisedBy) — read only
   *  by cancelSession, so a child's teardown also clears its own ask. */
  raisedBy?: string;
  resolve: (d: AskDecision) => void;
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
  /** One interval for ALL open asks — started when `pending` gains its first
   *  entry, stopped when it is empty. Never per-ask. */
  private reannounceTimer?: ReturnType<typeof setInterval>;

  /** Resolves only when a person answers (respond) or the ask is canceled —
   *  never on a timer. */
  ask(req: AskRequest): Promise<AskDecision> {
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
          // Spread-omitted like permissionMode below: absent unless the floor fired.
          ...(req.noAlwaysAllow ? { noAlwaysAllow: true } : {}),
          ...(req.specialist ? { specialist: req.specialist } : {}),
          // Spread-omitted (not `undefined`-valued) so the CC-path payload
          // shape is byte-identical to before this field existed.
          ...(req.permissionMode ? { permissionMode: req.permissionMode } : {}),
        },
      };
      const entry: PendingAsk = {
        sessionId: req.sessionId,
        raisedBy: req.raisedBy,
        resolve,
        announcement,
      };
      this.pending.set(requestId, entry);
      this.syncReannounceTimer();
      this.emitAnnouncement(entry);
    });
  }

  /** The ONE place a PermissionRequest hook-event is BUILT — the live
   *  announcement, every heartbeat and the pendingEventsFor() replay all route
   *  through this so the shape (sessionId/type/payload/timestamp) is defined in
   *  exactly one place. `payload` is a fresh copy per call: the stored
   *  announcement is reused indefinitely, so handing every listener the same
   *  object would let one in-process consumer's mutation rewrite what all
   *  later beats say. */
  private requestEventFor(entry: PendingAsk): HookEvent {
    return {
      sessionId: entry.announcement.sessionId,
      type: 'PermissionRequest',
      payload: { ...entry.announcement.payload },
      timestamp: Date.now(),
    };
  }

  /** The ONE place a PermissionRequest goes out, first time and every beat. */
  private emitAnnouncement(entry: PendingAsk): void {
    this.emit('hook-event', this.requestEventFor(entry));
  }

  /** Task 0 (ROADMAP #permissions, 2026-08-16): a renderer reload rebuilds
   *  every card from the on-disk transcript (TRANSCRIPT_REPLAY), but an open
   *  ask lives ONLY here — nothing on disk records that it is still awaiting
   *  an answer. Without this, the rebuilt card comes back with no buttons and
   *  an ask (which has no timeout) hangs the turn forever. Re-sending the
   *  stored `announcement` is the same "just say it again" trick the
   *  heartbeat above already relies on, one-shot instead of on an interval. */
  pendingEventsFor(sessionId: string): HookEvent[] {
    const events: HookEvent[] = [];
    for (const entry of this.pending.values()) {
      if (entry.sessionId !== sessionId) continue;
      events.push(this.requestEventFor(entry));
    }
    return events;
  }

  /** Re-emit every open ask — each one has a turn waiting on it. */
  private reannounce(): void {
    for (const entry of this.pending.values()) {
      this.emitAnnouncement(entry);
    }
  }

  /** Idempotent: run after any change to `pending`. */
  private syncReannounceTimer(): void {
    const answerable = this.pending.size > 0;
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
    // AskDecision.dismissed).
    const resolved: AskDecision = { behavior, always, grantScope, ...(behavior === 'deny' ? { dismissed: true } : {}), ...(updatedInput ? { updatedInput } : {}) };

    this.removeEntry(requestId, entry);
    entry.resolve(resolved);
    return true;
  }

  /** Is a routed ask raised by this specialist child still waiting on the
   *  person? WHY: a helper paused on an approval emits nothing, so without
   *  this the staleness check flagged it "may be stuck" and the main
   *  assistant read a waiting helper as a broken one. */
  isWaitingOnUser(childId: string): boolean {
    for (const entry of this.pending.values()) if (entry.raisedBy === childId) return true;
    return false;
  }

  /** `ownOnly` (Stop): cancel only the session's OWN asks, not asks routed to
   *  it by specialist children. WHY: Stop leaves background helpers running
   *  (NativeSessionHost.interrupt), and a helper's ask has no timeout — so a
   *  Stop press used to quietly kill a background helper that was waiting for
   *  approval. A foreground child's asks still go: interrupt() stops that
   *  child, whose own cancelSession(childId) matches by raisedBy. */
  cancelSession(sessionId: string, opts?: { ownOnly?: boolean }): void {
    for (const [id, entry] of [...this.pending]) {
      // Skip only asks raised by SOMEONE ELSE: interrupt(childId) passes the
      // child's own id, and that child's asks (raisedBy === childId) must go.
      if (opts?.ownOnly && entry.raisedBy && entry.raisedBy !== sessionId) continue;
      // `sessionId` is the card's HOME session (the parent, for a routed
      // ask); `raisedBy` is the specialist child that raised it. Either
      // being torn down cancels the ask — a child can no longer act on an
      // answer once it is gone, so its card must not linger.
      if (entry.sessionId !== sessionId && entry.raisedBy !== sessionId) continue;
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
    this.removeEntry(id, entry);
    // PermissionExpired clears the approval card; _requestId matches the field
    // hook-dispatcher reads for the expired branch. Emitted AFTER removeEntry's
    // PermissionResolved (below) so a RemoteServer buffer purge keyed on the
    // resolved id clears the now-stale Request first, THEN this terminal
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
   *  triggered it. Before this, `respond()` and `cancelOne()` each called `pending.delete` directly, and
   *  `respond()` emitted NOTHING on resolution (2026-08-16 review finding:
   *  "the catch-up replays asks that were already answered"). A phone
   *  reconnecting after answering a card in two seconds was replayed that
   *  same PermissionRequest out of RemoteServer's buffer — a dead question
   *  with live-looking Yes/No buttons; tapping either returned false and the
   *  card showed a "socket closed" message that was simply untrue. Routing
   *  every removal through here means RemoteServer only has to listen for
   *  ONE signal (`PermissionResolved`) to purge its buffer, instead of a
   *  per-route emit risking exactly the kind of miss this finding was about.
   *  Not built via requestEventFor() — that helper only knows the LIVE
   *  card state (Request); this is a new, renderer-invisible type
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
