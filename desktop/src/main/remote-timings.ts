// remote-timings.ts — the computer's log lines for how long a phone waited (2026-10-22 phone speed).
//
// WHY: a phone that felt slow left no number anywhere. The phone sends one `remote:timings` report per connection once its
// conversations are drawn (renderer/remote-timings.ts); the computer adds how long it took to answer each conversation and how
// big that answer was. Both go to desktop.log through logDevice, so real phones are measured without any tool on the phone.

/** Steps in the order a connection goes through them; anything else the phone sends is ignored. */
const STEPS: Array<[string, string]> = [
  ['waited', 'waited after waking'], ['page', 'page'], ['code', 'code ran'], ['first-frame', 'first frame'], ['connection-code', 'connection code'],
  ['connecting', 'connecting'], ['open', 'connected'], ['signed-in', 'signed in'], ['list', 'list'],
  ['terminal', 'terminal'], ['conversation', 'conversation'], ['drawn', 'drawn'],
];

const ms = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n < 3_600_000;

/** `remote:timings` from a phone, as one line, or null when it is not one. Times are milliseconds. */
export function describePhoneTimings(payload: unknown): string | null {
  const p = payload as { kind?: unknown; nav?: unknown; downloaded?: unknown; marks?: unknown } | null;
  if (!p || (p.kind !== 'load' && p.kind !== 'reconnect') || !p.marks || typeof p.marks !== 'object') return null;
  const marks = p.marks as Record<string, unknown>;
  const parts = STEPS.filter(([key]) => ms(marks[key])).map(([key, label]) => `${label} ${Math.round(marks[key] as number)}`);
  if (parts.length === 0) return null;
  const how = p.kind === 'load'
    ? `page ${typeof p.nav === 'string' ? p.nav.slice(0, 12) : 'load'}${typeof p.downloaded === 'number' && Number.isFinite(p.downloaded) && p.downloaded >= 0 ? `, ${kb(p.downloaded)} downloaded` : ''}`
    : 'reconnect';
  return `timings (${how}), ms: ${parts.join(' · ')}`;
}

/** One answer to a phone's conversation request: how long the computer took and how much it sent. */
export function describeAnswer(type: string, payload: unknown, tookMs: number, chars: number): string {
  const what = type === 'session:open' ? ((payload as { ptyOnly?: unknown })?.ptyOnly === true ? 'terminal' : 'conversation') : 'list';
  return `${what} answered in ${Math.round(tookMs)} ms, ${kb(chars)}`;
}

function kb(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}
