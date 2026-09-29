// first-run.ts — the setup wizard's channels and the band above the message box, for the computer's
// own windows.
//
// WHY (2026-09-30 one-core R3-3): these ten handlers were spread over four hand-written places:
// registerFirstRunIpc and the late sign-in copy of it in main.ts (two near-identical sets, one of
// which logged failures and one of which swallowed them), registerFirstRunLocalIpc (called from
// both), and the band's two handlers in ipc-handlers.ts. A phone had no case for any of them and
// was told "not available over remote access" (the shim answers `firstRun` itself, without asking
// the computer). Kept exactly: every entry is `desktopOnly`. First-run is the computer's own setup.
// Two behaviour notes, neither visible on screen:
//   - Failures in the late sign-in copy are now logged like the first copy's (they were swallowed).
//   - Before its manager exists (a launch that is not a first run and has not needed the late
//     sign-in yet) retry/start-auth/etc. now do nothing, where they used to throw "no handler".
// The wizard itself (FirstRunManager) is created in main.ts, after the window, so main.ts hands it
// over through bindFirstRunManager; everything registerIpcHandlers builds arrives through
// bindFirstRunNative. The `first-run:state` PUSH (state changes) keeps living in main.ts: a push has
// no receiver here and shares the channel name with the request below.
import type { FirstRunManager, FirstRunNativeDeps, OpenRouterSignInAuth } from '../first-run';
import type { ChatGptAuth } from '../providers/chatgpt-auth';
import type { ProviderRegistry } from '../providers/provider-registry';
import type { ClaudeAccount } from '../providers/claude-account';
import type { EngineManager } from '../engine/engine-manager';
import type { ModelManager } from '../models/model-manager';
import type { DownloadProgress } from '../../shared/model-manager-types';
import { IPC } from '../../shared/backend-contract';
import { firstRunStateDir, markSetupCompleted } from '../first-run';
import { clearSetupDownload, computeSetupDownloadStatus, pickSuggestedModel, readSetupDownload } from '../first-run-local';
import { log } from '../logger';
import { defineChannel, type MainChannelDef } from './channel-def';

interface NativeBinding {
  nativeDeps: FirstRunNativeDeps;
  openRouterSignIn: OpenRouterSignInAuth;
  providerRegistry: Pick<ProviderRegistry, 'list'>;
  claudeAccount: Pick<ClaudeAccount, 'status'>;
  engineManager: Pick<EngineManager, 'installedModels'>;
  modelManager: Pick<ModelManager, 'resume' | 'on'>;
}
interface ManagerBinding {
  /** The wizard's manager, or null when no wizard is running. */
  getManager: () => FirstRunManager | null;
  /** What first-run:state answers (main.ts owns the late "is auth still usable?" check). */
  getState: () => unknown;
  /** Null = the ChatGPT sign-in arm is off (the late copy's kill-switch gate). */
  chatgptAuth: ChatGptAuth | null;
}

let native: NativeBinding | null = null;
let wizard: ManagerBinding | null = null;
/** Progress of the setup download, per model file, for the band's rate and minutes-left. */
const setupLive = new Map<string, { latest: DownloadProgress; first: { at: number; bytes: number } }>();

/** Called once by registerIpcHandlers with what it builds (providers, engine, models, deps). */
export function bindFirstRunNative(next: NativeBinding): void {
  native = next;
  // The band above the message box reads this AFTER setup, when main.ts wires no wizard at all, so the
  // listener lives with the channel, registered on every launch.
  next.modelManager.on('download-progress', (p: DownloadProgress) => {
    const key = `${p.repo}::${p.quant}`;
    const prev = setupLive.get(key);
    // The rate is measured from the first event of THIS attempt, so a resume does not inherit the
    // previous attempt's clock.
    const first = prev && prev.latest.downloadId === p.downloadId ? prev.first : { at: Date.now(), bytes: p.receivedBytes };
    setupLive.set(key, { latest: p, first });
  });
}

/** Called by main.ts once the wizard (or its late sign-in stand-in) is decided. */
export function bindFirstRunManager(next: ManagerBinding): void { wizard = next; }

function nativeDeps(): NativeBinding {
  if (!native) throw new Error('Setup is not ready yet.');
  return native;
}
const manager = (): FirstRunManager | null => wizard?.getManager() ?? null;

