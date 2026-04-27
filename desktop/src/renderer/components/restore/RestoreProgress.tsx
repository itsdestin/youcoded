import React, { useEffect, useRef, useState } from 'react';
import type { RestoreCategory, RestoreProgressEvent } from '../../../shared/types';

// Subscribes to main-process restore:progress events and renders a global
// aggregate progress bar (0-100%) plus per-category rows. When every category
// has reached phase='done' we fire onAllDone so the parent wizard advances.
//
// The bar uses a target→display smoother ported from Android's SetupScreen.kt
// installer progress. Merge mode has no per-file stats from rclone, so Kotlin/
// TS emit discrete phase checkpoints (0 → 65 → 100). Between checkpoints the
// display creeps toward a phase-specific ceiling (fetching caps at 60%,
// swapping at 95%) so the bar never looks frozen during the silent 5-15 min
// pull. Without this, users see 0% for 10 minutes and assume the app hung.

type Props = {
  categories: RestoreCategory[];
  onAllDone?: () => void;
};

const PHASE_LABEL: Record<RestoreProgressEvent['phase'], string> = {
  snapshotting: 'Taking safety snapshot',
  fetching: 'Downloading',
  staging: 'Staging',
  swapping: 'Applying',
  done: 'Done',
  error: 'Failed',
};

// Creep ceiling per phase — display bar crawls up to this between backend
// events so progress feels alive, but never overshoots the next real checkpoint.
// Values chosen to sit a few % under the next discrete emit (fetching→65,
// swapping→100, etc.) with visible headroom so the handoff doesn't stutter.
const PHASE_CEIL: Record<RestoreProgressEvent['phase'], number> = {
  snapshotting: 0.15,
  fetching: 0.60,
  staging: 0.75,
  swapping: 0.95,
  done: 1.0,
  error: 0.0,
};

type State = Record<string, RestoreProgressEvent>;

