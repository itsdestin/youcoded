// dev-types.ts — request/response shapes of the Settings → Development channels (dev:*).
//
// WHY (2026-09-30 one-core R3-2): these were written inline inside the window.claude type AND
// again inside main/dev-tools.ts, so a change to one could not fail the other. The channel
// table's rows (backend-contract.ts ChannelTypes) and the window.claude members now read this one
// file; dev-tools.ts keeps its own names for the same shapes and the compiler checks the handlers
// in main/ipc/dev.ts against these.
import type { DevIssueKind } from './types';

export interface DevSummarizeArgs { kind: DevIssueKind; description: string; log?: string }
export interface DevSummaryResult {
  title: string;
  summary: string;
  flagged_strings: string[];
  /** false = nothing rewrote the text; the fields are the user's own words (design review F17). */
  assisted?: boolean;
  /** Why the assistant did not run, when it did not. */
  unavailable?: string;
}

/** `summary` is optional: AI help is a separate choice (contract R12). `browserOnly` = finish in the browser (R13/R14). */
export interface DevSubmitArgs {
  kind: 'bug' | 'feature';
  title: string;
  summary?: string;
  description: string;
  log?: string;
  label: 'bug' | 'enhancement';
  browserOnly?: boolean;
}
export type DevSubmitResult =
  | { ok: true; url: string }
  | { ok: false; needsBrowser: true; fallbackUrl: string; truncated: boolean }
  | { ok: false; error: string; fallbackUrl: string };

export type DevInstallWorkspaceResult = { path: string; alreadyInstalled: boolean } | { error: string };
export type DevSetupWorkspaceResult = { ok: true; path: string } | { ok: false; error: string };
export interface DevSetupStatus { state: 'idle' | 'running' | 'ready' | 'failed'; path?: string; error?: string }
export interface DevOpenSessionInArgs { cwd: string; initialInput?: string }
