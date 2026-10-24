// remote-timings.ts — how long a phone took to show a conversation, sent once to the computer's log (2026-10-22 phone speed).
//
// WHY: Destin's phone felt "REALLY slow" and nothing measured it — the computer logged connects and drops, never how long the
// person waited. The phone notes when each step of a connection finished and, once the conversations are drawn, sends ONE
// `remote:timings` line the computer writes to desktop.log (remote-server, describePhoneTimings). No reply, nothing retried.
//
// Two kinds of report: `load` (the page was opened or reloaded: times from the page's own start, plus how much it downloaded)
// and `reconnect` (an existing page connected again: times from that connection's start).

type Marks = Record<string, number>;

const pageMarks: Marks = {};
let pageReported = false;
let conn: { start: number; marks: Marks; reported: boolean } | null = null;
/** When the page was last shown again (or the network came back), until a connection starts or it goes stale. */
let wokeAt: number | null = null;

const now = () => Math.round(performance.now());

/** A step of the page's own start (before any connection): first time only. */
export function markPage(name: string): void {
  if (!(name in pageMarks)) pageMarks[name] = now();
}

/** The page was shown again or came back online: the next connection reports how long after that it began. WHY
 *  (2026-10-22): what a person waits for on resume is mostly the time BEFORE the new connection starts (the wake
 *  check deciding the old one is dead), which the per-connection marks alone never showed. */
export function markWake(): void {
  wokeAt = now();
}

/** A new socket is being opened. */
export function startConnection(): void {
  const start = now();
  conn = { start, marks: {}, reported: false };
  if (wokeAt !== null && start - wokeAt < 15_000) conn.marks.waited = start - wokeAt;   // the longest wake check, with room
  wokeAt = null;
  markPage('connecting');
}

/** A step of the current connection: first time only, also noted for the page's first connection. */
export function markConnection(name: string): void {
  if (!conn || name in conn.marks) return;
  conn.marks[name] = now() - conn.start;
  if (!pageReported) markPage(name);
}

/** What the browser itself recorded about loading the page: how it was opened and how many bytes came over the network. */
function pageFacts(): { nav?: string; downloaded?: number; marks: Marks } {
  const marks: Marks = {};
  let nav: string | undefined;
  let downloaded = 0;
  try {
    const entry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (entry) {
      nav = entry.type;
      marks.page = Math.round(entry.responseEnd);
      downloaded += entry.transferSize || 0;
    }
    for (const r of performance.getEntriesByType('resource') as PerformanceResourceTiming[]) downloaded += r.transferSize || 0;
    // The renderer's own start marks (index.tsx): the app's code has run, and it has drawn its first frame.
    for (const [name, as] of [['yc:modules-evaluated', 'code'], ['yc:root-render', 'first-frame']] as const) {
      const m = performance.getEntriesByName(name)[0];
      if (m) marks[as] = Math.round(m.startTime);
    }
  } catch { /* an older browser: the steps below are still reported */ }
  return { nav, downloaded, marks };
}

/**
 * The conversations of this connection are drawn: the report to send, or null once this connection has reported. Called on the
 * first fill report of each connection, one frame after it (so "drawn" includes the paint).
 */
export function takeReport(): { kind: 'load' | 'reconnect'; nav?: string; downloaded?: number; marks: Marks } | null {
  if (!conn || conn.reported) return null;
  conn.reported = true;
  if (!pageReported) {
    pageReported = true;
    markPage('drawn');
    const facts = pageFacts();
    return { kind: 'load', nav: facts.nav, downloaded: facts.downloaded, marks: { ...facts.marks, ...pageMarks } };
  }
  conn.marks.drawn = now() - conn.start;
  return { kind: 'reconnect', marks: { ...conn.marks } };
}
