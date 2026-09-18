// Sign in with OpenRouter (connection-trust design §3.5, docs/active/specs/
// 2026-08-31-openrouter-connection-trust-design.md).
//
// OpenRouter's PKCE sign-in: open openrouter.ai/auth in the user's browser
// with a callback on THIS computer, wait for OpenRouter to send the browser
// back with a one-time code, trade the code for an API key, check the key, and
// save it. The user copies nothing. What comes back is an ordinary API key, so
// everything after the exchange is the paste-a-key path (§3.1–3.2).
//
// WHY a separate, smaller machine than ChatGptAuth rather than a shared
// extraction (the design's first plan): ChatGPT's round needs a FIXED port
// OpenAI registered, a `state` check and token refresh; OpenRouter needs none of
// those (any port, no state parameter exists, a key never expires on its own).
// Reusing only the PKCE maths keeps the shipped ChatGPT sign-in untouched.
//
// Free of Electron: the caller passes openExternal, fetch and the key handler.
import http from 'node:http';
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { generatePkce, type RandomBytesFn } from './chatgpt-oauth';
import type { OpenRouterSignInStatus } from '../../shared/provider-types';

const OPENROUTER_AUTH_URL = 'https://openrouter.ai/auth';
const OPENROUTER_EXCHANGE_URL = 'https://openrouter.ai/api/v1/auth/keys';
/** What the new key is called on OpenRouter's Keys page. Without it a
 *  localhost app's key is named after its random port. */
const OPENROUTER_KEY_LABEL = 'YouCoded';
/** Under OpenRouter's 10-minute code life, and the same window ChatGPT's
 *  first-run sign-in uses. */
const OPENROUTER_SIGN_IN_TIMEOUT_MS = 5 * 60_000;
const EXCHANGE_TIMEOUT_MS = 30_000;

export type SignInOutcome = 'signed-in' | 'cancelled' | 'timed-out' | { error: string };

/** The slice of an HTTP request/response the callback handler touches, so a
 *  test can drive it without a socket. */
export interface CallbackRequest { url?: string }
export interface CallbackResponse {
  writeHead(status: number, headers: Record<string, string>): unknown;
  end(body?: string): unknown;
}
export type CallbackHandler = (req: CallbackRequest, res: CallbackResponse) => void;
interface ListenerLike { port: number; close(): void }
/** Binds 127.0.0.1 on a port the system picks. Injected for tests. */
export type ListenFn = (handler: CallbackHandler) => Promise<ListenerLike>;

export interface OpenRouterSignInDeps {
  openExternal: (url: string) => Promise<void>;
  /** Check the new key and save it. Answers what the check found; a
   *  'rejected' key must NOT have been saved. */
  acceptKey: (key: string) => Promise<{ verdict?: 'verified' | 'rejected' | 'unchecked'; message: string }>;
  fetch?: typeof fetch;
  listen?: ListenFn;
  randomBytes?: RandomBytesFn;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (t: unknown) => void;
}

const defaultListen: ListenFn = (handler) => new Promise((resolve, reject) => {
  const server = http.createServer((req, res) => handler(req, res));
  server.once('error', reject);
  // Port 0: the system picks a free one, so a busy port can never block the
  // sign-in (OpenRouter accepts a localhost callback on any port).
  server.listen(0, '127.0.0.1', () => {
    server.off('error', reject);
    server.on('error', () => { /* a post-bind error must not take down main */ });
    const addr = server.address();
    resolve({
      port: typeof addr === 'object' && addr ? addr.port : 0,
      // Stop accepting now; drop lingering sockets a moment later, so the
      // "you can close this tab" page finishes reaching the browser first.
      close: () => { server.close(); setTimeout(() => server.closeAllConnections?.(), 1000).unref?.(); },
    });
  });
});

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

/** The page the browser shows after coming back. Every response closes its
 *  connection so a keep-alive socket can't hold the listener open. */
function reply(res: CallbackResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', connection: 'close' });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>YouCoded</title>`
    + `<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;color:#222;background:#fafafa}p{font-size:18px;max-width:32em;text-align:center;padding:0 1em}</style>`
    + `</head><body><p>${escapeHtml(text)}</p></body></html>`);
}

interface Round {
  verifier: string;
  path: string;
  listener: ListenerLike;
  timer: unknown;
  handled: boolean;
  waiters: Array<(o: SignInOutcome) => void>;
}

export class OpenRouterSignIn {
  private status_: OpenRouterSignInStatus = { state: 'idle' };
  private round: Round | null = null;
  private lastOutcome: SignInOutcome | null = null;
  /** A round being set up: a double-click during the bind joins it. */
  private starting: Promise<boolean> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly listen: ListenFn;
  private readonly randomBytes: RandomBytesFn;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;

  constructor(private deps: OpenRouterSignInDeps) {
    this.fetchImpl = deps.fetch ?? fetch;
    this.listen = deps.listen ?? defaultListen;
    this.randomBytes = deps.randomBytes ?? ((n) => nodeRandomBytes(n));
    this.setTimer = deps.setTimeout ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
    this.clearTimer = deps.clearTimeout ?? ((t) => clearTimeout(t as NodeJS.Timeout));
  }

  /** What the Settings card polls. Never includes the key. */
  status(): OpenRouterSignInStatus {
    return { ...this.status_ };
  }

  /** Start a sign-in: open the browser and wait for it to come back. Resolves
   *  true once the browser is open. A second click while one is open joins it.
   *  Throws a plain sentence when the round can't start. */
  async signIn(opts: { timeoutMs?: number } = {}): Promise<boolean> {
    if (this.round) return true;
    if (this.starting) return this.starting;
    this.starting = this.start(opts).finally(() => { this.starting = null; });
    return this.starting;
  }

