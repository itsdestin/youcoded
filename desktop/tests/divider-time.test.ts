// A replayed divider shows when it HAPPENED, not when the screen was filled (one-core sync-fix3 review).
import { describe, it, expect } from 'vitest';
import { routeSessionLive } from '../src/renderer/state/transcript-batch';
import { SessionRecords } from '../src/main/session-record';
import { SessionLiveFacts } from '../src/main/session-live';

describe('divider times', () => {
  it('the screen stamps the marker with the time the computer drew it, falling back to its own clock for an older host', () => {
    const pushed: any[] = [];
    const deps = { batcher: { push: (a: any) => pushed.push(a) }, contextTokens: () => null, now: () => 999 };
    routeSessionLive({ sessionId: 's', kind: 'model-switch', id: 'm', label: 'x', at: 111 }, deps);
    routeSessionLive({ sessionId: 's', kind: 'clear', id: 'c', at: 222 }, deps);
    routeSessionLive({ sessionId: 's', kind: 'clear', id: 'c2' }, deps);
    expect(pushed.map((a) => a.timestamp)).toEqual([111, 222, 999]);
  });
  it('the computer stamps a divider with its own clock when it publishes it', () => {
    const out: any[] = [];
    const records = new SessionRecords();
    records.begin('s');
    const live = new SessionLiveFacts({ publish: (_s: string, _t: string, p: any) => out.push(p), records, isClaude: () => true, now: () => 5000 } as any);
    live.noteSessionStart('s', 'clear', 'c1');
    expect(out).toEqual([{ sessionId: 's', kind: 'clear', id: 'clear-c1', at: 5000 }]);
  });
});
