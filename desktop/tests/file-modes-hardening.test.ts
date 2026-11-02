// Security hardening 2026-10-30: private files stay private (owner-only) and shared-temp folders
// cannot be squatted. POSIX permission bits only exist off Windows.
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { atomicWrite } from '../src/main/atomic-write';
import { ensurePrivateTempDir, privateTempDirOrFresh } from '../src/main/private-temp-dir';

const posix = process.platform !== 'win32';
const mode = (p: string) => fs.statSync(p).mode & 0o777;
const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-modes-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); vi.resetModules(); });

describe.skipIf(!posix)('atomicWrite with a mode', () => {
  it('replaces a world-readable file with an owner-only one (the ~/.claude.json case)', async () => {
    const f = path.join(tmp(), 'claude.json');
    fs.writeFileSync(f, '{}', { mode: 0o644 });
    fs.chmodSync(f, 0o644);
    await atomicWrite(f, '{"a":1}', { mode: 0o600 });
    expect(mode(f)).toBe(0o600);
    expect(fs.readFileSync(f, 'utf8')).toBe('{"a":1}');
  });
  it('stays owner-only even under a permissive umask', async () => {
    const old = process.umask(0o000);
    try {
      const f = path.join(tmp(), 'x.json');
      await atomicWrite(f, 'x', { mode: 0o600 });
      expect(mode(f)).toBe(0o600);
    } finally { process.umask(old); }
  });
  it('without a mode, behaves as before (no chmod surprise for other callers)', async () => {
    const f = path.join(tmp(), 'y.json');
    await atomicWrite(f, 'y');
    expect(fs.readFileSync(f, 'utf8')).toBe('y');
  });
});

describe.skipIf(!posix)('the MCP reconciler writes ~/.claude.json owner-only', () => {
  it('passes mode 0600 to atomicWrite', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'mcp-reconciler.ts'), 'utf8');
    expect(src).toMatch(/atomicWrite\(CLAUDE_JSON, JSON\.stringify\(data, null, 2\), \{ mode: 0o600 \}\)/);
  });
});

describe.skipIf(!posix)('desktop.log is owner-only', () => {
  it('is created 0600, and an old 0644 log is tightened at launch', async () => {
    const home = tmp();
    fs.mkdirSync(path.join(home, '.claude'));
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    try {
      vi.resetModules();
      const { log, rotateLog } = await import('../src/main/logger');
      log('INFO', 'T', 'hello');
      const logPath = path.join(home, '.claude', 'desktop.log');
      // WHY: wait for the log file to appear instead of guessing a delay (flaky on a busy machine).
      await vi.waitFor(() => expect(mode(logPath)).toBe(0o600));
      fs.chmodSync(logPath, 0o644);
      await rotateLog();
      expect(mode(logPath)).toBe(0o600);
    } finally { process.env.HOME = oldHome; }
  });
});

describe.skipIf(!posix)('private temp folders', () => {
  it('creates an owner-only folder', async () => {
    const d = path.join(tmp(), 'uploads');
    await ensurePrivateTempDir(d);
    expect(mode(d)).toBe(0o700);
  });
  it('tightens an existing loose folder of ours', async () => {
    const d = path.join(tmp(), 'uploads');
    fs.mkdirSync(d); fs.chmodSync(d, 0o755);
    await ensurePrivateTempDir(d);
    expect(mode(d)).toBe(0o700);
  });
  it('refuses a link standing in for the folder (a squatter\'s doorway)', async () => {
    const base = tmp();
    const real = path.join(base, 'theirs'); fs.mkdirSync(real);
    const link = path.join(base, 'uploads'); fs.symlinkSync(real, link, 'dir');
    await expect(ensurePrivateTempDir(link)).rejects.toThrow(/not private/);
  });
  it('privateTempDirOrFresh uses an unpredictable fresh folder when the usual name is taken', async () => {
    const base = tmp();
    const real = path.join(base, 'theirs'); fs.mkdirSync(real);
    const link = path.join(base, 'attachments'); fs.symlinkSync(real, link, 'dir');
    const used = await privateTempDirOrFresh(link);
    expect(used).not.toBe(link);
    expect(used.startsWith(link + '-')).toBe(true);
    expect(mode(used)).toBe(0o700);
    dirs.push(used);
  });
});
