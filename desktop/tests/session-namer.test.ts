// The naming policy, exercised through failable fakes. Each test is one of the
// promises the settings copy and the rename dialog make to the user.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSessionNamer, buildNamingPrompt, type SessionNamerDeps } from '../src/main/session-namer';
import { effectiveName, emptyNamingRecord, mergeNamingRecords, type NamingRecord } from '../src/main/conversations/naming-core';
import { mayPublishAutomaticName } from '../src/main/conversations/naming-store';
import type { NamingPreferences } from '../src/main/naming-settings';
import type { TranscriptEvent } from '../src/shared/types';

const SID = 's1';
const IDENT = { provider: 'native', storeId: 'n1' };

function harness(over: Partial<SessionNamerDeps> = {}, prefs: NamingPreferences = { mode: 'ai', model: null }) {
  let record: NamingRecord = emptyNamingRecord(IDENT.storeId, IDENT.provider);
  const published: string[] = [];
  const generated: string[] = [];
  const asked: string[] = [];
  const settings = { current: prefs };
  const deps: SessionNamerDeps = {
    settings: () => settings.current,
    identify: () => IDENT,
    readNaming: async () => record,
    mutateNaming: async (_p, _i, fn) => { record = fn(record); return record; },
    getBinding: () => ({ providerId: 'p1', modelId: 'm1' }),
    generate: async (_b, prompt) => { generated.push(prompt); return 'Generated name'; },
    askInSessionModel: (sid) => { asked.push(sid); },
    currentName: () => 'New Session',
    hasTitle: async () => false,
    publish: async (_sid, name) => { published.push(name); },
    ...over,
  };
  const namer = createSessionNamer(deps);
  return {
    namer, published, generated, asked, settings,
    get record() { return record; },
    set record(v: NamingRecord) { record = v; },
  };
}

let turn = 0;
beforeEach(() => { turn = 0; });
const userMessage = (text: string): TranscriptEvent =>
  ({ type: 'user-message', sessionId: SID, uuid: `u${++turn}`, timestamp: '', data: { text } } as any);
const turnComplete = (uuid?: string): TranscriptEvent =>
  ({ type: 'turn-complete', sessionId: SID, uuid: uuid ?? `t${++turn}`, timestamp: '', data: {} } as any);
// The namer fires review() detached from the synchronous listener.
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

describe('write-to-publication interleavings', () => {
  it('an AI review replaces an opening write even when the opening publish resumes last', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let openingEntered!: () => void;
    const entered = new Promise<void>((resolve) => { openingEntered = resolve; });
    const shown: string[] = [];
    const h = harness({ publish: async (_sid, name, expectedAutoAt, opening) => {
      if (opening) { openingEntered(); await gate; }
      if (await mayPublishAutomaticName({
        read: async () => h.record, hasTitle: async () => false, name,
        expectedAutoAt, opening, enabled: () => true,
      })) shown.push(name);
    } });
    h.namer.noteEvent(userMessage('fix the scroll'));
    await entered; // sidecar has the opening name, but publication is paused
    h.namer.noteEvent(turnComplete());
    await settle();
    release();
    await settle();
    expect(shown).toEqual(['Generated name']);
    expect(h.record.auto).toBe('Generated name');
  });
});

