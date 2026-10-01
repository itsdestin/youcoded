// /clear as a CONTEXT BARRIER (M3 item 2, Destin's call 2026-07-26).
//
// The native session log is append-only with a write-once header, so "clear"
// cannot erase anything. It appends a `context-clear` marker; rebuildHistory
// treats that as a barrier, so the model sees nothing before it while the
// conversation keeps its file, its id, and its full readable scrollback.
//
// The tests that matter most are the ones proving the barrier is DURABLE (it
// survives a rebuild) and that it never destroys the on-disk record.
import { describe, it, expect } from 'vitest';
import { rebuildHistory } from '../src/main/harness/history-rebuild';
import { HarnessSession } from '../src/main/harness/harness-session';
import { ASSISTANT_PRESET } from '../src/shared/harness-manifest';
import { MockLanguageModelV4 } from 'ai/test';
import type { TranscriptEvent } from '../src/shared/types';
import { malformedEv } from './helpers/transcript-events';
import { EMPTY_SKILL_CATALOG } from './helpers/harness-fakes';

let seq = 0;
// WHY loose (M5): minimal fixtures on purpose (`ev('context-clear')`, no payload) — see malformedEv.
const ev = (type: string, data: any = {}): TranscriptEvent =>
  malformedEv(type, data, { sessionId: 's-1', uuid: `u-${++seq}`, timestamp: 1000 + seq });

describe('rebuildHistory — context-clear barrier', () => {
  it('drops everything before the barrier and keeps everything after', () => {
    const history = rebuildHistory([
      ev('user-message', { text: 'old question' }),
      ev('assistant-text', { text: 'old answer' }),
      ev('turn-complete'),
      ev('context-clear'),
      ev('user-message', { text: 'fresh question' }),
      ev('assistant-text', { text: 'fresh answer' }),
      ev('turn-complete'),
    ]);

    expect(history).toEqual([
      { role: 'user', content: 'fresh question' },
      { role: 'assistant', content: [{ type: 'text', text: 'fresh answer' }] },
    ]);
  });

  it('a barrier at the very end yields an empty history', () => {
    const history = rebuildHistory([
      ev('user-message', { text: 'q' }),
      ev('assistant-text', { text: 'a' }),
      ev('turn-complete'),
      ev('context-clear'),
    ]);
    expect(history).toEqual([]);
  });

  it('only the LAST barrier survives when the user clears more than once', () => {
    const history = rebuildHistory([
      ev('user-message', { text: 'first' }),
      ev('context-clear'),
      ev('user-message', { text: 'second' }),
      ev('context-clear'),
      ev('user-message', { text: 'third' }),
    ]);
    expect(history).toEqual([{ role: 'user', content: 'third' }]);
  });

  it('discards a half-built assistant message straddling the barrier', () => {
    // A tool-call before the barrier must NOT leak into post-barrier history:
    // it would arrive as an assistant tool-call whose result the model never
    // sees, which real providers reject.
    const history = rebuildHistory([
      ev('user-message', { text: 'old' }),
      ev('assistant-text', { text: 'calling a tool' }),
      ev('tool-use', { toolUseId: 't1', toolName: 'Read', toolInput: {} }),
      ev('context-clear'),
      ev('user-message', { text: 'new' }),
    ]);
    expect(history).toEqual([{ role: 'user', content: 'new' }]);
    // No dangling tool-call, and no synthesized pairing for one either.
    expect(JSON.stringify(history)).not.toContain('tool-call');
  });

  it('a transcript with NO barrier is completely unaffected', () => {
    const events = [
      ev('user-message', { text: 'q' }),
      ev('assistant-text', { text: 'a' }),
      ev('turn-complete'),
    ];
    expect(rebuildHistory(events)).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
    ]);
  });
});

describe('HarnessSession.clearHistory', () => {
  it('forgets source-labelled rule visibility at the successful clear barrier', () => {
    const s = new HarnessSession({ skillCatalog: EMPTY_SKILL_CATALOG, sessionId: 'rule-clear', cwd: '/tmp/x',
      harness: ASSISTANT_PRESET, binding: { providerId: 'openrouter', modelId: 'm' } } as any,
    async () => new MockLanguageModelV4({ doStream: async () => ({ stream: new ReadableStream({ start(c) { c.close(); } }) as any }) }) as any);
    (s as any).injectedTriggerIds.add('rule:id');
    (s as any).retainedTriggerMessages.add('<project-rule source="r">\nRule\n</project-rule>');
    expect(s.clearHistory()).toEqual({ ok: true });
    expect((s as any).injectedTriggerIds.size).toBe(0);
    expect((s as any).retainedTriggerMessages.size).toBe(0);
  });
  const OPTS = { skillCatalog: EMPTY_SKILL_CATALOG, sessionId: 's-1', cwd: '/tmp/x', harness: ASSISTANT_PRESET, binding: { providerId: 'openrouter', modelId: 'm' } };

  function session() {
    const s = new HarnessSession(OPTS as any, async () => new MockLanguageModelV4({ doStream: async () => ({ stream: new ReadableStream({ start(c) { c.close(); } }) as any }) }) as any);
    (s as any).history = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
    ];
    return s;
  }

  it('empties the model history and emits a persistable context-clear event', () => {
    const s = session();
    const events: TranscriptEvent[] = [];
    s.on('transcript-event', (e: TranscriptEvent) => events.push(e));

    expect(s.clearHistory()).toEqual({ ok: true });

    expect((s as any).history).toEqual([]);
    expect(events.map((e) => e.type)).toEqual(['context-clear']);
  });

  it('refuses while a turn is in flight rather than yanking history mid-turn', async () => {
    const never = new ReadableStream({ start() { /* never closes */ } });
    const model = new MockLanguageModelV4({ doStream: async () => ({ stream: never as any }) });
    const s = new HarnessSession(OPTS as any, async () => model as any);
    const inFlight = s.send('hi');

    const result = s.clearHistory();
    expect(result).toEqual({ ok: false, reason: 'turn-in-flight' });
    // History untouched — a refused clear must leave the session exactly as it was.
    expect((s as any).history.length).toBeGreaterThan(0);

    s.interrupt();
    await inFlight;
  });

  it('emits NOTHING when it refuses — no barrier may be persisted for a failed clear', () => {
    const never = new ReadableStream({ start() { /* never closes */ } });
    const model = new MockLanguageModelV4({ doStream: async () => ({ stream: never as any }) });
    const s = new HarnessSession(OPTS as any, async () => model as any);
    const events: TranscriptEvent[] = [];
    void s.send('hi');
    s.on('transcript-event', (e: TranscriptEvent) => events.push(e));

    s.clearHistory();

    // A persisted barrier here would silently drop context on the NEXT resume
    // even though the user was told the clear failed.
    expect(events.filter((e) => e.type === 'context-clear')).toHaveLength(0);
    s.interrupt();
  });
});
