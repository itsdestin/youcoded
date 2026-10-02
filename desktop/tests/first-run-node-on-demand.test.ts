// Pins "Git for everyone, Node.js on demand" (Destin, 2026-10-02):
//
//   - Setup installs Git and NOT Node.js on a machine with no Claude sign-in;
//     the Node.js row is marked skipped so the checklist and the progress bar
//     never wait on it.
//   - A machine already signed in to Claude Code skips the sign-in step, so
//     setup installs Node.js for it there.
//   - "Log in with Claude" installs Node.js before Claude Code; if Node.js
//     fails, Claude Code is not installed and the message names Node.js.
import { rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Keep FirstRunManager's saved state out of the real ~/.claude (see
// first-run-chatgpt.test.ts for the same pattern).
vi.mock('os', async (importOriginal) => {
  const real = await importOriginal<typeof import('os')>();
  const pathMod = await import('path');
  const home = pathMod.join(real.tmpdir(), `first-run-node-test-home-${process.pid}`);
  return { ...real, default: { ...real, homedir: () => home }, homedir: () => home };
});
vi.mock('../src/main/logger', () => ({ log: vi.fn() }));
vi.mock('../src/main/prerequisite-installer', () => ({
  detectNode: vi.fn(), detectGit: vi.fn(), detectClaude: vi.fn(), detectAuth: vi.fn(),
  installNode: vi.fn(), installGit: vi.fn(), installClaude: vi.fn(), ensureNode: vi.fn(),
  startOAuthLogin: vi.fn(), pollAuthStatus: vi.fn(), submitApiKey: vi.fn(),
  checkDiskSpace: vi.fn(),
}));

import * as prereq from '../src/main/prerequisite-installer';
import { FirstRunManager } from '../src/main/first-run';

const SCRATCH_HOME = join(tmpdir(), `first-run-node-test-home-${process.pid}`);
const m = vi.mocked(prereq);

function row(fr: FirstRunManager, name: string) {
  return fr.getState().prerequisites.find((p) => p.name === name)!;
}

beforeEach(() => {
  rmSync(SCRATCH_HOME, { recursive: true, force: true });
  vi.clearAllMocks();
  m.checkDiskSpace.mockReturnValue({ sufficient: true, availableMB: 10_000 });
  m.detectNode.mockResolvedValue({ installed: false });
  m.detectClaude.mockResolvedValue({ installed: false });
  m.detectAuth.mockResolvedValue({ installed: false });
  // Git: missing at first, present once installGit has run.
  let gitInstalled = false;
  m.detectGit.mockImplementation(async () => ({ installed: gitInstalled, version: gitInstalled ? 'git 2.56' : undefined }));
  m.installGit.mockImplementation(async () => { gitInstalled = true; return { success: true }; });
  m.installNode.mockResolvedValue({ success: true });
});
afterEach(() => { rmSync(SCRATCH_HOME, { recursive: true, force: true }); });

describe('setup installs Git for everyone and Node.js on demand', () => {
  it('a machine with no Claude sign-in gets Git only, and Node.js is skipped', async () => {
    const fr = new FirstRunManager();
    await fr.run();

    expect(m.installGit).toHaveBeenCalledTimes(1);
    expect(m.installNode).not.toHaveBeenCalled();
    expect(row(fr, 'git').status).toBe('installed');
    expect(row(fr, 'node').status).toBe('skipped');
    expect(fr.getState().currentStep).toBe('AUTHENTICATE');
    // Skipped rows don't hold the bar back: Git done, sign-in to go = half.
    expect(fr.getState().overallProgress).toBe(45);
  });

  it('a machine already signed in to Claude Code gets Node.js during setup', async () => {
    m.detectAuth.mockResolvedValue({ installed: true });
    let nodeInstalled = false;
    m.detectNode.mockImplementation(async () => ({ installed: nodeInstalled }));
    m.installNode.mockImplementation(async () => { nodeInstalled = true; return { success: true }; });

    const fr = new FirstRunManager();
    await fr.run();

    expect(m.installNode).toHaveBeenCalledTimes(1);
    expect(row(fr, 'node').status).toBe('installed');
  });
});

describe('"Log in with Claude" installs Node.js first', () => {
  it('installs Node.js, then Claude Code', async () => {
    const order: string[] = [];
    m.ensureNode.mockImplementation(async () => { order.push('node'); return { success: true }; });
    m.installClaude.mockImplementation(async () => { order.push('claude'); return { success: true }; });
    m.startOAuthLogin.mockReturnValue({ url: null, kill: vi.fn() } as never);

    const fr = new FirstRunManager();
    fr.forceStep('AUTHENTICATE');
    await fr.handleOAuthLogin();

    expect(order).toEqual(['node', 'claude']);
  });

  it('a failed Node.js install stops before Claude Code and says so', async () => {
    m.ensureNode.mockResolvedValue({ success: false, error: 'offline' });

    const fr = new FirstRunManager();
    fr.forceStep('AUTHENTICATE');
    const result = await fr.handleOAuthLogin();

    expect(result.url).toBeNull();
    expect(m.installClaude).not.toHaveBeenCalled();
    expect(fr.getState().lastError).toMatch(/Node\.js/);
    expect(fr.getState().authMode).toBe('none');
    // The card must not keep showing "Installing Claude Code…".
    expect(row(fr, 'claude').status).not.toBe('installing');
  });
});