describe('the opening message', () => {
  it.each(['basic', 'ai'] as const)('publishes a Basic name before completion in %s mode without counting a reply', async (mode) => {
    const h = harness({}, { mode, model: null });
    h.namer.noteEvent(userMessage('help me fix the chat scroll'));
    await settle();
    expect(h.published).toEqual(['Fix the chat scroll']);
    expect(h.record).toMatchObject({ auto: 'Fix the chat scroll', replies: 0, reviewed: 0 });
    expect(h.generated).toEqual([]);
  });

  it('does nothing in Off mode or on blank opening text', async () => {
    const h = harness({}, { mode: 'off', model: null });
    h.namer.noteEvent(userMessage('opening request'));
    await settle();
    expect(h.record.auto).toBe('');
    expect(h.published).toEqual([]);
    const other = harness();
    other.namer.noteEvent(userMessage('   '));
    await settle();
    expect(other.published).toEqual([]);
  });

  it('replaces the initial placeholder at the scheduled AI reply', async () => {
    const h = harness();
    h.namer.noteEvent(userMessage('help me fix the scroll'));
    await settle();
    h.namer.noteEvent(turnComplete());
    await settle();
    expect(h.published).toEqual(['Fix the scroll', 'Generated name']);
    expect(h.record).toMatchObject({ auto: 'Generated name', replies: 1, reviewed: 1 });
  });

  it.each(['manual', 'auto', 'legacy'] as const)('preserves a pre-existing %s title on the opening event', async (kind) => {
    const h = harness({ hasTitle: async () => kind === 'legacy' });
    if (kind === 'manual') h.record = { ...h.record, manual: 'Mine' };
    if (kind === 'auto') h.record = { ...h.record, auto: 'Older automatic' };
    h.namer.noteEvent(userMessage('opening request'));
    await settle();
    expect(h.published).toEqual([]);
    expect(h.record.auto).toBe(kind === 'auto' ? 'Older automatic' : '');
  });

  it('publishes once for duplicate openings and two namers sharing one store', async () => {
    const h = harness();
    // Both instances race the same ownership record and lock-backed mutation.
    const second = createSessionNamer({
      settings: () => h.settings.current, identify: () => IDENT,
      readNaming: async () => h.record,
      mutateNaming: async (_p, _i, fn) => { h.record = fn(h.record); return h.record; },
      getBinding: () => null, generate: async () => '', currentName: () => '',
      hasTitle: async () => false, publish: async (_sid, name) => { h.published.push(name); },
    });
    h.namer.noteEvent(userMessage('opening request'));
    h.namer.noteEvent(userMessage('opening request'));
    second.noteEvent(userMessage('opening request'));
    await settle();
    expect(h.published).toEqual(['Opening request']);
  });

  it('rolls back its saved opening auto when a legacy title lands while the naming write waits', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entering!: () => void;
    const entered = new Promise<void>((resolve) => { entering = resolve; });
    let legacyTitle = '';
    let wroteOpening = false;
    const h = harness({
      hasTitle: async () => !!legacyTitle,
      mutateNaming: async (_p, _i, fn) => {
        // First read saw no title; hold the sidecar write before its locked callback.
        if (!legacyTitle) { entering(); await gate; }
        h.record = fn(h.record);
        if (h.record.auto) wroteOpening = true;
        return h.record;
      },
    });
    h.namer.noteEvent(userMessage('opening request'));
    await entered;
    legacyTitle = 'Title from older client';
    release();
    await settle();
    expect(wroteOpening).toBe(true);
    expect(h.published).toEqual([]);
    // resolveSessionName uses effectiveName(sidecar, stored title) on resume.
    // Checking that resolution, not merely the current pill, detects a ghost auto.
    const resumed = effectiveName(JSON.parse(JSON.stringify(h.record)) as NamingRecord, legacyTitle);
    expect(resumed).toEqual({ name: legacyTitle, manual: false });
    expect(h.record.auto).toBe('');
    // A legacy title blocks Basic's opening placeholder, not AI's scheduled review.
    h.namer.noteEvent(turnComplete());
    await settle();
    expect(h.generated).toHaveLength(1);
    expect(h.record.auto).toBe('Generated name');
  });

  it.each([
    { reason: 'Off', sameMillisecond: true },
    { reason: 'Off', sameMillisecond: false },
    { reason: 'legacy title', sameMillisecond: true },
    { reason: 'manual rename', sameMillisecond: true },
  ] as const)('merges a synced opening copy after $reason races publication (same ms: $sameMillisecond)', async ({ reason, sameMillisecond }) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const start = '2026-09-09T10:00:00.000Z';
      vi.setSystemTime(new Date(start));
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let written!: () => void;
      const writeDone = new Promise<void>((resolve) => { written = resolve; });
      let first = true;
      let legacyTitle = '';
      const h = harness({
        hasTitle: async () => !!legacyTitle,
        mutateNaming: async (_p, _i, fn) => {
          h.record = fn(h.record);
          if (first) {
            first = false;
            written(); // simulate a sync snapshot before nameOpening resumes
            await gate;
          }
          return h.record;
        },
      });
      h.namer.noteEvent(userMessage('opening request'));
      await writeDone;
      const syncedCopy = JSON.parse(JSON.stringify(h.record)) as NamingRecord;
      expect(syncedCopy).toMatchObject({ auto: 'Opening request', autoAt: start });
      if (reason === 'Off') {
        h.settings.current = { mode: 'off', model: null };
        h.namer.invalidateAll();
      } else if (reason === 'legacy title') {
        legacyTitle = 'Older client title';
      } else {
        h.record = { ...h.record, manual: 'My name', manualAt: start };
        h.namer.invalidate(SID);
      }
      if (!sameMillisecond) vi.setSystemTime(new Date(Date.parse(start) + 5));
      release();
      await settle();
      expect(h.published).toEqual([]);
      if (reason === 'manual rename') {
        expect(h.record).toMatchObject({ auto: 'Opening request', autoAt: start, manual: 'My name' });
      } else {
        expect(h.record.auto).toBe('');
        expect(Date.parse(h.record.autoAt)).toBeGreaterThan(Date.parse(syncedCopy.autoAt));
        if (sameMillisecond) expect(h.record.autoAt).toBe('2026-09-09T10:00:00.001Z');
      }
      // A conflict copy can arrive after rollback; neither fold order may
      // resurrect the briefly saved Basic name over the clear or manual name.
      for (const merged of [mergeNamingRecords(h.record, syncedCopy), mergeNamingRecords(syncedCopy, h.record)]) {
        expect(effectiveName(merged, legacyTitle || 'Stored fallback')).toEqual(
          reason === 'manual rename' ? { name: 'My name', manual: true }
            : { name: legacyTitle || 'Stored fallback', manual: false },
        );
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives a later AI review a timestamp beyond a rollback tombstone on the same clock tick', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const start = '2026-09-09T10:00:00.000Z';
      vi.setSystemTime(new Date(start));
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let written!: () => void;
      const writeDone = new Promise<void>((resolve) => { written = resolve; });
      let first = true;
      const h = harness({ mutateNaming: async (_p, _i, fn) => {
        h.record = fn(h.record);
        if (first) { first = false; written(); await gate; }
        return h.record;
      } });
      h.namer.noteEvent(userMessage('opening request'));
      await writeDone;
      const syncedOpening = { ...h.record };
      h.settings.current = { mode: 'off', model: null };
      h.namer.invalidateAll();
      release();
      await settle();
      const tombstone = { ...h.record };
      expect(tombstone).toMatchObject({ auto: '', autoAt: '2026-09-09T10:00:00.001Z' });
      h.settings.current = { mode: 'ai', model: null };
      h.namer.noteEvent(turnComplete());
      await settle();
      expect(h.record.auto).toBe('Generated name');
      expect(Date.parse(h.record.autoAt)).toBeGreaterThan(Date.parse(tombstone.autoAt));
      expect(h.published).toEqual(['Generated name']);
      for (const merged of [mergeNamingRecords(h.record, tombstone), mergeNamingRecords(tombstone, h.record),
        mergeNamingRecords(h.record, syncedOpening)]) {
        expect(effectiveName(merged, 'Stored fallback')).toEqual({ name: 'Generated name', manual: false });
        const withManual = mergeNamingRecords(merged, { ...tombstone, manual: 'My name', manualAt: start });
        expect(effectiveName(withManual, 'Stored fallback')).toEqual({ name: 'My name', manual: true });
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['unchanged', 'newer AI', 'newer AI same ms', 'newer AI same name', 'manual'] as const)(
    'rolls back a completed but unresolved opening write after Off, preserving %s ownership', async (owner) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let written!: () => void;
      const writeDone = new Promise<void>((resolve) => { written = resolve; });
      let first = true;
      const h = harness({ mutateNaming: async (_p, _i, fn) => {
        h.record = fn(h.record);
        if (first) {
          first = false;
          written(); // sidecar is written, but nameOpening has not resumed
          await gate;
        }
        return h.record;
      } });
      h.namer.noteEvent(userMessage('opening request'));
      await writeDone;
      expect(h.record.auto).toBe('Opening request');
      const savedOpening = { ...h.record };
      h.settings.current = { mode: 'off', model: null };
      h.namer.invalidateAll();
      if (owner === 'newer AI' || owner === 'newer AI same ms' || owner === 'newer AI same name') {
        h.record = { ...h.record, auto: owner === 'newer AI same name' ? 'Opening request' : 'Newer review',
          autoAt: owner === 'newer AI same ms' ? savedOpening.autoAt : '2099-01-01T00:00:00.000Z' };
      } else if (owner === 'manual') {
        h.record = { ...h.record, manual: 'My title', manualAt: '2099-01-01T00:00:00.000Z' };
      }
      release();
      await settle();
      expect(h.published).toEqual([]);
      const resumed = effectiveName(JSON.parse(JSON.stringify(h.record)) as NamingRecord, 'Stored fallback');
      expect(resumed).toEqual(owner === 'newer AI' || owner === 'newer AI same ms'
        ? { name: 'Newer review', manual: false }
        : owner === 'manual' ? { name: 'My title', manual: true }
          : owner === 'newer AI same name' ? { name: 'Opening request', manual: false }
            : { name: 'Stored fallback', manual: false });
      expect(h.record.auto).toBe(owner === 'newer AI' || owner === 'newer AI same ms' ? 'Newer review'
        : owner === 'manual' || owner === 'newer AI same name' ? 'Opening request' : '');
      if (owner === 'newer AI same name') expect(h.record.autoAt).toBe('2099-01-01T00:00:00.000Z');
      if (owner === 'newer AI same ms') expect(h.record.autoAt).toBe(savedOpening.autoAt);
      if (owner === 'newer AI' || owner === 'manual') {
        expect(effectiveName(mergeNamingRecords(savedOpening, h.record), 'Stored fallback')).toEqual(resumed);
      }
    },
  );

  it.each(['rename', 'mode off'] as const)('does not write when %s races the delayed lock acquisition', async (change) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entering!: () => void;
    const entered = new Promise<void>((resolve) => { entering = resolve; });
    const h = harness({ mutateNaming: async (_p, _i, fn) => {
      entering();
      await gate;
      h.record = fn(h.record);
      return h.record;
    } });
    h.namer.noteEvent(userMessage('opening request'));
    await entered;
    if (change === 'rename') {
      h.record = { ...h.record, manual: 'Mine' };
      h.namer.invalidate(SID);
    } else {
      h.settings.current = { mode: 'off', model: null };
      h.namer.invalidateAll();
    }
    release();
    await settle();
    expect(h.record.auto).toBe('');
    expect(h.published).toEqual([]);
  });
});

