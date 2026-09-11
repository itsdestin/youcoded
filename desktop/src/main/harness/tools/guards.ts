// Tool-layer guards. These are NOT permission rules and no mode/preset/
// remembered decision reaches them: secret paths hard-deny; paths outside the
// session cwd report 'external'.
//
// WHAT 'external' COSTS depends on the tool, and that is decided by the CALLER
// (harness-session.ts, READ_ONLY_PATH_TOOLS), not here:
//   • Write/Edit  → a forced approval card, as always.
//   • Read/Grep/Glob → nothing. Since 2026-09-05 a read outside the workspace
//     just runs, in every permission mode. Looking at a file changes nothing,
//     and limitation 1 below means Bash could already read those same bytes
//     with no card, so the toll was only ever paid by the polite tools.
//     The secret hard-denies above are unaffected and still absolute.
//
// The spillRoot / internalReadRoots exemptions further down are consequently
// REDUNDANT for reads (an 'external' verdict now costs a read tool nothing).
// They are kept because they are cheap, they state intent, and they are the
// only thing standing between a future write-shaped tool and a card it should
// not raise — do not read their survival as evidence reads are still gated.
// KNOWN LIMITATIONS (spec §2.3, accepted — honest friction on the file tools,
// not a sandbox):
//   1. Bash can still `cat .env` — these guards only gate the native file tools.
//   2. Symlinks are NOT resolved: a link INSIDE cwd that points at ~/.ssh (or
//      anywhere outside) passes the jail, because we canonicalize the link path
//      lexically, not its realpath target. Deliberate — realpath would hit the
//      fs on every call and still race (TOCTOU). PITFALLS entry ships with this
//      file (Task 13).
import * as path from 'path';
import * as os from 'os';
import { isSensitivePath, isUnderRoot } from '../../artifacts/read-binary-access';
import { isCredentialPath } from './credential-paths';
import { spillRoot } from './spill-paths';

/** Canonicalize to the form isSensitivePath / isUnderRoot expect: forward
 * slashes, lowercased drive letter, no trailing slash on the root, `..` resolved.
 *  - path.resolve(cwd, p) ALWAYS: resolve() normalizes `..`/`.` AND ignores cwd
 *    when p is already absolute, so a lexical `C:/proj/../../secret` collapses to
 *    `C:/secret` instead of sneaking past the cwd jail (fix: the old isAbsolute
 *    branch skipped normalization for absolute inputs).
 *  - Windows is case-insensitive but the sensitive sets are all-lowercase, so we
 *    case-fold the WHOLE path on win32 (not just the drive) — otherwise `.SSH`,
 *    `.Env`, `.NETRC` evade the hard-deny. POSIX stays case-sensitive. */
export function canonicalize(p: string, cwd: string): string {
  const c = path.resolve(cwd, p).replace(/\\/g, '/');
  return process.platform === 'win32' ? c.toLowerCase() : c;
}

export function resolveP(p: string, cwd: string): string {
  // Always resolve() so absolute-with-`..` inputs are normalized, not trusted.
  return path.resolve(cwd, p);
}

/** Normalize a path for OUTPUT: backslashes → forward slashes, nothing else.
 *
 *  NOT `canonicalize()` above. That one also resolves against a cwd, collapses
 *  `..`, and LOWERCASES the whole path on win32 — right for the sensitive-path
 *  comparison sets it feeds, and destructive for anything a user or model reads
 *  back (every path the model sees would arrive lowercased on Windows).
 *
 *  Why this exists (2026-08-11): every harness tool must emit ONE path
 *  vocabulary on every platform. Glob normalized its separators; Grep printed
 *  ripgrep's stdout verbatim, so on Windows the same file came back as
 *  `src/a.ts` from one tool and `src\a.ts` from the other — the two are
 *  unpipeable between tools, which is the exact contract
 *  `harness-tool-bounds.test.ts` → "Grep and Glob agree on path format" pins. */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

// WHY this pair exists (two independent 2026-08 harness reviews, Grok 4.5 and
// Qwen 3.8 Max, hit the SAME asymmetry from opposite sides): Read/Glob/Grep
// always resolve a relative path from the workspace root; Bash resolves from
// its own persisted cwd, which `cd` moves. Both are documented, but a model
// mid-session can straddle the two — Grok assumed Read tracked the shell like
// Bash does; Qwen had `cd`'d into a subdirectory several calls earlier and
// then reused a root-relative path, watching a plain `grep` fail with no clue
// why. Neither half may GUESS: per docs/error-message-standards.md a wrong
// "did you mean" is worse than none, so both directions below confirm the
// alternative actually exists on disk before naming it — this is a
// deterministic disk check, not an inference.

