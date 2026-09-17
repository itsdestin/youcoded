/**
 * One async chain per file path, so two tool calls on the SAME file never
 * interleave their read-check-write.
 *
 * WHY (2026-09-16 smoothness sweep, C4): Edit and Write are "read the bytes,
 * compare their fingerprint to what the model last saw, then write". With
 * synchronous fs that sequence was atomic on the event loop for free. Moving
 * the reads and writes onto fs.promises (so a big file no longer freezes every
 * window) opens a gap between the check and the write, and a model that runs
 * two edits of one file in parallel could have both pass the check and the
 * second silently overwrite the first. Serialising per canonical path closes
 * the gap; different files still run concurrently.
 *
 * Same shape as the lease client's per-session chain: the chain entry is
 * dropped once its last operation settles, so the map cannot grow.
 */
const chains = new Map<string, Promise<unknown>>();

export function withPathLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(key, next);
  void next.then(
    () => { if (chains.get(key) === next) chains.delete(key); },
    () => { if (chains.get(key) === next) chains.delete(key); },
  );
  return next;
}

/** Test-only: how many paths currently hold a chain. */
export function __pathLocksHeld(): number {
  return chains.size;
}