describe('a name the user chose', () => {
  it('is never replaced by an automatic one', async () => {
    const h = harness();
    h.record = { ...h.record, manual: 'Biology revision', manualAt: '2026-09-09T10:00:00.000Z' };
    h.namer.noteEvent(userMessage('help me with photosynthesis'));
    h.namer.noteEvent(turnComplete());
    await settle();
    expect(h.published).toEqual([]);
    expect(h.generated).toEqual([]);
    // Not even the reply counter moves — there is no schedule to keep.
    expect(h.record.replies).toBe(0);
  });

  it('wins a rename that lands while the model is still thinking', async () => {
    let release: (v: string) => void = () => {};
    const h = harness({ generate: () => new Promise<string>((r) => { release = r; }) });
    h.namer.noteEvent(userMessage('fix the scroll'));
    h.namer.noteEvent(turnComplete());
    await settle();
    // The user renames mid-generation: both the record and the namer are told.
    h.record = { ...h.record, manual: 'My own name', manualAt: '2026-09-09T10:00:00.000Z' };
    h.namer.invalidate(SID);
    release('Automatic name');
    await settle();
    expect(h.published).toEqual(['Fix the scroll']);
    expect(h.record.manual).toBe('My own name');
    expect(h.record.auto).toBe('Fix the scroll');
  });

  it('wins even when only the record was updated, without invalidate', async () => {
    // Belt and braces: the commit re-reads ownership under the write lock, so a
    // rename from another window (or another device's sync) still wins.
    let release: (v: string) => void = () => {};
    const h = harness({ generate: () => new Promise<string>((r) => { release = r; }) });
    h.namer.noteEvent(userMessage('fix the scroll'));
    h.namer.noteEvent(turnComplete());
    await settle();
    h.record = { ...h.record, manual: 'Renamed elsewhere', manualAt: '2026-09-09T10:00:00.000Z' };
    release('Automatic name');
    await settle();
    expect(h.published).toEqual(['Fix the scroll']);
    expect(h.record.auto).toBe('Fix the scroll');
  });
});

