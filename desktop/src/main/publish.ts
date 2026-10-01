// publish.ts — the ONE way a session-scoped push leaves the core (one-core R5-1, seam S6).
//
// WHY (2026-10-01 one-core R5-1): about a dozen places did `sendForSession(id, channel, …)` and then, a line
// later, `remoteServer.broadcast({ type, payload })` — two hand-kept audience lists that drifted whenever one
// line was edited and the other was not. `publish` makes the pair one call, and the same call appends to the
// session's record (session-record.ts). tests/session-publish-equivalence.test.ts pins that each converted
// site delivers exactly what the pair delivered; the ast-grep rule `no-paired-session-send-and-broadcast`
// rejects a new pair outside this file.
//
// WHY (2026-10-01 one-core R5-2): publish now NUMBERS the event first and puts `{epoch, seq}` on the phone's message, so a
// phone can say where it got to and be sent exactly what it missed (session-open.ts). A screen that is being filled has
// its pushes for that session held until its answer is out (audience-fill.ts), and the phones' audience is the sessions
// each one has opened. The Claude Code hook relay now publishes through here too (its windows leg is the owner-only route
// main.ts always used, passed as `windows`), so the record sees an ask whether or not remote access is on.
//
// Electron-free: the three deliveries are injected, so tests drive it without a window or a socket.
import type { SessionRecords } from './session-record';
import type { AudienceFills } from './audience-fill';

/** Which screens, if any, wait for a held push: returns true when it took the delivery (it is queued). */
type HoldFn = (audienceId: number, deliver: () => void) => boolean;

export interface PublishDeps {
  records: Pick<SessionRecords, 'note' | 'epochOf'>;
  /** Holds a push for a screen that is being filled with this session. Omitted in tests that do not model one. */
  fills?: Pick<AudienceFills, 'hold'>;
  /**
   * The windows' leg: deliver `(channel, ...args)` to whoever owns or watches the session — exactly what
   * ipc-handlers' sendForSession does (owner + buddy subscribers, else the primary window). `hold` lets a window
   * that is being filled keep the delivery until its answer is out.
   */
  toWindows(sessionId: string, channel: string, args: unknown[], hold?: HoldFn): void;
  /**
   * The phones' leg: one `{type, payload}` message, with the event's `{epoch, seq}` when the record numbered it.
   * `socketIds` is the registry's answer to "which phones watch this session"; undefined means every connected phone.
   */
  toSockets(message: { type: string; payload: unknown; epoch?: string; seq?: number }, socketIds: number[] | undefined, hold?: HoldFn): void;
  /** The registry's socket audience for a session; omitted in tests that do not model one. */
  socketsFor?(sessionId: string): number[] | undefined;
}

interface PublishOptions {
  /**
   * What the WINDOWS receive after the channel name, when it differs from the phones' payload. Default: the
   * payload itself. Only session:meta-changed needs it (windows get `(sessionId, change)`, phones get
   * `{sessionId, ...change}` — a shape difference that predates this file and is kept as it was).
   */
  windowArgs?: unknown[];
  /** Runs between the windows' leg and the phones' leg (if it throws, phones are skipped). */
  afterWindows?: () => void;
  /** Replaces the windows' leg when a session-scoped push has a window route of its own (the Claude Code hook relay goes to the
   *  owner, never to a buddy subscriber). The phones' leg and the record are unchanged. */
  windows?: (sessionId: string, channel: string, args: unknown[], hold?: HoldFn) => void;
}

export type Publish = (sessionId: string, type: string, payload: unknown, options?: PublishOptions) => void;

export function createPublish(deps: PublishDeps): Publish {
  return function publish(sessionId, type, payload, options) {
    // Numbered FIRST so the phone's copy carries its number. The record is bookkeeping: a bug in it must never cost a
    // screen its event, so it is fenced and the push goes out unnumbered if it throws.
    let stamp: { epoch: string; seq: number } | null = null;
    try {
      const seq = deps.records.note(sessionId, type, payload);
      const epoch = seq === null ? null : deps.records.epochOf(sessionId);
      if (seq !== null && epoch) stamp = { epoch, seq };
    } catch (err) { console.warn('[publish] session record could not note an event:', type, String(err)); }
    const fills = deps.fills;
    const holdWindow: HoldFn | undefined = fills ? (id, deliver) => fills.hold(`w${id}`, sessionId, deliver) : undefined;
    const holdSocket: HoldFn | undefined = fills ? (id, deliver) => fills.hold(`s${id}`, sessionId, deliver) : undefined;
    // Windows first, then phones: the order the pairs always had.
    (options?.windows ?? deps.toWindows)(sessionId, type, options?.windowArgs ?? [payload], holdWindow);
    options?.afterWindows?.();
    deps.toSockets({ type, payload, ...(stamp ?? {}) }, deps.socketsFor?.(sessionId), holdSocket);
  };
}
