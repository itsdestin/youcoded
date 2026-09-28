import path from 'node:path';
import { rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Pins the per-instance temp base (fix round 1, review of Task 3): the registry must not
// hand out sessions before it has its own base, and must make that base unguessable and
// disposable rather than a fixed shared path.
describe('office session registry lifecycle', () => {
  let mod: typeof import('../../src/main/office/office-session-registry');
  let createdBases: string[] = [];

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../../src/main/office/office-session-registry');
    createdBases = [];
  });

  afterEach(async () => {
    for (const base of createdBases) await rm(base, { recursive: true, force: true, maxRetries: 3 });
  });

  it('refuses to hand out sessions before initOfficeSessions() has run', () => {
    expect(() => mod.getOfficeSessions()).toThrow();
  });

  it('creates a fresh, randomly-suffixed temp base under the OS temp dir on init', async () => {
    const sessions = await mod.initOfficeSessions();
    const session = await sessions.open('/docs/a.docx', 1);
    const base = path.dirname(session.temp);
    createdBases.push(base);
    expect(base.startsWith(path.join(tmpdir(), 'youcoded-office-'))).toBe(true);
    // WHY not the fixed old name: a shared os.tmpdir()/youcoded-office let a dev instance
    // and the live app collide on the same folder.
    expect(base).not.toBe(path.join(tmpdir(), 'youcoded-office'));
  });

  it('returns the same sessions instance initOfficeSessions() built', async () => {
    const sessions = await mod.initOfficeSessions();
    const session = await sessions.open('/docs/a.docx', 1);
    createdBases.push(path.dirname(session.temp));
    expect(mod.getOfficeSessions().get(session.token)).toBe(session);
  });

  it('removes the instance temp base on cleanup', async () => {
    const sessions = await mod.initOfficeSessions();
    const session = await sessions.open('/docs/a.docx', 1);
    const base = path.dirname(session.temp);
    await mod.cleanupOfficeSessions();
    await expect(stat(base)).rejects.toThrow();
  });

  it('does nothing (not throw) if cleanup runs before any init', async () => {
    await expect(mod.cleanupOfficeSessions()).resolves.toBeUndefined();
  });
});
