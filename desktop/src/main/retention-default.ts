import { mutateSettings } from './claude-settings';

// Seed `cleanupPeriodDays` into ~/.claude/settings.json when the key is
// ABSENT. Claude Code deletes transcript JSONLs whose age exceeds
// cleanupPeriodDays, and its built-in default is 30 days — which silently
// destroys YouCoded's Resume Browser history (2026-06-12 investigation: 221
// named conversations deleted locally). YouCoded is a chat app; users expect
// history to persist, so we seed a year.
//
// Unlike disable-prompt-suggestion.ts (force-overwrites every launch), this
// only writes when the key is missing: an explicit user value — even a
// deliberately short one — is respected.
//
// This file used to refuse to touch a settings.json that does not parse
// ("replacing a corrupt file with just our key would wipe the hooks"). The
// 2026-09-16 simplification (audit D5) moved every read and write into
// claude-settings.ts, and on 2026-09-17 Destin decided its ONE rule: a corrupt
// file is backed up beside itself and rewritten fresh, because silent hook
// loss is worse than a lost custom key and the backup keeps the key
// recoverable. seedCleanupPeriodInto() edits a settings object in place so the
// launch path can run it as one callback in a single locked read/write
// alongside the other launch chores.
//
// CC-coupled: `cleanupPeriodDays` is a Claude Code settings contract. See
// youcoded/docs/cc-dependencies.md → "Transcript retention (cleanupPeriodDays)".

const DEFAULT_CLEANUP_PERIOD_DAYS = 365;

export interface SeedRetentionResult {
  /** True iff the key was absent and has been set. */
  changed: boolean;
  /** The value now in effect, or undefined if settings were unwritable. */
  effective: number | undefined;
}

export function seedCleanupPeriodInto(settings: Record<string, unknown>): SeedRetentionResult {
  if (typeof settings.cleanupPeriodDays === 'number') {
    return { changed: false, effective: settings.cleanupPeriodDays };
  }
  settings.cleanupPeriodDays = DEFAULT_CLEANUP_PERIOD_DAYS;
  return { changed: true, effective: DEFAULT_CLEANUP_PERIOD_DAYS };
}

/** Standalone form: one locked read/write cycle of settings.json. */
export async function seedCleanupPeriodDefault(): Promise<SeedRetentionResult> {
  let result: SeedRetentionResult = { changed: false, effective: undefined };
  const r = await mutateSettings((settings) => { result = seedCleanupPeriodInto(settings); });
  return r.refused ? { changed: false, effective: undefined } : result;
}
