// claude-sign-in.ts — "Sign in again" for Claude Code, from the chat card and Settings.
//
// WHY (card #236): when Claude's login runs out the person used to be told to run /login in a
// terminal. This runs the SAME `claude auth login` first launch already uses (openClaudeLogin, below,
// which opens the browser itself — so nothing here opens a tab) and keeps it alive until the
// browser round-trip is done, exactly like first-run.ts handleOAuthLogin.
//
// The caller (the chat card / Settings card) polls `claude-code:status` to learn the end; this
// only answers "the browser is open" (true) and then finishes in the background.
import { log } from './logger';
import { returnToApp } from './headless/host-bridge';
import { startOAuthLogin as realStart, type OAuthLogin } from './prerequisite-installer';
import type { ClaudeAccount } from './providers/claude-account';

/** How long the login process is kept waiting for the person. WHY 10 min: the cap the Settings
 *  card's own poll gives every provider (provider-sign-in-store.ts). */
const CLAUDE_SIGN_IN_TIMEOUT_MS = 10 * 60_000;
const POLL_MS = 2000;
/** The longest wait for the login link. WHY 15 s, not the old fixed 1.5 s: the wait now ends the
 *  moment the link is printed (usually well under a second), so the cap only matters on a slow start
 *  — a cold boot or a just-updated CLI — where 1.5 s failed a login that would have worked. */
export const LOGIN_LINK_WAIT_MS = 15_000;

/** The ONE way the app opens Claude Code's login: start `claude auth login`, wait for its link,
 *  and end the process when no link came. WHY shared (1.3.4 bug): first launch (first-run.ts) and
 *  "Sign in again" (below) each had their own copy of these steps; the copies drifted and only the
 *  newer one broke in the installed app. Both screens now go through here. Resolves the running
 *  login (its `url` is set) or null when no link appeared.
 *  `start` runs synchronously before the wait, so a caller that must Cancel DURING the wait (up to
 *  15 s) keeps the process's kill from inside its own `start` — a cancelled login left running holds
 *  Claude's browser-callback port and an immediate retry collides with it. */
export async function openClaudeLogin(start: () => OAuthLogin = realStart): Promise<OAuthLogin | null> {
  const login = start();
  const url = await login.waitForUrl(LOGIN_LINK_WAIT_MS);
  if (!url) { login.kill(); return null; }
  return login;
}

export interface ClaudeSignInDeps {
  start?: () => OAuthLogin;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** WHY injectable: Android brings YouCoded back from the browser (a no-op on desktop). */
  returnToApp?: () => void;
}

/** The sentence shown when no login link appeared (same words first-run uses). */
export const NO_LOGIN_LINK_MESSAGE = 'Could not get login URL from Claude Code.';

export class ClaudeSignIn {
  /** The running `claude auth login`, from the moment it starts (so Cancel can end it during the
   *  link wait) until it finishes or is cancelled. */
  private login: OAuthLogin | null = null;
  /** The press-to-link attempt now under way. WHY one shared promise: a second press — even before
   *  the account was read — joins it and gets the SAME outcome (true, or the "no link" error),
   *  instead of starting a second login or being told "true" while the first one fails. */
  private inflight: Promise<boolean> | null = null;
  private round = 0;
  private readonly d: Required<Omit<ClaudeSignInDeps, 'start'>> & { start: () => OAuthLogin };

  constructor(deps: ClaudeSignInDeps = {}) {
    this.d = {
      start: deps.start ?? realStart,
      sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      now: deps.now ?? Date.now,
      returnToApp: deps.returnToApp ?? returnToApp,
    };
  }

  /** Starts the login. Resolves true once the link exists (the browser is open); throws a screen
   *  sentence when none appeared. A call during an attempt joins it; a call while an opened login
   *  is finishing in the background answers true. */
  signIn(account: Pick<ClaudeAccount, 'status' | 'invalidate' | 'clearAuthFailure'>): Promise<boolean> {
    if (this.inflight) return this.inflight;
    if (this.login) return Promise.resolve(true);
    const attempt: Promise<boolean> = this.attempt(account).finally(() => {
      if (this.inflight === attempt) this.inflight = null; // a newer attempt (after Cancel) keeps its own
    });
    this.inflight = attempt;
    return attempt;
  }

