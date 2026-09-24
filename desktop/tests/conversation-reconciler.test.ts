// Tests for the catch-up RECONCILER (Phase 2a design §1, Task 4). Sessions run
// OUTSIDE the app (bare `claude` in a terminal) never fire the live transcript-
// event path, so on startup + a slow periodic tick we scan ~/.claude/projects
// and upsert records for whatever we find. REAL temp dirs (fs.mkdtempSync) — no
// fs mocking — because the whole point is real transcript reads + the real store
// (locked read-modify-write on disk). Fixture style mirrors session-browser.test.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { reconcile } from '../src/main/conversations/reconciler';
import { ccProjectSlug } from '../src/main/slug-encoding';
import {
  createConversationStore,
  type ConversationStore,
} from '../src/main/conversations/conversation-store';

const SID_A = '11111111-1111-4111-8111-111111111111';
const SID_B = '22222222-2222-4222-8222-222222222222';

function jsonlLine(obj: Record<string, unknown>): string {
  return JSON.stringify(obj) + '\n';
}

/**
 * Write a realistic minimal transcript (meta + user prompt + long assistant
 * reply, >500 bytes) into <projectsDir>/<slug>/<sid>.jsonl. Returns the path so
 * a test can clobber its mtime (the load-bearing mtime-vs-content assertion).
 */
