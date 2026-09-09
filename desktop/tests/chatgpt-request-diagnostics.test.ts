import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatGptRequestDiagnostics } from '../src/main/providers/chatgpt-request-diagnostics';

// WHY: dispatch order, not response completion, defines the comparable prefix.
const body = (input: unknown[], extra = {}) => JSON.stringify({ model: 'gpt-5', input, instructions: 'PRIVATE_PROMPT', tools: [{ secret: 'PRIVATE_TOOL' }], prompt_cache_key: 'PRIVATE_KEY', ...extra });
const scope = { sessionId: 'PRIVATE_SESSION', purpose: 'chat' as const, logicalStepId: 'step' };
describe('private request diagnostics', () => {
  it('reschedules a record enqueued between drain completion and ownership release', async () => {
    const rows: any[] = [];
    const d = new ChatGptRequestDiagnostics({ directory: '/unused', write: async row => { rows.push(row); } });
    // WHY: empty flush completes its coroutine synchronously but releases ownership
    // in an await continuation. Enqueue in precisely that gap, with no sleeps.
    const draining = d.flush();
    d.finish(d.dispatch(scope, body(['gap'])), 'success');
    await draining;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(rows).toHaveLength(1);
    expect(d.stats().queued).toBe(0);
  });
  it('rotates into only two bounded private files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cache-rotation-'));
    const d = new ChatGptRequestDiagnostics({ directory: dir });
    try {
      await writeFile(join(dir, 'requests.jsonl'), ' '.repeat(5 * 1024 * 1024), { mode: 0o600 });
      d.finish(d.dispatch(scope, body(['a'])), 'success');
      await d.flush();
      expect((await readdir(dir)).sort()).toEqual(['requests.jsonl', 'requests.previous.jsonl']);
      for (const file of await readdir(dir)) {
        const info = await stat(join(dir, file));
        expect(info.size).toBeLessThanOrEqual(5 * 1024 * 1024);
        if (process.platform !== 'win32') expect(info.mode & 0o777).toBe(0o600);
      }
    } finally { await d.flush(); await rm(dir, { recursive: true, force: true, maxRetries: 3 }); }
  });

  it('retains exact serialized items and component changes, with a fresh process baseline', async () => {
    const rows: any[] = [];
    const d = new ChatGptRequestDiagnostics({ directory: '/unused', write: async row => { rows.push(row); } });
    d.finish(d.dispatch(scope, '{"input":[{"x":1}],"model":"gpt-5"}'), 'success');
    d.finish(d.dispatch(scope, '{"input":[{"x": 1}],"model":"gpt-5","temperature":0}'), 'success');
    d.finish(d.dispatch(scope, '{"input":[{"x": 1}],"model":"gpt-6","instructions":"new","tools":[],"prompt_cache_key":"new"}'), 'success');
    await d.flush();
    expect(rows[1]).toMatchObject({ change: 'edit', firstDifferingItem: 0, changed: { settings: true } });
    expect(rows[2].changed).toMatchObject({ instructions: true, tools: true, model: true, cacheKey: true });
    const fresh = new ChatGptRequestDiagnostics({ directory: '/unused', write: async row => { rows.push(row); } });
    fresh.finish(fresh.dispatch(scope, body(['a'])), 'success');
    await fresh.flush();
    expect(rows.at(-1).change).toBe('baseline');
    expect(rows.at(-1).sessionId).not.toBe(rows[0].sessionId);
  });

  it('drops queue excess without waiting for a blocked writer and isolates failures', async () => {
    let unblock!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    const d = new ChatGptRequestDiagnostics({ directory: '/unused', write: async () => { await gate; throw new Error('PRIVATE_ERROR'); } });
    d.finish(d.dispatch(scope, body(['a'])), 'failed');
    const flushing = d.flush();
    for (let i = 0; i < 1001; i++) d.finish(d.dispatch(scope, body(['a'])), 'failed');
    expect(d.stats()).toMatchObject({ queued: 1000, dropped: 1 });
    unblock();
    await flushing;
    expect(d.stats().writeFailures).toBe(1001);
  });

  it('evicts inactive fingerprints within 8 MiB and drops an oversized observation', async () => {
    const d = new ChatGptRequestDiagnostics({ directory: '/unused', write: async () => {} });
    const large = body(Array(10000).fill('x'));
    for (let i = 0; i < 30; i++) d.finish(d.dispatch({ ...scope, sessionId: String(i) }, large), 'success');
    expect(d.stats().evicted).toBeGreaterThan(0);
    expect(d.stats().fingerprintBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(d.dispatch(scope, body(Array(270000).fill('x')))).toBeUndefined();
    expect(d.stats().dropped).toBe(1);
    await d.flush();
  });

  it('measures representative request parsing and hashing CPU (not a savings claim)', async () => {
    const d = new ChatGptRequestDiagnostics({ directory: '/unused', write: async () => {} });
    const input = Array.from({ length: 1000 }, (_, i) => ({ role: 'user', content: `${i}:` + 'word '.repeat(80) }));
    const representative = body(input);
    const encrypted = body([...input, { type: 'reasoning', encrypted_content: 'e'.repeat(4 * 1024 * 1024) }]);
    for (const [name, payload] of [['100k-token-like', representative], ['plus-4MiB-encrypted', encrypted]]) {
      const start = process.cpuUsage();
      for (let i = 0; i < 20; i++) d.finish(d.dispatch(scope, payload), 'success');
      const cpu = process.cpuUsage(start);
      console.log(JSON.stringify({ measurement: name, bytes: Buffer.byteLength(payload), iterations: 20, userMicros: cpu.user, systemMicros: cpu.system, cpuMsPerRequest: (cpu.user + cpu.system) / 20000 }));
    }
    await d.flush();
  });
  it('compares ordered appends, edits and removals at dispatch and isolates lanes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cache-test-'));
    const d = new ChatGptRequestDiagnostics({ directory: dir });
    try {
      const a = d.dispatch(scope, body(['a']))!;
      const b = d.dispatch(scope, body(['a', 'b']))!;
      d.finish(b, 'success', { input_tokens: 100, output_tokens: 2, input_tokens_details: { cached_tokens: 0 } });
      d.finish(a, 'success', { input_tokens: 50 });
      const c = d.dispatch(scope, body(['a', 'x']))!;
      d.finish(c, 'failed');
      d.finish(d.dispatch(scope, body(['a']))!, 'aborted');
      d.finish(d.dispatch({ ...scope, purpose: 'summary' }, body(['a']))!, 'success');
      await d.flush();
      const text = await readFile(join(dir, 'requests.jsonl'), 'utf8');
      const rows = text.trim().split('\n').map(x => JSON.parse(x));
      expect(rows.map(x => x.change)).toEqual(['append', 'baseline', 'edit', 'remove', 'baseline']);
      expect(rows[2].lastSuccessfulAttemptId).toBe(b);
      expect(rows[0]).toMatchObject({ cacheDetailPresent: true, cachedInputTokens: 0, stablePrefixItems: 1 });
      expect(rows[1]).toMatchObject({ cacheDetailPresent: false, cachedInputTokens: null });
      for (const secret of ['PRIVATE_PROMPT', 'PRIVATE_TOOL', 'PRIVATE_KEY', 'PRIVATE_SESSION']) expect(text).not.toContain(secret);
    } finally { await d.flush(); await rm(dir, { recursive: true, force: true, maxRetries: 3 }); }
  });
  it('expires unfinished observations, bounds state and excludes invalid counts', async () => {
    let now = 0;
    const rows: any[] = [];
    const d = new ChatGptRequestDiagnostics({ directory: '/unused', now: () => now, write: async row => { rows.push(row); } });
    for (let i = 0; i < 257; i++) d.dispatch({ ...scope, sessionId: String(i) }, body(['a']));
    expect(d.stats().unfinished).toBe(256);
    expect(d.stats().dropped).toBe(1);
    now = 600_001;
    const a = d.dispatch(scope, body(['a']))!;
    d.finish(a, 'success', { input_tokens: 10, output_tokens: -1, input_tokens_details: { cached_tokens: 11 } });
    await d.flush();
    expect(d.stats().expired).toBe(256);
    expect(rows.at(-1)).toMatchObject({ cachedInputTokens: null, outputTokens: null, cacheDetailPresent: true });
    expect(d.stats().fingerprintBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
  });
});
