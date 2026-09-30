// session.ts — the conversation channels (session:*, session-naming:*, transcript:page and
// transcript:read-meta), one table entry each, served to the computer's windows and to a phone.
//
// WHY (2026-09-30 one-core R3-4): these were written twice, in ipc-handlers.ts and as `case`s in
// remote-server.ts, and the two drifted. The bodies that need things only registerIpcHandlers
// builds (creating and destroying a session, the window-ownership bookkeeping) stay there as named
// closures and arrive through bindSessionOps; everything else lives here.
//
// WHAT A PHONE SEES, before -> now (the R3-4 report has the full list):
//   - session:list: the phone now gets each native session stamped with the provider it is bound to
//     (the computer always did), so the phone can show the right plan's usage.
//   - session:destroy: the phone used to run a shorter teardown; it now runs the computer's, which
//     also releases the conversation's hold and forgets it for Welcome back. It hears the session
//     end once (from the session exit), not twice.
//   - session:browse: the Resume list leaves out sessions already open on the computer through the
//     ONE id map (the audit's B1 fix by construction; the phone-only lookup is gone).
//   - session:set-tag / set-note: same writes, the computer's wording for the two refusal messages.
//   - session:get-meta: the phone now also gets the reserved flags (Priority etc.) the computer got.
//   - session:history: the computer now also finds a transcript whose project folder changed (the
//     phone always did).
//   - session:create: a plain terminal is still refused for a phone, now declared as table policy.
//   - session:set-flag stays refused for a phone; session:selected / terminal-ready stay computer-only.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { IPC } from '../../shared/backend-contract';
import { tagFlagKey } from '../../shared/tags';
import { SESSION_FLAG_NAMES, type SessionFlagName, type SessionInfo, type SessionProvider, type TranscriptPageResult } from '../../shared/types';
import { listPastSessions, loadHistory, SAFE_ID_RE } from '../session-browser';
import { readTranscriptMeta } from '../transcript-utils';
import { readTranscriptPage } from '../transcript-page';
import { menuAnswerLock } from '../menu-answer-lock';
import { shareInFlight } from '../share-in-flight';
import { perfMark } from '../perf-marks';
import { getConversationStore, noteFlagChanged, noteSessionNote, emitConversationMetaChanged } from '../conversations/service';
import type { SessionManager } from '../session-manager';
import type { NativeSessionHost } from '../harness/native-session-host';
import type { WindowRegistry } from '../window-registry';
import type { WelcomeBackStore } from '../welcome-back-store';
import { defineChannel, type MainChannelDef } from './channel-def';

/** What registerIpcHandlers hands over: the shared maps and objects, and the few bodies that lean on
 *  its private state. A phone and the computer's windows reach the same ones. */
export interface SessionOps {
  sessionManager: Pick<SessionManager, 'listSessions' | 'sendInput' | 'resizeSession' | 'getSession'>;
  /** desktop session id -> conversation id (session-state.ts): the ONE copy. */
  sessionIdMap: Map<string, string>;
  nativeHost: NativeSessionHost;
  stampProviderTypes(rows: SessionInfo[]): Promise<SessionInfo[]>;
  windowRegistry?: WindowRegistry;
  welcomeBackStore?: WelcomeBackStore;
  /** `sender` is the calling window (computer) or null (phone). Called synchronously: ownership must be
   *  claimed before its first await (tests/ipc-handlers-create-ownership.test.ts). */
  createSession(sender: { id: number; isDestroyed?: () => boolean } | null, opts: any): Promise<any>;
  destroySession(sessionId: string): Promise<boolean>;
  signalTerminalReady(sessionId: string): void;
  /** The computer's paged history for one window (window ownership, resume boundaries, watchers). */
  desktopTranscriptPage(req: any, windowId: number | undefined): Promise<TranscriptPageResult>;
  /** The phantom-record gate: may a write reach the conversation store for this id? */
  canWriteStoreRecord(sessionId: string): boolean;
  sendForSession(sessionId: string, channel: string, ...args: unknown[]): void;
  /** Tell every paired phone (not the computer's windows). */
  remoteBroadcast(message: { type: string; payload: unknown }): void;
  naming: {
    get(): Promise<unknown>;
    set(value: unknown): Promise<unknown>;
    title(sessionId: string, fallback: string): Promise<unknown>;
    rename(sessionId: string, title: string): Promise<unknown>;
  };
}