/** Resolves `rawPath` under `altCwd` and returns the resolved absolute path
 *  IF something the caller recognizes actually exists there, else null.
 *  `exists` is injected so each caller asks its own question (a file for
 *  Read, a directory for Glob, "anything" for Grep/Bash). Null for an
 *  absolute `rawPath` too — an absolute path does not depend on either cwd,
 *  so there is no asymmetry to explain. */
export function resolveUnderAlternateCwd(
  rawPath: string,
  altCwd: string,
  exists: (absPath: string) => boolean,
): string | null {
  if (path.isAbsolute(rawPath)) return null;
  const candidate = path.resolve(altCwd, rawPath);
  return exists(candidate) ? candidate : null;
}

/** Read/Glob/Grep direction: a relative path just missed under the workspace
 *  root (`ctx.cwd`) — does it exist under the persisted Bash cwd instead?
 *  Returns a ready-to-append suffix (empty string when there is no such
 *  alternative: no persisted shell cwd, the shell cwd IS the workspace root,
 *  or the candidate genuinely doesn't exist either). Callers append this
 *  directly onto their own "failed"/"rejected" message — never a standalone
 *  sentence, per the house error-message style. */
export function shellCwdMissHint(
  rawPath: string,
  ctx: { cwd: string; shellCwd?: string },
  exists: (absPath: string) => boolean,
): string {
  if (!ctx.shellCwd) return '';
  if (canonicalize(ctx.shellCwd, ctx.cwd) === canonicalize(ctx.cwd, ctx.cwd)) return '';
  const hint = resolveUnderAlternateCwd(rawPath, ctx.shellCwd, exists);
  return hint ? ` It exists relative to the shell's current directory (${ctx.shellCwd}) instead — pass "${hint}".` : '';
}

/** Bash direction (Requirement B, the harder mirror image): a command just
 *  failed with the shell resolving `rawPath` under `failedCwd` (the
 *  persisted, possibly-`cd`-moved shell cwd) — does it exist under the
 *  workspace root instead? Same contract as shellCwdMissHint: empty string
 *  unless the alternative is CONFIRMED on disk. Bash callers additionally
 *  gate this on the failure text itself recognizably naming `rawPath` (see
 *  bash.ts) — arbitrary child-process stderr is not a structured error, so
 *  this function alone is not sufficient to fire the hint, only necessary. */
export function workspaceRootMissHint(
  rawPath: string,
  failedCwd: string,
  ctx: { cwd: string },
  exists: (absPath: string) => boolean,
): string {
  if (canonicalize(failedCwd, ctx.cwd) === canonicalize(ctx.cwd, ctx.cwd)) return '';
  const hint = resolveUnderAlternateCwd(rawPath, ctx.cwd, exists);
  return hint ? ` It exists relative to the workspace root (${ctx.cwd}) instead — pass "${hint}".` : '';
}

/** Third direction (2026-08-16), and the only one that changes a DECISION
 *  rather than decorating an error: `rawPath` resolved OUTSIDE the workspace —
 *  is it a path the model invented for a file that actually lives INSIDE?
 *  Returns the workspace-relative path when it does, else null.
 *
 *  WHY: a local model answered "what's in the roadmap" by Globbing (which
 *  returns workspace-relative paths — `ROADMAP.md`) and then rebuilding an
 *  absolute path out of the project's NAME: `/youcoded-dev/ROADMAP.md`. That
 *  is outside the cwd jail, so checkPathGuard forced an external_directory ask
 *  — an approval prompt about a location that does not exist, for a file
 *  sitting in the workspace the model was already allowed to read. The turn
 *  then hung on that ask (2026-08-16 stuck-session investigation).
 *
 *  Deliberately narrow, on two axes:
 *   • It fires only when the outside path is FICTIONAL. A real file outside
 *     the workspace is a real external access and still gets its ask.
 *   • It reports only what is CONFIRMED inside the workspace. Answering
 *     "no such file" for any outside path would let a model map the user's
 *     disk without ever asking; here every stat is inside the cwd jail, so it
 *     discloses nothing the model could not already Glob for.
 *  Same disk-confirmed contract as resolveUnderAlternateCwd above — never a
 *  guess, per docs/error-message-standards.md.
 *
 *  `exists` is the caller's own question (a file for Read/Edit), matching the
 *  injection style of the two hint helpers. */
