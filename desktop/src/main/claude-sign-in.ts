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

type Login = Pick<OAuthLogin, 'url' | 'kill' | 'waitForUrl'> & Partial<Pick<OAuthLogin, 'onExit'>>;

/** The ONE way the app opens Claude Code's login: start `claude auth login`, wait for its link,
 *  and end the process when no link came. WHY shared (1.3.4 bug): first launch (first-run.ts) and
 *  "Sign in again" (below) each had their own copy of these steps; the copies drifted and only the
 *  newer one broke in the installed app. Both screens now go through here. Resolves the running
 *  login (its `url` is set) or null when no link appeared. */
export async function openClaudeLogin(
  start: () => Login = realStart,
  // WHY onStart: the caller needs the running process BEFORE the link wait ends, so a Cancel during
  // that wait (up to 15 s) can end it at once. Otherwise the cancelled login lingers holding Claude's
  // browser-callback port, and an immediate retry collides with it.
  onStart?: (login: Login) => void,
): Promise<Login | null> {
  const login = start();
  onStart?.(login);
  const url = await login.waitForUrl(LOGIN_LINK_WAIT_MS);
  if (!url) { login.kill(); return null; }
  return login;
}

export interface ClaudeSignInDeps {
  start?: () => Login;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** WHY injectable: Android brings YouCoded back from the browser (a no-op on desktop). */
  returnToApp?: () => void;
}

/** The sentence shown when no login link appeared (same words first-run uses). */
export const NO_LOGIN_LINK_MESSAGE = 'Could not get login URL from Claude Code.';

export class ClaudeSignIn {
  private login: Login | null = null;
  private round = 0;
  private readonly d: Required<Omit<ClaudeSignInDeps, 'start'>> & { start: () => Login };

  constructor(deps: ClaudeSignInDeps = {}) {
    this.d = {
      start: deps.start ?? realStart,
      sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      now: deps.now ?? Date.now,
      returnToApp: deps.returnToApp ?? returnToApp,
    };
  }

  /** Starts the login. Resolves true once the link exists (the browser is open); throws a screen
   *  sentence when none appeared. A second call while one is open joins it. */
  async signIn(account: Pick<ClaudeAccount, 'status' | 'invalidate' | 'clearAuthFailure'>): Promise<boolean> {
    if (this.login) return true;
    const round = ++this.round;
    // WHY a placeholder taken BEFORE any await: a second click while this one is still reading the
    // account or waiting for the link joins it (the `if (this.login)` above) instead of starting a
    // second `claude auth login`. Its kill reaches the real process as soon as one exists, so Cancel
    // during the wait ends it immediately.
    let started = null as Login | null; // `as`: set inside the onStart callback, which TS cannot see
    this.login = { url: null, kill: () => started?.kill(), waitForUrl: async () => null };
    try {
      // What the login looked like BEFORE: an EXPIRED login still reads "signed in", so "signed in"
      // alone cannot say the person finished. A different end time can.
      account.invalidate();
      const before = await account.status().catch(() => ({ state: 'unknown' as const }));
      if (round !== this.round) return true; // cancelled before the login started
      let exitedOk = false;
      const login = await openClaudeLogin(() => {
        const l = this.d.start();
        l.onExit?.((code) => { if (code === 0) exitedOk = true; });
        return l;
      }, (l) => { started = l; });
      if (round !== this.round) { login?.kill(); return true; } // cancelled while the link was coming
      if (!login) throw new Error(NO_LOGIN_LINK_MESSAGE);
      this.login = login;
      void this.finish(account, before, login, round, () => exitedOk);
      return true;
    } catch (err) {
      // WHY: whatever failed (no link, or start() itself threw), never leave the placeholder behind —
      // it would make every later signIn() a silent no-op until the app restarts.
      if (round === this.round) { started?.kill(); this.login = null; }
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
    this.login?.kill();
    this.login = null;
    return true;
  }

  private async finish(
    account: Pick<ClaudeAccount, 'status' | 'invalidate' | 'clearAuthFailure'>,
    before: Awaited<ReturnType<ClaudeAccount['status']>>,
    login: Login, round: number, exitedOk: () => boolean,
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
