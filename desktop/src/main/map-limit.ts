// map-limit.ts — run an async function over a list with at most `limit` calls in flight.
//
// WHY (2026-10-22 freeze hunt): several main-process loops stat/read one file per item (thousands in
// one materialize sweep). Making each call async fixes the freeze, but firing them all at once would
// queue thousands of requests on libuv's small thread pool and starve every other async fs call.
// A bounded pool keeps them flowing a few at a time. Results come back in INPUT order, so a caller
// that used to loop sequentially sees the same ordering.
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}
