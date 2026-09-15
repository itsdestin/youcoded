import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { NativeHome } from '../src/main/native-home';
import { SessionStore } from '../src/main/harness/session-store';
import { NativeSessionHost } from '../src/main/harness/native-session-host';
import { ModelCatalog } from '../src/main/providers/model-catalog';
import type { ContextPreferences } from '../src/shared/context-preferences';
import type { ProviderStatus } from '../src/shared/provider-types';
import type { TranscriptEvent } from '../src/shared/types';

const binding = { providerId: 'chatgpt', modelId: 'plan-model' };
const provider: ProviderStatus = { id: 'chatgpt', type: 'chatgpt', label: 'Plan', enabled: true, builtIn: true, hasKey: false, ready: true };
const modelFactory = async () => new MockLanguageModelV4({ doStream: async () => ({ stream: simulateReadableStream({ chunks: [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'Hello' }, { type: 'text-end', id: 't' },
  { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } } },
] }) }) });

describe('saved cloud budgets in native session lifecycle', () => {
  let root: string;
  let host: NativeSessionHost;
  let preferences: ContextPreferences;
  let turns: TranscriptEvent[];
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-cloud-context-'));
    preferences = { openrouter: 'standard', chatgpt: 'standard' };
    const catalog = new ModelCatalog(root, vi.fn(), {
      contextPreferences: () => preferences,
      chatgptModels: async () => [{ ...binding, id: binding.modelId, label: 'Plan model', contextLength: 272000, maxContextLength: 872000 }],
    });
    host = new NativeSessionHost(new SessionStore(new NativeHome(root)), modelFactory,
      async (b) => ({ contextLength: await catalog.contextLengthFor(b, [provider]), totalSlots: null }),
      async () => 'chatgpt', async () => null);
    turns = [];
    host.on('transcript-event', (event: TranscriptEvent) => { if (event.type === 'turn-complete') turns.push(event); });
  });
  afterEach(async () => {
    await host.destroyAll();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });

  async function windowAfterTurn(id: string): Promise<number | null> {
    const count = turns.length;
    expect(host.send(id, 'hello').status).toBe('sent');
    await vi.waitFor(() => expect(turns.length).toBe(count + 1));
    await host.drain(id);
    return (turns[count].data as { usage: { contextLength: number | null } }).usage.contextLength;
  }

  it('keeps an active session stable, but new and reopened sessions take the saved preference', async () => {
    await host.create({ sessionId: 'original', cwd: root, binding });
    expect(await windowAfterTurn('original')).toBe(272000);
    preferences = { ...preferences, chatgpt: 'long' };
    expect(await windowAfterTurn('original')).toBe(272000);
    await host.create({ sessionId: 'new', cwd: root, binding });
    expect(await windowAfterTurn('new')).toBe(872000);
    await host.destroy('original');
    expect(await host.resume('original', root)).toBe(true);
    expect(await windowAfterTurn('original')).toBe(872000);
    preferences = { ...preferences, chatgpt: 'standard' };
    await host.destroy('original');
    expect(await host.resume('original', root)).toBe(true);
    expect(await windowAfterTurn('original')).toBe(272000);
  });

  it('re-resolves the preference on model selection and reports the effective window in usage', async () => {
    await host.create({ sessionId: 'switch', cwd: root, binding });
    expect(await windowAfterTurn('switch')).toBe(272000);
    preferences = { ...preferences, chatgpt: 'long' };
    expect(await host.setBinding('switch', binding)).toBe(true);
    expect(await windowAfterTurn('switch')).toBe(872000);
  });
});
