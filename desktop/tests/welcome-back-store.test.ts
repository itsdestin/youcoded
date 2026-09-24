// Design: docs/active/specs/2026-09-24-welcome-back-design.md §1, §6.
// An in-memory fake fs (never real disk) lets these assert on the exact
// write sequence — including that every write really does go through a
// temp file + rename, not a direct overwrite.
import { describe, it, expect, beforeEach } from 'vitest';
import { createWelcomeBackStore, type WelcomeBackFs } from '../src/main/welcome-back-store';

const FILE = '/fake/userData/welcome-back.json';
const TMP = `${FILE}.tmp`;

/** Records every write in order and lets a test gate when `writeFile`
 *  resolves, so races between two queued writes can be exercised on purpose. */
function createFakeFs(initial?: string) {
  let content: string | null = initial ?? null;
  let readError: unknown = initial === undefined ? new Error('ENOENT') : null;
  const calls: string[] = [];
  let gate: Promise<void> | null = null;

  const fs: WelcomeBackFs = {
    async readFile(path: string) {
      calls.push(`read:${path}`);
      if (readError) throw readError;
      return content as string;
    },
    async writeFile(path: string, data: string) {
      calls.push(`write:${path}`);
      if (gate) await gate;
      if (path === TMP) content = data; // the temp file holds the pending content until rename
    },
    async rename(oldPath: string, newPath: string) {
      calls.push(`rename:${oldPath}->${newPath}`);
      if (oldPath !== TMP || newPath !== FILE) throw new Error('unexpected rename');
    },
  };

  return {
    fs,
    calls,
    contentNow: () => content,
    parsedNow: () => (content ? JSON.parse(content) : null),
    /** Delay every writeFile call until `release()` is invoked. */
    holdWrites(): () => void {
      let release!: () => void;
      gate = new Promise((resolve) => { release = resolve; });
      return release;
    },
  };
}

