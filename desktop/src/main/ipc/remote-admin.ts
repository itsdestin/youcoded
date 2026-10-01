// remote-admin.ts — remote-access administration: remote:get-config / set-password / set-config / detect-tailscale /
// get-client-count / get-client-list / status / devices:list / devices:rename / devices:unpair / install-tailscale /
// auth-tailscale.
//
// WHY (2026-10-01 one-core R3-8): these were thirteen ipcMain handlers in ipc-handlers.ts for the Settings panel on the
// computer plus a matching set of `case`s in remote-server.ts. Both are table entries now, and the REFUSALS the phone's
// copy held are declared on the entries, byte for byte:
//   - set-password, set-config, devices:rename and devices:unpair answer a phone `{ ok:false, error: HOST_ADMIN_REFUSAL }`
//     and never reach their handler. WHY the socket refuses the whole class: behind a loopback bind every phone arrives as
//     127.0.0.1, so a source-address check would pass for all of them and any paired phone could change the host password
//     (which throws every other device off). set-config was never checked at all, so a phone could switch remote access
//     off on the computer. Renaming and unpairing decide who may reach this computer, so they stay on the computer.
//   - get-config, detect-tailscale, get-client-count, get-client-list, status and devices:list are READS the phone's Remote
//     Access screen asks for in one Promise.all; one missing answer opened the whole screen blank on a phone. They answer.
//   - install-tailscale and auth-tailscale were never bridged: `desktopOnly`, so a phone gets the old "not available over
//     remote access" answer.
//   - remote:disconnect-client has NO entry on purpose, so it still falls to the door's "unsupported" answer. It was kept as
//     an explicit `{ ok:false }` refusal once, but a shim only rejects `{ ok:false }` for channels in its own
//     REJECT_ON_NOT_OK and no released version lists this one, so that refusal resolved as success — another false
//     success. The honest "no" is the unsupported answer every shim version rejects. Pinned by remote-admin-channels.test.ts.
// Connection housekeeping — client:ready, remote:ping, remote:rehydrate, remote:request-outcome, replay buffers, pairing and
// auth — is transport, not a feature, and stays in remote-server.ts.
import { shell } from 'electron';
import { IPC } from '../../shared/backend-contract';
import { RemoteConfig, MIN_REMOTE_PASSWORD_LENGTH } from '../remote-config';
import type { RemoteServer } from '../remote-server';
import { defineChannel, type MainChannelCtx, type MainChannelDef, type RemoteHost } from './channel-def';

/** What a phone is told when it asks for host administration. Exported for the tests that pin it. */
export const HOST_ADMIN_REFUSAL = 'Change this on the computer itself.';
const hostAdminRefusal = { kind: 'reply' as const, payload: { ok: false, error: HOST_ADMIN_REFUSAL } };

/** What ipc-handlers.ts hands over: the config and server main built, and the keep-awake timer that lives beside them. */
interface RemoteAdminDeps {
  config: RemoteConfig | undefined;
  server: RemoteServer | undefined;
  applyKeepAwake(hours: number): void;
}
let deps: RemoteAdminDeps | null = null;
export function bindRemoteAdmin(next: RemoteAdminDeps): void { deps = next; }
const config = (): RemoteConfig => { if (!deps?.config) throw new Error('remote access is not set up'); return deps.config; };

/** The host a call reads: the one this phone is talking to, or, on the computer, the one main built. */
function hostOf(ctx: MainChannelCtx): RemoteHost {
  if (ctx.remote) return ctx.remote.host;
  const server = deps?.server;
  return {
    config: config(),
    getClientCount: () => server?.getClientCount() ?? 0,
    getClientList: () => server?.getClientList() ?? [],
    getStatus: () => server?.getStatus() ?? { state: 'stopped', port: 0, clientCount: 0 },
    getDeviceList: () => server?.getDeviceList() ?? [],
  };
}

