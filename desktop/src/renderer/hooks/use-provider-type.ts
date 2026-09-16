// Which provider a native session's model belongs to (Sign in with ChatGPT,
// design 2026-09-04 §4.9).
//
// WHY this exists: a native session records its bound MODEL id; the provider
// behind it decides whose plan the status-bar chips and the /usage card
// report. The status bar already accepted a `modelProviderType` prop that
// nothing filled — this is what fills it.
import { useEffect, useState } from 'react';
import { REMOTE_RECONNECTED_EVENT } from '../remote-events';

interface ProviderRow { id: string; type: string; label: string; ready: boolean }
interface CatalogRow { id: string; providerId: string; label: string }

// One load per page for both lists, held until something that changes the
// answer says so. WHY not "load once and never again" (the first version):
// a session started right after signing in to ChatGPT resolved to null — no
// chips, no plan on /usage — until the whole app reloaded, because the lists
// were captured before the sign-in added the plan's rows (design review
// R3-4, 2026-09-05). The ChatGPT card, the providers screen and App's
// status feed now call invalidateProviderTypeCache() after every change they
// see, and every mounted hook re-resolves from the fresh lists.
type Lists = { providers: ProviderRow[]; catalog: CatalogRow[] };
let cache: Lists | null = null;
let inflight: Promise<Lists> | null = null;
// Counts how many times the answer has been declared obsolete. WHY: one
// sign-in fires three invalidations in about a second and `providers.catalog`
// does a real network fetch when its 24h cache has lapsed, so three reads can
// be in the air at once. Without this counter the SLOWEST reply wins — and if
// that is the one started BEFORE the sign-in, the app quietly restores the
// pre-sign-in lists and the user sees no plan chips and no plan on /usage
// until they restart the app. Each read remembers the count it started at and
// throws its own answer away if the world moved on.
let generation = 0;
// Mounted hooks, told to re-read after an invalidation.
const listeners = new Set<() => void>();
// Model ids that already earned their one miss-triggered refetch (below).
const refetchedMisses = new Set<string>();

/** Forget the cached lists and make every mounted hook re-read them. Call
 *  after anything that adds or removes a provider or its models: a ChatGPT
 *  sign-in/out, a provider upsert/remove/setKey. Cheap — two IPC reads. */
export function invalidateProviderTypeCache(): void {
  cache = null;
  inflight = null;
  generation++;
  // A fresh sign-in may have just added the rows an earlier miss was about,
  // so every id gets its one refetch back.
  refetchedMisses.clear();
  for (const fn of Array.from(listeners)) fn();
}

/** Read both lists once, and keep the answer ONLY if nothing invalidated the
 *  world while it was in the air (see `generation` above). */
function fetchLists(): Promise<Lists> {
  const startedAt = generation;
  let failed = false;
  return Promise.all([
    window.claude.providers.list().catch(() => { failed = true; return []; }),
    window.claude.providers.catalog().catch(() => { failed = true; return []; }),
  ]).then(([providers, catalog]) => {
    const next: Lists = {
      providers: Array.isArray(providers) ? providers as ProviderRow[] : [],
      catalog: Array.isArray(catalog) ? catalog as CatalogRow[] : [],
    };
    // A late reply from before the last invalidation is stale by definition —
    // return it to whoever awaited it, but never let it become the cache.
    // A FAILED read is handed back but never cached, and the next load reads again: cached, one
    // lost request meant "no providers" until something invalidated it (2026-09-11 phone pass).
    if (startedAt === generation) {
      if (failed) inflight = null;
      else cache = next;
    }
    return next;
  });
}

async function load(): Promise<Lists> {
  if (cache) return cache;
  if (!inflight) inflight = fetchLists();
  return inflight;
}

/** Re-read the lists WITHOUT throwing away the ones we already have. WHY the
 *  distinction matters: the old code blanked the cache before refetching, so
 *  for one round trip every /usage card opened in that window fell back to
 *  Claude's numbers for a ChatGPT session. The old answer is stale at worst;
 *  no answer is wrong on screen. */
