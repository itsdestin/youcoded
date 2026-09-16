import { execFile } from 'child_process';
import { promisify } from 'util';
import { log } from '../logger';
import { resolveCommand } from '../prerequisite-installer';
import type { ClaudeAccountStatus } from '../../shared/claude-account-types';

const execFileAsync = promisify(execFile);

// Claude Code's live sign-in state — the answer the model menu and the Cloud
// providers card read. Rationale for existing at all: shared/claude-account-types.ts.
//
// Shaped deliberately like ChatGptAuth's read side (`status()`), because the two
// cards sit next to each other on the same Settings page and the renderer should
// not have to treat them differently.

/** How long an answer is reused before the CLI is asked again.
 *
 *  WHY 60s: the probe spawns a process (~0.13s measured 2026-09-09). Opening
 *  the model menu ten times in a minute must not spawn ten of them, but the
 *  answer must also not be so stale that a `/logout` in a terminal takes
 *  minutes to show up. Every event that plausibly changes the answer calls
 *  `invalidate()` anyway, so this is only the backstop. */
export const CLAUDE_STATUS_CACHE_MS = 60_000;

/** Hard ceiling on the probe. WHY: `claude auth status` normally answers in
 *  ~0.13s, but it is a subprocess on the user's machine — a wedged binary, a
 *  stalled network drive or an antivirus scan must never leave the Settings
 *  card spinning forever. On timeout the answer is `unknown`, which keeps every
 *  model available (never invent a problem). */
export const CLAUDE_STATUS_TIMEOUT_MS = 8_000;

/** What `claude auth status` prints. Only the fields this app reads; the CLI
 *  emits more (orgId, projectsDirectory, analyticsDisabled…). Measured against
 *  a real Max account on 2026-09-09:
 *    {"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty",
 *     "email":"…","orgName":"…","subscriptionType":"max"} */
interface AuthStatusJson {
  loggedIn?: boolean;
  authMethod?: string;
  apiProvider?: string;
  email?: string;
  subscriptionType?: string;
}

/** The one subprocess call, injectable so the tests never spawn anything. */
export type AuthStatusRunner = () => Promise<{ stdout: string }>;

const defaultRunner: AuthStatusRunner = () =>
  execFileAsync(resolveCommand('claude'), ['auth', 'status'], {
    timeout: CLAUDE_STATUS_TIMEOUT_MS,
    windowsHide: true,
  }) as Promise<{ stdout: string }>;

/**
 * Turn one run of `claude auth status` into a status. Pure and exported so the
 * whole decision table is testable without a process.
 *
 * `claude auth status` EXITS 0 EVEN WHEN LOGGED OUT (the same trap
 * prerequisite-installer.ts's detectAuth documents) — so the exit code says
 * nothing and only the parsed `loggedIn` field does.
 */
export function statusFromOutput(stdout: string): ClaudeAccountStatus {
  let parsed: AuthStatusJson;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    // The CLI printed something that is not JSON — a newer version changed its
    // output, or a shell profile wrote a banner onto stdout. We genuinely do not
    // know the answer, so we say so rather than guessing "signed out" and
    // greying out a working install.
    return { state: 'unknown' };
  }
  if (parsed.loggedIn !== true) return { state: 'signed-out' };
  // apiProvider 'firstParty' = a claude.ai account. Anything else (bedrock,
  // vertex) or authMethod naming a key means there is no Claude plan behind
  // this login, so the card must not promise plan limits.
  const apiKey = parsed.authMethod !== 'claude.ai';
  return {
    state: 'signed-in',
    email: parsed.email || undefined,
    plan: apiKey ? undefined : parsed.subscriptionType || undefined,
    apiKey,
  };
}

/** Is this failure "there is no claude binary" rather than "the probe broke"?
 *  The two need different words on screen, so they are different states. */
function isMissingBinary(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

export class ClaudeAccount {
  private cached: { status: ClaudeAccountStatus; at: number } | null = null;
  private inFlight: Promise<ClaudeAccountStatus> | null = null;

  constructor(
    private readonly run: AuthStatusRunner = defaultRunner,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The live answer, cached for `CLAUDE_STATUS_CACHE_MS`.
   *
   * Concurrent callers share one probe: the model menu, the Settings card and
   * the new-session form can all mount in the same frame, and three spawns for
   * one answer is exactly the cost this cache exists to avoid.
   */
  async status(): Promise<ClaudeAccountStatus> {
    const fresh = this.cached && this.now() - this.cached.at < CLAUDE_STATUS_CACHE_MS;
    if (fresh) return this.cached!.status;
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.probe()
      .then((status) => {
        // An `unknown` answer is NOT cached: it means the probe failed, and a
        // failure should be retried on the next ask rather than pinned for a
        // minute. A definite yes/no is cached.
        if (status.state !== 'unknown') this.cached = { status, at: this.now() };
        return status;
      })
      .finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  /** The last answer without asking again — for a synchronous render that must
   *  not block. Null when nothing has been read yet. */
  peek(): ClaudeAccountStatus | null {
    return this.cached?.status ?? null;
  }

  /** Drop the cache so the next `status()` re-probes. Called by anything that
   *  plausibly changed the login: the app regaining focus, a session failing to
   *  start, the user opening the Cloud providers page. */
  invalidate(): void {
    this.cached = null;
  }

  private async probe(): Promise<ClaudeAccountStatus> {
    try {
      const { stdout } = await this.run();
      return statusFromOutput(stdout);
    } catch (err) {
      if (isMissingBinary(err)) return { state: 'not-installed' };
      // Timed out, killed, permission denied — we do not know, and saying
      // "signed out" here is precisely the bug this module was written to fix.
      log('WARN', 'claude-account', 'auth status probe failed', { error: String(err) });
      return { state: 'unknown' };
    }
  }
}
