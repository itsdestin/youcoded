// src/renderer/hooks/useTagRegistry.ts
// Live view of the tag registry. Loads via window.claude.tags.list() and
// refetches whenever a tags:changed push arrives (any window/device mutation).
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TagRecord, TagColor } from '../../shared/tags';
import { useOnRemoteReconnect } from './useOnRemoteReconnect';
import { plainMessage } from '../utils/ipc-error';

export interface TagRegistryApi {
  tags: TagRecord[];                 // non-deleted; includes archived
  byId: Map<string, TagRecord>;
  loading: boolean;
  /** Why the LAST read failed, in plain words; null once a read succeeds. `tags` keeps
   *  the last list that DID load, so a failed refresh never empties what is on screen. */
  error: string | null;
  reload: () => void;
  create: (label: string, color: TagColor) => Promise<TagRecord | null>;
  update: (id: string, patch: { label?: string; color?: TagColor; archived?: boolean }) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export function useTagRegistry(): TagRegistryApi {
  const [tags, setTags] = useState<TagRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    // Optional-chained: the .catch below already says this hook intends to
    // survive a failed registry read, and a namespace that is not there is the
    // same class of failure as a rejected promise — but it threw synchronously
    // during render instead, taking the whole component down. Surfaced when
    // SessionDrawer became the first component to call this hook.
    //
    // WHY a failed read is an ERROR, not [] (error inventory 2026-09-10, false
    // message 16): a rejection and a non-array answer both used to become an empty
    // list, so the tag manager told someone with tags "No tags yet — create one
    // above", and a failed refresh wiped tags already on screen. The hosts now answer
    // `{ ok: false, error }` when the registry cannot be read (listTagsForHost). A
    // missing namespace still resolves [] exactly as before — out of scope here.
    Promise.resolve((window as any).claude?.tags?.list?.() ?? [])
      // A failed re-read reports itself and KEEPS what is on screen — never an empty
      // registry (error inventory 2026-09-10 false message 16; 2026-09-11 phone pass).
      .then((list: unknown) => {
        if (Array.isArray(list)) {
          setTags(list as TagRecord[]);
          setError(null);
          return;
        }
        const reason = (list as { error?: unknown } | null | undefined)?.error;
        setError(typeof reason === 'string' && reason ? reason : 'the answer could not be read');
      })
      .catch((e: unknown) => setError(plainMessage(e)))
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
  return { tags, byId, loading, error, reload, create, update, remove };
}
