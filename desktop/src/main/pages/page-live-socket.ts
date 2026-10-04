// A page's LIVE connection to its approved home device (spec
// 2026-10-04-page-live-socket-and-camera-video.md, Part 1).
//
// WHY: the one-shot exchange (page-socket.ts) answers a question and hangs up.
// "A card changes the moment the device does" needs a connection that stays
// open, so this module keeps one — under every rule the one-shot has (the same
// access check, run again on EVERY connect; the key only inside the approved
// greeting; every received message redacted) plus the rules a long-lived
// connection needs: who owns it, how many there can be, how fast, how big, how
// it recovers, and when it must stop.
//
// Main is the only place any of this is decided. The renderer (PageHost) and
// the page are untrusted callers that name a page and a frame; main generates
// the socket id and remembers the owner (a window or a remote client).
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { redact, type PageRateGate } from './page-fetch';
import { checkOutgoingSocketMessage, socketTarget, MAX_SOCKET_MESSAGE_BYTES, type DeviceSocketAccess } from './page-socket';
import type { PageSocketCall, PageSocketCallResult, PageSocketEvent, PageSocketOpenResult, PageSocketState } from '../../shared/pages-types';

/** Every limit in one place (the spec's Guardrails table). */
export const LIVE_LIMITS = {
  perPage: 2, perOwner: 4, perApp: 8,
  /** Out: messages per second, and size of each (bytes). */
  sendsPerSecond: 20, sendBytes: MAX_SOCKET_MESSAGE_BYTES,
  /** In: one message (a whole house's first subscribe_entities answer is large). */
  inMessageBytes: 1_000_000,
  /** In: batching — one push every 100 ms, at most 256 KB each. */
  batchMs: 100, pushBytes: 256_000,
  /** In: more than this in the window closes the socket. */
  floodBytes: 2_000_000, floodWindowMs: 10_000,
  binaryFrames: 20,
  openWaitMs: 10_000,
  /** Reconnect: 1, 2, 4 … 30 s, give up after 10 minutes down. */
  backoffStartMs: 1_000, backoffMaxMs: 30_000, giveUpMs: 600_000,
  /** The lease: main closes a socket nobody has pinged for this long. */
  leaseMs: 60_000,
  /** A connection with no "logged in" reply to wait for counts as sound once it has stayed open this long. */
  stableMs: 10_000,
  /** A remote client holding more than this unread is too slow for a live feed. */
  remoteBacklogBytes: 4 * 1024 * 1024,
} as const;

/** The minimum a socket must offer, so a test can hand in its own. */
export interface LiveWsLike {
  on(event: 'open', cb: () => void): unknown;
  on(event: 'message', cb: (data: WebSocket.RawData, isBinary: boolean) => void): unknown;
  on(event: 'close', cb: (code?: number) => void): unknown;
  on(event: 'error', cb: (e: Error) => void): unknown;
  on(event: 'unexpected-response', cb: (req: unknown, res: { statusCode?: number }) => void): unknown;
  send(data: string): void;
  terminate(): void;
}

export type PushResult = 'sent' | 'backed-up' | 'gone';
/** Who a socket belongs to, and how to reach them. `key` is `window:<id>` or
 *  `client:<id>`; events go to this owner and nobody else. */
export interface SocketOwner { key: string; push: (event: PageSocketEvent) => PushResult }

export interface LiveSocketDeps {
  /** The whole check chain for this page and address (service: approvals,
   *  fingerprint, saved key, home-address check). Called on every connect. */
  access: (pageId: string, url: string, signal: AbortSignal) => Promise<DeviceSocketAccess>;
  gate: Pick<PageRateGate, 'acquire' | 'release'>;
  /** Test injection: open the socket. Default: the `ws` client. */
  connect?: (url: string, headers: Record<string, string>) => LiveWsLike;
}

export function defaultConnect(url: string, headers: Record<string, string>): LiveWsLike {
  return new WebSocket(url, {
    headers: { 'User-Agent': 'YouCoded', ...headers },
    // A redirect would be a second address nobody approved.
    followRedirects: false,
    // ws closes the connection (code 1009) on anything bigger.
    maxPayload: LIVE_LIMITS.inMessageBytes,
    handshakeTimeout: LIVE_LIMITS.openWaitMs,
  });
}

