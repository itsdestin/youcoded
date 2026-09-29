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

  // Fix round 5: "Save a copy…" refuses any file Office still holds — including one whose close
  // is still draining its last save, and one whose open is still waiting for that close.
  it('counts a file as in use while its close drains and while a re-open waits', async () => {
    let release!: () => void;
    const held = createSessions(tempBase, { drain: () => new Promise<void>((r) => (release = r)) });
    const s = await held.open('/docs/report.docx', 1);
    expect(held.inUse('/docs/report.docx')).toBe(true);
    const closed = held.close(s.token);
    expect(held.byPath('/docs/report.docx')).toBeUndefined();
    expect(held.inUse('/docs/report.docx')).toBe(true); // draining
    const reopened = held.open('/docs/report.docx', 1); // waits for the drain
    release();
    await closed;
    const again = await reopened;
    expect(held.inUse('/docs/report.docx')).toBe(true);
    const closedAgain = held.close(again.token);
    release();
    await closedAgain;
    await new Promise((r) => setTimeout(r, 0));
    expect(held.inUse('/docs/report.docx')).toBe(false);
    expect(held.inUse('/docs/nope.docx')).toBe(false);
  });

  it('counts a file as in use while its first open is still under way', async () => {
    const opening = sessions.open('/docs/new.docx', 1);
    expect(sessions.inUse('/docs/new.docx')).toBe(true);
    await opening;
    expect(sessions.inUse('/docs/new.docx')).toBe(true);
  });

  it('makes an open of a file wait while that file is held (a restore of it is running)', async () => {
    let release!: () => void;
    const held = sessions.holdWhile('/docs/report.docx', () => new Promise<string>((r) => { release = () => r('restored'); }));
    expect(sessions.inUse('/docs/report.docx')).toBe(true);
    let opened = false;
    const opening = sessions.open('/docs/report.docx', 1).then((s) => { opened = true; return s; });
    await new Promise((r) => setImmediate(r));
    expect(opened).toBe(false);
    release();
    await expect(held).resolves.toBe('restored');
    await opening;
    expect(opened).toBe(true);
  });
});
