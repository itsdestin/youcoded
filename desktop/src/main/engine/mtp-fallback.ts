// The safety net under MTP drafting (review deck 2 Q-4, Destin 2026-11-12).
//
// WHY: MTP drafting is switched on for every dense model whose file carries the
// extra heads, but it was measured on ONE machine (Strix Halo, 2026-11-08). It
// needs a second context beside the model's own, and its extra memory is not in
// the fit estimate — so on another card it can be the thing that stops a model
// loading. Before this, such a model simply failed, every time, with no way out
// but finding the Speculative decoding switch. Forcing MTP on a file without
// heads on an RTX 4070 SUPER (2026-11-12) showed the shape of that failure: the
// model's process exits and the router answers the load with an error.
//
// What happens now: the FIRST failed load of a model that has MTP on is not
// reported. The model is loaded once more without MTP.
//   - It loads  → MTP was the cause. That is remembered for this model on this
//                 computer (`noMtp` in its settings), so it never fails again.
//   - It fails  → MTP was not the cause. MTP is put back, and the failure is
//                 reported exactly as it always was.
// A load that could not be asked at all (engine unreachable) is never retried
// here: that says nothing about the model.

export interface MtpFallbackDeps {
  /** Is MTP drafting on for this model right now? */
  hasMtp(modelId: string): boolean;
  /** Rewrite the engine's settings with this model excluded (see `excluded`),
   *  make the engine re-read them, and ask for the model again. */
  reloadWithoutMtp(modelId: string): Promise<void>;
  /** Persist "no MTP for this model on this computer". */
  remember(modelId: string): Promise<void>;
  /** Put MTP back into the engine's settings (the retry failed too). */
  restore(modelId: string): Promise<void>;
}

export class MtpFallback {
  private retrying = new Set<string>();
  constructor(private deps: MtpFallbackDeps) {}

  /** Models that must be left out of MTP while their retry is running. */
  excluded(modelId: string): boolean { return this.retrying.has(modelId); }

  /** Called with every load result. Returns true when the result was TAKEN
   *  OVER (a retry without MTP has started), so the caller must not record it
   *  as the model's error. `answered` = the engine itself replied. */
  onLoadResult(modelId: string, ok: boolean, answered: boolean): boolean {
    if (this.retrying.has(modelId)) {
      // The retry's own result. Whatever it was, the caller reports it.
      const done = () => { this.retrying.delete(modelId); };
      // Remember BEFORE the exclusion ends, or a settings rewrite in between
      // would turn MTP straight back on.
      if (ok) void this.deps.remember(modelId).catch(() => {}).then(done);
      else { done(); void this.deps.restore(modelId).catch(() => {}); }
      return false;
    }
    if (ok || !answered || !this.deps.hasMtp(modelId)) return false;
    this.retrying.add(modelId);
    void this.deps.reloadWithoutMtp(modelId).catch(() => {
      // The retry could not even be started: stop excluding, MTP stays as it was.
      this.retrying.delete(modelId);
    });
    return true;
  }
}