interface Live {
  id: string;
  owner: SocketOwner;
  page: string;
  frame: string;
  url: string;
  state: PageSocketState;
  /** Bumped on every attempt, drop and close: anything a stale connection or
   *  timer reports afterwards is ignored. */
  gen: number;
  tries: number;
  ws: LiveWsLike | null;
  connectionId: string | null;
  deny: readonly string[];
  secrets: string[];
  authFailedType?: string;
  readyType?: string;
  attempt: number;
  downSince: number | null;
  lastPing: number;
  abort: AbortController;
  sentAt: number[];
  flow: Array<{ t: number; bytes: number }>;
  binary: number;
  sawReady: boolean;
  batch: string[];
  closed: boolean;
  timers: { open?: ReturnType<typeof setTimeout>; backoff?: ReturnType<typeof setTimeout>; lease?: ReturnType<typeof setTimeout>; batch?: ReturnType<typeof setTimeout>; stable?: ReturnType<typeof setTimeout> };
}

const refusal = (message: string): { ok: false; message: string } => ({ ok: false, message });
const NOT_YOURS = 'That live connection is not open any more.';

export class PageLiveSockets {
  private readonly sockets = new Map<string, Live>();
  constructor(private readonly deps: LiveSocketDeps) {}

  /** How many are alive (tests, and the caps below). */
  get count(): number { return this.sockets.size; }

  async open(owner: SocketOwner, req: PageSocketCall & { url: string }): Promise<PageSocketOpenResult> {
    if (typeof req?.page !== 'string' || !req.page || typeof req.frame !== 'string' || !req.frame || typeof req.url !== 'string' || req.url.length > 2048) {
      return refusal('That page asked for a live connection the app could not read.');
    }
    // Caps (2 per page, 4 per window or client, 8 per app) are counted on the
    // records, which exist from this moment, so two quick opens cannot both pass.
    const all = [...this.sockets.values()];
    if (all.filter((s) => s.page === req.page).length >= LIVE_LIMITS.perPage) return refusal(`A page may keep at most ${LIVE_LIMITS.perPage} live connections open.`);
    if (all.filter((s) => s.owner.key === owner.key).length >= LIVE_LIMITS.perOwner) return refusal(`This window may keep at most ${LIVE_LIMITS.perOwner} live connections open.`);
    if (all.length >= LIVE_LIMITS.perApp) return refusal(`YouCoded may keep at most ${LIVE_LIMITS.perApp} live connections open at once.`);

    const s: Live = {
      // Unguessable, and chosen here: a frame can never name an id of its own.
      id: `ls_${randomBytes(16).toString('hex')}`,
      owner, page: req.page, frame: req.frame, url: req.url,
      state: 'connecting', gen: 0, tries: 0, ws: null, connectionId: null, deny: [], secrets: [],
      attempt: 0, downSince: null, lastPing: Date.now(), abort: new AbortController(),
      sentAt: [], flow: [], binary: 0, sawReady: false, batch: [], closed: false, timers: {},
    };
    this.sockets.set(s.id, s);
    this.armLease(s);
    const first = await this.connectOnce(s);
    // The page asked for something refused outright (not approved, no key, a
    // website): that is an answer to the open, not a socket that fails later.
    if (first.kind === 'refused') { this.finish(s, first.message, false); return refusal(first.message); }
    if (first.kind === 'aborted') return refusal(NOT_YOURS);
    return { ok: true, socket: s.id };
  }

  send(ownerKey: string, req: PageSocketCall & { socket: string; text: string }): PageSocketCallResult {
    const s = this.owned(ownerKey, req);
    if (!s) return refusal(NOT_YOURS);
    // Refused unless open: a greeting is in flight, or the connection dropped.
    if (s.state !== 'open' || !s.ws) return refusal('The live connection is not open right now.');
    if (typeof req.text !== 'string' || Buffer.byteLength(req.text) > LIVE_LIMITS.sendBytes) return refusal('That page tried to send a message the app could not send.');
    const now = Date.now();
    s.sentAt = s.sentAt.filter((t) => now - t < 1000);
    if (s.sentAt.length >= LIVE_LIMITS.sendsPerSecond) return refusal('That page is sending faster than the app allows. Slow down and try again.');
    // The checked, re-serialised text is what is sent (see checkOutgoingSocketMessage).
    const vetted = checkOutgoingSocketMessage(req.text, s.deny);
    if (!vetted.ok) return refusal(vetted.reason);
    try { s.ws.send(vetted.text); } catch { return refusal('The live connection could not send that.'); }
    s.sentAt.push(now);
    return { ok: true };
  }

