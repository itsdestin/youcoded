// update.ts — the app's own update channels, one body for both doors.
//
// WHY (2026-09-30 one-core R3-2): update:* had hand-written handlers in ipc-handlers.ts plus two
// phone `case`s (the beta channel) in remote-server.ts. Before/after for a phone:
//   - get/set beta channel: allowed on both before; still allowed. The desktop body ALSO
//     re-checks the release right after the switch (so "you're up to date" does not linger up to
//     30 minutes); the phone's copy skipped that. One body now, so the phone gets the re-check.
//   - changelog, download, cancel, launch, get-cached-download: a phone was refused ("not available
//     over remote access") because they open/install/relaunch THIS computer. Kept exactly: they are
//     `desktopOnly` (download/cancel/launch/cached) or `remoteAllowed:false` (changelog).
// A failed beta-channel save keeps the phone's old soft answer `{ok:false,error}` (remoteOnError).
import { IPC } from '../../shared/backend-contract';
import type { UpdateRestartResult } from '../../shared/update-install-types';
import { getChangelog } from '../changelog-service';
import { getUpdateService } from '../update-service';
import { defineChannel, type MainChannelDef } from './channel-def';

// Restart to update needs main.ts's windows and close-request queue, so main hands the function over at
// startup (the same pattern as window.ts's bindWindow).
let restartToUpdate: (() => Promise<UpdateRestartResult>) | null = null;
export function bindUpdateRestart(fn: () => Promise<UpdateRestartResult>): void { restartToUpdate = fn; }

export const updateChannels: MainChannelDef[] = [
  defineChannel({
    name: IPC.UPDATE_CHANGELOG, kind: 'handle', remoteAllowed: false,
    handler: (payload) => getChangelog({ forceRefresh: !!payload?.forceRefresh }),
  }),
  defineChannel({ name: IPC.UPDATE_DOWNLOAD, kind: 'handle', desktopOnly: true, handler: () => getUpdateService().download() }),
  defineChannel({ name: IPC.UPDATE_CANCEL, kind: 'handle', desktopOnly: true, handler: (payload) => getUpdateService().cancel(payload.jobId) }),
  // Installs and relaunches this computer: never from a phone.
  defineChannel({ name: IPC.UPDATE_LAUNCH, kind: 'handle', desktopOnly: true, handler: (payload) => getUpdateService().launch(payload) }),
  defineChannel({ name: IPC.UPDATE_GET_CACHED_DOWNLOAD, kind: 'handle', desktopOnly: true, handler: (payload) => getUpdateService().getCachedDownload(payload.version) }),
  defineChannel({ name: IPC.UPDATE_GET_BETA_CHANNEL, kind: 'handle', handler: () => getUpdateService().betaChannelState() }),
  defineChannel({
    name: IPC.UPDATE_SET_BETA_CHANNEL, kind: 'handle',
    handler: (payload) => getUpdateService().setBetaChannel(payload?.enabled),
    // The phone always got `{ok:false,error}` here when the save failed.
    remoteOnError: (error) => ({ ok: false, error: String((error as Error)?.message ?? error) }),
  }),
  // Restart to update (#183 T3): installs and reopens THIS computer, so never from a phone.
  defineChannel({ name: IPC.UPDATE_RESTART_TO_UPDATE, kind: 'handle', desktopOnly: true, handler: () => (restartToUpdate ? restartToUpdate() : Promise.resolve({ restarting: false })) }),
  // "Install updates automatically" (#183): allowed from a paired phone like the beta channel
  // (one setting kept in sync everywhere). {supported:false} where there is no in-app updater.
  defineChannel({ name: IPC.UPDATE_GET_AUTO_INSTALL, kind: 'handle', handler: () => getUpdateService().getAutoInstall() }),
  defineChannel({
    name: IPC.UPDATE_SET_AUTO_INSTALL, kind: 'handle',
    handler: (payload) => getUpdateService().setAutoInstall(payload?.enabled),
    // WHY no remoteOnError (review of T1): the beta channel's soft {ok:false,error} answer is an old
    // shape its own caller understands. This switch's caller treats any reply without `supported`
    // as a failure to revert from, so a failed save must reach the phone as a rejection (the table's
    // thrown-handler flag does that), never as a quiet answer.
  }),
];