function writeTranscript(projectsDir: string, slug: string, sid: string, opts: {
  firstUserText?: string;
  lastTimestamp?: string;
} = {}): string {
  const dir = path.join(projectsDir, slug);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sid}.jsonl`);
  let content = '';
  content += jsonlLine({ type: 'user', isMeta: true, uuid: 'm1', timestamp: '2026-06-01T10:00:00Z', message: { content: 'meta noise' } });
  content += jsonlLine({
    type: 'user', uuid: 'u1', promptId: 'p1', timestamp: '2026-06-01T10:00:01Z',
    message: { content: opts.firstUserText ?? 'fix the reconciler please' },
  });
  content += jsonlLine({
    type: 'assistant', uuid: 'a1', timestamp: opts.lastTimestamp ?? '2026-06-01T10:05:00Z',
    message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done. '.repeat(40) }] },
  });
  fs.writeFileSync(file, content);
  return file;
}

let tmp: string;
let projectsDir: string;
let topicsDir: string;
let store: ConversationStore;
let mirrorCalls: Array<{ p: string; key: string; sid: string }>;
const mirror = (p: string, key: string, sid: string) => { mirrorCalls.push({ p, key, sid }); };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-reconcile-'));
  projectsDir = path.join(tmp, '.claude', 'projects');
  topicsDir = path.join(tmp, '.claude', 'topics');
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.mkdirSync(topicsDir, { recursive: true });
  store = createConversationStore(path.join(tmp, 'conversations'));
  mirrorCalls = [];
});

afterEach(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

describe('reconcile — record creation', () => {
  it('creates a record per valid-UUID transcript, with projectName from the slug last segment', async () => {
    writeTranscript(projectsDir, 'C--proj-alpha', SID_A);
    const n = await reconcile({ projectsDir, topicsDir, store, device: 'Dev1', mirror });
    expect(n).toBe(1);
    const rec = await store.get('claude', SID_A);
    expect(rec).not.toBeNull();
    // 'C--proj-alpha' → last '-' segment → 'alpha' (documented approximation).
    expect(rec!.projectName).toBe('alpha');
    expect(rec!.device).toBe('Dev1');
    expect(rec!.transcriptRef).toBe(`claude/transcripts/alpha/${SID_A}.jsonl`);
  });

  it('sets lastActive from the transcript TAIL timestamp, NEVER the file mtime', async () => {
    // The load-bearing test: the 627-file mtime-rebump incident is why
    // lastActive must come from transcript CONTENT, not the (sync-clobbered) mtime.
    const file = writeTranscript(projectsDir, 'C--proj-alpha', SID_A, { lastTimestamp: '2026-06-10T12:00:00Z' });
    // Clobber the mtime to a wildly different time — reconcile must ignore it.
    fs.utimesSync(file, new Date('2020-01-01'), new Date('2020-01-01'));
    await reconcile({ projectsDir, topicsDir, store, device: 'Dev1', mirror });
    const rec = await store.get('claude', SID_A);
    expect(rec!.lastActive).toBe('2026-06-10T12:00:00.000Z');
  });
});

describe('reconcile — UUID gate', () => {
  it('skips files whose name is not a valid session UUID (no record created)', async () => {
    // >500 bytes so the ONLY reason to skip is the UUID gate.
    writeTranscript(projectsDir, 'C--proj-alpha', 'not-a-valid-uuid');
    const n = await reconcile({ projectsDir, topicsDir, store, device: 'Dev1', mirror });
    expect(n).toBe(0);
    expect(await store.list('claude')).toHaveLength(0);
    expect(mirrorCalls).toHaveLength(0);
  });
});

describe('reconcile — freshness merge', () => {
  it('UPDATES an existing STALE record from a newer transcript (the catch-up core purpose)', async () => {
    // Seed a record OLDER than the transcript — e.g. the session last ran in
    // the app a week ago, then the user ran bare `claude` in a terminal since.
    await store.upsert({
      id: SID_A, provider: 'claude', projectName: 'alpha',
      device: 'OldDevice', lastActive: '2026-06-01T00:00:00.000Z', title: 'Existing',
    });
    writeTranscript(projectsDir, 'C--proj-alpha', SID_A, { lastTimestamp: '2026-06-20T12:00:00Z' });
    const n = await reconcile({ projectsDir, topicsDir, store, device: 'NewDevice', mirror });
    expect(n).toBe(1);
    const rec = await store.get('claude', SID_A);
    // lastActive advanced to the transcript tail; device flipped (merge-decided,
    // and this side carries the newer activity so it wins).
    expect(rec!.lastActive).toBe('2026-06-20T12:00:00.000Z');
    expect(rec!.device).toBe('NewDevice');
    expect(rec!.title).toBe('Existing'); // real title survives the refresh
  });

  it('does not touch an existing record whose lastActive >= the transcript tail', async () => {
    // Seed a record FRESHER than the transcript we are about to scan.
    await store.upsert({
      id: SID_A, provider: 'claude', projectName: 'alpha',
      device: 'OldDevice', lastActive: '2026-07-10T00:00:00.000Z', title: 'Existing',
    });
    writeTranscript(projectsDir, 'C--proj-alpha', SID_A, { lastTimestamp: '2026-06-01T12:00:00Z' });
    const n = await reconcile({ projectsDir, topicsDir, store, device: 'NewDevice', mirror });
    // No upsert happened (record already as fresh as the file).
    expect(n).toBe(0);
    const rec = await store.get('claude', SID_A);
    expect(rec!.device).toBe('OldDevice'); // untouched — the merge-decided device field did not flip
    // Still mirrored (cheap, idempotent) even when the record was left alone.
    expect(mirrorCalls).toHaveLength(1);
    expect(mirrorCalls[0].key).toBe('alpha');
  });
});

describe('reconcile — title precedence', () => {
  it('prefers the topic file title', async () => {
    writeTranscript(projectsDir, 'C--proj-alpha', SID_A);
    fs.writeFileSync(path.join(topicsDir, `topic-${SID_A}`), 'Reconciler Work');
    await reconcile({ projectsDir, topicsDir, store, device: 'Dev1', mirror });
    const rec = await store.get('claude', SID_A);
    expect(rec!.title).toBe('Reconciler Work');
  });

  it('falls back to the derived first-user-message title when no topic file exists', async () => {
    writeTranscript(projectsDir, 'C--proj-alpha', SID_A, { firstUserText: 'fix the reconciler please' });
    await reconcile({ projectsDir, topicsDir, store, device: 'Dev1', mirror });
    const rec = await store.get('claude', SID_A);
    expect(rec!.title).toBe('fix the reconciler please');
  });

  it('leaves the record untitled ("") when neither a topic nor a derivable prompt exists', async () => {
    // >500 bytes, has a timestamp, but the only line is meta (no qualifying
    // user prompt) → no derivable title.
    const dir = path.join(projectsDir, 'C--proj-alpha');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${SID_A}.jsonl`),
      jsonlLine({ type: 'user', isMeta: true, uuid: 'm1', timestamp: '2026-06-01T10:05:00Z', message: { content: 'z'.repeat(600) } }),
    );
    await reconcile({ projectsDir, topicsDir, store, device: 'Dev1', mirror });
    const rec = await store.get('claude', SID_A);
    expect(rec).not.toBeNull();
    expect(rec!.title).toBe('');
  });
});