export const firstRunChannels: MainChannelDef[] = [
  defineChannel({ name: IPC.FIRST_RUN_STATE, kind: 'handle', desktopOnly: true, handler: () => (wizard ? wizard.getState() : { currentStep: 'COMPLETE' }) as any }),
  defineChannel({
    name: IPC.FIRST_RUN_RETRY, kind: 'handle', desktopOnly: true,
    handler: async () => {
      try { await manager()?.retry(); }
      catch (e) { log('ERROR', 'FirstRun', 'Retry failed', { error: String(e) }); }
    },
  }),
  defineChannel({
    name: IPC.FIRST_RUN_START_AUTH, kind: 'handle', desktopOnly: true,
    handler: async ({ mode }) => {
      const m = manager();
      if (!m) return;
      try {
        if (mode === 'oauth') {
          // claude auth login opens the browser itself — don't double-open
          await m.handleOAuthLogin();
        } else if (mode === 'chatgpt' && wizard?.chatgptAuth) {
          // Opens the browser through ChatGptAuth and waits for the callback. handleChatGptLogin
          // catches signIn()'s own throws (port 1455 held, no keychain) into lastError itself — the
          // catch below is only the last resort. WHY gated on chatgptAuth (null when the kill switch
          // is on): an ungated arm would still open a browser tab and bind port 1455 with the
          // feature turned off (review T4 F3).
          await m.handleChatGptLogin(wizard.chatgptAuth);
        } else if (mode === 'openrouter') {
          // Opens the browser and waits; handleOpenRouterLogin writes its own lastError.
          await m.handleOpenRouterLogin(nativeDeps().openRouterSignIn);
        }
      } catch (e) { log('ERROR', 'FirstRun', 'Auth failed', { error: String(e) }); }
    },
  }),
  defineChannel({
    name: IPC.FIRST_RUN_SUBMIT_API_KEY, kind: 'handle', desktopOnly: true,
    handler: async ({ key, service }) => {
      const m = manager();
      if (!m) return;
      // With a service (F-2) the key runs on YouCoded's own assistant; without one it is the old
      // Claude Code key path.
      try {
        if (service) await m.handleNativeApiKey(key, service, nativeDeps().nativeDeps);
        else await m.handleApiKeySubmit(key);
      } catch (e) { log('ERROR', 'FirstRun', 'API key submit failed', { error: String(e) }); }
    },
  }),
  defineChannel({
    name: IPC.FIRST_RUN_DEV_MODE_DONE, kind: 'handle', desktopOnly: true,
    handler: async () => {
      try { await manager()?.handleDevModeDone(); }
      catch (e) { log('ERROR', 'FirstRun', 'Dev mode failed', { error: String(e) }); }
    },
  }),
  defineChannel({
    name: IPC.FIRST_RUN_SKIP, kind: 'handle', desktopOnly: true,
    handler: () => {
      // One writer for the setup-completed flag (first-run.ts): it is the only place that knows WHERE
      // the wizard's files live, so a dev instance pointed at a scratch folder cannot write the
      // installed app's config. Then move the state machine so the renderer's onStateChanged fires.
      markSetupCompleted();
      manager()?.skip();
    },
  }),
  // The wizard's suggestion for this computer's memory, from the curated list.
  defineChannel({
    name: IPC.FIRST_RUN_LOCAL_SETUP, kind: 'handle', desktopOnly: true,
    handler: async () => {
      try {
        const os: typeof import('os') = require('os');
        return { suggested: pickSuggestedModel(await nativeDeps().nativeDeps.models.curatedList(), os.totalmem()) };
      } catch (e) {
        log('ERROR', 'FirstRun', 'Local setup suggestion failed', { error: String(e) });
        return null;
      }
    },
  }),
  defineChannel({
    name: IPC.FIRST_RUN_CONNECT_LOCAL_APP, kind: 'handle', desktopOnly: true,
    handler: async ({ baseUrl, name }) => {
      const m = manager();
      if (!m) return { ok: false, message: 'Setup is not running.' };
      return m.handleConnectLocalApp(baseUrl, name, nativeDeps().nativeDeps);
    },
  }),
  // The band above the message box for the download setup finished on. Registered on EVERY launch — it
  // is read after setup — and it answers null unless that first download is still unfinished AND
  // nothing else can answer yet (round 3 review B-5/B-6). The decision is computeSetupDownloadStatus.
  // WHY no argument (2026-09-30 one-core R3-3): the preload used to send a sessionId that this never
  // read; the band describes the computer's one setup download, not a chat, so it was dropped.
  defineChannel({
    name: IPC.FIRST_RUN_LOCAL_DOWNLOAD, kind: 'handle', desktopOnly: true,
    handler: async () => {
      try {
        const { providerRegistry, claudeAccount, engineManager } = nativeDeps();
        const dir = firstRunStateDir();
        const record = readSetupDownload(dir);
        if (!record) return null;
        const [providers, claude, installed] = await Promise.all([
          providerRegistry.list().catch(() => []),
          claudeAccount.status().catch(() => ({ state: 'unknown' as const })),
          engineManager.installedModels().catch(() => []),
        ]);
        const otherUsable = providers.some((p) => p.ready && p.id !== 'local') || claude.state === 'signed-in';
        const status = computeSetupDownloadStatus({
          record, otherUsable, installed, now: Date.now(),
          live: setupLive.get(`${record.repo}::${record.quant}`) ?? null,
        });
        // Finished, or no longer the only way to answer: the band never returns for it.
        if (otherUsable || status?.state === 'done') clearSetupDownload(dir);
        return status?.state === 'done' ? null : status;
      } catch {
        return null; // a band that cannot be read is a band not shown
      }
    },
  }),
  defineChannel({
    name: IPC.FIRST_RUN_RESUME_LOCAL_DOWNLOAD, kind: 'handle', desktopOnly: true,
    handler: async () => {
      const { engineManager, modelManager } = nativeDeps();
      const record = readSetupDownload(firstRunStateDir());
      if (!record) return;
      const row = (await engineManager.installedModels())
        .find((m) => m.repo === record.repo && m.quant === record.quant && m.status === 'unfinished');
      if (row) await modelManager.resume(row.id);
    },
  }),
];
