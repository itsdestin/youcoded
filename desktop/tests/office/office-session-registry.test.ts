import path from 'node:path';
import { promises as fsp } from 'node:fs';
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
    vi.restoreAllMocks();
    mod = await import('../../src/main/office/office-session-registry');
    createdBases = [];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const base of createdBases) await rm(base, { recursive: true, force: true, maxRetries: 3 });
  });

  it('hands out no sessions before initOfficeSessions() has run', () => {
    expect(mod.getOfficeSessions()).toBeNull();
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
    expect(mod.getOfficeSessions()?.get(session.token)).toBe(session);
  });

  // WHY this — not the older "two createSessions() calls with different bases" test in
  // office-sessions.test.ts (removed, fix round 2) — is what actually pins the per-instance
  // fix: createSessions() has always taken an explicit base and isolated by it. What changed
  // in fix round 1 is THIS module no longer building its singleton against one fixed path, so
  // two separate app instances (simulated here as two fresh module loads, the way a dev
  // instance and the live app are two separate processes) must land on different,
  // non-overlapping bases.
  it('gives two separate app instances of this registry non-overlapping bases', async () => {
    const sessionsA = await mod.initOfficeSessions();
    const openedA = await sessionsA.open('/docs/a.docx', 1);
    const baseA = path.dirname(openedA.temp);
    createdBases.push(baseA);

    vi.resetModules();
    const modB: typeof import('../../src/main/office/office-session-registry') = await import(
      '../../src/main/office/office-session-registry'
    );
    const sessionsB = await modB.initOfficeSessions();
    const openedB = await sessionsB.open('/docs/b.docx', 1);
    const baseB = path.dirname(openedB.temp);
    createdBases.push(baseB);

    expect(baseA).not.toBe(baseB);
    expect(baseB.startsWith(baseA)).toBe(false);
    expect(baseA.startsWith(baseB)).toBe(false);
    // Instance B's registry cannot see instance A's session (different registries, and its
    // token was never opened against B).
    expect(modB.getOfficeSessions()?.get(openedA.token)).toBeUndefined();
  });

  it('removes the instance temp base on cleanup', async () => {
    const sessions = await mod.initOfficeSessions();
    const session = await sessions.open('/docs/a.docx', 1);
    const base = path.dirname(session.temp);
    await mod.cleanupOfficeSessions();
    await expect(stat(base)).rejects.toThrow();
  });

  it('stops handing out the registry once cleanup has run, so a later caller cannot reopen into the removed base', async () => {
    const sessions = await mod.initOfficeSessions();
    const session = await sessions.open('/docs/a.docx', 1);
    createdBases.push(path.dirname(session.temp));
    await mod.cleanupOfficeSessions();
    expect(mod.getOfficeSessions()).toBeNull();
  });

  it('does nothing (not throw) if cleanup runs before any init', async () => {
    await expect(mod.cleanupOfficeSessions()).resolves.toBeUndefined();
  });

  // Item 1 (fix round 2): initOfficeSessionsSafely() must never let a failed mkdtemp (a full,
  // unwritable or policy-blocked temp dir) escape as an unhandled rejection into startup code.
  describe('initOfficeSessionsSafely()', () => {
    it('resolves to null instead of throwing when the temp base cannot be created', async () => {
      vi.spyOn(fsp, 'mkdtemp').mockRejectedValueOnce(new Error('ENOSPC: no space left on device'));
      await expect(mod.initOfficeSessionsSafely()).resolves.toBeNull();
    });

    it('leaves getOfficeSessions() answering "not available" after a failed init', async () => {
      vi.spyOn(fsp, 'mkdtemp').mockRejectedValueOnce(new Error('EACCES: permission denied'));
      await mod.initOfficeSessionsSafely();
      expect(mod.getOfficeSessions()).toBeNull();
    });

    it('returns a working registry on success, same as initOfficeSessions()', async () => {
      const sessions = await mod.initOfficeSessionsSafely();
      expect(sessions).not.toBeNull();
      const session = await sessions!.open('/docs/a.docx', 1);
      createdBases.push(path.dirname(session.temp));
      expect(mod.getOfficeSessions()?.get(session.token)).toBe(session);
    });
  });
});