  /** The page closed it. Nothing is pushed back: the host already knows. */
  close(ownerKey: string, req: PageSocketCall & { socket: string }): PageSocketCallResult {
    const s = this.owned(ownerKey, req);
    if (!s) return refusal(NOT_YOURS);
    this.finish(s, 'Closed by the page.', false);
    return { ok: true };
  }

  ping(ownerKey: string, req: PageSocketCall & { socket: string }): PageSocketCallResult {
    const s = this.owned(ownerKey, req);
    if (!s) return refusal(NOT_YOURS);
    s.lastPing = Date.now();
    return { ok: true };
  }

  /** Close every socket a page holds (or only those on one connection) because
   *  its approval, key, code or manifest changed. Sockets still connecting
   *  (connection not known yet) are closed too: better a retry than a guess. */
  closeFor(pageId: string, connectionId?: string, why = 'This page\'s connection was changed, so its live connection stopped.'): void {
    for (const s of [...this.sockets.values()]) {
      if (s.page !== pageId) continue;
      if (connectionId !== undefined && s.connectionId !== null && s.connectionId !== connectionId) continue;
      this.finish(s, why, true);
    }
  }

  /** The window navigated, crashed or closed, or the remote client dropped. */
  closeOwner(ownerKey: string): void {
    for (const s of [...this.sockets.values()]) if (s.owner.key === ownerKey) this.finish(s, 'The window that held this connection went away.', false);
  }

  closeAll(): void {
    for (const s of [...this.sockets.values()]) this.finish(s, 'YouCoded is stopping.', false);
  }

  private owned(ownerKey: string, req: PageSocketCall & { socket: string }): Live | null {
    const s = typeof req?.socket === 'string' ? this.sockets.get(req.socket) : undefined;
    // One answer for "no such socket" and "not yours": never confirm an id.
    return s && !s.closed && s.owner.key === ownerKey && s.page === req.page && s.frame === req.frame ? s : null;
  }

  // ── Connecting ─────────────────────────────────────────────────────────

  /** One attempt: the rate slot, the whole check chain, then the wire. */
  private async connectOnce(s: Live): Promise<{ kind: 'started' } | { kind: 'aborted' } | { kind: 'refused'; message: string; transient: boolean }> {
    const gen = ++s.gen;
    s.tries++;
    // WHY released at once: the gate counts opens per minute; a socket that
    // lives for hours must not hold one of the page's in-flight slots.
    if (!(await this.deps.gate.acquire(s.page))) return { kind: 'refused', message: 'This page is opening live connections faster than the app allows. It will be able to try again shortly.', transient: true };
    this.deps.gate.release(s.page);
    if (s.closed || gen !== s.gen) return { kind: 'aborted' };
    const access = await this.deps.access(s.page, s.url, s.abort.signal);
    if (s.closed || gen !== s.gen) return { kind: 'aborted' };
    if (!access.ok) {
      const r = access.refusal;
      // A failed home-address look-up may pass on the next try; an approval,
      // key or address that is refused will not, so it is never retried.
      return { kind: 'refused', message: r.ok ? 'Refused.' : r.message, transient: !r.ok && r.reason === 'network' };
    }
    s.connectionId = access.connection.id;
    s.deny = access.connection.socketDeny ?? [];
    s.secrets = access.secrets;
    s.readyType = access.connection.socketReady;
    s.authFailedType = access.connection.socketAuthFailed;
    s.sawReady = false; s.binary = 0; s.flow = []; s.batch = [];
    const { wsUrl, headers, helloText } = socketTarget(access);
    const host = access.httpUrl.hostname;

    let ws: LiveWsLike;
    try { ws = (this.deps.connect ?? defaultConnect)(wsUrl.toString(), headers); }
    catch (error) { return { kind: 'refused', message: `The app could not reach ${host}. ${redact(error instanceof Error ? error.message : String(error), s.secrets)}`.trim(), transient: true }; }
    s.ws = ws;
    // The 10-second limit to reach 'open'. The first attempt that never opens
    // is closed with a plain reason; a reconnect attempt counts as a failed try.
    s.timers.open = setTimeout(() => {
      s.timers.open = undefined;
      if (s.closed || gen !== s.gen) return;
      const why = `${host} did not answer within ${LIVE_LIMITS.openWaitMs / 1000} seconds.`;
      if (s.tries <= 1) this.finish(s, why, true); else this.dropped(s, why);
    }, LIVE_LIMITS.openWaitMs);

    ws.on('open', () => {
      if (s.closed || gen !== s.gen) { try { ws.terminate(); } catch { /* gone */ } return; }
      clearTimeout(s.timers.open); s.timers.open = undefined;
      try { if (helloText) ws.send(helloText); }
      catch (e) { this.dropped(s, redact(e instanceof Error ? e.message : String(e), s.secrets)); return; }
      this.setState(s, 'open');
      // With no "logged in" reply to wait for, staying open is the only proof.
      if (!s.readyType) s.timers.stable = setTimeout(() => { if (!s.closed && gen === s.gen) this.markStable(s); }, LIVE_LIMITS.stableMs);
    });
    ws.on('message', (data, isBinary) => { if (!s.closed && gen === s.gen) this.received(s, data, isBinary); });
    ws.on('unexpected-response', (_req, res) => { if (!s.closed && gen === s.gen) this.dropped(s, `${host} answered ${res?.statusCode ?? 'without a socket'} instead of opening a socket.`); });
    ws.on('error', (e) => { if (!s.closed && gen === s.gen) this.dropped(s, `Lost the connection to ${host}. ${redact(e?.message ?? '', s.secrets)}`.trim()); });
    ws.on('close', (code) => {
      if (s.closed || gen !== s.gen) return;
      // ws answers a message over the 1 MB limit by closing with 1009: retrying would only fetch the same message again.
      if (code === 1009) this.finish(s, `${host} sent a message larger than the app will pass to a page, so the live connection was closed.`, true);
      else this.dropped(s, `Lost the connection to ${host}.`);
    });
    return { kind: 'started' };
  }

