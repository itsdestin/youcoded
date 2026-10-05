// A page's one-shot socket exchange with its approved home device.
//
// Design: youcoded-dev/docs/active/specs/2026-10-01-device-live-connection.md
//
// WHY: some devices offer their settings only over a socket (Home Assistant
// renames things and moves them between rooms that way, never over plain web
// requests), and the home-page-v2 deck (Q-where) chose renames and room moves
// that happen in the device itself. This is the smallest door that allows it:
//
//   - ONLY a `device` connection that may make changes, and only at the exact
//     host AND port the person allowed — the same `covers` rule as the fetch
//     door, the same home/Tailscale-only address check, and no redirects
//     (a socket upgrade that answers 3xx is refused, never followed);
//   - the key reaches the socket only through the connection's own approved
//     `socketHello`, substituted HERE. A page's own messages are sent exactly
//     as written, so a page can never place its key in a message of its own
//     (and so never store it somewhere it could read back);
//   - every message received is redacted before it leaves main;
//   - one exchange, then the socket is closed: send, collect `until` messages,
//     close. Nothing stays open behind a hidden or closed page (performance
//     rule 2), and each exchange counts once against the page's rate cap.
import WebSocket from 'ws';
import { assertHomeHttpUrl } from '../harness/tools/net-guard';
import { covers, fingerprint, SOCKET_KEY_TOKEN } from './page-connections';
import { redact, type PageCredential, type PageFetchContext } from './page-fetch';
import type { PageConnection, PageFetchRequest, PageFetchResult } from '../../shared/pages-types';

/** Caps. Sized for a settings page: a rename is three messages out, three
 *  back; a room list is one large answer. */
export const MAX_SOCKET_SENDS = 20;
export const MAX_SOCKET_MESSAGE_BYTES = 64_000;
export const MAX_SOCKET_REPLIES = 50;
const MAX_SOCKET_TOTAL_BYTES = 1_000_000;
const DEFAULT_SOCKET_TIMEOUT_MS = 10_000;
const MAX_SOCKET_TIMEOUT_MS = 15_000;

/** The minimum a socket must offer, so a test can hand in its own. */
interface SocketLike {
  on(event: 'open', cb: () => void): unknown;
  on(event: 'message', cb: (data: WebSocket.RawData, isBinary: boolean) => void): unknown;
  on(event: 'close', cb: () => void): unknown;
  on(event: 'error', cb: (e: Error) => void): unknown;
  on(event: 'unexpected-response', cb: (req: unknown, res: { statusCode?: number }) => void): unknown;
  send(data: string): void;
  terminate(): void;
}

export interface PageSocketContext extends PageFetchContext {
  /** Test injection: open the socket. Default: the `ws` client. */
  connect?: (url: string, headers: Record<string, string>) => SocketLike;
}

function defaultConnect(url: string, headers: Record<string, string>): SocketLike {
  return new WebSocket(url, {
    headers: { 'User-Agent': 'YouCoded', ...headers },
    // A redirect would be a second address nobody approved.
    followRedirects: false,
    maxPayload: MAX_SOCKET_TOTAL_BYTES,
    handshakeTimeout: MAX_SOCKET_TIMEOUT_MS,
  });
}

const refuse = (reason: 'not-approved' | 'method-not-allowed' | 'bad-url' | 'network', message: string): PageFetchResult =>
  ({ ok: false, reason, message });

/** Check the request's own shape. Returns the cleaned plan or a refusal. */
function cleanPlan(socket: PageFetchRequest['socket']): { send: string[]; until: number; timeoutMs: number } | string {
  if (!socket || !Array.isArray(socket.send)) return 'That page asked for a socket exchange the app could not read.';
  const send = socket.send;
  if (send.length > MAX_SOCKET_SENDS) return `A page may send at most ${MAX_SOCKET_SENDS} messages at once.`;
  if (send.some((m) => typeof m !== 'string' || Buffer.byteLength(m) > MAX_SOCKET_MESSAGE_BYTES)) {
    return 'That page tried to send a message the app could not send.';
  }
  const until = Math.floor(Number(socket.until));
  if (!Number.isFinite(until) || until < 1 || until > MAX_SOCKET_REPLIES) {
    return `A page may wait for between 1 and ${MAX_SOCKET_REPLIES} answers.`;
  }
  const asked = Number(socket.timeoutMs);
  const timeoutMs = Number.isFinite(asked) && asked > 0 ? Math.min(asked, MAX_SOCKET_TIMEOUT_MS) : DEFAULT_SOCKET_TIMEOUT_MS;
  return { send, until, timeoutMs };
}

/** Message types refused on EVERY device socket whatever the manifest says; a
 *  manifest can only add to this (`socketDeny`). Threat: a page (or a later
 *  edit of it) minting a new login key for itself or changing who may log in.
 *  Home Assistant's `config/entity_registry/*`, `config/device_registry/*` and
 *  `config/area_registry/*` (renames, room moves) must NOT match: that is why
 *  the floor says `config/auth`, not `config/`. */
