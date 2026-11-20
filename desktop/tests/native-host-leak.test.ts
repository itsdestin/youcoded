import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import { NativeHome } from '../src/main/native-home';
import { SessionStore } from '../src/main/harness/session-store';
import { NativeSessionHost } from '../src/main/harness/native-session-host';
import { sizesOf, growth } from './helpers/leak-probe';

// R-4 phase 0/2: the native chat engine holds 21 per-chat lists; this opens and closes 50 chats with a helper report waiting.
describe('native host per-chat memory', () => {
  let root = ''; let host: NativeSessionHost | undefined;
  afterEach(async () => { await host?.destroyAll(); vi.restoreAllMocks(); if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }); });
  it('50 chats opened, given a waiting report, and closed leave nothing behind', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-host-leak-'));
    const home = new NativeHome(root), store = new SessionStore(home);
    host = new NativeSessionHost(store, async () => new MockLanguageModelV4({}), async () => ({ contextLength: null, totalSlots: null }), async () => null, async () => null,
      undefined, undefined, undefined, undefined, undefined, undefined, home);
    const h = host as any;
    const before = sizesOf('host', h);
    for (let i = 0; i < 50; i++) {
      const id = `chat-${i}`;
      await host.create({ sessionId: id, cwd: root, binding: { providerId: 'openrouter', modelId: 'offline-mock' } });
      h.pendingDeliveryParents.add(id); // a finished helper's report is waiting for this chat
      await host.destroy(id);
    }
    const grew = growth(before, sizesOf('host', h));
    // modeFor is a deliberate, tiny memory (one short word per chat: the chosen permission mode must survive close/resume) — see
    // the comment in destroyEntry. Everything else must be back to where it started.
    expect(grew['host.modeFor'] ?? 0).toBeLessThanOrEqual(50);
    delete grew['host.modeFor'];
    expect(grew).toEqual({});
  });
});