describe('reconcile — mirroring', () => {
  it('mirrors each scanned transcript with its projectKey + sessionId', async () => {
    const file = writeTranscript(projectsDir, 'C--proj-alpha', SID_A);
    await reconcile({ projectsDir, topicsDir, store, device: 'Dev1', mirror });
    expect(mirrorCalls).toHaveLength(1);
    expect(mirrorCalls[0]).toMatchObject({ p: file, key: 'alpha', sid: SID_A });
  });
});

describe('reconcile — junk threshold', () => {
  it('skips transcripts under 500 bytes', async () => {
    const dir = path.join(projectsDir, 'C--proj-alpha');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${SID_A}.jsonl`), 'tiny');
    const n = await reconcile({ projectsDir, topicsDir, store, device: 'Dev1', mirror });
    expect(n).toBe(0);
    expect(await store.list('claude')).toHaveLength(0);
  });

  it('skips a corrupt transcript (no parseable tail timestamp) instead of creating an EPOCH record', async () => {
    // >500 bytes but NO line carries a parseable timestamp — a corrupt file.
    // Creating a record would stamp EPOCH lastActive and re-upsert every scan.
    const dir = path.join(projectsDir, 'C--proj-alpha');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${SID_A}.jsonl`), 'not json at all '.repeat(50) + '\n');
    // A GOOD transcript alongside proves the scan continues past the corrupt one.
    writeTranscript(projectsDir, 'C--proj-beta', SID_B);
    const n = await reconcile({ projectsDir, topicsDir, store, device: 'Dev1', mirror });
    expect(n).toBe(1);
    expect(await store.get('claude', SID_A)).toBeNull();
    expect(await store.get('claude', SID_B)).not.toBeNull();
  });
});

describe('reconcile — per-file isolation', () => {
  it('a store.upsert throw on ONE file does not abort the scan', async () => {
    writeTranscript(projectsDir, 'C--proj-alpha', SID_A); // upsert will throw
    writeTranscript(projectsDir, 'C--proj-beta', SID_B);  // upsert succeeds
    // Wrap the store so upsert throws for SID_A only; get/list delegate to the real store.
    const throwing: ConversationStore = {
      ...store,
      upsert: async (input) => {
        if (input.id === SID_A) throw new Error('boom (simulated lock timeout / invalid id)');
        return store.upsert(input);
      },
    };
    const n = await reconcile({ projectsDir, topicsDir, store: throwing, device: 'Dev1', mirror });
    expect(n).toBe(1); // only SID_B counted
    expect(await store.get('claude', SID_A)).toBeNull();      // failed file left no record
    expect(await store.get('claude', SID_B)).not.toBeNull();  // scan continued past the failure
  });

  it('a mirror throw does not abort the scan or lose the upsert', async () => {
    writeTranscript(projectsDir, 'C--proj-alpha', SID_A);
    writeTranscript(projectsDir, 'C--proj-beta', SID_B);
    let calls = 0;
    const throwingMirror = () => { calls++; throw new Error('mirror boom'); };
    const n = await reconcile({ projectsDir, topicsDir, store, device: 'Dev1', mirror: throwingMirror });
    // Both upserts landed despite both mirror calls throwing.
    expect(n).toBe(2);
    expect(calls).toBe(2);
    expect(await store.get('claude', SID_A)).not.toBeNull();
    expect(await store.get('claude', SID_B)).not.toBeNull();
  });
});