describe('Off', () => {
  it('generates nothing, writes nothing and counts nothing', async () => {
    const h = harness({}, { mode: 'off', model: null });
    h.namer.noteEvent(userMessage('anything'));
    h.namer.noteEvent(turnComplete());
    await settle();
    expect(h.generated).toEqual([]);
    expect(h.published).toEqual([]);
    expect(h.record.replies).toBe(0);
  });

  it('turning AI on later names the conversation on its next reply', async () => {
    const h = harness({}, { mode: 'off', model: null });
    h.namer.noteEvent(userMessage('opening request'));
    for (let i = 0; i < 5; i++) h.namer.noteEvent(turnComplete());
    await settle();
    expect(h.published).toEqual([]);
    h.settings.current = { mode: 'ai', model: null };
    h.namer.noteEvent(turnComplete());
    await settle();
    expect(h.published).toEqual(['Generated name']);
  });
});

describe('Basic', () => {
  it('quotes the opening request without any model call, once', async () => {
    const h = harness({}, { mode: 'basic', model: null });
    h.namer.noteEvent(userMessage('help me fix the chat scroll'));
    h.namer.noteEvent(turnComplete());
    await settle();
    expect(h.generated).toEqual([]);
    // "help me" is how the request was opened, not what it is about.
    expect(h.published).toEqual(['Fix the chat scroll']);

    // Later replies do not rewrite it — Basic keeps the name it derived.
    for (let i = 0; i < 5; i++) { h.namer.noteEvent(turnComplete()); await settle(); }
    expect(h.published).toEqual(['Fix the chat scroll']);
  });

  it('leaves a conversation that already had a name alone', async () => {
    // Turning Basic on must not rewrite the history — a name from before this
    // feature existed may well be one the user chose somewhere else.
    const h = harness({ hasTitle: async () => true }, { mode: 'basic', model: null });
    h.namer.noteEvent(userMessage('help me fix the chat scroll'));
    h.namer.noteEvent(turnComplete());
    await settle();
    expect(h.published).toEqual([]);
  });

  it('waits rather than writing a blank name when nothing has been said yet', async () => {
    const h = harness({}, { mode: 'basic', model: null });
    h.namer.noteEvent(turnComplete());
    await settle();
    expect(h.published).toEqual([]);
    h.namer.noteEvent(userMessage('now I say something'));
    h.namer.noteEvent(turnComplete());
    await settle();
    expect(h.published).toEqual(['I say something']);
  });
});

