import { useEffect, useState } from 'react';
import type { ToolCallState } from '../../../shared/types';

/** "Working in the background · 2m 14s" / "Finished in 4m · 5 steps" — the
 *  one line that answers "is it done?" without opening anything. Ticks once a
 *  second only while running. */
export function RunStatusLine({ run, report, elapsedUnknown = false }: {
  run: NonNullable<ToolCallState['specialistRun']>;
  report?: ToolCallState['specialistReport'];
  /** No clock exists for this helper, so the line must not state one. Set for a
   *  Claude Code subagent whose card has not yet received a timestamped segment
   *  (useSpecialists.ts ccRunFromCard) — `Date.now() - 0` would read "56y 3m",
   *  and the status bar's rule is that a value we do not have renders nothing
   *  rather than a fabricated one. */
  elapsedUnknown?: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (run.status !== 'running' || elapsedUnknown) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [run.status, elapsedUnknown]);
  const end = run.endedAt ?? now;
  const elapsed = formatElapsed(Math.max(0, end - run.startedAt));
  const steps = run.steps !== undefined ? ` · ${run.steps} step${run.steps === 1 ? '' : 's'}` : '';
  // Every phrase below reads "<verb> <preposition> <elapsed>"; with no clock,
  // the preposition has to go too or the sentence dangles ("Finished in").
  const after = elapsedUnknown ? '' : ` after ${elapsed}`;
  let text: string;
  let tone = 'text-fg-muted';
  if (run.status === 'running') {
    const working = run.background ? 'Working in the background' : 'Working';
    text = `${working}${elapsedUnknown ? '' : ` · ${elapsed}`}${run.stale ? ' · no activity for a while — may be stuck' : ''}`;
    if (run.stale) tone = 'text-amber-500';
  } else if (run.status === 'completed') {
    text = report?.status === 'failed'
      ? `Failed${after}${steps}`
      : `Finished${elapsedUnknown ? '' : ` in ${elapsed}`}${steps}`;
    // Fix: `danger` isn't a real token (no --color-danger in globals.css), so this
    // line rendered in plain body color instead of red on failure. `destructive-fg`
    // is the app's real error/destructive text token.
    if (report?.status === 'failed') tone = 'text-destructive-fg';
  } else if (run.status === 'failed') {
    text = `Failed${after}${steps}`;
    tone = 'text-destructive-fg';
  } else {
    text = `Stopped${after}${steps} — the assistant can pick this back up`;
  }
  return <div className={`text-xs ${tone}`} data-testid="specialist-status-line">{text}</div>;
}

export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

