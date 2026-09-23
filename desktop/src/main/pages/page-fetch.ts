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
  guardedFetch, readBodyCapped, NetGuardError,
  type GuardedFetchOpts, type HostDecision,
} from '../harness/tools/net-guard';
import { covers, fingerprint, methodAllowed } from './page-connections';
import type { PageConnection, PageFetchRequest, PageFetchResult } from '../../shared/pages-types';

/** Caps (design §4). Over any of them the answer is a refusal, never a queue,
 *  so a runaway page cannot spend a paid key while nobody is watching. */
const MAX_BODY_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 30_000;
export const MAX_CONCURRENT_PER_PAGE = 4;
export const MAX_PER_PAGE_PER_MINUTE = 60;

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
  private readonly state = new Map<string, { recent: number[]; inFlight: number }>();

  /** True when this request may go. Call release() when it settles. */
  take(pageId: string, now = Date.now()): boolean {
    const s = this.state.get(pageId) ?? { recent: [], inFlight: 0 };
    s.recent = s.recent.filter((t) => now - t < 60_000);
    if (s.inFlight >= MAX_CONCURRENT_PER_PAGE || s.recent.length >= MAX_PER_PAGE_PER_MINUTE) {
      this.state.set(pageId, s);
      return false;
    }
    s.recent.push(now);
    s.inFlight += 1;
    this.state.set(pageId, s);
    return true;
  }

  release(pageId: string): void {
    const s = this.state.get(pageId);
    if (s) s.inFlight = Math.max(0, s.inFlight - 1);
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
  const connection = ctx.connections.find((c) => covers(c, url.hostname));
  if (!connection) {
    return { ok: false, reason: 'not-approved', message: `This page is not allowed to reach ${url.hostname}.` };
  }
  const recorded = ctx.approved[connection.id];
  if (!recorded || recorded !== fingerprint(connection)) {
    return { ok: false, reason: 'not-approved', message: `This page has not been allowed to reach ${url.hostname} yet.` };
  }

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
  const allowHost = (hostname: string): HostDecision => {
    if (covers(connection, hostname)) return { ok: true };
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
      fetchImpl: ctx.fetchImpl,
      lookup: ctx.lookup,
    });

    // Step 6.
    const { text } = await readBodyCapped(res, MAX_BODY_BYTES);
    const out: Record<string, string> = {};
    for (const name of RESPONSE_HEADER_ALLOWLIST) {
      const value = res.headers.get(name);
      if (value !== null) out[name] = redact(value, secrets);
    }
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
