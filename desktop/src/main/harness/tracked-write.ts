// Card #266: keep a write that is in flight where teardown can wait for it.
// WHY a helper: native-session-host.ts is at its line budget, and the set must never reject
// (destroy waits on it with Promise.all), while the caller still sees the real error.
export async function trackWrite(inFlight: Set<Promise<void>>, write: Promise<unknown>): Promise<void> {
  const settled = write.then(() => undefined, () => undefined);
  inFlight.add(settled);
  try { await write; } finally { inFlight.delete(settled); }
}
