// Per-install "Welcome back" bookkeeping — which desktop sessions are open
// THIS run (the "strip"), and which prior conversations should be offered for
// reopen the next time the app launches. Persisted at
// <userData>/welcome-back.json. Design: docs/active/specs/2026-09-24-welcome-back-design.md §1.
//
// WHY its own file, not the Conversation Store: this fact is per-INSTALL, not
// a fact any other device should ever learn. Syncing it would leave a
// `open:<installId>` key on the store forever for every device that ever ran
// this install (design §1) — this file only exists here, and is not synced.
//
// WHY injected fs: the caller (main.ts, T2) passes `fs.promises`; tests pass
// an in-memory fake, so this module's tests never touch a real disk and can
// assert on the exact write sequence (temp file, then rename).
import type { SessionProvider } from '../shared/types';

/** `shell` sessions are a terminal, not an AI conversation — they have no
 *  conversation id to remember, so they never appear in `open` or `offer`. */
export type WelcomeBackProvider = Exclude<SessionProvider, 'shell'>;

// WHY not exported: used only inside this file (knip flags an exported type
// with no outside importer as dead) — T2 wired the STORE's public API
// (WelcomeBackStore/WelcomeBackProvider) into main.ts/ipc-handlers.ts, but no
// caller needs this shape directly.
interface WelcomeBackEntry {
  conversationId: string;
  provider: WelcomeBackProvider;
}

interface WelcomeBackState {
  version: 1;
  /** This run's strip: desktopSessionId -> what it's tracking. */
  open: Record<string, WelcomeBackEntry>;
  /** What the Welcome back screen shows next launch. */
  offer: WelcomeBackEntry[];
}

function emptyState(): WelcomeBackState {
  return { version: 1, open: {}, offer: [] };
}

const VALID_PROVIDERS: readonly WelcomeBackProvider[] = ['claude', 'native'];

function asEntry(value: unknown): WelcomeBackEntry | null {
  const e = value as Partial<WelcomeBackEntry> | null;
  if (!e || typeof e !== 'object') return null;
  if (typeof e.conversationId !== 'string' || !e.conversationId) return null;
  if (!VALID_PROVIDERS.includes(e.provider as WelcomeBackProvider)) return null;
  return { conversationId: e.conversationId, provider: e.provider as WelcomeBackProvider };
}

// Corrupt or partial JSON must never throw — a bad file reads the same as a
// missing one (design §1: "a missing/corrupt file = empty (never throws)").
// Malformed individual entries are dropped rather than failing the whole
// parse, so one bad row never loses every other tracked session.
function parseState(raw: string): WelcomeBackState {
  try {
    const parsed = JSON.parse(raw) as Partial<WelcomeBackState> | null;
    if (!parsed || typeof parsed !== 'object') return emptyState();
    const open: Record<string, WelcomeBackEntry> = {};
    if (parsed.open && typeof parsed.open === 'object') {
      for (const [id, value] of Object.entries(parsed.open)) {
        const entry = asEntry(value);
        if (entry) open[id] = entry;
      }
    }
    const offer: WelcomeBackEntry[] = [];
    if (Array.isArray(parsed.offer)) {
      for (const value of parsed.offer) {
        const entry = asEntry(value);
        if (entry) offer.push(entry);
      }
    }
    return { version: 1, open, offer };
  } catch {
    return emptyState();
  }
}

// First entry per conversationId wins — `offer` is offered by conversation
// identity, not by which desktop session last tracked it.
function dedupeByConversationId(entries: WelcomeBackEntry[]): WelcomeBackEntry[] {
  const seen = new Map<string, WelcomeBackEntry>();
  for (const entry of entries) if (!seen.has(entry.conversationId)) seen.set(entry.conversationId, entry);
  return [...seen.values()];
}

