import path from 'path';
import { createRequire } from 'module';
import { mutateSettings, type MutateSettingsResult } from './claude-settings';
import { reconcileHooksInto, type ReconcileHooksResult } from './hook-reconciler';
import { applyPromptSuggestionDisabled, type EnforcePromptSuggestionResult } from './disable-prompt-suggestion';
import { seedCleanupPeriodInto, type SeedRetentionResult } from './retention-default';

// The launch chores that edit ~/.claude/settings.json, composed for main.ts.
//
// WHY (2026-09-16 audit W3 + W4 + D5): at every launch the app used to copy
// its hook scripts over themselves and then rewrite settings.json four times
// through four private readers and writers, whether or not anything changed.
// Now install-hooks is one locked read/compare/write, and the three chores
// that follow it — plugin-hook reconcile, prompt-suggestion off, retention
// default — are three callbacks in ONE further cycle, in the order main.ts has
// always run them. They cannot join the first cycle: legacy-cleanup.ts (which
// deletes the youcoded-core clone the reconciler then prunes hooks for) and
// the hook relay start sit between install-hooks and the reconciler, and that
// order is load-bearing (install-hooks must win the relay entries; the
// reconciler must see the clone already gone). main.ts keeps its perf marks
// where they were; the two chores that now ride the second cycle measure
// nothing on their own, which is the point.

// install-hooks.js is plain CommonJS under scripts/ (packaged as-is, outside
// src) — resolved the way main.ts always resolved it, relative to dist/main.
const installHooksScript = path.join(__dirname, '../../scripts/install-hooks.js');

interface InstallHooksModule {
  isWorktreeSource(): boolean;
  stageHookScripts(opts: { stamp: string }): { hookDir: string; copied: boolean };
  applyAppHooks(settings: Record<string, unknown>, hookDir: string): { repaired: number };
  deployAutoTitleInstruction(): void;
}

function loadInstallHooks(): InstallHooksModule {
  return createRequire(__filename)(installHooksScript) as InstallHooksModule;
}

export interface InstallHooksChoreResult extends Omit<MutateSettingsResult, 'repaired'> {
  /** The hook scripts were copied into the stable dir (stamp mismatch or first launch). */
  copied: boolean;
  /** App-owned entries whose command pointed elsewhere and were repaired. */
  repaired: number;
  /** settings.json did not parse and was backed up to `backupPath` before the
   *  fresh write (claude-settings.ts's rule) — a different repair from the one above. */
  repairedFile?: MutateSettingsResult['repaired'];
  /** Skipped entirely: the bundled scripts live inside a dev worktree. */
  skippedWorktree?: boolean;
}

/** Stage the app's hook scripts (skipped when this build already staged them)
 *  and point settings.json's app-owned hooks at them — one locked cycle. */
export async function runInstallHooksChore(build: { version: string; packaged: boolean }): Promise<InstallHooksChoreResult> {
  const ih = loadInstallHooks();
  if (ih.isWorktreeSource()) return { written: false, copied: false, repaired: 0, skippedWorktree: true };
  const { hookDir, copied } = ih.stageHookScripts({ stamp: `${build.version}|${build.packaged ? 'packaged' : 'dev'}` });
  let repaired = 0;
  const { repaired: repairedFile, ...r } = await mutateSettings((settings) => { repaired = ih.applyAppHooks(settings, hookDir).repaired; });
  ih.deployAutoTitleInstruction();
  return { ...r, copied, repaired, ...(repairedFile ? { repairedFile } : {}) };
}

export interface SettingsChoresResult extends MutateSettingsResult {
  hooks: ReconcileHooksResult;
  promptSuggestion: EnforcePromptSuggestionResult;
  retention: SeedRetentionResult;
}

/** Plugin-hook reconcile, prompt-suggestion off, retention default: three
 *  callbacks, one locked cycle, in that order. */
export async function runSettingsChores(): Promise<SettingsChoresResult> {
  let hooks: ReconcileHooksResult = { added: 0, updatedPath: 0, updatedTimeout: 0, pruned: 0, manifestCount: 0 };
  let promptSuggestion: EnforcePromptSuggestionResult = { changed: false, prior: undefined };
  let retention: SeedRetentionResult = { changed: false, effective: undefined };
  const r = await mutateSettings((settings) => {
    hooks = reconcileHooksInto(settings);
    promptSuggestion = applyPromptSuggestionDisabled(settings);
    retention = seedCleanupPeriodInto(settings);
  });
  if (r.refused) {
    // The lock could not be taken, so nothing landed; report each chore as
    // unchanged rather than as done — including the reconciler's counts, or
    // main.ts logs "reconciled {added:N}" for a write that never reached the
    // file. (A repaired file is the opposite case: everything above DID land,
    // in a fresh file — `r.repaired` names the backup.)
    hooks = { added: 0, updatedPath: 0, updatedTimeout: 0, pruned: 0, manifestCount: hooks.manifestCount };
    promptSuggestion = { changed: false, prior: promptSuggestion.prior };
    retention = { changed: false, effective: undefined };
  }
  return { ...r, hooks, promptSuggestion, retention };
}
