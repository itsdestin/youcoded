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

  it('drops a scan that did not walk every item instead of reporting differing requests as identical', async () => {
    const rows: any[] = [];
    // A scanner that reads the top level faithfully but silently loses the LAST array
    // item and says so. Real bodies cannot provoke this (valid JSON always walks), so a
    // stub is the only way to hand dispatch the shortfall the buffer sizing used to
    // paper over with zero blocks — two DIFFERENT requests comparing equal.
    const scan = (items: string[]) => ((text: string, array = false) => array
      ? { entries: items.slice(0, -1).map((v, i) => [String(i), v] as [string, string]), complete: false }
      : { entries: [['input', `[${items.join(',')}]`], ['model', '"gpt-5"']] as Array<[string, string]>, complete: true });

    const first = ['"same"', '"FIRST"'];
    const second = ['"same"', '"SECOND"'];
    const d = new ChatGptRequestDiagnostics({ directory: '/unused', write: async row => { rows.push(row); }, scan: scan(first) as any });
    d.finish(d.dispatch(scope, body(first.map(x => JSON.parse(x)))), 'success');
    (d as any).scan = scan(second);
    d.finish(d.dispatch(scope, body(second.map(x => JSON.parse(x)))), 'success');
    await d.flush();

    // Neither observation may become a comparison, and both are counted as loss.
    expect(rows.map(r => r.change)).not.toContain('identical');
    expect(rows).toHaveLength(0);
    expect(d.stats().dropped).toBe(2);

    // The lane was forgotten too, so the next healthy request is an honest baseline.
    (d as any).scan = undefined;
    const healthy = new ChatGptRequestDiagnostics({ directory: '/unused', write: async row => { rows.push(row); } });
    healthy.finish(healthy.dispatch(scope, body(['a'])), 'success');
    await healthy.flush();
    expect(rows.at(-1)).toMatchObject({ change: 'baseline', inputItems: 1 });
  });

  it('drops a body whose input array the scanner cannot finish walking', async () => {
    // WHY: with the full JSON.parse gone, a truncated/unterminated body reaches the
    // scanner directly. Half a walk is half a fingerprint; it must never be compared.
    const rows: any[] = [];
    const d = new ChatGptRequestDiagnostics({ directory: '/unused', write: async row => { rows.push(row); } });
    d.finish(d.dispatch(scope, body(['a', 'b'])), 'success');
    expect(d.dispatch(scope, '{"model":"gpt-5","input":[{"a":1},{"b":2}')).toBeUndefined();
    expect(d.dispatch(scope, '{"model":"gpt-5","input":')).toBeUndefined();
    await d.flush();
    expect(rows.map(r => r.change)).toEqual(['baseline']);
    expect(d.stats().dropped).toBe(2);
  });

  // WHY: this is a stopwatch, not a regression test — it asserts one invariant and
  // otherwise only prints numbers, so it is opt-in (`YOUCODED_DIAG_BENCH=1 npx vitest
  // run tests/chatgpt-request-diagnostics.test.ts`) and never taxes an ordinary run.
  it.skipIf(!process.env.YOUCODED_DIAG_BENCH)('measures representative request parsing and hashing CPU (not a savings claim)', async () => {
    const rows: any[] = [];
    const d = new ChatGptRequestDiagnostics({ directory: '/unused', write: async row => { rows.push(row); } });
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
    // The measurement is only meaningful if every dispatch was actually observed:
    // 40 recorded comparisons, none of them a dropped or unparsed observation.
    expect(rows).toHaveLength(40);
    expect(rows.every(r => r.inputItems > 0 && r.outcome === 'success')).toBe(true);
    expect(d.stats().dropped).toBe(0);
  });
  it('writes a loss record to the real file when observations are lost and nothing completes', async () => {
    // WHY: loss that never accompanies a completed request would otherwise be invisible —
    // the counters ride on ordinary records, and there are none. Real directory, real
    // writer: the `kind:'loss'` row is a persisted schema, not an internal counter.
    const dir = await mkdtemp(join(tmpdir(), 'cache-loss-'));
    const d = new ChatGptRequestDiagnostics({ directory: dir, now: () => 4_242 });
    try {
      // 257 dispatches, none finished: the 256-unfinished bound drops the last one.
      for (let i = 0; i < 257; i++) d.dispatch({ ...scope, sessionId: String(i) }, body(['a']));
      expect(d.stats()).toMatchObject({ unfinished: 256, dropped: 1, queued: 0 });
      await d.flush();

      const lines = (await readFile(join(dir, 'requests.jsonl'), 'utf8')).trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toEqual({ version: 1, kind: 'loss', timestamp: 4_242, dropped: 1, evicted: 0, expired: 0, writeFailures: 0 });
      // It reports loss and NOTHING else — no session, lane, model or body-derived field.
      expect(lines[0]).not.toContain('PRIVATE_SESSION');
      expect(lines[0]).not.toContain('gpt-5');

      // Unchanged counters must not append a second, redundant loss row.
      await d.flush();
      expect((await readFile(join(dir, 'requests.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1);
    } finally { await d.flush(); await rm(dir, { recursive: true, force: true, maxRetries: 3 }); }
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
