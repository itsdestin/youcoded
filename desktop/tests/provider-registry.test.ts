// ProviderRegistry — the contract for provider CRUD + key management + the
// languageModel() factory the native harness calls. Key pins: built-ins seed
// idempotently, upsert never persists derived status fields (the ProviderStatus
// doc warning), list() never leaks key material, and rotation keeps secretRef
// stable so providers.json pointers never need rewriting.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs'; import * as path from 'path'; import * as os from 'os';
import { NativeHome } from '../src/main/native-home';
import { SecretsStore } from '../src/main/providers/secrets-store';
import { ProviderRegistry } from '../src/main/providers/provider-registry';
import { ModelCatalog } from '../src/main/providers/model-catalog';
import { openRouterCostExtractor } from '../src/main/harness/pricing';
import type { LocalEngineHook } from '../src/main/engine/engine-manager';
import type { ChatGptAuth } from '../src/main/providers/chatgpt-auth';
import { limitError } from '../src/main/providers/chatgpt-oauth';
import { openAIContinuationBinding } from '../src/main/harness/openai-continuation';
import { streamText, generateText } from 'ai';

describe('ProviderRegistry', () => {
  let root: string; let reg: ProviderRegistry; let secrets: SecretsStore;
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-provreg-'));
    secrets = new SecretsStore(root);
    reg = new ProviderRegistry(new NativeHome(root), secrets);
    await reg.init();
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('seeds the two built-ins on first init and is idempotent', async () => {
    const list = await reg.list();
    expect(list.map((p) => p.id).sort()).toEqual(['local', 'openrouter']);
    expect(list.every((p) => p.builtIn)).toBe(true);
    await reg.init(); // second init must not duplicate
    expect((await reg.list())).toHaveLength(2);
  });

  it('local is not ready in Plan A; openrouter becomes ready once a key is set', async () => {
    let list = await reg.list();
    expect(list.find((p) => p.id === 'local')!.ready).toBe(false);
    expect(list.find((p) => p.id === 'openrouter')!.ready).toBe(false);
    await reg.setKey('openrouter', 'sk-or-abc');
    list = await reg.list();
    expect(list.find((p) => p.id === 'openrouter')!.ready).toBe(true);
  });

  it('refuses to remove built-ins; removes user entries and their secret', async () => {
    await expect(reg.remove('openrouter')).rejects.toThrow(/built-in/);
    const id = await reg.upsert({ type: 'openai-compatible', label: 'My LM Studio', baseUrl: 'http://localhost:1234/v1', enabled: true });
    await reg.setKey(id, 'whatever');
    const ref = (await reg.list()).find((p) => p.id === id)!.secretRef!;
    expect(secrets.has(ref)).toBe(true); // sanity: the secret exists before remove
    await reg.remove(id);
    expect((await reg.list()).find((p) => p.id === id)).toBeUndefined();
    expect(secrets.has(ref)).toBe(false); // ...and its secret was deleted too
  });

  it('upsert never persists derived status fields (builtIn/hasKey/ready)', async () => {
    const rows = await reg.list();
    // Simulate the renderer bug the ProviderStatus doc warns about: passing a status row back.
    await reg.upsert({ ...rows.find((p) => p.id === 'openrouter')!, enabled: false } as any);
    const onDisk = JSON.parse(fs.readFileSync(path.join(root, '.youcoded', 'providers.json'), 'utf8'));
    const entry = onDisk.providers.find((p: any) => p.id === 'openrouter');
    expect(entry.enabled).toBe(false);           // the real change persisted
    expect(entry.builtIn).toBeUndefined();       // derived fields did NOT
    expect(entry.hasKey).toBeUndefined();
    expect(entry.ready).toBeUndefined();
  });

  it('list() never exposes key material', async () => {
    await reg.setKey('openrouter', 'sk-or-secret');
    const json = JSON.stringify(await reg.list());
    expect(json).not.toContain('sk-or-secret');
  });

  it('languageModel() throws a plain-language error for an unready provider', async () => {
    await expect(reg.languageModel({ providerId: 'openrouter', modelId: 'meta-llama/llama-3-8b' }))
      .rejects.toThrow(/key/i);
    await expect(reg.languageModel({ providerId: 'local', modelId: 'x' }))
      .rejects.toThrow(/not available yet/i);
    await expect(reg.languageModel({ providerId: 'ghost', modelId: 'x' }))
      .rejects.toThrow(/not configured/i);
  });

  it('languageModel() returns an AI SDK handle for a keyed openrouter binding', async () => {
    await reg.setKey('openrouter', 'sk-or-abc');
    const model = await reg.languageModel({ providerId: 'openrouter', modelId: 'meta-llama/llama-3-8b' });
    expect(model).toBeTruthy();
    expect(typeof (model as any).modelId).toBe('string');
  });

  // Plan Task 27. OpenRouter reports the real dollar figure it charged on every
  // response; nothing else this app can talk to does. The hook that reads it is
  // attached to THIS branch only, and pricing.ts is emphatic that a provider
  // which reports nothing must read as nothing rather than as $0 — so a stray
  // extractor on a provider that never fills it in would be worse than none.
  it('openrouter asks the SDK to read the provider’s own cost off the wire', async () => {
    await reg.setKey('openrouter', 'sk-or-abc');
    const model = await reg.languageModel({ providerId: 'openrouter', modelId: 'openai/gpt-4o' });
    expect((model as any).config.metadataExtractor).toBe(openRouterCostExtractor);
  });

  it('no other provider claims to report a cost', async () => {
    const id = await reg.upsert({ type: 'openai-compatible', label: 'Ollama', baseUrl: 'http://localhost:11434/v1', enabled: true });
    const model = await reg.languageModel({ providerId: id, modelId: 'llama3' });
    expect((model as any).config.metadataExtractor).toBeUndefined();
  });

  // The plan expected a `usage: { include: true }` request body alongside the
  // extractor. OpenRouter's own Usage Accounting docs (fetched 2026-08-27) say
  // that parameter — and `stream_options: { include_usage: true }` — are
  // "deprecated and have no effect", because full usage details are now always
  // included automatically. Sending it would be code that claims to ask for
  // something it cannot ask for, so the body stays exactly as the SDK builds it.
  // NAME NARROWED (plan Task 30 item 3): this asserts one specific thing — that
  // no body-rewriting hook is installed — and the old name claimed it proved
  // the whole body asks for nothing, which it did not: the body still carried
  // `stream_options: { include_usage: true }` while this passed. The claim
  // about the BODY is now guarded by reading the real captured body, in
  // provider-cost-check.test.ts ("asks for the cost in NO request-body
  // parameter"). Both are kept: this one is the cheap structural check.
  it('installs no request-body rewriting hook on the OpenRouter branch', async () => {
    await reg.setKey('openrouter', 'sk-or-abc');
    const model = await reg.languageModel({ providerId: 'openrouter', modelId: 'openai/gpt-4o' });
    expect((model as any).config.transformRequestBody).toBeUndefined();
  });

  it('setKey rotation keeps the same secretRef (providers.json pointer stable)', async () => {
    await reg.setKey('openrouter', 'sk-1');
    const ref1 = (await reg.list()).find((p) => p.id === 'openrouter')!.secretRef;
    await reg.setKey('openrouter', 'sk-2');
    const ref2 = (await reg.list()).find((p) => p.id === 'openrouter')!.secretRef;
    expect(ref2).toBe(ref1);
  });

  it('languageModel() throws when the provider is disabled', async () => {
    await reg.setKey('openrouter', 'sk-or-abc'); // keyed, so ONLY the disable can be the reason
    await reg.upsert({ id: 'openrouter', type: 'openrouter', label: 'OpenRouter', enabled: false });
    await expect(reg.languageModel({ providerId: 'openrouter', modelId: 'x' }))
      .rejects.toThrow(/disabled/i);
  });

  it('openai-compatible without a key is ready and returns a handle (Ollama/LM Studio)', async () => {
    const id = await reg.upsert({ type: 'openai-compatible', label: 'Ollama', baseUrl: 'http://localhost:11434/v1', enabled: true });
    expect((await reg.list()).find((p) => p.id === id)!.ready).toBe(true);
    const model = await reg.languageModel({ providerId: id, modelId: 'llama3' });
    expect(typeof (model as any).modelId).toBe('string');
  });

  // Same bug as the local-engine pin below, on the branch that serves Ollama,
  // LM Studio and every custom endpoint: @ai-sdk/openai-compatible only sends
  // `stream_options:{include_usage:true}` when includeUsage is configured, and
  // a STREAMING response without it carries no usage block at all — so every
  // turn records inputTokens:0 and falls back to a chars/4 guess, starving both
  // the context gauge and the compaction trigger that read the same number.
  // This branch had no test of its own: deleting the flag here left the whole
  // desktop suite green (found reviewing 51e8b80e), and it is the same defect
  // the local branch actually shipped on 2026-07-28.
  it('openai-compatible: asks the server for real token counts', async () => {
    const id = await reg.upsert({ type: 'openai-compatible', label: 'Ollama', baseUrl: 'http://localhost:11434/v1', enabled: true });
    const model = await reg.languageModel({ providerId: id, modelId: 'llama3' });
    expect((model as any).config.includeUsage).toBe(true);
  });

  it('upsert partial update keeps omitted fields (baseUrl survives a label-only edit)', async () => {
    const id = await reg.upsert({ type: 'openai-compatible', label: 'Before', baseUrl: 'http://localhost:1234/v1', enabled: true });
    // Omit baseUrl entirely — the on-disk value must survive the merge.
    await reg.upsert({ id, type: 'openai-compatible', label: 'After', enabled: true } as any);
    const row = (await reg.list()).find((p) => p.id === id)!;
    expect(row.label).toBe('After');
    expect(row.baseUrl).toBe('http://localhost:1234/v1');
  });

  describe('local-engine hook (Plan B)', () => {
    function makeHook(overrides: Partial<LocalEngineHook> = {}): LocalEngineHook {
      return {
        installed: () => true,
        ensureRunning: async () => 'http://127.0.0.1:9999/v1',
        fetchImpl: () => fetch,
        ensureServable: async () => true, // fails OPEN in production too
        recordReply: () => {},              // T19: the engine card's speed line
        ...overrides,
      };
    }

    it('list(): local provider ready tracks hook.installed()', async () => {
      const withEngine = new ProviderRegistry(new NativeHome(root), secrets, makeHook());
      await withEngine.init();
      expect((await withEngine.list()).find((p) => p.id === 'local')?.ready).toBe(true);

      const without = new ProviderRegistry(new NativeHome(root), secrets, makeHook({ installed: () => false }));
      expect((await without.list()).find((p) => p.id === 'local')?.ready).toBe(false);
    });

    it('languageModel(local): awaits ensureRunning before returning a handle', async () => {
      const ensure = vi.fn(async () => 'http://127.0.0.1:9999/v1');
      const reg = new ProviderRegistry(new NativeHome(root), secrets, makeHook({ ensureRunning: ensure }));
      await reg.init();
      await reg.languageModel({ providerId: 'local', modelId: 'tiny-Q4_K_M' });
      expect(ensure).toHaveBeenCalledTimes(1);
    });

    it('languageModel(local): surfaces the hook install-guidance error verbatim', async () => {
      const reg = new ProviderRegistry(new NativeHome(root), secrets, makeHook({
        ensureRunning: async () => { throw new Error('Local models need a one-time engine install — open Settings → Providers and press Install.'); },
      }));
      await reg.init();
      await expect(reg.languageModel({ providerId: 'local', modelId: 'x' }))
        .rejects.toThrow(/one-time engine install/);
    });

    // The router discovers GGUFs at boot and re-scans only when asked, so a model
    // downloaded since is a selectable picker row it has never heard of. This is
    // the chokepoint every local send crosses — create, mid-session swap, remote.
    it('languageModel(local): asks whether the router can actually serve the model', async () => {
      const servable = vi.fn(async () => true);
      const reg = new ProviderRegistry(new NativeHome(root), secrets, makeHook({ ensureServable: servable }));
      await reg.init();
      await reg.languageModel({ providerId: 'local', modelId: 'tiny-Q4_K_M' });
      expect(servable).toHaveBeenCalledWith('tiny-Q4_K_M');
    });

    it('languageModel(local): an unservable model fails with the REAL cause, not the router 400', async () => {
      const reg = new ProviderRegistry(new NativeHome(root), secrets, makeHook({ ensureServable: async () => false }));
      await reg.init();
      // The raw router error is `model 'X' not found (provider error 400)`, which
      // reads as "your 29 GB download is corrupt" and invites a needless
      // re-download. Name the model, name the real cause, name the remedy.
      await expect(reg.languageModel({ providerId: 'local', modelId: 'gone-Q4_K_M' }))
        .rejects.toThrow(/could not find the model file for 'gone-Q4_K_M'.*re-download/s);
    });

    it('languageModel(local): with NO hook, keeps Plan A behavior (not-available error)', async () => {
      const reg = new ProviderRegistry(new NativeHome(root), secrets);
      await reg.init();
      await expect(reg.languageModel({ providerId: 'local', modelId: 'x' }))
        .rejects.toThrow(/not available yet/);
    });

    // Serial-only constraint (Task 10 / spec §4.2): small local models can't handle
    // parallel tool calls, so when the harness asks for serialToolCalls the
    // local-engine model must inject `parallel_tool_calls:false` into the request
    // body. We assert on the createOpenAICompatible config's transformRequestBody
    // hook (verified against @ai-sdk/openai-compatible@3.0.7: the config object,
    // incl. our hook, is stored on the model instance as `.config`).
    it('languageModel(local): serialToolCalls injects parallel_tool_calls:false via transformRequestBody', async () => {
      const reg = new ProviderRegistry(new NativeHome(root), secrets, makeHook());
      await reg.init();
      const model = await reg.languageModel({ providerId: 'local', modelId: 'm' }, { serialToolCalls: true });
      const body = (model as any).config.transformRequestBody({ messages: [], model: 'm' });
      expect(body.parallel_tool_calls).toBe(false);
      // The hook is additive — it must not drop the rest of the request body.
      expect(body.model).toBe('m');
    });

    // T19: the fetch handed to the SDK for a local send must report the finished
    // reply's speed back to the engine, so the card's fact line can show it.
    // Reaches through `.config.fetch` (same seam the transformRequestBody tests
    // use) and drives a REAL captured b10665 stream through it.
    it('languageModel(local): the SDK\'s fetch reports the reply speed back to the engine', async () => {
      // Verbatim frames from the pinned b10665 capture (2026-09-05) — see the
      // same payload in prefill-progress.test.ts.
      const finalFrame = {
        choices: [], created: 1788649092, model: 'Qwen3.5-2B-Q8_0',
        object: 'chat.completion.chunk',
        usage: { completion_tokens: 24, prompt_tokens: 15, total_tokens: 39 },
        timings: {
          cache_n: 0, prompt_n: 15, prompt_ms: 178.45, prompt_per_token_ms: 11.896666666666667,
          prompt_per_second: 84.05715886803026, predicted_n: 24, predicted_ms: 608.126,
          predicted_per_token_ms: 26.440260869565215, predicted_per_second: 37.821109441135555,
        },
      };
      const sse = `data: ${JSON.stringify(finalFrame)}\n\ndata: [DONE]\n\n`;
      const recorded: unknown[] = [];
      const reg = new ProviderRegistry(new NativeHome(root), secrets, makeHook({
        fetchImpl: () => (async () => new Response(sse, { status: 200 })) as any,
        recordReply: (t) => recorded.push(t),
      }));
      await reg.init();
      const model = await reg.languageModel({ providerId: 'local', modelId: 'm' });
      const res = await (model as any).config.fetch('http://127.0.0.1:9999/v1/chat/completions');
      // The SDK's branch must still see the bytes the server sent.
      expect(await res.text()).toBe(sse);
      await vi.waitFor(() => { expect(recorded).toHaveLength(1); });
      expect(recorded[0]).toEqual({ promptPerSecond: 84.05715886803026, generatePerSecond: 37.821109441135555 });
    });

    it('languageModel(local): WITHOUT serialToolCalls attaches no transformRequestBody hook', async () => {
      const reg = new ProviderRegistry(new NativeHome(root), secrets, makeHook());
      await reg.init();
      const model = await reg.languageModel({ providerId: 'local', modelId: 'm' });
      // No hook configured → the SDK leaves the body untouched (default parallel).
      expect((model as any).config.transformRequestBody).toBeUndefined();
    });

    // The bug this pins: @ai-sdk/openai-compatible only sends
    // `stream_options:{include_usage:true}` when includeUsage is configured, and
    // a STREAMING OpenAI-compatible response without it carries no usage block at
    // all. We shipped without it, so every native turn recorded inputTokens:0 and
    // fell back to a chars/4 guess for output — starving both the context gauge
    // and the compaction trigger, which reads the same number. Nothing asserted
    // token counts were real, which is exactly why it survived to dogfooding
    // (Destin, 2026-07-28).
    it('languageModel(local): asks the server for real token counts', async () => {
      const reg = new ProviderRegistry(new NativeHome(root), secrets, makeHook());
      await reg.init();
      const model = await reg.languageModel({ providerId: 'local', modelId: 'm' });
      expect((model as any).config.includeUsage).toBe(true);
    });
  });

  // Sign in with ChatGPT — backend design §2 (the virtual row), §4.1/§4.2 (the
  // request shape), §6 (the kill switch). Everything here runs against a fake
  // ChatGptAuth whose fetch() records what would have gone on the wire and
  // answers with a recorded-shape Responses stream — no network, no browser.
  describe('Sign in with ChatGPT (virtual row + request path)', () => {
    const NOT_A_KEY = 'ChatGPT is signed in through OpenAI, not with a key — use Sign out on its card.';
    const TURNED_OFF = 'ChatGPT sign-in is turned off in this build.';
    const SIGN_IN_REQUIRED = 'Sign in with ChatGPT in Settings → Model Providers to use this model.';

    interface Captured { url: string; headers: Record<string, string>; body: any }
    interface FakeOpts {
      signedIn?: boolean;
      blockedReason?: string;
      token?: string;
      credentialEpoch?: string;
      /** What the fake network answers with; default = a one-message stream. */
      reply?: () => Response | Promise<Response>;
    }
    /** A ChatGptAuth stand-in with only the surface the registry uses. Its
     *  fetch() does what the real one does to the credential: REPLACES the
     *  lower-cased `authorization` the SDK froze in, never adds a second one. */
    function fakeChatGpt(o: FakeOpts = {}): { auth: ChatGptAuth; requests: Captured[] } {
      const signedIn = o.signedIn ?? true;
      const token = o.token ?? 'real-access-token';
      const requests: Captured[] = [];
      const auth = {
        isSignedIn: () => signedIn && !o.blockedReason,
        status: () =>
          !signedIn ? { state: 'signed-out' }
          : o.blockedReason ? { state: 'blocked', email: 'd@example.com', reason: o.blockedReason }
          : { state: 'signed-in', email: 'd@example.com', plan: 'free', usage: null },
        signedInAccount: () => {
          if (!signedIn) throw new Error(SIGN_IN_REQUIRED);
          if (o.blockedReason) { const e = new Error(o.blockedReason); e.name = 'ChatGptBlockedError'; throw e; }
          // credentialEpoch: the durable half of continuation identity (Task
          // 1) — fixed per fake so `continuationIdentity()` produces a stable,
          // well-formed string in tests without a real ChatGptAuth.
          return { accountId: 'acct_123', email: 'd@example.com', plan: 'free', authGeneration: 1, credentialEpoch: o.credentialEpoch ?? 'epoch-1' };
        },
        models: async () => [],
        fetch: (_expected?: { accountId: string; authGeneration: number }) => async (input: any, init: any) => {
          const headers = new Headers(init?.headers);
          headers.set('authorization', `Bearer ${token}`);
          requests.push({
            url: String(input),
            headers: Object.fromEntries(headers.entries()),
            body: init?.body ? JSON.parse(init.body) : undefined,
          });
          return o.reply ? await o.reply() : sse(responsesStream({ text: 'Hello there' }));
        },
      };
      return { auth: auth as unknown as ChatGptAuth, requests };
    }

    /** A Responses-API SSE body in the shapes the Phase 0 probe recorded
     *  (docs/active/investigations/2026-09-05-chatgpt-phase0-findings.md):
     *  response.created → output_item.added → output_text.delta →
     *  output_item.done → response.completed with the usage block. */
    function responsesStream(o: { text?: string; toolCall?: { name: string; args: string } }): string {
      const ev: any[] = [
        { type: 'response.created', response: { id: 'resp_1', created_at: 1757000000, model: 'gpt-5.5' } },
      ];
      if (o.text != null) {
        ev.push({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'in_progress', content: [] } });
        ev.push({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: o.text });
        ev.push({ type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: o.text }] } });
      }
      if (o.toolCall) {
        ev.push({ type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: o.toolCall.name, arguments: '', status: 'in_progress' } });
        ev.push({ type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: o.toolCall.name, arguments: o.toolCall.args, status: 'completed' } });
      }
      ev.push({ type: 'response.completed', response: { id: 'resp_1', usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
      return ev.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
    }
    function sse(body: string): Response {
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    function make(auth: ChatGptAuth | null) {
      return new ProviderRegistry(new NativeHome(root), secrets, null, auth);
    }
    async function turn(reg: ProviderRegistry, o: { system?: string; cacheKey?: string } = {}): Promise<string> {
      const model = await reg.languageModel({ providerId: 'chatgpt', modelId: 'gpt-5.5' }, { cacheKey: o.cacheKey });
      const result = streamText({ model: model as any, prompt: 'hi', ...(o.system ? { system: o.system } : {}) });
      let text = '';
      for await (const chunk of result.textStream) text += chunk;
      return text;
    }

    it('list(): the virtual row appears LAST, builtIn, only when a ChatGptAuth is given', async () => {
      const without = await make(null).list();
      expect(without.map((p) => p.id)).not.toContain('chatgpt');
      const withAuth = await make(fakeChatGpt().auth).list();
      expect(withAuth[withAuth.length - 1]).toMatchObject({ id: 'chatgpt', type: 'chatgpt', label: 'ChatGPT Plan', enabled: true, builtIn: true, hasKey: false });
      expect(withAuth.map((p) => p.id)).toEqual(['local', 'openrouter', 'chatgpt']);
    });

    // The new-session form defaults to the FIRST ready provider and blocks
    // Create when that provider has no models to pick. ChatGPT's list is
    // cache-first: right after signing in — and for as long as the manifest
    // fetch keeps failing — it is ready with zero models. Putting the plan
    // first made that the default and left Create dead with no explanation,
    // with the user's OpenRouter models one dropdown away. So: last.
    it('signed in with an EMPTY model cache, the first READY provider still has models — a session is still creatable', async () => {
      const reg = make(fakeChatGpt({ signedIn: true }).auth);   // models() → []
      await reg.setKey('openrouter', 'sk-or-abc');
      const ready = (await reg.list()).filter((p) => p.ready);
      expect(ready.map((p) => p.id)).toEqual(['openrouter', 'chatgpt']);

      // End to end through the real catalog, because "ready" alone is not what
      // unblocks Create — having a model to bind to is.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-provreg-cat-'));
      try {
        const catalog = new ModelCatalog(dir, async (url: string) => ({
          ok: true,
          json: async () => (String(url).includes('openrouter')
            ? { data: [{ id: 'meta-llama/llama-3-8b', name: 'Llama 3 8B', context_length: 8192 }] }
            : {}),
        }) as any, { chatgptModels: async () => [] });
        const rows = await catalog.get(await reg.list());
        const first = ready[0];
        expect(rows.some((m) => m.providerId === first.id)).toBe(true);
        expect(rows.some((m) => m.providerId === 'chatgpt')).toBe(false);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    it('init() after construction with a ChatGptAuth leaves NO chatgpt row in providers.json', async () => {
      const reg = make(fakeChatGpt().auth);
      await reg.init();
      await reg.init();
      // The file itself, not list(): the bug this pins is a stray persisted row
      // that an older build on the same machine would render as a key card.
      const file = JSON.parse(fs.readFileSync(path.join(root, '.youcoded', 'providers.json'), 'utf8'));
      expect(file.providers.map((p: any) => p.id)).toEqual(['local', 'openrouter']);
      expect(file.providers.some((p: any) => p.type === 'chatgpt')).toBe(false);
    });

    it('ready follows isSignedIn(): signed in → ready, signed out or blocked → listed but not ready', async () => {
      const ready = (await make(fakeChatGpt({ signedIn: true }).auth).list()).find((p) => p.id === 'chatgpt')!;
      expect(ready.ready).toBe(true);
      const out = (await make(fakeChatGpt({ signedIn: false }).auth).list()).find((p) => p.id === 'chatgpt')!;
      expect(out.ready).toBe(false);
      const blocked = (await make(fakeChatGpt({ blockedReason: 'Codex is disabled for this workspace.' }).auth).list()).find((p) => p.id === 'chatgpt')!;
      expect(blocked).toMatchObject({ ready: false, enabled: true, builtIn: true });
    });

    it('upsert / remove / setKey refuse the virtual row with the one sentence', async () => {
      const reg = make(fakeChatGpt().auth);
      await expect(reg.upsert({ id: 'chatgpt', type: 'chatgpt', label: 'x', enabled: false })).rejects.toThrow(NOT_A_KEY);
      await expect(reg.upsert({ type: 'chatgpt', label: 'another', enabled: true })).rejects.toThrow(NOT_A_KEY);
      await expect(reg.remove('chatgpt')).rejects.toThrow(NOT_A_KEY);
      await expect(reg.setKey('chatgpt', 'sk-nope')).rejects.toThrow(NOT_A_KEY);
      const file = JSON.parse(fs.readFileSync(path.join(root, '.youcoded', 'providers.json'), 'utf8'));
      expect(file.providers.some((p: any) => p.id === 'chatgpt' || p.type === 'chatgpt')).toBe(false);
    });

    it('testConnection(chatgpt) answers from isSignedIn() and never touches the network', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network must not be used'); }));
      try {
        expect(await make(fakeChatGpt({ signedIn: true }).auth).testConnection('chatgpt'))
          .toEqual({ ok: true, message: 'Signed in as d@example.com.' });
        expect(await make(fakeChatGpt({ signedIn: false }).auth).testConnection('chatgpt'))
          .toEqual({ ok: false, message: SIGN_IN_REQUIRED });
        expect(await make(fakeChatGpt({ blockedReason: 'Codex is disabled for this workspace.' }).auth).testConnection('chatgpt'))
          .toEqual({ ok: false, message: 'Codex is disabled for this workspace.' });
        expect((globalThis.fetch as any).mock.calls).toHaveLength(0);
      } finally { vi.unstubAllGlobals(); }
    });

    it('languageModel(chatgpt): the request carries the plan shape and exactly one real bearer', async () => {
      const { auth, requests } = fakeChatGpt({ token: 'tok-1' });
      const text = await turn(make(auth), { system: 'Be terse.', cacheKey: 'sess-42' });
      expect(text).toBe('Hello there');
      expect(requests).toHaveLength(1);
      const [req] = requests;
      expect(req.url).toBe('https://chatgpt.com/backend-api/codex/responses');
      // §4.2 body
      expect(req.body.store).toBe(false);
      expect(req.body.stream).toBe(true);
      expect(req.body.instructions).toBe('Be terse.');
      expect(req.body.include).toContain('reasoning.encrypted_content');
      expect(req.body.prompt_cache_key).toBe('sess-42');
      expect(req.body.model).toBe('gpt-5.5');
      // The system text moved into `instructions`; it must NOT also be an input item.
      expect(req.body.input.some((i: any) => i.role === 'system')).toBe(false);
      expect(req.body.input.some((i: any) => i.role === 'user')).toBe(true);
      // §4.1 headers — the three the endpoint wants, and the honest originator.
      expect(req.headers['chatgpt-account-id']).toBe('acct_123');
      expect(req.headers['originator']).toBe('youcoded');
      expect(req.headers['openai-beta']).toBe('responses=experimental');
      // Exactly one authorization value, the wrapper's — the registry's
      // placeholder never reaches the network.
      const authValues = Object.entries(req.headers).filter(([k]) => k.toLowerCase() === 'authorization');
      expect(authValues).toEqual([['authorization', 'Bearer tok-1']]);
      // The placeholder the registry hands the SDK ('Bearer chatgpt') must be
      // gone from everything that reaches the network — header names like
      // chatgpt-account-id are fine, the VALUE is what must not leak.
      expect(Object.values(req.headers)).not.toContain('Bearer chatgpt');
      expect(JSON.stringify(req.body)).not.toContain('Bearer chatgpt');
    });

    // The `include` assertion on gpt-5.5 above cannot fail: the SDK recognises
    // any gpt-5.x as a reasoning model and adds `reasoning.encrypted_content`
    // itself whenever store is false. So this repeats it on an id the SDK does
    // NOT recognise — which is the only case the middleware's own `include` is
    // there for, and the normal case for a model the plan's manifest names
    // before the SDK has heard of it. Without it, reasoning would come back
    // with nothing we can carry to the next step of the same turn.
    it('include: an id the SDK does not treat as a reasoning model still asks for encrypted reasoning', async () => {
      const { auth, requests } = fakeChatGpt();
      const model = await make(auth).languageModel({ providerId: 'chatgpt', modelId: 'codex-auto-review' });
      const result = streamText({ model: model as any, prompt: 'hi' });
      for await (const _ of result.textStream) { /* drain */ }
      expect(requests[0].body.model).toBe('codex-auto-review');
      expect(requests[0].body.include).toContain('reasoning.encrypted_content');
    });

    it('sends the fixed instructions sentence when the harness has no system text', async () => {
      const { auth, requests } = fakeChatGpt();
      await turn(make(auth));
      expect(requests[0].body.instructions).toBe("You are YouCoded's assistant.");
      expect(requests[0].body.input.some((i: any) => i.role === 'system')).toBe(false);
    });

    // Phase 0 P0-5: the endpoint refuses a non-streaming call outright (HTTP
    // 400 "Stream must be set to true"). The auto-title feeder uses
    // generateText, so the middleware must stream for it and fold the answer.
    it('generateText on the model streams under the hood and returns the folded text', async () => {
      const { auth, requests } = fakeChatGpt();
      const model = await make(auth).languageModel({ providerId: 'chatgpt', modelId: 'gpt-5.5' }, { cacheKey: 'sess-1' });
      const result = await generateText({ model: model as any, prompt: 'title this' });
      expect(result.text).toBe('Hello there');
      expect(result.finishReason).toBe('stop');
      expect(result.usage.inputTokens).toBe(12);
      expect(result.usage.outputTokens).toBe(3);
      expect(requests).toHaveLength(1);
      expect(requests[0].body.stream).toBe(true);
      expect(requests[0].body.store).toBe(false);
      expect(requests[0].body.prompt_cache_key).toBe('sess-1');
    });

    it('the folded generate result carries a tool call the stream produced', async () => {
      const { auth } = fakeChatGpt({ reply: () => sse(responsesStream({ toolCall: { name: 'lookup', args: '{"q":"x"}' } })) });
      const model: any = await make(auth).languageModel({ providerId: 'chatgpt', modelId: 'gpt-5.5' });
      const out = await model.doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
        tools: [{ type: 'function', name: 'lookup', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }],
      });
      const call = out.content.find((c: any) => c.type === 'tool-call');
      expect(call).toMatchObject({ toolCallId: 'call_1', toolName: 'lookup', input: '{"q":"x"}' });
      expect(out.finishReason.unified).toBe('tool-calls');
      expect(out.usage.inputTokens.total).toBe(12);
    });

    // The card's limit / expired / blocked copy keys on the thrown message
    // byte for byte, and the SDK's retry logic keys on statusCode — so the
    // wrapper's own errors must come through with neither wrapped nor added.
    it('a limit error thrown by the fetch reaches the caller unwrapped, with no statusCode', async () => {
      const msg = 'You have hit your ChatGPT plan limit. It resets in 3 hours.';
      const { auth } = fakeChatGpt({ reply: () => { throw limitError(msg); } });
      const model: any = await make(auth).languageModel({ providerId: 'chatgpt', modelId: 'gpt-5.5' });
      let caught: any;
      try { await generateText({ model, prompt: 'hi' }); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(Error);
      expect(caught.message).toBe(msg);
      expect(caught.name).toBe('ChatGptLimitError');
      expect(caught.statusCode).toBeUndefined();
      expect(caught.status).toBeUndefined();
    });

    it('languageModel(chatgpt): signed out → the sign-in sentence; blocked → OpenAI’s own reason', async () => {
      await expect(make(fakeChatGpt({ signedIn: false }).auth).languageModel({ providerId: 'chatgpt', modelId: 'gpt-5.5' }))
        .rejects.toThrow(SIGN_IN_REQUIRED);
      await expect(make(fakeChatGpt({ blockedReason: 'Codex is disabled for this workspace.' }).auth).languageModel({ providerId: 'chatgpt', modelId: 'gpt-5.5' }))
        .rejects.toThrow('Codex is disabled for this workspace.');
    });

    // Task 1: continuationIdentity() is the ONE place this string is built —
    // the harness's continuationOwner closure and the future restore path
    // both call it, so they can never disagree (cache-stage4-architecture §
    // "Identity strings").
    describe('continuationIdentity()', () => {
      it('a non-ChatGPT binding is provider\\0model, with no ChatGptAuth involved', () => {
        const reg = make(null);
        expect(reg.continuationIdentity({ providerId: 'openrouter', modelId: 'meta-llama/llama-3-8b' }))
          .toBe('openrouter\0meta-llama/llama-3-8b');
      });

      it('equals what languageModel() binds onto the ChatGPT model, and never contains the raw accountId', async () => {
        const { auth } = fakeChatGpt();
        const reg = make(auth);
        const binding = { providerId: 'chatgpt', modelId: 'gpt-5.5' };
        const model = await reg.languageModel(binding);
        const identity = reg.continuationIdentity(binding);
        expect(openAIContinuationBinding(model)).toBe(identity);
        expect(identity.startsWith('chatgpt\0gpt-5.5\0')).toBe(true);
        expect(identity).not.toContain('acct_123');
      });

      it('changes when the credential epoch changes (a reauth), same account', () => {
        const binding = { providerId: 'chatgpt', modelId: 'gpt-5.5' };
        const before = make(fakeChatGpt({ credentialEpoch: 'epoch-1' }).auth).continuationIdentity(binding);
        const after = make(fakeChatGpt({ credentialEpoch: 'epoch-2' }).auth).continuationIdentity(binding);
        expect(after).not.toBe(before);
      });

      it('throws the sign-in-required sentence when signed out', () => {
        const reg = make(fakeChatGpt({ signedIn: false }).auth);
        expect(() => reg.continuationIdentity({ providerId: 'chatgpt', modelId: 'gpt-5.5' })).toThrow(SIGN_IN_REQUIRED);
      });
    });

    it('kill switch (chatgpt = null): no row, and a ChatGPT binding is refused with the sentence', async () => {
      const reg = make(null);
      expect((await reg.list()).some((p) => p.id === 'chatgpt')).toBe(false);
      await expect(reg.languageModel({ providerId: 'chatgpt', modelId: 'gpt-5.5' })).rejects.toThrow(TURNED_OFF);
      // ONE state, ONE explanation: Test on a leftover ChatGPT card used to say
      // "not configured", which reads as "you forgot to set it up" and sends
      // the user looking for a setting that isn't there.
      expect(await reg.testConnection('chatgpt')).toEqual({ ok: false, message: TURNED_OFF });
    });
  });
});
