// tags.ts — the tag registry channels (tags:list / create / update / delete), one body for both doors.
//
// WHY (2026-09-30 one-core R3-1): these were written twice, in ipc-handlers.ts and as `case`s in
// remote-server.ts, and the phone's copy had drifted (see the R3-1 report's phone list): it
// passed a phone's raw label/patch to the registry, told only OTHER PHONES that the registry
// changed (the computer's own windows stayed stale), and never refreshed the search index's
// copy of tag labels after a rename or delete. The desktop body is the one kept.
import { IPC } from '../../shared/backend-contract';
import { isTagColor, type TagColor } from '../../shared/tags';
import { getTagRegistry, listTagsForHost } from '../conversations/tag-registry-service';
import { emitConversationMetaChanged } from '../conversations/service';
import { defineChannel, type MainChannelDef } from './channel-def';

const registryUnavailable = { ok: false as const, error: 'tag registry unavailable' };
const failure = (e: unknown) => ({ ok: false as const, error: (e as Error)?.message || String(e) });

export const tagsChannels: MainChannelDef[] = [
  // A failed read answers { ok: false, error }, never [] — see listTagsForHost for why
  // (ast-grep rule tags-list-no-empty-fallback pins this entry).
  defineChannel({ name: IPC.TAGS_LIST, kind: 'handle', handler: () => listTagsForHost() }),

  defineChannel({
    name: IPC.TAGS_CREATE, kind: 'handle',
    handler: async (payload, ctx) => {
      const reg = getTagRegistry();
      if (!reg) return registryUnavailable;
      const color: TagColor = isTagColor(payload?.color) ? payload.color : 'tag-gray';
      try {
        const tag = await reg.create(String(payload?.label ?? ''), color);
        // Every screen: this computer's windows (buddy + main share the registry) and every phone.
        ctx.broadcast(IPC.TAGS_CHANGED, {});
        return { ok: true as const, tag };
      } catch (e) { return failure(e); }
    },
  }),

  defineChannel({
    name: IPC.TAGS_UPDATE, kind: 'handle',
    handler: async (payload, ctx) => {
      const reg = getTagRegistry();
      if (!reg) return registryUnavailable;
      const patch = payload?.patch;
      const clean: { label?: string; color?: TagColor; archived?: boolean } = {};
      if (patch?.label !== undefined) clean.label = String(patch.label);
      if (patch?.color !== undefined) clean.color = isTagColor(patch.color) ? patch.color : 'tag-gray';
      if (patch?.archived !== undefined) clean.archived = !!patch.archived;
      try {
        const tag = await reg.update(String(payload?.id), clean);
        ctx.broadcast(IPC.TAGS_CHANGED, {});
        // The chatsearch metadata snapshot denormalizes tag LABELS at build time (meta-builder.ts),
        // so a rename must also refresh the index, or it keeps serving the OLD label.
        emitConversationMetaChanged();
        return { ok: true as const, tag };
      } catch (e) { return failure(e); }
    },
  }),

  defineChannel({
    name: IPC.TAGS_DELETE, kind: 'handle',
    handler: async (payload, ctx) => {
      const reg = getTagRegistry();
      if (!reg) return registryUnavailable;
      try {
        await reg.delete(String(payload?.id));
        ctx.broadcast(IPC.TAGS_CHANGED, {});
        // Same gap as TAGS_UPDATE: a deleted tag's label must drop out of the index too.
        emitConversationMetaChanged();
        return { ok: true as const };
      } catch (e) { return failure(e); }
    },
  }),
];
