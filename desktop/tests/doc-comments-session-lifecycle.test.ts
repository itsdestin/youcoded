// Pins session-lifecycle.ts (extracted out of ipc-handlers.ts to keep that
// file under its own line budget): the pending-mutation queue start/stop
// wiring, and the T9c/T20 adversarial review's finding #3 — a session's own
// doc-comments MCP deploy directory (config + token) is deleted once that
// session exits.
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { wireDocCommentsSessionLifecycle } from '../src/main/doc-comments/session-lifecycle';

function fakeSessionManager() {
  return new EventEmitter();
}

describe('doc-comments MCP deploy directory cleanup on session-exit (finding #3)', () => {
  it('deletes the deploy directory once the session that owns it exits', async () => {
    const deployDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-doc-comments-deploy-cleanup-'));
    fs.writeFileSync(path.join(deployDir, 'mcp-config.json'), '{"mcpServers":{}}');
    expect(fs.existsSync(deployDir)).toBe(true);

    const manager = fakeSessionManager();
    wireDocCommentsSessionLifecycle(manager as any);

    manager.emit('doc-comments-mcp-attached', 'sess-cleanup', '/some/project', 'tok-123', 'youcoded-doc-comments-deadbeef', deployDir);
    expect(fs.existsSync(deployDir)).toBe(true); // not yet — the session hasn't exited

    manager.emit('session-exit', 'sess-cleanup', 0);
    // The cleanup is async (fire-and-forget, non-blocking-main-process) —
    // wait on the real signal (the directory disappearing), never a fixed
    // sleep, per this suite's own test-hygiene rule.
    await vi.waitFor(() => {
      if (fs.existsSync(deployDir)) throw new Error('deploy dir still exists');
    });
  });

  it('a session with no doc-comments deploy (deploy failed) exiting is a no-op, not a crash', () => {
    const manager = fakeSessionManager();
    wireDocCommentsSessionLifecycle(manager as any);

    expect(() => manager.emit('session-exit', 'never-attached', 0)).not.toThrow();
  });

  it('the queue start/stop wiring still fires alongside the deploy-dir cleanup', () => {
    const manager = fakeSessionManager();
    wireDocCommentsSessionLifecycle(manager as any);
    // No assertion on the queue's own internal state here (pending-mutation-
    // queue.test.ts owns that) — this just proves BOTH listeners this file
    // wires (queue lifecycle + deploy-dir cleanup) run off the SAME two
    // events without one throwing and skipping the other.
    const deployDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-doc-comments-deploy-cleanup-both-'));
    expect(() => {
      manager.emit('doc-comments-mcp-attached', 'sess-both', os.tmpdir(), 'tok-both', 'youcoded-doc-comments-deadbeef', deployDir);
      manager.emit('session-exit', 'sess-both', 0);
    }).not.toThrow();
  });
});
