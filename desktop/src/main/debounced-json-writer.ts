// debounced-json-writer.ts — save a small JSON file after a burst of changes settles, off the main thread.
//
// WHY (2026-10-22 freeze hunt): the buddy window saved its position with a writeFileSync on EVERY
// move event while being dragged — dozens of blocking disk writes a second, each able to stall the
// whole app for seconds on a nearly-full btrfs disk. Now a burst of moves schedules ONE async,
// atomic write ~500 ms after the last one, and `flush()` (called on quit) writes any pending change
// immediately so the last position is never lost.
import { atomicWrite } from './atomic-write';

export interface DebouncedJsonWriter {
  /** Note that `getValue()` has changed; it is read when the write actually happens, so the file
   *  always gets the latest state, not the state at the time of the call. */
  schedule(): void;
  /** Write now if a change is pending, and wait for any write in flight. Never rejects. */
  flush(): Promise<void>;
}

export function createDebouncedJsonWriter(opts: {
  file: string;
  getValue: () => unknown;
  delayMs?: number;
  /** Serializer; defaults to compact JSON (the buddy file's existing on-disk shape). */
  serialize?: (v: unknown) => string;
}): DebouncedJsonWriter {
  const delay = opts.delayMs ?? 500;
  const serialize = opts.serialize ?? ((v) => JSON.stringify(v));
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;
  // Writes run one at a time so an older write can never land after a newer one.
  let inFlight: Promise<void> = Promise.resolve();

  const writeNow = (): Promise<void> => {
    timer = null;
    if (!dirty) return inFlight;
    dirty = false;
    // Capture the text now (sync, cheap) so the file matches the moment we decided to write.
    const text = serialize(opts.getValue());
    inFlight = inFlight.then(() => atomicWrite(opts.file, text)).catch(() => { /* best effort, as before */ });
    return inFlight;
  };

  return {
    schedule() {
      dirty = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void writeNow(); }, delay);
      // A pending save must not keep the process alive; quit calls flush() explicitly.
      (timer as any).unref?.();
    },
    async flush() {
      if (timer) clearTimeout(timer);
      await writeNow();
      await inFlight;
    },
  };
}
