import type { PermissionOverrides } from '../shared/types';

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
