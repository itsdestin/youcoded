// create-runtime.ts — builds the assistant's runtime (the "core") with no Electron in reach.
//
// WHY (2026-09-29 one-core R1): this construction used to sit in the middle of
// registerIpcHandlers, so the desktop window door built the runtime and the phone door
// (RemoteServer) got it handed over afterwards through a setter. Now main.ts calls
// createRuntime once and gives the SAME result to both doors. Everything here is plain
// Node: the few things only the host OS can do arrive through `platform`
// (main/platform.ts), and the profile folder / app version arrive as plain values.
// tests/create-runtime.test.ts proves nothing reachable from this file imports Electron.
import fs from 'fs';
import path from 'path';
import os from 'os';
import { generateText } from 'ai';
import { hasRealTitle } from '../shared/session-title';
import type { SessionProvider } from '../shared/types';
import type { ModelBinding } from '../shared/provider-types';
import { ENGINE_PORT } from '../shared/ports';
import { NativeHome } from './native-home';
import { SecretsStore } from './providers/secrets-store';
import { ProviderRegistry } from './providers/provider-registry';
import { OpenRouterHealth } from './providers/openrouter-health';
import { OpenRouterSignIn } from './providers/openrouter-oauth';
import { ClaudeAccount } from './providers/claude-account';
import type { ChatGptAuth } from './providers/chatgpt-auth';
import { createSessionNamer } from './session-namer';
import { NamingSettings } from './naming-settings';
import { ModelCatalog } from './providers/model-catalog';
import { EngineManager } from './engine/engine-manager';
import { ModelManager } from './models/model-manager';
import { SessionStore } from './harness/session-store';
import { NativeSessionHost } from './harness/native-session-host';
import { startAdminPassword } from './harness/admin-password-startup';
import { AcceptedHistoryStore } from './harness/accepted-history-store';
import { SpecialistCatalog } from './harness/specialists/catalog';
import type { ProfileProviderType } from './harness/capability-profile';
import { PermissionStore } from './harness/permission-store';
import { StepGuardSettings } from './harness/step-guard-settings';
import { ContextSettingsStore } from './harness/context-settings-store';
import { McpRegistry } from './harness/mcp/mcp-registry';
import { McpManager } from './harness/mcp/mcp-manager';
import { createConnection } from './harness/mcp/mcp-client';
import { SearchKeyStore } from './harness/search/search-key-store';
import { SearchService } from './harness/search/search-service';
import { SearchChain } from './harness/search/search-chain';
import { exaBackend } from './harness/search/backends/exa';
import { ddgBackend } from './harness/search/backends/ddg';
import { tavilyBackend } from './harness/search/backends/tavily';
import {
  noteTitleChanged, getConversationStore, getNamingRecord, mutateNamingRecord,
} from './conversations/service';
import { createTitleQueue, mayPublishAutomaticName } from './conversations/naming-store';
import { bindingToPortableModel } from './conversations/portable-model';
import type { PortableModelRef } from './conversations/store-core';
import type { SessionInfo } from '../shared/types';
import type { Platform } from './platform';
import { createSessionState, type SessionState } from './ipc/session-state';
import { SessionRecords } from './session-record';
import { AudienceFills } from './audience-fill';

export interface CreateRuntimeDeps {
  /** The profile folder (Electron's userData in the app). Every private file lives under it. */
  userDataDir: string;
  /** Injected once into the native system prompt (the host cannot import Electron's `app`). */
  appVersion: string;
  /** What only the host OS can do. */
  platform: Platform;
  /** main.ts's Sign in with ChatGPT account (its file reader stays alive under the kill
   *  switch; the switch itself is applied HERE, exactly as registerIpcHandlers did). */
  chatgptAuth?: ChatGptAuth | null;
  /** The session list, read for names only (title checks). Structural so this file needs
   *  no import of session-manager (which pulls in Electron). */
  sessionManager: { getSession(id: string): Pick<SessionInfo, 'name'> | undefined | null };
}

/** The slice of the runtime the phone door (RemoteServer) reads. */
export type RemoteNativeRuntime = Pick<NativeRuntime,
  'nativeHost' | 'providerRegistry' | 'modelCatalog' | 'engineManager' | 'modelManager' | 'searchKeyStore'
  | 'searchService' | 'permissionStore' | 'stepGuardSettings' | 'contextSettings' | 'specialistCatalog'
  | 'chatgptAuth' | 'claudeAccount' | 'openRouterSignIn' | 'resolvePortableModel'
  // WHY sessionState (2026-09-30 one-core R3-7): the artifact channels match a session's files to its conversation
  // through the ONE id map, for a window and for a phone.
  | 'sessionState'
  // WHY records and fills (one-core R5-2): the phone door fills a screen from the record (session:open) and holds a
  // screen's pushes while it is being filled, the same as the computer's door.
  | 'records' | 'fills'>;