const SOCKET_DENY_FLOOR = ['auth/', 'config/auth', 'person/'] as const;

/** Check ONE page-written outgoing socket message and return the text that
 *  may be SENT. Main reads the message's `type` itself (a page is never
 *  trusted to say what it is sending): it must be a JSON object with a string
 *  `type`, and that type, trimmed and lower-cased, must not start with any
 *  floor or manifest-denied prefix.
 *
 *  WHY the caller sends `text` from the result and never the page's own string:
 *  JSON.parse keeps only the LAST of two `"type"` keys (even when one is
 *  written with escapes, which no text search can see), while a device may act
 *  on the first. Re-serialising the parsed object means what was checked is
 *  exactly what is sent; a duplicate collapses to the checked value. A nested
 *  `"type"` (a dashboard save) is ordinary and passes. */
export type OutgoingCheck = { ok: true; text: string } | { ok: false; reason: string };
export function checkOutgoingSocketMessage(text: string, extraDeny: readonly string[] = []): OutgoingCheck {
  const unreadable: OutgoingCheck = { ok: false, reason: 'That page tried to send a message the app could not read, so nothing was sent.' };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return unreadable; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return unreadable;
  const type = (parsed as { type?: unknown }).type;
  if (typeof type !== 'string') return unreadable;
  const t = type.trim().toLowerCase();
  const hit = [...SOCKET_DENY_FLOOR, ...extraDeny].find((p) => t.startsWith(p.toLowerCase()));
  return hit
    ? { ok: false, reason: `That page tried to send "${t}", which the app never allows on a home device, so nothing was sent.` }
    : { ok: true, text: JSON.stringify(parsed) };
}

/** Everything a socket to a home device must pass, in one place so the
 *  one-shot exchange here and the live socket and video later cannot drift
 *  apart (spec 2026-10-04, "One shared check function"). Order: the page's
 *  address, a `device` connection that covers host AND port, approved at the
 *  current fingerprint, full access, a saved key when the greeting needs one,
 *  and the home-address check (re-resolved every call). */
export type DeviceSocketAccess =
  | { ok: false; refusal: PageFetchResult }
  | { ok: true; connection: DeviceConnection; httpUrl: URL; credential: PageCredential | null; secrets: string[]; hello: string | undefined };
type DeviceConnection = Extract<PageConnection, { kind: 'device' }>;

export async function checkDeviceSocketAccess(
  url: unknown,
  ctx: Pick<PageFetchContext, 'connections' | 'approved' | 'credential' | 'lookup' | 'signal'>,
  /** When the caller named a connection (a video start does), THAT one is used, not just the first at the address. */
  connectionId?: string,
): Promise<DeviceSocketAccess> {
  const no = (refusal: PageFetchResult): DeviceSocketAccess => ({ ok: false, refusal });
  // The page names its device the way it names it for a fetch — its http(s)
  // address — or as ws(s). Either way the match and the home check run on the
  // http form, so the rule is the SAME one the fetch door applies.
  let httpUrl: URL;
  try { httpUrl = new URL(String(url ?? '')); }
  catch { return no(refuse('bad-url', 'That page asked for an address the app could not read.')); }
  const scheme = httpUrl.protocol;
  if (scheme === 'ws:' || scheme === 'wss:') httpUrl = new URL(httpUrl.toString().replace(/^ws/, 'http'));
  else if (scheme !== 'http:' && scheme !== 'https:') return no(refuse('bad-url', 'A socket exchange needs a ws:// or http:// address.'));

  // WHY the named id: two device lines can share an address (different service/profile); picking the first
  // that covers it handed back the wrong line's hello, key and deny list.
  const connection = ctx.connections.find((c) => (connectionId === undefined || c.id === connectionId) && covers(c, httpUrl));
  if (!connection || connection.kind !== 'device') {
    return no(refuse('not-approved', `This page may not open a socket to ${httpUrl.hostname}. Only an allowed home device can be reached that way.`));
  }
  if (!ctx.approved[connection.id] || ctx.approved[connection.id] !== fingerprint(connection)) {
    return no(refuse('not-approved', `This page has not been allowed to reach ${httpUrl.hostname} yet.`));
  }
  // A socket can change anything the device offers, so a look-up-only
  // approval never opens one.
  if (connection.access !== 'full') {
    return no(refuse('method-not-allowed', `This page may only look things up at ${httpUrl.hostname}; it cannot send changes there.`));
  }

  const credential = await ctx.credential(connection);
  const secrets: string[] = [];
  if (credential) {
    secrets.push(credential.value);
    if (credential.secret && credential.secret !== credential.value) secrets.push(credential.secret);
  }
  const hello = connection.socketHello;
  if (hello?.includes(SOCKET_KEY_TOKEN) && !credential) {
    return no(refuse('not-approved', `There is no saved key for ${connection.service}. Remove this connection and add the key again.`));
  }

  try {
    await assertHomeHttpUrl(httpUrl.toString(), ctx.lookup, ctx.signal);
  } catch (error) {
    return no(refuse('network', redact(error instanceof Error ? error.message : String(error), secrets)));
  }
  return { ok: true, connection, httpUrl, credential, secrets, hello };
}

