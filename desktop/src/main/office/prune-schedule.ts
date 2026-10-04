// When the tidy-up of every kept Office version (versions.pruneAll: each file's rules, then 1 GB
// across all files) runs. WHY its own small scheduler: the 1 GB cap must hold while the app stays
// open, not only at startup, but pruneAll reads every kept file's index — so it runs a while
// after a snapshot, never on the save that caused it (off the hot path), requests while one is
// pending join it, and runs are spaced at least `minGapMs` apart.

export interface PruneScheduler {
  /** Ask for a run: `delayMs` from now, or later if the last run started under `minGapMs` ago.
   *  Does nothing while a run is already waiting. */
  request(): void;
  /** Drop a waiting run (a re-register, or quit). A run already going finishes. */
  cancel(): void;
}

// Every scheduler not yet cancelled, so quit can stop them all (cancelAllPruning).
const live = new Set<PruneScheduler>();
/** Quit: no tidy-up may start while the app is shutting down. */
export function cancelAllPruning(): void {
  for (const p of [...live]) p.cancel();
}

export function createPruneScheduler(run: () => Promise<void>, opts: { delayMs: number; minGapMs: number }): PruneScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastStart = -Infinity;
  let running: Promise<void> = Promise.resolve();
  let cancelled = false;
  const self: PruneScheduler = {
    cancel() {
      cancelled = true;
      live.delete(self);
      if (timer) { clearTimeout(timer); timer = null; }
    },
    request() {
      if (timer || cancelled) return;
      const wait = Math.max(opts.delayMs, lastStart + opts.minGapMs - Date.now());
      timer = setTimeout(() => {
        timer = null;
        // WHY chained: a very slow run (a huge versions folder) must not overlap the next one.
        running = running.then(async () => {
          if (cancelled) return;
          lastStart = Date.now();
          await run().catch(() => {});
        });
      }, wait);
      // A pending tidy-up must never keep the app (or a test run) alive on its own.
      (timer as { unref?: () => void }).unref?.();
    },
  };
  live.add(self);
  return self;
}
