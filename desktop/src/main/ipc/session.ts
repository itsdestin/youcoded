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
import { SESSION_FLAG_NAMES, type SessionFlagName, type SessionInfo, type SessionProvider, type TranscriptPageRequest, type TranscriptPageResult } from '../../shared/types';
import { listPastSessions, loadHistory, SAFE_ID_RE } from '../session-browser';
import { readTranscriptMeta } from '../transcript-utils';
import type { Publish } from '../publish';
import type { SessionLiveFacts } from '../session-live';
import type { SessionScreens } from '../session-screens';
import { openSession, openPtyOnly, type NativeLive } from '../session-open';
import { isSendId, SEND_OUTCOMES_MAX_IDS } from '../../shared/send-outcome-types';
import { isClaudeControlRequest, type ClaudeControlRequest, type ClaudeControlResult } from '../../shared/claude-control-types';
import type { SessionRecords } from '../session-record';
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
import { noteMilestone } from '../analytics-service';

/** What registerIpcHandlers hands over: the shared maps and objects, and the few bodies that lean on
 *  its private state. A phone and the computer's windows reach the same ones. */
export interface SessionOps {
  queueAction?: import('../../shared/conversation-queue-channel-types').ConversationQueueBridge['action'];
  // WHY createSession too (2026-09-30 one-core R3-6): engine:run-in-terminal opens its plain-shell session through
  // the same manager, for a window and for a phone.
  sessionManager: Pick<SessionManager, 'listSessions' | 'sendInput' | 'resizeSession' | 'getSession' | 'createSession' | 'control' | 'isControlReady'>;
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
  /** `windowId` is the window whose terminal mounted (ctx.sender.id); flow control needs to know WHICH terminal is ready. */
  signalTerminalReady(sessionId: string, windowId?: number): void;
  /** Terminal flow control (perf): a window finished drawing `chars` characters of this session's output. */
  ackTerminalOutput(sessionId: string, windowId: number | undefined, chars: number): void;
  /** A window cut its hidden-window backlog and asks the program to repaint once. */
  requestTerminalRepaint(sessionId: string, windowId?: number): void;
  /** One page of a conversation's history: the SAME body for a window and a phone (resume boundaries, watchers, the transcript
   *  file by id). WHY one (one-core R5-2): see ipc-handlers.ts transcriptPage. */
  transcriptPage(req: TranscriptPageRequest): Promise<TranscriptPageResult>;
  /** The phantom-record gate: may a write reach the conversation store for this id? */
  canWriteStoreRecord(sessionId: string): boolean;
  /** The one way a session-scoped push leaves the core: the session's windows, every phone, and its record. */
  publish: Publish;
  /** The computer's reading of a Claude Code session's live facts (one-core R5-4a). */
  liveFacts?: SessionLiveFacts;
  /** The computer's own copy of each Claude Code terminal (one-core R5-4b): told what is typed and the terminal's size. */
  screens?: SessionScreens;
  naming: {
    get(): Promise<unknown>;
    set(value: unknown): Promise<unknown>;
    title(sessionId: string, fallback: string): Promise<unknown>;
    rename(sessionId: string, title: string): Promise<unknown>;
  };
}

let boundOps: SessionOps | null = null;
// WHY (2026-09-30 one-core R3-5, review F4): the phone's socket opens before registerIpcHandlers has
// bound these, and for those first seconds a phone's session or naming call used to be answered
// ("Sessions are not ready yet") instead of served. A call that arrives unbound now WAITS for the bind
// (up to BOOT_WAIT_MS) and then runs normally; the computer's own door registers after the bind, so it
// never waits.
const BOOT_WAIT_MS = 15_000;
let bindWaiters: Array<() => void> = [];
/** Called once by registerIpcHandlers (null unbinds, for tests). */
export function bindSessionOps(next: SessionOps | null): void {
  boundOps = next;
  if (next) { const waiting = bindWaiters; bindWaiters = []; for (const wake of waiting) wake(); }
}
function untilBound(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      bindWaiters = bindWaiters.filter((w) => w !== wake);
      reject(new Error('Sessions are not ready yet. Try again.'));
    }, BOOT_WAIT_MS);
    timer.unref?.();
    const wake = () => { clearTimeout(timer); resolve(); };
    bindWaiters.push(wake);
  });
}
/** The bound ops for a handler outside this file that needs them (engine:run-in-terminal): waits for the bind
 *  like a session entry does, and refuses to run for a phone that has gone. */