type TitleAppliedListener = (desktopId: string, title: string) => void;

export interface NativeRuntime {
  nativeHome: NativeHome;
  permissionStore: PermissionStore;
  stepGuardSettings: StepGuardSettings;
  contextSettings: ContextSettingsStore;
  secretsStore: SecretsStore;
  engineManager: EngineManager;
  /** ChatGPT account with the YOUCODED_CHATGPT=0 kill switch applied (null = feature off). */
  chatgptAuth: ChatGptAuth | null;
  providerRegistry: ProviderRegistry;
  openRouterSignIn: OpenRouterSignIn;
  modelCatalog: ModelCatalog;
  claudeAccount: ClaudeAccount;
  searchKeyStore: SearchKeyStore;
  searchService: SearchService;
  specialistCatalog: SpecialistCatalog;
  nativeHost: NativeSessionHost;
  modelManager: ModelManager;
  namingSettings: NamingSettings;
  sessionNamer: ReturnType<typeof createSessionNamer>;
  applyAutomaticTitle: (
    desktopId: string, storeId: string, provider: SessionProvider, title: string,
    expectedAutoAt?: string, opening?: boolean,
  ) => Promise<boolean>;
  queueTitle: ReturnType<typeof createTitleQueue>;
  publishNamingMode: () => void;
  resolvePortableModel: (sessionId: string) => Promise<PortableModelRef | null>;
  stampProviderTypes: (rows: SessionInfo[]) => Promise<SessionInfo[]>;
  /** The per-session maps every door shares — ONE copy, owned here. */
  sessionState: SessionState;
  /** The computer's record of each session: epoch, numbered event ring, open asks, live facts (session-record.ts). */
  records: SessionRecords;
  /** Pushes held for a screen that is being filled with a session (audience-fill.ts). */
  fills: AudienceFills;
  /** A door subscribes to hear an automatic title land (window push + phone push). */
  onTitleApplied(listener: TitleAppliedListener): void;
  /** Runtime half of app quit. Returns the engine-stop promise so quit can await it. */
  cleanup(): Promise<void>;
}

