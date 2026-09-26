// admin-password-service.ts — task 4's main-side glue between AskpassServer's
// low-level socket protocol (harness/askpass/askpass-server.ts, task 3 —
// imported from, never edited here) and PermissionBroker's password-ask kind
// (task 4, permission-broker.ts): turns one verified askpass connection into
// exactly one PasswordRequest hook-event, and turns the renderer's Confirm
// button (native:submit-admin-password) into exactly one write back to that
// connection's socket.
//
// SCOPE (design §11, task 4 vs task 5): task 4 built the ask/withdraw/submit
// lifecycle against fakes for both `broker` and `askpass`. Task 5 (this
// revision) adds the up-front (R20) flow — `askUpFront`/`wipeUpfront` — and
// wires in RunningCalls (markGranted/recordSudoPath for the forget step,
// design §5) and the "accepted" signal ShellRegistry's admin flag (design
// §7) subscribes to. The real AskpassServer + RunningCalls construction and
// the Bash env/registration wiring itself live in native-session-host.ts /
// tools/bash.ts / shell-registry.ts — never here.
'use strict';

import { EventEmitter } from 'events';
import type { PermissionBroker, PasswordAskRequest } from './permission-broker';
import type { AskpassServer, AskpassAskEvent } from './askpass/askpass-server';
import { displayCommandFromSudoArgv, displayCommandFromArgv, sudoRealArgv } from './tools/admin-command';

/** Structural contract other modules (native-session-host.ts, tests) code
 *  against instead of importing the concrete class — same pattern as
 *  child-ask-router.ts's `Pick<PermissionBroker, 'ask'>`. */
export interface AdminPasswordServiceLike {
  submit(requestId: string, password: string): boolean;
  /** design §2.4/R20/§11 task 5: harness-session.ts calls this AFTER the
   *  approval card returns allow for a call whose admin verdict is 'admin',
   *  BEFORE spawning. Resolves 'submitted' once the person types the
   *  password (held in main as a Buffer, matched against
   *  `expectedArgvLines`); 'canceled' if Skip/Stop/session-close/quit ends
   *  the ask first — never a timeout (the ask lives in the SAME broker
   *  pending map as a permission ask, so it gets the same re-announce and
   *  cancellation). `expectedArgvLines` is `visibleSudoLines(command)`
   *  (tools/admin-command.ts) — the argv sudo will actually run for each
   *  visible `sudo` line in the approved command text. */
  askUpFront(req: {
    sessionId: string;
    toolCallId: string;
    expectedArgvLines: string[][];
  }): Promise<'submitted' | 'canceled'>;
  /** design §6: called by the Bash tool/registry on EVERY call exit
   *  (foreground close/error, or a background/handed-off run's own exit) —
   *  zeroes and drops a held up-front password that was never consumed (the
   *  sudo it was meant for never actually ran, or the call was killed
   *  before it did). A cheap no-op when nothing is held for `toolCallId`. */
  wipeUpfront(toolCallId: string): void;
}

/** Narrow, structural (design §5/§7, §11 task 5) — the only two RunningCalls
 *  members this service touches. Real wiring passes the actual
 *  `RunningCalls` instance (askpass/running-calls.ts), which satisfies this
 *  for free; a test can inject a bag of two `vi.fn()`s instead. */
export interface AdminPasswordRunningCallsLike {
  markGranted(toolCallId: string): void;
  recordSudoPath(sudoExePath: string): void;
}

/** design §2.4/review 3 F2: one visible-sudo command's password, held after
 *  the person typed it and before any askpass connection exists yet.
 *  `expectedArgvLines` are the ONLY sudo argvs this password may be handed
 *  to without a card — anything else in the same call still gets the
 *  ordinary mid-command ask. */
interface UpfrontHold {
  password: Buffer;
  expectedArgvLines: string[][];
}

/** A pending up-front ask still waiting for the person to submit or cancel —
 *  `resolve` settles `askUpFront`'s own returned Promise (never a decision;
 *  see PasswordAskRequest/PendingAsk — this ask lives in the broker's
 *  pending map exactly like a mid-command one, but nobody but THIS service
 *  ever reads its requestId back out). */
