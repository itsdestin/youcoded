// The one door out of a page: `pages:fetch`, checked in main.
//
// Design: youcoded-dev/docs/active/specs/2026-09-20-youcoded-pages-phase2-technical-design.md §4
//
// The page's own document cannot reach the network at all (its CSP takes
// `connect-src` away). Everything it wants goes through here, where the
// approvals on disk decide — so a renderer bug or a compromised frame cannot
// widen the grant, and the credential never enters the renderer at all.
//
// THE PROMISE THIS KEEPS: a page reaches exactly what its approval lists, and
// nothing else. Five things make that true rather than merely stated:
//   1. the host must match a connection EXACTLY, never by suffix;
//   2. a look-up connection may only send GET and HEAD;
//   3. the caller's headers are replaced by a three-name allowlist, so a page
//      cannot overwrite the credential or smuggle a cookie;
//   4. every redirect hop is re-checked, and the credential is dropped the
//      moment the host changes (design review 1, finding 4);
//   5. the credential string is redacted from the body, the headers and every
//      error message before the answer leaves main (finding 7) — services echo
//      keys back in error text, and a page could otherwise harvest its own key
//      and save it into its synced data.json.
import {
  guardedFetch, readBodyCapped, readBytesCapped, NetGuardError,
  type GuardedFetchOpts, type HostDecision,
} from '../harness/tools/net-guard';
import { covers, fingerprint, methodAllowed } from './page-connections';
import type { PageConnection, PageFetchRequest, PageFetchResult } from '../../shared/pages-types';

/** Caps (design §4). The per-minute cap REFUSES, so a runaway page cannot
 *  spend a paid key while nobody is watching. The in-flight cap QUEUES: a
 *  dashboard legitimately asks for a dozen things at once, and refusing all but
 *  four of them broke the first real one (Destin's analytics page, 2026-09-23 —
 *  "This page is asking for information faster than the app will allow").
 *  The per-minute cap was 60; one refresh of that dashboard is 11 requests, so
 *  60 allowed five filter changes a minute. 120 still stops a runaway loop. */
const MAX_BODY_BYTES = 1_000_000;
/** A camera snapshot (home-device deck, Q-scope). Larger than a text answer
 *  because a 1080p JPEG is routinely 300–900 KB; still bounded, because the
 *  answer crosses IPC as a base64 string a third bigger again. */
const MAX_PICTURE_BYTES = 3_000_000;
/** A recorded camera clip (spec 2026-10-04, Part 3). Nest clips are a few
 *  seconds long; 4 MB leaves room while the base64 answer (a third bigger) stays
 *  a sane thing to push across IPC. */
const MAX_VIDEO_BYTES = 4_000_000;
const REQUEST_TIMEOUT_MS = 30_000;
/** Pages with a clip download in flight. WHY one at a time: a clip is up to
 *  4 MB and a page that asks for twelve at once would hold twelve of them in
 *  memory; the card only ever plays one. Module-level because the cap is per
 *  page, and performPageFetch is otherwise stateless. */
const videoFetching = new Set<string>();
export const MAX_CONCURRENT_PER_PAGE = 4;
export const MAX_PER_PAGE_PER_MINUTE = 120;
/** How many requests may wait for a slot before the rest are refused. */
export const MAX_WAITING_PER_PAGE = 50;

/** What the page sees instead of a credential. Short and obviously not a key,
 *  so a page author reading their own error text knows what happened. */
export const REDACTED = '[key hidden]';

/** Response headers a page may see. `Set-Cookie` is absent on purpose: a page
 *  is an opaque origin with no cookie jar, and handing it one would be handing
 *  it a session it could save into its own data file. */
const RESPONSE_HEADER_ALLOWLIST = ['content-type', 'content-length', 'date', 'etag', 'last-modified', 'cache-control', 'retry-after'];

/** Request headers a page may set. Lower-cased, because they REPLACE the
 *  guard's own defaults rather than combining with them (finding 18): two
 *  spellings of `accept` in one object arrive at the service as one joined
 *  header, which is not what the page asked for. */
const REQUEST_HEADER_ALLOWLIST = ['accept', 'accept-language', 'content-type'];