describe('reconcile — exact projectKey from known folders', () => {
  // The whole-branch review's Finding 1: the slug-last-segment truncation
  // ('...-youcoded-dev' → 'dev') disagrees with the live path's basename(cwd)
  // key ('youcoded-dev'), producing an orphan duplicate space transcript and a
  // cross-device materialize gap. When this device KNOWS the folder, the exact
  // basename is recovered from its slug.

  it('recovers the exact folder name (not the truncation) for a known hyphenated folder', async () => {
    // A realistic hyphenated project path; slug is derived the same way CC would
    // name the on-disk dir, so the test is platform-encoding-agnostic.
    const folder = path.join('C:', 'Users', 'desti', 'youcoded-dev');
    const slug = ccProjectSlug(folder); // e.g. 'C--Users-desti-youcoded-dev'
    writeTranscript(projectsDir, slug, SID_A);

    const n = await reconcile({
      projectsDir, topicsDir, store, device: 'Dev1', mirror,
      knownFolders: [folder],
    });

    expect(n).toBe(1);
    const rec = await store.get('claude', SID_A);
    // Exact basename — NOT the last-segment truncation 'dev' (red before the fix).
    expect(rec!.projectName).toBe('youcoded-dev');
    expect(rec!.transcriptRef).toBe(`claude/transcripts/youcoded-dev/${SID_A}.jsonl`);
    // The mirror (space) key matches too — no orphan under 'dev/'.
    expect(mirrorCalls[0].key).toBe('youcoded-dev');
  });

  it('matches case-insensitively so folder-path case drift still recovers the name', async () => {
    // Saved-folder path recorded with different case than CC's on-disk slug —
    // Windows paths are case-insensitive, so the lowercased map lookup must match.
    const folder = path.join('C:', 'Users', 'Desti', 'MyApp-Client');
    const onDiskSlug = ccProjectSlug(folder).toLowerCase(); // CC dir written lowercased
    writeTranscript(projectsDir, onDiskSlug, SID_A);

    await reconcile({
      projectsDir, topicsDir, store, device: 'Dev1', mirror,
      knownFolders: [folder],
    });

    const rec = await store.get('claude', SID_A);
    expect(rec!.projectName).toBe('MyApp-Client');
  });

  it('falls back to the last-segment truncation for an UNKNOWN folder', async () => {
    // No knownFolders match → the documented truncation fallback is unchanged.
    writeTranscript(projectsDir, 'C--Users-someone-else-secret-proj', SID_A);
    await reconcile({
      projectsDir, topicsDir, store, device: 'Dev1', mirror,
      knownFolders: [path.join('C:', 'Users', 'desti', 'youcoded-dev')],
    });
    const rec = await store.get('claude', SID_A);
    expect(rec!.projectName).toBe('proj'); // last '-' segment, as before
  });
});

describe('reconcile — foreign-slug symlinks (legacy machinery) are skipped', () => {
  // Found by the single-machine dev smoke test on a real ~/.claude/projects: the
  // LEGACY sync / resume-browser machinery symlinks a session's real transcript
  // into the HOME-dir project slug ('C--Users-desti/<id>.jsonl' ->
  // '../C--Users-desti-<proj>/<id>.jsonl'; 687 such symlinks observed, all in the
  // home slug). Following them tagged EVERY linked conversation with the home
  // basename ('desti') and bucketed all transcripts together. The reconciler must
  // detect the symlink (via lstat, which does NOT follow) and skip it, processing
  // the REAL transcript in its true cwd slug instead. NOT a Claude Code behavior.

  // Windows file symlinks need Developer Mode / admin; skip these tests where the
  // OS forbids symlink creation (they run on CI/POSIX and on dev machines with it
  // enabled — the legacy app created 687 here, so it's enabled on the real one).
  const canSymlink = (() => {
    const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-symlink-probe-'));
    try {
      fs.writeFileSync(path.join(probeDir, 'target'), 'x');
      fs.symlinkSync('target', path.join(probeDir, 'link'), 'file');
      return true;
    } catch { return false; }
    finally { try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch {} }
  })();

  it.skipIf(!canSymlink)('skips a home-slug symlink and processes the real transcript in its true slug', () => {
    // Real transcript in its true cwd slug.
    writeTranscript(projectsDir, 'C--Users-desti-youcoded-dev', SID_A);
    // Legacy foreign-slug symlink in the HOME slug pointing at it.
    const homeDir = path.join(projectsDir, 'C--Users-desti');
    fs.mkdirSync(homeDir, { recursive: true });
    fs.symlinkSync(
      path.join('..', 'C--Users-desti-youcoded-dev', `${SID_A}.jsonl`),
      path.join(homeDir, `${SID_A}.jsonl`),
      'file',
    );

    return reconcile({ projectsDir, topicsDir, store, device: 'Dev1', mirror }).then(async (n) => {
      // Exactly one record — the symlink was skipped, the real file processed once.
      expect(n).toBe(1);
      const rec = await store.get('claude', SID_A);
      // 'youcoded-dev' slug last segment 'dev' — NOT the home basename 'desti'
      // (red before the fix, which followed the symlink and yielded 'desti').
      expect(rec!.projectName).toBe('dev');
      expect(rec!.transcriptRef).toBe(`claude/transcripts/dev/${SID_A}.jsonl`);
      // Mirrored once, from the REAL file in the youcoded-dev slug (not the link).
      expect(mirrorCalls).toHaveLength(1);
      expect(mirrorCalls[0].key).toBe('dev');
      expect(mirrorCalls[0].p).toBe(
        path.join(projectsDir, 'C--Users-desti-youcoded-dev', `${SID_A}.jsonl`),
      );
    });
  });

  it('a REAL file in the home slug (genuine home-dir session) is kept as the home basename', async () => {
    // No symlink — a session actually run from the home dir. lstat says regular
    // file, so it is processed and legitimately keyed 'desti'.
    writeTranscript(projectsDir, 'C--Users-desti', SID_A);
    const n = await reconcile({ projectsDir, topicsDir, store, device: 'Dev1', mirror });
    expect(n).toBe(1);
    const rec = await store.get('claude', SID_A);
    expect(rec!.projectName).toBe('desti');
  });
});

