// Pins the fix (found on the first real-data run, 2026-08-15): runSlugRepair's
// default knownFolders assembly must match runReconcile's (conversations/service.ts
// runReconcile) EXACTLY — managed projects FIRST, then saved folders, each source
// individually try-guarded. Before the fix, runSlugRepair only read saved folders
// (~/.claude/youcoded-folders.json), so a MANAGED-only project (never saved) was
// invisible to the repair even though the reconciler buckets by it — the repair
// silently did nothing for that project's mis-filed data. This is a mirror of
// conversations-service.test.ts's "passes managed + saved folder paths as
// knownFolders to the reconciler" test, for the repair side of the same contract.
//
// Isolated in its own file (per the fix plan) because vi.mock on
// sync-spaces/service and saved-folders is module-scoped — slug-repair.test.ts's
// other runSlugRepair tests pass an explicit knownFolders override and must not
// be disturbed by these mocks.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { ccProjectSlug } from '../src/main/slug-encoding';
import { createConversationStore } from '../src/main/conversations/conversation-store';

// vi.mock factories are hoisted above imports, so shared fake state is created
// via vi.hoisted for the factories to close over.
const h = vi.hoisted(() => ({
  managedProjects: [] as Array<{ name: string; path: string }>,
  savedFolders: [] as Array<{ path: string }>,
}));

vi.mock('../src/main/sync-spaces/service', () => ({
  getManagedRoots: () => ({ listProjects: () => h.managedProjects, personalRoot: '' }),
}));
vi.mock('../src/main/saved-folders', () => ({
  readFolders: () => h.savedFolders,
}));

import { runSlugRepair, Quarantine } from '../src/main/conversations/slug-repair';

describe('runSlugRepair default knownFolders — managed projects + saved folders (matches runReconcile)', () => {
  const F = (uuid: string, cwd: string) => JSON.stringify({ type: 'user', uuid, cwd }) + '\n';
  const old = new Date(Date.now() - 60 * 60 * 1000); // aged past LIVE_MTIME_MS so 6.1 doesn't defer it
  let home = '';

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'r-known-'));
    h.managedProjects = [];
    h.savedFolders = [];
  });
  afterEach(() => {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('reaches a MANAGED project that is not in saved folders — moves the mis-filed transcript into it', async () => {
    const P = path.join(home, 'PAF 574 - Something');
    fs.mkdirSync(P, { recursive: true });
    h.managedProjects = [{ name: path.basename(P), path: P }];
    h.savedFolders = []; // NOT saved — the exact gap that hid the project on the real device

    const projectsDir = path.join(home, '.claude', 'projects');
    const homeSlugDir = path.join(projectsDir, ccProjectSlug(home));
    fs.mkdirSync(homeSlugDir, { recursive: true });
    const wrong = path.join(homeSlugDir, 's1.jsonl');
    fs.writeFileSync(wrong, F('u1', P));
    fs.utimesSync(wrong, old, old);

    const correctDir = path.join(projectsDir, ccProjectSlug(P)); // exists but empty
    fs.mkdirSync(correctDir, { recursive: true });

    const spaceRoot = path.join(home, 'Conversations');
    fs.mkdirSync(path.join(spaceRoot, 'claude', 'transcripts'), { recursive: true });
    const store = createConversationStore(spaceRoot);
    const quarantine = new Quarantine(home);
    const stateFile = path.join(home, '.youcoded', 'state.json');

    // NOTE: no knownFolders override — this is the point of the test. It must
    // come from runSlugRepair's own default assembly reaching the mocked
    // getManagedRoots()/readFolders() the same way runReconcile does.
    await runSlugRepair({ projectsDir, homeDir: home, store, spaceRoot, stateFile, quarantine });

    expect(fs.existsSync(path.join(correctDir, 's1.jsonl'))).toBe(true); // moved to the managed project
    expect(fs.existsSync(wrong)).toBe(false);                            // no longer at the $HOME slug dir
  });

  it('mirror-negative: no managed projects and no saved folders — knownFolders is empty, run is a no-op', async () => {
    h.managedProjects = [];
    h.savedFolders = [];
    const P = path.join(home, 'Some Project');
    fs.mkdirSync(P, { recursive: true });

    const projectsDir = path.join(home, '.claude', 'projects');
    const homeSlugDir = path.join(projectsDir, ccProjectSlug(home));
    fs.mkdirSync(homeSlugDir, { recursive: true });
    const wrong = path.join(homeSlugDir, 's2.jsonl');
    fs.writeFileSync(wrong, F('u1', P));
    fs.utimesSync(wrong, old, old);

    const correctDir = path.join(projectsDir, ccProjectSlug(P));
    fs.mkdirSync(correctDir, { recursive: true });

    const spaceRoot = path.join(home, 'Conversations');
    fs.mkdirSync(path.join(spaceRoot, 'claude', 'transcripts'), { recursive: true });
    const store = createConversationStore(spaceRoot);
    const quarantine = new Quarantine(home);
    const stateFile = path.join(home, '.youcoded', 'state.json');

    await runSlugRepair({ projectsDir, homeDir: home, store, spaceRoot, stateFile, quarantine });

    expect(fs.existsSync(wrong)).toBe(true);                              // untouched
    expect(fs.existsSync(path.join(correctDir, 's2.jsonl'))).toBe(false); // nothing moved
  });
});