let boundOps: SessionOps | null = null;
/** Called once by registerIpcHandlers (null unbinds, for tests). */
export function bindSessionOps(next: SessionOps | null): void { boundOps = next; }
function ops(): SessionOps {
  if (!boundOps) throw new Error('Sessions are not ready yet. Try again.');
  return boundOps;
}

// One scan answers every browse made while it runs with the same live sessions excluded
// (share-in-flight.ts has the why: two full scans per first open).
const browseOnce = shareInFlight<Awaited<ReturnType<typeof listPastSessions>>>();

/** Provider bucket to READ a resolved session's meta from. 'native' when the host recognizes the id
 *  (live now, or a persisted ~/.youcoded/sessions file); otherwise probe the store's native bucket — a
 *  store-only native browse row (record synced, transcript not local yet) is still native. A null store
 *  (boot window) falls back to 'claude'. WRITES do NOT use this: they pass isNativeSessionId straight to
 *  noteFlagChanged / noteSessionNote, which defer the probe to flush time. */
export async function sessionProviderFor(resolved: string): Promise<SessionProvider> {
  if (ops().nativeHost.isNativeSessionId(resolved)) return 'native';
  const store = getConversationStore();
  if (!store) return 'claude';
  try { return (await store.get('native', resolved)) ? 'native' : 'claude'; }
  catch { return 'claude'; }
}

const SAVE_REFUSED = 'Could not save — conversation storage is not available on this device.';

/** After a meta write: tell the owning window and every phone, and refresh the search index. */
function announceMeta(resolved: string, change: Record<string, unknown>): void {
  ops().sendForSession(resolved, IPC.SESSION_META_CHANGED, resolved, change);
  ops().remoteBroadcast({ type: IPC.SESSION_META_CHANGED, payload: { sessionId: resolved, ...change } });
  emitConversationMetaChanged();
}

/** The phone's paged history. Kept as the phone's own body: a phone has no window ownership, resume
 *  boundary or watcher, so it resolves the transcript file itself (the computer's version is
 *  desktopTranscriptPage, bound above). Validate the id FIRST, then probe the caller's slug before
 *  scanning — a traversal-shaped id must never shape a path. */
async function phoneTranscriptPage(req: any, nativeHost: NativeSessionHost | undefined): Promise<TranscriptPageResult> {
  const { sessionId: pageSessionId, beforeCursor } = req ?? {};
  const emptyPage: TranscriptPageResult = { events: [], cursor: null, hasMore: false };
  if (typeof pageSessionId !== 'string' || !SAFE_ID_RE.test(pageSessionId)) return emptyPage;
  const beforeOffset = (beforeCursor && typeof beforeCursor.offset === 'number') ? beforeCursor.offset : null;

  // Native sessions page over the merged event array; null means "not a native id", so CC's transcript
  // file is the source. An existing-but-unreadable native transcript throws: `unresolved` (retry).
  let nativePage: Awaited<ReturnType<NativeSessionHost['getHistoryPageAsync']>> = null;
  try { nativePage = nativeHost ? await nativeHost.getHistoryPageAsync(pageSessionId, beforeOffset) : null; }
  catch { return { ...emptyPage, unresolved: true }; }
  if (nativePage) {
    return {
      events: nativePage.events,
      cursor: nativePage.hasMore ? { path: `native:${pageSessionId}`, offset: nativePage.nextIndex!, sizeAtRead: 0 } : null,
      hasMore: nativePage.hasMore,
    };
  }

  const pageProjectsDir = path.join(os.homedir(), '.claude', 'projects');
  const pageSlugs = await fs.promises.readdir(pageProjectsDir).catch(() => [] as string[]);
  const pageSlugHint = req.projectSlug;
  const pageCandidates = (typeof pageSlugHint === 'string' && SAFE_ID_RE.test(pageSlugHint))
    ? [pageSlugHint, ...pageSlugs.filter((sl) => sl !== pageSlugHint)]
    : pageSlugs;
  let pagePath = '';
  for (const slug of pageCandidates) {
    const candidate = path.join(pageProjectsDir, slug, pageSessionId + '.jsonl');
    try { await fs.promises.access(candidate); pagePath = candidate; break; } catch { /* try the next slug */ }
  }
  // "I could not find the transcript" must not read as "you have reached the beginning of the
  // conversation", which the renderer records by dropping the cursor and the scroll-up sentinel for good.
  if (!pagePath) return { ...emptyPage, unresolved: true };
  return readTranscriptPage({
    jsonlPath: pagePath,
    sessionId: pageSessionId,
    endOffset: beforeOffset,
    subagentsDir: path.join(path.dirname(pagePath), pageSessionId, 'subagents'),
  });
}

