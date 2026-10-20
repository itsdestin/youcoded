import { describe, it, expect, vi } from 'vitest';
import { CLAUDE_CONTROL_PLUGIN_SOURCE } from '../src/main/claude-control-plugin';

function harness(durable = new Map<string, any>()) {
  const hooks = new Map<string, Function[]>(); const scheduled: (() => unknown)[] = []; const events: any[] = [];
  let box = ''; let value: any; let version = 0; let command: any = { kind: 'idle' }; let finishFence!: () => void;
  const $: any = {
    env: { get: async (key: string) => key.endsWith('URL') ? 'http://127.0.0.1:1234' : 'token' },
    clock: { now: async () => 1000, after: (_: number, fn: () => unknown) => scheduled.push(fn) },
    session: { id: async () => 'conversation', model: async () => 'haiku' },
    store: { get: async (key: string) => durable.get(key), set: vi.fn(async (key: string, data: any) => { durable.set(key, structuredClone(data)); }), delete: vi.fn(async (key: string) => { durable.delete(key); }) },
    state: { get: async () => ({ value, version }), set: vi.fn(async (_: any, v: any, options?: any) => { if (options && options.ifVersion !== version) return { isSet: false, version }; value = v; return { isSet: true, version: ++version }; }) },
    prompt: { read: async () => ({ text: box, cursor: box.length }), fill: vi.fn(async ({ text }: any) => { box = text; return { isFilled: true }; }) },
    http: { fetch: vi.fn(async (url: string, init: any) => {
      const body = JSON.parse(init.body); let answer: any = {};
      if (url.endsWith('/hello')) answer = { queueEnabled: true };
      else if (url.endsWith('/queue-poll')) { answer = command; command = { kind: 'idle' }; }
      else if (url.endsWith('/poll')) return new Promise(() => {});
      else if (url.endsWith('/queue-offer')) { events.push({ ...body.offer, kind: 'offer' }); await new Promise<void>(r => { finishFence = r; }); }
      else if (url.endsWith('/queue-event')) events.push(body.event);
      return { ok: true, status: 200, text: JSON.stringify(answer) };
    }) },
  };
  const register = new Function(CLAUDE_CONTROL_PLUGIN_SOURCE.replace('export function register', 'function register') + ';return register')();
  register((event: string, fn: Function) => { hooks.set(event, [...(hooks.get(event) ?? []), fn]); return { catch() {} }; });
  const emit = (name: string, e: any, bottom: any = async (v: any) => v, signal = new AbortController().signal) => {
    const handlers = hooks.get(name) ?? [];
    const call = (at: number, input: any): any => { if (at === handlers.length) return bottom(input); const next: any = (v: any) => call(at + 1, v); next.signal = signal; return handlers[at]($, input, next); };
    return call(0, e);
  };
  async function start() { await emit('session.start', {}); await scheduled.shift()!(); }
  async function arm(text = 'wire\né') {
    await start();
    // The deferred idle offer is not run: create one real batch fence instead.
    await emit('turn.start', { turnId: 'turn' });
    const pending = emit('classic.PostToolBatch', {}); await vi.waitFor(() => expect(events.some(e => e.kind === 'offer')).toBe(true));
    const offered = events.find(e => e.kind === 'offer');
    const lease = { attemptId: 'attempt', incarnation: value?.incarnation ?? '', conversationId: 'conversation', turnId: 'turn', boundaryId: offered.boundaryId, boundarySeq: offered.boundarySeq, wireHash: 'a'.repeat(64), expiresAt: 5000, wireText: text };
    // Real module incarnation is stamped in its offer id.
    lease.incarnation = offered.boundaryId.slice(0, offered.boundaryId.lastIndexOf(':'));
    command = { kind: 'stage', lease };
    const poll = scheduled.find(fn => String(fn).includes('queuePoll'))!; await poll();
    return { pending, lease };
  }
  return { $, events, emit, arm, scheduled, release: () => finishFence(), pollCommand: async (op: any) => { await vi.waitFor(() => expect(scheduled.some(fn => String(fn).includes('queuePoll'))).toBe(true)); command = op; await scheduled.find(fn => String(fn).includes('queuePoll'))!(); }, stateValue: () => value, box: () => box, setBox: (s: string) => { box = s; }, revokeState: () => { value = { ...value, state: 'revoked' }; version++; } };
}
describe('single-module native queue admission', () => {
  it('abandons owned staging, fences late stage and admission, and preserves a changed human draft', async () => {
    for (const draft of ['', 'human draft']) {
      const h = harness(); const { pending, lease } = await h.arm('discard me');
      if (draft) h.setBox(draft);
      await h.pollCommand({ kind: 'abandon', attempt: lease });
      expect(h.events.at(-1)).toMatchObject({ kind: 'abandoned', attemptId: lease.attemptId });
      expect(h.box()).toBe(draft);
      const fills = h.$.prompt.fill.mock.calls.length;
      await h.pollCommand({ kind: 'stage', lease });
      expect(h.$.prompt.fill).toHaveBeenCalledTimes(fills);
      const next = vi.fn(async (e: any) => e);
      // A new manual input no longer inherits the abandoned queue owner.
      await h.emit('prompt.submit', { text: 'new message', turnId: 'turn' }, next);
      expect(next).toHaveBeenCalledTimes(1);
      h.release(); await pending;
    }
  });
  it('does not replace a live idle fence when two offers await the same session getter', async () => {
    const h = harness(); await h.emit('session.start', {}); await h.scheduled.shift()!();
    const idle = h.scheduled.find(fn => String(fn).includes('queueOffer'))!;
    let release!: () => void; const held = new Promise<void>(r => { release = r; });
    h.$.session.id = async () => { await held; return 'conversation'; };
    const first = idle(); const second = idle(); release();
    await vi.waitFor(() => expect(h.events.filter(e => e.kind === 'offer').length).toBeGreaterThan(0));
    // Settle both getter continuations before asserting the single authoritative fence.
    await Promise.resolve(); await Promise.resolve();
    expect(h.events.filter(e => e.kind === 'offer')).toHaveLength(1);
    h.release(); await Promise.all([first, second]);
  });
  it('classifies an expired never-staged lease without clearing or submitting the composer', async () => {
    const h = harness(); h.$.clock.now = async () => 5001;
    const { pending } = await h.arm('hi');
    expect(h.$.prompt.fill).not.toHaveBeenCalled();
    expect(h.events).toContainEqual(expect.objectContaining({ kind: 'revoked', beforeAdmission: true, composerSafe: true }));
    h.release(); await pending;
  });
  it('never clears a human draft or downgrades accepted evidence when declining a stale stage', async () => {
    const human = harness(); human.$.clock.now = async () => 5001; human.setBox('human draft');
    const declined = await human.arm('hi');
    expect(human.events).toContainEqual(expect.objectContaining({ kind: 'revoked', beforeAdmission: true, composerSafe: false }));
    expect(human.box()).toBe('human draft'); expect(human.$.prompt.fill).not.toHaveBeenCalled(); human.release(); await declined.pending;
    const accepted = harness(); const { pending, lease } = await accepted.arm('hi');
    await accepted.emit('prompt.submit', { text: 'hi', turnId: 'turn' }); accepted.release(); await pending;
    await accepted.pollCommand({ kind: 'stage', lease });
    expect(accepted.stateValue().state).toBe('accepted');
    expect(accepted.events.at(-1)).toMatchObject({ kind: 'accepted', attemptId: lease.attemptId });
    expect(accepted.$.prompt.fill).toHaveBeenCalledTimes(1);
  });
  it('recovers the original native UUID after receipt loss and module restart without sending or reading message text', async () => {
    const durable = new Map<string, any>(); const h = harness(durable); const { pending, lease } = await h.arm();
    const original = h.$.http.fetch.getMockImplementation()!;
    h.$.http.fetch.mockImplementation(async (url: string, init: any) => { if (JSON.parse(init.body).event?.kind === 'transcript') throw Error('lost receipt'); return original(url, init); });
    await h.emit('prompt.submit', { text: lease.wireText, turnId: 'turn' });
    await expect(h.emit('session.append', { uuid: 'actual-row', door: 'delivery', origin: { kind: 'composer' }, message: { name: 'queued_command', content: [{ type: 'text', text: lease.wireText }] } })).rejects.toThrow('lost receipt');
    h.release(); await pending;
    const restored = harness(durable); await restored.emit('session.start', {}); await restored.scheduled.shift()!();
    restored.$.session.id = async () => 'different-current-conversation';
    await restored.pollCommand({ kind: 'evidence', attempt: lease });
    expect(restored.events).toContainEqual(expect.objectContaining({ kind: 'recovered', attemptId: lease.attemptId, wireHash: lease.wireHash, uuid: 'actual-row' }));
    expect(restored.$.prompt.fill).not.toHaveBeenCalled(); expect(restored.$.store.set).not.toHaveBeenCalled();
    await restored.pollCommand({ kind: 'evidence', attempt: { ...lease, incarnation: 'wrong-original' } });
    expect(restored.events.at(-1)).toMatchObject({ kind: 'recovered', attemptId: lease.attemptId }); expect(restored.events.at(-1).uuid).toBeUndefined();
  });
  it('stages exact Unicode, CAS-admits and preserves next result when acceptance receipt is lost', async () => {
    const h = harness(); const { pending, lease } = await h.arm(); expect(h.box()).toBe(lease.wireText);
    const original = h.$.http.fetch.getMockImplementation()!;
    h.$.http.fetch.mockImplementation(async (url: string, init: any) => { const b = JSON.parse(init.body); if (b.event?.kind === 'accepted') throw Error('receipt lost'); return original(url, init); });
    const next = vi.fn(async () => ({ text: lease.wireText, origin: { kind: 'composer' } }));
    expect(await h.emit('prompt.submit', { text: lease.wireText, turnId: 'turn' }, next)).toEqual({ text: lease.wireText, origin: { kind: 'composer' } });
    expect(next).toHaveBeenCalledTimes(1); expect(h.events.some(e => e.kind === 'admitted')).toBe(true); expect(h.events.some(e => e.kind === 'unknown')).toBe(true);
    h.release(); await pending;
  });
  it('drops revoked or changed owned input BEFORE next without erasing a changed human draft', async () => {
    const h = harness(); const { pending, lease } = await h.arm(); h.revokeState(); const next = vi.fn(async () => ({ text: 'human' }));
    expect(await h.emit('prompt.submit', { text: lease.wireText, turnId: 'turn' }, next)).toHaveProperty('drop'); expect(next).not.toHaveBeenCalled();
    h.setBox('new human draft');
    expect(await h.emit('prompt.submit', { text: 'new human draft', turnId: 'turn' }, next)).toHaveProperty('drop');
    expect(next).not.toHaveBeenCalled(); expect(h.box()).toBe('new human draft'); h.release(); await pending;
  });
  it('rewrites only the measured native trim normalization back to exact staged bytes after admission', async () => {
    const h = harness(); const { pending, lease } = await h.arm('  Unicode é🙂 with trailing space  ');
    const bottom = vi.fn(async (e: any) => ({ text: e.text }));
    expect(await h.emit('prompt.submit', { text: lease.wireText.trim(), turnId: 'turn' }, bottom)).toEqual({ text: lease.wireText });
    expect(bottom.mock.calls[0][0].text).toBe(lease.wireText); h.release(); await pending;
  });
  it('expires an owned native lease without invoking next even when host still wants Enter', async () => {
    const h = harness(); const { pending, lease } = await h.arm(); h.$.clock.now = async () => lease.expiresAt + 1;
    const bottom = vi.fn(); expect(await h.emit('prompt.submit', { text: lease.wireText, turnId: 'turn' }, bottom)).toHaveProperty('drop');
    expect(bottom).not.toHaveBeenCalled(); h.release(); await pending;
  });
  it('does not erase text when prompt.fill may have effected then thrown without confirming staging ownership', async () => {
    const h = harness();
    h.$.prompt.fill.mockImplementationOnce(async ({ text }: any) => { h.setBox(text); throw Error('effect then throw'); });
    const { pending, lease } = await h.arm();
    expect(h.box()).toBe(lease.wireText); expect(h.$.prompt.fill).toHaveBeenCalledTimes(1);
    expect(h.events).toContainEqual(expect.objectContaining({ kind: 'revoked', composerSafe: false }));
    h.release(); await pending;
  });
  it('invalidates an admission awaiting its ACK before allowing new manual input', async () => {
    const h = harness(); const {pending,lease}=await h.arm('old attempt');
    const original=h.$.http.fetch.getMockImplementation()!; let resume!:()=>void;
    const gate=new Promise<void>(resolve=>{resume=resolve;});
    h.$.http.fetch.mockImplementation(async(url:string,init:any)=>{const result=await original(url,init);if(JSON.parse(init.body).event?.kind==='admitted')await gate;return result;});
    const next=vi.fn(async(e:any)=>e); const submitting=h.emit('prompt.submit',{text:lease.wireText,turnId:'turn'},next);
    await vi.waitFor(()=>expect(h.events.some(e=>e.kind==='admitted')).toBe(true));
    await h.pollCommand({kind:'abandon',attempt:lease}); resume();
    expect(await submitting).toHaveProperty('drop'); expect(next).not.toHaveBeenCalled();
    await h.emit('prompt.submit',{text:'fresh manual',turnId:'turn'},next); expect(next).toHaveBeenCalledTimes(1);
    h.release(); await pending;
  });
  it('rechecks authority after a delayed admitted acknowledgement before invoking next', async () => {
    const h = harness(); const { pending, lease } = await h.arm(); const original = h.$.http.fetch.getMockImplementation()!;
    h.$.http.fetch.mockImplementation(async (url: string, init: any) => {
      const response = await original(url,init);
      if (JSON.parse(init.body).event?.kind === 'admitted') { h.$.clock.now = async () => lease.expiresAt + 1; h.release(); await pending; }
      return response;
    });
    const bottom = vi.fn(); expect(await h.emit('prompt.submit', { text: lease.wireText, turnId: 'turn' }, bottom)).toHaveProperty('drop');
    expect(bottom).not.toHaveBeenCalled(); expect(h.stateValue().state).toBe('not-invoked');
  });
  it('reconciles CAS admission whose bookkeeping failed before next without treating actual invoked outcomes as not sent', async () => {
    const h = harness(); const { pending, lease } = await h.arm(); const original = h.$.http.fetch.getMockImplementation()!;
    h.$.http.fetch.mockImplementation(async (url: string, init: any) => { if (JSON.parse(init.body).event?.kind === 'admitted') throw Error('admitted reply lost'); return original(url,init); });
    const bottom = vi.fn(); expect(await h.emit('prompt.submit', { text: lease.wireText, turnId: 'turn' }, bottom)).toHaveProperty('drop'); expect(bottom).not.toHaveBeenCalled();
    expect(h.stateValue().state).toBe('not-invoked');
    await h.pollCommand({ kind: 'revoke', lease });
    expect(h.events).toContainEqual(expect.objectContaining({ kind: 'revoked', beforeInvocation: true, composerSafe: true }));
    h.release(); await pending;
  });
  it('ignores nested-agent batches without creating a fence', async () => {
    const h = harness(); const next = vi.fn(async () => ({})); await h.emit('classic.PostToolBatch', { agent_id: 'worker' }, next);
    expect(next).toHaveBeenCalledTimes(1); expect(h.events).toEqual([]);
  });
});
