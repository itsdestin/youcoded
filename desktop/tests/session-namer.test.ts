// The naming policy, exercised through failable fakes. Each test is one of the
// promises the settings copy and the rename dialog make to the user.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSessionNamer, buildNamingPrompt, type SessionNamerDeps } from '../src/main/session-namer';
import { emptyNamingRecord, type NamingRecord } from '../src/main/conversations/naming-core';
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
    expect(h.published).toEqual([]);
    expect(h.record.manual).toBe('My own name');
    expect(h.record.auto).toBe('');
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
    expect(h.published).toEqual([]);
    expect(h.record.auto).toBe('');
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
    expect(h.published).toEqual(['Generated name']);
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
    expect(h.published).toEqual([]);
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
    expect(h.published).toEqual([]);
    expect(h.record.auto).toBe('');
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
