import type { PermissionOverrides } from '../shared/types';
import { docCommentsMcpMutatorTools } from '../shared/doc-comments-mcp';
import { nativeFormatFor } from './doc-comments/doc-comments-dispatch';

// --- Permission override classification ---
// In bypass mode, Claude Code still fires PermissionRequest for protected paths,
// compound cd commands, and AskUserQuestion. These regexes classify each request
// so the user's per-category overrides can selectively auto-approve them.

const TITLE_HOOK_RE = /[>|].*[/\\]\.claude[/\\]topics[/\\]topic-/;
const CONFIG_FILE_RE = /\.(bashrc|bash_profile|zshrc|zprofile|profile|gitconfig|gitmodules|ripgreprc)\b|\.mcp\.json|\.claude\.json/;
const PROTECTED_DIR_RE = /[/\\]\.git[/\\]|[/\\]\.claude[/\\]/;
const CD_REDIRECT_RE = /\bcd\b.*[>]/;
const CD_GIT_RE = /\bcd\b.*\bgit\b/;

type PermissionCategory =
  | 'titleHook'
  | 'protectedConfigFiles'
  | 'protectedDirectories'
  | 'compoundCdRedirect'
  | 'compoundCdGit'
  | 'unknown';

function classifyPermission(toolName: string, toolInput?: Record<string, unknown>): PermissionCategory {
  const cmd = (toolInput?.command as string) || '';
  const filePath = (toolInput?.file_path as string) || '';
  const target = cmd || filePath;

  // Title hook — always auto-approved, checked first
  if (toolName === 'Bash' && TITLE_HOOK_RE.test(cmd)) return 'titleHook';

  // Compound cd patterns (Bash only) — check before path-based patterns
  // because a single command can match both (e.g., cd /tmp && echo > .git/config)
  if (toolName === 'Bash') {
    if (CD_GIT_RE.test(cmd)) return 'compoundCdGit';
    if (CD_REDIRECT_RE.test(cmd)) return 'compoundCdRedirect';
  }

  // Protected config files
  if (CONFIG_FILE_RE.test(target)) return 'protectedConfigFiles';

  // Protected directories (.git/, .claude/)
  if (PROTECTED_DIR_RE.test(target)) return 'protectedDirectories';

  return 'unknown';
}

/** Tools that need the user's OWN answer. Claude Code ignores a hook "allow"
 *  for them (measured on 2.1.281 for ExitPlanMode:
 *  tests/fixtures/plan-menu/cc-2.1.281-hook-allow-only-120x40.json — the menu
 *  stayed up), so auto-allowing one only hides the card while the question is
 *  still waiting in the terminal. */
const NEEDS_THE_USERS_OWN_ANSWER = new Set(['AskUserQuestion', 'ExitPlanMode']);

/**
 * The Claude Code CLI's own live permission mode, as it names its values
 * (verified 2026-09-27 against the installed 2.1.283 binary's embedded Zod
 * schema and its own `--help`/documentation strings — see
 * youcoded/docs/cc-dependencies.md's "hook payload permission_mode field"
 * entry for the exact evidence, since no official published schema doc was
 * reachable from this session). This is Claude Code's OWN vocabulary, never
 * this app's `PermissionMode` (`shared/types.ts`: 'normal'|'auto-accept'|
 * 'plan'|'auto'|'bypass') — the two are related but not the same strings, and
 * this file must classify what actually rides on the wire, not what the
 * StatusBar chip is labelled.
 *
 * Modes that behave like Edit/Write already does for a real file write
 * (Claude Code auto-accepts a native file edit with no ask): `acceptEdits`
 * is the direct match; `bypassPermissions` is included for defensiveness
 * even though Claude Code's own engine already skips firing this hook at all
 * for an ordinary tool under bypass (see the "PermissionRequest hook
 * timeout" cc-dependencies.md entry), so this branch is normally moot for
 * that mode, not load-bearing. `dontAsk`/`auto` are deliberately EXCLUDED:
 * neither is documented as an unconditional file-edit auto-accept the way
 * `acceptEdits` is (`auto` is a model classifier that can still deny;
 * `dontAsk` denies anything not pre-approved rather than approving it) —
 * this list only grows to a mode independently confirmed to already
 * auto-accept a real Edit/Write with no ask.
 */
