// editable-path-policy — THE security boundary for artifact writes (D5,
// resolved 2026-07-22; spec 2026-07-20 §12.1, plan §1).
//
// Why this exists: artifacts:get/save enforce nothing but path traversal in
// main, so the renderer's old 3-extension allowlist was load-bearing security
// by accident. Unlocking code editing (D4) without this module would expose
// .git/hooks (code execution on next commit), .claude hooks/settings (hook
// config IS command execution), .env secrets, and the .youcoded sidecar (whose
// tracked absolutePath field converts an in-root write into an arbitrary
// out-of-root write).
//
// Placement: lives in shared/ because BOTH sides consume it — main (and the
// Kotlin port EditablePathPolicy.kt) ENFORCE it on the resolved absolute path;
// the renderer only MIRRORS it to hide the Edit affordance and to show the
// confirm dialog before offering an action main would refuse.
//
// Contract: callers pass a CANONICAL path (canonicalize(p, null)) of the
// RESOLVED target — after fs.realpath — so symlinks and Windows case tricks
// cannot dodge a segment match. Pure module (no fs/path imports) so it stays
// unit-testable; the shared fixture editable-path-policy-cases.json pins the
// TS and Kotlin implementations to identical verdicts.

export type EditTier = 'free' | 'needs-confirm' | 'denied';

/** Directory segments refused for READS anywhere in the path, even inside an
 * allowed project root. Shared with artifacts:read-binary (which additionally
 * refuses dotenv — see protectedReadPath for why saves differ). */
export const SENSITIVE_SEGMENTS = new Set(['.ssh', '.gnupg', '.aws', '.azure', '.kube']);

/** Basenames refused outright (credential stores). */
export const SENSITIVE_BASENAMES = new Set(['.netrc', '_netrc', '.credentials.json']);

/** `.config/gh` holds the GitHub OAuth token (hosts.yml). */
export const SENSITIVE_SUBPATHS = ['/.config/gh/'];

/** True for `.env`, `.env.<suffix>`, and direnv `.envrc` — but NOT unrelated
 * names that merely start with the letters (e.g. `.environment`). */
export function isDotenvBasename(base: string): boolean {
  return base === '.env' || base === '.envrc' || base.startsWith('.env.');
}

// Never editable in-pane: no legitimate editing story, and both are escalation
// vectors — .git/hooks + .git/config run code; .youcoded is the sidecar whose
// absolutePath field the tracked save branch trusts completely. Matches a `.git`
// FILE too (the worktree case), since a basename is just the final segment.
const DENIED_SEGMENTS = new Set(['.git', '.youcoded']);

// Editable behind an explicit confirm: legitimate user flows exist (editing
// your own rules/skills, pasting an API key into .env), but the consequences
// deserve one deliberate click — .claude settings/hooks run commands, dotenv
// holds secrets, .envrc is executed as shell by direnv.
const CONFIRM_SEGMENTS = new Set(['.claude']);

function splitCanonical(canonicalPath: string): { parts: string[]; base: string } {
  const parts = canonicalPath.split('/');
  return { parts, base: parts[parts.length - 1] ?? '' };
}

/**
 * The per-path write policy. Precedence: denied > needs-confirm > free, so
 * e.g. ~/.claude/CLAUDE.md is needs-confirm (global agent memory) while a
 * project CLAUDE.md is free (editing it is the product pitch).
 */
export function editTier(canonicalPath: string): EditTier {
  const { parts, base } = splitCanonical(canonicalPath);
  if (parts.some((seg) => DENIED_SEGMENTS.has(seg))) return 'denied';
  if (parts.some((seg) => SENSITIVE_SEGMENTS.has(seg))) return 'denied';
  if (SENSITIVE_BASENAMES.has(base)) return 'denied';
  if (SENSITIVE_SUBPATHS.some((sub) => canonicalPath.includes(sub))) return 'denied';
  if (parts.some((seg) => CONFIRM_SEGMENTS.has(seg))) return 'needs-confirm';
  if (isDotenvBasename(base)) return 'needs-confirm';
  return 'free';
}

/**
 * Paths artifacts:get refuses to READ: the sensitive set MINUS dotenv.
 * Deliberate asymmetry with read-binary (which denies dotenv): the agent's
 * tools are hard-denied dotenv, so the pane is the HUMAN escape hatch — a
 * confirm-tier .env edit requires get to serve its content (D5).
 */
export function protectedReadPath(canonicalPath: string): boolean {
  const { parts, base } = splitCanonical(canonicalPath);
  if (parts.some((seg) => SENSITIVE_SEGMENTS.has(seg))) return true;
  if (SENSITIVE_BASENAMES.has(base)) return true;
  return SENSITIVE_SUBPATHS.some((sub) => canonicalPath.includes(sub));
}

/** How much of a text file is served on the FIRST read. A naked multi-MB
 * readFile blocks the main thread, transits IPC/WS whole, then blocks the
 * renderer highlighting it (spec §2.3).
 *
 * This is no longer a wall: above it the file still opens, read-only, showing
 * this much with the rest a click away (spec §4.3). So the number means "this
 * much appears instantly", not "we refuse above this".
 *
 * 3 MB — Destin, 2026-08-25. The measurement (spec §2) put p99.5 of real text
 * files at 206 KB, so any value in this range serves ~100% of first reads
 * whole; the extra megabyte is headroom, not a fix for a measured miss. */
export const EDIT_MAX_BYTES = 3 * 1024 * 1024;

/** Ceiling on "Load the whole file" from the partial-view banner (spec §4.3).
 * Deliberately expressed as a multiple of the cap rather than an independent
 * magic number: it means "we will load at most four times what we promise to
 * show instantly". A starting value, not a measurement. Past this the renderer
 * blocks long enough to feel frozen -- which is what EDIT_MAX_BYTES exists to
 * prevent in the first place. */
export const FULL_READ_MAX_BYTES = 4 * EDIT_MAX_BYTES;

/** Ceiling for artifacts:read-binary — base64 inflates 33% and it all transits
 * IPC/WS. This is the limit that actually governs images, PDFs and Office docs;
 * EDIT_MAX_BYTES governs only the text editor. Confusing the two is what made
 * the pane refuse a 2.3 MB PNG (spec §1.1). */
export const READ_BINARY_MAX_BYTES = 50 * 1024 * 1024;

/**
 * True when reading these bytes as UTF-8 loses information: the file is text in
 * an older encoding (Latin-1 / Windows-1252 — an accented word is the common
 * case), so every byte the decoder cannot read comes back as U+FFFD.
 *
 * WHY it gates editing (2026-09-11): the pane already shows those replacements,
 * and saving writes them over the originals — a file loses every accent for
 * good even when the user changed an unrelated line. The NUL sniff above does
 * not catch this (such a file has no NUL bytes), which is why it needs its own
 * question. Mirrored in Kotlin EditablePathPolicy.losesBytesAsUtf8.
 */
export function losesBytesAsUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return false;
  } catch {
    return true;
  }
}

/** git-style binary sniff: a NUL byte in the head slice means not-text. The
 * caller passes at most the first 8KB — do not read whole files to decide. */
export function looksBinary(head: Uint8Array): boolean {
  const n = Math.min(head.length, 8192);
  for (let i = 0; i < n; i++) {
    if (head[i] === 0) return true;
  }
  return false;
}
