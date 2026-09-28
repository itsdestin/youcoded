import path from 'node:path';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSessions } from '../../src/main/office/office-sessions';

// Pins the session registry behind office:// (design §3a, R2-1/R2-2): one
// unguessable token and one temp dir per open document, closed and swept
// independently.
describe('office session registry', () => {
  let tempBase: string;
  let sessions: ReturnType<typeof createSessions>;

  beforeEach(async () => {
    tempBase = await mkdtemp(path.join(tmpdir(), 'office-sessions-test-'));
    sessions = createSessions(tempBase);
  });

  afterEach(async () => {
    await rm(tempBase, { recursive: true, force: true, maxRetries: 3 });
  });

  it('opens a session with a 32-hex token and an existing temp dir', async () => {
    const session = await sessions.open('/docs/report.docx', 1);
    expect(session.token).toMatch(/^[0-9a-f]{32}$/);
    expect(session.path).toBe('/docs/report.docx');
    expect(session.senderId).toBe(1);
    expect(session.modified).toBe(false);
    const info = await stat(session.temp);
    expect(info.isDirectory()).toBe(true);
  });

  it('gives two opens different tokens and different temp dirs', async () => {
    const a = await sessions.open('/docs/a.docx', 1);
    const b = await sessions.open('/docs/b.docx', 1);
    expect(a.token).not.toBe(b.token);
    expect(a.temp).not.toBe(b.temp);
  });

  it('removes the temp dir and forgets the session on close', async () => {
    const session = await sessions.open('/docs/report.docx', 1);
    await sessions.close(session.token);
    expect(sessions.get(session.token)).toBeUndefined();
    await expect(stat(session.temp)).rejects.toThrow();
  });

  it('closes only the given sender\'s sessions with closeAllFor', async () => {
    const mine = await sessions.open('/docs/mine.docx', 7);
    const theirs = await sessions.open('/docs/theirs.docx', 9);
    await sessions.closeAllFor(7);
    expect(sessions.get(mine.token)).toBeUndefined();
    expect(sessions.get(theirs.token)).toBeDefined();
    await expect(stat(mine.temp)).rejects.toThrow();
    const info = await stat(theirs.temp);
    expect(info.isDirectory()).toBe(true);
  });

  it('finds an open session by its file path with byPath', async () => {
    const session = await sessions.open('/docs/report.docx', 1);
    expect(sessions.byPath('/docs/report.docx')?.token).toBe(session.token);
    expect(sessions.byPath('/docs/nope.docx')).toBeUndefined();
  });
});

// WHY (fix round 1, review of Task 3): the per-instance temp base fix means two
// createSessions() calls with different bases (one per app instance) must never be able to
// read or remove each other's dirs — the whole point of moving off one shared fixed path.
describe('two registries built from different bases', () => {
  let baseA: string;
  let baseB: string;

  beforeEach(async () => {
    baseA = await mkdtemp(path.join(tmpdir(), 'office-sessions-a-'));
    baseB = await mkdtemp(path.join(tmpdir(), 'office-sessions-b-'));
  });

  afterEach(async () => {
    await rm(baseA, { recursive: true, force: true, maxRetries: 3 });
    await rm(baseB, { recursive: true, force: true, maxRetries: 3 });
  });

  it('keeps each registry\'s sessions confined to its own base dir', async () => {
    const a = createSessions(baseA);
    const b = createSessions(baseB);
    const sessionA = await a.open('/docs/a.docx', 1);
    const sessionB = await b.open('/docs/b.docx', 1);

    expect(sessionA.temp.startsWith(baseA)).toBe(true);
    expect(sessionB.temp.startsWith(baseB)).toBe(true);
    expect(sessionA.temp.startsWith(baseB)).toBe(false);
    expect(sessionB.temp.startsWith(baseA)).toBe(false);
  });

  it('lets closing one registry\'s sessions leave the other registry untouched', async () => {
    const a = createSessions(baseA);
    const b = createSessions(baseB);
    const sessionA = await a.open('/docs/a.docx', 1);
    const sessionB = await b.open('/docs/b.docx', 1);

    await a.closeAllFor(1);

    expect(a.get(sessionA.token)).toBeUndefined();
    expect(b.get(sessionB.token)).toBeDefined();
    const info = await stat(sessionB.temp);
    expect(info.isDirectory()).toBe(true);
  });
});
