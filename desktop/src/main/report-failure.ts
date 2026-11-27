import { log } from './logger';

// The behind-the-scenes twin of renderer/utils/report-failure.ts (R-1, Destin 2026-11-18).
//
// WHY: main-process code used `catch {}` for failures that matter for diagnosis. This writes the REAL cause
// to ~/.claude/desktop.log (which feeds bug reports) and nothing is shown to the person; a handler that
// needs the person told returns the failure to the screen, which words it with the renderer helper. A
// main-to-window pop-up channel is deliberately NOT here yet: no batch-1 failure needs one, and a new
// channel needs desktop/Android/remote parity (.claude/rules/ipc-bridge.md).
const DEDUPE_MS = 30_000;
const lastLogged = new Map<string, number>();

export function reportFailure(r: { what: string; cause?: unknown; where: string }): void {
  const key = `${r.where}|${r.what}`;
  const now = Date.now();
  if ((lastLogged.get(key) ?? -Infinity) > now - DEDUPE_MS) return;
  lastLogged.set(key, now);
  const msg = r.cause instanceof Error ? r.cause.message : typeof r.cause === 'string' ? r.cause : undefined;
  log('WARN', r.where, `couldn't ${r.what}`, msg ? { cause: msg } : undefined);
}

/** Tests only. */
export function resetFailureDedupeForTests(): void { lastLogged.clear(); }
