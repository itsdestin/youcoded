import { IPC } from '../../shared/backend-contract';
import { defineChannel, type MainChannelCtx, type MainChannelDef } from './channel-def';

const authOwners = new WeakMap<object, Map<string, number>>();
function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) throw new Error(`Invalid ${field}.`);
  return value;
}
function service(ctx: MainChannelCtx) {
  if (!ctx.runtime?.googleFiles) throw new Error('Google files are not available in this instance.');
  return ctx.runtime.googleFiles;
}
function chat(ctx: MainChannelCtx, id: unknown): string {
  const sessionId = text(id, 'conversation');
  if (!ctx.desktop?.sessionManager.getSession(sessionId)) throw new Error('This conversation is no longer open.');
  // WHY: native tools see the stored chat ID, not the desktop tab's alias.
  return ctx.runtime!.sessionState.sessionIdMap.get(sessionId) ?? sessionId;
}
function owner(ctx: MainChannelCtx): number {
  if (!ctx.sender?.id) throw new Error('Google sign-in must be started from this computer.');
  return ctx.sender.id;
}
function ownedFlow(ctx: MainChannelCtx, value: unknown): string {
  const id = text(value, 'sign-in flow');
  if (authOwners.get(service(ctx))?.get(id) !== owner(ctx)) throw new Error('This sign-in belongs to another window.');
  return id;
}

// WHY desktopOnly: a loopback callback on the computer cannot complete a phone's
// browser sign-in. Do not advertise phone support until its client flow is built.
export const googleFilesChannels: MainChannelDef[] = [
  defineChannel({ name: IPC.GOOGLE_FILES_STATUS, desktopOnly: true, kind: 'handle', handler: async (_p, ctx) => service(ctx).status() }),
  defineChannel({ name: IPC.GOOGLE_FILES_AUTH_START, desktopOnly: true, kind: 'handle', handler: async (p, ctx) => {
    const id = owner(ctx), api = service(ctx);
    const result = await api.beginAuth(p?.accountId === undefined ? undefined : text(p.accountId, 'account'));
    let owned = authOwners.get(api);
    if (!owned) { owned = new Map(); authOwners.set(api, owned); }
    owned.set(result.flowId, id);
    return result;
  } }),
  defineChannel({ name: IPC.GOOGLE_FILES_AUTH_STATE, desktopOnly: true, kind: 'handle', handler: async (p, ctx) => {
    const id = ownedFlow(ctx, p.flowId), result = await service(ctx).authState(id);
    if (result.state !== 'pending') authOwners.get(service(ctx))?.delete(id);
    return result;
  } }),
  defineChannel({ name: IPC.GOOGLE_FILES_AUTH_CANCEL, desktopOnly: true, kind: 'handle', handler: async (p, ctx) => {
    const id = ownedFlow(ctx, p.flowId);
    await service(ctx).cancelAuth(id); authOwners.get(service(ctx))?.delete(id);
  } }),
  defineChannel({ name: IPC.GOOGLE_FILES_LIST, desktopOnly: true, kind: 'handle', handler: async (p, ctx) => service(ctx).listFiles(text(p.accountId, 'account')) }),
  defineChannel({ name: IPC.GOOGLE_FILES_ATTACH, desktopOnly: true, kind: 'handle', handler: async (p, ctx) => {
    const id = chat(ctx, p.sessionId);
    if (!Array.isArray(p.fileIds) || p.fileIds.length > 100) throw new Error('Choose at most 100 files.');
    return service(ctx).attach(id, text(p.accountId, 'account'), p.fileIds.map((f) => text(f, 'file')));
  } }),
  defineChannel({ name: IPC.GOOGLE_FILES_ATTACHED, desktopOnly: true, kind: 'handle', handler: async (p, ctx) => service(ctx).attached(chat(ctx, p.sessionId)) }),
  defineChannel({ name: IPC.GOOGLE_FILES_DETACH, desktopOnly: true, kind: 'handle', handler: async (p, ctx) => service(ctx).detach(chat(ctx, p.sessionId), text(p.accountId, 'account'), text(p.fileId, 'file')) }),
  defineChannel({ name: IPC.GOOGLE_FILES_DISCONNECT, desktopOnly: true, kind: 'handle', handler: async (p, ctx) => service(ctx).disconnect(text(p.accountId, 'account')) }),
  defineChannel({ name: IPC.GOOGLE_FILES_READ, desktopOnly: true, kind: 'handle', handler: async (p, ctx) => service(ctx).read(chat(ctx, p.sessionId), text(p.accountId, 'account'), text(p.fileId, 'file')) }),
  defineChannel({ name: IPC.GOOGLE_FILES_PROPOSALS, desktopOnly: true, kind: 'handle', handler: async (p, ctx) => service(ctx).proposals(chat(ctx, p.sessionId)) }),
  // No corresponding model-tool action: only a human in the UI can approve a save.
  defineChannel({ name: IPC.GOOGLE_FILES_APPROVE, desktopOnly: true, kind: 'handle', handler: async (p, ctx) => {
    const id = chat(ctx, p.sessionId), proposal = text(p.proposalId, 'proposal');
    if (p.mode !== undefined && p.mode !== 'original' && p.mode !== 'copy') throw new Error('Invalid save destination.');
    return p.mode === undefined ? service(ctx).approve(id, proposal) : service(ctx).approve(id, proposal, p.mode);
  } }),
  defineChannel({ name: IPC.GOOGLE_FILES_REJECT, desktopOnly: true, kind: 'handle', handler: async (p, ctx) => service(ctx).reject(chat(ctx, p.sessionId), text(p.proposalId, 'proposal')) }),
];
