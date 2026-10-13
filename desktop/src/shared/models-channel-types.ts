// models-channel-types.ts — the request/response rows of the models:*, engine:*, provider:*, search:*,
// chatgpt:*, openrouter:*, claude-code:* and endpoints:detect channels that live in the channel table
// (one-core R3-6).
//
// WHY a file of its own (2026-09-30 one-core R3-6): backend-contract.ts is at its line budget; like
// native-channel-types.ts, ChannelTypes extends this so a row is still found by name through ChannelTypes.
// Push channels (engine:install-progress, engine:status-changed, engine:models-changed,
// models:download-progress) are not rows: they have no request.
//
// WHY the answers are derived from the runtime's own methods: the table handler returns exactly what the
// method returns, so the type cannot drift from it. `Rt` is imported as a TYPE only (shared/ never loads main/).
import type { NativeRuntime } from '../main/create-runtime';
import type { ProviderConfig, OpenRouterSignInStatus } from './provider-types';
import type { ChatGptAccountStatus } from './chatgpt-types';
import type { ClaudeAccountStatus } from './claude-account-types';
import type { EngineBackend, EnginePrereqs, EngineSpeedSettings } from './engine-types';
import type { ModelSettingsWrite, DetectedEndpoint, StoredModelSettings } from './model-manager-types';

type Rt = NativeRuntime;
type Answer<K extends keyof Rt, M extends keyof Rt[K]> = Rt[K][M] extends (...a: any[]) => infer R ? Awaited<R> : never;
/** What the engine endpoints answer after a change: the fresh status, or null when the runtime is not built yet (a phone only). */
type EngineStatusAnswer = Answer<'engineManager', 'status'> | null;
/** A failed key test or connection test is an answer, not a throw. */
type TestAnswer = { ok: boolean; message: string };

export interface ModelsChannelTypes {
  // Providers (Settings → Providers).
  'provider:list': { request: void; response: Answer<'providerRegistry', 'list'> };
  'provider:upsert': { request: Omit<ProviderConfig, 'id'> & { id?: string }; response: string | null };
  'provider:remove': { request: { id: string }; response: true };
  'provider:test': { request: { id: string; key?: unknown }; response: Answer<'providerRegistry', 'testConnection'> | TestAnswer };
  'provider:set-key': { request: { id: string; key: string }; response: true };
  'provider:catalog': { request: void; response: Answer<'modelCatalog', 'get'> };
  'endpoints:detect': { request: void; response: DetectedEndpoint[] };
  // Sign in with ChatGPT / OpenRouter, and Claude Code's own sign-in.
  'chatgpt:status': { request: void; response: ChatGptAccountStatus };
  'chatgpt:sign-in': { request: void; response: boolean };
  'chatgpt:cancel-sign-in': { request: void; response: boolean };
  'chatgpt:sign-out': { request: void; response: boolean };
  'openrouter:sign-in-status': { request: void; response: OpenRouterSignInStatus };
  'openrouter:sign-in': { request: void; response: boolean };
  'openrouter:cancel-sign-in': { request: void; response: boolean };
  'claude-code:status': { request: { refresh?: boolean } | undefined; response: ClaudeAccountStatus };
  'claude-code:install': { request: void; response: { success: boolean; error?: string } };
  // WebSearch keys. A key goes IN (set-key, test) and is never in an answer: list says only whether one exists.
  'search:list': { request: void; response: Answer<'searchKeyStore', 'list'> };
  'search:set-key': { request: { backend: 'tavily' | 'exa'; key: string }; response: true };
  'search:remove-key': { request: { backend: 'tavily' | 'exa' }; response: true };
  'search:test': { request: { backend: 'tavily' | 'exa'; key: string }; response: TestAnswer };
  // The local engine.
  'engine:status': { request: void; response: EngineStatusAnswer };
  'engine:install': { request: void; response: EngineStatusAnswer };
  'engine:restart': { request: void; response: EngineStatusAnswer };
  'engine:set-backend': { request: { backend: EngineBackend | string }; response: EngineStatusAnswer };
  'engine:set-context': { request: { contextSize: number }; response: EngineStatusAnswer };
  'engine:set-config': { request: { contextSize?: number; speed?: Partial<EngineSpeedSettings> } | undefined; response: EngineStatusAnswer };
  'engine:run-in-terminal': { request: { command: string }; response: { sessionId: string } };
  'engine:prereqs': { request: { backend: string }; response: EnginePrereqs };
  'engine:models': { request: void; response: Answer<'engineManager', 'liveModels'> };
  // The model manager.
  'models:curated': { request: void; response: Answer<'modelManager', 'curatedList'> };
  'models:search': { request: { query: string }; response: Answer<'modelManager', 'search'> };
  'models:quants': { request: { repo: string }; response: Answer<'modelManager', 'quants'> };
  'models:download': { request: { repo: string; quant: Parameters<Rt['modelManager']['download']>[1] }; response: { downloadId: string } | null };
  'models:download-cancel': { request: { downloadId: string }; response: true };
  'models:delete': { request: { id: string }; response: true };
  'models:installed': { request: void; response: Answer<'engineManager', 'installedModels'> };
  'models:resume': { request: { modelId: string }; response: { downloadId: string } };
  'models:settings': { request: { modelId: string }; response: StoredModelSettings | null };
  'models:set-settings': { request: { modelId: string; patch?: ModelSettingsWrite }; response: StoredModelSettings | null };
  'models:add-vision': { request: { modelId: string }; response: { downloadId: string } | null };
  'models:memory-check': { request: { modelId: string }; response: Answer<'modelManager', 'memoryCheck'> };
  'models:load': { request: { modelId: string }; response: true };
}
