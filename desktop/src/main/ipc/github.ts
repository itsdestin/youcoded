// github.ts — the Connect-GitHub modal's request/response channels, one body for both doors.
//
// WHY (2026-09-30 one-core R3-4): written twice. A phone could already drive every one of these;
// that stays. The device-flow orchestrator is the process-wide singleton (github-connect.ts), so a
// phone and the computer drive the SAME flow; its `github:connect-done` push is still fanned out
// where the orchestrator is built (registerIpcHandlers), and the access token never enters any
// payload (sync-spaces.md).
import { IPC } from '../../shared/backend-contract';
import { installGh } from '../github-auth';
import { combinedGithubStatus } from '../github-client';
import { getGithubConnect, disconnectGithub } from '../github-connect';
import { defineChannel, type MainChannelDef } from './channel-def';

export const githubChannels: MainChannelDef[] = [
  // Combined status (Phase 2): authed = stored app token OR gh login — a stock machine that connected
  // in-app reads as authed with no gh at all. Legacy {installed, authed, login} shape, additive fields.
  defineChannel({ name: IPC.GITHUB_STATUS, kind: 'handle', handler: () => combinedGithubStatus() }),
  // Completion arrives as the github:connect-done push, fanned out to every client.
  defineChannel({ name: IPC.GITHUB_CONNECT_START, kind: 'handle', handler: async () => { const gc = getGithubConnect(); return gc ? await gc.start() : { error: 'unavailable' as const }; } }),
  defineChannel({ name: IPC.GITHUB_CONNECT_CANCEL, kind: 'handle', handler: () => { getGithubConnect()?.cancel(); return { ok: true as const }; } }),
  defineChannel({ name: IPC.GITHUB_INSTALL_GH, kind: 'handle', handler: () => installGh() }),
  defineChannel({ name: IPC.GITHUB_DISCONNECT, kind: 'handle', handler: () => disconnectGithub() }),
];