// Pure mutators, shared between "apply now" (already loaded) and "replay onto
// the just-loaded file" (see the `ready` IIFE below — review 1 finding: a
// mutation made before the load finished used to be wiped out when the load
// assigned `state` wholesale). Each is idempotent-shaped (a set or a filter,
// never an increment), so replaying one that ALSO ran against the pre-load
// placeholder state is harmless — only the replayed result survives anyway.
function applyTrack(s: WelcomeBackState, desktopId: string, conversationId: string, provider: WelcomeBackProvider): void {
  s.open[desktopId] = { conversationId, provider };
}
function applyRemap(s: WelcomeBackState, desktopId: string, conversationId: string): void {
  const existing = s.open[desktopId];
  if (!existing || existing.conversationId === conversationId) return;
  s.open[desktopId] = { ...existing, conversationId };
}
function applyUntrack(s: WelcomeBackState, desktopId: string): void {
  delete s.open[desktopId];
}
function applyForget(s: WelcomeBackState, ids: string[]): void {
  if (!ids.length) return;
  const remove = new Set(ids);
  s.offer = s.offer.filter((entry) => !remove.has(entry.conversationId));
}

/** The subset of `fs.promises` this store needs. Callers pass `fs.promises`
 *  itself (structurally compatible); tests pass an in-memory fake. */
export interface WelcomeBackFs {
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
}

export interface WelcomeBackStore {
  /** Resolves once the on-disk file (or its absence) has been loaded.
   *  Every handler awaits this (design §1, review 1 D5) instead of relying on
   *  it being called after some fixed boot delay. */
  ready: Promise<void>;
  /** Run once at app.whenReady(), before createWindow(): folds this run's
   *  strip into `offer` and clears it. Union, not replace — if the app dies
   *  again before Destin answers the Welcome back screen, the still-unanswered
   *  offer survives (design §1). Resolves once that change is durable. */
  startup(): Promise<void>;
  /** A desktop session started resuming, or sent its first user message. */
  track(desktopId: string, conversationId: string, provider: WelcomeBackProvider): void;
  /** The conversation id backing an already-tracked desktop session changed
   *  (`/clear` rotation, in-session `/resume`, a SessionStart remap). A no-op
   *  if `desktopId` isn't tracked — remap fires for every mapping change,
   *  tracked or not (design §2). */
  remap(desktopId: string, conversationId: string): void;
  /** The session left `open` because IT specifically ended (explicit X,
   *  "don't resume" on window close, a holder takeover) — never because the
   *  process merely exited (design §2: that case calls nothing, on purpose). */
  untrack(desktopId: string): void;
  /** Conversation ids the Welcome back screen should offer. */
  offerIds(): string[];
  /** Removes these conversation ids from `offer` (the screen was answered or left). */
  forget(ids: string[]): void;
  /** Resolves once every write queued so far has landed on disk. */
  flush(): Promise<void>;
}

