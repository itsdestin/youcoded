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
import { getChangelog } from '../changelog-service';
import { getUpdateService } from '../update-service';
import { defineChannel, type MainChannelDef } from './channel-def';

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
];