describe('the AI review schedule', () => {
  it('runs at completed replies 1, 3, 28 and 53', async () => {
    const fired: number[] = [];
    let replies = 0;
    const h = harness({ generate: async () => { fired.push(replies); return `Name ${fired.length}`; } });
    h.namer.noteEvent(userMessage('opening'));
    for (let i = 0; i < 60; i++) { replies = i + 1; h.namer.noteEvent(turnComplete()); await settle(); }
    expect(fired).toEqual([1, 3, 28, 53]);
  });

  it('does not spend a reply on a duplicated completion event', async () => {
    const h = harness();
    h.namer.noteEvent(userMessage('opening'));
    h.namer.noteEvent(turnComplete('same-turn'));
    await settle();
    h.namer.noteEvent(turnComplete('same-turn'));
    await settle();
    expect(h.record.replies).toBe(1);
    expect(h.generated).toHaveLength(1);
  });

  it('counts replies that land while a slow review is still running', async () => {
    // A fifteen-second generation used to swallow every reply inside its
    // window, so the schedule drifted longest on the busiest conversations.
    let release: (v: string) => void = () => {};
    let calls = 0;
    const h = harness({ generate: () => { calls += 1; return new Promise<string>((r) => { release = r; }); } });
    h.namer.noteEvent(userMessage('opening'));
    h.namer.noteEvent(turnComplete());          // reply 1 — starts the review
    await settle();
    h.namer.noteEvent(turnComplete());          // reply 2 — lands mid-generation
    h.namer.noteEvent(turnComplete());          // reply 3
    await settle();
    expect(h.record.replies).toBe(3);
    // …and only ONE model call was made for that window.
    expect(calls).toBe(1);
    release('Generated name');
    await settle();
  });

  it('still reviews after completions were missed', async () => {
    const h = harness();
    h.record = { ...h.record, replies: 30, reviewed: 3 };
    h.namer.noteEvent(userMessage('opening'));
    h.namer.noteEvent(turnComplete());
    await settle();
    expect(h.published).toEqual(['Opening', 'Generated name']);
  });

  it('tool steps are not replies — only turn-complete moves the counter', async () => {
    const h = harness();
    h.namer.noteEvent(userMessage('opening'));
    h.namer.noteEvent({ type: 'tool-use', sessionId: SID, uuid: 'x1', timestamp: '', data: {} } as any);
    h.namer.noteEvent({ type: 'tool-result', sessionId: SID, uuid: 'x2', timestamp: '', data: {} } as any);
    await settle();
    expect(h.record.replies).toBe(0);
    expect(h.generated).toEqual([]);
  });
});