/** How a credential is attached, resolved by the caller from the approval. */
export type PageCredential =
  | { in: 'header'; param: string; value: string; secret?: string }
  | { in: 'query'; param: string; value: string; secret?: string };

export interface PageFetchContext {
  /** Every connection the page's manifest lists, already parsed. */
  connections: PageConnection[];
  /** Connection id → the fingerprint recorded when it was approved. */
  approved: Record<string, string>;
  /** The credential for one connection, or null when it carries none
   *  (`public`) or its key has gone missing. Resolved lazily so an unapproved
   *  or blocked request never decrypts anything. */
  credential: (c: PageConnection) => Promise<PageCredential | null>;
  signal: AbortSignal;
  /** Which page is asking; only the one-clip-at-a-time rule needs it. */
  pageId?: string;
  /** Test injection; both are handed straight to guardedFetch. */
  fetchImpl?: GuardedFetchOpts['fetchImpl'];
  lookup?: GuardedFetchOpts['lookup'];
}

/**
 * Per-page concurrency and rate state. In memory on purpose: a cap that
 * survived a restart would punish the person for closing the app, and a cap
 * written to disk 60x a minute is the hot write path §3 keeps approvals out of.
 */
export class PageRateGate {
  private readonly state = new Map<string, { recent: number[]; inFlight: number; waiting: Array<() => void> }>();

  /** Resolves true when the request may go (possibly after waiting for one of
   *  the page's in-flight requests to finish), false when it is refused. A
   *  request is counted against the minute WHEN IT IS ASKED, so a queue can
   *  never let a page exceed the minute cap later. Call release() when it
   *  settles — every true answer owes exactly one release. */
  async acquire(pageId: string, now = Date.now()): Promise<boolean> {
    const s = this.state.get(pageId) ?? { recent: [], inFlight: 0, waiting: [] };
    this.state.set(pageId, s);
    s.recent = s.recent.filter((t) => now - t < 60_000);
    if (s.recent.length >= MAX_PER_PAGE_PER_MINUTE || s.waiting.length >= MAX_WAITING_PER_PAGE) return false;
    s.recent.push(now);
    if (s.inFlight < MAX_CONCURRENT_PER_PAGE) { s.inFlight += 1; return true; }
    // Wait for a slot. release() hands its slot straight to the next waiter,
    // so inFlight never dips and a newcomer cannot jump the queue.
    await new Promise<void>((resolve) => s.waiting.push(resolve));
    return true;
  }

  release(pageId: string): void {
    const s = this.state.get(pageId);
    if (!s) return;
    const next = s.waiting.shift();
    if (next) next();
    else s.inFlight = Math.max(0, s.inFlight - 1);
  }
}

/** Remove every credential string from anything on its way out of main. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    // Short strings are not credentials worth hunting for, and blanking a
    // two-character value would mangle ordinary text.
    if (!secret || secret.length < 4) continue;
    for (const form of new Set([secret, encodeURIComponent(secret)])) {
      out = out.split(form).join(REDACTED);
    }
  }
  return out;
}

/**
 * Steps 1–6 of §4. The caller has already resolved the page and its approvals;
 * this decides, requests and answers. Freshness (step 7) is the caller's, so
 * this function stays free of clocks and state.
 */
export async function performPageFetch(request: PageFetchRequest, ctx: PageFetchContext): Promise<PageFetchResult> {
  // Step 4's first half, done first: the URL must be absolute and http(s).
  // `//evil.example` is refused here, never resolved against anything.
  let url: URL;
  try { url = new URL(String(request.url ?? '')); }
  catch { return { ok: false, reason: 'bad-url', message: 'That page asked for a web address the app could not read. It must be a full https:// address.' }; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: 'bad-url', message: `That page asked for a ${url.protocol.replace(':', '')} address. Pages may only reach https:// and http:// addresses.` };
  }

  // Step 2: the connection whose address EQUALS this hostname. `covers` is an
  // exact, case-folded match — never a suffix, or
  // `api.example.com.attacker.test` would pass for `api.example.com`.
  // A device matches on host AND port, so the whole URL goes in.
  const connection = ctx.connections.find((c) => covers(c, url));
  if (!connection) {
    return { ok: false, reason: 'not-approved', message: `This page is not allowed to reach ${url.hostname}.` };
  }
  const recorded = ctx.approved[connection.id];
  if (!recorded || recorded !== fingerprint(connection)) {
    return { ok: false, reason: 'not-approved', message: `This page has not been allowed to reach ${url.hostname} yet.` };
  }

  // Clips (spec Part 3): a device connection only, and one download at a time
  // per page. Checked before any request goes out.
  let videoSlot: string | null = null;
  if (request.as === 'video') {
    if (connection.kind !== 'device') {
      return { ok: false, reason: 'method-not-allowed', message: 'This page may only play video clips from a home device it has been allowed to reach.' };
    }
    videoSlot = ctx.pageId ?? '';
    if (videoFetching.has(videoSlot)) {
      return { ok: false, reason: 'too-many-requests', message: 'This page is already loading a clip. It can ask for the next one when that one finishes.' };
    }
    videoFetching.add(videoSlot);
  }
  try {
    return await performApprovedFetch(request, ctx, url, connection);
  } finally {
    if (videoSlot !== null) videoFetching.delete(videoSlot);
  }
}