// Perf (2026-09-23): the scan runs at startup and every 30 minutes over EVERY
// transcript ever written, on the main process. It must not block the main
// thread with synchronous fs calls, and an unchanged transcript must not be
// tail-read again — while the results stay exactly what they were.
describe('reconcile — main-thread cost', () => {
  it('makes no synchronous fs call while scanning', async () => {
    writeTranscript(projectsDir, 'C--proj-alpha', SID_A);
    fs.writeFileSync(path.join(topicsDir, `topic-${SID_A}`), 'A topic');
    const knownFolder = path.join(tmp, 'alpha');
    fs.mkdirSync(knownFolder);
    const spies = (['readdirSync', 'lstatSync', 'statSync', 'readFileSync', 'realpathSync', 'existsSync', 'openSync', 'readSync'] as const)
      .map((m) => vi.spyOn(fs, m));
    const nativeSpy = vi.spyOn(fs.realpathSync, 'native');
    try {
      const n = await reconcile({ projectsDir, topicsDir, store, device: 'Dev1', mirror, knownFolders: [knownFolder] });
      expect(n).toBe(1);
      // Spy calls made by the store itself are out of scope — only the
      // reconciler's own transcript/topic/folder reads are pinned here.
      const ownPaths = (args: unknown[]) => typeof args[0] === 'string'
        && (args[0].startsWith(projectsDir) || args[0].startsWith(topicsDir) || args[0] === knownFolder);
      for (const spy of spies) expect(spy.mock.calls.filter(ownPaths)).toEqual([]);
      expect(nativeSpy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
      nativeSpy.mockRestore();
    }
    expect((await store.get('claude', SID_A))!.title).toBe('A topic');
  });

  it('a second pass over unchanged transcripts skips the tail read but gives identical results', async () => {
    writeTranscript(projectsDir, 'C--proj-alpha', SID_A);
    writeTranscript(projectsDir, 'C--proj-beta', SID_B);
    expect(await reconcile({ projectsDir, topicsDir, store, device: 'Dev1', mirror })).toBe(2);
    const before = await store.list('claude');
    mirrorCalls = [];

    const openSpy = vi.spyOn(fs.promises, 'open');
    try {
      expect(await reconcile({ projectsDir, topicsDir, store, device: 'Dev1', mirror })).toBe(0);
      const transcriptOpens = openSpy.mock.calls.filter(([p]) => String(p).startsWith(projectsDir));
      expect(transcriptOpens).toEqual([]);
    } finally {
      openSpy.mockRestore();
    }
    // Same records, and every transcript still mirrored, exactly as before.
    expect(await store.list('claude')).toEqual(before);
    expect(mirrorCalls.map((c) => c.sid).sort()).toEqual([SID_A, SID_B].sort());
  });

  it('a transcript that GREW since the last pass is re-read and its record advanced', async () => {
    const file = writeTranscript(projectsDir, 'C--proj-alpha', SID_A, { lastTimestamp: '2026-06-01T10:05:00Z' });
    await reconcile({ projectsDir, topicsDir, store, device: 'Dev1', mirror });
    fs.appendFileSync(file, jsonlLine({
      type: 'assistant', uuid: 'a2', timestamp: '2026-06-02T09:00:00Z',
      message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'more' }] },
    }));
    expect(await reconcile({ projectsDir, topicsDir, store, device: 'Dev1', mirror })).toBe(1);
    expect((await store.get('claude', SID_A))!.lastActive).toBe('2026-06-02T09:00:00.000Z');
  });
});
