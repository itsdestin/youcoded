// Tests for SpecialistUsageHistory — the estimate's raw material (specialists
// plans, spending rework T5; backend design §4). Real filesystem per test
// (NativeHome on a temp root), same fixture style as plan-journal.test.ts.
// Every history instance here is built with a huge scanDelayMs so the
// constructor's own deferred timer never fires mid-test; scans are run
// explicitly with `.scan()` so tests stay deterministic.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { NativeHome } from '../src/main/native-home';
import { SpecialistUsageHistory, toHistoryUsage } from '../src/main/harness/plans/specialist-usage-history';

const NO_AUTO_SCAN = { scanDelayMs: 24 * 60 * 60 * 1000, writeDebounceMs: 5 };

let root: string; let home: NativeHome;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'specialist-usage-history-'));
  home = new NativeHome(root);
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

/** Writes a fake specialist session file: header line + one turn-complete
 *  usage line, exactly the shape session-store.ts's real writer produces. */
async function writeSpecialistSession(
  slug: string, sessionId: string,
  opts: { agentType: string; providerId?: string; modelId?: string; usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number } } ,
): Promise<void> {
  await home.appendSessionLine(slug, sessionId, {
    v: 1, sessionId, harnessId: 'h1', cwd: '/proj', createdAt: 1,
    sessionKind: 'specialist', agentType: opts.agentType,
    binding: { providerId: opts.providerId ?? 'anthropic', modelId: opts.modelId ?? 'claude' },
  });
  const usage = opts.usage ?? { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 200, cacheCreationTokens: 0 };
  await home.appendSessionLine(slug, sessionId, { type: 'turn-complete', sessionId, data: { usage } });
}

async function writeRootSession(slug: string, sessionId: string): Promise<void> {
  await home.appendSessionLine(slug, sessionId, {
    v: 1, sessionId, harnessId: 'h1', cwd: '/proj', createdAt: 1, sessionKind: 'root',
    binding: { providerId: 'anthropic', modelId: 'claude' },
  });
  await home.appendSessionLine(slug, sessionId, { type: 'turn-complete', sessionId, data: { usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 } } });
}