export async function sessionOpsWhenReady(ctx: { isConnected?(): boolean }): Promise<SessionOps> {
  if (!boundOps) await untilBound();
  if (ctx.isConnected && !ctx.isConnected()) throw new Error('The phone that asked has disconnected.');
  return boundOps!;
}
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

/** `<audience key>:<session id>` for each phone just sent a session's terminal alone, so its ordinary open leaves it out (session:open). */
const ptyCutServed = new Set<string>();
const SAVE_REFUSED = 'Could not save — conversation storage is not available on this device.';

/** After a meta write: tell the owning window and every phone, and refresh the search index. */
function announceMeta(resolved: string, change: Record<string, unknown>): void {
  // Windows get (sessionId, change); phones get {sessionId, ...change} — the shapes the old pair sent (one-core R5-1).
  // WHY everyPhone (one-core R5-3): `resolved` is the conversation's CLAUDE id, which no phone watches; per-session delivery would
  // otherwise deliver this to nobody (found by the dev smoke: a tag change reached only a phone that watched every conversation).
  ops().publish(resolved, IPC.SESSION_META_CHANGED, { sessionId: resolved, ...change }, { windowArgs: [resolved, change], everyPhone: true });
  emitConversationMetaChanged();
}

/** The transcript file for a conversation id, probing the caller's project-folder hint FIRST and scanning
 *  the projects directory only on a miss.
 *  WHY (2026-09-30 one-core R3-5, review F3): both doors listed ~/.claude/projects on every call even
 *  when the hint was right (the common case: one stat would do); a long scroll-up pages dozens of times.
 *  The caller has already checked `sessionId` against SAFE_ID_RE; the hint is checked here before it can
 *  shape a path. Returns the project folder name, or '' when no transcript is found. */
export async function findTranscriptSlug(sessionId: string, slugHint: unknown): Promise<{ slug: string; projectsDir: string }> {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  const exists = (slug: string) => fs.promises.access(path.join(projectsDir, slug, sessionId + '.jsonl')).then(() => true, () => false);
  const hint = typeof slugHint === 'string' && SAFE_ID_RE.test(slugHint) ? slugHint : '';
  if (hint && await exists(hint)) return { slug: hint, projectsDir };
  const slugs = await fs.promises.readdir(projectsDir).catch(() => [] as string[]);
  for (const slug of slugs) {
    if (slug !== hint && await exists(slug)) return { slug, projectsDir };
  }
  return { slug: '', projectsDir };
}

/** What only a native session's host knows, in the shape session-open.ts asks for (null for any other session). */
function nativeLiveFor(host: NativeSessionHost, sessionId: string): NativeLive | null {
  if (!host.isLive(sessionId)) return null;
  return {
    askEvents: () => host.pendingAskEventsFor(sessionId),
    specialistRuns: () => host.specialistRunsFor(sessionId),
    shellRuns: () => host.shellRunsForAsync(sessionId),
    usageProgress: () => host.currentUsageProgressFor(sessionId),
    sessionContext: () => host.sessionContextFor(sessionId),
    idle: () => host.isIdle(sessionId),
    queue: () => host.queuedMessagesFor(sessionId),
    permissionMode: () => host.getPermissionMode(sessionId),
  };
}

/** Also used for late mod receipts after an invoke timed out; these updates are idempotent. */
export function recordClaudeControlResult(records: Pick<SessionRecords, 'noteSend' | 'noteSendRefused'> | undefined, sessionId: string, request: ClaudeControlRequest, result: ClaudeControlResult, mayClearRefusal = true): void {
  if (!records || request.kind !== 'send-text') return;
  if (result.status === 'accepted') records.noteSend(sessionId, request.sendId);
  else if (mayClearRefusal && (result.status === 'rejected' || result.status === 'unavailable')) records.noteSendRefused(sessionId, request.sendId);
}

