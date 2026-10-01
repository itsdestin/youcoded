// replay.ts — transcript:replay-from-start and session:replay-live-state: a window that just acquired a session asks main to
// re-send what only main's memory holds. The computer's own windows only.
//
// WHY (2026-10-01 one-core R3-8): both were ipcMain handlers in ipc-handlers.ts. They stay computer-window plumbing by design — the
// record of a session moves into the core in R5, which replaces both — so they enter the table as `desktopOnly` entries (the
// phone door refuses them from the entry with the same "not available over remote access" answer the old default gave; a
// phone gets its snapshot through the connection's own replay). The bodies stay where they were (they lean on the native host
// and sendLiveOnlyState) and are handed over.
import { IPC } from '../../shared/backend-contract';
import { defineChannel, type MainChannelDef } from './channel-def';

type Sender = { sender: Electron.WebContents };
interface ReplayDeps {
  replayFromStart(evt: Sender, payload: { sessionId: string }): Promise<void>;
  replayLiveState(evt: Sender, payload: { sessionId: string }): void;
}
let deps: ReplayDeps | null = null;
export function bindReplay(next: ReplayDeps): void { deps = next; }
const need = (): ReplayDeps => { if (!deps) throw new Error('transcript replay is not ready'); return deps; };
const evtOf = (ctx: { sender?: unknown }): Sender => ({ sender: ctx.sender as Electron.WebContents });

export const replayChannels: MainChannelDef[] = [
  // Transcript replay: a window that just acquired a session asks for every historical event so its reducer can hydrate. Events
  // stream back on the normal TRANSCRIPT_EVENT channel (uuid dedup handles overlap with live), sent directly to the requesting
  // window — NOT via sendForSession — because ownership has already transferred to them by the time this fires.
  defineChannel({ name: IPC.TRANSCRIPT_REPLAY, kind: 'on', desktopOnly: true, handler: (p, ctx) => need().replayFromStart(evtOf(ctx), p) }),
  // Ownership-handoff counterpart. A window that inherits a session hydrates its transcript from ONE page, then asks for the part
  // that exists only in memory. `handle`, not `on`: the renderer awaits the page FIRST and then this, so the replay-complete marker
  // cannot reap tool cards before the page that creates them has been applied.
  defineChannel({ name: IPC.SESSION_REPLAY_LIVE_STATE, kind: 'handle', desktopOnly: true, handler: (p, ctx) => need().replayLiveState(evtOf(ctx), p) }),
];
