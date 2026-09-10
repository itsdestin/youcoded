// Prompt-cache request shaping (cache follow-ups A1, 2026-09-10).
//
// Providers only discount the repeated part of a request when the caller asks
// (Anthropic) or when the conversation keeps landing on the server that holds
// the cache (OpenRouter). Both asks live in the provider registry as a model
// middleware keyed on the harness `cacheKey`, so the harness stays
// provider-ignorant and a caller without a key (session naming) gets nothing.
//
// Every assertion here is on the REAL request body as the real SDK provider
// serializes it — the only layer where "cache_control sits on the system block"
// is a fact rather than an intention.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs'; import * as path from 'path'; import * as os from 'os';
import { generateText } from 'ai';
import { NativeHome } from '../src/main/native-home';
import { SecretsStore } from '../src/main/providers/secrets-store';
import { ProviderRegistry } from '../src/main/providers/provider-registry';
import { withChatGptRequest } from '../src/main/providers/chatgpt-request-diagnostics';

const ANTHROPIC_REPLY = {
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5',
  content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
};
const OPENAI_REPLY = {
  id: 'cmpl_1', object: 'chat.completion', created: 0, model: 'x',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

describe('prompt-cache request shaping', () => {
  let root: string; let reg: ProviderRegistry; let anthropicId: string;
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-pcache-'));
    reg = new ProviderRegistry(new NativeHome(root), new SecretsStore(root));
    await reg.init();
    await reg.setKey('openrouter', 'sk-or-abc');
    anthropicId = await reg.upsert({ type: 'anthropic', label: 'Anthropic', enabled: true });
    await reg.setKey(anthropicId, 'sk-ant-abc');
  });
  afterEach(() => { vi.unstubAllGlobals(); fs.rmSync(root, { recursive: true, force: true }); });

  /** One real generateText call against a stubbed network; returns the body the
   *  SDK actually put on the wire. */
  async function sent(model: any, reply: unknown, run: (fn: () => Promise<unknown>) => Promise<unknown> = (fn) => fn()): Promise<any> {
    let body: any;
    vi.stubGlobal('fetch', async (_url: any, init: any) => {
      body = JSON.parse(init.body);
      return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    await run(() => generateText({ model, system: 'You are the assistant.', prompt: 'hi' }));
    return body;
  }
  const anthropic = (opts?: { cacheKey?: string }) => reg.languageModel({ providerId: anthropicId, modelId: 'claude-opus-5' }, opts);
  const openrouter = (modelId: string, opts?: { cacheKey?: string }) => reg.languageModel({ providerId: 'openrouter', modelId }, opts);
  const asSummary = (fn: () => Promise<unknown>) => withChatGptRequest('s1', 'summary', fn);

  describe('Anthropic direct', () => {
    it('a harness request marks the system block AND asks for automatic tail caching, both 1h', async () => {
      const body = await sent(await anthropic({ cacheKey: 's1' }), ANTHROPIC_REPLY);
      expect(body.system).toEqual([expect.objectContaining({ type: 'text', cache_control: { type: 'ephemeral', ttl: '1h' } })]);
      expect(body.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    });
    // The summary changes tool_choice, which invalidates Anthropic's MESSAGES
    // cache while keeping tools+system. A tail marker there would write the
    // whole history at 2x for a cache nobody reads. System marker only.
    it('a summary request marks the system block only — no tail marker', async () => {
      const body = await sent(await anthropic({ cacheKey: 's1' }), ANTHROPIC_REPLY, asSummary);
      expect(body.system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
      expect(body.cache_control).toBeUndefined();
    });
    it('a request without a cacheKey (session naming) carries no cache_control at all', async () => {
      const body = await sent(await anthropic(), ANTHROPIC_REPLY);
      expect(body.cache_control).toBeUndefined();
      expect(body.system[0].cache_control).toBeUndefined();
    });
  });

  describe('OpenRouter', () => {
    it('a harness request pins the session and, for a Claude model, asks for automatic caching at 1h', async () => {
      const body = await sent(await openrouter('anthropic/claude-opus-5', { cacheKey: 's1' }), OPENAI_REPLY);
      expect(body.session_id).toBe('s1');
      expect(body.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    });
    it('a non-Claude model gets the session pin and NO cache_control (its cache is automatic)', async () => {
      const body = await sent(await openrouter('deepseek/deepseek-v4-flash', { cacheKey: 's1' }), OPENAI_REPLY);
      expect(body.session_id).toBe('s1');
      expect(body.cache_control).toBeUndefined();
    });
    it('a summary request keeps the session pin but asks for no caching (top-level is all-or-nothing)', async () => {
      const body = await sent(await openrouter('anthropic/claude-opus-5', { cacheKey: 's1' }), OPENAI_REPLY, asSummary);
      expect(body.session_id).toBe('s1');
      expect(body.cache_control).toBeUndefined();
    });
    it('the pin is the cacheKey itself: stable within a session, different across sessions, absent without one', async () => {
      expect((await sent(await openrouter('openai/gpt-4o', { cacheKey: 's1' }), OPENAI_REPLY)).session_id).toBe('s1');
      expect((await sent(await openrouter('openai/gpt-4o', { cacheKey: 's2' }), OPENAI_REPLY)).session_id).toBe('s2');
      expect((await sent(await openrouter('openai/gpt-4o'), OPENAI_REPLY)).session_id).toBeUndefined();
    });
  });
});
