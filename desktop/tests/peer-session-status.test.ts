// ---------------------------------------------------------------------------
// INVARIANT: the "sessions in other windows" rows are coloured from main's
// cross-window attention SUMMARY (which carries the derived dot colour itself,
// green included) and fall back to status:data's attentionMap (which carries
// "needs attention" states only, so it can never say green) — never the other
// way round, and never over a session THIS window owns.
//
// Why this is a test and not a comment: before the summary was wired in, a peer
// window's working session was indistinguishable from an idle one, and the
// obvious patch ("fill in ids we have no colour for") silently does nothing —
// App dispatches ATTENTION_STATE_CHANGED for every attentionMap entry, peer
// sessions included, so those ids ALREADY have a (staler, red/amber-only)
// colour by the time the peer pass runs.
// ---------------------------------------------------------------------------
import { describe, it, expect } from 'vitest';
import { mergePeerSessionStatuses } from '../src/renderer/hooks/useSessionAttention';
import type { SessionStatusColor } from '../src/renderer/components/StatusDot';

const MINE = 'mine';
const PEER = 'peer';

function directory() {
  return {
    windows: [
      { window: { id: 1, label: 'window 1' }, sessions: [{ id: MINE }] },
      { window: { id: 2, label: 'window 2' }, sessions: [{ id: PEER }] },
    ],
  };
}

function merge(over: {
  base?: Array<[string, SessionStatusColor]>;
  summary?: Record<string, { status?: SessionStatusColor }>;
  attentionMap?: Record<string, string>;
} = {}) {
  return mergePeerSessionStatuses({
    base: new Map<string, SessionStatusColor>(over.base ?? [[MINE, 'green']]),
    localSessionIds: new Set([MINE]),
    windowDirectory: directory(),
    summaryPerSession: over.summary,
    attentionMap: over.attentionMap,
  });
}

describe('peer-window session status', () => {
  it('shows a peer window\'s working session as green — the whole point', () => {
    // attentionMap has no vocabulary for this: a working session is 'ok' there,
    // which maps to no colour at all.
    expect(merge({ summary: { [PEER]: { status: 'green' } } }).get(PEER)).toBe('green');
  });

  it('prefers the live summary over a stale attentionMap for the same session', () => {
    // The peer stalled, then the user in that window unstuck it. The summary is
    // pushed ~100ms after the change; attentionMap is up to 10s behind.
    const m = merge({
      base: [[MINE, 'gray'], [PEER, 'red']],   // red: what the stale feed already produced
      summary: { [PEER]: { status: 'green' } },
      attentionMap: { [PEER]: 'stalled' },
    });
    expect(m.get(PEER)).toBe('green');
  });

  it('falls back to attentionMap when the summary has nothing yet', () => {
    // The window just opened: the push fires on change only, so until this
    // window's first pull/summary lands, the 10s feed is all there is.
    expect(merge({ attentionMap: { [PEER]: 'stalled' } }).get(PEER)).toBe('red');
    expect(merge({ attentionMap: { [PEER]: 'stuck' } }).get(PEER)).toBe('amber');
  });

  it('never overrides a session this window owns', () => {
    // Blue means "activity you haven't read", derived from THIS window's viewed
    // set. A peer's report about our own session cannot know that.
    const m = merge({
      base: [[MINE, 'blue']],
      summary: { [MINE]: { status: 'gray' }, [PEER]: { status: 'green' } },
    });
    expect(m.get(MINE)).toBe('blue');
  });

  it('leaves a peer session alone when neither feed knows anything', () => {
    expect(merge().has(PEER)).toBe(false);
  });

  it('does not mutate the map it was handed', () => {
    const base = new Map<string, SessionStatusColor>([[MINE, 'green']]);
    mergePeerSessionStatuses({
      base,
      localSessionIds: new Set([MINE]),
      windowDirectory: directory(),
      summaryPerSession: { [PEER]: { status: 'green' } },
      attentionMap: {},
    });
    expect(base.has(PEER)).toBe(false);
  });

  it('survives a partial window directory', () => {
    // Same defensive contract the peer section itself keeps: SessionStrip lives
    // above the error boundary, so a missing `sessions` array must not throw.
    expect(() => mergePeerSessionStatuses({
      base: new Map(),
      localSessionIds: new Set(),
      windowDirectory: { windows: [{ window: { id: 2, label: 'w' } } as any, null as any] },
      summaryPerSession: undefined,
      attentionMap: undefined,
    })).not.toThrow();
  });
});