  private async start(opts: { timeoutMs?: number }): Promise<boolean> {
    const { verifier, challenge } = generatePkce(this.randomBytes);
    // A random path stands in for the `state` parameter OpenRouter doesn't
    // have: a stray request from another local page hits a 404 and cannot end
    // the round. (PKCE already makes a stolen code useless.)
    const path = `/or-callback/${Buffer.from(this.randomBytes(16)).toString('hex')}`;
    let listener: ListenerLike;
    try {
      listener = await this.listen((req, res) => { void this.onCallback(req, res); });
    } catch (e) {
      throw new Error(`YouCoded couldn't start listening for the sign-in on this computer (${e instanceof Error ? e.message : String(e)}). Try again, or use an API key instead.`);
    }
    const round: Round = { verifier, path, listener, timer: null, handled: false, waiters: [] };
    this.round = round;
    this.lastOutcome = null;
    this.status_ = { state: 'waiting' };
    round.timer = this.setTimer(() => this.finish(round, 'timed-out'), opts.timeoutMs ?? OPENROUTER_SIGN_IN_TIMEOUT_MS);

    const url = new URL(OPENROUTER_AUTH_URL);
    url.searchParams.set('callback_url', `http://127.0.0.1:${listener.port}${path}`);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('key_label', OPENROUTER_KEY_LABEL);
    try {
      await this.deps.openExternal(url.toString());
    } catch (e) {
      this.finish(round, { error: "YouCoded couldn't open your browser for the sign-in. Try again, or use an API key instead." });
      throw new Error("YouCoded couldn't open your browser for the sign-in. Try again, or use an API key instead.");
    }
    return true;
  }

  /** Stop waiting. The card goes straight back to its button. */
  async cancelSignIn(): Promise<boolean> {
    if (!this.round) return false;
    this.finish(this.round, 'cancelled');
    return true;
  }

  /** How the current (or just-finished) round ended — for first-run, which
   *  waits on it rather than polling. */
  waitForSignIn(): Promise<SignInOutcome> {
    if (!this.round) return Promise.resolve(this.lastOutcome ?? 'cancelled');
    const round = this.round;
    return new Promise((resolve) => round.waiters.push(resolve));
  }

  dispose(): void {
    if (this.round) this.finish(this.round, 'cancelled');
  }

  private async onCallback(req: CallbackRequest, res: CallbackResponse): Promise<void> {
    const round = this.round;
    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://127.0.0.1'); } catch { reply(res, 400, 'Not a sign-in address.'); return; }
    if (!round || url.pathname !== round.path) { reply(res, 404, 'Not a sign-in address.'); return; }
    if (round.handled) { reply(res, 409, 'This sign-in was already used. You can close this tab.'); return; }
    round.handled = true;
    const code = url.searchParams.get('code');
    if (!code) {
      reply(res, 400, "OpenRouter didn't send the sign-in back. Return to YouCoded and try again.");
      this.finish(round, { error: "OpenRouter didn't send the sign-in back. Try again." });
      return;
    }
    const outcome = await this.exchange(round, code);
    if (outcome === 'signed-in') {
      reply(res, 200, "You're signed in to OpenRouter. You can close this tab and go back to YouCoded.");
    } else {
      reply(res, 200, `${typeof outcome === 'object' ? outcome.error : 'The sign-in did not finish.'} You can close this tab.`);
    }
    this.finish(round, outcome);
  }

  private async exchange(round: Round, code: string): Promise<SignInOutcome> {
    let res: Response;
    try {
      res = await this.fetchImpl(OPENROUTER_EXCHANGE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, code_verifier: round.verifier, code_challenge_method: 'S256' }),
        signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
      });
    } catch {
      return { error: "Couldn't reach OpenRouter to finish signing in. Check your connection and try again." };
    }
    if (!res.ok) {
      let said = '';
      try { said = String((await res.json())?.error?.message ?? ''); } catch { /* no body */ }
      if (/expired/i.test(said)) return { error: 'The sign-in took too long to finish. Try again.' };
      // Live OpenRouter (2026-09-18) answers a bad code with 400 "Invalid
      // code"; its docs say 403. Match either.
      if (res.status === 403 || /invalid code|code_verifier/i.test(said)) return { error: "OpenRouter didn't accept the sign-in. Try again." };
      return { error: `OpenRouter couldn't finish the sign-in (HTTP ${res.status}). Try again.` };
    }
    let key: unknown;
    try { key = (await res.json())?.key; } catch { /* handled below */ }
    if (typeof key !== 'string' || !key.trim()) return { error: "OpenRouter finished the sign-in but sent no key. Try again." };
    try {
      const check = await this.deps.acceptKey(key.trim());
      if (check.verdict === 'rejected') return { error: `OpenRouter made a key but then refused it: ${check.message}` };
    } catch (e) {
      return { error: `The sign-in worked, but the key couldn't be saved: ${e instanceof Error ? e.message : String(e)}` };
    }
    return 'signed-in';
  }

  private finish(round: Round, outcome: SignInOutcome): void {
    if (this.round !== round) return;
    this.round = null;
    this.lastOutcome = outcome;
    this.clearTimer(round.timer);
    try { round.listener.close(); } catch { /* already closed */ }
    this.status_ =
      outcome === 'signed-in' || outcome === 'cancelled' ? { state: 'idle' }
      : outcome === 'timed-out' ? { state: 'failed', message: 'Sign-in timed out. Try again when you are ready.' }
      : { state: 'failed', message: outcome.error };
    for (const w of round.waiters) w(outcome);
  }
}
