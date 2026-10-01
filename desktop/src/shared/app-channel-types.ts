// app-channel-types.ts — the request/response rows of the last channels to enter the table (one-core R3-8): the
// document comments, themes and appearance, games and the arcade, zoom, the small phone singles (platform, commands,
// ui action), the shell pieces (open, dialog, clipboard, performance, attention), and the computer-only families
// (window, detach and drag, buddy, integrations, the remote-access admin, voice, social, transcript replay).
//
// WHY a file of its own (2026-10-01 one-core R3-8): backend-contract.ts is at its line budget; like
// files-channel-types.ts, ChannelTypes extends this so a row is still found by name through ChannelTypes.
// Pushes (docComments:changed, appearance:sync, ui:action:received ...) are not rows: they have no request.
//
// Answers are derived from the function that makes them where one exists, so the type cannot drift from it.
// Functions are imported as TYPES only (shared/ never loads main/).
import type { RemoteConfig } from '../main/remote-config';
import type { listWithState, IntegrationInstaller } from '../main/integration-installer';
import type { ArcadeOps } from '../main/arcade-handlers';
import type { AttentionReport, AttentionSummary, BuddyHelperStatus, BuddyShowResult, PerformanceConfigSnapshot } from './types';
import type { CommentAuthor, CommentSelector } from './doc-comments-types';
import type { ApiResult } from './account-types';
import type { SocialUserCard, RequestsPayload, FriendRow, BlockRow } from '../renderer/state/marketplace-api-client';

type Answer<F extends (...a: any[]) => any> = Awaited<ReturnType<F>>;
/** What every document-comment channel answers: the store's own answer, or a coded refusal (unknown folder, missing field). */
type DocAnswer = { ok: boolean; error?: string; field?: string; [k: string]: unknown };
type DocTarget = { path: string; projectRoot?: string };
/** A call that answers nothing. */
type Nothing = void;

export interface AppChannelTypes {
  // ── Document comments ──
  'docComments:list': { request: DocTarget; response: DocAnswer };
  'docComments:add': { request: DocTarget & { selector: CommentSelector; text: string; author?: CommentAuthor; id?: string }; response: DocAnswer };
  'docComments:reply': { request: DocTarget & { id: string; text: string; author?: CommentAuthor }; response: DocAnswer };
  'docComments:resolve': { request: DocTarget & { id: string; by?: CommentAuthor }; response: DocAnswer };
  'docComments:reopen': { request: DocTarget & { id: string; by?: CommentAuthor }; response: DocAnswer };
  'docComments:move': { request: DocTarget & { id: string; newSelector: CommentSelector }; response: DocAnswer };
  'docComments:edit': { request: DocTarget & { id: string; text: string }; response: DocAnswer };
  'docComments:edit-reply': { request: DocTarget & { id: string; replyId: string; text: string }; response: DocAnswer };
  'docComments:delete': { request: DocTarget & { id: string }; response: DocAnswer };
  'docComments:delete-reply': { request: DocTarget & { id: string; replyId: string }; response: DocAnswer };
  'docComments:watch': { request: DocTarget; response: DocAnswer };
  'docComments:unwatch': { request: DocTarget; response: DocAnswer };

  // ── Themes and appearance ──
  'theme:list': { request: void; response: string[] };
  'theme:read-file': { request: { slug: string }; response: string };
  'theme:write-file': { request: { slug: string; content: string }; response: Nothing };
  'appearance:get': { request: void; response: Record<string, unknown> | null };
  'appearance:set': { request: Record<string, unknown>; response: boolean };
  'appearance:get-favorite-themes': { request: void; response: string[] };
  'appearance:favorite-theme': { request: { slug: string; favorited: boolean }; response: string[] };
  'appearance:broadcast': { request: Record<string, unknown>; response: Nothing };

