import { mutateSettings } from './claude-settings';

// Force `promptSuggestionEnabled: false` in the user's ~/.claude/settings.json
// at every app launch. Claude Code 2.1.x ships an opt-out next-prompt
// suggestion (system prompt: "[SUGGESTION MODE: Suggest what the user might
// naturally type next into Claude Code.]") that pre-fills ghost text into the
// input bar. The interaction is buggy in YouCoded — our chat→PTY write path
// streams body bytes + `\r` directly without clearing CC's input buffer, so
// suggestion ghost text gets concatenated with the user's chat send and
// submitted as one combined user prompt. Re-enable here only if/when the
// underlying interaction is fixed.
//
// WHY the split (2026-09-16 audit D5/W4): applyPromptSuggestionDisabled()
// edits a settings object in place so the launch path can run it as one
// callback in a single locked read/write of settings.json; the file itself
// is only ever read and written by claude-settings.ts. An unparseable
// settings.json is backed up beside itself before the fresh write — see that
// module's header for the one rule every writer now follows.

export interface EnforcePromptSuggestionResult {
  /** True iff the value didn't match and was set. */
  changed: boolean;
  /** The value before this call. `undefined` when the key was absent (CC's
   *  default is `enabled`, so absent === enabled from CC's perspective). */
  prior: boolean | undefined;
}

export function applyPromptSuggestionDisabled(settings: Record<string, unknown>): EnforcePromptSuggestionResult {
  const prior = settings.promptSuggestionEnabled as boolean | undefined;
  if (prior === false) return { changed: false, prior };
  settings.promptSuggestionEnabled = false;
  return { changed: true, prior };
}

/** Standalone form: one locked read/write cycle of settings.json. */
export async function enforcePromptSuggestionDisabled(): Promise<EnforcePromptSuggestionResult> {
  let result: EnforcePromptSuggestionResult = { changed: false, prior: undefined };
  const r = await mutateSettings((settings) => { result = applyPromptSuggestionDisabled(settings); });
  return r.refused ? { changed: false, prior: result.prior } : result;
}
