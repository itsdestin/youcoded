// One running job answers every identical request made while it runs.
//
// WHY (2026-09-26): the Resume list was scanned twice at once on a first open —
// the welcome screen's "anything to resume?" check and the Resume browser itself,
// fired by the same click. A request made while an identical scan is still
// running waits for that scan's answer; once it settles, the next request starts
// fresh, so nobody is ever handed an answer computed before they asked AND after
// it finished.
export function shareInFlight<T>(): (key: string, run: () => Promise<T>) => Promise<T> {
  let current: { key: string; result: Promise<T> } | null = null;
  return (key, run) => {
    if (current?.key === key) return current.result;
    const result = run();
    current = { key, result };
    // Only clear OUR entry — a request with another key may have replaced it.
    void result.finally(() => { if (current?.result === result) current = null; }).catch(() => {});
    return result;
  };
}
