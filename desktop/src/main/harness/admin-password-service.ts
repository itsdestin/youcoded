// admin-password-service.ts — task 4's main-side glue between AskpassServer's
// low-level socket protocol (harness/askpass/askpass-server.ts, task 3 —
// imported from, never edited here) and PermissionBroker's password-ask kind
// (task 4, permission-broker.ts): turns one verified askpass connection into
// exactly one PasswordRequest hook-event, and turns the renderer's Confirm
// button (native:submit-admin-password) into exactly one write back to that
// connection's socket.
//
// SCOPE (design §11, task 4 vs task 5): this file owns the ask/withdraw/
// submit lifecycle end to end and is fully testable against fakes for both
// `broker` and `askpass`. It does NOT touch Bash's env, RunningCalls
// registration, or the up-front (R20) flow — task 5 constructs the real
// AskpassServer + RunningCalls, wires them into Bash, builds ONE of these
// services around them, and hands it to NativeSessionHost.setAdminPasswordService.
// Until then `submit()` has nothing live to reach and honestly returns false.
'use strict';

import type { PermissionBroker, PasswordAskRequest } from './permission-broker';
import type { AskpassServer, AskpassAskEvent } from './askpass/askpass-server';
import { displayCommandFromSudoArgv } from './tools/admin-command';

/** Structural contract other modules (native-session-host.ts, tests) code
 *  against instead of importing the concrete class — same pattern as
 *  child-ask-router.ts's `Pick<PermissionBroker, 'ask'>`. */
export interface AdminPasswordServiceLike {
  submit(requestId: string, password: string): boolean;
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
}

// WHAT TASK 5's UP-FRONT FLOW (design §2.4) WILL NEED BEYOND submit():
// a way to hand this service a password BEFORE any askpass connection
// exists, because the approval card already named `sudo` visibly (R20) and
// the person typed the password right after approving — before the command
// even spawned. That needs a THIRD registration path alongside onAsk/
// onWithdrawn above: keyed to the exact toolCallId and the exact sudo argv
// the up-front ask approved (`visibleSudoLines`, tools/admin-command.ts), so
// a DIFFERENT sudo hidden in the same call (a downloaded script) still gets
// the ordinary mid-command ask instead of this pre-typed password (design
// §2.4, review 3 F2) — and a signal this service would need to emit once a
// password is actually accepted, for task 5's `ShellRegistry.admin` flag
// (design §7, "Running as admin") to subscribe to.
//
// Deliberately NOT typed out as a real interface/method here: nothing in
// this task calls it, and an unused export is dead code this codebase's own
// knip gate refuses to grow on spec — task 5 adds the real shape together
// with its first caller.

export class AdminPasswordService implements AdminPasswordServiceLike {
  private readonly broker: AdminPasswordServiceDeps['broker'];
  private readonly askpass: AdminPasswordServiceDeps['askpass'];
  private readonly resolveSpecialistChild: AdminPasswordServiceDeps['resolveSpecialistChild'];
  private readonly toBuffer: (password: string) => Buffer;

  // Bidirectional so either side's own event can find and drop the OTHER
  // half's mapping FIRST, before triggering an action that would otherwise
  // loop back and re-trigger this same pair — see submit()/onWithdrawn()/
  // onPasswordResolved() below, which all rely on this ordering.
  private readonly askIdByRequestId = new Map<string, string>();
  private readonly requestIdByAskId = new Map<string, string>();

  constructor(deps: AdminPasswordServiceDeps) {
    this.broker = deps.broker;
    this.askpass = deps.askpass;
    this.resolveSpecialistChild = deps.resolveSpecialistChild;
    this.toBuffer = deps.toBuffer ?? ((password: string) => Buffer.from(password, 'utf8'));

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
      if (typeof requestId === 'string') this.onPasswordResolved(requestId);
    });
  }

  private forget(requestId: string, askId: string): void {
    this.askIdByRequestId.delete(requestId);
    this.requestIdByAskId.delete(askId);
  }

  private onAsk(event: AskpassAskEvent): void {
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
    const askId = this.askIdByRequestId.get(requestId);
    if (!askId) return false;
    // Drop the mapping FIRST: withdraw() below fires the broker's own
    // PasswordResolved hook-event, which onPasswordResolved listens for and
    // would otherwise try to refuse the very socket this call just
    // delivered to.
    this.forget(requestId, askId);
    const delivered = this.askpass.deliver(askId, this.toBuffer(password));
    // Withdrawn regardless of whether delivery succeeded: either way this
    // ask is no longer open, and every OTHER device watching this session
    // (a second window, a paired phone — contract R6) needs to see its card
    // end too, not just the device that submitted.
    this.broker.withdraw(requestId);
    return delivered;
  }
}
