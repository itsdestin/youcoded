// src/renderer/hooks/useTagRegistry.ts
// Live view of the tag registry. Loads via window.claude.tags.list() and
// refetches whenever a tags:changed push arrives (any window/device mutation).
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TagRecord, TagColor } from '../../shared/tags';
import { useOnRemoteReconnect } from './useOnRemoteReconnect';

export interface TagRegistryApi {
  tags: TagRecord[];                 // non-deleted; includes archived
  byId: Map<string, TagRecord>;
  loading: boolean;
  reload: () => void;
  create: (label: string, color: TagColor) => Promise<TagRecord | null>;
  update: (id: string, patch: { label?: string; color?: TagColor; archived?: boolean }) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export function useTagRegistry(): TagRegistryApi {
  const [tags, setTags] = useState<TagRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    // Optional-chained: the .catch below already says this hook intends to
    // survive a failed registry read, and a namespace that is not there is the
    // same class of failure as a rejected promise — but it threw synchronously
    // during render instead, taking the whole component down. Surfaced when
    // SessionDrawer became the first component to call this hook.
    Promise.resolve((window as any).claude?.tags?.list?.() ?? [])
      .then((list: TagRecord[]) => setTags(Array.isArray(list) ? list : []))
      // Keep what is shown: a failed re-read is not an empty registry (2026-09-11 phone pass).
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    reload();
    const off = (window as any).claude.on?.tagsChanged?.(() => reload());
    return () => { if (typeof off === 'function') off(); };
  }, [reload]);
  useOnRemoteReconnect(reload);

  const create = useCallback(async (label: string, color: TagColor) => {
    const res: any = await (window as any).claude.tags.create(label, color);
    reload();
    return res?.ok ? (res.tag as TagRecord) : null;
  }, [reload]);

  const update = useCallback(async (id: string, patch: { label?: string; color?: TagColor; archived?: boolean }) => {
    await (window as any).claude.tags.update(id, patch); reload();
  }, [reload]);

  const remove = useCallback(async (id: string) => {
    await (window as any).claude.tags.delete(id); reload();
  }, [reload]);

  const byId = useMemo(() => new Map(tags.map((t) => [t.id, t])), [tags]);
  return { tags, byId, loading, reload, create, update, remove };
}
