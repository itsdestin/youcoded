// native-channel-types.ts — the request/response rows of the native:*, permission(s):*, specialists:*,
// model:* and handoff:* channels that live in the channel table (one-core R3-5).
//
// WHY a file of its own (2026-09-30 one-core R3-5): backend-contract.ts is past its line budget; like
// session-channel-types.ts, ChannelTypes extends this so a row is still found by name through
// ChannelTypes. Push channels (native:model-state, native:shell-event, native:permission-mode,
// native:session-context, specialists:event) are not rows: they have no request.
import type {
  NativeSendResult, NativeSwitchResult, SessionContextText, SpecialistsListResult, DelegatedModelsView,
  HandoffAttemptResult, HandoffCreateParams,
} from './types';
import type { NativePermissionMode, PermissionRule, StoredProject } from './permission-types';
import type { ContextPreferences } from './context-preferences';
import type { NativeSessionHost } from '../main/harness/native-session-host';

/** A model a native session is bound to: which provider row, which model on it. */
type ModelBinding = { providerId: string; modelId: string };
/** What compact / clear / invoke-skill answer: done, or a coded reason the screen can explain. */
type NativeActionResult = { ok: true } | { ok: false; reason: string; detail?: string };
type SpecialistsWriteResult = { ok: true } | { ok: false; error: string };

export interface NativeChannelTypes {
  // Native runtime: sending, queueing, stopping.
  'native:send': { request: { sessionId: string; text: string; attachments?: string[]; /** the phone's id for this send (R5-4b) */ sendId?: string }; response: NativeSendResult };
  'native:queue-remove': { request: { sessionId: string; queueId: string }; response: boolean };
  'native:queue-send-now': { request: { sessionId: string; queueId: string }; response: boolean };
  'native:interrupt': { request: { sessionId: string }; response: void };
  'native:retry': { request: { sessionId: string }; response: void };
  'native:compact': { request: { sessionId: string; focus?: string }; response: NativeActionResult };
  'native:clear': { request: { sessionId: string }; response: NativeActionResult };
  'native:invoke-skill': { request: { sessionId: string; skill: string; args?: string }; response: NativeActionResult };
  // Models and modes.
  'native:set-binding': { request: { sessionId: string; binding: ModelBinding }; response: boolean };
  'native:switch-model': { request: { sessionId: string; binding: ModelBinding; summarize?: boolean }; response: NativeSwitchResult };
  'native:set-permission-mode': { request: { sessionId: string; mode: NativePermissionMode }; response: NativePermissionMode };
  'native:get-permission-mode': { request: { sessionId: string }; response: NativePermissionMode };
  'native:get-context-preferences': { request: void; response: ContextPreferences };
  'native:set-context-preferences': { request: { patch: Partial<ContextPreferences> }; response: ContextPreferences };
  'native:get-step-guard': { request: void; response: number | null };
  'native:set-step-guard': { request: { value: number | null }; response: number | null };
  // Reading what is there.
  'native:sessions-list': { request: void; response: Awaited<ReturnType<NativeSessionHost['listAsync']>> };
  'native:kill-shell': { request: { sessionId: string; shellId: string }; response: { ok: true } | { ok: false; reason: string } };
  'native:submit-admin-password': { request: { requestId: string; password: string }; response: boolean };
  'native:session-context-text': { request: { sessionId: string; kind: 'project' | 'user' | 'skill'; id?: string }; response: SessionContextText | { error: string } };
  // Permissions: answering a prompt, and the remembered "Always allow" rules.
  'permission:respond': { request: { requestId: string; decision: object }; response: boolean };
  'permissions:list': { request: void; response: StoredProject[] };
  'permissions:remove': { request: { slug: string; rule: PermissionRule }; response: boolean };
  'permissions:remove-project': { request: { slug: string }; response: boolean };
  // Specialists: the roster, the two model tiers, and the card's Steer / Stop.
  'specialists:list': { request: { cwd?: string; ensurePersonalFolder?: boolean } | undefined; response: SpecialistsListResult };
  'specialists:delegated-get': { request: void; response: DelegatedModelsView };
  'specialists:delegated-set': { request: { tier: 'budget' | 'frontier'; binding: ModelBinding | null }; response: SpecialistsWriteResult };
  'specialists:steer': { request: { sessionId: string; childId: string; text: string }; response: SpecialistsWriteResult };
  'specialists:interrupt': { request: { sessionId: string; childId: string }; response: SpecialistsWriteResult };
  // The last-used model choice for new Claude Code sessions, and the model a transcript last ran on.
  'model:get-preference': { request: void; response: string };
  'model:set-preference': { request: { model: string }; response: boolean };
  'model:read-last': { request: { transcriptPath: string }; response: string | null };
  // Handoff: moving a conversation to this computer, one attempt at a time.
  'handoff:begin': { request: { conversationId: string; provider: 'claude' | 'native'; create?: HandoffCreateParams }; response: HandoffAttemptResult };
  'handoff:status': { request: { id: string }; response: HandoffAttemptResult };
  'handoff:wait': { request: { id: string }; response: HandoffAttemptResult };
  'handoff:retry': { request: { id: string }; response: HandoffAttemptResult };
  'handoff:saved-copy': { request: { id: string; consent: boolean }; response: HandoffAttemptResult };
  'handoff:force': { request: { id: string; consent: boolean; expectedHolderId: string }; response: HandoffAttemptResult };
  'handoff:cancel': { request: { id: string }; response: HandoffAttemptResult };
  'handoff:create-params': { request: { id: string; create: HandoffCreateParams }; response: HandoffAttemptResult };
}
