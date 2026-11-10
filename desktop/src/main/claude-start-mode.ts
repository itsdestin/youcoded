// Which permission mode a new Claude Code session starts in, and what the mode badge shows from the first moment.
//
// WHY (Destin, 2026-11-09 final review Q-8 / F-7: "should always start in auto for claude code ... unless i toggle
// bypass permissions"): the app used to start Claude Code without naming a mode and GUESS "normal" for the badge,
// then correct it when Claude Code drew its footer. A session that really started in auto showed NORMAL and flipped
// (an earlier fix hid the badge for six seconds instead). The app now tells Claude Code which mode to start in,
// so the badge is a fact from the start, not a guess.
//
// Three cases, in order:
//  1. "Skip permissions" is on                  -> bypass (the existing flag).
//  2. The person set their own default in Claude Code's settings (permissions.defaultMode) -> leave it to
//     Claude Code and show that mode. WHY: a start option outranks the settings file, so naming auto here
//     would silently override a choice they made on purpose (e.g. always start in plan mode).
//  3. Otherwise                                  -> auto, named explicitly.
//
// If the account or model cannot use auto, Claude Code falls back to its plain mode and prints a notice
// ("auto mode is unavailable for your plan"); shared/permission-mode-detect.ts reads that and corrects the badge.
import { getField, readProjectDefaultMode } from './claude-settings';
import type { PermissionMode } from '../shared/types';

/** Claude Code's own names for its modes -> the badge's names. */
const BADGE_FOR_CC_MODE: Record<string, PermissionMode> = {
  default: 'normal', manual: 'normal', dontAsk: 'normal',
  acceptEdits: 'auto-accept', plan: 'plan', auto: 'auto', bypassPermissions: 'bypass',
};

export interface ClaudeStartMode { args: string[]; badge: PermissionMode }

export function claudeStartMode(skipPermissions: boolean, userDefaultMode: unknown): ClaudeStartMode {
  if (skipPermissions) return { args: ['--dangerously-skip-permissions'], badge: 'bypass' };
  const own = typeof userDefaultMode === 'string' ? BADGE_FOR_CC_MODE[userDefaultMode] : undefined;
  if (own) return { args: [], badge: own };
  return { args: ['--permission-mode', 'auto'], badge: 'auto' };
}

// A default mode set for ONE FOLDER (its .claude/settings.local.json, then .claude/settings.json), remembered per folder.
// WHY (independent review, 2026-11-10): only the person's own settings file was read, so a project that sets its own
// default (say, always plan mode in this repo) was silently outranked by the "auto" start option: the very override
// case 2 above exists to avoid. Remembered for the same reason as the person's own default below: starting a session
// must not stop to read a file. The session-create request reads it first (ipc-handlers.ts), and it is refreshed after
// every start; a start that arrives another way before any read falls back to the person's default.
const projectModes = new Map<string, unknown>();

export function projectDefaultMode(cwd: string | undefined): unknown { return cwd ? projectModes.get(cwd) : undefined; }

export async function refreshProjectDefaultMode(cwd: string | undefined): Promise<void> {
  if (!cwd) return;
  try { projectModes.set(cwd, await readProjectDefaultMode(cwd)); } catch { /* keep the last known value */ }
}

// The person's own permissions.defaultMode, remembered. WHY remembered: starting a session must not stop to
// read a file (the main process's no-blocking-reads rule), and settings.json has one reader (claude-settings.ts),
// which is asynchronous. It is refreshed when the app starts and again after every session start, so a change
// made in Claude Code's settings applies from the next session.
let rememberedDefaultMode: unknown;

export function userDefaultMode(): unknown { return rememberedDefaultMode; }

export async function refreshUserDefaultMode(): Promise<void> {
  try { rememberedDefaultMode = await getField('permissions.defaultMode'); } catch { /* keep the last known value */ }
}