describe('createWelcomeBackStore', () => {
  it('starts empty when no file exists, without throwing', async () => {
    const { fs } = createFakeFs();
    const store = createWelcomeBackStore(FILE, fs);
    await store.ready;
    expect(store.offerIds()).toEqual([]);
  });

  it('starts empty when the file is corrupt JSON', async () => {
    const { fs } = createFakeFs('{not json');
    const store = createWelcomeBackStore(FILE, fs);
    await store.ready;
    expect(store.offerIds()).toEqual([]);
  });

  it('starts empty when the file is well-formed JSON with the wrong shape', async () => {
    const { fs } = createFakeFs(JSON.stringify({ version: 1, open: 'nope', offer: 42 }));
    const store = createWelcomeBackStore(FILE, fs);
    await store.ready;
    expect(store.offerIds()).toEqual([]);
  });

  it('drops a malformed entry without losing the rest of the file', async () => {
    const seeded = {
      version: 1,
      open: {},
      offer: [
        { conversationId: 'good-1', provider: 'claude' },
        { conversationId: 'bad', provider: 'not-a-provider' },
        { notEvenAnEntry: true },
      ],
    };
    const { fs } = createFakeFs(JSON.stringify(seeded));
    const store = createWelcomeBackStore(FILE, fs);
    await store.ready;
    expect(store.offerIds()).toEqual(['good-1']);
  });

  describe('track / remap / untrack', () => {
    let fake: ReturnType<typeof createFakeFs>;
    let store: ReturnType<typeof createWelcomeBackStore>;

    beforeEach(async () => {
      fake = createFakeFs();
      store = createWelcomeBackStore(FILE, fake.fs);
      await store.ready;
    });

    it('track adds a session to the strip and persists it', async () => {
      store.track('desktop-1', 'conv-1', 'claude');
      await store.flush();
      expect(fake.parsedNow().open).toEqual({ 'desktop-1': { conversationId: 'conv-1', provider: 'claude' } });
    });

    it('remap updates the conversationId of an already-tracked session', async () => {
      store.track('desktop-1', 'conv-1', 'claude');
      store.remap('desktop-1', 'conv-2');
      await store.flush();
      expect(fake.parsedNow().open).toEqual({ 'desktop-1': { conversationId: 'conv-2', provider: 'claude' } });
    });

    it('remap is a no-op for a session that was never tracked (design §2)', async () => {
      store.remap('never-tracked', 'conv-9');
      await store.flush();
      // No write should even have been queued — remap on an untracked id does nothing.
      expect(fake.calls.filter((c) => c.startsWith('write:'))).toEqual([]);
      expect(store.offerIds()).toEqual([]);
    });

    it('untrack (explicit X) removes the session from the strip', async () => {
      store.track('desktop-1', 'conv-1', 'claude');
      store.untrack('desktop-1');
      await store.flush();
      expect(fake.parsedNow().open).toEqual({});
    });

    it('untrack is a no-op for a session that is not tracked', async () => {
      store.untrack('never-tracked');
      await store.flush();
      expect(fake.calls.filter((c) => c.startsWith('write:'))).toEqual([]);
    });

  });

  describe('mutations made before ready resolves', () => {
    // Every call below happens synchronously right after construction — the
    // fake's readFile has not yet had a microtask turn to resolve, so these
    // land while the load is still in flight. Review finding 1: the old
    // implementation replaced `state` wholesale when the load landed, so a
    // pre-ready mutation was silently lost (or a stale loaded value came back
    // to life). These assert the result only AFTER awaiting ready.

    it('a pre-ready track is not lost when the load lands', async () => {
      const { fs, parsedNow } = createFakeFs();
      const store = createWelcomeBackStore(FILE, fs);
      store.track('desktop-1', 'conv-1', 'claude'); // before ready
      await store.ready;
      expect(store.offerIds()).toEqual([]); // sanity: open, not offer
      await store.flush();
      expect(parsedNow().open).toEqual({ 'desktop-1': { conversationId: 'conv-1', provider: 'claude' } });
    });

    it('a pre-ready track then untrack of the same id cancel out, even when the loaded file disagrees', async () => {
      const seeded = { version: 1, open: { 'desktop-1': { conversationId: 'stale', provider: 'claude' } }, offer: [] };
      const { fs, parsedNow } = createFakeFs(JSON.stringify(seeded));
      const store = createWelcomeBackStore(FILE, fs);
      store.track('desktop-1', 'conv-1', 'claude'); // before ready
      store.untrack('desktop-1'); // before ready — cancels the track above
      await store.ready;
      // The untrack must win over BOTH the pre-ready track AND whatever the
      // file said about desktop-1 — it must not be resurrected by the load.
      expect(store.offerIds()).toEqual([]);
      await store.flush();
      expect(parsedNow().open).toEqual({});
    });

    it('a pre-ready track wins over a stale value the loaded file has for the same desktopId', async () => {
      const seeded = { version: 1, open: { 'desktop-1': { conversationId: 'stale-conv', provider: 'native' } }, offer: [] };
      const { fs, parsedNow } = createFakeFs(JSON.stringify(seeded));
      const store = createWelcomeBackStore(FILE, fs);
      store.track('desktop-1', 'fresh-conv', 'claude'); // before ready — this is "current"
      await store.ready;
      await store.flush();
      expect(parsedNow().open).toEqual({ 'desktop-1': { conversationId: 'fresh-conv', provider: 'claude' } });
    });

    it('a pre-ready forget removes an id that only the loaded file knew about', async () => {
      const seeded = { version: 1, open: {}, offer: [{ conversationId: 'conv-x', provider: 'claude' }] };
      const { fs, parsedNow } = createFakeFs(JSON.stringify(seeded));
      const store = createWelcomeBackStore(FILE, fs);
      store.forget(['conv-x']); // before ready — nothing in memory to remove yet, only the disk copy has it
      await store.ready;
      expect(store.offerIds()).toEqual([]);
      await store.flush();
      expect(parsedNow().offer).toEqual([]);
    });

    it('no write happens until after ready resolves, even though a mutation was queued', async () => {
      const { fs, calls } = createFakeFs();
      const store = createWelcomeBackStore(FILE, fs);
      store.track('desktop-1', 'conv-1', 'claude'); // before ready
      expect(calls.filter((c) => c.startsWith('write:'))).toEqual([]);
      await store.ready;
      // The catch-up write happens as part of ready settling — never a
      // half-loaded snapshot on its own.
      expect(calls.filter((c) => c.startsWith('write:')).length).toBe(1);
    });
  });

  describe('startup()', () => {
    it('unions offer with the values of open, deduped by conversationId, and clears open', async () => {
      const seeded = {
        version: 1,
        open: {
          'desktop-1': { conversationId: 'conv-1', provider: 'claude' },
          'desktop-2': { conversationId: 'conv-2', provider: 'native' },
        },
        offer: [{ conversationId: 'conv-2', provider: 'native' }, { conversationId: 'conv-3', provider: 'claude' }],
      };
      const { fs, parsedNow } = createFakeFs(JSON.stringify(seeded));
      const store = createWelcomeBackStore(FILE, fs);
      await store.startup();
      // conv-2 appears in both open and offer — union must not duplicate it.
      expect(store.offerIds().sort()).toEqual(['conv-1', 'conv-2', 'conv-3']);
      expect(parsedNow().open).toEqual({});
    });

    it('startup persists before resolving, with no separate flush() needed', async () => {
      const { fs, calls } = createFakeFs();
      const store = createWelcomeBackStore(FILE, fs);
      await store.startup();
      expect(calls.some((c) => c.startsWith('write:'))).toBe(true);
      expect(calls.some((c) => c.startsWith('rename:'))).toBe(true);
    });

    it('an unanswered offer survives a second startup before it is ever shown (crash-before-crash)', async () => {
      const { fs, parsedNow } = createFakeFs();
      const store = createWelcomeBackStore(FILE, fs);
      await store.ready;
      store.track('desktop-1', 'conv-1', 'claude');
      await store.startup(); // first launch dies before Destin answers the screen
      store.track('desktop-2', 'conv-2', 'claude'); // second launch opens a session, then dies too
      await store.startup();
      expect(store.offerIds().sort()).toEqual(['conv-1', 'conv-2']);
      expect(parsedNow().open).toEqual({});
    });
  });

  describe('forget()', () => {
    it('removes only the given conversation ids from offer', async () => {
      const seeded = {
        version: 1, open: {},
        offer: [{ conversationId: 'conv-1', provider: 'claude' }, { conversationId: 'conv-2', provider: 'claude' }],
      };
      const { fs } = createFakeFs(JSON.stringify(seeded));
      const store = createWelcomeBackStore(FILE, fs);
      await store.ready;
      store.forget(['conv-1']);
      await store.flush();
      expect(store.offerIds()).toEqual(['conv-2']);
    });

    it('is a no-op (no write) when none of the given ids are offered', async () => {
      const { fs, calls } = createFakeFs();
      const store = createWelcomeBackStore(FILE, fs);
      await store.ready;
      store.forget(['nothing-here']);
      await store.flush();
      expect(calls.filter((c) => c.startsWith('write:'))).toEqual([]);
    });

    it('is a no-op for an empty id list', async () => {
      const { fs, calls } = createFakeFs();
      const store = createWelcomeBackStore(FILE, fs);
      await store.ready;
      store.forget([]);
      await store.flush();
      expect(calls.filter((c) => c.startsWith('write:'))).toEqual([]);
    });
  });

  describe('write serialization', () => {
    it('writes through a temp file then renames it into place, in that order', async () => {
      const { fs, calls } = createFakeFs();
      const store = createWelcomeBackStore(FILE, fs);
      await store.ready;
      store.track('desktop-1', 'conv-1', 'claude');
      await store.flush();
      expect(calls).toEqual([`read:${FILE}`, `write:${TMP}`, `rename:${TMP}->${FILE}`]);
    });

    it('serializes overlapping writes so the on-disk file always converges on the latest state', async () => {
      const fake = createFakeFs();
      const store = createWelcomeBackStore(FILE, fake.fs);
      await store.ready;
      const release = fake.holdWrites();
      // Two mutations fire before the FIRST write's writeFile has even resolved.
      store.track('desktop-1', 'conv-1', 'claude');
      store.track('desktop-2', 'conv-2', 'claude');
      const flushed = store.flush();
      release();
      await flushed;
      // The chain must not have clobbered the second mutation with a stale
      // snapshot of the first — both end up persisted.
      expect(fake.parsedNow().open).toEqual({
        'desktop-1': { conversationId: 'conv-1', provider: 'claude' },
        'desktop-2': { conversationId: 'conv-2', provider: 'claude' },
      });
    });

    it('not coalesced: each mutation queues its own write rather than merging into one', async () => {
      const { fs, calls } = createFakeFs();
      const store = createWelcomeBackStore(FILE, fs);
      await store.ready;
      store.track('desktop-1', 'conv-1', 'claude');
      await store.flush();
      store.track('desktop-2', 'conv-2', 'claude');
      await store.flush();
      const writeCount = calls.filter((c) => c.startsWith('write:')).length;
      expect(writeCount).toBe(2);
    });

    it('flush() resolves once every queued write has landed', async () => {
      const fake = createFakeFs();
      const store = createWelcomeBackStore(FILE, fake.fs);
      await store.ready;
      const release = fake.holdWrites();
      store.track('desktop-1', 'conv-1', 'claude');
      let flushedYet = false;
      const flushed = store.flush().then(() => { flushedYet = true; });
      await Promise.resolve(); // let microtasks up to the held write run
      expect(flushedYet).toBe(false);
      release();
      await flushed;
      expect(flushedYet).toBe(true);
    });

    it('a failed write does not wedge later writes (tail always continues)', async () => {
      const { fs, calls, parsedNow } = createFakeFs();
      let failNext = true;
      const flaky: WelcomeBackFs = {
        ...fs,
        async writeFile(path, data) {
          if (failNext && path === TMP) {
            failNext = false;
            calls.push(`write:${path}`); // the attempt happened; it just failed
            throw new Error('disk full');
          }
          return fs.writeFile(path, data);
        },
      };
      const store = createWelcomeBackStore(FILE, flaky);
      await store.ready;
      store.track('desktop-1', 'conv-1', 'claude');
      await store.flush().catch(() => { /* the first write's own failure is expected here */ });
      store.track('desktop-2', 'conv-2', 'claude');
      await store.flush();
      expect(parsedNow().open).toEqual({
        'desktop-1': { conversationId: 'conv-1', provider: 'claude' },
        'desktop-2': { conversationId: 'conv-2', provider: 'claude' },
      });
      expect(calls.filter((c) => c.startsWith('write:')).length).toBe(2);
    });
  });
});
