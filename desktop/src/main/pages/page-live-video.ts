// Camera video played by the app (spec 2026-10-04, Part 2) — main's half.
//
// WHY main opens its OWN socket to the device (not the page's): the page is
// untrusted and must never see SDP, network candidates or the key. Main greets
// the device with the approved greeting, waits for the device's "logged in"
// reply, sends the approved `videoProfile.send` template with the host's offer
// and the checked target filled in, and hands the host only the filtered
// answer and candidates. It keeps that socket open for the video's life: Home
// Assistant stops the stream the moment its subscription ends (measured).
//
// Reuses the live socket's machinery rather than duplicating it: the same owner
// (a window or remote client; events go to that owner only), the same access
// check run fresh at start, the same rate gate, redaction, outgoing-message
// check (with the connection's deny list), lease length and `closeFor` /
// `closeOwner` shape. Videos are counted apart from sockets (2 per page, 4 per
// app) and never mark a page "fresh".
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { redact, type PageRateGate } from './page-fetch';
import { checkOutgoingSocketMessage, socketTarget, type DeviceSocketAccess } from './page-socket';
import { defaultConnect, LIVE_LIMITS, type LiveWsLike, type SocketOwner } from './page-live-socket';
import { filterAnswerSdp, filterCandidate } from './page-video-sdp';
import type { PageSocketCallResult, PageVideoCall, PageVideoStartRequest, PageVideoStartResult } from '../../shared/pages-types';

export const VIDEO_LIMITS = {
  perPage: 2, perApp: 4,
  /** The offer a page's host may send (an SDP is about 2-4 KB; Nest's is small). */
  offerBytes: 32 * 1024,
  /** A video ends by itself after this; the card offers Play again. */
  maxMs: 5 * 60_000,
  /** "Logged in" reply wait, and the wait for a usable candidate when the answer had none. */
  readyWaitMs: 10_000, candidateWaitMs: 10_000,
  leaseMs: LIVE_LIMITS.leaseMs,
  /** One reply from the device (an answer SDP is a few KB), and how many replies one video may take. */
  replyBytes: 256 * 1024, maxReplies: 200,
  targetChars: 64,
} as const;

export interface LiveVideoDeps {
  /** The whole check chain for this page and connection id (service). Run fresh at every start. */
  access: (pageId: string, connectionId: string, signal: AbortSignal) => Promise<DeviceSocketAccess>;
  gate: Pick<PageRateGate, 'acquire' | 'release'>;
  /** Test injection: open the socket. Default: the `ws` client. */
  connect?: (url: string, headers: Record<string, string>) => LiveWsLike;
}

interface Video {
  id: string;
  owner: SocketOwner;
  page: string; frame: string; connection: string;
  closed: boolean;
  abort: AbortController;
  ws: LiveWsLike | null;
  secrets: string[];
  lastPing: number;
  /** greeting: waiting for socketReady; negotiating: the template is sent. */
  phase: 'greeting' | 'negotiating';
  usable: number;
  heldAnswer: string | null;
  /** The device's answer has been seen (a second one is ignored). */
  answered: boolean;
  replies: number;
  timers: { lease?: ReturnType<typeof setTimeout>; max?: ReturnType<typeof setTimeout>; ready?: ReturnType<typeof setTimeout>; cand?: ReturnType<typeof setTimeout> };
}

const refusal = (message: string): { ok: false; message: string } => ({ ok: false, message });
const NOT_YOURS = 'That video is not playing any more.';

/** The value at a dotted path (`event.answer`) in a parsed reply. */
function at(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const k of path.split('.')) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur) || !Object.prototype.hasOwnProperty.call(cur, k)) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

export class PageLiveVideos {
  private readonly videos = new Map<string, Video>();
  constructor(private readonly deps: LiveVideoDeps) {}

  get count(): number { return this.videos.size; }

