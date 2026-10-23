// refill-retry.ts — a phone's conversations that could not be refilled are tried again on their own (2026-10-22 phone reliability, cause 6).
//
// WHY: a refill that failed (it timed out over a slow link, the computer was frozen, the answer could not be applied) left the
// conversation as the phone had it, with "This conversation may be out of date" and a Refresh button — and nothing ever tried
// again until the person pressed it or the connection dropped. Live messages for that conversation could be missing meanwhile.
//
// Retries are FRESH fills (a whole new page): a failed catch-up may already have moved the phone's position past events it never
// applied, so asking for "what I missed" again could skip them. Bounded per round: after the last try the strip keeps offering
// Refresh. Paused while the page is hidden (performance.md rule 2). A new round (reconnect, Refresh) cancels this one.
export const REFILL_RETRY_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

export interface RefillRetryDeps {
  refill(sessionId: string): Promise<string>;
  /** Every conversation that had failed is now filled: the strip may say "Up to date". */
  healed(): void;
  hidden(): boolean;
  /** Call `cb` once when the page is next shown; returns a way to stop waiting. */
  whenVisible(cb: () => void): () => void;
}

export function createRefillRetry(deps: RefillRetryDeps) {
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopWaiting: (() => void) | null = null;

  const cancel = (): void => {
    generation++;
    if (timer) { clearTimeout(timer); timer = null; }
    if (stopWaiting) { stopWaiting(); stopWaiting = null; }
  };

  const schedule = (failed: string[], attempt: number, gen: number): void => {
    if (attempt >= REFILL_RETRY_MS.length) return; // out of tries: Refresh stays on the strip
    timer = setTimeout(() => {
      timer = null;
      const run = async () => {
        if (gen !== generation) return;
        const outcomes = await Promise.all(failed.map((id) => deps.refill(id)));
        if (gen !== generation) return;
        const still = failed.filter((_, i) => outcomes[i] !== 'ok');
        if (still.length === 0) deps.healed();
        else schedule(still, attempt + 1, gen);
      };
      if (deps.hidden()) stopWaiting = deps.whenVisible(() => { stopWaiting = null; void run(); });
      else void run();
    }, REFILL_RETRY_MS[attempt]);
  };

  return {
    /** A round of fills ended: try again the ones that failed. Replaces any retry still pending. */
    start(ids: string[], outcomes: string[]): void {
      cancel();
      const failed = ids.filter((_, i) => outcomes[i] !== 'ok');
      if (failed.length > 0) schedule(failed, 0, generation);
    },
    cancel,
  };
}
