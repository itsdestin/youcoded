// Claude Code's own sign-in, as the app reads it LIVE. Shared between main and
// renderer; keep free of Node/Electron imports.
//
// WHY THIS FILE EXISTS (bug found 2026-09-09).
//
// Every other provider answers "can you run a model right now?" from live state:
// ChatGPT from its account file, OpenRouter from its key, the local engine from
// whether the engine is installed. Claude Code — the built-in engine — had no
// live answer at all, so the model menu and the Cloud providers card borrowed
// the SETUP WIZARD's notes instead (`FirstRunState.authComplete`).
//
// That is a record of the past, and it was wrong in two ways at once:
//   · On every launch after the first, main.ts answers `firstRun.getState()`
//     with a bare `{ currentStep: 'COMPLETE' }` — no authComplete field at all —
//     so the menu read the blank as "signed out" and greyed out every Claude
//     model with "Sign in to use" on an install that was signed in and working.
//   · Even with the real file, a `/logout` in a terminal, an expired token or a
//     revoked login left the notes saying "signed in" forever.
//
// So Claude Code gets the same live check the other three already have. The
// answer comes from `claude auth status`, which is the CLI's own answer about
// its own login — measured at 0.13s on 2026-09-09.

/**
 * What the live probe found.
 *
 * FOUR states, not two. `unknown` is load-bearing: Destin's standing rule is
 * that the app never invents a problem it is not sure about (2026-09-07), so a
 * probe that timed out or returned something unparsable must NOT grey out a
 * model the user can perfectly well run. Only a definite `signed-out` or
 * `not-installed` does that.
 */
export type ClaudeAccountStatus =
  /** `claude auth status` said `loggedIn: true`. */
  | {
      state: 'signed-in';
      /** The account's email, as the CLI reports it. Absent on installs whose
       *  auth carries no email (an API key). */
      email?: string;
      /** `subscriptionType` verbatim ('max', 'pro', …) — free-form on purpose,
       *  the same way ChatGPT's plan string is. Absent for API-key auth, which
       *  bills per token and has no plan. */
      plan?: string;
      /** True when the login is an Anthropic API key rather than a Claude
       *  account, so the card can say which one it is instead of promising
       *  plan limits that do not exist. */
      apiKey: boolean;
    }
  /** The CLI ran and said `loggedIn: false`. */
  | { state: 'signed-out' }
  /** No `claude` binary on PATH. Different from signed-out, and it needs
   *  different words: signing in is not the fix. */
  | { state: 'not-installed' }
  /** The probe could not produce an answer (timed out, unparsable output).
   *  Treated as "assume it works" everywhere — see the type comment. */
  | { state: 'unknown' };

/** Human plan label: 'max' → 'Max plan'. Unknown strings pass through
 *  title-cased so a plan Anthropic renames still reads as a name, not a code.
 *  Mirrors `chatGptPlanLabel` so the two cards read as one system. */
export function claudePlanLabel(plan: string | undefined): string {
  const p = (plan ?? '').trim();
  if (!p) return 'Claude plan';
  return `${p.charAt(0).toUpperCase()}${p.slice(1)} plan`;
}

/**
 * Can Claude Code run a model on this install?
 *
 * The ONE place that question is answered from a status, so the model menu, the
 * Default model row and the new-session forms cannot drift apart. `unknown`
 * answers yes — see the type comment.
 */
export function claudeCanRun(status: ClaudeAccountStatus | null | undefined): boolean {
  if (!status) return true; // not asked yet — never accuse a working install
  return status.state === 'signed-in' || status.state === 'unknown';
}

/** The words shown on a greyed model row when Claude Code cannot run it.
 *  Null when it can. Kept beside the state so the reason and the judgement
 *  cannot disagree. */
export function claudeUnavailableReason(status: ClaudeAccountStatus | null | undefined): string | null {
  if (claudeCanRun(status)) return null;
  return status?.state === 'not-installed' ? 'Claude Code not installed' : 'Sign in to use';
}