  private async attempt(account: Pick<ClaudeAccount, 'status' | 'invalidate' | 'clearAuthFailure'>): Promise<boolean> {
    const round = ++this.round;
    try {
      // What the login looked like BEFORE: an EXPIRED login still reads "signed in", so "signed in"
      // alone cannot say the person finished. A different end time can.
      account.invalidate();
      const before = await account.status().catch(() => ({ state: 'unknown' as const }));
      if (round !== this.round) return true; // cancelled before the login started
      let exitedOk = false;
      const login = await openClaudeLogin(() => {
        const l = this.d.start();
        this.login = l; // WHY here, before the wait: Cancel during the link wait ends this process
        l.onExit((code) => { if (code === 0) exitedOk = true; });
        return l;
      });
      if (round !== this.round) { login?.kill(); return true; } // cancelled while the link was coming
      if (!login) throw new Error(NO_LOGIN_LINK_MESSAGE);
      void this.finish(account, before, login, round, () => exitedOk);
      return true;
    } catch (err) {
      // Cancelled meanwhile: the person already left this attempt; nothing to report.
      if (round !== this.round) return true;
      // WHY: whatever failed (no link, or start() itself threw), never leave a login behind — a stale
      // one would make every later signIn() answer "true" without doing anything.
      this.login?.kill();
      this.login = null;
      if (err instanceof Error && err.message === NO_LOGIN_LINK_MESSAGE) throw err;
      // A crash while starting is not something the person can act on in detail; the card shows the
      // same accurate sentence (no login link came) and the log keeps the real cause.
      log('ERROR', 'claude-sign-in', 'Claude sign-in could not start', { error: String(err) });
      throw new Error(NO_LOGIN_LINK_MESSAGE);
    }
  }

  /** Stops an open login. Always true (nothing open is fine). */
  cancel(): boolean {
    this.round++; // an open wait notices and quietly stops
    this.inflight = null; // so an immediate retry starts afresh instead of joining the cancelled one
    this.login?.kill();
    this.login = null;
    return true;
  }

  private async finish(
    account: Pick<ClaudeAccount, 'status' | 'invalidate' | 'clearAuthFailure'>,
    before: Awaited<ReturnType<ClaudeAccount['status']>>,
    login: OAuthLogin, round: number, exitedOk: () => boolean,
  ): Promise<void> {
    const started = this.d.now();
    const beforeEnd = before.state === 'signed-in' ? before.expiresAt : undefined;
    const needsNewEnd = before.state === 'signed-in' && !!beforeEnd;
    try {
      while (round === this.round && this.d.now() - started < CLAUDE_SIGN_IN_TIMEOUT_MS) {
        await this.d.sleep(POLL_MS);
        if (round !== this.round) return;
        account.invalidate();
        const s = await account.status().catch(() => ({ state: 'unknown' as const }));
        // Finished when the login process says it succeeded, or the account now reads signed in
        // with a NEW end time (was signed in already) / at all (was signed out). A login with no
        // end time to compare can only be confirmed by the process exiting cleanly.
        const done = exitedOk()
          || (s.state === 'signed-in'
              && (before.state === 'signed-in' ? needsNewEnd && !!s.expiresAt && s.expiresAt !== beforeEnd : true));
        if (done) {
          log('INFO', 'claude-sign-in', 'Claude sign-in finished');
          account.clearAuthFailure();
          account.invalidate();
          this.d.returnToApp(); // WHY: on the phone, bring YouCoded back from the browser (no-op on desktop)
          return;
        }
      }
    } finally {
      // Only the open round tears down; a newer sign-in owns `this.login` now.
      if (round === this.round) { login.kill(); this.login = null; }
    }
  }
}

/** One sign-in at a time per app, like the other providers. */
export const claudeSignIn = new ClaudeSignIn();