describe('scan', () => {
  it('indexes a specialist session, netting cache reads/writes out of the raw input total', async () => {
    await writeSpecialistSession('proj', 'child-1', {
      agentType: 'worker', providerId: 'openrouter', modelId: 'model-a',
      usage: { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 300, cacheCreationTokens: 100 },
    });
    const h = new SpecialistUsageHistory(home, NO_AUTO_SCAN);
    await h.scan();
    const entries = h.snapshot().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      childId: 'child-1', agentType: 'worker', providerId: 'openrouter', modelId: 'model-a',
      usage: { uncached: 600, cacheRead: 300, cacheWrite: 100, output: 50 },
    });
  });

  it('sums usage across multiple turn-complete/user-interrupt/session-error/compact-summary lines', async () => {
    await home.appendSessionLine('proj', 'child-multi', {
      v: 1, sessionId: 'child-multi', harnessId: 'h1', cwd: '/proj', createdAt: 1,
      sessionKind: 'specialist', agentType: 'reviewer', binding: { providerId: 'a', modelId: 'm' },
    });
    await home.appendSessionLine('proj', 'child-multi', { type: 'turn-complete', sessionId: 'child-multi', data: { usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 } } });
    await home.appendSessionLine('proj', 'child-multi', { type: 'assistant-text', sessionId: 'child-multi', data: { text: 'ignored — not a usage event' } });
    await home.appendSessionLine('proj', 'child-multi', { type: 'compact-summary', sessionId: 'child-multi', data: { usage: { inputTokens: 50, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 } } });
    await home.appendSessionLine('proj', 'child-multi', { type: 'user-interrupt', sessionId: 'child-multi', data: { usage: { inputTokens: 20, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 } } });
    const h = new SpecialistUsageHistory(home, NO_AUTO_SCAN);
    await h.scan();
    expect(h.snapshot().entries[0].usage).toEqual({ uncached: 170, cacheRead: 0, cacheWrite: 0, output: 17 });
  });

  it('skips a non-specialist (root) session file — no entry at all', async () => {
    await writeRootSession('proj', 'root-1');
    await writeSpecialistSession('proj', 'child-1', { agentType: 'worker' });
    const h = new SpecialistUsageHistory(home, NO_AUTO_SCAN);
    await h.scan();
    const entries = h.snapshot().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].childId).toBe('child-1');
  });

  it('tolerates a malformed line — skips it and still sums the valid lines around it', async () => {
    await home.appendSessionLine('proj', 'child-bad', {
      v: 1, sessionId: 'child-bad', harnessId: 'h1', cwd: '/proj', createdAt: 1,
      sessionKind: 'specialist', agentType: 'worker', binding: { providerId: 'a', modelId: 'm' },
    });
    await home.appendSessionLine('proj', 'child-bad', { type: 'turn-complete', sessionId: 'child-bad', data: { usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 } } });
    // A torn/corrupt tail line, appended directly (never through appendSessionLine, which would JSON-encode it).
    const p = path.join(root, '.youcoded', 'sessions', 'proj', 'child-bad.jsonl');
    fs.appendFileSync(p, '{"type":"turn-complete","data":{"usage":{"inputTok\n');
    await home.appendSessionLine('proj', 'child-bad', { type: 'turn-complete', sessionId: 'child-bad', data: { usage: { inputTokens: 50, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 } } });
    const h = new SpecialistUsageHistory(home, NO_AUTO_SCAN);
    await h.scan();
    expect(h.snapshot().entries[0].usage).toEqual({ uncached: 150, cacheRead: 0, cacheWrite: 0, output: 15 });
  });

  it('does not re-read an unchanged file on a second scan', async () => {
    await writeSpecialistSession('proj', 'child-1', { agentType: 'worker' });
    const h = new SpecialistUsageHistory(home, NO_AUTO_SCAN);
    await h.scan();
    const spy = vi.spyOn(home, 'readSessionHeadAsync');
    await h.scan(); // nothing changed on disk — the size+mtime skip key should short-circuit before any header read
    expect(spy).not.toHaveBeenCalled();
  });

  it('re-reads a file whose size/mtime changed since the last scan', async () => {
    await writeSpecialistSession('proj', 'child-1', {
      agentType: 'worker', usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });
    const h = new SpecialistUsageHistory(home, NO_AUTO_SCAN);
    await h.scan();
    expect(h.snapshot().entries[0].usage.uncached).toBe(100);
    // A real specialist file never grows after its run ends, but the test
    // only needs to prove the skip key is honored — append more usage and a
    // later mtime, same as a genuinely different file would show.
    await new Promise((r) => setTimeout(r, 5));
    await home.appendSessionLine('proj', 'child-1', { type: 'turn-complete', sessionId: 'child-1', data: { usage: { inputTokens: 900, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 } } });
    await h.scan();
    expect(h.snapshot().entries[0].usage.uncached).toBe(1000);
  });
});

describe('record', () => {
  it('pushes an entry into memory immediately — synchronous, no scan needed', () => {
    const h = new SpecialistUsageHistory(home, NO_AUTO_SCAN);
    h.record('child-live', 'worker', 'openrouter', 'model-a', { uncached: 500, cacheRead: 0, cacheWrite: 0, output: 20 });
    expect(h.snapshot().entries).toEqual([
      { childId: 'child-live', agentType: 'worker', providerId: 'openrouter', modelId: 'model-a',
        usage: { uncached: 500, cacheRead: 0, cacheWrite: 0, output: 20 }, size: 0, mtimeMs: expect.any(Number) },
    ]);
  });

  it('toHistoryUsage nets cache reads/writes out of the raw input total, clamped', () => {
    expect(toHistoryUsage({ inputTokens: 1000, outputTokens: 50, cacheReadTokens: 300, cacheCreationTokens: 100 }))
      .toEqual({ uncached: 600, cacheRead: 300, cacheWrite: 100, output: 50 });
    // A malformed report claiming more cache than input tokens can't drive
    // uncached negative or overcount either cache bucket.
    expect(toHistoryUsage({ inputTokens: 100, outputTokens: 0, cacheReadTokens: 90, cacheCreationTokens: 90 }))
      .toEqual({ uncached: 0, cacheRead: 90, cacheWrite: 10, output: 0 });
  });

  it('a later scan reaching the same childId overwrites the record()-pushed entry with real stat numbers', async () => {
    await writeSpecialistSession('proj', 'child-1', { agentType: 'worker' });
    const h = new SpecialistUsageHistory(home, NO_AUTO_SCAN);
    h.record('child-1', 'worker', 'anthropic', 'claude', { uncached: 1, cacheRead: 0, cacheWrite: 0, output: 1 });
    expect(h.snapshot().entries[0].size).toBe(0);
    await h.scan();
    expect(h.snapshot().entries[0].size).toBeGreaterThan(0);
  });
});