export function RestoreProgress({ categories, onAllDone }: Props) {
  const [state, setState] = useState<State>({});
  // displayPct tracked per-category as 0-1 float. Ref + tick counter to
  // animate at 20fps without re-subscribing to events. Ticking state below
  // triggers the re-render; the ref holds the authoritative values.
  const displayRef = useRef<Record<string, number>>({});
  const [, setTick] = useState(0);
  // Track whether we've already announced "all done" to avoid re-firing.
  // Errors are surfaced by the wizard via the restore.execute() rejection —
  // phase='error' here just paints the bar red for the brief window before
  // the wizard unmounts this component and flips to its error step.
  const firedDoneRef = useRef(false);

  useEffect(() => {
    // onProgress returns an unsub fn — wiring it here means the cleanup runs
    // on unmount. Leaking listeners across restore attempts would cause the
    // next restore to double-report progress.
    // @ts-ignore window.claude is contextBridge-provided
    const unsub: () => void = window.claude.sync.restore.onProgress((evt: RestoreProgressEvent) => {
      setState((prev) => ({ ...prev, [evt.category]: evt }));
    });
    return () => {
      unsub?.();
    };
  }, []);

  // Target→display smoother: 20fps tick. Ported from SetupScreen.kt lines 75-91.
  // Close 12% of the remaining gap per tick when catching up to a new target;
  // creep 0.1% of remaining room toward the phase ceiling otherwise. Keeps the
  // bar visibly alive during multi-minute silent operations.
  useEffect(() => {
    const timer = setInterval(() => {
      let changed = false;
      for (const cat of categories) {
        const evt = state[cat];
        const phase = evt?.phase ?? 'fetching';
        const target = evt && evt.filesTotal > 0
          ? Math.min(1, evt.filesDone / evt.filesTotal)
          : (phase === 'done' ? 1 : 0);
        const ceil = PHASE_CEIL[phase] ?? 0;
        const current = displayRef.current[cat] ?? 0;

        if (phase === 'error') {
          // Freeze the bar where it is — don't advance, don't creep.
          continue;
        }

        // Creep is scoped to merge mode's sentinel emits (filesTotal === 100
        // with discrete checkpoint values). Wipe mode has real file counts
        // (filesTotal = actual file count from rclone/adapter), so creeping
        // past the real progress would lie to the user.
        const isSentinel = evt != null && evt.filesTotal === 100;

        let next = current;
        if (current < target) {
          const step = Math.max((target - current) * 0.12, 0.002);
          next = Math.min(current + step, target);
        } else if (isSentinel && current < ceil) {
          // Bootstrap-safe creep: SetupScreen.kt gates on current >= 0.001f
          // because it always seeds non-zero targets; merge restore seeds
          // target=0 so we'd never start creeping. Drop the lower bound so
          // the bar leaves 0% as soon as the first 'fetching' event arrives.
          const remaining = ceil - current;
          const creep = Math.max(remaining * 0.001, 0.0002);
          next = Math.min(current + creep, ceil);
        }

        if (next !== current) {
          displayRef.current[cat] = next;
          changed = true;
        }
      }
      if (changed) setTick((t) => t + 1);
    }, 50);
    return () => clearInterval(timer);
  }, [categories, state]);

  // Fire onAllDone once every category reaches phase='done'.
  useEffect(() => {
    if (firedDoneRef.current) return;
    const allDone =
      categories.length > 0 &&
      categories.every((c) => state[c]?.phase === 'done');
    if (allDone) {
      firedDoneRef.current = true;
      onAllDone?.();
    }
  }, [state, categories, onAllDone]);

  // Global aggregate: average of all per-category display values.
  // For merge the categories move in lockstep so this is just "the progress";
  // for wipe it's a meaningful aggregate across the independent category bars.
  const globalPct = categories.length > 0
    ? Math.round(
        (categories.reduce((sum, c) => sum + (displayRef.current[c] ?? 0), 0) / categories.length) * 100
      )
    : 0;

  // Global phase label: show the dominant in-progress phase, or 'Downloading'
  // as a default. Priority: error > snapshotting > fetching > staging > swapping > done.
  const phasePriority: RestoreProgressEvent['phase'][] = ['error', 'snapshotting', 'fetching', 'staging', 'swapping', 'done'];
  const globalPhase = phasePriority.find((p) =>
    categories.some((c) => state[c]?.phase === p)
  ) ?? 'fetching';
  const hasError = globalPhase === 'error';

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="text-sm font-medium text-fg">
          {hasError ? 'Restore failed' : 'Restoring…'}
        </div>
        <div className="text-[11px] text-fg-dim mt-0.5">
          {hasError
            ? 'See details below.'
            : "Please don't close the app until this finishes."}
        </div>
      </div>

      {/* Global aggregate bar. Primary progress signal for merge mode. */}
      <div className="rounded-md border border-edge bg-inset/60 px-3 py-2.5">
        <div className="flex items-center justify-between text-xs mb-2">
          <span className="text-fg font-medium">{PHASE_LABEL[globalPhase]}</span>
          <span className="text-fg-dim tabular-nums">{globalPct}%</span>
        </div>
        <div className="h-2 rounded-full bg-inset overflow-hidden">
          <div
            className={`h-full transition-all duration-75 ${hasError ? 'bg-destructive' : 'bg-accent'}`}
            style={{ width: `${globalPct}%` }}
          />
        </div>
      </div>

      {/* Per-category detail rows — subsidiary to the global bar for merge,
          meaningful independent bars for wipe. */}
      <div className="flex flex-col gap-2">
        {categories.map((cat) => {
          const evt = state[cat];
          const phase = evt?.phase ?? 'fetching';
          const pct = Math.round((displayRef.current[cat] ?? 0) * 100);
          return (
            <div key={cat} className="rounded-md border border-edge-dim bg-inset/40 px-3 py-2">
              <div className="flex items-center justify-between text-[11px] mb-1.5">
                <span className="text-fg capitalize font-medium">{cat}</span>
                <span className="text-fg-dim">
                  {PHASE_LABEL[phase]}
                  {evt && evt.filesTotal > 0 && phase !== 'done' && phase !== 'error' && evt.filesTotal !== 100 && (
                    <> — {evt.filesDone}/{evt.filesTotal}</>
                  )}
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-inset overflow-hidden">
                <div
                  className={`h-full transition-all duration-75 ${phase === 'error' ? 'bg-destructive' : 'bg-accent'}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              {evt?.currentFile && phase !== 'done' && phase !== 'error' && (
                <div className="text-[10px] text-fg-muted mt-1 truncate">{evt.currentFile}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
