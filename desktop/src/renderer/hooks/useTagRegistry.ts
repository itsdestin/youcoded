// src/renderer/hooks/useTagRegistry.ts
// Live view of the tag registry. Loads via window.claude.tags.list() and
// refetches whenever a tags:changed push arrives (any window/device mutation).
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
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
// WHY a generation counter: reads can overlap (a push arrives while a surface's
// refresh is in flight) and IPC answers need not come back in order. Only the
// answer to the NEWEST read may publish, so a slow older answer can never put a
// stale list back on screen — and a reset (tests) bumps it too, so an answer that
// lands after the reset is dropped instead of leaking into the next test.
let gen = 0;
// Generation of a read still waiting for its answer, or 0. Lets a surface's
// refresh reuse a read that is already on its way instead of stacking a second.
let inFlight = 0;

function sameTags(a: TagRecord[], b: TagRecord[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  // Records are small plain JSON from the host, so comparing their text is exact
  // and cheap next to the IPC round trip that produced them.
  for (let i = 0; i < a.length; i++) if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return false;
  return true;
}

function publish(next: Partial<Snap>) {
  // WHY compare by content (not just "an answer arrived"): surfaces now re-read on
  // open, so most reads return exactly what is held. A fresh snapshot for an equal
  // list would change identity and redraw every consumer — every chip, every
  // card — for nothing. Equal list + nothing else changed = no publish at all.
  const patch: Partial<Snap> = { ...next };
  if (patch.tags && sameTags(patch.tags, snap.tags)) delete patch.tags;
  const changed = (Object.keys(patch) as (keyof Snap)[]).some((k) => patch[k] !== snap[k]);
  if (!changed) return;
  const tags = patch.tags ?? snap.tags;
  snap = { ...snap, ...patch, byId: patch.tags ? new Map(tags.map((t) => [t.id, t])) : snap.byId };
  for (const s of subs) s();
}

function load() {
  const mine = ++gen;
  inFlight = mine;
  const settle = (next: Partial<Snap>) => {
    if (mine !== gen) return; // a newer read (or a reset) superseded this one
    inFlight = 0;
    publish(next);
  };
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
      if (Array.isArray(list)) { settle({ tags: list as TagRecord[], error: null, loading: false }); return; }
      const reason = (list as { error?: unknown } | null | undefined)?.error;
      settle({ error: typeof reason === 'string' && reason ? reason : 'the answer could not be read', loading: false });
    })
    .catch((e: unknown) => settle({ error: plainMessage(e), loading: false }));
}

/**
 * Re-read the registry in the background, keeping what is on screen meanwhile.
 *
 * WHY surfaces call this on open (render-cost consolidation, final review F1):
 * the shared store reads once, on its first subscriber — and SessionStrip
 * subscribes at app start and never unmounts, so without this nothing would
 * re-read until a `tags:changed` push. A sync pull that brings in a tag made or
 * renamed on another device sends no push, so chips stayed missing/stale until
 * restart. Before the shared store every Resume-browser open and Conversations-tab
 * mount re-read; this restores exactly those moments (plus the tag manager).
 * Chosen over "re-read when a new subscriber arrives and the snapshot is old":
 * subscribers come and go constantly (chips in revealed rows, pickers), so an
 * age rule would re-read on scrolling, and its timing would make tests depend on
 * the clock. An explicit call at the list surfaces is deterministic and cheap —
 * and an equal answer publishes nothing, so the first draw uses the cached list
 * and nothing redraws unless a tag really changed.
 */
export function refreshTagRegistry() {
  if (!started) return; // the first subscriber's read is about to happen anyway
  if (inFlight) return;  // a read already on its way is as fresh as a new one
  load();
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
  } else if (snap.error && !inFlight) {
    // WHY: the first read can land before main has started the tag registry
    // (startTagRegistry runs after the window is created), leaving an error that
    // nothing would otherwise clear short of Retry. A new consumer arriving while
    // the store holds an error re-reads in the background; the error stays shown
    // until that read succeeds.
    load();
  }
  return () => { subs.delete(cb); };
}

/** Test-only: forget the loaded registry so each test starts cold. */
export function __resetTagRegistryForTests() {
  offPush?.(); offPush = null; started = false; subs.clear();
  gen++; inFlight = 0; // any answer still in flight now belongs to a dead store
  snap = { tags: [], byId: new Map(), loading: true, error: null };
}

export function useTagRegistry(opts?: { refreshOnMount?: boolean }): TagRegistryApi {
  const s = useSyncExternalStore(subscribe, () => snap);
  const refreshOnMount = !!opts?.refreshOnMount;
  // A list surface passes refreshOnMount so opening it re-reads (see
  // refreshTagRegistry). It draws the cached list first; the re-read redraws
  // only if a tag actually changed.
  useEffect(() => { if (refreshOnMount) refreshTagRegistry(); }, [refreshOnMount]);
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