export const remoteAdminChannels: MainChannelDef[] = [
  defineChannel({
    name: IPC.REMOTE_GET_CONFIG, kind: 'handle',
    handler: (_p, ctx) => { const host = hostOf(ctx); return { ...host.config.toSafeObject(), clientCount: host.getClientCount() }; },
  }),

  defineChannel({
    name: IPC.REMOTE_SET_PASSWORD, kind: 'handle', remoteAllowed: false, refusal: hostAdminRefusal,
    handler: async (password) => {
      // Backstop for the length rule the Settings UI enforces (2026-09-10 security review, #5): refuse a new password under
      // the minimum rather than silently storing a one-character one. Returns false so the UI can show its message.
      if (typeof password !== 'string' || password.length < MIN_REMOTE_PASSWORD_LENGTH) return false;
      await config().setPassword(password);
      deps?.server?.invalidateTokens();
      return true;
    },
  }),

  defineChannel({
    name: IPC.REMOTE_SET_CONFIG, kind: 'handle', remoteAllowed: false, refusal: hostAdminRefusal,
    handler: async (updates) => {
      const remoteConfig = config();
      const remoteServer = deps?.server;
      const wasEnabled = remoteConfig.enabled;
      if (typeof updates.enabled === 'boolean') remoteConfig.enabled = updates.enabled;
      if (typeof updates.keepAwakeHours === 'number') {
        remoteConfig.keepAwakeHours = updates.keepAwakeHours;
        deps?.applyKeepAwake(updates.keepAwakeHours);
      }
      remoteConfig.save();

      // Fix: flipping this toggle used to persist `enabled` and stop there. remoteServer.start() ran exactly once, at boot
      // (main.ts), when the flag was still false — so turning remote access on did nothing until the app was restarted,
      // with no indication that a restart was required. The user saw the toggle on and the browser saw ERR_CONNECTION_REFUSED.
      const toggled = typeof updates.enabled === 'boolean' && updates.enabled !== wasEnabled;
      if (toggled && remoteServer) {
        if (remoteConfig.enabled) {
          try {
            await remoteServer.start();
          } catch (err: any) {
            // Roll the flag back so the persisted state, the UI and reality all agree — otherwise the toggle reads "on"
            // against a dead server.
            remoteConfig.enabled = false;
            remoteConfig.save();
            // Surface the real OS error (EADDRINUSE etc.) rather than guessing at a cause — see docs/error-message-standards.md.
            const detail = err?.message ? String(err.message) : String(err);
            console.error('[remote] start failed:', detail);
            return {
              ...remoteConfig.toSafeObject(),
              error: `Remote access could not start on port ${remoteConfig.port}: ${detail}`,
            };
          }
        } else {
          remoteServer.stop();
        }
      }
      return remoteConfig.toSafeObject();
    },
  }),

  defineChannel({ name: IPC.REMOTE_DETECT_TAILSCALE, kind: 'handle', handler: (_p, ctx) => RemoteConfig.detectTailscale(hostOf(ctx).config.port) }),
  defineChannel({ name: IPC.REMOTE_GET_CLIENT_COUNT, kind: 'handle', handler: (_p, ctx) => hostOf(ctx).getClientCount() }),
  defineChannel({ name: IPC.REMOTE_GET_CLIENT_LIST, kind: 'handle', handler: (_p, ctx) => hostOf(ctx).getClientList() }),
  // Reading status is not administration — it is the same question the indicator already answers — so it is answered.
  defineChannel({ name: IPC.REMOTE_STATUS, kind: 'handle', handler: (_p, ctx) => hostOf(ctx).getStatus() }),
  // A window gets the bare list; a phone's page reads `{ devices }`.
  defineChannel({
    name: IPC.REMOTE_DEVICES_LIST, kind: 'handle',
    remoteReply: (list) => ({ devices: list }),
    handler: (_p, ctx) => hostOf(ctx).getDeviceList(),
  }),

  defineChannel({
    name: IPC.REMOTE_DEVICES_RENAME, kind: 'handle', remoteAllowed: false, refusal: hostAdminRefusal,
    handler: ({ deviceId, name }) => deps?.server?.renameDevice(deviceId, name) ?? false,
  }),
  defineChannel({
    name: IPC.REMOTE_DEVICES_UNPAIR, kind: 'handle', remoteAllowed: false, refusal: hostAdminRefusal,
    handler: ({ deviceId }) => deps?.server?.unpairDevice(deviceId) ?? false,
  }),

  defineChannel({ name: IPC.REMOTE_INSTALL_TAILSCALE, kind: 'handle', desktopOnly: true, handler: () => RemoteConfig.installTailscale() }),
  defineChannel({
    name: IPC.REMOTE_AUTH_TAILSCALE, kind: 'handle', desktopOnly: true,
    handler: async () => {
      const result = await RemoteConfig.startTailscaleAuth();
      if (result.url) {
        // Fire-and-forget: openExternal rejects when the OS has no handler for the scheme. The URL is returned to the renderer
        // either way, so the user can still copy it — but the rejection must not escape as an unhandled rejection.
        void shell.openExternal(result.url).catch(() => {});
      }
      return result;
    },
  }),
];
