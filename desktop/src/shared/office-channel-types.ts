// office-channel-types.ts — the request/response rows of the office:* channels (main/ipc/office.ts).
//
// WHY a file of its own (2026-10-04, one-core merge of master's Office): backend-contract.ts is at its line budget; like
// files-channel-types.ts, ChannelTypes extends this so a row is still found by name through ChannelTypes.
// WHY every request is ONE object (the table's rule): master's Office bridge passed positional arguments; the phone shim
// already sent objects, so the computer's preload now does too and both doors read the same shape.
// Answers come from OfficeBridge (office-types.ts), so a row cannot drift from the bridge the screens call.
// Pushes (office:changed, office:journal-request, office:unsaved-prompt, office:comments-request) are not rows.
import type { OfficeBridge, OfficeKind } from './office-types';

type Answer<K extends keyof OfficeBridge> = OfficeBridge[K] extends (...a: any[]) => infer R ? Awaited<R> : never;
type Nothing = void;

export interface OfficeChannelTypes {
  'office:status': { request: { projectRoot: string | null }; response: Answer<'status'> };
  'office:create': { request: { kind: OfficeKind; projectRoot: string | null }; response: Answer<'create'> };
  'office:pick': { request: void; response: Answer<'pick'> };
  'office:open': { request: { path: string }; response: Answer<'open'> };
  'office:invoke': { request: { token: string; cmd: string; args: unknown }; response: unknown };
  'office:close': { request: { token: string }; response: Nothing };
  'office:versions': { request: { path: string }; response: Answer<'versions'> };
  'office:restore': { request: { path: string; versionId: string }; response: Answer<'restore'> };
  'office:save-copy': { request: { token: string; mode: 'check' | 'save' | 'again' | 'release'; data?: string }; response: Answer<'saveCopy'> };
  // The window's answers to main's pushes (fire-and-forget).
  'office:journal-done': { request: { id: string }; response: Nothing };
  'office:other-unsaved': { request: { names: string[] }; response: Nothing };
  'office:proceed': { request: void; response: Nothing };
  'office:dismiss': { request: void; response: Nothing };
  'office:comments-answer': { request: { id: string; result: unknown; token: string }; response: Nothing };
  'office:comments-changed': { request: { token: string }; response: Nothing };
}