  // ── Game favorites, presence incognito, the arcade ──
  // The computer sends the bare list / flag; a phone sends { favorites } or the bare value — the entry reads both.
  'favorites:get': { request: void; response: unknown[] };
  'favorites:set': { request: unknown[] | { favorites: unknown[] }; response: boolean };
  'game:getIncognito': { request: void; response: boolean };
  'game:setIncognito': { request: unknown; response: boolean };
  'arcade:status': { request: void; response: Answer<ArcadeOps['status']> | ArcadeUnavailable };
  'arcade:leaderboard': { request: { game: string }; response: Answer<ArcadeOps['leaderboard']> | ArcadeUnavailable };
  'arcade:submit-score': { request: { game: string; score: number }; response: Answer<ArcadeOps['submitScore']> | ArcadeUnavailable };
  'arcade:records': { request: { game?: string }; response: Answer<ArcadeOps['records']> | ArcadeUnavailable };

  // ── Zoom (the computer's window; a phone paired to it may drive it too, as before) ──
  'zoom:in': { request: void; response: number };
  'zoom:out': { request: void; response: number };
  'zoom:reset': { request: void; response: number };
  'zoom:get': { request: void; response: number };

  // ── Small singles ──
  'platform:get': { request: void; response: string };
  'commands:list': { request: void; response: unknown[] };
  /** A phone's screen action, relayed to the other phones and this computer's windows. */
  'ui:action': { request: unknown; response: Nothing };
  /** A window's screen action, relayed to every phone. */
  'ui:action:broadcast': { request: unknown; response: Nothing };
  'system:notify-stack-state': { request: void; response: Nothing };
  'terminal:get-screen-text': { request: { sessionId: string; tailRows?: number }; response: string };
  'app:restart': { request: void; response: Nothing };
  'performance:get-config': { request: void; response: PerformanceConfigSnapshot };
  'performance:set-config': { request: { preferPowerSaving: boolean }; response: { ok: true } };
  'attention:report': { request: AttentionReport; response: Nothing };
  'attention:get-summary': { request: void; response: AttentionSummary };
  'remote:attention-changed': { request: { sessionId: string; state: string }; response: Nothing };

  // ── Shell: open, dialogs, clipboard ──
  'shell:open-changelog': { request: void; response: Nothing };
  'shell:open-external': { request: { url: string }; response: Nothing };
  'shell:show-item-in-folder': { request: { filePath: string }; response: Nothing };
  'shell:open-path': { request: { filePath: string }; response: string };
  'dialog:open-file': { request: void; response: string[] };
  'dialog:open-sound': { request: void; response: string | null };
  'dialog:open-folder': { request: void; response: string | null };
  'clipboard:save-image': { request: void; response: string | null };

  // ── Windows, detach and drag (the computer's own windows) ──
  'window:minimize': { request: void; response: Nothing };
  'window:maximize': { request: void; response: Nothing };
  'window:close': { request: void; response: Nothing };
  'window:set-traffic-light-pos': { request: { pos: { x: number; y: number } | null }; response: Nothing };
  'window:set-icon': { request: { url: string | null }; response: Nothing };
  'window:get-id': { request: void; response: number };
  'window:get-directory': { request: void; response: unknown };
  'window:answer-close': { request: { requestId: string; close: boolean; reopen?: boolean }; response: Nothing };
  'window:open-detached': { request: { sessionId: string; draft?: unknown }; response: Nothing };
  'window:focus-and-switch': { request: { windowId: number; sessionId: string }; response: Nothing };
  'detach:claim-pending': { request: void; response: unknown };
  'session:detach-start': { request: { sessionId: string; screenX: number; screenY: number }; response: Nothing };
  'session:detach-live': { request: { sessionId: string; offsetX?: number; offsetY?: number }; response: { windowId: number } };
  'session:drag-window-move': { request: void; response: Nothing };
  'session:drag-dropped': { request: { sessionId: string; targetWindowId: number; insertIndex: number }; response: Nothing };
  'session:drag-adopt': { request: { sessionId: string }; response: Nothing };
  'session:drag-started': { request: void; response: Nothing };
  'session:drag-ended': { request: void; response: Nothing };
  'session:drop-resolve': { request: void; response: { targetWindowId: number | null } };