const FRICTIONLESS_DOC_COMMENT_MODES = new Set(['acceptEdits', 'bypassPermissions']);

/**
 * §5.2a of the doc-comments build design (decided option 1, Destin "fine w
 * A"): a comment mutation aimed at a plain-text/markdown/code file only ever
 * touches the inert `.youcoded/comments/<path>.json` sidecar (never the
 * source file's own bytes) — internal app metadata, the same posture the
 * native tool surface gives it (`permissionSubject: () => undefined`,
 * doc-comments-tools.ts). It is auto-approved UNCONDITIONALLY here (unlike
 * every other category in this file, which only fires under bypass mode and
 * needs an explicit Advanced Settings override): the design's own intent is
 * that this case never prompts in ANY mode, not just bypass.
 *
 * A Word/Excel target writes the file's own XML/note bytes directly — the
 * goal is "the same tier as Edit/Write": auto-approved only when Claude
 * Code's OWN live permission mode is one that already auto-accepts a native
 * file edit (`FRICTIONLESS_DOC_COMMENT_MODES`, above), and asked ordinarily
 * otherwise — `'plan'` explicitly falls through to the ordinary ask (Claude
 * Code's own no-execution-in-plan-mode posture), and so does `'default'`, an
 * unrecognized future mode string, or `permissionMode` being absent
 * altogether (the hook payload's own base schema marks this field
 * `.optional()` — a caller-vetted YES is required, never assumed).
 * `permissionMode` reaches this function from the SAME PermissionRequest
 * hook payload `toolName`/`toolInput` already come from (main.ts reads
 * `event.payload.permission_mode`) — no new IPC, no new hook registration:
 * relay-blocking.js already forwards the CLI's whole hook JSON verbatim, and
 * hook-relay.ts's `parseHookPayload` already keeps the whole parsed object
 * as `event.payload`, so this field was already flowing through unused.
 *
 * `serverId` (adversarial review 2026-09-27, finding #2) is THIS session's
 * own randomly-generated `mcpServers` config key
 * (`deployClaudeCodeDocCommentsMcp`), looked up by `event.sessionId` in
 * main.ts — never a fixed, module-level, publicly-guessable string. Passing
 * `undefined` (a session main.ts has no record of yet, e.g. a hook arriving
 * before the attach event landed) fails CLOSED: nothing is matched, and the
 * call falls through to the ordinary ask, same as any other unrecognized
 * tool.
 */
export function shouldAutoApproveDocComment(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  permissionMode: string | undefined,
  serverId: string | undefined,
): boolean {
  if (!serverId) return false;
  if (!docCommentsMcpMutatorTools(serverId).includes(toolName)) return false;
  const path = toolInput?.path;
  if (typeof path !== 'string') return false;
  if (nativeFormatFor(path) === null) return true;
  return permissionMode !== undefined && FRICTIONLESS_DOC_COMMENT_MODES.has(permissionMode);
}

/** Should main answer this PermissionRequest "allow" without showing a card? */
export function shouldAutoApprove(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  overrides: PermissionOverrides,
): boolean {
  if (NEEDS_THE_USERS_OWN_ANSWER.has(toolName)) return false;
  const category = classifyPermission(toolName, toolInput);
  // Title hooks are always auto-approved (fire every few minutes)
  if (category === 'titleHook') return true;
  // Blanket approve-all override (restores old behavior)
  if (overrides.approveAll) return true;
  // Per-category overrides — approve if the user enabled this category
  return category !== 'unknown' && !!overrides[category];
}
