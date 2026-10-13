// What a screen does with one session:live push (one-core R5-4a): the App's handler, driven without mounting App.
import { describe, it, expect, vi } from 'vitest';
import { applySessionLive } from '../src/renderer/state/apply-session-live';

function deps(native = false) {
  const pushed: any[] = [];
  return {
    pushed,
    chip: vi.fn(), sess: vi.fn(),
    d: {
      batcher: { push: (a: any) => pushed.push(a) }, contextTokens: () => 123, isNative: () => native,
      setChipModel: undefined as any, setSessionModel: undefined as any,
    },
  };
}
const make = (native = false) => { const x = deps(native); x.d.setChipModel = x.chip; x.d.setSessionModel = x.sess; return x; };

describe('applySessionLive', () => {
  it('a queue snapshot becomes one QUEUE_SYNCED action through the batcher', () => {
    const x = make();
    applySessionLive({ sessionId: 's', kind: 'queue', queue: [{ queueId: 'q', content: 'c', timestamp: 1 }] }, x.d);
    expect(x.pushed).toEqual([{ type: 'QUEUE_SYNCED', sessionId: 's', queue: [{ queueId: 'q', content: 'c', timestamp: 1 }] }]);
    expect(x.chip).not.toHaveBeenCalled();
  });
  it('a Claude Code model announcement moves the chip and the session\'s own model, by alias', () => {
    const x = make();
    applySessionLive({ sessionId: 's', kind: 'model', model: 'claude-sonnet-4-6' }, x.d);
    expect(x.pushed[0]).toMatchObject({ type: 'MODEL_ANNOUNCED', model: 'claude-sonnet-4-6' });
    expect(x.chip).toHaveBeenCalledWith('s', 'sonnet');
    expect(x.sess).toHaveBeenCalledWith('s', 'sonnet');
  });
  it('a native model id is kept as it is and never touches the Claude chip', () => {
    const x = make(true);
    applySessionLive({ sessionId: 's', kind: 'model', model: 'gpt-5.5' }, x.d);
    expect(x.chip).not.toHaveBeenCalled();
    expect(x.sess).toHaveBeenCalledWith('s', 'gpt-5.5');
  });
  it('a model nobody can name changes no chip', () => {
    const x = make();
    applySessionLive({ sessionId: 's', kind: 'model', model: 'mystery-9' }, x.d);
    expect(x.chip).not.toHaveBeenCalled();
    expect(x.sess).not.toHaveBeenCalled();
  });
  it('the compaction spinner takes this screen\'s own context reading; a malformed push does nothing', () => {
    const x = make();
    applySessionLive({ sessionId: 's', kind: 'compact-start', id: 'c1' }, x.d);
    expect(x.pushed[0]).toMatchObject({ type: 'COMPACTION_PENDING', beforeContextTokens: 123, hostOwned: true });
    applySessionLive(null as any, x.d);
    expect(x.pushed).toHaveLength(1);
  });
});