export function createWelcomeBackStore(filePath: string, fs: WelcomeBackFs): WelcomeBackStore {
  let state: WelcomeBackState = emptyState();
  // WHY per-process, not a fixed name (ast-grep atomic-tmp-name-per-process):
  // the dev instance and the built app CAN share this same userData path in
  // some setups, and even a single install's main process could in principle
  // run two writes concurrently — a fixed `.tmp` name lets the second rename
  // throw ENOENT on the first's already-consumed temp file.
  const tmpPath = `${filePath}.${process.pid}.tmp`;

  // `loaded` is false until the on-disk file has been read and parsed.
  // track/remap/untrack/forget called before that point must NOT touch
  // `state` directly — the load is about to overwrite it wholesale — so they
  // record what they meant to do here instead, and it is replayed ON TOP OF
  // the loaded state once the load lands (review 1 finding 1: a pre-ready
  // mutation used to be silently clobbered by the load). Recording the
  // ORIGINAL call (not a snapshot of `state`) is what makes "current wins"
  // work: replaying `applyForget(s, ids)` against the real loaded `offer`
  // removes a match that didn't exist yet in the empty pre-load state.
  let loaded = false;
  let pendingOps: Array<(s: WelcomeBackState) => void> = [];

  // `tail` orders writes and never rejects, so one failed write can't wedge
  // every later one and can't surface as an unhandled rejection when nobody
  // is awaiting that particular call (track/untrack/remap/forget are
  // fire-and-forget from the caller's side). `pendingWrite` is the most
  // recent attempt's own promise, which flush() returns AS-IS (it may
  // reject) so a caller that does await — shutdownApp — learns of a real
  // disk failure instead of it being silently swallowed.
  let tail: Promise<void> = Promise.resolve();
  let pendingWrite: Promise<void> = Promise.resolve();

  async function persist(): Promise<void> {
    // Read `state` here, at execution time, not at the call site: if several
    // mutations queue writes before the first one runs, every queued write
    // still persists whatever is CURRENT when its turn comes — so the file on
    // disk always converges on the latest state even though writes are not
    // coalesced (design §1: "serialized on one promise chain, latest state wins").
    const json = JSON.stringify(state);
    // Temp file + rename: a crash mid-write leaves the OLD file intact rather
    // than a half-written JSON that would read back as corrupt (i.e. empty).
    await fs.writeFile(tmpPath, json, 'utf8');
    await fs.rename(tmpPath, filePath);
  }

  function enqueueWrite(): Promise<void> {
    const attempt = tail.then(persist);
    pendingWrite = attempt;
    tail = attempt.catch(() => { /* logged nowhere on purpose — see comment above */ });
    return attempt;
  }

  const ready: Promise<void> = (async () => {
    let loadedState: WelcomeBackState;
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      loadedState = parseState(raw);
    } catch {
      // Missing file (first run) or unreadable file — both are "nothing saved".
      loadedState = emptyState();
    }
    // Replay every mutation that arrived while the read above was in flight,
    // IN CALL ORDER, on top of the file's content — never the other way
    // around, so a session tracked/untracked/forgotten before the load
    // finished is never lost or resurrected by stale on-disk content.
    state = loadedState;
    for (const apply of pendingOps) apply(state);
    const hadPendingWrite = pendingOps.length > 0;
    pendingOps = [];
    loaded = true;
    // Only the merged result may ever reach disk — never the loaded snapshot
    // on its own — so a crash right after startup can't persist a partial
    // state that forgot what happened before the read resolved.
    if (hadPendingWrite) await enqueueWrite();
  })();

  return {
    ready,

    async startup(): Promise<void> {
      await ready;
      state = {
        version: 1,
        offer: dedupeByConversationId([...state.offer, ...Object.values(state.open)]),
        open: {},
      };
      await enqueueWrite();
    },

    track(desktopId, conversationId, provider): void {
      if (!loaded) { pendingOps.push((s) => applyTrack(s, desktopId, conversationId, provider)); return; }
      applyTrack(state, desktopId, conversationId, provider);
      // Fire-and-forget: the returned promise is `tail`-chained and self-caught
      // (see enqueueWrite), so an unawaited call here can never surface as an
      // unhandled rejection — `void` only satisfies the no-floating-promises lint.
      void enqueueWrite();
    },

    remap(desktopId, conversationId): void {
      if (!loaded) { pendingOps.push((s) => applyRemap(s, desktopId, conversationId)); return; }
      const existing = state.open[desktopId];
      if (!existing) return; // not tracked — nothing to remap (design §2)
      if (existing.conversationId === conversationId) return; // no change, no write
      applyRemap(state, desktopId, conversationId);
      void enqueueWrite();
    },

    untrack(desktopId): void {
      if (!loaded) { pendingOps.push((s) => applyUntrack(s, desktopId)); return; }
      if (!(desktopId in state.open)) return;
      applyUntrack(state, desktopId);
      void enqueueWrite();
    },

    offerIds(): string[] {
      return state.offer.map((entry) => entry.conversationId);
    },

    forget(ids): void {
      if (!ids.length) return;
      if (!loaded) { pendingOps.push((s) => applyForget(s, ids)); return; }
      if (!state.offer.length) return;
      const before = state.offer.length;
      applyForget(state, ids);
      if (state.offer.length === before) return; // nothing matched — no write
      void enqueueWrite();
    },

    flush(): Promise<void> {
      return pendingWrite;
    },
  };
}