describe('the 1,000-entry cap', () => {
  it('keeps at most 1,000 entries, evicting the OLDEST by mtimeMs first', () => {
    const h = new SpecialistUsageHistory(home, NO_AUTO_SCAN);
    for (let i = 0; i < 1_005; i++) {
      h.record(`child-${i}`, 'worker', 'a', 'm', { uncached: i, cacheRead: 0, cacheWrite: 0, output: 0 });
    }
    const entries = h.snapshot().entries;
    expect(entries.length).toBe(1_000);
    // record() stamps mtimeMs as "now" in insertion order, so the first 5
    // pushed (child-0..child-4) are the oldest and must be the ones evicted.
    const ids = new Set(entries.map((e) => e.childId));
    for (let i = 0; i < 5; i++) expect(ids.has(`child-${i}`)).toBe(false);
    expect(ids.has('child-1004')).toBe(true);
  });
});

describe('cache persistence (D7)', () => {
  it('debounces the write, then writes fs.promises.writeFile (not through NativeHome.mutateJson)', async () => {
    const h = new SpecialistUsageHistory(home, { scanDelayMs: NO_AUTO_SCAN.scanDelayMs, writeDebounceMs: 10 });
    h.record('child-1', 'worker', 'a', 'm', { uncached: 5, cacheRead: 0, cacheWrite: 0, output: 1 });
    const cachePath = path.join(root, '.youcoded', 'specialist-usage.json');
    expect(fs.existsSync(cachePath)).toBe(false); // debounced — nothing yet
    await vi.waitFor(() => { expect(fs.existsSync(cachePath)).toBe(true); }, { timeout: 1000 });
    const written = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    expect(written).toEqual([
      { childId: 'child-1', agentType: 'worker', providerId: 'a', modelId: 'm',
        usage: { uncached: 5, cacheRead: 0, cacheWrite: 0, output: 1 }, size: 0, mtimeMs: expect.any(Number) },
    ]);
  });

  it('loads a previously written cache at construction, async, without blocking snapshot()', async () => {
    fs.mkdirSync(path.join(root, '.youcoded'), { recursive: true });
    fs.writeFileSync(path.join(root, '.youcoded', 'specialist-usage.json'), JSON.stringify([
      { childId: 'child-cached', agentType: 'reviewer', providerId: 'a', modelId: 'm', usage: { uncached: 1, cacheRead: 0, cacheWrite: 0, output: 0 }, size: 10, mtimeMs: 10 },
    ]));
    const h = new SpecialistUsageHistory(home, NO_AUTO_SCAN);
    // snapshot() right away is synchronous and never throws even though the
    // cache read hasn't landed yet — it just may still be empty.
    expect(() => h.snapshot()).not.toThrow();
    await vi.waitFor(() => { expect(h.snapshot().entries).toHaveLength(1); });
    expect(h.snapshot().entries[0].childId).toBe('child-cached');
  });

  it('a corrupt cache file reads as empty rather than throwing', async () => {
    fs.mkdirSync(path.join(root, '.youcoded'), { recursive: true });
    fs.writeFileSync(path.join(root, '.youcoded', 'specialist-usage.json'), '{not json');
    const h = new SpecialistUsageHistory(home, NO_AUTO_SCAN);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.snapshot().entries).toEqual([]);
  });
});