async function performApprovedFetch(request: PageFetchRequest, ctx: PageFetchContext, url: URL, connection: PageConnection): Promise<PageFetchResult> {
  // Step 3.
  const method = (typeof request.method === 'string' && request.method.trim() ? request.method.trim() : 'GET').toUpperCase();
  if (!methodAllowed(connection, method, url.pathname)) {
    const places = connection.kind === 'youcoded' && connection.writePaths?.length ? connection.writePaths.join(', ') : '';
    return { ok: false, reason: 'method-not-allowed', message: places
      ? `This page may only make changes at ${places} on ${url.hostname}.`
      : `This page may only look things up at ${url.hostname}; it cannot send changes there.` };
  }

  // Step 4: strip the caller's headers to the allowlist, then attach the
  // credential ourselves. Building a fresh object (rather than deleting from
  // theirs) is what makes "the page cannot set Authorization" true.
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    const lower = String(name).toLowerCase();
    if (!REQUEST_HEADER_ALLOWLIST.includes(lower) || typeof value !== 'string') continue;
    headers[lower] = value;
  }

  const credential = await ctx.credential(connection);
  const credentialHeaders: Record<string, string> = {};
  const credentialQueryParams: string[] = [];
  const secrets: string[] = [];
  if (credential) {
    secrets.push(credential.value);
    // The bare key too, when the value wraps it ("Bearer <key>"): a service
    // that echoes the key without the word must not hand it back to the page.
    if (credential.secret && credential.secret !== credential.value) secrets.push(credential.secret);
    if (credential.in === 'header') credentialHeaders[credential.param] = credential.value;
    else { url.searchParams.set(credential.param, credential.value); credentialQueryParams.push(credential.param); }
  }

  // Step 5. Every hop is re-checked against the SAME connection, so a 302 to a
  // host the approval does not name is refused outright rather than followed.
  let refusedHost: string | null = null;
  const allowHost = (hostname: string, _hop: number, hopUrl: URL): HostDecision => {
    if (covers(connection, connection.kind === 'device' ? hopUrl : hostname)) return { ok: true };
    refusedHost = hostname;
    return { ok: false, message: `That page was sent on to ${hostname}, which it is not allowed to reach.` };
  };

  try {
    const { res } = await guardedFetch(url.toString(), {
      signal: ctx.signal,
      timeoutMs: REQUEST_TIMEOUT_MS,
      method,
      body: typeof request.body === 'string' ? request.body : undefined,
      headers,
      credentialHeaders,
      credentialQueryParams,
      allowHost,
      // A device connection is the ONE place a page reaches inside the home,
      // and then only inside it (S-only-home): every hop must be a home or
      // Tailscale address. Every other kind keeps the public-only guard.
      reach: connection.kind === 'device' ? 'home' : 'public',
      fetchImpl: ctx.fetchImpl,
      lookup: ctx.lookup,
    });

    // Step 6.
    const out: Record<string, string> = {};
    for (const name of RESPONSE_HEADER_ALLOWLIST) {
      const value = res.headers.get(name);
      if (value !== null) out[name] = redact(value, secrets);
    }
    if (request.as === 'picture') {
      // Only an image type becomes a picture. Anything else is refused rather
      // than encoded: base64 would carry it past the text redaction below, so
      // "picture" must never be a way to read a page's own key back.
      const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (res.status >= 200 && res.status < 300 && !/^image\/(jpeg|png|gif|webp)$/.test(type)) {
        await res.body?.cancel().catch(() => { /* already closed */ });
        return { ok: false, reason: 'network', message: `${url.hostname} did not answer with a picture.` };
      }
      const { bytes, truncated } = await readBytesCapped(res, MAX_PICTURE_BYTES);
      if (truncated) return { ok: false, reason: 'network', message: `That picture from ${url.hostname} is too large to show.` };
      // WHY the bytes too (as:'video' does the same with 'ftyp'): the header is the device's own word. A
      // reflecting endpoint could label request data image/png and, as base64, carry the key past the text redaction.
      if (res.status >= 200 && res.status < 300 && !looksLikePicture(type, bytes)) {
        return { ok: false, reason: 'network', message: `${url.hostname} did not answer with a picture.` };
      }
      const body = res.status >= 200 && res.status < 300 ? `data:${type};base64,${bytes.toString('base64')}` : redact(bytes.toString('utf8'), secrets);
      return { ok: true, status: res.status, headers: out, body };
    }
    if (request.as === 'video') {
      // A recorded clip, only from a device (spec Part 3). Refused unless it is
      // an mp4 that really starts like one: base64 would carry any other bytes
      // past the text redaction, so "video" must never become a way to read the
      // page's own key back, any more than "picture" may.
      const ok2xx = res.status >= 200 && res.status < 300;
      if (ok2xx) {
        const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
        if (type !== 'video/mp4') {
          await res.body?.cancel().catch(() => { /* already closed */ });
          return { ok: false, reason: 'network', message: `${url.hostname} did not answer with a video clip.` };
        }
        // WHY the header first: refuse a huge clip before reading a byte of it.
        const declared = Number(res.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > MAX_VIDEO_BYTES) {
          await res.body?.cancel().catch(() => { /* already closed */ });
          return { ok: false, reason: 'network', message: `That clip from ${url.hostname} is too large to play.` };
        }
      }
      const { bytes, truncated } = await readBytesCapped(res, MAX_VIDEO_BYTES);
      if (truncated) return { ok: false, reason: 'network', message: `That clip from ${url.hostname} is too large to play.` };
      if (!ok2xx) return { ok: true, status: res.status, headers: out, body: redact(bytes.toString('utf8'), secrets) };
      // An mp4 begins with a box: 4 bytes of size, then its name, 'ftyp' first.
      if (bytes.length < 12 || bytes.toString('latin1', 4, 8) !== 'ftyp') {
        return { ok: false, reason: 'network', message: `${url.hostname} did not answer with a video clip.` };
      }
      return { ok: true, status: res.status, headers: out, body: `data:video/mp4;base64,${bytes.toString('base64')}` };
    }
    const { text } = await readBodyCapped(res, MAX_BODY_BYTES);
    return { ok: true, status: res.status, headers: out, body: redact(text, secrets) };
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const message = redact(raw, secrets);
    if (refusedHost !== null) return { ok: false, reason: 'not-approved', message };
    if (error instanceof NetGuardError) return { ok: false, reason: 'network', message };
    // An abort is the 30s cap or a closing window, not a mystery: say which.
    if ((error as { name?: string })?.name === 'AbortError' || (error as { name?: string })?.name === 'TimeoutError') {
      return { ok: false, reason: 'network', message: `${url.hostname} did not answer within 30 seconds.` };
    }
    return { ok: false, reason: 'network', message: `The app could not reach ${url.hostname}. ${message}` };
  }
}

/** Do the first bytes match the image type the header claimed? (jpeg ff d8 ff, png 89 'PNG', gif 'GIF8', webp 'RIFF'....'WEBP'.) */
function looksLikePicture(type: string, b: Buffer): boolean {
  switch (type) {
    case 'image/jpeg': return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case 'image/png': return b.length >= 8 && b.toString('latin1', 0, 8) === '\x89PNG\r\n\x1a\n';
    case 'image/gif': return b.length >= 4 && b.toString('latin1', 0, 4) === 'GIF8';
    case 'image/webp': return b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP';
    default: return false;
  }
}