describe('when naming fails', () => {
  it('leaves the name on screen alone and never surfaces an error', async () => {
    const h = harness({ generate: async () => { throw new Error('provider offline'); } });
    h.namer.noteEvent(userMessage('opening'));
    h.namer.noteEvent(turnComplete());
    await settle();
    expect(h.published).toEqual(['Opening']);
  });

  it('gives up after three tries and waits for the next scheduled review', async () => {
    let calls = 0;
    const h = harness({ generate: async () => { calls += 1; throw new Error('offline'); } });
    h.namer.noteEvent(userMessage('opening'));
    for (let i = 0; i < 10; i++) { h.namer.noteEvent(turnComplete()); await settle(); }
    expect(calls).toBe(3);
  });

  it('treats an empty reply as a failure rather than writing a blank name', async () => {
    const h = harness({ generate: async () => '   ' });
    h.namer.noteEvent(userMessage('opening'));
    h.namer.noteEvent(turnComplete());
    await settle();
    expect(h.published).toEqual(['Opening']);
    expect(h.record.auto).toBe('Opening');
  });

  it('skips silently when the store identity is not known yet', async () => {
    const h = harness({ identify: () => null });
    h.namer.noteEvent(userMessage('opening'));
    h.namer.noteEvent(turnComplete());
    await settle();
    expect(h.generated).toEqual([]);
    expect(h.published).toEqual([]);
  });

  it('a failing store write does not take the turn down', async () => {
    const h = harness({ mutateNaming: async () => { throw new Error('disk full'); } });
    h.namer.noteEvent(userMessage('opening'));
    expect(() => h.namer.noteEvent(turnComplete())).not.toThrow();
    await settle();
    expect(h.published).toEqual([]);
  });
});

