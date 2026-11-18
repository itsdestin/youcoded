// claude-sign-in.ts — "Sign in again" for Claude Code, from the chat card and Settings.
//
// WHY (card #236): when Claude's login runs out the person used to be told to run /login in a
// terminal. This runs the SAME `claude auth login` first launch already uses (startOAuthLogin,
// which opens the browser itself — so nothing here opens a tab) and keeps it alive until the
// browser round-trip is done, exactly like first-run.ts handleOAuthLogin.
//
// The caller (the chat card / Settings card) polls `claude-code:status` to learn the end; this
// only answers "the browser is open" (true) and then finishes in the background.
import { log } from './logger';
import { returnToApp } from './headless/host-bridge';
import { startOAuthLogin as realStart } from './prerequisite-installer';
import type { ClaudeAccount } from './providers/claude-account';

/** How long the login process is kept waiting for the person. WHY 10 min: the cap the Settings
 *  card's own poll gives every provider (provider-sign-in-store.ts). */
const CLAUDE_SIGN_IN_TIMEOUT_MS = 10 * 60_000;
const POLL_MS = 2000;
/** How long to wait for the login link to appear. Same 1.5 s first-run waits. */
const URL_WAIT_MS = 1500;

type Login = { url: string | null; kill: () => void; onExit?: (cb: (code: number | null) => void) => void };

export interface ClaudeSignInDeps {
  start?: (isPackaged: boolean) => Login;
  isPackaged?: boolean;
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
  private readonly d: Required<Omit<ClaudeSignInDeps, 'start'>> & { start: (p: boolean) => Login };

  constructor(deps: ClaudeSignInDeps = {}) {
    this.d = {
      start: deps.start ?? realStart,
      isPackaged: deps.isPackaged ?? false,
      sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      now: deps.now ?? Date.now,
      returnToApp: deps.returnToApp ?? returnToApp,
    };
  }

  /** Starts the login. Resolves true once the link exists (the browser is open); throws a screen
   *  sentence when none appeared. A second call while one is open joins it. */
  async signIn(account: Pick<ClaudeAccount, 'status' | 'invalidate' | 'clearAuthFailure'>): Promise<boolean> {
    if (this.login) return true;
    // What the login looked like BEFORE: an EXPIRED login still reads "signed in", so "signed in"
    // alone cannot say the person finished. A different end time can.
    account.invalidate();
    const before = await account.status().catch(() => ({ state: 'unknown' as const }));
    const login = this.d.start(this.d.isPackaged);
    const round = ++this.round;
    this.login = login;
    let exitedOk = false;
    login.onExit?.((code) => { if (code === 0) exitedOk = true; });

    await this.d.sleep(URL_WAIT_MS);
    if (!login.url) {
      login.kill();
      this.login = null;
      throw new Error(NO_LOGIN_LINK_MESSAGE);
    }
    void this.finish(account, before, login, round, () => exitedOk);
    return true;
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
