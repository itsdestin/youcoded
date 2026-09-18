// src/renderer/hooks/useTagRegistry.ts
// Live view of the tag registry. Loads via window.claude.tags.list() and
// refetches whenever a tags:changed push arrives (any window/device mutation).
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { TagRecord, TagColor } from '../../shared/tags';
import { REMOTE_RECONNECTED_EVENT } from '../remote-events';
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

// WHY one module-level store (render-cost consolidation 2026-09-18): every
// consumer used to run its own tags.list() on mount and add its own tagsChanged
// listener. A list that mounted one (ConversationsTab) drew all its rows, then
// drew them ALL again when the late answer arrived — and tags visibly popped in.
// Now the first subscriber loads, later ones render the loaded tags on their
// first render, and one push means one re-read.
interface Snap { tags: TagRecord[]; byId: Map<string, TagRecord>; loading: boolean; error: string | null }
let snap: Snap = { tags: [], byId: new Map(), loading: true, error: null };
const subs = new Set<() => void>();
let started = false;
let offPush: (() => void) | null = null;

function publish(next: Partial<Snap>) {
  const tags = next.tags ?? snap.tags;
  snap = { ...snap, ...next, byId: next.tags ? new Map(tags.map((t) => [t.id, t])) : snap.byId };
  for (const s of subs) s();
}

function load() {
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
      if (Array.isArray(list)) { publish({ tags: list as TagRecord[], error: null, loading: false }); return; }
      const reason = (list as { error?: unknown } | null | undefined)?.error;
      publish({ error: typeof reason === 'string' && reason ? reason : 'the answer could not be read', loading: false });
    })
    .catch((e: unknown) => publish({ error: plainMessage(e), loading: false }));
}

function subscribe(cb: () => void) {
  subs.add(cb);
  if (!started) {
    started = true;
    load();
    const off = (window as any).claude?.on?.tagsChanged?.(() => load());
    // One reconnect listener for the store, not one per consumer (was
    // useOnRemoteReconnect in each hook instance — same WHY as that hook). These
    // listeners are intentionally never removed while the app runs: the store
    // lives as long as the renderer does, so there is no teardown moment for
    // them short of the page unloading.
    window.addEventListener(REMOTE_RECONNECTED_EVENT, load);
    offPush = () => {
      if (typeof off === 'function') off();
      window.removeEventListener(REMOTE_RECONNECTED_EVENT, load);
    };
  }
  return () => { subs.delete(cb); };
}

/** Test-only: forget the loaded registry so each test starts cold. */
export function __resetTagRegistryForTests() {
  offPush?.(); offPush = null; started = false; subs.clear();
  snap = { tags: [], byId: new Map(), loading: true, error: null };
}

export function useTagRegistry(): TagRegistryApi {
  const s = useSyncExternalStore(subscribe, () => snap);
  const create = useCallback(async (label: string, color: TagColor) => {
    const res: any = await (window as any).claude.tags.create(label, color);
    load();
    return res?.ok ? (res.tag as TagRecord) : null;
  }, []);
  const update = useCallback(async (id: string, patch: { label?: string; color?: TagColor; archived?: boolean }) => {
    await (window as any).claude.tags.update(id, patch); load();
  }, []);
  const remove = useCallback(async (id: string) => {
    await (window as any).claude.tags.delete(id); load();
  }, []);
  return useMemo(() => ({ ...s, reload: load, create, update, remove }), [s, create, update, remove]);
}