describe('which model is asked', () => {
  it('prefers the separately chosen naming model over the session model', async () => {
    const seen: any[] = [];
    const h = harness(
      { generate: async (b) => { seen.push(b); return 'Name'; } },
      { mode: 'ai', model: { providerId: 'chosen', modelId: 'chosen-model' } },
    );
    h.namer.noteEvent(userMessage('opening'));
    h.namer.noteEvent(turnComplete());
    await settle();
    expect(seen).toEqual([{ providerId: 'chosen', modelId: 'chosen-model' }]);
  });

  it('never substitutes a paid provider for a session that has no model of its own', async () => {
    // A Claude Code session: its model lives in the CLI. The free in-session
    // lane is asked instead, and no provider call is made.
    const h = harness({ getBinding: () => null });
    h.namer.noteEvent(userMessage('opening'));
    h.namer.noteEvent(turnComplete());
    await settle();
    expect(h.generated).toEqual([]);
    expect(h.asked).toEqual([SID]);
    // The schedule still advances, so the free lane is not asked every reply.
    expect(h.record.reviewed).toBe(1);
  });

  it('two completions at once do not start two generations', async () => {
    let inFlight = 0;
    let peak = 0;
    const h = harness({ generate: async () => {
      inFlight += 1; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1; return 'Name';
    } });
    h.namer.noteEvent(userMessage('opening'));
    h.namer.noteEvent(turnComplete());
    h.namer.noteEvent(turnComplete());
    await new Promise((r) => setTimeout(r, 30));
    expect(peak).toBe(1);
  });
});

describe('buildNamingPrompt', () => {
  it('sends only the user’s own words, truncated, plus the current name', () => {
    const prompt = buildNamingPrompt({
      first: 'a'.repeat(900), recent: ['dropped one', 'c', 'd', 'b'.repeat(900)], current: 'Fix chat scroll',
    });
    expect(prompt).toContain('The current name is "Fix chat scroll"');
    expect(prompt).toContain('a'.repeat(500));
    expect(prompt).not.toContain('a'.repeat(501));
    expect(prompt).toContain('b'.repeat(300));
    expect(prompt).not.toContain('b'.repeat(301));
    // Only the last three recent messages travel; older ones are dropped.
    expect(prompt).toContain('- c');
    expect(prompt).toContain('- d');
    expect(prompt).not.toContain('dropped one');
  });

  it('does not tell the model to keep a placeholder name', () => {
    const prompt = buildNamingPrompt({ first: 'hello', recent: [], current: 'New Session' });
    expect(prompt).not.toContain('current name');
  });
});

describe('the diagnostics lane', () => {
  it('runs the naming model call in the title lane, never the chat baseline', async () => {
    const { currentChatGptRequest } = await import('../src/main/providers/chatgpt-request-diagnostics');
    const seen: Array<{ sessionId: string; purpose: string } | undefined> = [];
    const h = harness({
      generate: async () => { const c = currentChatGptRequest(); seen.push(c && { sessionId: c.sessionId, purpose: c.purpose }); return 'Generated name'; },
    });
    h.namer.noteEvent(userMessage('help me with photosynthesis'));
    h.namer.noteEvent(turnComplete());
    await settle();
    expect(seen).toEqual([{ sessionId: SID, purpose: 'title' }]);
  });
});