  /** The connection is gone and the socket is still wanted: back off and retry. */
  private dropped(s: Live, why: string): void {
    if (s.closed) return;
    // Bumping the generation makes everything the old connection says from now on stale.
    s.gen++;
    this.flush(s);
    this.stopWire(s);
    const now = Date.now();
    s.downSince ??= now;
    const delay = Math.min(LIVE_LIMITS.backoffMaxMs, LIVE_LIMITS.backoffStartMs * 2 ** s.attempt);
    s.attempt++;
    if (now + delay - s.downSince > LIVE_LIMITS.giveUpMs) {
      this.finish(s, `${why} It has been down for ${Math.round(LIVE_LIMITS.giveUpMs / 60_000)} minutes, so the app stopped trying.`, true);
      return;
    }
    this.setState(s, 'reconnecting', `${why} Trying again in ${Math.round(delay / 1000)} s.`);
    s.timers.backoff = setTimeout(() => { s.timers.backoff = undefined; void this.reconnect(s); }, delay);
  }

  private async reconnect(s: Live): Promise<void> {
    if (s.closed) return;
    const r = await this.connectOnce(s);
    if (r.kind === 'aborted' || s.closed) return;
    if (r.kind === 'refused') {
      if (r.transient) this.dropped(s, r.message); else this.finish(s, r.message, true);
    }
  }

  /** A logged-in (or long-open) connection: the backoff starts over. A close
   *  right after opening is NOT this, so a flapping device keeps backing off. */
  private markStable(s: Live): void { s.attempt = 0; s.downSince = null; }

  // ── What the device says ───────────────────────────────────────────────

