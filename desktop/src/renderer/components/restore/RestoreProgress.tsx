import React, { useEffect, useRef, useState } from 'react';
import type { RestoreCategory, RestoreProgressEvent } from '../../../shared/types';

// Subscribes to main-process restore:progress events and renders a per-category
// progress bar with phase label. When every category has reached phase='done'
// we fire onAllDone so the parent wizard can advance to the summary step.

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
};

type State = Record<string, RestoreProgressEvent>;

export function RestoreProgress({ categories, onAllDone }: Props) {
  const [state, setState] = useState<State>({});
  // Track whether we've already announced "all done" to avoid double-firing.
  const firedDoneRef = useRef(false);

  useEffect(() => {
    // onProgress returns an unsub fn — wiring it here means the cleanup
    // runs on unmount, which is critical: leaking listeners across restore
    // attempts would cause the next restore to double-report progress.
    // @ts-ignore window.claude is contextBridge-provided
    const unsub: () => void = window.claude.sync.restore.onProgress((evt: RestoreProgressEvent) => {
      setState((prev) => ({ ...prev, [evt.category]: evt }));
    });
    return () => {
      unsub?.();
    };
  }, []);

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

  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="text-sm font-medium text-fg">Restoring…</div>
        <div className="text-[11px] text-fg-dim mt-0.5">
          Please don't close the app until this finishes.
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {categories.map((cat) => {
          const evt = state[cat];
          const phase = evt?.phase ?? 'fetching';
          const pct =
            evt && evt.filesTotal > 0
              ? Math.min(100, Math.round((evt.filesDone / evt.filesTotal) * 100))
              : phase === 'done'
                ? 100
                : 0;
          return (
            <div key={cat} className="rounded-md border border-edge-dim bg-inset/40 px-3 py-2">
              <div className="flex items-center justify-between text-[11px] mb-1.5">
                <span className="text-fg capitalize font-medium">{cat}</span>
                <span className="text-fg-dim">
                  {PHASE_LABEL[phase]}
                  {evt && evt.filesTotal > 0 && phase !== 'done' && (
                    <> — {evt.filesDone}/{evt.filesTotal}</>
                  )}
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-inset overflow-hidden">
                <div
                  className="h-full bg-accent transition-all duration-200"
                  style={{ width: `${pct}%` }}
                />
              </div>
              {evt?.currentFile && phase !== 'done' && (
                <div className="text-[10px] text-fg-muted mt-1 truncate">{evt.currentFile}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
