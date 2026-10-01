// session-channel-types.ts — the request/response rows of the session:*, session-naming:* and
// transcript:* channels that live in the channel table (one-core R3-4).
//
// WHY a file of its own (2026-09-30 one-core R3-4): backend-contract.ts is past its line budget;
// like marketplace-channel-types.ts and sync-channel-types.ts, ChannelTypes extends this so a
// row is still found by name through ChannelTypes.
import type {
  SessionInfo, SessionCreateResult, SessionMetaResult, HistoryMessage, PastSession,
  TranscriptPageRequest, TranscriptPageResult,
} from './types';
import type { CreateSessionOpts } from '../main/session-manager';
import type { OpenRequest, OpenReply } from './session-open-types';
import type { PromptReport } from './session-live-types';

/** What a session-meta write answers: `ok:false` carries the reason a screen can show. */
type SessionWriteResult = { ok: true } | { ok: false; error: string };

/** The naming preference as the Assistant settings screen reads it. */
interface SessionNamingPreference {
  mode: unknown;
  model: { runtime: 'native'; providerId: string; modelId: string } | null;
}

export interface SessionChannelTypes {
  // Lifecycle. A phone may create (except a plain terminal), destroy and list — as before.
  'session:create': { request: CreateSessionOpts; response: SessionCreateResult };
  'session:destroy': { request: { sessionId: string }; response: boolean };
  'session:list': { request: void; response: SessionInfo[] };
  'session:selected': { request: { sessionId: string | null }; response: void };
  'session:switch': { request: { sessionId: string }; response: { ok: true } };
  // Terminal traffic: fire-and-forget on every door.
  'session:input': { request: { sessionId: string; text: string; /** a typed chat command, so the host can draw its divider (R5-4a) */ notice?: 'model-switch' }; response: void };
  'session:resize': { request: { sessionId: string; cols: number; rows: number }; response: void };
  'session:terminal-ready': { request: { sessionId: string }; response: void };
  'session:menu-lock': { request: { sessionId: string; holder: string; action: 'acquire' | 'release' }; response: boolean };
  // Browsing and history.
  'session:browse': { request: void; response: PastSession[] };
  'session:history': { request: { sessionId: string; projectSlug: string; count?: number; all?: boolean }; response: HistoryMessage[] };
  'transcript:read-meta': { request: { path: string } | string; response: { model: string; contextPercent: number | null } | null };
  'transcript:page': { request: TranscriptPageRequest; response: TranscriptPageResult };
  // The one way a screen is filled (one-core R5-2): see main/session-open.ts for the ask and the answer.
  'session:open': { request: OpenRequest; response: OpenReply };
  // End a phone's watch of one session (one-core R5-3). `session:open` is what starts a watch; there is no separate "watch" call, because a
  // watch without a fill would deliver events onto a conversation the phone has no history for.
  'session:unwatch': { request: { sessionId: string }; response: { ok: true } };
  // A computer window reports a card it read off its terminal (one-core R5-4a); the host numbers it and shows it on every screen.
  'session:prompt-report': { request: PromptReport; response: { ok: boolean } };
  // Tags, notes, flags and names.
  'session:set-flag': { request: { sessionId: string; flag: string; value: boolean }; response: SessionWriteResult };
  'session:set-tag': { request: { sessionId: string; tagId: string; value: boolean }; response: SessionWriteResult };
  'session:set-note': { request: { sessionId: string; note: string }; response: SessionWriteResult };
  'session:get-meta': { request: { sessionId: string }; response: SessionMetaResult };
  'session-naming:get': { request: void; response: SessionNamingPreference };
  'session-naming:set': { request: { value: unknown }; response: SessionWriteResult };
  'session-naming:title': { request: { sessionId: string; fallback: string }; response: { title: string; manual: boolean } };
  'session-naming:rename': { request: { sessionId: string; title: string }; response: { ok: true; name: string } | { ok: false; error: string } };
  // Welcome back: the conversations open at the last shutdown (the computer's own screen).
  'session:reopen-list': { request: void; response: string[] };
  'session:forget-reopen': { request: { ids: string[] }; response: { ok: boolean } };
}