  private received(s: Live, data: WebSocket.RawData, isBinary: boolean): void {
    // Text only: bytes would carry the key past the text redaction.
    if (isBinary) {
      if (++s.binary >= LIVE_LIMITS.binaryFrames) this.finish(s, 'The device sent data the app does not pass on, so the live connection was closed.', true);
      return;
    }
    const raw = data.toString();
    const bytes = Buffer.byteLength(raw);
    const now = Date.now();
    s.flow = s.flow.filter((f) => now - f.t < LIVE_LIMITS.floodWindowMs);
    s.flow.push({ t: now, bytes });
    if (s.flow.reduce((n, f) => n + f.bytes, 0) > LIVE_LIMITS.floodBytes) {
      this.finish(s, 'The device sent more than the app will pass to a page, so the live connection was closed.', true);
      return;
    }
    // Reply-type detection: the exact `type` of a login reply, after JSON.parse
    // of THAT reply. Only small messages are read (a login reply is tiny; the
    // big first answer to a subscription is not worth parsing).
    let authFailed = false;
    if ((s.readyType || s.authFailedType) && raw.length <= 4096) {
      let type: unknown;
      try { type = (JSON.parse(raw) as { type?: unknown } | null)?.type; } catch { /* not JSON: not a login reply */ }
      if (typeof type === 'string') {
        if (s.authFailedType && type === s.authFailedType) authFailed = true;
        else if (s.readyType && type === s.readyType && !s.sawReady) { s.sawReady = true; this.markStable(s); }
      }
    }
    // Redacted per message BEFORE batching, so a key can never ride a batch.
    s.batch.push(redact(raw, s.secrets));
    if (authFailed) {
      // The wrong key will be wrong again: never retried (a burst of failed logins can get the computer banned).
      this.finish(s, 'The device refused the saved key. Remove this connection on the page and add the key again.', true);
      return;
    }
    s.timers.batch ??= setTimeout(() => { s.timers.batch = undefined; this.flush(s); }, LIVE_LIMITS.batchMs);
  }

  /** Push what has gathered, in order, at most 256 KB per push. One message
   *  larger than that (a whole house's first answer) goes alone: it cannot be cut. */
  private flush(s: Live): void {
    clearTimeout(s.timers.batch); s.timers.batch = undefined;
    const pending = s.batch;
    s.batch = [];
    let chunk: string[] = [];
    let size = 0;
    const send = () => {
      if (!chunk.length) return;
      this.deliver(s, { socket: s.id, kind: 'messages', texts: chunk });
      chunk = []; size = 0;
    };
    for (const text of pending) {
      const b = Buffer.byteLength(text);
      if (chunk.length && size + b > LIVE_LIMITS.pushBytes) send();
      chunk.push(text); size += b;
    }
    send();
  }

  // ── Reporting, and stopping ────────────────────────────────────────────

  private deliver(s: Live, event: PageSocketEvent): void {
    const r = s.owner.push(event);
    // A remote client that is not reading fast enough loses THIS socket, never its connection to the computer.
    if (r === 'backed-up') this.finish(s, 'Your phone is not keeping up with this live connection, so it was closed.', false);
    else if (r === 'gone') this.finish(s, 'The window that held this connection went away.', false);
  }

  private setState(s: Live, state: PageSocketState, why?: string): void {
    if (s.closed) return;
    s.state = state;
    this.deliver(s, { socket: s.id, kind: 'state', state, ...(why ? { why } : {}) });
  }

  /** Stop the wire and its timers, keep the record (a reconnect may follow). */
  private stopWire(s: Live): void {
    clearTimeout(s.timers.open); clearTimeout(s.timers.stable); clearTimeout(s.timers.batch);
    s.timers.open = s.timers.stable = s.timers.batch = undefined;
    const ws = s.ws; s.ws = null;
    try { ws?.terminate(); } catch { /* already gone */ }
  }

  /** End the socket for good. `tell`: push 'closed' with the reason (the owner
   *  did not ask for it); what had gathered is pushed first, in order. */
  private finish(s: Live, why: string, tell: boolean): void {
    if (s.closed) return;
    s.gen++;
    if (tell) this.flush(s);
    s.closed = true;
    this.stopWire(s);
    clearTimeout(s.timers.backoff); clearTimeout(s.timers.lease);
    s.timers.backoff = s.timers.lease = undefined;
    s.abort.abort();
    this.sockets.delete(s.id);
    s.state = 'closed';
    if (tell) s.owner.push({ socket: s.id, kind: 'state', state: 'closed', why });
  }

  /** The lease: one timer per socket, only while it exists (no idle ticking). */
  private armLease(s: Live): void {
    const idle = Date.now() - s.lastPing;
    s.timers.lease = setTimeout(() => {
      s.timers.lease = undefined;
      if (s.closed) return;
      if (Date.now() - s.lastPing >= LIVE_LIMITS.leaseMs) this.finish(s, 'The page stopped checking in, so its live connection was closed.', true);
      else this.armLease(s);
    }, Math.max(0, LIVE_LIMITS.leaseMs - idle));
  }
}
