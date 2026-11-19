// Pins the invisible data-safety fixes in first-run.ts (backup fixes 2026-11-18):
//   - setup_completed is written with the settings file kept whole: a file that cannot be read or parsed
//     is NEVER treated as "empty" and written back (that wiped the saved backup destinations);
//   - the settings file and the setup state file are written atomically (never left half-written);
//   - reaching the COMPLETE step records setup_completed (it was only ever written on a rare path).
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/main/logger', () => ({ log: vi.fn() }));
vi.mock('../src/main/network-check', () => ({ checkInternet: vi.fn(async () => true) }));
vi.mock('../src/main/prerequisite-installer', () => ({
  detectNode: vi.fn(), detectGit: vi.fn(), detectClaude: vi.fn(), detectAuth: vi.fn(),
  installNode: vi.fn(), installGit: vi.fn(), installClaude: vi.fn(), ensureNode: vi.fn(),
  startOAuthLogin: vi.fn(), pollAuthStatus: vi.fn(), submitApiKey: vi.fn(), checkDiskSpace: vi.fn(),
}));

const DIR = join(tmpdir(), `first-run-config-safety-${process.pid}`);
const CONFIG = join(DIR, 'config.json');
const STATE = join(DIR, 'first-run-state.json');

async function load() {
  process.env.YOUCODED_TOOLKIT_STATE_DIR = DIR;
  vi.resetModules();
  return import('../src/main/first-run');
}

beforeEach(() => { rmSync(DIR, { recursive: true, force: true }); mkdirSync(DIR, { recursive: true }); });
afterEach(() => { delete process.env.YOUCODED_TOOLKIT_STATE_DIR; rmSync(DIR, { recursive: true, force: true }); });

describe('markSetupCompleted keeps the settings file whole', () => {
  it('adds the flag and keeps the saved backup list', async () => {
    const backends = [{ id: 'drive-1', type: 'drive', label: 'My Drive', syncEnabled: true, config: {} }];
    writeFileSync(CONFIG, JSON.stringify({ storage_backends: backends }));
    const mod = await load();
    await mod.markSetupCompleted();
    const after = JSON.parse(readFileSync(CONFIG, 'utf8'));
    expect(after.setup_completed).toBe(true);
    expect(after.storage_backends).toEqual(backends);
  });

  it('creates the file when there is none yet (a fresh install)', async () => {
    const mod = await load();
    await mod.markSetupCompleted();
    expect(JSON.parse(readFileSync(CONFIG, 'utf8'))).toEqual({ setup_completed: true });
  });

  it('leaves a file it cannot parse exactly as it was — never "empty, then written back"', async () => {
    const damaged = '{"storage_backends":[{"id":"drive-1","type":"dr'; // cut off mid-write
    writeFileSync(CONFIG, damaged);
    const mod = await load();
    await mod.markSetupCompleted();
    expect(readFileSync(CONFIG, 'utf8')).toBe(damaged);
  });

  it.each([['zero-byte', ''], ['whitespace-only', ' \n  ']])('a %s file counts as empty (first run) and gets the flag', async (_name, content) => {
    writeFileSync(CONFIG, content);
    const mod = await load();
    await mod.markSetupCompleted();
    expect(JSON.parse(readFileSync(CONFIG, 'utf8'))).toEqual({ setup_completed: true });
  });

  it('leaves a file it cannot read exactly as it was (a folder where the file should be)', async () => {
    rmSync(CONFIG, { force: true });
    mkdirSync(CONFIG); // reading it fails with EISDIR, not ENOENT
    const mod = await load();
    await mod.markSetupCompleted();
    expect(statSync(CONFIG).isDirectory()).toBe(true); // untouched: nothing replaced it
  });

  it('writes through a temp file and leaves no temp file behind', async () => {
    writeFileSync(CONFIG, '{}');
    const mod = await load();
    await mod.markSetupCompleted();
    expect(readdirSync(DIR).filter((n) => n.includes('.tmp'))).toEqual([]);
  });
});

describe('setup state', () => {
  it('is saved whole, through a temp file, and in the order it was asked', async () => {
    const mod = await load();
    const m = new mod.FirstRunManager();
    m.forceStep('AUTHENTICATE');
    m.forceStep('COMPLETE');
    await mod.flushFirstRunWrites();
    expect(JSON.parse(readFileSync(STATE, 'utf8')).currentStep).toBe('COMPLETE');
    expect(readdirSync(DIR).filter((n) => n.includes('.tmp'))).toEqual([]);
  });

  it('reaching COMPLETE records setup_completed in the settings file', async () => {
    const mod = await load();
    const m = new mod.FirstRunManager();
    m.skip(); // moves the machine to COMPLETE
    await mod.flushFirstRunWrites();
    expect(JSON.parse(readFileSync(CONFIG, 'utf8')).setup_completed).toBe(true);
  });
});
