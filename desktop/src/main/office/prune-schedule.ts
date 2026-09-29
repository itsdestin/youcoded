// When the tidy-up of every kept Office version (versions.pruneAll: each file's rules, then 1 GB
// across all files) runs. WHY its own small scheduler: the 1 GB cap must hold while the app stays
// open, not only at startup, but pruneAll reads every kept file's index — so it runs a while
// after a snapshot, never on the save that caused it (off the hot path), requests while one is
// pending join it, and runs are spaced at least `minGapMs` apart.

export interface PruneScheduler {
  /** Ask for a run: `delayMs` from now, or later if the last run started under `minGapMs` ago.
   *  Does nothing while a run is already waiting. */
  request(): void;
}

export function createPruneScheduler(run: () => Promise<void>, opts: { delayMs: number; minGapMs: number }): PruneScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastStart = -Infinity;
  let running: Promise<void> = Promise.resolve();
  return {
    request() {
      if (timer) return;
      const wait = Math.max(opts.delayMs, lastStart + opts.minGapMs - Date.now());
      timer = setTimeout(() => {
        timer = null;
        // WHY chained: a very slow run (a huge versions folder) must not overlap the next one.
        running = running.then(async () => {
          lastStart = Date.now();
          await run().catch(() => {});
        });
      }, wait);
      // A pending tidy-up must never keep the app (or a test run) alive on its own.
      (timer as { unref?: () => void }).unref?.();
    },
  };
}