const sessionEntries: MainChannelDef[] = [
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

  // WHY a separate channel: terminal keys and plan/menu answers must never be inferred as chat controls.
  defineChannel({
    name: IPC.SESSION_CLAUDE_CONTROL, kind: 'handle',
    handler: async (payload, ctx): Promise<ClaudeControlResult> => {
      const { sessionId, request } = payload ?? {};
      if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 128 || !isClaudeControlRequest(request)
        || (request.kind === 'send-text' && !isSendId(request.sendId))) {
        return { status: 'rejected', message: 'This Claude control request is not supported.' };
      }
      // WHY: old remote bundles may still request mods Stop. Prove no dispatch so their existing Escape fallback is safe.
      if (request.kind === 'stop') return { status: 'unavailable' };
      const o = ops(); const records = ctx.runtime?.records;
      // WHY: rejecting a conflicting reuse of an ID must not erase the original operation's uncertainty.
      const newPending = request.kind === 'send-text' ? records?.noteSendPending(sessionId, request.sendId) : false;
      if (request.kind === 'command' && o.sessionManager.isControlReady(sessionId)) o.liveFacts?.directCommandStarted(sessionId, request);
      let result: ClaudeControlResult;
      try { result = await o.sessionManager.control(sessionId, request); }
      catch { result = { status: 'unknown', message: 'Claude did not confirm this action. Check the conversation before trying again.' }; }
      recordClaudeControlResult(records, sessionId, request, result, newPending === true);
      o.liveFacts?.directCommandFinished(sessionId, request, result);
      return result;
    },
  }),

  // ── Terminal traffic (fire-and-forget) ───────────────────────────────────────
  // WHY these two call straight through: they run at typing speed. The table lookup is one Map read and
  // the desktop door calls the handler directly (no promise hop), so they carry no overhead they lacked.
  // `notice` (a typed chat command, one-core R5-4a) is still accepted from older screens but no longer read: the model-switch divider
  // comes from the transcript's own record of the switch (2026-10-22).
  defineChannel({
    name: IPC.SESSION_INPUT, kind: 'on',
    handler: ({ sessionId, text, sendId }, ctx) => {
      const o = ops();
      // Only a write that reached the terminal is a fact worth announcing (a refused one changed nothing).
      if (o.sessionManager.sendInput(sessionId, text)) {
        o.liveFacts?.noteInput(sessionId, text);
        // A submitted line (Enter) is a sent message: the setup staircase's last step (deck U-2).
        // One in-memory check after the first time — this runs at typing speed.
        if (typeof text === 'string' && text.includes('\r') && text.trim().length > 0) noteMilestone('first_message');
        o.screens?.noteInput(sessionId, text);
        // The write was accepted, so the computer "received" this send: a phone that lost its connection right after can learn that (R5-4b).
        if (sendId !== undefined) ctx.runtime?.records.noteSend(sessionId, sendId);
      }
    },
  }),
  defineChannel({ name: IPC.SESSION_RESIZE, kind: 'on', handler: ({ sessionId, cols, rows }) => { const o = ops(); o.sessionManager.resizeSession(sessionId, cols, rows); /* the computer's screen copy follows the PTY worker's size report (pty-size), not this request */ } }),
  // The renderer says its terminal is mounted; main then releases the output it buffered. A phone needs no
  // such gate (it replays the PTY buffer on connect), so the message is dropped silently.
  defineChannel({
    name: IPC.TERMINAL_READY, kind: 'on', desktopOnly: true, refusal: { kind: 'silent' },
    handler: ({ sessionId }, ctx) => { ops().signalTerminalReady(sessionId, ctx.sender?.id); },
  }),
  // Terminal flow control (perf, 2026-10-04): "this terminal finished drawing N characters" lets main lift the brake on a flooding program.
  // WHY desktopOnly + silent refusal: only a desktop window's OWN terminal may release the brake, so a slow phone can never stall the
  // desktop's program; the shim does not send it and a stray/older client's copy is dropped before the handler runs.
  defineChannel({
    name: IPC.TERMINAL_ACK, kind: 'on', desktopOnly: true, refusal: { kind: 'silent' },
    handler: ({ sessionId, chars }, ctx) => { ops().ackTerminalOutput(sessionId, ctx.sender?.id, chars); },
  }),
  // A hidden window's backlog was cut: ask the program to repaint once. Same window-only rule (a phone must not resize the desktop's terminal).
  defineChannel({
    name: IPC.TERMINAL_REPAINT, kind: 'on', desktopOnly: true, refusal: { kind: 'silent' },
    handler: ({ sessionId }, ctx) => { ops().requestTerminalRepaint(sessionId, ctx.sender?.id); },
  }),
  // One device at a time answers a menu by verified navigation — the SAME lock the computer's windows use.
  defineChannel({ name: IPC.SESSION_MENU_LOCK, kind: 'handle', handler: ({ sessionId, holder, action }) => menuAnswerLock.handle(sessionId, holder, action) }),

  // ── Browsing and history ─────────────────────────────────────────────────────
  defineChannel({
    name: IPC.SESSION_BROWSE, kind: 'handle',
    handler: (payload) => {
      const { sessionIdMap, sessionManager, nativeHost } = ops();
      // Collect the conversation ids of the sessions open right now so the Resume list leaves them out.
      // A live session's desktop id is a separate UUID from its Claude transcript id, so it is mapped
      // through the ONE id map; filtered to mappings whose desktop session still exists (the map is a
      // cache, not truth — a stale entry once hid a CLOSED session until restart).
      const activeIds = new Set<string>();
      for (const [desktopId, claudeId] of sessionIdMap.entries()) {
        if (sessionManager.getSession(desktopId)) activeIds.add(claudeId);
      }
      // WHY (2026-09-30 one-core R3-5, review F2): a NATIVE session's desktop id IS its conversation id, but
      // it is entered in the map only after its native start finishes; browsing in that window offered the
      // brand-new conversation as resumable. The old phone lookup excluded every live id; this keeps that for
      // native ids only (a Claude desktop id matches no transcript, and the tests pin it stays out).
      for (const live of sessionManager.listSessions()) {
        if (nativeHost.isNativeSessionId(live.id)) activeIds.add(live.id);
      }
      // Native rows join the SAME enrichment pass Claude Code rows get (flags/tags/note/device/title
      // precedence, lastUsedModel); NativeSessionHost stays the one source of truth for what exists.
      // WHY includeOpen (spec 2026-10-16, a page's chat list): the Resume list leaves open chats out, but a page
      // that shows "Working" needs them, with the same names, tags and notes. They come from the same scan with
      // nothing excluded and the ones open right now marked `open` — the app's own id map is the only thing that
      // knows which transcript belongs to which open tab, so the mapping cannot be done by the page. New row
      // objects, never a change to the shared in-flight answer another caller may be holding.
      if (payload?.includeOpen === true) {
        return browseOnce(`all:${[...activeIds].sort().join(',')}`, async () => {
          const nativeEntries = await nativeHost.listAsync();
          const rows = await listPastSessions(undefined, nativeEntries);
          return rows.map((r) => (activeIds.has(r.sessionId) ? { ...r, open: true } : r));
        });
      }
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
      // WHY (2026-09-30 one-core R3-5, F3): the caller's slug is probed first and the directory scanned only
      // on a miss (findTranscriptSlug); SAFE_ID_RE gates both before they can shape a path.
      const { slug: foundSlug } = await findTranscriptSlug(sessionId, projectSlug);
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
  // Paged history: the newest page, then each older one as the reader scrolls up. ONE body for a window and a phone
  // (one-core R5-2): a page depends on the session, not on who asks.
  defineChannel({
    name: IPC.TRANSCRIPT_PAGE, kind: 'handle',
    handler: (req) => ops().transcriptPage(req),
  }),
  // The ONE way a screen is filled (one-core R5-2, session-open.ts): the newest page, the record's recent past and what only
  // memory holds, or just the events a reconnecting screen missed. From the moment it arrives until the answer is sent, this
  // screen's pushes for the session are held (audience-fill.ts), so the answer and the live stream never overlap or leave a gap.
  defineChannel({
    name: IPC.SESSION_OPEN, kind: 'handle',
    handler: async (req, ctx) => {
      const o = ops();
      const rt = ctx.runtime;
      if (!rt) return { ok: false as const, error: 'The computer is still starting. Try again.' };
      // WHO is asking: a window (webContents id) or a phone (its id in the window registry). The key is how holds are named.
      const audience = ctx.door === 'desktop'
        ? (ctx.windowId !== undefined ? { key: `w${ctx.windowId}`, id: ctx.windowId, socket: false } : null)
        : (ctx.audienceId !== undefined ? { key: `s${ctx.audienceId}`, id: ctx.audienceId, socket: true } : null);
      const sessionId = typeof req?.sessionId === 'string' ? req.sessionId : '';
      // The terminal alone (one-core sync-fix2): a phone's terminal no longer waits for the chat page. Joined to the terminal stream and cut in the same synchronous step,
      // so the frames that follow continue exactly from the answer. No hold, no chat subscription: the ordinary open still follows and fills the chat.
      if (req?.ptyOnly === true && audience?.socket && sessionId) {
        const reply = openPtyOnly({ knows: (id) => !!o.sessionManager.getSession(id), records: rt.records }, req);
        if (reply.ok) {
          o.windowRegistry?.subscribePty(sessionId, audience.id);
          ptyCutServed.add(`${audience.key}:${sessionId}`);
          // Bounded (branch review F8): an entry is removed by the ordinary open that follows, which a dropped connection never sends.
          if (ptyCutServed.size > 256) ptyCutServed.delete(ptyCutServed.values().next().value as string);
        }
        return reply as unknown as Awaited<ReturnType<typeof openSession>>;   // same channel, its own small shape (PtyOnlyReply)
      }
      // WHY (2026-10-22 phone reliability): a phone asks for the terminal alone and then the ordinary open, both carrying its terminal
      // position — and both answers carried the terminal, up to 4 M characters, the second only to be thrown away. Over the slow relay a
      // phone used, that doubled a conversation's first load. The terminal answer just went out first on this same socket, so the
      // ordinary one leaves it out. A phone that never asks for the terminal alone (an older page) still gets it here.
      if (audience?.socket && sessionId && ptyCutServed.delete(`${audience.key}:${sessionId}`) && req?.pty) req = { ...req, pty: undefined };
      if (audience && sessionId) {
        rt.fills.begin(audience.key, sessionId, { reset: true });
        // A phone gets a session's pushes once it has opened it: the same "this audience member wants this session" fact a
        // buddy window's subscribe is (R5-1). Joined BEFORE the head is sampled so nothing between them is missed.
        if (audience.socket) o.windowRegistry?.subscribe(sessionId, audience.id);
      }
      let reply;
      try {
        reply = await openSession({
          records: rt.records,
          knows: (id) => !!o.sessionManager.getSession(id),
          page: (r) => o.transcriptPage({ sessionId: r.sessionId, beforeCursor: null, claudeSessionId: r.claudeSessionId, projectSlug: r.projectSlug, toEnd: true }),
          native: (id) => nativeLiveFor(rt.nativeHost as NativeSessionHost, id),
          persistedShellRuns: async (id) => {
            const info = o.sessionManager.getSession(id);
            return info?.provider === 'native' && info.cwd ? (rt.nativeHost as NativeSessionHost | undefined)?.persistedShellRunsFor(id, info.cwd) ?? [] : [];
          },
        }, req, { remote: ctx.door === 'remote' });
      } catch (err) {
        if (audience && sessionId) rt.fills.release(audience.key, sessionId);
        throw err;
      }
      // The answer is sent by the door when this returns; the held pushes follow it, in order.
      if (audience && sessionId) {
        if (ctx.afterReply) ctx.afterReply(() => rt.fills.release(audience.key, sessionId));
        else rt.fills.release(audience.key, sessionId);
      }
      return reply;
    },
  }),

  // End a phone's watch of one session (one-core R5-3). The phone keeps what it has drawn and is sent nothing more for this session
  // (the summary keeps flowing), until it opens it again: `session:open` is the only thing that starts a watch.
  // WHY a window gets a plain "ok" and nothing happens: a window's audience is ownership and its own subscriptions (the buddy), which
  // other channels manage; per-session delivery is a phone's concern only, and the computer's windows must not be affected by it.
  defineChannel({
    name: IPC.SESSION_UNWATCH, kind: 'handle',
    handler: async (req, ctx) => {
      const sessionId = typeof req?.sessionId === 'string' ? req.sessionId : '';
      if (ctx.door !== 'desktop' && ctx.audienceId !== undefined && sessionId) {
        ops().windowRegistry?.unsubscribe(sessionId, ctx.audienceId);
        // An open still in flight must not deliver its held pushes to a screen that has just said it no longer wants them.
        ctx.runtime?.fills.cancel(`s${ctx.audienceId}`, sessionId);
      }
      return { ok: true as const };
    },
  }),

  // "Did the computer get my message?" (one-core R5-4b). A screen that lost its connection mid-send asks what the record noted for the ids it has
  // no echo for. Read-only; any screen may ask about any session it can see (an id says nothing about the message's text).
  defineChannel({
    name: IPC.SESSION_SEND_OUTCOMES, kind: 'handle',
    handler: (req, ctx) => {
      const sessionId = typeof req?.sessionId === 'string' ? req.sessionId : '';
      const ids = (Array.isArray(req?.ids) ? req.ids : []).slice(0, SEND_OUTCOMES_MAX_IDS);
      if (!ctx.runtime || !sessionId) return { epoch: null, outcomes: Object.fromEntries(ids.filter(isSendId).map((i) => [i, 'unknown' as const])) };
      return ctx.runtime.records.sendOutcomes(sessionId, ids, req?.epoch);
    },
  }),

  // ── Flags, tags, notes ───────────────────────────────────────────────────────
  // Set a named flag (complete, priority, ...).
  // WHY open to a phone now (2026-10-01 one-core R6-1; Destin, 2026-09-30: "a phone may set session flags (complete, priority). Yes."):
  // it was refused only because the phone's old code had no case for it. The body is the computer's own, so a phone's flag lands in the
  // same store record and is announced to every screen the same way. Tags and notes were already open to a phone.
  defineChannel({
    name: IPC.SESSION_SET_FLAG, kind: 'handle',
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
      return store.offerEntries();
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

/** Entries whose handler never reads the bound ops, so they have nothing to wait for. */
const NEEDS_NO_BIND = new Set<string>([IPC.SESSION_HISTORY, IPC.READ_TRANSCRIPT_META, IPC.SESSION_SWITCH, IPC.TRANSCRIPT_PAGE]);

/** Every other entry, made to wait for the bind when called before it (see untilBound). WHY the bound path
 *  calls the handler directly with no await: session:create must claim its window before its first await. */
export const sessionChannels: MainChannelDef[] = sessionEntries.map((def) => NEEDS_NO_BIND.has(def.name) ? def : ({
  ...def,
  handler: (payload: any, ctx: any) => (boundOps ? def.handler(payload, ctx) : untilBound().then(() => {
    // WHY (2026-09-30 one-core R3-6, R3-5 review): a phone that asked during the boot wait and then
    // disconnected must not have its request run afterwards (a session create would make a session nobody
    // asked to see). Its reply would be dropped anyway, so skip the work.
    if (ctx?.isConnected && !ctx.isConnected()) return undefined;
    return def.handler(payload, ctx);
  })),
}));