function refetch(): Promise<Lists> {
  generation++;
  inflight = fetchLists();
  return inflight;
}

let reconnectHooked = false;
/** After a remote reconnect, lists that never loaded are read again and every mounted hook
 *  re-resolves; lists that did load are kept. Registered once per page, not per hook. */
function hookReconnectOnce(): void {
  if (reconnectHooked || typeof window === 'undefined') return;
  reconnectHooked = true;
  window.addEventListener(REMOTE_RECONNECTED_EVENT, () => { if (!cache) invalidateProviderTypeCache(); });
}

/** Synchronous read for callers outside React (the /usage snapshot factory).
 *  Null until the hook below has loaded the lists once.
 *
 *  `providerType` is the session's OWN provider type when main has stamped it
 *  on SessionInfo — always preferred, because it is the only answer that
 *  cannot be wrong. The catalog lookup underneath is a fallback for sessions
 *  that carry no stamp. */
export function resolveProviderType(
  modelId: string | null | undefined,
  providerType?: string | null,
): string | null {
  if (providerType) return providerType;
  if (!modelId || !cache) return null;
  const rows = cache.catalog.filter((m) => m.id === modelId);
  // WHY we refuse to pick when several providers offer the same model id:
  // models.dev's `openai` list carries the very ids the ChatGPT plan uses
  // (`gpt-5.5`, …). With BOTH an OpenAI-key provider and the plan signed in,
  // the old rule handed every such session to the plan — so a conversation
  // spending API credit showed the plan's usage chips and told the user on
  // /usage that it was "Measured across your whole ChatGPT plan". Wrong
  // numbers on screen are worse than no numbers, so an ambiguous id reads as
  // unknown (exactly like an OpenRouter session) until the session's own
  // providerType settles it.
  const types = new Set<string>();
  for (const r of rows) {
    const t = cache.providers.find((x) => x.id === r.providerId)?.type;
    if (t) types.add(t);
  }
  return types.size === 1 ? [...types][0] : null;
}

/** True when the lists are loaded and the id is genuinely not in them —
 *  the case that earns one refetch, since a session's model can arrive a
 *  beat before the catalog that names it. */
function isMiss(modelId: string | null | undefined): boolean {
  return !!modelId && !!cache && !cache.catalog.some((m) => m.id === modelId);
}

/** The provider type ('chatgpt', 'openrouter', 'local-engine', …) behind a
 *  native session's bound model id; null for Claude Code sessions, unknown or
 *  ambiguous ids, and until the lists have loaded.
 *
 *  Pass the session's own `providerType` (SessionInfo.providerType) whenever
 *  it is known — it short-circuits the whole lookup. */
export function useModelProviderType(
  modelId: string | null | undefined,
  providerType?: string | null,
): string | null {
  const [type, setType] = useState<string | null>(() => resolveProviderType(modelId, providerType));
  useEffect(() => {
    // The session told us who it belongs to: nothing to look up, and no
    // listener to register (a stamped session can never be re-answered).
    if (providerType) { setType(providerType); return; }
    hookReconnectOnce();
    let alive = true;
    const read = () => {
      void load().then(() => {
        if (!alive) return;
        // ONE refetch on a miss, then accept the answer: an id nobody lists
        // (a removed provider's model) must not re-read the lists on every
        // render. The guard is per id and resets only on an invalidation.
        if (isMiss(modelId) && !refetchedMisses.has(modelId!)) {
          refetchedMisses.add(modelId!);
          void refetch().then(() => { if (alive) setType(resolveProviderType(modelId)); });
          return;
        }
        setType(resolveProviderType(modelId));
      });
    };
    listeners.add(read);
    read();
    // Dropping the listener is load-bearing: without it every destroyed
    // session leaves a callback behind that every future invalidation still
    // calls, so a long session of opening and closing chats makes each
    // sign-in do more and more pointless work.
    return () => { alive = false; listeners.delete(read); };
  }, [modelId, providerType]);
  return providerType ?? type;
}