export function createRuntime(deps: CreateRuntimeDeps): NativeRuntime {
  const { userDataDir, appVersion, platform, sessionManager } = deps;
  // WHY here, not a module-level export: one runtime, one map set — a second
  // createRuntime (tests) must not share state with the first.
  const sessionState = createSessionState();
  const titleListeners: TitleAppliedListener[] = [];
  const topicDir = path.join(os.homedir(), '.claude', 'topics');
  // Store title check that looks through the placeholder names planted on resumed
  // sessions (moved with the provisional-title map; see session-state.ts).
  const liveNameForTitleCheck = (desktopId: string): string | undefined =>
    sessionState.provisionalResumeTitles.forTitleCheck(desktopId, sessionManager.getSession(desktopId)?.name);

  // --- Native runtime stack (Phase 1 Plan A, Task 9) ---
  // NativeHome is the single writer for ~/.youcoded/; SecretsStore keeps API
  // keys in Electron's safeStorage-encrypted userData (NOT in the syncable home
  // dir). ProviderRegistry.init() seeds the built-in providers under the file
  // lock (fire-and-forget — list/languageModel read on demand). The catalog's
  // contextLengthFor feeds HarnessSession's context-window sizing.
  const nativeHome = new NativeHome();
  // Hoisted out of the NativeSessionHost constructor call below (M5 2a): the
  // permissions:list handler and the remote-server WS case both need to READ the
  // same store the host writes through. Constructing a second one would still
  // work (they share one file under NativeHome's lock) but would make the
  // "one store" invariant a coincidence rather than a fact.
  const permissionStore = new PermissionStore(nativeHome);
  const stepGuardSettings = new StepGuardSettings(nativeHome);
  const contextSettings = new ContextSettingsStore(nativeHome);
  const secretsStore = new SecretsStore(userDataDir, platform.secretStorage);
  // Plan B: the local engine. EngineManager owns acquisition + supervision; its
  // hook makes the 'local' provider real and its listModels feeds the model
  // picker. ENGINE_PORT rides the shifted-port scheme so the dev instance and
  // the built app never fight over one llama-server.
  const engineManager = new EngineManager(nativeHome, userDataDir, ENGINE_PORT);
  // Bring an already-installed engine up to the pinned version, in the background.
  // Fire-and-forget by design — it never throws, never blocks startup, and skips
  // itself entirely when nothing is installed yet (a first install stays the user's
  // call). Without this a pin bump reaches nobody: EngineAcquisition.installed()
  // keeps serving whatever version is on disk, so a model needing a newer llama.cpp
  // just looks like a broken app.
  void engineManager.autoUpdateOnLaunch();
  // Sign in with ChatGPT — the kill switch (§6). `chatgptForUi` is what the
  // registry, the catalog, the four handlers and the remote WS cases see: null
  // under YOUCODED_CHATGPT=0 so the plan's row and models vanish and every
  // surface answers signed-out, while `chatgptAuth` itself (main.ts's file
  // reader) is untouched. Stored tokens are left alone — the flag is a fast
  // revert, not a sign-out.
  const chatgptForUi: ChatGptAuth | null = process.env.YOUCODED_CHATGPT !== '0' ? (deps.chatgptAuth ?? null) : null;
  // Connection trust (§3.1): what OpenRouter last said about THIS profile's
  // key, stored beside its secrets (userData), never in shared ~/.youcoded.
  const openRouterHealth = new OpenRouterHealth({ dir: userDataDir });
  const providerRegistry = new ProviderRegistry(nativeHome, secretsStore, engineManager.registryHook(), chatgptForUi, openRouterHealth);
  void providerRegistry.init();
  // Re-check the OpenRouter key shortly after launch and every 5 minutes, so a
  // key that died while the app sat idle reads as dead before anyone sends a
  // message. refreshOpenRouter asks nothing unless OpenRouter is on with a key.
  // (The ChatGPT usage poll's cadence — providers/chatgpt-auth.ts USAGE_POLL_MS.)
  setTimeout(() => { void providerRegistry.refreshOpenRouter(); }, 5_000).unref?.();
  setInterval(() => { void providerRegistry.refreshOpenRouter(); }, 5 * 60_000).unref?.();
  // Sign in with OpenRouter (§3.5). The key it brings back takes the paste
  // path: checked first, and saved only if OpenRouter didn't refuse it.
  const openRouterSignIn = new OpenRouterSignIn({
    openExternal: (url) => platform.openExternal(url),
    acceptKey: async (key) => {
      const check = await providerRegistry.testConnection('openrouter', key);
      if (check.verdict !== 'rejected') await providerRegistry.setKey('openrouter', key);
      return check;
    },
  });
  const modelCatalog = new ModelCatalog(userDataDir, undefined, {
    // WHY read defaults at resolution time, never mutate budgets of active sessions.
    contextPreferences: () => contextSettings.read(),
    localModels: () => engineManager.catalogModels(),
    // The plan's models come from ChatGptAuth's manifest cache (§4.2); absent
    // under the kill switch so the catalog contributes nothing for 'chatgpt'.
    ...(chatgptForUi ? { chatgptModels: () => chatgptForUi.models() } : {}),
  });
  // WebSearch stack (Phase 2 Plan B): keys live in SecretsStore, the ref map in
  // ~/.youcoded/search-providers.json (via NativeHome). SearchChain caches the
  // patchable backend chain under userData — the SAME cache-dir convention as
  // ModelCatalog/CuratedCatalog (both take userDataDir). The
  // SearchService is injected into the native tool framework as `toolServices`
  // so the WebSearch tool can reach it (see NativeSessionHost.toolWiring).
  // Claude Code's live sign-in probe (2026-09-09). ONE instance for the whole
  // process, because the cache is the point: the model menu, the Cloud
  // providers card and the new-session form all ask, and a second instance
  // would mean a second `claude auth status` spawn for the same answer.
  // Shared with the remote server below so a paired browser gets the desktop's
  // real answer rather than its own guess.
  const claudeAccount = new ClaudeAccount();
  const searchKeyStore = new SearchKeyStore(nativeHome, secretsStore);
  const searchService = new SearchService(
    new SearchChain(userDataDir),
    searchKeyStore,
    { exa: exaBackend, ddg: ddgBackend, tavily: tavilyBackend },
  );
  // Task 7b: this is the ONLY production construction site for both classes —
  // without it every piece of the native-MCP stack (registry, client, pooled
  // manager, tool adapter) is unreachable dead code (see task-7b-brief.md).
  // Registry rides the SAME nativeHome/secretsStore instances as everything
  // else above (never a duplicate) — same precedent as SearchKeyStore just
  // above. connectionFactory is mcp-client's real createConnection, unwrapped
  // (no fake, no override) — every server it pools is a real subprocess/HTTP
  // client once acquired.
  //
  // Construction itself is side-effect-free: McpRegistry.list()/
  // resolveAllEnabled() only READ ~/.youcoded/mcp.json (NativeHome.readJson
  // never creates the directory — see native-home.ts's lazy-creation
  // invariant), and McpManager's constructor does no I/O at all. Nothing here
  // connects to a server or spawns a subprocess: that only happens inside
  // acquire(), called per-session by NativeSessionHost (Task 6's wiring)
  // below. A user with no ~/.youcoded/mcp.json configured gets zero
  // directory creation, zero subprocesses, and zero log output from this
  // line — the normal case for almost every install.
  const mcpRegistry = new McpRegistry(nativeHome, secretsStore);
  const mcpManager = new McpManager({ registry: mcpRegistry, connectionFactory: createConnection });
  // Task 4 (plan 1c) — the real per-cwd specialist catalog: reads personal
  // (~/.youcoded/specialists/), Claude-Code user-level (~/.claude/agents/),
  // and each project's own .claude/agents/, merged with the four built-ins.
  // ONE instance for the app's whole life, shared by every project folder —
  // its in-memory per-source state is what makes re-reading only a CHANGED
  // folder work across turns and across conversations sharing one project.
  const specialistCatalog = new SpecialistCatalog({ home: nativeHome });
  // Durable accepted-history continuation (cache Stage 4). Profile-PRIVATE
  // state: it lives under Electron's userData, never under NativeHome (which
  // syncs) and never beside the transcripts it describes. One sweep at startup
  // drops sidecars whose transcript is gone — the only lifecycle boundary the
  // app has, since there is no native transcript-deletion UI today.
  const acceptedHistory = new AcceptedHistoryStore(userDataDir);
  void acceptedHistory.cleanupOrphans().catch(() => { /* best-effort cleanup */ });
  const nativeHost = new NativeSessionHost(
    new SessionStore(nativeHome),
    // Pass the per-turn opts (e.g. serialToolCalls for small local models) straight through.
    (binding, opts) => providerRegistry.languageModel(binding, opts),
    // Context-window sizing AND the engine's real parallel-slot count, from
    // ONE closure. Fix pass 2 (Task 13): the first fix threaded contextLength
    // and totalSlots through two SEPARATE closures that shared one /props
    // reading via a module-scoped `lastLocalSlotReading` variable — correct
    // only if native-session-host.ts always awaited them back-to-back for the
    // same binding with nothing else able to run in between. It doesn't hold:
    // two local-engine sessions starting concurrently, or a cloud binding's
    // resolution landing between the two awaits (which reset the shared
    // variable to null), could read another binding's slot count or a wrong
    // null — silently, with no throw. Returning both values from this single
    // call removes the shared state entirely, so there is no ordering left to
    // break. For LOCAL models this still costs exactly ONE /props round trip
    // (effectiveContextWindow reads context AND slots from the same response);
    // remote/API models keep the catalog's context number and report
    // totalSlots: null (hosted concurrency is a flat constant, not
    // engine-measured — see capability-profile.ts's CLOUD_DEFAULT).
    async (binding) => {
      const providers = await providerRegistry.list();
      const p = providers.find((x) => x.id === binding.providerId);
      if (p?.type === 'local-engine') return engineManager.effectiveContextWindow(binding.modelId);
      return { contextLength: await modelCatalog.contextLengthFor(binding, providers), totalSlots: null };
    },
    // Provider TYPE resolver (Task 5): the host picks a CapabilityProfile from
    // this. Unknown provider → null, so the host falls back to a cloud-safe
    // default. ProviderType and ProfileProviderType are the same union today.
    async (binding) => {
      const p = (await providerRegistry.list()).find((x) => x.id === binding.providerId);
      return (p?.type as ProfileProviderType) ?? null;
    },
    // Vision-support resolver (Task 6c; local models added by T18, design §E5).
    // TWO provider types can answer "does THIS model accept images" from real
    // per-model data rather than a hand-maintained guess, and both answer it
    // through the SAME catalog field — so there is ONE lookup here, not two
    // mechanisms:
    //   - OpenRouter, from `architecture.input_modalities` on its /models rows
    //     (parsed in model-catalog.ts's openrouterModels());
    //   - the LOCAL engine, from the identically-named field on llama-server's
    //     own `GET /models` (kept by EngineSupervisor.listModels, turned into
    //     CatalogModel.supportsVision by EngineManager.catalogModels) — which
    //     is `["text","image"]` exactly when the router paired an mmproj
    //     projector beside the model.
    // Every OTHER provider type has no such signal, so this still returns null
    // for them and lets resolveProfile fall back to the registry/provider-type
    // default. That short-circuit mirrors the context/slots closure above (same
    // `providers`/`p` lookup, just gated on provider type) and is what keeps
    // this closure off a session start it does not apply to: a direct-key or
    // openai-compatible binding never touches modelCatalog at all.
    // A local binding DOES now pay a catalog read, and this closure is the
    // FIRST AND ONLY modelCatalog.get() on a local session start — the
    // context/slots closure above asks the ENGINE, and the price closure below
    // short-circuits local before the catalog. What keeps that read cheap is
    // ModelCatalog.get()'s own network gate — it skips its two upstream fetches
    // when no provider in the list can consume them — plus the fact that we
    // hand it ONLY the binding's own provider (see below). Together those make
    // a purely local, OFFLINE session start cost nothing. Without that gate this cost 4 fetches and
    // 15.1 s on every create/resume/swap, with no memoization (measured
    // 2026-09-05) — see the WHY at model-catalog.ts's get(). What is left is
    // the engine's own listModels: a localhost GET while the engine runs (it
    // does by now — the context closure above booted it), a disk scan
    // otherwise.
    // modelCatalog.get() never throws (its own contract — a dead network
    // degrades to stale cache or an empty list, and an unavailable engine
    // degrades to no local rows), so there is nothing to catch here; a cache
    // miss, an unknown model, or a router that reported no modalities all fall
    // through the `?.supportsVision` chain to null, which means "don't know".
    // Be aware where that honesty ends: capability-profile's visionFor() turns
    // an undiscovered answer into a hard `false` at the profile layer, because
    // there is no third state for the harness to act on. That is the safe
    // direction — a wrong false means the model is told the picture cannot be
    // delivered, a wrong true fails the whole turn with a provider error.
    async (binding) => {
      const providers = await providerRegistry.list();
      const p = providers.find((x) => x.id === binding.providerId);
      if (p?.type !== 'openrouter' && p?.type !== 'local-engine') return null;
      // `[p]`, not the whole list: the lookup below only ever inspects rows of
      // the BINDING'S OWN provider, so every other provider's rows are built
      // and discarded. Narrowing is what makes the network gate in
      // ModelCatalog.get() actually reach the offline local user — 'openrouter'
      // ships ENABLED by default (provider-registry's BUILT_INS), so handing
      // over the full list would drag its fetch in on every local session start
      // even for someone who has never touched it. Same rows out, since get()
      // is scoped to the providers it is handed.
      const models = await modelCatalog.get([p]);
      const hit = models.find((m) => m.providerId === binding.providerId && m.id === binding.modelId);
      return hit?.supportsVision ?? null;
    },
    // Price resolver (Task 11, spec §5): reads the SAME catalog the model
    // picker shows, so the price the user sees when choosing a model is the
    // price the session-cost chip charges. Short-circuits local-engine before
    // touching the catalog — a model running on this machine costs nothing to
    // run and its rows carry no price anyway; the host stamps those turns
    // `free` instead. modelCatalog.get() never throws (its own contract: a
    // dead network degrades to stale cache or an empty list), and a model
    // that isn't in the catalog falls through to null, which means "no
    // published price" — never a guessed zero.
    async (binding) => {
      const providers = await providerRegistry.list();
      const p = providers.find((x) => x.id === binding.providerId);
      if (p?.type === 'local-engine') return null;
      // `[p]`, not `providers` — the same narrowing the vision closure above
      // already has, for the same reason: this lookup only ever reads the
      // binding's own provider's rows, so handing over the whole list built
      // and threw away every OTHER provider's catalog on every hosted
      // create/resume/swap (measured 2026-09-05 while fixing the local half).
      // A provider missing from the registry is caught below: `p` undefined
      // means no rows, and the lookup falls through to null as before.
      const models = await modelCatalog.get(p ? [p] : []);
      const hit = models.find((m) => m.providerId === binding.providerId && m.id === binding.modelId);
      return hit?.pricing ?? null;
    },
    // Remembered "Always allow" rules (per-project, ~/.youcoded/permissions.json)
    // + the injected app version for the once-per-session assembled system prompt
    // (electron `app` isn't importable in the host's own test env — inject here).
    permissionStore,
    appVersion,
    // Runtime services threaded into every native tool's ToolContext — WebSearch
    // reads services.search (the chain-walking SearchService).
    {
      search: searchService,
      // Task 14 fix pass: same shape as the context/slots (~2295) and
      // vision-support (~2324) closures above — providers first, then the
      // catalog rows for those providers. NativeSessionHost.toolWiring()
      // recombines this with its own host-internal DelegatedModels store into
      // services.models, so ModelSearch and a per-hire specific-model-id
      // override can actually confirm a real id instead of always seeing
      // "catalog not loaded" (the null default this closure replaces).
      modelCatalog: async () => modelCatalog.get(await providerRegistry.list()),
    },
    // skillCatalog (9th param, shifted from 10th by fix pass 2 collapsing the
    // context and slot-count closures back into one): NOT wired yet — a
    // different task's scope (see task-7b-brief.md "Explicitly NOT in
    // scope"). Passed explicitly so mcpManager lands in the 10th positional
    // slot instead of silently taking skillCatalog's place.
    undefined,
    // mcpManager (10th param, Task 7b — shifted from 11th by the same
    // collapse): makes the whole native-MCP stack reachable — see the
    // construction comment above.
    mcpManager,
    // nativeHome (11th param, plan 1b Task 2): backs the DelegationLedger the
    // host constructs internally (see delegation-ledger.ts) — the SAME
    // nativeHome instance every other ~/.youcoded/ writer above shares, never
    // a second one.
    nativeHome,
    // specialistCatalog (12th param, Task 4 plan 1c; the ask-hold parameter
    // that sat before it was removed 2026-09-16): the real catalog built
    // above, sharing nativeHome with every other ~/.youcoded/ writer here.
    specialistCatalog,
    () => stepGuardSettings.read(),
    // Continuation (15th param): the private store above, plus the registry's
    // SINGLE continuation-identity method — the same one the ChatGPT model's
    // owner closure calls, so what the harness accepts and what a resume looks
    // up can never disagree. It throws when ChatGPT is signed out; the host
    // treats that as a fallback to ordinary reconstruction.
    { acceptedHistory, continuationIdentityFor: (binding) => providerRegistry.continuationIdentity(binding) },
  );

  // admin-password: the password card's app-start wiring and its quit teardown
  // (harness/admin-password-startup.ts). Always settles this machine's capability,
  // which session creation below awaits.
  const stopAdminPassword = startAdminPassword(nativeHost, platform.resolveAskpassPaths);

  // Task 4: resolves sessionId's CURRENT model binding into the portable ref
  // noteModelUsed persists — thin async wrapper around bindingToPortableModel
  // (portable-model.ts) closed over the live nativeHost/providerRegistry.
  // Returns null (write nothing) when the session has no live binding or its
  // provider has vanished from the registry — never guess.
  const resolvePortableModel = async (sessionId: string): Promise<PortableModelRef | null> =>
    bindingToPortableModel(nativeHost.getBinding(sessionId), await providerRegistry.list());

  // One registry read for a whole listing (§4.9, review T6 F1). Returns copies:
  // SessionInfo objects are owned by SessionManager and must not be mutated here.
  const stampProviderTypes = async (rows: SessionInfo[]): Promise<SessionInfo[]> => {
    if (!rows.some((s) => s.provider === 'native')) return rows;
    const providers = await providerRegistry.list();
    return rows.map((s) => {
      if (s.provider !== 'native') return s;
      const ref = bindingToPortableModel(nativeHost.getBinding(s.id), providers);
      return ref ? { ...s, providerType: ref.providerType } : s;
    });
  };

  // Session naming (2026-09-09 contract). ONE policy for both lanes: Off,
  // Basic (quote the opening request, no model call) and AI (review at
  // completed replies 1, 3, then every 25). It replaces the old
  // native-title-feeder, whose rule was "one bound-model call at the first
  // turn-complete, native only". See session-namer.ts for the schedule, the
  // ownership guard and the commit-time re-checks.
  const namingSettings = new NamingSettings(nativeHome);

  /**
   * Publish the current mode where the bundled Auto-Title hook can read it.
   * The hook runs inside the Claude Code process and cannot ask the app
   * anything, so this one-word file is the whole protocol: it is what makes Off
   * and Basic stop the hook from interrupting a reply to request a title, and
   * what switches AI onto the app's review schedule instead of the hook's old
   * 120s/600s timer. Written at startup and after every settings change.
   *
   * WHY it lives under userData and travels by ENV rather than sitting at a
   * fixed path in ~/.claude/topics: that directory is shared by every YouCoded
   * process on the machine, so a dev instance set to Off would silently switch
   * off auto-titling in Destin's installed app. run-dev.sh isolates userData,
   * so one file per instance is one setting per instance. The env var is set on
   * the MAIN process before any session spawns, and the pty worker passes its
   * whole environment down, so every Claude Code session inherits it. A session
   * that somehow has neither falls back to the hook's own timer.
   */
  const namingModeFile = path.join(userDataDir, 'naming-mode');
  const publishNamingMode = () => {
    try {
      fs.mkdirSync(path.dirname(namingModeFile), { recursive: true });
      fs.writeFileSync(namingModeFile, `${namingSettings.read().mode}\n`);
      process.env.YOUCODED_NAMING_MODE_FILE = namingModeFile;
    } catch { /* best-effort: the hook falls back to its own timer */ }
  };

  // Store identity for a live session, or null when it is not knowable yet.
  // Native ids are identity-mapped into sessionIdMap; a CC session only
  // becomes identifiable once a hook event has told us its Claude id.
  const namingIdentity = (sessionId: string): { provider: string; storeId: string } | null => {
    const resolved = sessionState.sessionIdMap.get(sessionId) || sessionId;
    if (nativeHost.isNativeSessionId(resolved)) return { provider: 'native', storeId: resolved };
    if (sessionState.sessionIdMap.has(sessionId)) return { provider: 'claude', storeId: resolved };
    return null;
  };

  // Serialize local title projections with manual renames. This is NOT the
  // cross-process sidecar lock: no filesystem lock is held across store awaits.
  const queueTitle = createTitleQueue();

  /**
   * Publish an AUTOMATIC name: persist, then paint. Every generated title in
   * the app goes through here — the topic watcher below included — so the
   * ownership check and the persist-before-broadcast order exist in exactly
   * one place. Returns false when the user owns the name, so a caller that
   * caches "the last topic I applied" does not record one it did not apply.
   */
  const applyAutomaticTitle = async (
    desktopId: string, storeId: string, provider: SessionProvider, title: string,
    expectedAutoAt?: string, opening = false,
  ): Promise<boolean> => queueTitle(`${provider}/${storeId}`, async () => {
    const eligible = () => namingSettings.read().mode !== 'off';
    const read = () => getNamingRecord(provider, storeId);
    const hasTitle = async () => {
      const rec = await getConversationStore()?.get(provider, storeId);
      return hasRealTitle(rec?.title, liveNameForTitleCheck(desktopId));
    };
    if (!await mayPublishAutomaticName({ read, hasTitle, name: title, expectedAutoAt, opening, enabled: eligible })) return false;
    let publicationStamp = expectedAutoAt;
    if (publicationStamp === undefined) {
      // The CC hook has not yet written its sidecar. Refuse a newer review
      // that wins the lock after our read rather than rolling it back.
      const before = await read();
      let wrote = false;
      const at = new Date().toISOString();
      const written = await mutateNamingRecord(provider, storeId, (cur) => {
        if (cur.manual || cur.auto !== (before?.auto ?? '') ||
            cur.autoAt !== (before?.autoAt ?? cur.autoAt)) return cur;
        wrote = true;
        return { ...cur, auto: title, autoAt: at };
      });
      if (!written || !wrote) return false;
      publicationStamp = at;
    }
    // Namer writes already went through the sidecar lock; do NOT call
    // noteAutomaticTitle again: it would re-write an older opening title over
    // a newer AI review between the first write and this projection.
    if (!await mayPublishAutomaticName({ read, hasTitle, name: title,
      expectedAutoAt: publicationStamp, opening, enabled: eligible })) return false;
    const previousTitle = (await getConversationStore()?.get(provider, storeId))?.title ?? '';
    const result = await noteTitleChanged(storeId, title, provider);
    if (!result.ok) return false;
    if (!await mayPublishAutomaticName({ read, hasTitle: async () => false,
      name: title, expectedAutoAt: publicationStamp, enabled: eligible })) {
      // A rename/Off may have landed during the projection await. Restore the
      // authority's name (or the prior title when Off) instead of leaving a
      // stale compatibility projection for older readers. A queued local manual
      // rename will subsequently make its own projection and broadcast.
      const current = await read();
      const restored = current?.manual || (eligible() ? current?.auto : previousTitle);
      if (restored !== undefined && restored !== title) await noteTitleChanged(storeId, restored, provider);
      return false;
    }
    // WHY (2026-09-29 one-core R1): pushing the new name to windows and phones is a
    // DOOR job (it needs the window registry and the remote server, neither of which
    // exists in the core). The core announces; registerIpcHandlers subscribes and does
    // the same two calls (sendForSession SESSION_RENAMED + broadcastRename) it did inline.
    for (const l of titleListeners) l(desktopId, title);
    return true;
  });

  const sessionNamer = createSessionNamer({
    settings: () => namingSettings.read(),
    identify: namingIdentity,
    readNaming: (provider, storeId) => getNamingRecord(provider as SessionProvider, storeId),
    mutateNaming: async (provider, storeId, fn) => {
      const rec = await mutateNamingRecord(provider, storeId, fn);
      // A null store (no managed roots this launch) must not look like a
      // successful write — the namer treats a throw as "skip this reply".
      if (!rec) throw new Error('conversation storage is not available');
      return rec;
    },
    getBinding: (sessionId: string) => nativeHost.getBinding(sessionId),
    // Bounded with a 15s abort — a bare unbounded generateText await would
    // hang the namer (same hazard class as the compaction-hang rule).
    // providerRegistry.languageModel() throws for an unconfigured/disabled/
    // removed provider; that rejection is the namer's "stay silent, retry"
    // path, which is why nothing is caught here.
    generate: async (binding: ModelBinding, prompt: string) => {
      const model = await providerRegistry.languageModel(binding);
      const { text } = await generateText({ model, prompt, abortSignal: AbortSignal.timeout(15_000) });
      return text;
    },
    // The free lane for a Claude Code session with no separately chosen naming
    // model: its model lives inside the CLI, so the bundled Auto-Title hook
    // asks it, in-session, at no extra cost. This file is the whole protocol —
    // the hook writes a topic only when it finds one (hook-scripts/
    // title-update.sh), which is what turned ~6 unsolicited title requests per
    // conversation into exactly the scheduled ones.
    askInSessionModel: (_sessionId: string, storeId: string) => {
      try {
        fs.mkdirSync(topicDir, { recursive: true });
        fs.writeFileSync(path.join(topicDir, `ask-${storeId}`), '');
      } catch { /* best-effort: a missed ask retries at the next review */ }
    },
    // A resumed chat's provisional opening words are not a name to "keep", or
    // the review would echo them back as the title (createProvisionalTitles).
    currentName: (sessionId: string) => sessionState.provisionalResumeTitles.forNamer(sessionId, sessionManager.getSession(sessionId)?.name),
    // Store title wins; the live session name covers the boot window before
    // the store's first upsert. BOTH halves go through the shared placeholder
    // predicate — the 2026-08-06 lesson: a check that only excluded 'New
    // Session' read a resumed session's 'Resuming…' as a real title.
    hasTitle: async (sessionId: string) => {
      const ident = namingIdentity(sessionId);
      if (!ident) return true; // unknown identity: assume named rather than overwrite
      const rec = await getConversationStore()?.get(ident.provider, ident.storeId);
      return hasRealTitle(rec?.title, liveNameForTitleCheck(sessionId));
    },
    publish: async (sessionId: string, name: string, expectedAutoAt: string, opening: boolean) => {
      const ident = namingIdentity(sessionId);
      if (!ident) return;
      await applyAutomaticTitle(sessionId, ident.storeId, ident.provider as SessionProvider, name, expectedAutoAt, opening);
    },
  });

  // Plan C: model manager (curated catalog, HF search, downloads, detectors).
  // Built with the rest so the desktop door and the phone door reach the SAME instance (the
  // models:* handlers themselves are registered in ipc-handlers, next to the engine block).
  const modelManager = new ModelManager(nativeHome, engineManager, userDataDir);

  // WHY here (one-core R5-1): the record belongs to the core, not to either door, so the window door's publish
  // and the phone door's hook feed write to ONE copy. Native sessions' queue and mode are read from the host
  // that owns them (never copied); every other fact is folded from the events publish carries.
  const records = new SessionRecords();
  const fills = new AudienceFills();
  records.setLiveSource((sessionId) => (nativeHost.isNativeSessionId(sessionId)
    ? { queued: nativeHost.queuedMessageIds(sessionId), permissionMode: nativeHost.getPermissionMode(sessionId) }
    : null));

  return {
    nativeHome, permissionStore, stepGuardSettings, contextSettings, secretsStore, engineManager,
    chatgptAuth: chatgptForUi, providerRegistry, openRouterSignIn, modelCatalog, claudeAccount,
    searchKeyStore, searchService, specialistCatalog, nativeHost, modelManager, namingSettings,
    sessionNamer, applyAutomaticTitle, queueTitle, publishNamingMode, resolvePortableModel,
    stampProviderTypes, sessionState, records, fills,
    onTitleApplied: (listener) => { titleListeners.push(listener); },
    cleanup: () => {
      openRouterSignIn.dispose();
      // Flush + tear down every live native session on quit (best-effort, bounded
      // to one in-flight streaming part). Fire-and-forget with .catch — cleanup()
      // is synchronous and callers don't await it, so this mirrors the async
      // stopSyncSpaces() teardown pattern in main.ts window-all-closed.
      void nativeHost.destroyAll().catch(() => {});
      stopAdminPassword(); // refuse open password asks; final forget sweep
      // Awaited by the caller: never leave an orphaned llama-server on quit.
      const engineStopped = engineManager.stopAll().catch(() => {});
      sessionState.dispose();
      records.clear();
      fills.clear();
      return engineStopped;
    },
  };
}