export const sessionChannels: MainChannelDef[] = [
  // ── Lifecycle ────────────────────────────────────────────────────────────────
  defineChannel({
    name: IPC.SESSION_CREATE, kind: 'handle',
    // Called synchronously, no await before it: the window must claim the session before the first await.
    handler: (opts, ctx) => {
      if (!boundOps) throw new Error('Session opening is not ready. Try again.');
      return boundOps.createSession(ctx.sender ?? null, opts);
    },
    // This payload reaches createSession unfiltered, so without this a phone could ask for
    // `{provider:'shell', cwd:'/'}`. BE PRECISE ABOUT WHAT THIS BUYS: it does NOT stop a signed-in phone
    // from reaching a shell (engine:run-in-terminal and session:input are open to it too). What it removes
    // is what that payload alone would carry — a phone-chosen folder and an initialCommand nothing
    // validated. The property that matters — the APP never runs a command for anyone — is enforced by
    // prepareRunInTerminal, not here.
    remoteGuard: (opts) => (opts?.provider === 'shell'
      ? { ok: false, error: 'A terminal session can only be opened from the app itself.' }
      : undefined),
    // A phone's failed start answers the request instead of leaving it to time out.
    remoteOnError: (error) => ({ ok: false, error: error instanceof Error ? error.message : 'Could not open this conversation.' }),
  }),
  defineChannel({ name: IPC.SESSION_DESTROY, kind: 'handle', handler: ({ sessionId }) => ops().destroySession(sessionId) }),
  defineChannel({
    name: IPC.SESSION_LIST, kind: 'handle',
    // Stamp each native session with the TYPE of the provider it is bound to: two providers can list the
    // same model id (an OpenAI key and the ChatGPT plan both have `gpt-5.5`), and the session knows which
    // one it is bound to; the model id does not.
    handler: async (_p, ctx) => {
      const all = await ops().stampProviderTypes(ops().sessionManager.listSessions());
      const registry = ops().windowRegistry;
      // A phone has no window: it sees every session. A window sees its own; a session with no owner yet
      // (started from a phone) belongs to the primary window.
      if (ctx.door === 'remote' || !registry) return all;
      const callerId = ctx.windowId;
      const primaryId = registry.getLeaderId();
      return all.filter((s) => {
        const owner = registry.getOwner(s.id);
        if (owner == null) return callerId === primaryId;
        return owner === callerId;
      });
    },
  }),
  // Each window reports the session it shows; main caches it per window so the phone snapshot and
  // session:destroyed can tell a phone what the computer is showing. A phone has no window and must never
  // write that cache: refused, silently, as a push is.
  defineChannel({
    name: IPC.SESSION_SELECTED, kind: 'on', desktopOnly: true, refusal: { kind: 'silent' },
    handler: ({ sessionId }, ctx) => { if (ctx.windowId != null) ops().windowRegistry?.setSelectedSession(ctx.windowId, typeof sessionId === 'string' ? sessionId : null); },
  }),
  // Switching is client-side state; this exists so the request is answered on every bridge.
  defineChannel({ name: IPC.SESSION_SWITCH, kind: 'handle', handler: () => ({ ok: true as const }) }),

  // ── Terminal traffic (fire-and-forget) ───────────────────────────────────────
  // WHY these two call straight through: they run at typing speed. The table lookup is one Map read and
  // the desktop door calls the handler directly (no promise hop), so they carry no overhead they lacked.
  defineChannel({ name: IPC.SESSION_INPUT, kind: 'on', handler: ({ sessionId, text }) => { ops().sessionManager.sendInput(sessionId, text); } }),
  defineChannel({ name: IPC.SESSION_RESIZE, kind: 'on', handler: ({ sessionId, cols, rows }) => { ops().sessionManager.resizeSession(sessionId, cols, rows); } }),
  // The renderer says its terminal is mounted; main then releases the output it buffered. A phone needs no
  // such gate (it replays the PTY buffer on connect), so the message is dropped silently.
  defineChannel({
    name: IPC.TERMINAL_READY, kind: 'on', desktopOnly: true, refusal: { kind: 'silent' },
    handler: ({ sessionId }) => { ops().signalTerminalReady(sessionId); },
  }),
  // One device at a time answers a menu by verified navigation — the SAME lock the computer's windows use.
  defineChannel({ name: IPC.SESSION_MENU_LOCK, kind: 'handle', handler: ({ sessionId, holder, action }) => menuAnswerLock.handle(sessionId, holder, action) }),

  // ── Browsing and history ─────────────────────────────────────────────────────
  defineChannel({
    name: IPC.SESSION_BROWSE, kind: 'handle',
    handler: () => {
      const { sessionIdMap, sessionManager, nativeHost } = ops();
      // Collect the conversation ids of the sessions open right now so the Resume list leaves them out.
      // A live session's desktop id is a separate UUID from its Claude transcript id, so it is mapped
      // through the ONE id map; filtered to mappings whose desktop session still exists (the map is a
      // cache, not truth — a stale entry once hid a CLOSED session until restart).
      const activeIds = new Set<string>();
      for (const [desktopId, claudeId] of sessionIdMap.entries()) {
        if (sessionManager.getSession(desktopId)) activeIds.add(claudeId);
      }
      // Native rows join the SAME enrichment pass Claude Code rows get (flags/tags/note/device/title
      // precedence, lastUsedModel); NativeSessionHost stays the one source of truth for what exists.
      return browseOnce([...activeIds].sort().join(','), async () => {
        perfMark('bg:browse:native-list:start');
        const nativeEntries = await nativeHost.listAsync();
        perfMark('bg:browse:native-list:done', { native: nativeEntries.length });
        return listPastSessions(activeIds, nativeEntries);
      });
    },
  }),
  defineChannel({
    name: IPC.SESSION_HISTORY, kind: 'handle',
    handler: async ({ sessionId, projectSlug, count, all }) => {
      // Validate the id BEFORE probing the disk: loadHistory's own guard only runs after a probe, so a
      // traversal-shaped id would make the probe a file-existence oracle. The typeof check matters too:
      // SAFE_ID_RE.test(undefined) coerces to the string "undefined", which the regex accepts.
      if (typeof sessionId !== 'string' || !SAFE_ID_RE.test(sessionId)) return [];
      // Probe the caller's slug FIRST (the common case skips the directory scan); a stale or invalid slug
      // falls through to the scan, and SAFE_ID_RE gates it before it can shape a path.
      const projectsDir = path.join(os.homedir(), '.claude', 'projects');
      const slugs = await fs.promises.readdir(projectsDir).catch(() => [] as string[]);
      const candidates = (typeof projectSlug === 'string' && SAFE_ID_RE.test(projectSlug))
        ? [projectSlug, ...slugs.filter((s) => s !== projectSlug)]
        : slugs;
      let foundSlug = '';
      for (const slug of candidates) {
        try { await fs.promises.access(path.join(projectsDir, slug, sessionId + '.jsonl')); foundSlug = slug; break; } catch { /* next */ }
      }
      if (!foundSlug) return [];
      return loadHistory(sessionId, foundSlug, count, all);
    },
  }),
  // Model + context from a transcript file (first/last byte-range reads). Accepts { path } or a raw string,
  // and rejects anything else BEFORE touching path.resolve, so a malformed frame answers null.
  defineChannel({
    name: IPC.READ_TRANSCRIPT_META, kind: 'handle',
    handler: async (payload) => {
      const transcriptPath = (payload && typeof payload === 'object' && 'path' in payload) ? (payload as { path: unknown }).path : payload;
      if (typeof transcriptPath !== 'string') return null;
      try {
        const claudeProjects = path.join(os.homedir(), '.claude', 'projects');
        const resolved = path.resolve(transcriptPath);
        // + path.sep so a sibling dir like ~/.claude/projects-evil can't pass the prefix check
        if (!resolved.startsWith(claudeProjects + path.sep)) return null;
        return await readTranscriptMeta(transcriptPath);
      } catch { return null; }
    },
  }),
  // Paged history: the newest page, then each older one as the reader scrolls up. The computer's version
  // knows which window is asking (ownership handoffs, resume boundaries, the watcher); a phone has none of
  // that and resolves the transcript itself. One entry, two honest bodies.
  defineChannel({
    name: IPC.TRANSCRIPT_PAGE, kind: 'handle',
    handler: (req, ctx) => (ctx.door === 'remote'
      ? phoneTranscriptPage(req, ctx.runtime?.nativeHost as NativeSessionHost | undefined)
      : ops().desktopTranscriptPage(req, ctx.windowId)),
  }),

  // ── Flags, tags, notes ───────────────────────────────────────────────────────
  // Set a named flag (complete, priority, ...). Refused to a phone, as before (it had no case for it).
  defineChannel({
    name: IPC.SESSION_SET_FLAG, kind: 'handle', remoteAllowed: false,
    handler: async ({ sessionId, flag, value }) => {
      if (!SESSION_FLAG_NAMES.includes(flag as SessionFlagName)) return { ok: false as const, error: `unknown flag: ${flag}` };
      const { sessionIdMap, nativeHost } = ops();
      const resolved = sessionIdMap.get(sessionId) || sessionId;
      try {
        // Flags are STORE-ONLY. Phantom-record gate: only write when `resolved` is a CLAUDE id (the mapping
        // is known) or the id is not a live desktop session (Resume Browser rows pass claude ids for past
        // sessions). Without it, flagging a LIVE session before its SessionStart hook maps it would seed a
        // flag-only record keyed by the desktop UUID — synced to every device and never pruned.
        if (ops().canWriteStoreRecord(sessionId)) {
          const res = await noteFlagChanged(resolved, flag, !!value, nativeHost.isNativeSessionId(resolved));
          if (!res.ok) return { ok: false as const, error: SAVE_REFUSED };
        }
        announceMeta(resolved, { flag, value: !!value });
        return { ok: true as const };
      } catch (e: any) { return { ok: false as const, error: e?.message || String(e) }; }
    },
  }),
  defineChannel({
    name: IPC.SESSION_SET_TAG, kind: 'handle',
    handler: async ({ sessionId, tagId, value }) => {
      if (typeof tagId !== 'string' || !tagId.startsWith('tag_')) return { ok: false as const, error: `invalid tag id: ${tagId}` };
      const { sessionIdMap, nativeHost } = ops();
      const resolved = sessionIdMap.get(sessionId) || sessionId;
      const key = tagFlagKey(tagId);
      try {
        // Same phantom-record gate as set-flag. Tags are stored as `tag:<id>` flags; the provider is derived,
        // not hardcoded, so the write lands in the bucket get-meta / browse read it back from.
        if (ops().canWriteStoreRecord(sessionId)) {
          const res = await noteFlagChanged(resolved, key, !!value, nativeHost.isNativeSessionId(resolved));
          if (!res.ok) return { ok: false as const, error: SAVE_REFUSED };
        }
        announceMeta(resolved, { flag: key, value: !!value });
        return { ok: true as const };
      } catch (e: any) { return { ok: false as const, error: e?.message || String(e) }; }
    },
  }),
  defineChannel({
    name: IPC.SESSION_SET_NOTE, kind: 'handle',
    handler: async ({ sessionId, note }) => {
      const { sessionIdMap, nativeHost } = ops();
      const resolved = sessionIdMap.get(sessionId) || sessionId;
      const text = String(note ?? '');
      if (text.length > 8000) return { ok: false as const, error: 'note exceeds 8000 characters' };
      try {
        if (ops().canWriteStoreRecord(sessionId)) {
          const res = await noteSessionNote(resolved, text, nativeHost.isNativeSessionId(resolved));
          if (!res.ok) return { ok: false as const, error: SAVE_REFUSED };
        }
        announceMeta(resolved, { note: text });
        return { ok: true as const };
      } catch (e: any) { return { ok: false as const, error: e?.message || String(e) }; }
    },
  }),
  // A live or past session's applied tags + note (session:browse excludes live sessions, so the in-session
  // tag chip reads here).
  defineChannel({
    name: IPC.SESSION_GET_META, kind: 'handle',
    handler: async ({ sessionId }) => {
      const store = getConversationStore();
      const resolved = ops().sessionIdMap.get(sessionId) || sessionId;
      // `unreadable` (a missing store or a failed read) is not "none": the close prompt once showed "No
      // note" for a conversation that had one and used that blank as the baseline for a note write. A
      // record that is simply absent is still a real "none".
      if (!store) return { tags: [], note: '', supported: true, unreadable: "conversation storage isn't available" };
      try {
        const rec = await store.get(await sessionProviderFor(resolved), resolved);
        if (!rec) return { tags: [], note: '', supported: true };
        const tags: string[] = [];
        // Reserved flags travel with the tags (the chip shows Priority as a built-in tag). Whitelisted to
        // SESSION_FLAG_NAMES so an internal flag key can never leak by being added to a record.
        const reserved: Partial<Record<string, boolean>> = {};
        for (const [k, v] of Object.entries(rec.flags)) {
          if (v.value && k.startsWith('tag:')) tags.push(k.slice(4));
          else if (v.value && (SESSION_FLAG_NAMES as string[]).includes(k)) reserved[k] = true;
        }
        return { tags, note: rec.note || '', supported: true, flags: reserved };
      } catch (e) { return { tags: [], note: '', supported: true, unreadable: e instanceof Error && e.message ? e.message : "the conversation's record could not be read" }; }
    },
  }),

  // ── Naming ───────────────────────────────────────────────────────────────────
  // get/set are the Assistant-settings preference; title/rename are per-conversation name ownership, and
  // `sessionId` may be a live desktop id or a saved conversation id. ONE implementation (built in
  // registerIpcHandlers) so a phone's rename cannot bypass a gate the computer's path enforces.
  defineChannel({ name: IPC.SESSION_NAMING_GET, kind: 'handle', handler: () => ops().naming.get() as any }),
  defineChannel({ name: IPC.SESSION_NAMING_SET, kind: 'handle', handler: ({ value }) => ops().naming.set(value) as any }),
  defineChannel({ name: IPC.SESSION_NAMING_TITLE, kind: 'handle', handler: ({ sessionId, fallback }) => ops().naming.title(String(sessionId ?? ''), String(fallback ?? '')) as any }),
  defineChannel({ name: IPC.SESSION_NAMING_RENAME, kind: 'handle', handler: ({ sessionId, title }) => ops().naming.rename(String(sessionId ?? ''), String(title ?? '')) as any }),

  // ── Welcome back (the computer's own screen) ─────────────────────────────────
  // A phone never shows it, so it is told "nothing to offer" without the handler running.
  defineChannel({
    name: IPC.SESSION_REOPEN_LIST, kind: 'handle', desktopOnly: true, refusal: { kind: 'reply', payload: [] },
    handler: async () => {
      const store = ops().welcomeBackStore;
      if (!store) return [];
      await store.ready;
      return store.offerIds();
    },
  }),
  defineChannel({
    name: IPC.SESSION_FORGET_REOPEN, kind: 'handle', desktopOnly: true, refusal: { kind: 'reply', payload: { ok: true } },
    handler: async ({ ids }) => {
      const store = ops().welcomeBackStore;
      if (!store) return { ok: true };
      await store.ready;
      store.forget(Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : []);
      return { ok: true };
    },
  }),
];