// The repair re-derived every transcript's first cwd on every launch (~3,300
// reads on a big history). It now remembers each answer per file (size +
// modified time), so the next launch reads only what changed — with the same
// outcome.
describe('runSlugRepair remembers first cwds between launches', () => {
  const F = (uuid: string, cwd: string) => JSON.stringify({ type: 'user', uuid, cwd }) + '\n';
  let home = '';
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'r-cwdcache-')); h.managedProjects = []; h.savedFolders = []; });
  afterEach(() => { vi.restoreAllMocks(); try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ } });

  it('a second launch opens only the transcript that changed', async () => {
    const P = path.join(home, 'proj');
    fs.mkdirSync(P, { recursive: true });
    h.managedProjects = [{ name: 'proj', path: P }];
    const projectsDir = path.join(home, '.claude', 'projects');
    const correctDir = path.join(projectsDir, ccProjectSlug(P));
    fs.mkdirSync(correctDir, { recursive: true });
    const files = ['a', 'b', 'c'].map((n) => { const f = path.join(correctDir, `${n}.jsonl`); fs.writeFileSync(f, F(`u-${n}`, P)); return f; });
    const spaceRoot = path.join(home, 'Conversations');
    fs.mkdirSync(path.join(spaceRoot, 'claude', 'transcripts'), { recursive: true });
    fs.mkdirSync(path.join(home, '.youcoded'), { recursive: true }); // the app's private home always exists
    const run = () => runSlugRepair({ projectsDir, homeDir: home, store: createConversationStore(spaceRoot), spaceRoot, stateFile: path.join(home, '.youcoded', 'state.json'), quarantine: new Quarantine(home) });

    const open = vi.spyOn(fs.promises, 'open');
    const opened = (f: string) => open.mock.calls.filter(([p]) => String(p) === f).length;
    await run();
    expect(files.every((f) => opened(f) >= 1)).toBe(true);   // non-vacuous: first launch read them
    open.mockClear();

    fs.appendFileSync(files[1], F('u-b2', P));                // one transcript changes
    await run();
    expect(opened(files[0])).toBe(0);
    expect(opened(files[2])).toBe(0);
    expect(opened(files[1])).toBeGreaterThanOrEqual(1);
  });

  it('remembers "no usable folder" (a Windows-made transcript on Linux) but never a failed read', async () => {
    // POSIX only (the foreign case is a drive-letter path there), and not as root,
    // for whom chmod 000 does not make a file unreadable.
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const P = path.join(home, 'proj');
    fs.mkdirSync(P, { recursive: true });
    h.managedProjects = [{ name: 'proj', path: P }];
    const projectsDir = path.join(home, '.claude', 'projects');
    const correctDir = path.join(projectsDir, ccProjectSlug(P));
    fs.mkdirSync(correctDir, { recursive: true });
    const foreign = path.join(correctDir, 'win.jsonl');
    fs.writeFileSync(foreign, F('u-w', 'C:\\Users\\x\\proj'));
    const locked = path.join(correctDir, 'locked.jsonl');
    fs.writeFileSync(locked, F('u-l', P));
    fs.chmodSync(locked, 0o000);                               // unreadable on the first launch
    const spaceRoot = path.join(home, 'Conversations');
    fs.mkdirSync(path.join(spaceRoot, 'claude', 'transcripts'), { recursive: true });
    fs.mkdirSync(path.join(home, '.youcoded'), { recursive: true });
    const run = () => runSlugRepair({ projectsDir, homeDir: home, store: createConversationStore(spaceRoot), spaceRoot, stateFile: path.join(home, '.youcoded', 'state.json'), quarantine: new Quarantine(home) });

    const open = vi.spyOn(fs.promises, 'open');
    const opened = (f: string) => open.mock.calls.filter(([p]) => String(p) === f).length;
    try {
      await run();
      expect(opened(foreign)).toBeGreaterThanOrEqual(1);
      expect(opened(locked)).toBeGreaterThanOrEqual(1);
      open.mockClear();
      fs.chmodSync(locked, 0o644);                             // readable now; size and time unchanged
      await run();
      expect(opened(foreign)).toBe(0);                         // "no usable folder" was remembered
      expect(opened(locked)).toBeGreaterThanOrEqual(1);        // the failed read was not
    } finally { fs.chmodSync(locked, 0o644); }
  });
});