  async start(owner: SocketOwner, req: PageVideoStartRequest): Promise<PageVideoStartResult> {
    if (typeof req?.page !== 'string' || !req.page || typeof req.frame !== 'string' || !req.frame
      || typeof req.connection !== 'string' || !req.connection || req.connection.length > 64
      || typeof req.target !== 'string' || req.target.length > 128 || typeof req.offer !== 'string' || !req.offer) {
      return refusal('That page asked for a video the app could not read.');
    }
    if (Buffer.byteLength(req.offer) > VIDEO_LIMITS.offerBytes) return refusal('That video request was larger than the app allows.');
    // Caps are counted on the records, which exist from this moment, so two quick starts cannot both pass.
    const all = [...this.videos.values()];
    if (all.filter((v) => v.page === req.page).length >= VIDEO_LIMITS.perPage) return refusal(`A page may play at most ${VIDEO_LIMITS.perPage} videos at once.`);
    if (all.length >= VIDEO_LIMITS.perApp) return refusal(`YouCoded may play at most ${VIDEO_LIMITS.perApp} videos at once.`);

    const v: Video = {
      // Unguessable and chosen here: a frame can never name an id of its own.
      id: `lv_${randomBytes(16).toString('hex')}`,
      owner, page: req.page, frame: req.frame, connection: req.connection,
      closed: false, abort: new AbortController(), ws: null, secrets: [], lastPing: Date.now(),
      phase: 'greeting', usable: 0, heldAnswer: null, answered: false, replies: 0, timers: {},
    };
    this.videos.set(v.id, v);
    this.armLease(v);
    v.timers.max = setTimeout(() => this.finish(v, 'The video reached its 5-minute limit. Play again to keep watching.', true), VIDEO_LIMITS.maxMs);

    // One rate-gate slot, released at once (the gate counts starts per minute; a
    // video that lives minutes must not hold the page's in-flight slot).
    if (!(await this.deps.gate.acquire(v.page))) { this.finish(v, '', false); return refusal('This page is starting videos faster than the app allows. It will be able to try again shortly.'); }
    this.deps.gate.release(v.page);
    if (v.closed) return refusal(NOT_YOURS);
    const access = await this.deps.access(v.page, v.connection, v.abort.signal);
    if (v.closed) return refusal(NOT_YOURS);
    if (!access.ok) { const m = access.refusal.ok ? 'Refused.' : access.refusal.message; this.finish(v, '', false); return refusal(m); }
    const profile = access.connection.videoProfile;
    if (!profile) { this.finish(v, '', false); return refusal('This connection does not offer camera video.'); }
    // The target is checked HERE, against the approved prefix: no pattern a page
    // or manifest wrote ever runs in main.
    const rest = req.target.startsWith(profile.targetPrefix) ? req.target.slice(profile.targetPrefix.length) : '';
    if (!profile.targetPrefix.endsWith('.') || !/^[a-z0-9_]+$/.test(rest) || rest.length > VIDEO_LIMITS.targetChars) {
      this.finish(v, '', false);
      return refusal('That page asked to watch something this connection does not allow.');
    }
    v.secrets = access.secrets;
    const { wsUrl, headers, helloText } = socketTarget(access);
    const host = access.httpUrl.hostname;
    const ready = access.connection.socketReady;
    const authFailed = access.connection.socketAuthFailed;

    let ws: LiveWsLike;
    try { ws = (this.deps.connect ?? defaultConnect)(wsUrl.toString(), headers); }
    catch (e) { this.finish(v, '', false); return refusal(`The app could not reach ${host}. ${redact(e instanceof Error ? e.message : String(e), v.secrets)}`.trim()); }
    v.ws = ws;

    /** Fill the approved template in ONE pass and send what the message check returns. */
    const sendTemplate = () => {
      // WHY one pass with a callback: text inserted for {{offer}} is never
      // looked at again, so an offer that itself contains "{{target}}" cannot
      // change the message. Values go in as JSON (templates write them unquoted).
      const filled = profile.send.replace(/\{\{(offer|target)\}\}/g, (_m, k: string) => JSON.stringify(k === 'offer' ? req.offer : req.target));
      // The filled message passes the same check as any page-written one, with
      // this connection's deny list: a manifest cannot make the video template a back door.
      const vetted = checkOutgoingSocketMessage(filled, access.connection.socketDeny);
      if (!vetted.ok) { this.finish(v, 'The app could not start that video.', true); return; }
      try { ws.send(vetted.text); v.phase = 'negotiating'; }
      catch (e) { this.finish(v, redact(e instanceof Error ? e.message : String(e), v.secrets), true); }
    };

    ws.on('open', () => {
      if (v.closed) { try { ws.terminate(); } catch { /* gone */ } return; }
      try { if (helloText) ws.send(helloText); }
      catch (e) { this.finish(v, redact(e instanceof Error ? e.message : String(e), v.secrets), true); return; }
      if (ready) {
        v.timers.ready = setTimeout(() => this.finish(v, `${host} did not log in within ${VIDEO_LIMITS.readyWaitMs / 1000} seconds.`, true), VIDEO_LIMITS.readyWaitMs);
      } else sendTemplate();
    });
    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (v.closed) return;
      if (isBinary) return; // text only: bytes would carry the key past the text redaction
      const raw = data.toString();
      if (Buffer.byteLength(raw) > VIDEO_LIMITS.replyBytes || ++v.replies > VIDEO_LIMITS.maxReplies) { this.finish(v, 'The device sent more than the app will pass on, so the video stopped.', true); return; }
      // Redacted FIRST: everything below (the answer, a candidate, a failure
      // text) is read from redacted text, so a key can never ride any of them.
      let msg: unknown;
      try { msg = JSON.parse(redact(raw, v.secrets)); } catch { return; }
      const type = (msg as { type?: unknown } | null)?.type;
      if (typeof type !== 'string') return;
      if (authFailed && type === authFailed) { this.finish(v, 'The device refused the saved key. Remove this connection on the page and add the key again.', true); return; }
      if (v.phase === 'greeting') {
        if (ready && type === ready) { clearTimeout(v.timers.ready); v.timers.ready = undefined; sendTemplate(); }
        return;
      }
      this.negotiate(v, msg, type, profile);
    });
    ws.on('unexpected-response', (_r, res) => { if (!v.closed) this.finish(v, `${host} answered ${res?.statusCode ?? 'without a socket'} instead of opening a socket.`, true); });
    ws.on('error', (e) => { if (!v.closed) this.finish(v, `Lost the connection to ${host}. ${redact(e?.message ?? '', v.secrets)}`.trim(), true); });
    ws.on('close', () => { if (!v.closed) this.finish(v, `Lost the connection to ${host}.`, true); });
    return { ok: true, video: v.id };
  }

  /** One reply after the template was sent: the answer, a candidate, a failure — anything else is ignored. */
  private negotiate(v: Video, msg: unknown, type: string, profile: NonNullable<Extract<DeviceSocketAccess, { ok: true }>['connection']['videoProfile']>): void {
    const failed = at(msg, profile.failed);
    if (typeof failed === 'string' && failed) { this.finish(v, failed.slice(0, 300), true); return; }
    // A plain "no" to the request itself (the device's result message).
    if (type === 'result' && (msg as { success?: unknown }).success === false) { this.finish(v, 'The device did not start the video.', true); return; }
    const answer = at(msg, profile.answer);
    if (typeof answer === 'string' && answer && !v.answered) {
      const f = filterAnswerSdp(answer);
      v.answered = true;
      v.usable += f.usable;
      if (v.usable > 0) this.emitAnswer(v, f.sdp);
      else {
        // No address the app may use in the answer: wait for trickled ones, then refuse.
        v.heldAnswer = f.sdp;
        v.timers.cand = setTimeout(() => this.finish(v, 'The camera offered no address the app could use, so the video was not started.', true), VIDEO_LIMITS.candidateWaitMs);
      }
      return;
    }
    const cand = at(msg, profile.candidate);
    if (cand !== undefined) {
      const json = filterCandidate(cand);
      if (json === null) return;
      v.usable++;
      if (v.heldAnswer !== null) { clearTimeout(v.timers.cand); v.timers.cand = undefined; const held = v.heldAnswer; v.heldAnswer = null; this.emitAnswer(v, held); }
      this.push(v, { socket: v.id, kind: 'video-candidate', candidate: json });
    }
  }

  private emitAnswer(v: Video, sdp: string): void { this.push(v, { socket: v.id, kind: 'video-answer', answer: sdp }); }

  private push(v: Video, event: Parameters<SocketOwner['push']>[0]): void {
    if (v.closed) return;
    const r = v.owner.push(event);
    // A remote client that is not reading loses THIS video, never its connection.
    // WHY told: a silent stop left the card showing a frozen picture; the one small 'stopped' frame goes through a backlog.
    if (r === 'backed-up') this.finish(v, 'Your phone is not keeping up with this video, so it was stopped.', true);
    else if (r === 'gone') this.finish(v, '', false);
  }

  stop(ownerKey: string, req: PageVideoCall): PageSocketCallResult {
    const v = this.owned(ownerKey, req);
    if (!v) return refusal(NOT_YOURS);
    this.finish(v, '', false);
    return { ok: true };
  }

  ping(ownerKey: string, req: PageVideoCall): PageSocketCallResult {
    const v = this.owned(ownerKey, req);
    if (!v) return refusal(NOT_YOURS);
    v.lastPing = Date.now();
    return { ok: true };
  }

  /** The approval, key, code or manifest changed: every video of the page (or of one connection) stops. */
  closeFor(pageId: string, connectionId?: string, why = 'This page\'s connection was changed, so its video stopped.'): void {
    for (const v of [...this.videos.values()]) {
      if (v.page !== pageId) continue;
      if (connectionId !== undefined && v.connection !== connectionId) continue;
      this.finish(v, why, true);
    }
  }

  closeOwner(ownerKey: string): void {
    for (const v of [...this.videos.values()]) if (v.owner.key === ownerKey) this.finish(v, '', false);
  }

  closeAll(): void { for (const v of [...this.videos.values()]) this.finish(v, '', false); }

  private owned(ownerKey: string, req: PageVideoCall): Video | null {
    const v = typeof req?.video === 'string' ? this.videos.get(req.video) : undefined;
    // One answer for "no such video" and "not yours": never confirm an id.
    return v && !v.closed && v.owner.key === ownerKey && v.page === req.page && v.frame === req.frame ? v : null;
  }

  /** End the video for good. `tell`: push 'video-stopped' with the reason (the owner did not ask for it). */
  private finish(v: Video, why: string, tell: boolean): void {
    if (v.closed) return;
    v.closed = true;
    for (const k of Object.keys(v.timers) as Array<keyof Video['timers']>) { clearTimeout(v.timers[k]); v.timers[k] = undefined; }
    const ws = v.ws; v.ws = null;
    try { ws?.terminate(); } catch { /* already gone */ }
    v.abort.abort();
    this.videos.delete(v.id);
    if (tell) v.owner.push({ socket: v.id, kind: 'video-stopped', why });
  }

  /** One timer per video: it checks the last ping, and re-arms for the remainder. */
  private armLease(v: Video): void {
    const idle = Date.now() - v.lastPing;
    v.timers.lease = setTimeout(() => {
      v.timers.lease = undefined;
      if (v.closed) return;
      if (Date.now() - v.lastPing >= VIDEO_LIMITS.leaseMs) this.finish(v, 'The page stopped checking in, so its video was stopped.', true);
      else this.armLease(v);
    }, Math.max(0, VIDEO_LIMITS.leaseMs - idle));
  }
}