export function workspaceMatchFor(
  rawPath: string,
  cwd: string,
  exists: (absPath: string) => boolean,
): string | null {
  const canonical = canonicalize(rawPath, cwd);
  if (exists(canonical)) return null; // a real outside file — genuinely external
  const root = canonicalize(cwd, cwd);
  // Longest suffix first: `/elsewhere/src/index.ts` should recover
  // `src/index.ts`, not a coincidentally-named top-level `index.ts`.
  //
  // Segments come from the ORIGINAL-CASE resolution, never from `canonical`.
  // canonicalize() lowercases the whole path on win32 — which is right for the
  // comparisons above, and wrong for the value this function RETURNS, because
  // that value is handed to the model and shown to the user. Reading the
  // segments off `canonical` meant a file named `ROADMAP.md` was recovered as
  // `roadmap.md` on Windows: it still opens (the filesystem is case-insensitive)
  // but every downstream use of that string carries the wrong name, including
  // git, whose index is case-SENSITIVE on every platform. toPosix's own doc
  // comment names this exact hazard — "destructive for anything a user or model
  // reads back" — and this call site was doing it. Fixed 2026-08-28; it was
  // visible only as one red test on the Windows CI leg.
  const segments = toPosix(resolveP(rawPath, cwd)).split('/').filter(Boolean);
  for (let i = 0; i < segments.length; i++) {
    const suffix = segments.slice(i).join('/');
    const candidate = path.resolve(cwd, suffix);
    // The suffix comes from an already-canonicalized path so it carries no
    // `..`, but re-check rather than reason about it: this helper's whole
    // value is that it only ever names something inside the jail.
    if (!isUnderRoot(canonicalize(candidate, cwd), root)) continue;
    if (exists(candidate)) return suffix;
  }
  return null;
}

export type GuardVerdict =
  | { kind: 'ok' }
  | { kind: 'deny'; reason: string }
  | { kind: 'external'; canonicalPath: string };

export function checkPathGuard(rawPath: string, cwd: string, internalReadRoots?: string[]): GuardVerdict {
  const canonical = canonicalize(rawPath, cwd);
  // isSensitivePath already covers .ssh/.gnupg/.aws segments, credential
  // basenames, .config/gh, and (as of Phase 2) dotenv files.
  if (isSensitivePath(canonical)) {
    return { kind: 'deny', reason: `Access to ${rawPath} is blocked: it looks like a credential or secret file. This cannot be overridden.` };
  }
  // Belt-and-suspenders for the home credential dirs even when addressed
  // relatively — redundant with isSensitivePath's segment check, but keeps the
  // guard's intent legible and survives any future narrowing of that set.
  const home = canonicalize(os.homedir(), cwd);
  for (const secretDir of [`${home}/.ssh`, `${home}/.gnupg`, `${home}/.aws`]) {
    if (isUnderRoot(canonical, secretDir)) {
      return { kind: 'deny', reason: `Access to ${rawPath} is blocked: it is under a credential directory. This cannot be overridden.` };
    }
  }
  // Harness-only credential files (2026-09-10 security review): git/docker/cloud
  // credentials, keyrings, browser login stores, YouCoded's own encrypted stores.
  // Separate from isSensitivePath so the file VIEWER is unaffected — see
  // credential-paths.ts.
  if (isCredentialPath(canonical, home)) {
    return { kind: 'deny', reason: `Access to ${rawPath} is blocked: it looks like a stored credential. This cannot be overridden.` };
  }
  // Bash's own spill files are readable without an external_directory ask.
  //
  // WHY (2026-08-11 review round 8): when Bash truncates, it saves the full
  // output under tmpdir and the result tells the model to "Read that file" —
  // but tmpdir is outside the workspace, so following that advice forced an
  // approval prompt, and in the review battery (where every ask is denied) it
  // was a closed loop: two models were told to read a file the harness would
  // never let them read. The advice and the guard have to agree, and the
  // advice is the correct half — the model is reading back output of a command
  // it already ran and already partly saw.
  //
  // Deliberately placed AFTER the credential denies above, so this can never
  // become a bypass: a path only reaches here once it has cleared them. Scoped
  // to spillRoot() and nothing else — that tree is written by this harness
  // alone, contains only Bash output, and is swept on a retention policy. It
  // widens nothing the threat model didn't already accept: per the KNOWN
  // LIMITATIONS at the top of this file, Bash can read any of it directly.
  if (isUnderRoot(canonical, canonicalize(spillRoot(), cwd))) return { kind: 'ok' };
  // Task 10 (plan 1b) — a session's own internal read roots (e.g. the spill
  // directory an oversized specialist report was written to) are readable
  // without an external_directory ask, same shape as the spillRoot exemption
  // just above and for the identical reason: the footer that names the path
  // tells the model to Read it, and the guard has to agree that it's allowed
  // to. Unlike spillRoot() (one fixed global constant), these roots are
  // PER-SESSION — the caller (HarnessSession, from opts.internalReadRoots)
  // decides what counts as "this session's own", so the exemption can never
  // widen beyond what that one session was actually wired with. Checked here,
  // AFTER the credential denies above and BEFORE the external-directory
  // branch below, so it can deny-override but never bypass a secret path.
  if (internalReadRoots?.some((root) => isUnderRoot(canonical, canonicalize(root, cwd)))) return { kind: 'ok' };
  if (!isUnderRoot(canonical, canonicalize(cwd, cwd))) {
    return { kind: 'external', canonicalPath: canonical }; // → external_directory ask
  }
  return { kind: 'ok' };
}
