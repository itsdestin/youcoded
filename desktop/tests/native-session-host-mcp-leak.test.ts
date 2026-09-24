// Fix pass 1 / Finding 3 — dedicated file (not native-session-host.test.ts)
// because it mocks HarnessSession's CONSTRUCTOR to throw, which vi.mock hoists
// to module scope and would poison every other test in the shared suite (most
// of which reach into `(h as any).live.get(id).session` and call real methods
// on it). Isolating the mock to its own file keeps that blast radius to zero.
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs'; import * as path from 'path'; import * as os from 'os';

// Replace HarnessSession with a stand-in whose constructor always throws, so
// NativeSessionHost.create()/resume() hit the fallible-construction window
// (acquire() already ran; wire() never gets a chance to register the id in
// `this.live`) without needing to find a real code path that fails.
vi.mock('../src/main/harness/harness-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/harness/harness-session')>();
  return {
    ...actual,
    HarnessSession: class {
      constructor() { throw new Error('boom — session construction failed'); }
    },
  };
});

import { NativeHome } from '../src/main/native-home';
import { SessionStore } from '../src/main/harness/session-store';
import { NativeSessionHost } from '../src/main/harness/native-session-host';

describe('NativeSessionHost — MCP acquire/release leak guard', () => {
  it('releases the acquired MCP hold when create() throws before wire()', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-host-leak-'));
    const release = vi.fn(async () => {});
    // release() lives on the lease acquire() returns, not on the manager —
    // see McpLease in mcp-manager.ts.
    const acquire = vi.fn(async () => ({ servers: [], release }));
    const h = new NativeSessionHost(
      new SessionStore(new NativeHome(root)),
      (async () => { throw new Error('modelFactory unused in this test'); }) as any,
      async () => ({ contextLength: null, totalSlots: null }), async () => null, async () => null, undefined,
      undefined, undefined, undefined, undefined,
      { destroyAll: async () => {}, acquire },
    );

    // The ORIGINAL error must surface unchanged (docs/error-message-standards.md
    // — never wrap or reword a caught error), and the mcp hold acquired just
    // before construction must be released rather than stranded.
    await expect(
      h.create({ sessionId: 's-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } }),
    ).rejects.toThrow('boom — session construction failed');

    expect(acquire).toHaveBeenCalledWith('s-1');
    expect(release).toHaveBeenCalledTimes(1);
    // Confirms the id was never registered live — the exact condition that
    // makes the hold otherwise unreleasable (destroy() early-returns for a
    // non-live id).
    expect(h.isLive('s-1')).toBe(false);

    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });
});
