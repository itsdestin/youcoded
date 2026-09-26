// Pins the shared docComments:* projectRoot gate (post-T3 build review,
// finding F1 — blocker): docs/active/specs/2026-09-26-doc-comments-build-
// design.md §1.5 assumed `projectRoot` was already a root the app recognized
// before the store's own containment check ran against it — nothing ever
// enforced that assumption. `refuseUnknownProjectRoot` is the ONE place that
// now does: reused identically by desktop (doc-comments/ipc-handlers.ts) and
// remote (remote-server.ts), so this file exercises it directly rather than
// through either transport's own plumbing.
//
// RED-BEFORE-GREEN: before this fix, `doc-comments-gate.ts` did not exist —
// every test in this file (and the corresponding new cases in
// doc-comments-ipc-handlers.test.ts / doc-comments-remote-relay.test.ts)
// fails to even import against the pre-fix commit (58ee463df).
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { refuseUnknownProjectRoot } from '../src/main/doc-comments/doc-comments-gate';

describe('refuseUnknownProjectRoot', () => {
  it('proceeds (returns null) when projectRoot is not supplied at all', async () => {
    await expect(refuseUnknownProjectRoot(undefined)).resolves.toBeNull();
  });

  it('refuses "/" — the exact forged root the finding names: containment against an unvetted root is a no-op', async () => {
    await expect(refuseUnknownProjectRoot('/')).resolves.toEqual({ ok: false, error: 'unknown-project-root' });
  });

  it('refuses $HOME the same way', async () => {
    await expect(refuseUnknownProjectRoot(os.homedir())).resolves.toEqual({ ok: false, error: 'unknown-project-root' });
  });

  it('refuses an ordinary temp directory that was never registered as a saved folder, an indexed project, or a live session root', async () => {
    const forged = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-doc-comments-gate-forged-'));
    try {
      await expect(refuseUnknownProjectRoot(forged)).resolves.toEqual({ ok: false, error: 'unknown-project-root' });
    } finally {
      await fs.promises.rm(forged, { recursive: true, force: true });
    }
  });

  it('accepts a root that is one of the caller-supplied live session roots, even when it is not a saved folder or indexed project', async () => {
    const sessionCwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-doc-comments-gate-session-'));
    try {
      await expect(refuseUnknownProjectRoot(sessionCwd, [sessionCwd])).resolves.toBeNull();
    } finally {
      await fs.promises.rm(sessionCwd, { recursive: true, force: true });
    }
  });

  it('still refuses when extraSessionRoots is non-empty but does not contain the named root', async () => {
    const forged = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-doc-comments-gate-forged2-'));
    const unrelatedSession = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-doc-comments-gate-unrelated-'));
    try {
      await expect(refuseUnknownProjectRoot(forged, [unrelatedSession])).resolves.toEqual({ ok: false, error: 'unknown-project-root' });
    } finally {
      await fs.promises.rm(forged, { recursive: true, force: true });
      await fs.promises.rm(unrelatedSession, { recursive: true, force: true });
    }
  });
});