interface UpfrontWaiter {
  toolCallId: string;
  expectedArgvLines: string[][];
  resolve: (result: 'submitted' | 'canceled') => void;
}

function argvEquals(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** sudo's own default `passwd_tries` (design §6) — a sudoers override just
 *  means this count is off, which is why the card never claims certainty
 *  beyond "tries left" rather than an exact lockout count. */
const SUDO_DEFAULT_TRIES = 3;

/** Structural, NOT `Pick<PermissionBroker, ...>`: EventEmitter's `on()`
 *  overloads return `this`, so a `Pick` built from the concrete class forces
 *  every fake's `on()` to return a `PermissionBroker` specifically — a plain
 *  EventEmitter-based test fake can never satisfy that. Declaring `on()`
 *  here with a plain `unknown` return keeps both the real broker and a fake
 *  assignable. */
interface AdminPasswordBrokerLike {
  askPassword(req: PasswordAskRequest): string;
  withdraw(requestId: string): boolean;
  on(event: 'hook-event', cb: (e: { type: string; sessionId: string; payload: Record<string, unknown> }) => void): unknown;
}

/** Same reasoning as AdminPasswordBrokerLike above, for AskpassServer. */
interface AdminPasswordAskpassLike {
  on(event: 'ask', cb: (e: AskpassAskEvent) => void): unknown;
  on(event: 'withdrawn', cb: (askId: string) => void): unknown;
  deliver(askId: string, password: Buffer): boolean;
  refuse(askId: string): boolean;
}

// Compile-time proof the real classes actually satisfy the structural
// contracts above — if permission-broker.ts or askpass-server.ts ever drops
// one of these methods, this file fails to typecheck right here instead of
// silently degrading at the two `on()` calls in the constructor below.
type _BrokerSatisfies = PermissionBroker extends AdminPasswordBrokerLike ? true : never;
type _AskpassSatisfies = AskpassServer extends AdminPasswordAskpassLike ? true : never;
const _brokerCheck: _BrokerSatisfies = true;
const _askpassCheck: _AskpassSatisfies = true;
void _brokerCheck;
void _askpassCheck;

export interface AdminPasswordServiceDeps {
  /** Structural — a test injects a fake with just these three members
   *  instead of standing up a real broker. */
  broker: AdminPasswordBrokerLike;
  /** Structural — same reasoning; a test drives a fake socket-less
   *  AskpassServer instead of a real unix socket + real /proc reads. */
  askpass: AdminPasswordAskpassLike;
  /** Specialist-child routing (design §2.5: "for a specialist child session,
   *  route to the parent session labelled like child-ask-router does").
   *  Undefined, or returning null, means "not a child, or nothing to route"
   *  — the ask stays on `event.sessionId` with no `specialist` label. The
   *  childId -> {parentId, title, parentToolCallId} mapping lives entirely
   *  inside native-session-host.ts's own bookkeeping (task 5 wires the real
   *  lookup there); injecting it here keeps this file decoupled from that
   *  class the same way childAskRouter's own deps are decoupled from it. */
  resolveSpecialistChild?: (sessionId: string) => {
    parentId: string;
    childId: string;
    agentType: string;
    title: string;
    parentToolCallId: string;
  } | null;
  /** Injectable for tests (a fixed value instead of a real Buffer); defaults
   *  to `Buffer.from(password, 'utf8')`. */
  toBuffer?: (password: string) => Buffer;
  /** design §5/§7, §11 task 5: markGranted (the forget-Set) and
   *  recordSudoPath (the `-K` target) on every delivery. Optional so task
   *  4's existing tests (which never construct a real RunningCalls) keep
   *  passing unchanged — defaults to a no-op pair. */
  runningCalls?: AdminPasswordRunningCallsLike;
}

export class AdminPasswordService extends EventEmitter implements AdminPasswordServiceLike {
  private readonly broker: AdminPasswordServiceDeps['broker'];
  private readonly askpass: AdminPasswordServiceDeps['askpass'];
  private readonly resolveSpecialistChild: AdminPasswordServiceDeps['resolveSpecialistChild'];
  private readonly toBuffer: (password: string) => Buffer;
  private readonly runningCalls: AdminPasswordRunningCallsLike;

  // Bidirectional so either side's own event can find and drop the OTHER
  // half's mapping FIRST, before triggering an action that would otherwise
  // loop back and re-trigger this same pair — see submit()/onWithdrawn()/
  // onPasswordResolved() below, which all rely on this ordering.
  private readonly askIdByRequestId = new Map<string, string>();
  private readonly requestIdByAskId = new Map<string, string>();
  /** askId -> the delivery-time bookkeeping submit()'s mid-command branch
   *  needs but does not otherwise have in hand (it only ever sees a bare
   *  requestId from the renderer). Populated in onAsk's normal-card branch,
   *  consumed (and dropped) in submit(). */
  private readonly askMeta = new Map<string, { toolCallId: string; sessionId: string; sudoPid: number; sudoExePath: string }>();

  // design §2.4/review 3 F2 — the up-front flow's own bookkeeping.
  private readonly upfrontByToolCallId = new Map<string, UpfrontHold>();
  private readonly upfrontWaiters = new Map<string, UpfrontWaiter>();

  // design §7 — "accepted" (no re-ask within ~1s of a delivery), keyed by
  // sudoPid so a SAME-pid retry (the previous password was wrong) cancels
  // the pending signal for that wrong delivery outright.
  private readonly acceptanceTimers = new Map<number, NodeJS.Timeout>();

  constructor(deps: AdminPasswordServiceDeps) {
    super();
    this.broker = deps.broker;
    this.askpass = deps.askpass;
    this.resolveSpecialistChild = deps.resolveSpecialistChild;
    this.toBuffer = deps.toBuffer ?? ((password: string) => Buffer.from(password, 'utf8'));
    this.runningCalls = deps.runningCalls ?? { markGranted: () => {}, recordSudoPath: () => {} };

    this.askpass.on('ask', (event: AskpassAskEvent) => this.onAsk(event));
    this.askpass.on('withdrawn', (askId: string) => this.onWithdrawn(askId));
    // The broker's OWN cancellation paths (cancelSession/cancelAll — Stop,
    // Skip, session close, app quit) remove a password ask without going
    // through this service at all; PasswordResolved is how we learn about
    // that and refuse the socket we would otherwise leave hanging (design
    // §6: "pending sockets answered {ok:false}").
    this.broker.on('hook-event', (event: { type: string; payload: Record<string, unknown> }) => {
      if (event.type !== 'PasswordResolved') return;
      const requestId = event.payload._requestId;
      if (typeof requestId !== 'string') return;
      // design §2.4 up-front cancellation: Skip/Stop/session-close/quit
      // removed the ask via broker.cancelSession/cancelAll — a route that,
      // like the mid-command one below, never goes through submit(). A
      // waiter still present here means submit() did NOT already resolve
      // it (submit() removes the waiter FIRST — see its own comment).
      const waiter = this.upfrontWaiters.get(requestId);
      if (waiter) {
        this.upfrontWaiters.delete(requestId);
        waiter.resolve('canceled');
        return;
      }
      this.onPasswordResolved(requestId);
    });
  }

  private forget(requestId: string, askId: string): void {
    this.askIdByRequestId.delete(requestId);
    this.requestIdByAskId.delete(askId);
    this.askMeta.delete(askId);
  }

  /** design §7: schedules the "accepted" signal ~1s after a delivery, and —
   *  called unconditionally at the top of onAsk BEFORE anything else — a
   *  fresh ask for the SAME sudo pid cancels whatever was pending for it,
   *  because that can only mean the previous delivery for this exact pid was
   *  wrong and sudo is asking again (design §7 must never fire "accepted"
   *  for a password that turned out wrong). */
  private clearAcceptanceTimer(sudoPid: number): void {
    const timer = this.acceptanceTimers.get(sudoPid);
    if (!timer) return;
    clearTimeout(timer);
    this.acceptanceTimers.delete(sudoPid);
  }

  private scheduleAcceptance(info: { sudoPid: number; sessionId: string; toolCallId: string }): void {
    this.clearAcceptanceTimer(info.sudoPid);
    const timer = setTimeout(() => {
      this.acceptanceTimers.delete(info.sudoPid);
      this.emit('accepted', { sessionId: info.sessionId, toolCallId: info.toolCallId });
    }, 1_000);
    // WHY unref'd: an accepted-but-not-yet-fired timer must never be the
    // reason the main process refuses to exit (same reasoning as the
    // broker's own re-announce timer).
    timer.unref?.();
    this.acceptanceTimers.set(info.sudoPid, timer);
  }

  private onAsk(event: AskpassAskEvent): void {
    // Any earlier "accepted" signal pending for this exact sudo pid is now
    // moot — see clearAcceptanceTimer's own comment.
    this.clearAcceptanceTimer(event.sudoPid);

    // design §2.4/review 3 F2: a held up-front password for THIS call only
    // ever satisfies the FIRST ask whose sudo argv matches one of the
    // approved lines — wiped on that match regardless of whether sudo later
    // accepts it (a wrong one still shows the normal card via a SECOND ask,
    // design §2.4: "sudo asks again -> normal card with triesLeft"). An ask
    // that does NOT match (a hidden sudo elsewhere in the same call) leaves
    // the hold intact and falls through to the ordinary card below.
    const hold = this.upfrontByToolCallId.get(event.toolCallId);
    if (hold) {
      const real = sudoRealArgv(event.sudoArgv);
      if (hold.expectedArgvLines.some((line) => argvEquals(line, real))) {
        this.upfrontByToolCallId.delete(event.toolCallId);
        this.askpass.deliver(event.askId, hold.password); // zeroes it
        this.runningCalls.markGranted(event.toolCallId);
        this.runningCalls.recordSudoPath(event.sudoExePath);
        this.scheduleAcceptance({ sudoPid: event.sudoPid, sessionId: event.sessionId, toolCallId: event.toolCallId });
        return;
      }
    }

    const command = displayCommandFromSudoArgv(event.sudoArgv);
    // Design §6: attempt 0 (the first ask for this sudo pid) carries no
    // triesLeft — the card only starts warning about tries after a WRONG
    // one. attempt N (N>0) means N previous passwords were wrong.
    const triesLeft = event.attempt > 0 ? SUDO_DEFAULT_TRIES - event.attempt : undefined;

    const child = this.resolveSpecialistChild?.(event.sessionId) ?? null;
    const req: PasswordAskRequest = {
      sessionId: child ? child.parentId : event.sessionId,
      toolUseId: event.toolCallId,
      command,
      via: event.via,
      triesLeft,
      specialist: child
        ? { childId: child.childId, agentType: child.agentType, title: child.title, parentToolCallId: child.parentToolCallId }
        : undefined,
      raisedBy: child ? child.childId : undefined,
    };
    const requestId = this.broker.askPassword(req);

    this.askIdByRequestId.set(requestId, event.askId);
    this.requestIdByAskId.set(event.askId, requestId);
    this.askMeta.set(event.askId, { toolCallId: event.toolCallId, sessionId: event.sessionId, sudoPid: event.sudoPid, sudoExePath: event.sudoExePath });
  }

  private onWithdrawn(askId: string): void {
    // The SOCKET went away first (sudo gave up, the command was killed) —
    // the mirror image of submit()'s order below: drop the mapping BEFORE
    // telling the broker, so the broker's own PasswordResolved hook-event
    // finds nothing left to act on in onPasswordResolved.
    const requestId = this.requestIdByAskId.get(askId);
    if (!requestId) return;
    this.forget(requestId, askId);
    this.broker.withdraw(requestId);
  }

  private onPasswordResolved(requestId: string): void {
    // The BROKER side closed first (a session Stop/Skip/close/quit, or a
    // requestId this service already forgot — e.g. submit()'s own withdraw,
    // which is exactly why submit() forgets the mapping BEFORE calling it).
    // Refuse the askpass connection if one is still open; a no-op otherwise.
    const askId = this.askIdByRequestId.get(requestId);
    if (!askId) return;
    this.forget(requestId, askId);
    this.askpass.refuse(askId);
  }

  /** native:submit-admin-password (design §2.5). Converts the string to a
   *  Buffer ONLY here and hands it straight to the verified socket;
   *  AskpassServer.deliver() zeroes that Buffer before this call returns.
   *  `password` itself is never stored, logged, or handed to anything else
   *  — it does not outlive this one call. Returns false for an unknown or
   *  already-settled requestId (the card reads that as "this request
   *  expired"). */
  submit(requestId: string, password: string): boolean {
    // design §2.4 up-front: this requestId belongs to the up-front card
    // (askUpFront), not a mid-command askId — the password is HELD (never
    // handed to askpass directly), for the first matching onAsk to consume.
    const waiter = this.upfrontWaiters.get(requestId);
    if (waiter) {
      this.upfrontWaiters.delete(requestId);
      this.upfrontByToolCallId.set(waiter.toolCallId, {
        password: this.toBuffer(password),
        expectedArgvLines: waiter.expectedArgvLines,
      });
      this.broker.withdraw(requestId);
      waiter.resolve('submitted');
      return true;
    }

    const askId = this.askIdByRequestId.get(requestId);
    if (!askId) return false;
    const meta = this.askMeta.get(askId);
    // Drop the mapping FIRST: withdraw() below fires the broker's own
    // PasswordResolved hook-event, which onPasswordResolved listens for and
    // would otherwise try to refuse the very socket this call just
    // delivered to.
    this.forget(requestId, askId);
    const delivered = this.askpass.deliver(askId, this.toBuffer(password));
    if (delivered && meta) {
      // design §5/§7: markGranted/recordSudoPath feed the forget step; the
      // "accepted" signal (below) is what lets ShellRegistry's admin flag
      // rely on "no re-ask within ~1s" rather than "a delivery happened at
      // all" (a wrong password also "happens" — it just gets a second ask).
      this.runningCalls.markGranted(meta.toolCallId);
      this.runningCalls.recordSudoPath(meta.sudoExePath);
      this.scheduleAcceptance({ sudoPid: meta.sudoPid, sessionId: meta.sessionId, toolCallId: meta.toolCallId });
    }
    // Withdrawn regardless of whether delivery succeeded: either way this
    // ask is no longer open, and every OTHER device watching this session
    // (a second window, a paired phone — contract R6) needs to see its card
    // end too, not just the device that submitted.
    this.broker.withdraw(requestId);
    return delivered;
  }

  /** design §2.4/R20/§11 task 5 — see AdminPasswordServiceLike.askUpFront's
   *  own doc for the contract. Card text is the FIRST visible sudo line's
   *  display form (design §2.4: "command = displayCommand of the first
   *  visible sudo line, no via"). */
  askUpFront(req: { sessionId: string; toolCallId: string; expectedArgvLines: string[][] }): Promise<'submitted' | 'canceled'> {
    const command = req.expectedArgvLines[0] ? displayCommandFromArgv(req.expectedArgvLines[0]) : '';
    const child = this.resolveSpecialistChild?.(req.sessionId) ?? null;
    const pwReq: PasswordAskRequest = {
      sessionId: child ? child.parentId : req.sessionId,
      toolUseId: req.toolCallId,
      command,
      specialist: child
        ? { childId: child.childId, agentType: child.agentType, title: child.title, parentToolCallId: child.parentToolCallId }
        : undefined,
      raisedBy: child ? child.childId : undefined,
    };
    const requestId = this.broker.askPassword(pwReq);
    return new Promise<'submitted' | 'canceled'>((resolve) => {
      this.upfrontWaiters.set(requestId, { toolCallId: req.toolCallId, expectedArgvLines: req.expectedArgvLines, resolve });
    });
  }

  /** design §6/§11 task 5 — see AdminPasswordServiceLike.wipeUpfront's own
   *  doc. */
  wipeUpfront(toolCallId: string): void {
    const hold = this.upfrontByToolCallId.get(toolCallId);
    if (!hold) return;
    this.upfrontByToolCallId.delete(toolCallId);
    hold.password.fill(0);
  }
}