/** Where and how to open the wire for an approved device: the ws address, the
 *  upgrade headers, and the greeting with the key substituted. Shared by the
 *  one-shot exchange and the live socket so the two cannot drift. */
export function socketTarget(checked: Extract<DeviceSocketAccess, { ok: true }>): { wsUrl: URL; headers: Record<string, string>; helloText: string | undefined } {
  const { httpUrl, credential, hello } = checked;
  // The upgrade request carries the key the same way a fetch would, for a
  // device that signs sockets in by header or address rather than a greeting.
  const wsUrl = new URL(httpUrl.toString().replace(/^http/, 'ws'));
  const headers: Record<string, string> = {};
  if (credential && !hello) {
    if (credential.in === 'header') headers[credential.param] = credential.value;
    else wsUrl.searchParams.set(credential.param, credential.value);
  }
  // The key goes in as JSON string content, so a key with a quote in it can
  // never break the greeting's JSON.
  const helloText = hello && credential
    ? hello.split(SOCKET_KEY_TOKEN).join(JSON.stringify(credential.secret ?? credential.value).slice(1, -1))
    : hello;
  return { wsUrl, headers, helloText };
}

export async function performPageSocket(request: PageFetchRequest, ctx: PageSocketContext): Promise<PageFetchResult> {
  const plan = cleanPlan(request.socket);
  if (typeof plan === 'string') return refuse('bad-url', plan);

  const checked = await checkDeviceSocketAccess(request.url, ctx);
  if (!checked.ok) return checked.refusal;
  const { connection, httpUrl, secrets } = checked;

  // WHY here: a denied message (a new login key, a changed login list) must be
  // refused before anything is sent, so the whole exchange is refused, not
  // half-run. Applies to every page message, never to the app's own greeting.
  // The checked, re-serialised text is what gets sent (see checkOutgoingSocketMessage).
  const toSend: string[] = [];
  for (const m of plan.send) {
    const vetted = checkOutgoingSocketMessage(m, connection.socketDeny);
    if (!vetted.ok) return refuse('method-not-allowed', vetted.reason);
    toSend.push(vetted.text);
  }

  const { wsUrl, headers, helloText } = socketTarget(checked);

  const connect = ctx.connect ?? defaultConnect;
  return new Promise<PageFetchResult>((resolve) => {
    const frames: string[] = [];
    let total = 0;
    let done = false;
    let ws: SocketLike;
    const finish = (result: PageFetchResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
      try { ws?.terminate(); } catch { /* already gone */ }
      resolve(result);
    };
    const answer = () => finish({ ok: true, status: 101, headers: {}, body: JSON.stringify(frames.map((f) => redact(f, secrets))) });
    const timer = setTimeout(() => finish(refuse('network', `${httpUrl.hostname} did not answer within ${Math.round(plan.timeoutMs / 1000)} seconds.`)), plan.timeoutMs);
    const onAbort = () => finish(refuse('network', 'The request was stopped.'));
    ctx.signal.addEventListener('abort', onAbort);

    try { ws = connect(wsUrl.toString(), headers); }
    catch (error) {
      finish(refuse('network', `The app could not reach ${httpUrl.hostname}. ${redact(error instanceof Error ? error.message : String(error), secrets)}`));
      return;
    }
    ws.on('unexpected-response', (_req, res) => {
      // 3xx included: never followed (no second address), and 401/404 say the
      // device does not offer a socket here, or refused the key.
      finish(refuse('network', `${httpUrl.hostname} answered ${res?.statusCode ?? 'without a socket'} instead of opening a socket.`));
    });
    ws.on('error', (e) => {
      finish(refuse('network', `The app could not reach ${httpUrl.hostname}. ${redact(e?.message ?? '', secrets)}`.trim()));
    });
    ws.on('open', () => {
      try {
        if (helloText) ws.send(helloText);
        for (const m of toSend) ws.send(m);
      } catch (e) {
        finish(refuse('network', redact(e instanceof Error ? e.message : String(e), secrets)));
      }
    });
    ws.on('message', (data, isBinary) => {
      // Text only: bytes would carry the key past the text redaction.
      if (isBinary) return;
      const text = data.toString();
      total += Buffer.byteLength(text);
      if (total > MAX_SOCKET_TOTAL_BYTES) {
        finish(refuse('network', `${httpUrl.hostname} answered with more than the app will pass to a page.`));
        return;
      }
      frames.push(text);
      if (frames.length >= plan.until) answer();
    });
    // Closed early (a refused key closes the socket): the page still gets what
    // arrived, so it can show WHY rather than a timeout.
    ws.on('close', answer);
  });
}