  // ── The buddy ──
  'buddy:show': { request: void; response: BuddyShowResult };
  'buddy:hide': { request: void; response: Nothing };
  'buddy:toggle-chat': { request: void; response: Nothing };
  'buddy:set-session': { request: { sessionId: string }; response: Nothing };
  'buddy:subscribe': { request: { sessionId: string }; response: Nothing };
  'buddy:unsubscribe': { request: { sessionId: string }; response: Nothing };
  'buddy:get-viewed-session': { request: void; response: string | null };
  'buddy:move-mascot': { request: { localDx: number; localDy: number }; response: Nothing };
  'buddy:drag-ended': { request: void; response: Nothing };
  'buddy:dismiss': { request: void; response: Nothing };
  'buddy:get-status': { request: void; response: { dismissed: boolean; visible: boolean } };
  'buddy:open-main': { request: { resume?: string } | undefined; response: Nothing };
  'buddy:capture-desktop': { request: void; response: string | null };
  'buddy:helper-status': { request: void; response: BuddyHelperStatus };
  'buddy:install-helper': { request: void; response: { ok: boolean; error?: string } };
  'buddy:remove-helper': { request: void; response: { ok: boolean; error?: string } };

  // ── Integrations (the computer's own installer) ──
  'integrations:list': { request: void; response: Answer<typeof listWithState> };
  'integrations:status': { request: { slug: string }; response: Answer<IntegrationInstaller['status']> };
  'integrations:install': { request: { slug: string }; response: Answer<IntegrationInstaller['install']> };
  'integrations:uninstall': { request: { slug: string }; response: Answer<IntegrationInstaller['uninstall']> };
  'integrations:configure': { request: { slug: string; settings: Record<string, unknown> }; response: Answer<IntegrationInstaller['configure']> };
  'integrations:connect': { request: { slug: string }; response: Answer<IntegrationInstaller['connect']> };

  // ── Remote-access administration ──
  'remote:get-config': { request: void; response: Record<string, unknown> };
  'remote:set-password': { request: string; response: boolean };
  'remote:set-config': { request: { enabled?: boolean; keepAwakeHours?: number }; response: Record<string, unknown> };
  'remote:detect-tailscale': { request: void; response: unknown };
  'remote:get-client-count': { request: void; response: number };
  'remote:get-client-list': { request: void; response: unknown[] };
  'remote:status': { request: void; response: unknown };
  'remote:devices:list': { request: void; response: unknown[] };
  'remote:devices:rename': { request: { deviceId: string; name: string }; response: boolean };
  'remote:devices:unpair': { request: { deviceId: string }; response: boolean };
  'remote:install-tailscale': { request: void; response: unknown };
  'remote:auth-tailscale': { request: void; response: Answer<typeof RemoteConfig.startTailscaleAuth> };

  // ── Voice (the computer's own microphone and speech engine) ──
  'voice:status': { request: void; response: unknown };
  'voice:download': { request: void; response: unknown };
  'voice:start': { request: void; response: Nothing };
  'voice:stop': { request: void; response: Nothing };
  'voice:cancel': { request: void; response: Nothing };
  'voice:mic-access': { request: void; response: 'granted' | 'denied' | 'not-determined' | 'unknown' };
  'voice:audio': { request: { chunk: ArrayBuffer; rms: number }; response: Nothing };

  // ── Social (friends and presence, over the account) ──
  'social:lookup-handle': { request: { handle: string }; response: ApiResult<SocialUserCard> };
  'social:send-request': { request: { handle: string }; response: ApiResult<{ status: 'pending' | 'friends' }> };
  'social:list-requests': { request: void; response: ApiResult<RequestsPayload> };
  'social:accept-request': { request: { id: string }; response: ApiResult<void> };
  'social:decline-request': { request: { id: string }; response: ApiResult<void> };
  'social:cancel-request': { request: { id: string }; response: ApiResult<void> };
  'social:list-friends': { request: void; response: ApiResult<FriendRow[]> };
  'social:unfriend': { request: { userId: string }; response: ApiResult<void> };
  'social:block': { request: { userId: string }; response: ApiResult<void> };
  'social:unblock': { request: { userId: string }; response: ApiResult<void> };
  'social:list-blocks': { request: void; response: ApiResult<BlockRow[]> };
  'social:presence-connect': { request: void; response: { ok: true } };
  'social:presence-disconnect': { request: void; response: { ok: true } };
  'social:presence-send': { request: { message: Record<string, unknown> }; response: { ok: true } | { ok: false; status: number; message: string } };
}

type ArcadeUnavailable = { ok: false; status: number; message: string };
