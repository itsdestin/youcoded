// publish.ts — the ONE way a session-scoped push leaves the core (one-core R5-1, seam S6).
//
// WHY (2026-10-01 one-core R5-1): about a dozen places did `sendForSession(id, channel, …)` and then, a line
// later, `remoteServer.broadcast({ type, payload })` — two hand-kept audience lists that drifted whenever one
// line was edited and the other was not. `publish` makes the pair one call, and the same call appends to the
// session's record (session-record.ts). tests/session-publish-equivalence.test.ts pins that each converted
// site delivers exactly what the pair delivered; the ast-grep rule `no-paired-session-send-and-broadcast`
// rejects a new pair outside this file.
//
// Electron-free: the three deliveries are injected, so tests drive it without a window or a socket.
import type { SessionRecords } from './session-record';

export interface PublishDeps {
  records: Pick<SessionRecords, 'note'>;
  /**
   * The windows' leg: deliver `(channel, ...args)` to whoever owns or watches the session — exactly what
   * ipc-handlers' sendForSession does (owner + buddy subscribers, else the primary window).
   */
  toWindows(sessionId: string, channel: string, args: unknown[]): void;
  /**
   * The phones' leg: one `{type, payload}` message. `socketIds` is the registry's answer to "which phones
   * want this session" (every phone today); undefined means every connected phone.
   */
  toSockets(message: { type: string; payload: unknown }, socketIds: number[] | undefined): void;
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
  /** Runs between the windows' leg and the phones' leg (the replay-buffer write the old pairs did there; if it throws,
   *  phones are skipped exactly as before). */
  afterWindows?: () => void;
}

export type Publish = (sessionId: string, type: string, payload: unknown, options?: PublishOptions) => void;

export function createPublish(deps: PublishDeps): Publish {
  return function publish(sessionId, type, payload, options) {
    // Windows first, then phones: the order the pairs always had.
    deps.toWindows(sessionId, type, options?.windowArgs ?? [payload]);
    options?.afterWindows?.();
    deps.toSockets({ type, payload }, deps.socketsFor?.(sessionId));
    // The record is bookkeeping. A bug in it must never cost a screen its event, so it comes last and is fenced.
    try { deps.records.note(sessionId, type, payload); }
    catch (err) { console.warn('[publish] session record could not note an event:', type, String(err)); }
  };
}
