/**
 * WebSocket-backed implementation of window.claude for browser (non-Electron) access.
 * Provides the same API surface as the Electron preload bridge.
 */

// Type-only, so nothing is added to the bundle the Android WebView loads.
import type { VoiceReadiness } from '../shared/voice-types';

// ── Marketplace types re-declared locally ─────────────────────────────────────
// WHY: remote-shim.ts lives in renderer/ and cannot import from main/ (Node.js
import { REMOTE_UNSUPPORTED_EVENT, hasFeatureName, remoteFeatureName, remoteUnsupportedMessage } from './remote-unsupported';
import { REMOTE_RECONNECTED_EVENT } from './remote-events';
import type { FirstRunState } from '../shared/first-run-types';
// boundary). These interfaces mirror marketplace-auth-store.ts and
// marketplace-api-handlers.ts exactly — keep in sync if those change.
interface MarketplaceUser {
  id: string;       // github:<numeric id>
  login: string;
  avatar_url: string;
}

type ApiResult<T> = { ok: true; value: T } | { ok: false; status: number; message: string };

type Callback = (...args: any[]) => void;

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timeout: ReturnType<typeof setTimeout>;
  type: string;
  /** Sent, no reply, timed out: it MAY have run. Asked about on reconnect, never retried. */
  outcomeUnknown?: boolean;
}

/**
 * Ids whose fate the host could not tell us, announced as a window event.
 *
 * NOTHING LISTENS TO THIS YET. The sentence here used to read "The UI reads this to say so
 * plainly", which was not true: the reconciliation runs and the event fires, and the person
 * is told nothing either way. Sending is still safe — a request is never re-run — but the
 * "we don't know whether that happened" state has no screen. Filed as an open item in
 * docs/roadmap/remote-access.md rather than invented at review time.
 */
export const OUTCOME_UNKNOWN_EVENT = 'youcoded:outcome-unknown';

export type RemoteConnectionState = 'disconnected' | 'connecting' | 'authenticating' | 'connected';

let ws: WebSocket | null = null;
let messageId = 0;
/**
 * Bumped on every socket. Request ids were `msg-N` from a per-page-load counter, so two
 * devices — or the same device after a reload — produced the same ids, and a host answering
 * "did this run?" could answer about somebody else's request.
 */
let connectionGeneration = 0;
/** Rehydration is for coming BACK: on a first connect the caller's own queued mount-time
 *  fetches already flush, and re-asking would double every connection's traffic. */
let hasConnectedBefore = false;
/** Set from auth:ok, so an id names the device it came from. */
let myDeviceId = '';
const pending = new Map<string, PendingRequest>();
const listeners = new Map<string, Set<Callback>>();
let connectionState: RemoteConnectionState = 'disconnected';
let stateChangeCallback: ((state: RemoteConnectionState) => void) | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30_000;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

/** Why a sign-in did not complete, attached to the error connect() rejects with.
 *
 * WHY the kinds (Destin, 2026-09-11: the password screen "flickering before loading back into
 * the thing without actually needing a password"): every failure used to look alike, so a page
 * load with no signal yet was treated like a computer that had unpaired the phone, and the
 * saved key was deleted. Only `refused` is the computer's answer about the key; the other
 * kinds say nothing about it. */
export type SignInFailure =
  | { kind: 'refused'; reason: string }
  | { kind: 'unreachable' | 'closed' };
export type SavedKeySignInEvent =
  | { type: 'refused'; reason: string }
  | { type: 'failed'; kind: 'unreachable' | 'closed' };

/** Refusals that mean the saved key can never sign in again. `no-password-configured` is not
 *  one: remote access is switched off on the computer, and the key works again once it is on. */
const KEY_IS_DEAD = new Set(['revoked', 'unknown', 'invalid-credentials']);

/** The sign-in screen, told how the saved key's attempts go until one succeeds. */
let savedKeyListener: ((e: SavedKeySignInEvent) => void) | null = null;
/** Set by "Enter password instead": no more automatic attempts with the saved key. */
let savedKeyStopped = false;

/** Told when the computer refuses this device AFTER it had connected (unpaired, or its key
 *  retired by a password change), so the page can leave the app for the password screen instead
 *  of saying "Reconnecting" forever (review of the 2026-09-11 fixes, finding 4). */
let credentialRefusedListener: ((reason: string) => void) | null = null;
export function onCredentialRefused(cb: (reason: string) => void): void {
  credentialRefusedListener = cb;
}

function noteRefusedAfterConnecting(reason: string): void {
  // The next sign-in is a new pairing whose terminals start empty: resuming the old terminal
  // positions would skip everything before them.
  lastReadyHost = null;
  credentialRefusedListener?.(reason);
}

/** Messages received from the computer. The wake check reads it: anything arriving after its
 *  question proves the connection is alive, even when the reply itself is queued behind it. */
let framesReceived = 0;

function signInError(message: string, failure: SignInFailure): Error {
  return Object.assign(new Error(message), { signInFailure: failure });
}

function signInFailureOf(err: unknown): SignInFailure | null {
  return (err as { signInFailure?: SignInFailure } | null)?.signInFailure ?? null;
}

/** Override WebSocket target — set by connectToHost(), cleared by disconnectFromHost() */
let targetUrl: string | null = null;

// Remote access batch 2 (design §1 A, §6): the readiness handshake.
//
// The host queues every broadcast for this client until it hears `client:ready`, then
// restores in order (session list, snapshot, replays, the queue) and goes live. The shim
// sends it the FIRST time App's chat:hydrate listener exists after auth:ok — that is the
// moment the page can apply what the host sends — and never twice per connection: App
// re-adds the listener on an effect re-run or a StrictMode double mount, and a second
// client:ready must not restart the sequence.
//
// `clientReadySeq` is monotonic for the shim's LIFETIME, never per connection: the host
// echoes it in chat:hydrate and the shim applies only the hydrate it last asked for, so a
// slow answer to an earlier request (or an earlier connection) can never land on top of a
// newer one. Refresh (remote:rehydrate, §6) draws from the same counter.
let clientReadySeq = 0;
let readySentThisGeneration = false;
/** Whether this client held state from THIS host before the current connection. The host
 *  uses it to decide what its restore may skip. Keyed on the host, not the shim's lifetime
 *  (review of T1, finding 1): an Android page connects to its local bridge first, and a
 *  later pairing to a desktop is a FIRST connect to that desktop, however many times the
 *  bridge was reached before — and the same in reverse on the fallback to local. */
let readyReconnect = false;
let lastReadyHost: string | null = null;

// Remote access batch 2 (design §6, contract R13–R15): where this page's copy of the
// conversation stands. The shim alone knows it — the connection state, which hydrate it
// asked for last, whether that hydrate was degraded, and (from App's report) whether the
// apply kept any session of the phone's own. App only renders the strip.
type ConversationPhase = 'reconnecting' | 'restoring' | 'incomplete' | 'complete';
let conversationPhase: ConversationPhase | null = null;
/** Set around a close that is not a drop: leaving a paired computer, or a host that refused
 *  this device for good. Neither is "reconnecting" (T4 review, 3 and 13). */
let suppressReconnectingPhase = false;
/** The hydrate most recently handed to the page, waiting for App's report. */
let lastHydrate: { seq: number | undefined; degraded: boolean } | null = null;
let noHydrateTimer: ReturnType<typeof setTimeout> | null = null;
/** A restore that never answers must not leave the strip busy forever. */
const NO_HYDRATE_MS = 10_000;

function setConversationPhase(phase: ConversationPhase): void {
  // The Android app on its own local bridge never hydrates from a computer: a phase there
  // would end as "may be out of date" with a Refresh that has nothing to refresh.
  if (isAndroidLocal()) return;
  conversationPhase = phase;
  dispatchEvent('remote:conversation-status', { phase });
}

/** This page no longer describes a computer's copy (it left the host): forget the phase so a
 *  late subscriber is not told a stale one. */
function forgetConversationPhase(): void {
  conversationPhase = null;
  lastHydrate = null;
  if (noHydrateTimer) { clearTimeout(noHydrateTimer); noHydrateTimer = null; }
}

function armNoHydrateTimer(): void {
  if (noHydrateTimer) clearTimeout(noHydrateTimer);
  const seqAtArm = clientReadySeq;
  noHydrateTimer = setTimeout(() => {
    noHydrateTimer = null;
    if (conversationPhase === 'restoring' && clientReadySeq === seqAtArm) setConversationPhase('incomplete');
  }, NO_HYDRATE_MS);
}

/** App's report after it applied a hydrate: which sessions the apply kept. */
function reportHydrate(report: { seq?: number; kept?: string[] } | undefined): void {
  if (!lastHydrate || report?.seq !== lastHydrate.seq) return;
  if (report?.seq !== undefined && report.seq !== clientReadySeq) return;   // an older ask
  if (noHydrateTimer) { clearTimeout(noHydrateTimer); noHydrateTimer = null; }
  const kept = Array.isArray(report?.kept) ? report!.kept : [];
  setConversationPhase(lastHydrate.degraded || kept.length > 0 ? 'incomplete' : 'complete');
}

/** Refresh (§6): ask the host for a fresh copy under the next seq. */
function requestRehydrate(): Promise<{ ok: boolean }> {
  // Not while the socket is down: the reconnect's own restore brings a fresh copy, and a
  // queued Refresh would run a second one right behind it.
  if (connectionState !== 'connected') return Promise.resolve({ ok: false });
  const seq = ++clientReadySeq;
  setConversationPhase('restoring');
  armNoHydrateTimer();
  return invoke('remote:rehydrate', { seq }).then((r: { ok?: boolean } | undefined) => {
    // A host that answers without refreshing (T4 review, 1): the strip must not stay busy.
    if (!r?.ok && clientReadySeq === seq) setConversationPhase('incomplete');
    return { ok: !!r?.ok };
  }).catch(() => {
    // A host that cannot refresh (an older desktop, the Android runtime): say the copy
    // may still be behind, which is true, rather than stay busy.
    if (clientReadySeq === seq) setConversationPhase('incomplete');
    return { ok: false };
  });
}

// Remote access batch 2 (design §7): how much of each session's terminal this page has
// drawn, as the host's own stream positions. Every pty:output from a batch-2 host carries
// the buffer's `epoch` and the chunk's `offset`; the end of the last chunk is what a
// reconnect reports, and the host answers with exactly the units past it — or, when the
// epoch changed (a host restart, a session recreated) or the offset is no longer held, a
// pty:reset followed by the whole buffer. An older host sends neither field; nothing is
// reported for it and a reconnect replays in full, as before.
const ptyOffsets = new Map<string, { epoch: string; units: number }>();

function collectPtyOffsets(): Record<string, { epoch: string; units: number }> {
  return Object.fromEntries(ptyOffsets);
}

// Remote access batch 2 (design §1 C): terminal frames that arrive before the terminal
// for that session has a listener. The restore sends the terminal replay the moment the
// phone says it is ready, and TerminalView's listener is a React effect that registers
// after commit — without a backlog the head of the replay was gone. Bounded per session
// in UTF-16 units; overflow drops the oldest, so a long-idle tab still draws the tail.
// `pty:raw-bytes` is deliberately not here: no desktop host emits it.
const PTY_BACKLOG_MAX_UNITS = 256 * 1024;
/** How far past the cut the trim looks for a line break before cutting where it is. An
 *  Ink redraw can run hundreds of KB without one (T2 re-review, 10). */
const LINE_BREAK_SEARCH_UNITS = 4096;
/** Permission answers sent from this page and not yet replied to (T2 review, 1). */
const answersInFlight = new Set<string>();
type PtyBacklogEntry = { kind: 'output'; data: string } | { kind: 'reset' };
const ptyBacklog = new Map<string, { entries: PtyBacklogEntry[]; units: number }>();

function backlogPty(sessionId: string, entry: PtyBacklogEntry): void {
  let b = ptyBacklog.get(sessionId);
  if (!b) { b = { entries: [], units: 0 }; ptyBacklog.set(sessionId, b); }
  b.entries.push(entry);
  if (entry.kind === 'output') b.units += entry.data.length;
  // Over the cap, trim the OLDEST output and keep its tail (T2 review, 5). Dropping whole
  // entries threw away a restore's entire replay — one frame of up to 4M units — the
  // moment one more frame arrived, while the saved offset already counted it as drawn,
  // so no later reconnect would ever send it again. A terminal needs the tail; the cut
  // moves forward to a line break when there is one, so it rarely lands mid-sequence.
  while (b.units > PTY_BACKLOG_MAX_UNITS) {
    const idx = b.entries.findIndex((e) => e.kind === 'output');
    if (idx < 0) break;
    const oldest = b.entries[idx] as { kind: 'output'; data: string };
    const excess = b.units - PTY_BACKLOG_MAX_UNITS;
    if (oldest.data.length <= excess) {
      b.entries.splice(idx, 1);
      b.units -= oldest.data.length;
      continue;
    }
    let cut = excess;
    const nl = oldest.data.indexOf('\n', cut);
    if (nl >= 0 && nl - cut <= LINE_BREAK_SEARCH_UNITS && nl + 1 < oldest.data.length) cut = nl + 1;
    b.entries[idx] = { kind: 'output', data: oldest.data.slice(cut) };
    b.units -= cut;
  }
}

/** Hand a session's backlog to the listener that just registered, in arrival order. */
function drainPtyBacklog(sessionId: string): void {
  const b = ptyBacklog.get(sessionId);
  if (!b) return;
  ptyBacklog.delete(sessionId);
  for (const entry of b.entries) {
    if (entry.kind === 'reset') dispatchEvent(`pty:reset:${sessionId}`);
    else dispatchEvent(`pty:output:${sessionId}`, entry.data);
  }
}

function forgetPtySession(sessionId: string): void {
  ptyOffsets.delete(sessionId);
  ptyBacklog.delete(sessionId);
}

function maybeSendClientReady(): void {
  if (connectionState !== 'connected' || readySentThisGeneration) return;
  if (!listeners.get('chat:hydrate')?.size) return;   // App has not mounted its handler yet
  readySentThisGeneration = true;
  fire('client:ready', { seq: ++clientReadySeq, reconnect: readyReconnect, ptyOffsets: collectPtyOffsets() });
  armNoHydrateTimer();
}
/** Whether to preserve __PLATFORM__ on next auth:ok (prevents desktop overwriting 'android') */
let preservePlatform = false;

/** The one sentence shown when a voice call is refused because this device is
 *  paired to another computer.
 *
 *  WHO ACTUALLY READS THIS, which is not who the first draft addressed: a plain
 *  remote browser tab never gets the namespace at all (it is deleted below), so it
 *  draws no mic and reaches no sentence. The only reader is a PHONE that paired to
 *  a desktop mid-session — and for that reader the old wording, about browsers and
 *  encrypted connections, was an unverified cause for someone who is not in a
 *  browser. Their real reason is simpler: while paired, the phone talks to the
 *  desktop, and the desktop has no voice over that bridge. It is also actionable,
 *  which the old sentence was not — disconnecting brings the mic straight back.
 *  Found reviewing T7, 2026-09-05; see docs/error-message-standards.md.
 *
 *  (Why voice is off in a remote browser at all, for the reader of this file: a
 *  browser only hands a page the microphone on an encrypted connection, and remote
 *  access is still plain http. Destin decided on the voice questions deck, Q-7,
 *  that it stays off until that changes rather than shipping a button that fails.) */
const VOICE_REMOTE_REASON =
  'Voice typing is off while you are connected to another computer. '
  + "Disconnect to use this phone's microphone.";

/** Is this client the Android app talking to its OWN on-device bridge?
 *
 *  `file:` means the page was loaded out of the APK (a browser tab is http/https),
 *  and no `targetUrl` means it has not been pointed at someone's desktop. Both
 *  halves are needed: `!targetUrl` ALONE is also true of a plain remote browser
 *  tab, which is precisely where the microphone must not appear. */
function isAndroidLocal(): boolean {
  return location.protocol === 'file:' && !targetUrl;
}

// Fix: queue application messages sent before the WS auth handshake completes,
// then flush on auth:ok. Without this, first-mount fetches (skills.list etc.)
// that race the auth handshake silently disappeared, leaving contexts empty
// for the app's lifetime. Visible on Android as "installed plugins never
// appear in the command drawer." Bound at MAX_QUEUE to prevent unbounded
// growth if a real flow ever fans out faster than the auth handshake.
const MAX_QUEUE = 256;
/** How long a request waits for an answer, and therefore how long a queued message can
 *  still have somebody waiting on it. The two must be the same number. */
const REQUEST_TIMEOUT_MS = 30_000;
/**
 * Queued while the socket is down, with the time each was queued.
 *
 * WHY the timestamp: the queue is what makes a FIRST connect work — mount-time reads fire
 * before auth and would otherwise be lost — but it was also replaying requests whose caller
 * had already been told, thirty seconds earlier, that they failed. So an action you were
 * told did not happen could happen minutes later. Anything older than the request timeout
 * is dropped at flush instead: nobody is still waiting on it, and the honest outcome for a
 * caller that already gave up is nothing at all.
 */
let pendingSendQueue: { data: string; at: number }[] = [];

function setConnectionState(state: RemoteConnectionState) {
  const was = connectionState;
  connectionState = state;
  // Batch 2 (§6): leaving `connected` after a first successful connect is a drop —
  // the strip says "reconnecting" and the phone keeps what it shows.
  if (was === 'connected' && state !== 'connected' && hasConnectedBefore && !suppressReconnectingPhase) setConversationPhase('reconnecting');
  if (was === 'connected' && state !== 'connected') failRequestsCutOffByDrop();
  stateChangeCallback?.(state);
}

/**
 * Requests sent on a connection that just dropped can never be answered: the host replies on the
 * socket a request came from. WHY fail them now (review of the 2026-09-11 fixes, finding 3): each
 * used to wait out its 30 s, by which time the reconnect had already asked the host about the
 * requests it knew were lost, so one that ran was reported as timed out and never checked. Marked
 * "may have run" here, so the reconnect's sign-in asks. The Android app's own bridge cannot
 * answer that question, so there they are simply dropped.
 */
function failRequestsCutOffByDrop(): void {
  for (const [id, entry] of pending) {
    if (entry.outcomeUnknown) continue;
    clearTimeout(entry.timeout);
    if (isAndroidLocal()) pending.delete(id);
    else entry.outcomeUnknown = true;
    entry.reject(new Error('Lost the connection before the computer answered.'));
  }
}

export function onConnectionStateChange(cb: (state: RemoteConnectionState) => void) {
  stateChangeCallback = cb;
}

function getWsUrl(): string {
  // If a remote host override is set, use it (connectToHost sets this)
  if (targetUrl) return targetUrl;
  // Android WebView loads from file:// — connect to local bridge server.
  // Port comes from the `bridgePort` query param injected by WebViewHost.kt
  // so dev (9951) and release (9901) APKs can run side-by-side without
  // colliding on the same localhost socket. Default 9901 keeps the legacy
  // wiring working if a host forgets to inject the param.
  if (location.protocol === 'file:') {
    const port = new URLSearchParams(location.search).get('bridgePort') || '9901';
    return `ws://localhost:${port}`;
  }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

/**
 * What each outbound channel is, and therefore what happens to it while the socket is down.
 *
 * Contract row R2: a message typed while the connection is down waits as a draft until you
 * press Send yourself; nothing runs again on its own. The old behaviour was the opposite —
 * everything queued and the queue was flushed on the next auth:ok, so a request that had
 * already timed out and told the user it failed could execute minutes later.
 *
 *   'user-action' — something the person did. Refused while disconnected; the composer keeps
 *                   the text. NEVER queued, because queueing is what makes it run twice.
 *   'read'        — safe to SEND again, because sending it twice lands where sending it once
 *                   does. Usually because it asks rather than changes; `session:resize` is
 *                   the exception that made the older wording ("asking changes nothing")
 *                   false, since a resize does change the host and is still safe to repeat.
 *   'transport'   — the connection talking about itself.
 *
 * An unclassified channel fails remote-message-kinds.test.ts. That is deliberate: the way
 * this goes wrong again is a new channel quietly defaulting to the queue.
 */
export const MESSAGE_KIND: Readonly<Record<string, 'user-action' | 'read' | 'transport'>> = {
  'session:input': 'user-action',
  'session:resize': 'read',
  'session:terminal-ready': 'transport',
  'native:interrupt': 'user-action',
  'native:retry': 'user-action',
  'ui:action': 'user-action',
  'system:notify-stack-state': 'transport',
  // Batch 2: the readiness handshake is the connection talking about itself. Sent only
  // while connected (maybeSendClientReady checks), so it is never queued anyway.
  'client:ready': 'transport',
  // A theme change made on this phone, told to the computer and other phones. The change is
  // already saved (appearance:set); a copy queued while offline could replay an old theme over
  // a newer one chosen on the computer meanwhile, so it is never queued.
  'appearance:broadcast': 'user-action',
};

/**
 * Re-issued once on reconnect. WHY this exists at all: deleting the flush queue would
 * otherwise bring back the cold-start bug where installed plugins never appeared in the
 * command drawer — the mount-time fetches fired before auth and were lost. Reads only, and
 * a test asserts that.
 */
export const REHYDRATE_ON_RECONNECT: readonly string[] = [
  'skills:list',
  'commands:list',
  'remote:get-config',
  'remote:status',
  // The file lists a phone was showing when it dropped (remote access batch 3,
  // design §8). Re-issued with the arguments they were last asked with — see
  // lastReadPayload — because a bare list-all-files names no project and is a
  // request the host can only refuse.
  'artifacts:list-all-files',
  'artifacts:list-session',
];

/**
 * The payload each REHYDRATE_ON_RECONNECT channel was last invoked with, so the
 * re-issue asks the same question. Channels that take no arguments simply never
 * appear here and are re-issued bare, as before.
 */
const lastReadPayload = new Map<string, unknown>();

function send(msg: any): boolean {
  const data = JSON.stringify(msg);
  // Only send directly when both the socket is OPEN AND auth has completed.
  // If OPEN but still 'authenticating', the auth message has been sent but
  // 'auth:ok' hasn't arrived — the bridge rejects application messages here.
  if (ws?.readyState === WebSocket.OPEN && connectionState === 'connected') {
    ws.send(data);
    return true;
  }
  // A person's action is never held for later: the composer keeps the text and they send it
  // when they choose. Everything else waits for auth, which lands within the connect.
  if (MESSAGE_KIND[msg?.type] === 'user-action') return false;
  if (pendingSendQueue.length >= MAX_QUEUE) {
    console.warn('[remote-shim] send queue overflow — dropping oldest');
    pendingSendQueue.shift();
  }
  pendingSendQueue.push({ data, at: Date.now() });
  return true;
}

/**
 * The stored credential is `<deviceId>:<secret>`.
 *
 * WHY a value with no colon is sent as a device id with no secret: that is a credential from
 * the retired token file. The host answers "unknown", which is terminal, so the client stops
 * and asks for the password once rather than retrying a credential that can never work.
 */
function splitCredential(stored: string): { deviceId: string; secret?: string } {
  const at = stored.indexOf(':');
  return at === -1 ? { deviceId: stored } : { deviceId: stored.slice(0, at), secret: stored.slice(at + 1) };
}

/** A name for this device's row in the host's list — never its address. */
function describeThisDevice(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iPhone' : /Mac/i.test(ua) ? 'Mac' : /Windows/i.test(ua) ? 'Windows' : /Linux/i.test(ua) ? 'Linux' : '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return os ? `${browser} on ${os}` : browser;
}

/**
 * Ask the host whether the requests we lost the answers to actually ran.
 *
 * WHY it can answer "unknown" and that is not a bug: the host keeps a short ring of
 * completed ids, so anything older — or anything at all after the host restarted — is
 * genuinely not knowable. Saying so is the honest option; guessing "done" or silently
 * retrying are both worse.
 */
function reconcileUnknownOutcomes(): void {
  const ids = [...pending.entries()].filter(([, e]) => e.outcomeUnknown).map(([id]) => id);
  if (ids.length === 0) return;
  invoke('remote:request-outcome', { ids }).then((res: { outcomes?: Record<string, string> }) => {
    const outcomes = res?.outcomes ?? {};
    for (const id of ids) {
      const entry = pending.get(id);
      if (!entry) continue;
      pending.delete(id);
      window.dispatchEvent(new CustomEvent(OUTCOME_UNKNOWN_EVENT, {
        detail: { id, type: entry.type, outcome: outcomes[id] === 'completed' ? 'completed' : 'unknown' },
      }));
    }
  }).catch(() => { /* still unknown; the entries stay marked */ });
}

/**
 * A host-relative path made absolute on the host this client is paired to.
 * WHY not always location.origin (design R2-10): the Android app's page is
 * file:// and its host lives in the stored target (`ws://host:port/ws`); a
 * phone browser has no stored target and the page's own origin IS the host.
 */
function absoluteHostUrl(hostRelative: string): string {
  if (targetUrl) {
    const u = new URL(targetUrl);
    const proto = u.protocol === 'wss:' ? 'https:' : 'http:';
    return `${proto}//${u.host}${hostRelative}`;
  }
  return `${location.origin}${hostRelative}`;
}

/** Open a link the way a "Save" would: an anchor with `download`, clicked, removed. */
function openAsDownload(url: string, name: string): void {
  const a = document.createElement('a');
  a.href = url;
  // The attribute is honoured same-origin (the phone browser); cross-origin
  // (the Android app's file:// page) the host's Content-Disposition does the
  // same job, and WebViewHost.kt routes /download/ to the download manager.
  a.setAttribute('download', name);
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  try { a.click(); } finally { a.remove(); }
}

/** Ask again for the state a fresh mount would have fetched. Reads only. */
function rehydrate(): void {
  for (const channel of REHYDRATE_ON_RECONNECT) {
    // A list the phone never asked for has nothing to re-ask.
    if ((channel === 'artifacts:list-all-files' || channel === 'artifacts:list-session') && !lastReadPayload.has(channel)) continue;
    invoke(channel, lastReadPayload.get(channel)).catch(() => { /* a reconnect is not the place to surface a read failure */ });
  }
  // Tell the page. Screens holding a per-SOCKET subscription on the host (the
  // project watcher) have to subscribe again on the new socket; the shim cannot
  // do it for them because it does not know which root they show. Only ever
  // reached on a reconnect — the caller guards on hasConnectedBefore.
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent(REMOTE_RECONNECTED_EVENT));
  }
}

// Flush queued application messages once auth:ok has resolved.
// Called ONLY from inside the auth:ok branch — never from ws.onopen, since
// the bridge rejects application traffic before auth completes.
function flushSendQueue(): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const cutoff = Date.now() - REQUEST_TIMEOUT_MS;
  const queued = pendingSendQueue.filter(item => item.at >= cutoff);
  const dropped = pendingSendQueue.length - queued.length;
  if (dropped > 0) console.warn(`[remote-shim] dropped ${dropped} queued message(s) older than the request timeout`);
  pendingSendQueue = [];
  for (const { data } of queued) {
    try { ws.send(data); } catch (e) {
      console.error('[remote-shim] flush failed:', e);
    }
  }
}

// Default 30s is fine for anything interactive, but long-running sync
// operations (rclone copy of 100s of files over cellular, git push of a large
// repo, etc.) can legitimately take minutes. Callers pass a larger timeoutMs
// for those — see `sync.force` below.
// Mirror of preload's `unwrap`: main answers {ok:false,error} and never throws
// across the bridge, but the naming UI shows its ErrorState from a caught
// error and keeps the last saved value.
async function unwrapRemote(p: Promise<any>): Promise<void> {
  const r = await p;
  if (!r || r.ok !== true) throw new Error(r?.error || 'That could not be saved.');
}

function invoke(type: string, payload?: any, opts?: { timeoutMs?: number }): Promise<any> {
  const timeoutMs = opts?.timeoutMs ?? REQUEST_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const id = `${myDeviceId || 'anon'}:${connectionGeneration}:${++messageId}`;
    const timeout = setTimeout(() => {
      const entry = pending.get(id);
      if (!entry) return;
      // WHY the entry stays: the request was SENT, so it may have run. Dropping it here is
      // what let the app tell you an action failed when it had actually succeeded and only
      // the reply was lost. It is now marked, asked about on reconnect, and never retried.
      entry.outcomeUnknown = true;
      reject(new Error(`Request ${type} timed out`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timeout, type });
    if (REHYDRATE_ON_RECONNECT.includes(type)) lastReadPayload.set(type, payload);
    send({ type, id, payload });
  });
}

// ── "Not available over remote access" reporting ──────────────────────────────
// Many window.claude channels aren't bridged to the remote WebSocket server
// yet. They now answer immediately instead of hanging for 30s, but the answer
// lands in call sites that mostly don't check it, so the user just sees an
// empty panel. Announce it in plain language instead.
//
// Names/event live in ./remote-unsupported so the UI can import them without
// dragging this whole module into the desktop bundle (see that file).

// Announce each FEATURE at most once per page load. Deduping by feature rather
// than by channel matters because some of these are called on a loop —
// useAttentionClassifier polls terminal:get-screen-text every second — and a
// toast per poll would be unusable.
const announced = new Set<string>();

/**
 * When this connection finished authenticating, and how long after that we stay quiet.
 *
 * WHY a quiet window at all: connecting a phone announced TEN of these at once, because
 * mounting the app fetches skills, commands, themes, the marketplace, project files and
 * presence before the person has looked at anything. None of it was asked for, none of it
 * was actionable, and the first thing a new phone did was list what does not work.
 *
 * This notice earns its place LATER — when someone opens a panel and it is empty, the
 * explanation is worth having. So: the boot fetches go to the console, and anything after
 * the app has settled goes on screen, because by then it followed something the user did.
 */
let connectedAt = 0;
const BOOT_QUIET_MS = 4000;

/** Called when auth completes, so the quiet window is measured from a real connection
 *  rather than from page load — a slow tailnet hop would otherwise spend it waiting. */
export function markConnectedForNotices(): void {
  connectedAt = Date.now();
}

/** Channels whose `{ ok:false, error }` answer is a FAILURE to re-throw, not a
 *  value to hand back.
 *
 *  remote-server.ts answers `{ ok:false, error }` when a handler throws. On the
 *  desktop the SAME failure arrives as a thrown Error the caller catches and
 *  shows; over the remote link, resolving it hands the caller a success — so
 *  the click does nothing, with no message, no retry and no clue. Worse for a
 *  channel whose answer gets rendered: the failure object has none of the real
 *  fields, so the component falls back to its defaults and redraws a screen the
 *  user believes is true.
 *
 *  MEMBERSHIP RULE: a channel belongs here when its SUCCESS shape is a plain
 *  object or record that can never itself be `{ ok:false }`. A channel that
 *  legitimately RETURNS `{ ok:false }` as data must stay out, or a real answer
 *  would be thrown away as an error.
 *
 *  Exported and hoisted to module scope on purpose: pinned by
 *  tests/remote-shim-reject.test.ts, because deleting an entry restores a bug
 *  no other test in the suite can see.
 *
 *  KNOWN GAP, filed rather than fixed here: `models:installed` answers the same
 *  `{ ok:false }` object and is NOT in this list, and LocalModelsSection casts
 *  its answer straight to an array and filters it. That predates this list. */
export const REJECT_ON_NOT_OK: ReadonlySet<string> = new Set([
  // Reads a phone loads at start, answered by the host since 2026-09-11. A failure there comes
  // back as { ok:false, error } and must reach the caller's catch, not land as a "list".
  'theme:list',
  'commands:list',
  'appearance:get-favorite-themes',
  // Host administration is refused over the remote socket (desktop IPC only). Without
  // these the refusal `{ ok:false }` resolves as an ordinary value, so a phone that
  // tried to change the host password saw the field's success tick for a change that never
  // happened — a false success on the one surface where it matters most.
  'remote:set-password',
  'remote:set-config',
  // Same refusal, same reason: renaming and unpairing decide who may reach this computer.
  // Left out of this set, an unpair on a phone removed the row from the list while the
  // device kept full access — the false success this list exists to prevent, on the one
  // action where believing it is most dangerous.
  'remote:devices:rename',
  'remote:devices:unpair',
  // Success is `{ sessionId }`.
  'engine:run-in-terminal',
  // Success is the engine STATUS object. Without this a failed speed-switch
  // save redraws the card from a failure object: every field missing, so both
  // speed switches read ON and the faster-engine list reads empty, and the user
  // is told nothing went wrong.
  'engine:set-config',
  // Success is the PREREQUISITES object. Without this a failed check falls into
  // the card's remaining branch, which prints a specific diagnosis of the user's
  // machine ("AMD's software comes from AMD's own repository") for a check that
  // never reached a verdict — an error message guessing a cause, which
  // docs/error-message-standards.md forbids.
  'engine:prereqs',
  // Success is a settings record / a settings record / a { downloadId }. A
  // refused save — a context length under the floor, an engine option the
  // binary does not know — has to reach the dialog's error line.
  'models:settings', 'models:set-settings', 'models:add-vision',
  'native:get-step-guard', 'native:set-step-guard',
]);

/** What a `<channel>:response` payload MEANS, as one pure decision.
 *
 *  Extracted from handleMessage so it can be tested at all: the dispatcher
 *  needs a live socket and a pending request before it will run a line, so the
 *  rule that decides whether a user sees their error or a silent success had no
 *  reachable test. Anything that stops consulting REJECT_ON_NOT_OK now fails
 *  tests/remote-shim-reject.test.ts.
 *
 *   'unsupported' — the host does not implement this channel at all.
 *   'failure'     — the host's handler threw; re-throw it to the caller.
 *   'value'       — an ordinary answer. */
export function responseOutcome(channel: string, payload: unknown): 'unsupported' | 'failure' | 'value' {
  if (!payload || typeof payload !== 'object') return 'value';
  if ((payload as { unsupported?: unknown }).unsupported === true) return 'unsupported';
  if ((payload as { ok?: unknown }).ok === false && REJECT_ON_NOT_OK.has(channel)) return 'failure';
  return 'value';
}

function noteUnsupported(channel: string): void {
  // WHY an unnamed channel says nothing at all: the fallback name IS the channel id, and a
  // toast reading "terminal:get-screen-text isn't available via remote access yet." tells a
  // non-developer nothing they can act on — it only says something is broken. The console
  // warning below still names it for whoever is fixing it.
  if (!hasFeatureName(channel)) {
    console.warn(`[remote-shim] not available over remote access (unnamed): ${channel}`);
    return;
  }
  const feature = remoteFeatureName(channel);
  if (announced.has(feature)) return;
  announced.add(feature);
  // WHY the host matters: the phone's own bridge answers `unsupported` too
  // (since 2026-09-10, for any channel it has no handler for), and a phone
  // doing no remote access must not be told "via remote access".
  const host = isAndroidLocal() ? 'phone' : 'remote';
  console.warn(`[remote-shim] not available on this host (${host}): ${channel}`);
  // The app's own boot fetches are not something the person did. Recorded, not announced.
  if (connectedAt === 0 || Date.now() - connectedAt < BOOT_QUIET_MS) return;
  window.dispatchEvent(new CustomEvent(REMOTE_UNSUPPORTED_EVENT, {
    detail: { channel, feature, message: remoteUnsupportedMessage(channel, host) },
  }));
}

/** A rejection shaped exactly like the host's `unsupported` refusal, minus the
 *  notice. WHY: a few channels are asked for AUTOMATICALLY — on launch, on
 *  opening Settings — and the phone's bridge cannot answer them until the
 *  rebuild. Every caller already handles the rejection; what none of them
 *  wants is a toast about it on an ordinary screen. Until 2026-09-10 the
 *  bridge answered these with a bare `{error}` object that RESOLVED, which
 *  crashed Project View (a status object with no `spaces`) and threw inside
 *  the chat reducer on every launch. */
function refuseQuietlyOnPhone(channel: string): Promise<never> {
  return Promise.reject(new Error(`remote-unsupported: ${channel}`));
}

/** Settle one pending request from the host's answer. THE only place a
 *  response resolves or rejects a caller's promise.
 *
 *  WHY this is exported and takes the entry, rather than the rule alone being
 *  extracted: a test over the RULE proves what the rule says, not what the
 *  dispatcher does with it. Both of these left the whole suite green while the
 *  original bug was fully restored — resolving in the `failure` arm, and
 *  resolving before the switch and leaving it dead. Settling here, and nowhere
 *  else in the response path, is what a test can actually hold. */
export function applyResponse(
  entry: { resolve: (value: unknown) => void; reject: (err: Error) => void },
  channel: string,
  payload: unknown,
): void {
  switch (responseOutcome(channel, payload)) {
    case 'unsupported':
      noteUnsupported(channel);
      entry.reject(new Error(`remote-unsupported: ${channel}`));
      return;
    // A handler that answered `{ ok:false, error }` is a FAILURE — resolving it
    // hands the caller a failure dressed as a success. See REJECT_ON_NOT_OK.
    case 'failure':
      entry.reject(new Error(String((payload as { error?: unknown })?.error ?? 'The request failed.')));
      return;
    default:
      entry.resolve(payload);
      return;
  }
}

/** Returns false when the action was refused because the connection is down, so the caller
 *  can keep what the person typed instead of clearing it. */
function fire(type: string, payload: any): boolean {
  return send({ type, payload });
}

function addListener(channel: string, cb: Callback): Callback {
  let set = listeners.get(channel);
  if (!set) {
    set = new Set();
    listeners.set(channel, set);
  }
  set.add(cb);
  // The hydrate handler is the last thing App mounts before it can apply a restore.
  if (channel === 'chat:hydrate') maybeSendClientReady();
  // The terminal's first listener takes everything that arrived before it existed.
  if (channel.startsWith('pty:output:') && set.size === 1) drainPtyBacklog(channel.slice('pty:output:'.length));
  return cb;
}

function removeListener(channel: string, handler: Callback): void {
  const set = listeners.get(channel);
  if (set) {
    set.delete(handler);
    if (set.size === 0) listeners.delete(channel);
  }
}

function removeAllListeners(channel: string): void {
  listeners.delete(channel);
}

function dispatchEvent(type: string, ...args: any[]): void {
  const set = listeners.get(type);
  if (set) {
    for (const cb of set) {
      try { cb(...args); } catch (e) { console.error(`[remote-shim] listener error on ${type}:`, e); }
    }
  }
}

function handleMessage(data: string, generation: number): void {
  // WHY the stamp: the stale-socket guard used to cover auth:ok only. A late frame from a
  // socket the connect timeout abandoned — or one replaced by a reconnect — was still
  // dispatched into the page as if it came from the current host connection (R2-17).
  if (generation !== connectionGeneration) return;
  framesReceived++;
  let msg: any;
  try { msg = JSON.parse(data); } catch { return; }

  const { type, id, payload } = msg;

  // Auth responses are handled separately
  if (type === 'auth:ok' || type === 'auth:failed') return;

  // Response to a pending request
  if (type?.endsWith(':response') && id && pending.has(id)) {
    const entry = pending.get(id)!;
    clearTimeout(entry.timeout);
    pending.delete(id);
    // The host answered "I don't implement this channel" (remote-server's
    // default case). Surface it — otherwise the caller, which mostly doesn't
    // check, renders an empty panel with no explanation.
    //
    // REJECT, don't resolve. The original version resolved "so nothing
    // crashes", which was exactly backwards: callers expect the channel's real
    // return SHAPE, so handing them {ok:false,unsupported:true} substitutes an
    // object where an array belongs. marketplace-context does
    //   theme.marketplace.list().catch(() => [])   → object survives the ||
    // and the next `for (const theme of themeEntries)` threw "undefined is not
    // a function" on a phone, taking out the whole screen.
    //
    // Rejecting restores the contract every caller was already written
    // against: before the default case existed these channels were dropped and
    // invoke() rejected on its 30s timeout, which is why `.catch(() => [])` is
    // everywhere. Now they reject in milliseconds instead of 30 seconds — the
    // fast-fail we wanted, without changing the type callers receive.
    //
    // noteUnsupported still fires first, so the explanatory toast is unaffected.
    // The ONLY place a response settles a caller's promise — see applyResponse.
    applyResponse(entry, String(type).replace(/:response$/, ''), payload);
    return;
  }

  // Push events — dispatch to registered listeners
  switch (type) {
    case 'pty:output': {
      const sid: string = payload.sessionId;
      // A frame from a different stream than the one this terminal drew — the host
      // restarted, or the session was recreated — with no restore pass to say so: clear
      // the terminal first instead of appending the new stream to the old screen
      // (T2 review, 12).
      const drawn = ptyOffsets.get(sid);
      if (drawn && typeof payload.epoch === 'string' && drawn.epoch !== payload.epoch) {
        if (listeners.get(`pty:output:${sid}`)?.size) dispatchEvent(`pty:reset:${sid}`);
        else backlogPty(sid, { kind: 'reset' });
      }
      if (typeof payload.epoch === 'string' && typeof payload.offset === 'number') {
        ptyOffsets.set(sid, { epoch: payload.epoch, units: payload.offset + String(payload.data ?? '').length });
      }
      dispatchEvent('pty:output', sid, payload.data);                            // global (App.tsx mode detection)
      if (listeners.get(`pty:output:${sid}`)?.size) dispatchEvent(`pty:output:${sid}`, payload.data);   // per-session (TerminalView)
      else backlogPty(sid, { kind: 'output', data: String(payload.data ?? '') });
      break;
    }
    case 'pty:reset': {
      // The host cannot continue this terminal from where we were: clear it, then the
      // full buffer follows on the same ordered channel (and the same backlog).
      const sid: string = payload.sessionId;
      if (typeof payload.epoch === 'string') ptyOffsets.set(sid, { epoch: payload.epoch, units: 0 });
      if (listeners.get(`pty:output:${sid}`)?.size) dispatchEvent(`pty:reset:${sid}`);
      else backlogPty(sid, { kind: 'reset' });
      break;
    }
    case 'hook:replay-complete':
      dispatchEvent('hook:replay-complete', payload);
      break;
    case 'pty:raw-bytes':
      // Per-session dispatch only — no global consumer (xterm is per-session).
      // Payload data is base64-encoded raw PTY bytes from Android's
      // RawByteListener (Tier 1). usePtyRawBytes decodes to Uint8Array.
      dispatchEvent(`pty:raw-bytes:${payload.sessionId}`, payload.data);
      break;
    case 'hook:event':
      // T2 review (1): for a NATIVE ask the host announces a resolution BEFORE it replies
      // to the answer that caused it, so the answering phone would hear "resolved" first
      // and mark its own answer "Answered on the computer". An answer this shim has in
      // flight is ours — hide that one resolution; every other device still gets it. (A
      // Claude Code ask replies first — the relay announces on a microtask — and the card
      // is already answered when the resolution lands, so the reducer ignores it.)
      if (payload?.type === 'PermissionResolved' && answersInFlight.has(payload?.payload?._requestId)) break;
      dispatchEvent('hook:event', payload);
      break;
    case 'session:created':
      dispatchEvent('session:created', payload);
      break;
    case 'session:destroyed':
      forgetPtySession(payload?.sessionId || payload);
      // Forward exitCode alongside id so the chat reducer can surface
      // 'session-died' when a turn was in flight. Default 0 for older bridges.
      dispatchEvent(
        'session:destroyed',
        payload.sessionId || payload,
        typeof payload?.exitCode === 'number' ? payload.exitCode : 0,
        // Batch 2 (§3): what the desktop is showing, so a phone whose conversation went
        // away can open it. Null from a host that does not send it.
        typeof payload?.focus?.sessionId === 'string' ? payload.focus.sessionId : null,
      );
      break;
    case 'session:renamed':
      dispatchEvent('session:renamed', payload.sessionId, payload.name);
      break;
    case 'session:moved':
      // Plan 2b — another device took over this session's lease. Forward the
      // whole payload ({ sessionId, device?, claudeSessionId?, projectSlug?,
      // projectPath? }) so App.tsx's MovedGate can show it and offer Resume
      // (parity with preload's enriched sessionMoved).
      dispatchEvent('session:moved', payload);
      break;
    case 'session:meta-changed':
      // Forward note too — set-note broadcasts {sessionId, note} (no flag), and
      // narrowing to {flag, value} silently dropped it. Preload forwards the
      // raw payload; this now matches.
      dispatchEvent('session:meta-changed', payload.sessionId, { flag: payload.flag, value: payload.value, note: payload.note });
      break;
    case 'tags:changed':
      dispatchEvent('tags:changed', undefined, payload || {});
      break;
    case 'session:permission-mode':
      // Android-only: corrects React's optimistic Shift+Tab cycling state.
      // Desktop uses pty:output text detection in App.tsx, but Android doesn't
      // forward raw PTY bytes to the renderer (terminal is rendered natively).
      dispatchEvent('session:permission-mode', payload.sessionId, payload.mode);
      break;
    case 'status:data':
      dispatchEvent('status:data', payload);
      break;
    case 'ui:action':
      dispatchEvent('ui:action:received', payload);
      break;
    case 'transcript:event':
      dispatchEvent('transcript:event', payload);
      break;
    case 'transcript:shrink':
      dispatchEvent('transcript:shrink', payload);
      break;
    case 'prompt:show':
      dispatchEvent('prompt:show', payload);
      break;
    case 'prompt:dismiss':
      dispatchEvent('prompt:dismiss', payload);
      break;
    case 'prompt:complete':
      dispatchEvent('prompt:complete', payload);
      break;
    case 'syncspaces:event':
      // Cross-device sync-space engine events (synced/conflict/oversize/error)
      // flow to any listener registered via window.claude.syncSpaces.onEvent().
      // Broadcast (no sessionId).
      dispatchEvent('syncspaces:event', payload);
      break;
    case 'github:connect-done':
      // Connect-GitHub device flow settled on the host. Payload is
      // {ok, login?, error?} — the token NEVER travels over the WS. Flows to
      // window.claude.github.onConnectDone(). Broadcast (no sessionId).
      dispatchEvent('github:connect-done', payload);
      break;
    case 'chat:hydrate':
      // Only the hydrate this client last asked for (see clientReadySeq). A host from
      // before the handshake sends none — apply that as it always was.
      if (payload?.seq !== undefined && payload.seq !== clientReadySeq) {
        console.warn('[remote-shim] ignoring stale chat:hydrate seq', payload.seq, 'latest', clientReadySeq);
        return;
      }
      // Remembered BEFORE the page applies it: App's handler reports synchronously.
      lastHydrate = { seq: payload?.seq, degraded: payload?.degraded === true };
      // Full chat state snapshot sent by the host when a remote client connects.
      // Dispatched into the chat reducer via window.claude.on.chatHydrate in App.tsx.
      dispatchEvent('chat:hydrate', payload);
      break;
    case 'appearance:sync':
      dispatchEvent('appearance:sync', payload);
      break;
    case 'theme:reload':
      // Fix: without this case, Android theme installs never refreshed the
      // appearance picker. SessionService broadcasts {type:'theme:reload',
      // payload:{slug}} after install + on file-watcher events; we unwrap
      // slug to match theme-context's onReload(slug) signature.
      dispatchEvent('theme:reload', payload?.slug);
      break;
    case 'dev:install-progress':
      // WHY: dev.onInstallProgress subscribers listen on this channel.
      // The server emits one line at a time (string payload) while cloning
      // the workspace. We forward the raw payload so the cb receives a string.
      dispatchEvent('dev:install-progress', payload);
      break;
    case 'engine:install-progress':
      dispatchEvent('engine:install-progress', payload);
      break;
    case 'engine:status-changed':
      dispatchEvent('engine:status-changed', payload);
      break;
    case 'models:download-progress':
      // WHY: models.onDownloadProgress subscribers listen on this channel.
      dispatchEvent('models:download-progress', payload);
      break;
    case 'engine:models-changed':
      // WHY: engine.onModelsChanged subscribers listen on this channel.
      dispatchEvent('engine:models-changed', payload);
      break;
    case 'native:model-state':
      // WHY: native.onModelState subscribers (ChatView banner) listen here.
      dispatchEvent('native:model-state', payload);
      break;
    case 'system:back':
      // Android hardware back press → routed to useDismissTop via the
      // window.claude.system.onBack subscriber registered in App.tsx. No
      // payload is used — the event itself is the signal.
      dispatchEvent('system:back', payload);
      break;
    case 'artifacts:changed':
      // Artifact viewer update event — dispatched when artifacts are added,
      // modified, or excluded. The payload contains change metadata.
      dispatchEvent('artifacts:changed', payload);
      break;
    case 'git:changed':
      dispatchEvent('git:changed', payload);
      break;
    case 'specialists:event':
      // Task 8 — push-only (see ipc-handlers.ts's nativeHost.on('specialists-
      // event', ...) forwarder). window.claude.on.specialistEvent subscribers
      // receive the SpecialistsEvent payload verbatim.
      dispatchEvent('specialists:event', payload);
      break;
    case 'native:shell-event':
      // G-1 — push-only (ipc-handlers.ts's nativeHost.on('shell-event', …)
      // forwarder). window.claude.on.shellEvent subscribers get the ShellEvent.
      dispatchEvent('native:shell-event', payload);
      break;
    case 'native:session-context':
      // "What the assistant was given" — push-only (ipc-handlers.ts's
      // nativeHost.on('session-context', …) forwarder). A client that connects
      // LATER does not need this case: the record travels inside chat:hydrate.
      dispatchEvent('native:session-context', payload);
      break;
    case 'voice:event':
      // Voice typing push events from the ANDROID host (readiness / level /
      // partial words / final / heartbeat / error). window.claude.voice.onEvent
      // subscribers get the payload verbatim. Broadcast — no sessionId, because
      // there is one microphone on the device, not one per conversation.
      dispatchEvent('voice:event', payload);
      break;
    case 'social:presence-event':
      // Presence relay (Task 6). The host forwards one presence event (server
      // protocol frame or synthetic connection-state event). window.claude.social
      // .onPresenceEvent subscribers registered via addListener receive the
      // payload object verbatim; the renderer (Task 7) interprets it.
      dispatchEvent('social:presence-event', payload);
      break;
  }
}

export function connect(passwordOrToken: string, isToken = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const generation = ++connectionGeneration;
    // One socket at a time. WHY retire the previous one (review of the 2026-09-11 fixes, finding
    // 2): an attempt left running — "Enter password instead" while offline, or the Android app
    // going back to its own runtime — kept its handlers, and they wrote through the shared `ws`.
    // Its late open set "authenticating" over a working connection and sent a second sign-in on
    // it; its late close set "disconnected". Every handler below is bound to its own socket.
    if (ws) retireSocket(ws);
    setConnectionState('connecting');
    const socket = new WebSocket(getWsUrl());
    ws = socket;
    const isCurrent = () => generation === connectionGeneration && ws === socket;
    // Decided now, not when the close arrives: by then the Android app may already have gone back
    // to its own runtime, which changes the answer (finding 1).
    const localBridge = location.protocol === 'file:' && !targetUrl;

    // Track whether the socket ever got to OPEN. Lets onclose tell the difference
    // between "couldn't reach host" (TCP refused, Android cleartext block,
    // firewall) and "reached server but it closed without a proper auth reply"
    // (rate limit 4029, server auth timeout 4000) — the previous generic
    // "Connection closed before auth" error hid both cases.
    let didOpen = false;

    // Timeout if WebSocket stays in CONNECTING state (network unreachable, etc.)
    const connectTimeout = setTimeout(() => {
      if (isCurrent() && socket.readyState === WebSocket.CONNECTING) {
        console.error('[remote-shim] connect timeout to', getWsUrl());
        // Retired, not only closed: its close event must not run the close handler below as well.
        retireSocket(socket);
        ws = null;
        setConnectionState('disconnected');
        reject(signInError('Connection timed out', { kind: 'unreachable' }));
      }
    }, 15_000);

    socket.onopen = () => {
      if (!isCurrent()) return;
      didOpen = true;
      clearTimeout(connectTimeout);
      setConnectionState('authenticating');
      // Security: when connecting to the local Android bridge (file:// protocol),
      // use the auth token passed via URL query param by WebViewHost.
      // The token is in the URL so it's available before any JS runs (no race).
      const bridgeToken = new URLSearchParams(location.search).get('bridgeToken');
      const isLocalBridge = location.protocol === 'file:' && !targetUrl;
      const authMsg = isLocalBridge && bridgeToken
        ? { type: 'auth', token: bridgeToken }
        : isToken
          ? { type: 'auth', ...splitCredential(passwordOrToken), readyHandshake: true }
          : { type: 'auth', password: passwordOrToken, deviceName: describeThisDevice(), readyHandshake: true };
      socket.send(JSON.stringify(authMsg));
    };

    let authResolved = false;
    // The computer answered auth:failed on THIS socket. Its close must not start a reconnect:
    // the same credential gets the same answer, and a loop of refusals is what trips the host's
    // slowdown for every other device.
    let refused = false;

    socket.onmessage = (event) => {
      if (!authResolved) {
        let msg: any;
        try { msg = JSON.parse(event.data); } catch { return; }

        if (msg.type === 'auth:ok') {
          // WHY the guard: without it a late auth:ok from a socket we already replaced
          // rebinds the CURRENT connection's handlers to the dead one.
          if (!isCurrent()) return;
          myDeviceId = msg.deviceId ?? myDeviceId;
          authResolved = true;
          reconnectDelay = 1000; // Reset backoff on success
          reconnectAttempts = 0;
          // Signed in: the sign-in screen is gone, and a later drop is the strip's to report.
          savedKeyListener = null;
          savedKeyStopped = false;
          console.log('[remote-shim] auth:ok from', getWsUrl());
          setConnectionState('connected');
          markConnectedForNotices();
          // WHY remote mode is declared HERE and not only in connectToHost: that function is
          // the ANDROID pairing path, and it was the only thing that ever set 'remote'. A
          // plain phone BROWSER opening the host's address goes through connect() instead,
          // so isRemoteMode() stayed false on the one surface the flag exists to describe.
          //
          // Everything keyed on it was therefore inert there: the attention classifier kept
          // polling the host for terminal text (which is what still put a channel id on
          // Destin's screen after I had "fixed" it), the theme kept trying to load a
          // wallpaper that only exists on the host, and Unpair stayed enabled on a phone.
          //
          // The test is the local bridge, not the platform string: an Android WebView on
          // file:// talks to a runtime on the same device and is genuinely local, while the
          // server tells every client `platform: 'desktop'`, so getPlatform() cannot answer
          // this. connectToHost still declares it explicitly for the Android-paired case,
          // which IS file:// and IS remote.
          if (!isAndroidLocal()) {
            void import('./platform').then(({ setConnectionMode }) => setConnectionMode('remote'));
          }

          // Fix: drain any messages queued during the cold-start window
          // (mount-time fetches that fired before auth completed). Must be
          // here, not in ws.onopen — the bridge rejects pre-auth traffic.
          flushSendQueue();
          if (hasConnectedBefore) rehydrate();
          // Readiness (batch 2): a new connection generation may send client:ready once.
          // On a reconnect App's listener is still registered, so it goes out right here;
          // on a first connect App mounts after this, and addListener sends it.
          readySentThisGeneration = false;
          // Batch 2 (§6): until the hydrate this connection asks for is applied.
          setConversationPhase('restoring');
          readyReconnect = hasConnectedBefore && lastReadyHost === getWsUrl();
          // Terminal positions are the OLD host's stream positions — meaningless to a
          // different host, which would only answer them with a reset anyway.
          if (!readyReconnect) { ptyOffsets.clear(); ptyBacklog.clear(); }
          lastReadyHost = getWsUrl();
          maybeSendClientReady();
          hasConnectedBefore = true;
          reconcileUnknownOutcomes();
          // The secret comes back exactly once, at pairing; later connections answer with
          // the device id alone, so keep what is already stored.
          const token = msg.secret
            ? `${msg.deviceId}:${msg.secret}`
            : (localStorage.getItem('youcoded-remote-token') ?? msg.deviceId ?? '');
          if (token) localStorage.setItem('youcoded-remote-token', token);
          // Preserve __PLATFORM__ when connecting to a remote desktop from Android —
          // the desktop server responds with platform:"electron" but we're still on a phone
          if (!preservePlatform) {
            const platform = msg.platform || 'browser';
            (window as any).__PLATFORM__ = platform;
          }
          // Naming capability, straight off the handshake — no extra round
          // trip, and settled before the first paint that could show a naming
          // control. Absent on a host that has no naming backend (an Android
          // phone running Claude Code locally), which leaves every naming
          // control hidden rather than broken.
          const naming = (window as any).claude?.sessionNaming;
          if (naming) naming.available = msg.sessionNaming === true;
          resolve(token);
          // Switch to normal message handling
          socket.onmessage = (e) => handleMessage(e.data as string, generation);
        } else if (msg.type === 'auth:failed') {
          if (!isCurrent()) return;
          authResolved = true;
          refused = true;
          const reason = String(msg.reason || 'refused');
          console.error('[remote-shim] auth:failed', reason);
          // Forget the saved key only when the computer will never take it, and only when it was
          // the key that was tried: a mistyped password says nothing about the saved one.
          if (isToken && KEY_IS_DEAD.has(reason)) localStorage.removeItem('youcoded-remote-token');
          setConnectionState('disconnected');
          reject(signInError(msg.reason || 'Authentication failed', { kind: 'refused', reason }));
          socket.close();
        }
        return;
      }

      handleMessage(event.data as string, generation);
    };

    socket.onclose = (event) => {
      clearTimeout(connectTimeout);
      // A socket that is no longer the current one (disconnect() closed it, or a newer attempt
      // replaced it) must not change the state of the one that is.
      if (!isCurrent()) return;
      if (!authResolved) {
        const url = getWsUrl();
        const code = event.code;
        const reason = event.reason;
        console.error('[remote-shim] ws closed before auth', { url, code, reason, didOpen });
        setConnectionState('disconnected');
        // Translate WS close scenarios into messages the paired-device UI can
        // actually act on. didOpen=false almost always means the socket never
        // completed the TCP/HTTP-upgrade handshake — on Android that's usually
        // the cleartext-traffic policy or a wrong host/port/firewall.
        let message: string;
        if (!didOpen) {
          message = `Cannot reach host at ${url}. Check the host, port, and network (VPN/firewall).`;
        } else if (code === 4029) {
          message = 'Too many failed attempts. Wait a minute and try again.';
        } else if (code === 4000) {
          message = reason || 'Server closed the connection during auth.';
        } else {
          message = `Connection closed before auth (code ${code}${reason ? `: ${reason}` : ''}).`;
        }
        reject(signInError(message, { kind: didOpen ? 'closed' : 'unreachable' }));
        return;
      }

      // The Android app's own bridge keeps its old retry: its token comes from the page address,
      // and a refusal there during start-up is not an answer about a saved key.
      if (refused && !localBridge) {
        setConnectionState('disconnected');
        return;
      }

      if (isTerminalClose(event.code)) suppressReconnectingPhase = true;
      setConnectionState('disconnected');
      suppressReconnectingPhase = false;
      // Attempt reconnection — local bridge uses its own retry (token comes
      // from the URL each time), remote connections use stored session tokens.
      if (localBridge) {
        retryLocalBridge();
      } else if (isTerminalClose(event.code)) {
        // Unpaired or retired: the credential can never work again. Forget it so the next
        // attempt asks for the password once, rather than retrying forever.
        localStorage.removeItem('youcoded-remote-token');
        console.warn('[remote-shim] host refused this device permanently:', event.code, event.reason);
        noteRefusedAfterConnecting(event.code === 4003 ? 'revoked' : event.code === 4004 ? 'retired' : 'unsupported-version');
      } else {
        const storedToken = localStorage.getItem('youcoded-remote-token');
        if (storedToken) {
          scheduleReconnect(storedToken);
        }
      }
    };

    socket.onerror = () => {
      // onclose will fire after this
    };
  });
}

/**
 * A close code the host uses to say "do not come back with this credential": unpaired,
 * retired, or a version it cannot serve. Retrying any of these is guaranteed to fail, and
 * on upgrade day every device retrying at once is what would trip the host's own limiter.
 */
function isTerminalClose(code: number): boolean {
  return code === 4003 || code === 4004 || code === 4005;
}

function scheduleReconnect(token: string): void {
  // WHY only a real local bridge falls back: this path deleted the saved address and
  // credential and connected to 'android-local', which does not exist in a browser. A phone
  // that lost signal in a lift came back unpaired.
  const hasLocalBridge = location.protocol === 'file:';
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS && !hasLocalBridge) {
    // Keep retrying, slowly, and keep the pairing. Disconnected is a state to show, not a
    // reason to forget who you are.
    reconnectDelay = Math.min(reconnectDelay * 2, 60_000);
    reconnectAttempts = MAX_RECONNECT_ATTEMPTS;
  }
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS && hasLocalBridge) {
    // Reconnect-fallback: switching to local bridge means any messages
    // queued for the prior remote host are wrong-destination. Drop them
    // here — disconnect() isn't on this path (ws.onclose only schedules
    // the retry, doesn't disconnect).
    if (pendingSendQueue.length > 0) {
      console.warn('[remote-shim] discarding', pendingSendQueue.length,
        'queued messages on reconnect fallback to local bridge');
      pendingSendQueue = [];
    }
    reconnectAttempts = 0;
    reconnectDelay = 1000;
    targetUrl = null;
    localStorage.removeItem('youcoded-remote-target');
    localStorage.removeItem('youcoded-remote-token');
    // Reconnect to local bridge
    forgetConversationPhase();
    connect('android-local', false).catch(() => {});
    import('./platform').then(({ setConnectionMode }) => setConnectionMode('local'));
    return;
  }

  if (reconnectTimer) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    reconnectAttempts++;
    try {
      await connect(token, true);
    } catch (err) {
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
      onSavedKeyAttemptFailed(err, token);
    }
  }, reconnectDelay);
}

/** One attempt with the saved key failed: tell the sign-in screen, then try again, unless the
 *  computer refused the key or the person chose to type the password instead. */
function onSavedKeyAttemptFailed(err: unknown, token: string): void {
  const failure = signInFailureOf(err);
  if (failure?.kind === 'refused') {
    savedKeyListener?.({ type: 'refused', reason: failure.reason });
    if (hasConnectedBefore) noteRefusedAfterConnecting(failure.reason);
    if (location.protocol === 'file:' && targetUrl) {
      // The Android app paired to a computer that will never take its key goes back to its own
      // runtime now, which is where MAX_RECONNECT_ATTEMPTS used to land it after minutes. Any
      // other refusal (remote access switched off on the computer) keeps the pairing and keeps
      // trying slowly, as it always did: deleting it would unpair the phone (finding 1).
      if (KEY_IS_DEAD.has(failure.reason)) reconnectAttempts = MAX_RECONNECT_ATTEMPTS;
      scheduleReconnect(token);
    }
    return;
  }
  savedKeyListener?.({ type: 'failed', kind: failure?.kind ?? 'closed' });
  if (savedKeyStopped) return;
  scheduleReconnect(token);
}

/**
 * Sign in with the key this browser saved at pairing, when the page loads. Returns false when
 * there is none, so the page asks for the password.
 *
 * WHY here and not in the page (it was `connect(token).catch(() => removeItem(key))` in
 * index.tsx): that deleted the key on ANY failure and never tried again, so a phone whose
 * browser reloaded the tab before its network came back had to type the password.
 */
export function startSavedKeySignIn(listener: (e: SavedKeySignInEvent) => void): boolean {
  const token = localStorage.getItem('youcoded-remote-token');
  if (!token) return false;
  savedKeyListener = listener;
  savedKeyStopped = false;
  connect(token, true).catch((err) => onSavedKeyAttemptFailed(err, token));
  return true;
}

/** "Try now": attempt at once instead of waiting out the backoff. */
export function retrySavedKeyNow(): void {
  const token = localStorage.getItem('youcoded-remote-token');
  if (!token || connectionState === 'connecting' || connectionState === 'authenticating') return;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  savedKeyStopped = false;
  connect(token, true).catch((err) => onSavedKeyAttemptFailed(err, token));
}

/** "Enter password instead": no more automatic attempts. The key stays; a page reload tries it. */
export function stopSavedKeySignIn(): void {
  savedKeyStopped = true;
  savedKeyListener = null;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
}

/** How long the wake check waits, with nothing at all arriving, before calling the connection
 *  dead. 10 s, not 5: right after waking a phone's radio and tunnel can take several seconds to
 *  come back, and a reply can queue behind a catch-up already on its way (review finding 3). */
const WAKE_CHECK_TIMEOUT_MS = 10_000;
let wakeCheckInFlight = false;

/**
 * The phone just woke, came back to this tab, or regained its network: make sure the connection
 * is real before the screens it is about to open ask it for anything.
 *
 * WHY (Destin, 2026-09-11: the project list was empty, then "randomly popped back in"): after
 * sleep a phone can hold a socket the computer already closed, which only times out much later,
 * or sit out a reconnect backoff of up to 30 s. Every request made meanwhile timed out after
 * 30 s, and the screens that asked stayed empty. Down: reconnect now. Up: one quick question,
 * and a connection that cannot answer it is replaced at once rather than waited on.
 */
export function checkConnectionAfterWake(): void {
  // The Android app's own bridge is on the same device; the first sign-in has its own screen.
  if (isAndroidLocal()) return;
  if (!hasConnectedBefore) {
    // Still on the sign-in screen, trying the saved key: the network coming back is the moment to
    // try again, not the end of a backoff of up to a minute (finding 6).
    if (savedKeyListener && !savedKeyStopped && connectionState === 'disconnected') retrySavedKeyNow();
    return;
  }
  if (connectionState === 'connecting' || connectionState === 'authenticating') return;
  const token = localStorage.getItem('youcoded-remote-token');
  if (connectionState === 'disconnected') {
    if (token && !savedKeyStopped) reconnectNow(token);
    return;
  }
  const socket = ws;
  if (!socket || wakeCheckInFlight) return;
  wakeCheckInFlight = true;
  const generation = connectionGeneration;
  const framesAtSend = framesReceived;
  const id = `${myDeviceId || 'anon'}:${generation}:${++messageId}`;
  const settle = () => { clearTimeout(timeout); pending.delete(id); wakeCheckInFlight = false; };
  const timeout = setTimeout(() => {
    settle();
    if (generation !== connectionGeneration || ws !== socket || connectionState !== 'connected') return;
    if (framesReceived > framesAtSend) return;   // the computer is talking: the connection is alive
    console.warn('[remote-shim] no answer after waking; replacing the connection');
    abandonSocket(socket);
    if (token) reconnectNow(token);
  }, WAKE_CHECK_TIMEOUT_MS);
  // Any answer proves the socket is alive, including an older computer's "unsupported" — so
  // both outcomes settle the same way. Not invoke(): a check that timed out must not be kept
  // and asked about after the reconnect like a request the person made.
  pending.set(id, { resolve: settle, reject: settle, timeout, type: 'remote:ping' });
  try {
    socket.send(JSON.stringify({ type: 'remote:ping', id }));
  } catch {
    settle();
    abandonSocket(socket);
    if (token) reconnectNow(token);
  }
}

/** Stop listening to a socket that is dead or about to be, and report the drop. Its handlers go
 *  first: a closing handshake on a dead connection can take far longer than the check did, and
 *  a late frame or close from it must not reach the page or the connection that replaces it. */
function abandonSocket(socket: WebSocket): void {
  retireSocket(socket);
  if (ws === socket) ws = null;
  setConnectionState('disconnected');
}

/** Detach a socket's handlers and close it, so nothing it does afterwards reaches the page. */
function retireSocket(socket: WebSocket): void {
  socket.onopen = null;
  socket.onmessage = null;
  socket.onclose = null;
  socket.onerror = null;
  try { socket.close(); } catch { /* already gone */ }
}

/** Connect with the saved key now, dropping any backoff: the conditions that made it grow changed. */
function reconnectNow(token: string): void {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  reconnectDelay = 1000;
  reconnectAttempts = 0;
  connect(token, true).catch((err) => onSavedKeyAttemptFailed(err, token));
}

/**
 * Retry connecting to the local Android bridge server with exponential backoff.
 * Unlike scheduleReconnect (which uses stored tokens for remote servers), this
 * retries the local bridge auth flow — the bridge token comes from the URL each
 * time. Needed because the bridge server may not be listening yet when the
 * WebView first loads (race between onCreate and WebView render).
 */
const MAX_LOCAL_RETRIES = 5;
let localRetryCount = 0;
let localRetryTimer: ReturnType<typeof setTimeout> | null = null;

export function retryLocalBridge(): void {
  if (localRetryTimer) return;
  if (localRetryCount >= MAX_LOCAL_RETRIES) {
    console.error('[remote-shim] local bridge retry limit reached');
    localRetryCount = 0;
    return;
  }

  // Backoff: 500ms, 1s, 2s, 4s, 8s
  const delay = 500 * Math.pow(2, localRetryCount);
  localRetryTimer = setTimeout(async () => {
    localRetryTimer = null;
    localRetryCount++;
    try {
      await connect('android-local', false);
      localRetryCount = 0; // Reset on success
    } catch {
      retryLocalBridge(); // Schedule next attempt
    }
  }, delay);
}

function disconnect(): void {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  // A new generation, so a frame still buffered from the socket being closed is dropped by
  // handleMessage's stamp instead of landing in the page between here and the next connect.
  connectionGeneration++;
  suppressReconnectingPhase = true;
  if (ws) { ws.close(); ws = null; }
  setConnectionState('disconnected');
  suppressReconnectingPhase = false;
  forgetConversationPhase();
  localStorage.removeItem('youcoded-remote-token');
  // Drop any pre-auth queued messages on every disconnect() path. Covered
  // paths: explicit disconnect() calls, connectToHost (calls disconnect
  // first), and disconnectFromHost. In all cases the queue would otherwise
  // leak across hosts and flush to the wrong server on the next auth:ok.
  // Brief reconnect to the SAME host also loses the queue, but caller-side
  // invoke() 30s timeout still surfaces a clean error, and renderer
  // mount-time fetches re-issue idempotently on retry.
  // (MAX_RECONNECT_ATTEMPTS fallback in scheduleReconnect AND the
  //  catch block in connectToHost both clear the queue inline.)
  if (pendingSendQueue.length > 0) {
    console.warn('[remote-shim] discarding', pendingSendQueue.length,
      'queued messages on disconnect');
    pendingSendQueue = [];
  }
}

/**
 * Check if a host IP is in the Tailscale CGNAT range (100.64.0.0/10)
 * and verify Tailscale VPN is connected before attempting connection.
 */
async function checkTailscaleIfNeeded(host: string): Promise<void> {
  const match = host.match(/^100\.(\d+)\./);
  if (!match) return;
  const secondOctet = parseInt(match[1]);
  if (secondOctet < 64 || secondOctet > 127) return;

  try {
    const status = await invoke('remote:detect-tailscale');
    if (!status?.connected) {
      throw new Error('Tailscale VPN is not connected. Turn on Tailscale and try again.');
    }
  } catch (err: any) {
    // Re-throw Tailscale-specific errors; swallow others (e.g. bridge timeout)
    if (err.message?.includes('Tailscale')) throw err;
  }
}

/**
 * Connect to a remote desktop server. Disconnects from the current server first.
 * __PLATFORM__ is preserved as 'android' so touch adaptations stay active.
 */
export async function connectToHost(host: string, port: number, password: string): Promise<void> {
  // Pre-flight: check Tailscale before disconnecting from local bridge
  // (invoke needs the current WebSocket connection)
  await checkTailscaleIfNeeded(host);

  const { setConnectionMode } = await import('./platform');

  // Disconnect from current server (local bridge or previous remote)
  disconnect();

  // Reject any pending requests from the old server
  for (const entry of pending.values()) {
    clearTimeout(entry.timeout);
    entry.reject(new Error('Server switched'));
  }
  pending.clear();
  // Note: pre-auth send queue was already cleared inside disconnect() above.

  // Point at the desktop server (defer localStorage until auth succeeds)
  targetUrl = `ws://${host}:${port}/ws`;
  preservePlatform = true;

  try {
    await connect(password, false);
    // Connection succeeded — persist remote target for session restore
    localStorage.setItem('youcoded-remote-target', targetUrl);
    preservePlatform = false;
    setConnectionMode('remote');
  } catch (err) {
    console.error('[remote-shim] connectToHost failed:', (err as Error)?.message);
    // Same leak class as scheduleReconnect's MAX_RECONNECT branch:
    // queue may hold messages bound for the failed remote target. They
    // were enqueued during the 'authenticating' window after disconnect()
    // already cleared the queue at the top of connectToHost. ws.onclose's
    // pre-auth path doesn't call disconnect(), so we must clear here
    // before falling back to the local bridge — otherwise stale messages
    // would flush to the local bridge on its auth:ok.
    if (pendingSendQueue.length > 0) {
      console.warn('[remote-shim] discarding', pendingSendQueue.length,
        'queued messages on connectToHost failure fallback');
      pendingSendQueue = [];
    }
    // Reset remote state and reconnect to local bridge
    targetUrl = null;
    preservePlatform = false;
    localStorage.removeItem('youcoded-remote-target');
    connect('android-local', false).catch(() => {});
    throw err;
  }
}

/**
 * Disconnect from a remote desktop and reconnect to the local bridge server.
 */
export async function disconnectFromHost(): Promise<void> {
  const { setConnectionMode } = await import('./platform');

  disconnect();

  for (const entry of pending.values()) {
    clearTimeout(entry.timeout);
    entry.reject(new Error('Server switched'));
  }
  pending.clear();
  // Note: pre-auth send queue was already cleared inside disconnect() above.

  // Clear remote target — getWsUrl() falls back to localhost:9901
  targetUrl = null;
  localStorage.removeItem('youcoded-remote-target');
  preservePlatform = false;

  // Reconnect to local bridge
  await connect('android-local', false);

  setConnectionMode('local');
}

/**
 * Opens a browser file picker, reads selected files as base64,
 * uploads each to the remote desktop via WebSocket, and returns
 * the desktop-side file paths.
 */
async function pickAndUploadFiles(): Promise<string[]> {
  // Create a hidden file input and trigger the native picker
  const paths: string[] = [];
  const files = await new Promise<FileList | null>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    // No `accept` attribute on purpose — the attachment picker must default to
    // ALL file types (Destin's 2026-08-12 request). The old whitelist here made
    // mobile browsers open a media-biased picker and desktop browsers preselect
    // a "Custom Files" filter. Browsers can't offer a multi-category filter
    // dropdown like Electron's native dialog, so "no accept" IS the whole fix.
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      resolve(input.files);
      document.body.removeChild(input);
    });
    // Handle cancel — the input won't fire 'change', so listen for focus return
    const onFocus = () => {
      setTimeout(() => {
        if (!input.files?.length) {
          resolve(null);
          if (input.parentNode) document.body.removeChild(input);
        }
        window.removeEventListener('focus', onFocus);
      }, 300);
    };
    window.addEventListener('focus', onFocus);
    input.click();
  });

  if (!files || files.length === 0) return [];

  // Read each file as base64 and upload to the desktop
  for (const file of Array.from(files)) {
    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const base64 = btoa(binary);
      const result = await invoke('file:upload', {
        name: file.name,
        data: base64,
        size: file.size,
      });
      if (result?.path) paths.push(result.path);
    } catch (err) {
      console.error('Failed to upload file:', file.name, err);
    }
  }
  return paths;
}

/** Install the window.claude shim. Call once on app startup in browser mode. */
export function installShim(): void {
  // Wake checks (2026-09-11): see checkConnectionAfterWake. Guarded for pages without a DOM.
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') checkConnectionAfterWake();
    });
  }
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('online', () => checkConnectionAfterWake());
    // A page restored from the browser's back/forward cache kept its old socket object.
    window.addEventListener('pageshow', (e) => { if ((e as PageTransitionEvent).persisted) checkConnectionAfterWake(); });
  }
  // Android WebView (file://) always starts in local mode — clear any stale remote target
  // that could redirect connect('android-local') to a dead remote server
  if (location.protocol === 'file:') {
    localStorage.removeItem('youcoded-remote-target');
    localStorage.removeItem('youcoded-remote-token');
  } else {
    // Browser: restore remote target from previous session (e.g., page reload while in remote mode)
    const savedTarget = localStorage.getItem('youcoded-remote-target');
    if (savedTarget) {
      targetUrl = savedTarget;
      preservePlatform = true; // Will be set on next auth:ok
      // Restore connection mode synchronously so components render correctly on first paint
      import('./platform').then(({ setConnectionMode }) => setConnectionMode('remote'));
    }
  }

  (window as any).claude = {
    // Parity with preload's devLabel. Always null here: a remote/Android client
    // has no process env, and the label describes the DEV INSTANCE you're sitting
    // in front of, not the host it happens to be talking to.
    devLabel: null,
    // Session naming. `available` starts FALSE and is set by the one-time probe
    // below, because a phone running Claude Code locally has no naming backend
    // at all — no provider registry, no ownership store — and the UI decides
    // whether the feature exists by asking this object. Painting the settings
    // card and the rename pencil and only then failing would be worse than not
    // offering them: naming-api.ts treats available:false exactly like a host
    // that never heard of naming, which is today's behaviour there.
    sessionNaming: {
      available: false,
      get: () => invoke('session-naming:get'),
      set: (value: unknown) => unwrapRemote(invoke('session-naming:set', { value })),
      title: (sessionId: string, fallback: string) =>
        invoke('session-naming:title', { sessionId, fallback }),
      rename: (sessionId: string, title: string) =>
        unwrapRemote(invoke('session-naming:rename', { sessionId, title })),
    },
    session: {
      create: (opts: any) => invoke('session:create', opts),
      destroy: (sessionId: string) => invoke('session:destroy', { sessionId }),
      list: () => invoke('session:list'),
      browse: () => invoke('session:browse'),
      // Fix: parameter order MUST match preload.ts — (sessionId, projectSlug, count, all).
      // The shim previously declared (sessionId, count, all, projectSlug), so every
      // caller's project slug landed in `count` and 10 landed in `all` (truthy),
      // making the host return the ENTIRE transcript on every remote/Android
      // initial history load (tens of MB over the WS for large conversations).
      // `count || 10` / `all || false` mirror preload so the wire always carries
      // real number/boolean types (Android's optInt/optBoolean and the server's
      // slice(-count) both need them). Guard: shim-parity.test.ts +
      // remote-shim-loadhistory-args.test.ts.
      loadHistory: (sessionId: string, projectSlug: string, count?: number, all?: boolean) =>
        invoke('session:history', { sessionId, projectSlug, count: count || 10, all: all || false }),
      switch: (sessionId: string) => invoke('session:switch', { sessionId }),
      // Shape parity with preload (batch 2 §2). A phone or browser has no desktop window
      // whose selection main could cache, and the host ignores the channel anyway.
      noteSelected: (_sessionId: string | null) => {},
      // Set a named flag on a past session (complete, priority; helpful retired).
      setFlag: (sessionId: string, flag: string, value: boolean) =>
        invoke('session:set-flag', { sessionId, flag, value }),
      // Toggle a custom user tag on a past session.
      setTag: (sessionId: string, tagId: string, value: boolean) =>
        invoke('session:set-tag', { sessionId, tagId, value }),
      // Set the freeform note on a past session.
      setNote: (sessionId: string, note: string) =>
        invoke('session:set-note', { sessionId, note }),
      // Read a session's applied tag ids + note (used by the in-session Tag chip).
      getMeta: (sessionId: string) => invoke('session:get-meta', { sessionId }),
      canSend: () => ws?.readyState === WebSocket.OPEN && connectionState === 'connected',
      sendInput: (sessionId: string, text: string) => fire('session:input', { sessionId, text }),
      resize: (sessionId: string, cols: number, rows: number) => fire('session:resize', { sessionId, cols, rows }),
      signalReady: (sessionId: string) => fire('session:terminal-ready', { sessionId }),
      // Tracked while in flight so the host's resolution of THIS answer is not shown as
      // "answered elsewhere" (see the hook:event case). Cleared when the reply settles.
      respondToPermission: (requestId: string, decision: object) => {
        answersInFlight.add(requestId);
        return invoke('permission:respond', { requestId, decision }).finally(() => { answersInFlight.delete(requestId); });
      },
    },
    // Tag registry CRUD (custom user-defined tags shared across sessions).
    // Args wrapped as objects to match this transport's handler read-shape
    // (preload passes them positionally — intentional, mirrors setFlag).
    tags: {
      list: () => invoke('tags:list'),
      create: (label: string, color: string) => invoke('tags:create', { label, color }),
      update: (id: string, patch: object) => invoke('tags:update', { id, patch }),
      delete: (id: string) => invoke('tags:delete', { id }),
    },
    on: {
      sessionCreated: (cb: Callback) => addListener('session:created', cb),
      sessionDestroyed: (cb: Callback) => addListener('session:destroyed', cb),
      ptyOutput: (cb: Callback) => addListener('pty:output', cb),
      ptyOutputForSession: (sessionId: string, cb: (data: string) => void) => {
        const channel = `pty:output:${sessionId}`;
        const handler = addListener(channel, cb);
        return () => removeListener(channel, handler);
      },
      ptyRawBytesForSession: (sessionId: string, cb: (data: string) => void) => {
        const channel = `pty:raw-bytes:${sessionId}`;
        const handler = addListener(channel, cb);
        return () => removeListener(channel, handler);
      },
      // Batch 2 (§7): "clear the terminal, a full redraw follows". Register it BEFORE
      // ptyOutputForSession — the backlog drains on the output listener.
      ptyResetForSession: (sessionId: string, cb: () => void) => {
        const channel = `pty:reset:${sessionId}`;
        const handler = addListener(channel, cb);
        return () => removeListener(channel, handler);
      },
      // Batch 2 (§6): where this page's copy stands. A late subscriber (App mounts after
      // auth:ok) is told the current phase at once — it missed the push.
      remoteConversationStatus: (cb: Callback) => {
        const handler = addListener('remote:conversation-status', cb);
        if (conversationPhase) cb({ phase: conversationPhase });
        return () => removeListener('remote:conversation-status', handler);
      },
      // Batch 2 (§7): the asks still open after a reconnect's hook replay.
      hookReplayComplete: (cb: Callback) => {
        const handler = addListener('hook:replay-complete', cb);
        return () => removeListener('hook:replay-complete', handler);
      },
      hookEvent: (cb: Callback) => addListener('hook:event', cb),
      statusData: (cb: Callback) => addListener('status:data', cb),
      sessionRenamed: (cb: Callback) => addListener('session:renamed', cb),
      // Plan 2b Task 10 — "this conversation moved to <device>" push (parity
      // with preload's sessionMoved). Returns the cb so off() can remove it.
      sessionMoved: (cb: Callback) => addListener('session:moved', cb),
      // Return UNSUBSCRIBE fns (not the raw cb) so the tag hooks' off() cleanup
      // actually removes the listener — parity with preload, prevents leaks.
      sessionMetaChanged: (cb: Callback) => { addListener('session:meta-changed', cb); return () => removeListener('session:meta-changed', cb); },
      // Pushed when the tag registry changes (create/update/delete).
      tagsChanged: (cb: Callback) => { addListener('tags:changed', cb); return () => removeListener('tags:changed', cb); },
      // Specialists 1c (Task 8) — one hire's ledger record changed. Unsubscribe
      // fn, matching preload's specialistEvent (both keep window.claude.on's
      // shape consistent for the specialists card's cleanup effects).
      specialistEvent: (cb: Callback) => { addListener('specialists:event', cb); return () => removeListener('specialists:event', cb); },
      // G-1: background command run records — mirrors preload's on.shellEvent.
      shellEvent: (cb: Callback) => { addListener('native:shell-event', cb); return () => removeListener('native:shell-event', cb); },
      // Android-only push event — see remote-shim handleMessage above for rationale.
      sessionPermissionMode: (cb: Callback) => addListener('session:permission-mode', cb),
      uiAction: (cb: Callback) => addListener('ui:action:received', cb),
      transcriptEvent: (cb: Callback) => addListener('transcript:event', cb),
      transcriptShrink: (cb: Callback) => addListener('transcript:shrink', cb),
      promptShow: (cb: Callback) => addListener('prompt:show', cb),
      promptDismiss: (cb: Callback) => addListener('prompt:dismiss', cb),
      promptComplete: (cb: Callback) => addListener('prompt:complete', cb),
      // Full chat state snapshot received from host on connect (remote browsers only).
      chatHydrate: (cb: Callback) => addListener('chat:hydrate', cb),
    },
    skills: {
      list: () => invoke('skills:list'),
      listMarketplace: (filters?: any) => invoke('skills:list-marketplace', filters),
      getDetail: (id: string) => invoke('skills:get-detail', { id }),
      search: (query: string) => invoke('skills:search', { query }),
      install: (id: string) => invoke('skills:install', { id }),
      uninstall: (id: string) => invoke('skills:uninstall', { id }),
      getFavorites: () => invoke('skills:get-favorites'),
      setFavorite: (id: string, favorited: boolean) => invoke('skills:set-favorite', { id, favorited }),
      getChips: () => invoke('skills:get-chips'),
      setChips: (chips: any[]) => invoke('skills:set-chips', { chips }),
      getOverride: (id: string) => invoke('skills:get-override', { id }),
      setOverride: (id: string, override: any) => invoke('skills:set-override', { id, override }),
      createPrompt: (skill: any) => invoke('skills:create-prompt', skill),
      deletePrompt: (id: string) => invoke('skills:delete-prompt', { id }),
      publish: (id: string) => invoke('skills:publish', { id }),
      getShareLink: (id: string) => invoke('skills:get-share-link', { id }),
      importFromLink: (encoded: string) => invoke('skills:import-from-link', { encoded }),
      getCuratedDefaults: () => invoke('skills:get-curated-defaults'),
      getFeatured: () => invoke('skills:get-featured'),
      // Decomposition v3 §9.9: shim parity for integration badges
      getIntegrationInfo: (id: string) => invoke('skills:get-integration-info', { id }),
      // Decomposition v3 §9.10: shim parity for onboarding helpers
      installMany: (ids: string[]) => invoke('skills:install-many', { ids }),
      applyOutputStyle: (styleId: string) => invoke('skills:apply-output-style', { styleId }),
      // Phase 3b: update a plugin (re-installs at the same path)
      update: (id: string) => invoke('skills:update', { id }),
    },
    commands: {
      list: () => invoke('commands:list'),
    },
    // Marketplace redesign Phase 3 — integrations namespace.
    integrations: {
      list: () => invoke('integrations:list'),
      install: (slug: string) => invoke('integrations:install', { slug }),
      uninstall: (slug: string) => invoke('integrations:uninstall', { slug }),
      status: (slug: string) => invoke('integrations:status', { slug }),
      configure: (slug: string, settings: Record<string, any>) =>
        invoke('integrations:configure', { slug, settings }),
      connect: (slug: string) => invoke('integrations:connect', { slug }),
    },
    // Platform detection for renderer-level UI gating. Desktop returns the
    // raw string; Android wraps in {platform}. Normalize both here so callers
    // see a consistent union type.
    getPlatform: async (): Promise<'darwin' | 'win32' | 'linux' | 'android'> => {
      const result = await invoke('platform:get');
      if (typeof result === 'string') return result as any;
      if (result && typeof result === 'object' && 'platform' in result) {
        return (result as any).platform;
      }
      return 'linux'; // degenerate fallback; shouldn't hit in practice
    },
    // Phase 3: unified marketplace (packages map + per-entry config)
    marketplace: {
      getPackages: () => invoke('marketplace:get-packages'),
      getConfig: (id: string) => invoke('marketplace:get-config', { id }),
      setConfig: (id: string, values: Record<string, any>) =>
        invoke('marketplace:set-config', { id, values }),
      invalidateCache: () => invoke('marketplace:invalidate-cache'),
      readComponent: (args: { pluginId: string; kind: 'skill' | 'command' | 'agent'; name: string }) =>
        invoke('marketplace:read-component', args),
    },
    // YouCoded account (device-code OAuth) — same shape as preload.ts. Android
    // handlers live in SessionService.kt (Task 4). The shim wraps args in objects
    // (Kotlin reads with optString); start/poll/updateProfile/setHandle/deleteAccount
    // return ApiResult. signedIn is a pure local read; user may lazily heal via
    // /auth/me; signOut best-effort revokes server-side. No ApiResult wrapper on those.
    account: {
      start: (): Promise<ApiResult<unknown>> => invoke('account:start'),
      poll: (deviceCode: string): Promise<ApiResult<unknown>> =>
        invoke('account:poll', { deviceCode }),
      signedIn: (): Promise<boolean> => invoke('account:signed-in'),
      user: (): Promise<MarketplaceUser | null> => invoke('account:user'),
      // Force a /auth/me round-trip; returns the fresh profile or null (401-cleared).
      refresh: (): Promise<MarketplaceUser | null> => invoke('account:refresh'),
      signOut: (): Promise<void> => invoke('account:sign-out'),
      updateProfile: (displayName: string): Promise<ApiResult<unknown>> =>
        invoke('account:update-profile', { displayName }),
      setHandle: (handle: string): Promise<ApiResult<unknown>> =>
        invoke('account:set-handle', { handle }),
      deleteAccount: (): Promise<ApiResult<unknown>> => invoke('account:delete'),
      // Export account data. On a remote browser the SAVE DIALOG opens on the
      // HOST desktop (the file is written host-side) — a browser can't drive a
      // native save dialog; acceptable pre-existing remote-host pattern. On
      // Android the SessionService handler writes to the public Downloads folder.
      exportData: (): Promise<unknown> => invoke('account:export'),
    },
    // Social graph (accounts Phase 2) — friends / requests / blocks. Same shape
    // as preload.ts; args are object-wrapped so the Android SessionService
    // handlers read them via optString. Every method returns ApiResult so the
    // renderer sees .status (404 unknown/blocked handle, 429 caps, 400 self-request).
    social: {
      lookupHandle: (handle: string): Promise<ApiResult<unknown>> => invoke('social:lookup-handle', { handle }),
      sendRequest: (handle: string): Promise<ApiResult<unknown>> => invoke('social:send-request', { handle }),
      listRequests: (): Promise<ApiResult<unknown>> => invoke('social:list-requests'),
      acceptRequest: (id: string): Promise<ApiResult<unknown>> => invoke('social:accept-request', { id }),
      declineRequest: (id: string): Promise<ApiResult<unknown>> => invoke('social:decline-request', { id }),
      cancelRequest: (id: string): Promise<ApiResult<unknown>> => invoke('social:cancel-request', { id }),
      listFriends: (): Promise<ApiResult<unknown>> => invoke('social:list-friends'),
      unfriend: (userId: string): Promise<ApiResult<unknown>> => invoke('social:unfriend', { userId }),
      block: (userId: string): Promise<ApiResult<unknown>> => invoke('social:block', { userId }),
      unblock: (userId: string): Promise<ApiResult<unknown>> => invoke('social:unblock', { userId }),
      listBlocks: (): Promise<ApiResult<unknown>> => invoke('social:list-blocks'),
      // Presence socket (Task 6). connect/disconnect/send resolve to { ok:true };
      // events flow back via the 'social:presence-event' push (handleMessage below).
      // message is object-wrapped as { message } so the Android SessionService
      // reads it via msg.payload.getJSONObject("message").
      presenceConnect: (): Promise<{ ok: true }> => invoke('social:presence-connect'),
      presenceDisconnect: (): Promise<{ ok: true }> => invoke('social:presence-disconnect'),
      // presenceSend returns an honest receipt: { ok:false, status:0, message }
      // when the platform socket isn't connected (frame would silently drop).
      presenceSend: (message: Record<string, unknown>): Promise<{ ok: true } | { ok: false; status: number; message: string }> =>
        invoke('social:presence-send', { message }),
      onPresenceEvent: (cb: (ev: Record<string, unknown>) => void) => {
        const handler = addListener('social:presence-event', cb as Callback);
        return () => removeListener('social:presence-event', handler);
      },
    },
    // Marketplace write endpoints — same shape as preload.ts.
    marketplaceApi: {
      install: (pluginId: string): Promise<ApiResult<unknown>> =>
        invoke('marketplace:install', { pluginId }),
      // WHY: pass input flat so Android handler reaches payload.plugin_id directly,
      // not payload.input.plugin_id — consistent with all other shim call sites.
      rate: (input: { plugin_id: string; stars: 1 | 2 | 3 | 4 | 5; review_text?: string }): Promise<ApiResult<unknown>> =>
        invoke('marketplace:rate', input),
      deleteRating: (pluginId: string): Promise<ApiResult<unknown>> =>
        invoke('marketplace:rate:delete', { pluginId }),
      likeTheme: (themeId: string): Promise<ApiResult<unknown>> =>
        invoke('marketplace:theme:like', { themeId }),
      // WHY: pass input flat — same rationale as rate above.
      thumb: (input: { plugin_id: string; value: 'up' | 'down' | null }): Promise<ApiResult<unknown>> =>
        invoke('marketplace:thumb', input),
      // WHY the object wrapper: every shim call sends an OBJECT payload, and the
      // Android arm reads `msg.payload.optString("plugin_id")`. A bare string
      // makes `payload` not a JSON object, so Android reads an empty id and the
      // thumb never lights up on a phone — silently, with no error either side.
      myThumb: (pluginId: string): Promise<ApiResult<unknown>> =>
        invoke('marketplace:thumb:get', { plugin_id: pluginId }),
      comment: (input: { plugin_id: string; text: string }): Promise<ApiResult<unknown>> =>
        invoke('marketplace:comment', input),
      // WHY: pass input flat — same rationale as rate above.
      report: (input: { rating_user_id: string; rating_plugin_id: string; reason?: string }): Promise<ApiResult<unknown>> =>
        invoke('marketplace:report', input),
    },
    // Phase 3: theme namespace (stub + marketplace endpoints) so the unified
    // Marketplace modal can reach theme install/uninstall/update on Android.
    // Only marketplace methods are exposed — native theme editor lives elsewhere.
    theme: {
      list: () => invoke('theme:list').catch(() => []),
      readFile: (slug: string) => invoke('theme:read-file', { slug }).catch(() => null),
      writeFile: (slug: string, content: string) => invoke('theme:write-file', { slug, content }).catch(() => {}),
      // Fix: previously a no-op stub, which silently dropped theme:reload
      // events from the Android file-watcher and post-install broadcasts.
      // theme-context calls this with (slug) => readFile(slug) to refresh the
      // appearance picker when a theme is installed/edited externally.
      onReload: (cb: Callback) => {
        const handler = addListener('theme:reload', cb);
        return () => removeListener('theme:reload', handler);
      },
      marketplace: {
        list: (filters?: any) => invoke('theme-marketplace:list', filters),
        detail: (slug: string) => invoke('theme-marketplace:detail', { slug }),
        install: (slug: string) => invoke('theme-marketplace:install', { slug }),
        uninstall: (slug: string) => invoke('theme-marketplace:uninstall', { slug }),
        update: (slug: string) => invoke('theme-marketplace:update', { slug }),
        publish: (slug: string) => invoke('theme-marketplace:publish', { slug }),
        generatePreview: (slug: string) => invoke('theme-marketplace:generate-preview', { slug }),
        // Publish-lifecycle: read-side APIs work on Android (registry fetch + gh PR lookup)
        // if gh is installed. If IPC itself fails, degrade to unknown so the UI shows the
        // same "couldn't verify" state as a gh auth failure rather than crashing.
        resolvePublishState: (slug: string) =>
          invoke('theme-marketplace:resolve-publish-state', { slug })
            .catch((err: any) => ({ kind: 'unknown', reason: err?.message ?? 'IPC failed' })),
        refreshRegistry: () =>
          invoke('theme-marketplace:refresh-registry').catch(() => null),
      },
    },
    dialog: {
      openFile: () => targetUrl
        ? pickAndUploadFiles()                   // Remote — pick on device, upload to desktop
        : invoke('dialog:open-file')             // Local Android — native file picker
            .then((r: any) => r?.paths ?? r ?? [])
            .catch(() => [] as string[]),
      openFolder: () => invoke('dialog:open-folder').catch(() => null),
      openSound: () => invoke('dialog:open-sound').catch(() => null),
      readTranscriptMeta: (p: string) => invoke('transcript:read-meta', { path: p }),
      saveClipboardImage: async () => null,
    },
    shell: {
      // Matches the URL hardcoded in desktop's ipc-handlers.ts OPEN_CHANGELOG
      // handler. On Android, WebViewHost.shouldOverrideUrlLoading intercepts
      // the non-file:// URL and launches an Intent.ACTION_VIEW — same net
      // effect as Electron's shell.openExternal.
      openChangelog: async () => {
        window.open('https://github.com/itsdestin/youcoded/blob/master/CHANGELOG.md', '_blank');
      },
      // On the ANDROID host, go through the bridge: React runs under file://
      // there, and window.open from a promise callback is a no-op (a trap the
      // old restore wizard's browse-url handler hit first, 2026-05) — a
      // link tile in the Deliverables card would be a dead button. The bridge
      // fires Intent.ACTION_VIEW, which always works. `targetUrl` means we are
      // a REMOTE browser talking to a desktop server instead, where opening a
      // tab is both possible and the right behaviour.
      openExternal: async (url: string) => {
        if (!targetUrl) {
          try {
            await invoke('shell:open-external', { url });
            return;
          } catch { /* fall through — an older host without the handler */ }
        }
        window.open(url, '_blank');
      },
      // No-op on remote/Android — a browser can't reveal a file in the host's
      // file manager. The artifact panel hides the button on touch anyway.
      showItemInFolder: async () => {},
      // No-op on remote/Android — a browser can't launch the host's default app
      // for a local path. The "Open externally" button is desktop-gated, so this
      // only exists to keep the window.claude shape symmetric.
      openPath: async () => '',
    },
    update: {
      changelog: async (opts: { forceRefresh: boolean }) =>
        invoke('update:changelog', opts),
      // Mirrors main-side IPC channels for parity (see tests/update-install-ipc.test.ts):
      //   'update:download'           — stub below (throws remote-unsupported)
      //   'update:cancel'             — stub below (returns { success: false })
      //   'update:launch'             — stub below (returns remote-unsupported)
      //   'update:get-cached-download'— stub below (returns null)
      //   'update:progress'           — never fires on remote (no-op subscribe)
      download: async () => {
        throw new Error('remote-unsupported');
      },
      cancel: async (_jobId: string) => ({ success: false }),
      launch: async (_jobId: string, _filePath: string) => ({
        success: false as const,
        error: 'remote-unsupported' as const,
      }),
      getCachedDownload: async (_version: string) => null,
      onProgress: (_handler: (ev: any) => void) => {
        // No-op on remote browsers — they never emit progress.
        return () => {};
      },
    },
    remote: {
      getConfig: () => invoke('remote:get-config'),
      setPassword: (password: string) => invoke('remote:set-password', password),
      setConfig: (updates: { enabled?: boolean }) =>
        invoke('remote:set-config', updates),
      detectTailscale: () => invoke('remote:detect-tailscale'),
      getClientCount: () => invoke('remote:get-client-count'),
      getClientList: () => invoke('remote:get-client-list'),
      getStatus: () => invoke('remote:status'),
      // No push channel over the socket yet: a remote client reads the state when it opens
      // the panel. Returning a no-op unsubscribe keeps the caller's cleanup honest.
      onStatus: () => () => {},
      // Renaming and unpairing are refused over this socket by design; list is read-only.
      devices: {
        list: () => invoke('remote:devices:list').then((r: { devices?: unknown[] }) => r?.devices ?? []),
        rename: (deviceId: string, name: string) => invoke('remote:devices:rename', { deviceId, name }),
        unpair: (deviceId: string) => invoke('remote:devices:unpair', { deviceId }),
      },
      broadcastAction: (action: any) => fire('ui:action', action),
      // Batch 2 (§6): Refresh on the may-be-behind strip, and App's report of what its
      // hydrate kept (the shim derives incomplete/complete from it).
      rehydrate: () => requestRehydrate(),
      reportHydrate: (report: { seq?: number; kept?: string[] }) => reportHydrate(report),
    },
    model: {
      getPreference: () => invoke('model:get-preference'),
      setPreference: (model: string) => invoke('model:set-preference', { model }),
      // Desktop's handler returns the last-used model name from a JSONL
      // transcript file. Android's SessionService mirrors the read; we wrap
      // the path in an object because the WebSocket protocol's payload
      // field is always parsed as a JSON object on the Kotlin side.
      readLastModel: (transcriptPath: string) => invoke('model:read-last', { transcriptPath }),
    },
    appearance: {
      get: () => invoke('appearance:get'),
      set: (prefs: Record<string, any>) => invoke('appearance:set', prefs),
      // Parity with preload.ts — theme favorites stored in appearance prefs.
      favoriteTheme: (slug: string, favorited: boolean) =>
        invoke('appearance:favorite-theme', { slug, favorited }),
      getFavoriteThemes: () => invoke('appearance:get-favorite-themes', {}),
      // WHY these are real now (Destin, 2026-09-11: the phone kept an old theme until it was
      // reloaded): a phone is one more window on the computer's appearance. A change here
      // goes to the computer to pass on; a change there arrives as appearance:sync.
      // tests/remote-appearance-sync.test.ts.
      broadcast: (prefs: Record<string, any>) => { fire('appearance:broadcast', prefs); },
      onSync: (cb: (prefs: Record<string, any>) => void) => {
        const handler = addListener('appearance:sync', cb);
        return () => removeListener('appearance:sync', handler);
      },
    },
    defaults: {
      get: () => invoke('defaults:get'),
      set: (updates: Record<string, any>) => invoke('defaults:set', updates),
    },
    // Anonymous analytics opt-out — mirror of preload.ts. Android handlers
    // land in Phase 7; until then the remote-shim path resolves via the
    // WebSocket once the Kotlin side dispatches these types.
    analytics: {
      getOptIn: (): Promise<boolean> => invoke('analytics:get-opt-in'),
      setOptIn: (enabled: boolean): Promise<void> =>
        invoke('analytics:set-opt-in', { enabled }),
    },
    // Parity with preload.ts — Preferences panel uses this over remote too
    settings: {
      get: (field: string) => invoke('settings:get', { field }),
      set: (field: string, value: unknown) => invoke('settings:set', { field, value }),
    },
    modes: {
      get: () => invoke('modes:get'),
      set: (modes: Record<string, any>) => invoke('modes:set', modes),
    },
    sync: {
      getStatus: () => invoke('sync:get-status'),
      getConfig: () => invoke('sync:get-config'),
      setConfig: (updates: any) => invoke('sync:set-config', { updates }),
      // Full sync can transfer megabytes across slow cellular — 10 min ceiling.
      force: () => invoke('sync:force', undefined, { timeoutMs: 10 * 60_000 }),
      getLog: (lines?: number) => invoke('sync:get-log', { lines }),
      dismissWarning: (warning: string) => invoke('sync:dismiss-warning', { warning }),
      // V2: Per-instance backend management
      addBackend: (instance: any) => invoke('sync:add-backend', instance),
      removeBackend: (id: string) => invoke('sync:remove-backend', { id }),
      updateBackend: (id: string, updates: any) => invoke('sync:update-backend', { id, updates }),
      pushBackend: (id: string) => invoke('sync:push-backend', { id }),
      openFolder: (id: string) => invoke('sync:open-folder', { id }),
      // Guided setup wizard
      setup: {
        checkPrereqs: (backend: string) => invoke('sync:setup:check-prereqs', { backend }),
        installRclone: () => invoke('sync:setup:install-rclone'),
        checkGdrive: () => invoke('sync:setup:check-gdrive'),
        // OAuth waits on the user completing sign-in in a browser tab; Android
        // side has a 180s rclone wait, gh device flow can poll longer — give a
        // 4 min ceiling so the shim doesn't cut the kotlin timeout short.
        authGdrive: () => invoke('sync:setup:auth-gdrive', undefined, { timeoutMs: 4 * 60_000 }),
        authGithub: () => invoke('sync:setup:auth-github', undefined, { timeoutMs: 4 * 60_000 }),
        createRepo: (repoName: string) => invoke('sync:setup:create-repo', { repoName }),
      },
    },
    // Cross-device sync spaces (spec 2026-07-03). Same shared shape as
    // preload.ts syncSpaces so React components render identically on remote
    // browsers + Android (PITFALLS parity rule). onEvent returns an
    // unsubscribe function to match preload's shape.
    syncSpaces: {
      // The phone has no Sync Spaces engine (audit 2026-09-10); status is polled
      // on mount by Settings, Project View and the folder switcher, so it is
      // refused without a notice — see refuseQuietlyOnPhone.
      status: () => (isAndroidLocal() ? refuseQuietlyOnPhone('syncspaces:status') : invoke('syncspaces:status')),
      enable: (enabled: boolean) => invoke('syncspaces:enable', { enabled }),
      // Optional spaceId narrows to one space (Project View "Sync now"); omit for all.
      syncNow: (spaceId?: string) => invoke('syncspaces:sync-now', { spaceId }),
      createProject: (name: string) => invoke('syncspaces:create-project', { name }),
      // Spec §3 import: move an existing folder into ~/YouCoded/Projects/<name>.
      // Shim wraps args in an object (the established convention).
      importProject: (sourcePath: string, name: string) =>
        invoke('syncspaces:import-project', { sourcePath, name }),
      // Cross-device rename (display-name only) + stop-syncing (2026-07-12).
      renameProject: (name: string, displayName: string) =>
        invoke('syncspaces:rename-project', { name, displayName }),
      stopProject: (name: string) => invoke('syncspaces:stop-project', { name }),
      // Synced project description (Task 3) — payload-object shape, matching
      // preload's renameProject/setProjectDescription convention.
      setProjectDescription: (name: string, description: string) =>
        invoke('syncspaces:set-project-description', { name, description }),
      // Conversation-lease takeover (Plan 2b Task 9). Same shape as preload for
      // parity (PITFALLS rule) so a remote browser doesn't crash when the resume
      // dialog calls leaseQuery. Remote-server routing lands in Task 11 — until
      // then these reject/time out and the renderer resume gate degrades (proceeds
      // with the resume, never hard-blocks — spec §3 never-block).
      leaseQuery: (claudeSessionId: string) => invoke('syncspaces:lease-query', { claudeSessionId }),
      leaseTakeover: (claudeSessionId: string) => invoke('syncspaces:lease-takeover', { claudeSessionId }),
      leaseForce: (claudeSessionId: string) => invoke('syncspaces:lease-force', { claudeSessionId }),
      // Device registry (Plan 2b spec §10a). Object-payload invoke over WS to
      // match the shim's convention; routed by remote-server (Task 11).
      listDevices: () => invoke('syncspaces:list-devices'),
      renameDevice: (id: string, name: string) => invoke('syncspaces:rename-device', { id, name }),
      removeDevice: (id: string) => invoke('syncspaces:remove-device', { id }),
      onEvent: (cb: (e: unknown) => void) => {
        const handler: Callback = (e: any) => cb(e);
        addListener('syncspaces:event', handler);
        return () => removeListener('syncspaces:event', handler);
      },
    },
    // Connect-GitHub modal (device-flow auth). Same shared shape as preload's
    // window.claude.github so the modal renders identically on remote browsers.
    // The whole flow is main-process; the shim just relays requests + the
    // connect-done push. Token never crosses the WS (only status/login/error do).
    github: {
      status: () => invoke('github:status'),
      connectStart: () => invoke('github:connect-start'),
      connectCancel: () => invoke('github:connect-cancel'),
      installGh: () => invoke('github:install-gh'),
      disconnect: () => invoke('github:disconnect'),
      onConnectDone: (cb: (payload: { ok: boolean; login?: string; error?: string }) => void) => {
        const handler: Callback = (p: any) => cb(p);
        addListener('github:connect-done', handler);
        return () => removeListener('github:connect-done', handler);
      },
    },
    folders: {
      list: () => invoke('folders:list'),
      add: (folderPath: string, nickname?: string) => invoke('folders:add', { folderPath, nickname }),
      remove: (folderPath: string) => invoke('folders:remove', { folderPath }),
      rename: (folderPath: string, nickname: string) => invoke('folders:rename', { folderPath, nickname }),
      setDescription: (folderPath: string, description: string) =>
        invoke('folders:set-description', { folderPath, description }),
    },
    artifacts: {
      listSession: (sessionId: string, projectRoot: string) =>
        invoke('artifacts:list-session', { sessionId, projectRoot }),
      listProject: (projectId: string, opts?: { withCount?: boolean }) =>
        invoke('artifacts:list-project', { projectId, opts }),
      listAllFiles: (projectId: string, opts?: { force?: boolean }) =>
        invoke('artifacts:list-all-files', { projectId, opts }),
      // One tapped chat path, resolved on the host (remote-server.ts, same
      // root gate as the other reads). Its { ok:false, error } answers are DATA
      // the caller words for the person (not-found, not-allowed…), so this
      // channel is deliberately NOT in REJECT_ON_NOT_OK. On the Android app the
      // bridge answers not-implemented-on-mobile and the caller falls back.
      resolvePath: (projectRoot: string, filePath: string) =>
        invoke('artifacts:resolve-path', { projectRoot, path: filePath }),
      listProjectsIndex: (opts?: { withCounts?: boolean }) =>
        invoke('artifacts:list-projects-index', opts ?? {}),
      // This transport sends an OBJECT payload, not positional args — `full`
      // has to be spread in by name or it is dropped silently.
      get: (projectRoot: string, artifactId: string, opts?: { full?: boolean }) =>
        invoke('artifacts:get', { projectRoot, artifactId, full: opts?.full }),
      // Bridged by remote-server.ts since batch 3 (with the phone's smaller
      // preview ceiling — over it the host answers too-large with the size).
      readBinary: (absolutePath: string) =>
        invoke('artifacts:read-binary', { absolutePath }),
      // Save a copy to this device (batch 3, §10). The host mints a short-lived
      // link bound to this socket; the link is opened through an <a download>
      // so the browser's own download UI shows progress and the finished file,
      // and the file is saved, never displayed (R20). A refusal is data — the
      // card shows it — so this channel is not in REJECT_ON_NOT_OK.
      download: async (absolutePath: string, opts?: { projectRoot?: string; artifactId?: string }) => {
        const res = await invoke('artifacts:download', { absolutePath, ...opts });
        if (!res || res.ok !== true || typeof res.url !== 'string') return res;
        const url = absoluteHostUrl(res.url);
        openAsDownload(url, typeof res.name === 'string' ? res.name : '');
        return { ...res, url };
      },
      save: (projectRoot: string, projectId: string, projectName: string,
             artifactId: string, content: string, sessionId: string,
             opts?: { baseMtimeMs?: number; confirmed?: boolean }) =>
        invoke('artifacts:save', { projectRoot, projectId, projectName, artifactId, content, sessionId, ...opts }),
      // Fix: data-flow gap — renderer Tracker calls this on Write/Edit/MultiEdit
      // transcript events so the central index is populated automatically on Android.
      appendVersion: (projectRoot: string, sessionId: string, args: any) =>
        invoke('artifacts:append-version', { projectRoot, sessionId, args }),
      // Copy or move a picked file INTO the project folder — see
      // artifacts/import-file.ts for the traversal/collision/protected-path policy.
      importFile: (projectRoot: string, sourcePath: string, destDir: string,
                   opts: {
                     mode: 'move' | 'copy';
                     onCollision: 'replace' | 'keep-both' | 'skip';
                     // The colliding basenames the dialog NAMED to the user —
                     // 'replace' is limited to these, so an undisclosed
                     // collision can never be overwritten.
                     disclosedCollisions?: string[];
                   }) =>
        invoke('artifacts:import-file', { projectRoot, sourcePath, destDir, opts }),
      includeExternal: (projectRoot: string, absolutePath: string) =>
        invoke('artifacts:include-external', { projectRoot, absolutePath }),
      exclude: (projectRoot: string, canonicalPath: string) =>
        invoke('artifacts:exclude', { projectRoot, canonicalPath }),
      // Task 7.3: remove a project from the central index (files untouched)
      deleteProject: (projectId: string, deleteSidecar: boolean) =>
        invoke('artifacts:delete-project', { projectId, deleteSidecar }),
      // Returns the subset of artifactIds whose underlying file is missing from
      // disk. Android stub returns empty missingIds (existence check is desktop-only
      // until Project View ships on mobile).
      checkExistence: (projectRoot: string, artifactIds: string[]) =>
        invoke('artifacts:check-existence', { projectRoot, artifactIds }),
      rename: (projectRoot: string, artifactId: string, newName: string) =>
        invoke('artifacts:rename', { projectRoot, artifactId, newName }),
      // Remove a tracking RECORD from the sidecar (never the file on disk).
      removeRecord: (projectRoot: string, artifactId: string) =>
        invoke('artifacts:remove-record', { projectRoot, artifactId }),
      watchProject: (projectRoot: string) =>
        invoke('artifacts:watch-project', { projectRoot }),
      unwatchProject: (projectRoot: string) =>
        invoke('artifacts:unwatch-project', { projectRoot }),
      searchContent: (projectRoot: string, query: string) =>
        invoke('artifacts:search-content', { projectRoot, query }),
      onChanged: (cb: (event: any) => void) => {
        const handler: Callback = (evt: any) => cb(evt);
        addListener('artifacts:changed', handler);
        return () => removeListener('artifacts:changed', handler);
      },
    },
    git: {
      fileStatus: (projectRoot: string, relPath: string) =>
        invoke('git:file-status', { projectRoot, relPath }),
      fileReview: (projectRoot: string, relPath: string, opts?: { logSkip?: number }) =>
        invoke('git:file-review', { projectRoot, relPath, ...opts }),
      // prevPath (project-root-relative old name) is passed for the rename
      // commit itself so pairing with -M can happen, same as preload.ts.
      commitFileDiff: (projectRoot: string, sha: string, relPath: string, prevPath?: string) =>
        invoke('git:commit-file-diff', { projectRoot, sha, relPath, prevPath }),
      stage: (projectRoot: string, relPath: string) => invoke('git:stage', { projectRoot, relPath }),
      unstage: (projectRoot: string, relPath: string) => invoke('git:unstage', { projectRoot, relPath }),
      commit: (projectRoot: string, message: string) => invoke('git:commit', { projectRoot, message }),
      discard: (projectRoot: string, relPath: string) => invoke('git:discard', { projectRoot, relPath }),
      watch: (projectRoot: string) => invoke('git:watch', { projectRoot }),
      unwatch: (projectRoot: string) => invoke('git:unwatch', { projectRoot }),
      onChanged: (cb: (event: any) => void) => {
        const handler: Callback = (evt: any) => cb(evt);
        addListener('git:changed', handler);
        return () => removeListener('git:changed', handler);
      },
    },
    // Project View IPC — sibling to artifacts. Object-payload invoke style
    // mirrors the artifacts namespace above; the literal 'project:*' channel
    // strings are required by the IPC parity test.
    project: {
      listConversations: (projectPath: string) =>
        invoke('project:list-conversations', { projectPath }),
      conversationHistory: (projectPath: string, sessionId: string, count: number, all: boolean) =>
        invoke('project:conversation-history', { projectPath, sessionId, count, all }),
      repoInfo: (projectPath: string) =>
        invoke('project:repo-info', { projectPath }),
      listContext: (projectPath: string) =>
        invoke('project:list-context', { projectPath }),
      readContextFile: (projectPath: string, absolutePath: string) =>
        invoke('project:read-context-file', { projectPath, absolutePath }),
      writeContextFile: (projectPath: string, absolutePath: string, content: string) =>
        invoke('project:write-context-file', { projectPath, absolutePath, content }),
    },
    // Session references. Object payloads, like project.* above — the remote
    // server reads named fields off `payload`, never positional arguments.
    chatsearch: {
      resolve: (shortIds: string[]) => invoke('chatsearch:resolve', { shortIds }),
      read: (req: { provider: string; id: string; tail: number; before?: number }) =>
        invoke('chatsearch:read', req),
    },
    // Voice typing — the PHONE's half of window.claude.voice.
    //
    // Written as a plain, unconditional `voice: {` rather than a conditional
    // spread on purpose: the workbench's contract scan
    // (tests/workbench-mock-contract.test.ts) finds a namespace by looking for
    // its name at exactly this indentation, and `...(androidLocal ? {voice} : {})`
    // would be invisible to it. The namespace is instead DELETED after this
    // object is built, whenever this client is not the Android app on its own
    // bridge — see the isAndroidLocal() check at the end of installShim().
    //
    // `sendAudio` and `micAccess` are deliberately missing, unlike preload's
    // copy: on a phone Android's own speech recognition owns the microphone, and
    // the app window's permission prompt owns the permission question, so no
    // audio and no permission query ever passes through here. Every caller tests
    // `typeof bridge.sendAudio === 'function'` instead of assuming. Both gaps are
    // written down in the workspace rule .claude/rules/ipc-bridge.md.
    voice: {
      // Every method below refuses the moment this client is pointed at someone
      // else's desktop.
      //
      // WHY a test inside each method, when the namespace is already deleted for
      // anything but the Android app: pairing to a desktop mid-session only flips
      // the `targetUrl` variable — it does NOT rebuild window.claude, and the
      // composer captured this bridge once when it mounted. Without these tests a
      // phone that pairs to a desktop while the mic is open would keep a live
      // microphone running and send voice:* to a host that has no such handlers,
      // which is a hang, not an error. This is the same per-call shape the
      // `android` namespace below already uses.
      status: (): Promise<VoiceReadiness> =>
        targetUrl
          // Answer, don't reject: the composer shows this sentence on its card,
          // so the user reads why there is no microphone instead of watching a
          // button go quietly dead.
          ? Promise.resolve({ state: 'unavailable', reason: VOICE_REMOTE_REASON })
          : invoke('voice:status'),
      download: (): Promise<void> =>
        targetUrl ? Promise.reject(new Error(VOICE_REMOTE_REASON)) : invoke('voice:download'),
      start: (): Promise<void> =>
        targetUrl ? Promise.reject(new Error(VOICE_REMOTE_REASON)) : invoke('voice:start'),
      stop: (): Promise<void> =>
        targetUrl ? Promise.reject(new Error(VOICE_REMOTE_REASON)) : invoke('voice:stop'),
      cancel: (): Promise<void> =>
        targetUrl ? Promise.reject(new Error(VOICE_REMOTE_REASON)) : invoke('voice:cancel'),
      onEvent: (cb: (e: unknown) => void) => {
        // Refuses the same way: once we are talking to a desktop, no voice event
        // can ever arrive, so subscribe to nothing and hand back an unsubscribe
        // that callers can still call unconditionally.
        if (targetUrl) return () => {};
        const handler: Callback = (payload: any) => cb(payload);
        addListener('voice:event', handler);
        return () => removeListener('voice:event', handler);
      },
    },
    // System namespace — hardware back button bridge for Android.
    // notifyStackState: React tells Android whether the dismissal stack is
    //   non-empty. Android sets OnBackPressedCallback.isEnabled accordingly
    //   (true when at least one overlay/full-screen view is open, false to
    //   let Android default = background the app take over).
    // onBack: subscribe to "user pressed hardware back" push events from
    //   Android. Returns an unsubscribe function (same pattern as
    //   dev.onInstallProgress).
    system: {
      notifyStackState: (empty: boolean) => {
        fire('system:notify-stack-state', { empty });
      },
      onBack: (cb: () => void) => {
        const handler: Callback = () => cb();
        addListener('system:back', handler);
        return () => removeListener('system:back', handler);
      },
    },
    // Settings → Development feature — mirrors preload.ts dev namespace.
    // WHY: remote-browser users (and Android WebView) load remote-shim instead
    // of preload.ts. Without this, DevelopmentPopup crashes when it calls
    // window.claude.dev.logTail (parity invariant from PITFALLS.md).
    dev: {
      logTail: (maxLines: number) =>
        invoke('dev:log-tail', maxLines),
      diagnostics: (): Promise<string> =>
        invoke('dev:diagnostics') as Promise<string>,
      summarizeIssue: (args: { kind: 'bug' | 'feature'; description: string; log?: string }) =>
        invoke('dev:summarize-issue', args),
      submitIssue: (args: { kind: 'bug' | 'feature'; title: string; summary: string; description: string; log?: string; label: 'bug' | 'enhancement' }) =>
        invoke('dev:submit-issue', args),
      installWorkspace: () =>
        invoke('dev:install-workspace'),
      onInstallProgress: (cb: (line: string) => void) => {
        // WHY: Server pushes 'dev:install-progress' events via the existing
        // WebSocket push dispatcher (handleMessage switch). Register a listener
        // using addListener/removeListener — same pattern as syncSpaces.onEvent.
        const handler: Callback = (payload: any) => cb(String(payload));
        addListener('dev:install-progress', handler);
        return () => removeListener('dev:install-progress', handler);
      },
      openSessionIn: (args: { cwd: string; initialInput?: string }) =>
        invoke('dev:open-session-in', args),
      // WHY these are here even though the server has no handler for them
      // (code review C6): this namespace is HAND-BUILT, so a member that is
      // merely absent is `undefined`, and calling it throws
      // "window.claude.dev.setupWorkspace is not a function" — a raw JavaScript
      // error shown to a phone user as the explanation for why setup failed.
      // Routing them through invoke() means the server answers `unsupported`,
      // the shim rejects with `remote-unsupported: dev:setup-workspace`, and
      // plainMessage turns that into "Developer tools isn't available via remote
      // access yet." Desktop-only has to be a REFUSAL, not an omission.
      setupWorkspace: () =>
        invoke('dev:setup-workspace'),
      setupStatus: () =>
        invoke('dev:setup-status'),
      clearSetupStatus: () =>
        invoke('dev:setup-clear'),
    },
    // First-run is desktop-only — return COMPLETE so the renderer never enters first-run mode
    firstRun: {
      getState: () => Promise.resolve({ currentStep: 'COMPLETE' }),
      retry: () => Promise.resolve(),
      // Same widened type as preload's (FirstRunState['authMode']); still a no-op here.
      startAuth: (_mode: FirstRunState['authMode']) => Promise.resolve(),
      submitApiKey: (_key: string) => Promise.resolve(),
      devModeDone: () => Promise.resolve(),
      skip: () => Promise.resolve(),
      onStateChanged: (_cb: Callback) => (() => {}),
    },
    // Android-only bridge methods — when connected to a remote desktop, these
    // return immediate defaults since the remote server doesn't handle android:* messages
    android: {
      getTier: () => targetUrl ? Promise.resolve('CORE') : invoke('android:get-tier'),
      setTier: (tier: string) => targetUrl ? Promise.resolve() : invoke('android:set-tier', { tier }),
      getAbout: () => targetUrl ? Promise.resolve({ version: '', build: '' }) : invoke('android:get-about'),
      getPairedDevices: () => targetUrl ? Promise.resolve([]) : invoke('android:get-paired-devices'),
      savePairedDevice: (device: { name: string; host: string; port: number; password: string }) =>
        targetUrl ? Promise.resolve() : invoke('android:save-paired-device', device),
      removePairedDevice: (host: string, port: number) =>
        targetUrl ? Promise.resolve() : invoke('android:remove-paired-device', { host, port }),
      scanQr: () => targetUrl ? Promise.resolve(null) : invoke('android:scan-qr'),
    },
    off: (channel: string, handler: Callback) => removeListener(channel, handler),
    removeAllListeners: (channel: string) => removeAllListeners(channel),
    getHomePath: () => invoke('get-home-path'),
    getFavorites: () => invoke('favorites:get'),
    setFavorites: (favorites: string[]) => invoke('favorites:set', favorites),
    getIncognito: () => invoke('game:getIncognito'),
    setIncognito: (incognito: boolean) => invoke('game:setIncognito', incognito),
    // Zoom — when connected to a remote desktop, delegate to the desktop's
    // Electron zoom. On local Android/browser, use CSS transform as fallback.
    zoom: (() => {
      let cssZoomLevel = 0; // Matches Electron's logarithmic scale
      const STEP = 0.5;
      const MIN = -3;
      const MAX = 5;
      const toPercent = (level: number) => Math.round(Math.pow(1.2, level) * 100);
      const applyCSS = (level: number) => {
        const scale = Math.pow(1.2, level);
        document.documentElement.style.transform = level === 0 ? '' : `scale(${scale})`;
        document.documentElement.style.transformOrigin = 'top left';
        // Adjust width so content doesn't overflow when zoomed in
        document.documentElement.style.width = level === 0 ? '' : `${100 / scale}%`;
        document.documentElement.style.height = level === 0 ? '' : `${100 / scale}%`;
      };
      return {
        zoomIn: () => {
          if (targetUrl) return invoke('zoom:in');
          cssZoomLevel = Math.min(cssZoomLevel + STEP, MAX);
          applyCSS(cssZoomLevel);
          return Promise.resolve(toPercent(cssZoomLevel));
        },
        zoomOut: () => {
          if (targetUrl) return invoke('zoom:out');
          cssZoomLevel = Math.max(cssZoomLevel - STEP, MIN);
          applyCSS(cssZoomLevel);
          return Promise.resolve(toPercent(cssZoomLevel));
        },
        reset: () => {
          if (targetUrl) return invoke('zoom:reset');
          cssZoomLevel = 0;
          applyCSS(0);
          return Promise.resolve(100);
        },
        get: () => {
          if (targetUrl) return invoke('zoom:get');
          return Promise.resolve(toPercent(cssZoomLevel));
        },
      };
    })(),
    // Multi-window detach is desktop-Electron only. Browser/Android renderers
    // get no-op stubs so SessionStrip's drag handlers, App.tsx's ownership
    // effect, and the 'Launch in New Window' toggle all degrade cleanly
    // without runtime errors. dropResolve resolves to null (no hit) so the
    // source's pointerUp falls through to the local reorder path.
    detach: {
      getDirectory: () => Promise.resolve({ leaderWindowId: -1, windows: [] }),
      onDirectoryUpdated: (_cb: (dir: any) => void) => () => {},
      onLeaderChanged: (_cb: (id: number) => void) => () => {},
      onOwnershipAcquired: (_cb: (p: any) => void) => () => {},
      onOwnershipLost: (_cb: (p: any) => void) => () => {},
      onCrossWindowCursor: (_cb: (p: any) => void) => () => {},
      detachStart: (_p: any) => {},
      dragStarted: (_p: any) => {},
      dragEnded: () => {},
      dragDropped: (_p: any) => {},
      // Claiming a dropped session is desktop-Electron only (main moves
      // ownership between windows). A browser tab or the phone has one window.
      dragAdopt: (_p: any) => {},
      focusAndSwitch: (_p: any) => {},
      openDetached: (_p: any) => {},
      requestTranscriptReplay: (_sid: string) => {},
      // Stubs: multi-window ownership is desktop-only. There is no second
      // window on the phone or in a remote browser, so nothing is ever queued
      // and there is no memory-only state to re-send — the page fetched by
      // requestTranscriptPage below is the whole story. Both must EXIST though:
      // App.tsx calls them unconditionally on mount, and a missing key is a
      // TypeError, not a no-op.
      claimPending: () => Promise.resolve([] as any[]),
      replayLiveState: (_sid: string) => Promise.resolve(),
      // A REAL call, not a stub, when a desktop is on the other end.
      // requestTranscriptReplay above shipped as a no-op and silently gave the
      // phone no history for months; paging is the only way back through a long
      // conversation, so it must reach the desktop.
      // On the phone's OWN bridge there is no pager (deliberately absent since
      // 2026-08-27, see tests/transcript-page-channel-parity.test.ts): App.tsx
      // asks for the first page of every session on launch, so the refusal is
      // quiet — the callers already treat it as "no older messages".
      requestTranscriptPage: (req: { sessionId: string; beforeCursor?: unknown; claudeSessionId?: string; projectSlug?: string }) =>
        isAndroidLocal() ? refuseQuietlyOnPhone('transcript:page') : invoke('transcript:page', {
          sessionId: req.sessionId,
          beforeCursor: req.beforeCursor ?? null,
          claudeSessionId: req.claudeSessionId,
          projectSlug: req.projectSlug,
        }),
      dropResolve: () => Promise.resolve({ targetWindowId: null as number | null }),
    },
    // Buddy floater is desktop-Electron only (MVP). Browser/Android get
    // error-throwing stubs except onAttentionSummary which returns a no-op unsubscribe.
    //
    // Current callers are gated upstream by a `?mode=buddy-*` URL param that only
    // Electron's BuddyWindowManager sets, so these throws never fire in practice.
    // If you add a NEW buddy call site in chrome shared with remote browsers (e.g.
    // a mounted control in the main chat view), guard it with optional chaining
    // or a `window.claude?.window` presence check — throwing here keeps stray
    // remote-code paths loud rather than silently succeeding.
    buddy: {
      show: () => { throw new Error('Buddy is desktop-only in this version'); },
      hide: () => { throw new Error('Buddy is desktop-only in this version'); },
      toggleChat: () => { throw new Error('Buddy is desktop-only in this version'); },
      setSession: () => { throw new Error('Buddy is desktop-only in this version'); },
      subscribe: () => { throw new Error('Buddy is desktop-only in this version'); },
      unsubscribe: () => { throw new Error('Buddy is desktop-only in this version'); },
      getViewedSession: () => { throw new Error('Buddy is desktop-only in this version'); },
      // No-op (not throw): drag handlers fire constantly while the user moves
      // the pointer; throwing would spam the console on any platform where
      // the buddy mascot window somehow loaded remote-shim (shouldn't happen,
      // but the cost of being defensive is one line).
      moveMascot: (_t: { localDx: number; localDy: number }) => { /* desktop-only */ },
      onAttentionSummary: () => () => { /* no-op unsubscribe */ },
      // ── Buddy upgrades — same desktop-only contract as the methods above.
      // dragEnded is a no-op (not a throw): it fires from a pointer handler and
      // throwing would spam the console if a buddy surface ever loaded
      // remote-shim. The on* listeners return no-op unsubscribers.
      dragEnded: () => { /* desktop-only */ },
      openMain: () => { throw new Error('Buddy is desktop-only in this version'); },
      dismiss: () => { throw new Error('Buddy is desktop-only in this version'); },
      getStatus: () => { throw new Error('Buddy is desktop-only in this version'); },
      onStatusChanged: () => () => { /* no-op unsubscribe */ },
      onBarState: () => () => { /* no-op unsubscribe */ },
      onMascotState: () => () => { /* no-op unsubscribe */ },
      onChatState: () => () => { /* no-op unsubscribe */ },
      onFocusSession: () => () => { /* no-op unsubscribe */ },
      // ── Linux Wayland overlay (Task 3+4) — same desktop-only contract:
      // listeners return no-op unsubscribers, senders are no-ops (not
      // throws) since overlaySetInteractive is a hover-hot path.
      overlayReady: async () => null, // remote has no overlay window to init
      onOverlayToggleChat: () => () => { /* no-op unsubscribe */ },
      overlaySetInteractive: (_i: boolean) => { /* desktop-only */ },
      overlayPersist: (_s: { mascot: { x: number; y: number }; dock: string | null }) => { /* desktop-only */ },
      // Task 8 — KDE keep-above is Electron-only (KWin DBus scripting has
      // no browser/Android equivalent); same desktop-only-throw contract as
      // openMain/dismiss/getStatus above.
      setKeepAbove: () => { throw new Error('Buddy is desktop-only in this version'); },
      // ── The Linux/KDE buddy helper (design §4) ──
      // Answered locally, not thrown and not sent over the wire. Two reasons.
      // First, the honest answer really is this one: a phone or a remote browser
      // has no buddy window at all, so nothing here needs a helper and the whole
      // helper UI stays hidden — which is exactly what needed:false renders.
      // Second, asking the DESKTOP would be wrong even though it can answer:
      // the reply would describe the desktop's screen, not this browser's, and
      // an "Add helper" button on a phone would change a machine the user is not
      // looking at.
      //
      // The two actions still throw, matching openMain/dismiss/getStatus above:
      // they are user-driven writes that genuinely cannot happen from here, and
      // the file's contract is that a stray remote call is loud rather than
      // silently successful.
      helperStatus: async () => ({ needed: false, supported: false, installed: false }),
      installHelper: () => { throw new Error('Buddy is desktop-only in this version'); },
      removeHelper: () => { throw new Error('Buddy is desktop-only in this version'); },
    },
    // Remote clients do not participate in buddy attention aggregation —
    // main-process aggregation is desktop-Electron only.
    attention: {
      report: () => { /* no-op: buddy attention summary is desktop-only */ },
      // Resolves empty rather than throwing: App's mount effect calls this
      // unconditionally, and remote clients get their dot colours from
      // status:data's attentionMap instead (see useAttentionSummary).
      getSummary: () => Promise.resolve({ anyNeedsAttention: false, perSession: {} }),
    },
    // WHY: useAttentionClassifier calls window.claude.terminal.getScreenText
    // every 1s on Electron to read the xterm PTY buffer for attention state
    // classification. On Android the PTY buffer lives in Kotlin (TerminalView /
    // ScreenBufferTracker), so we route through the existing WebSocket invoke
    // helper to the terminal:get-screen-text handler added in SessionService.kt
    // (Task 7). Response shape is {text: string}; normalize to Promise<string>
    // with a '' fallback for safety.
    terminal: {
      getScreenText: async (sessionId: string): Promise<string> => {
        const response = await invoke('terminal:get-screen-text', { sessionId });
        return response?.text ?? '';
      },
    },
    // GPU / performance preference — mirrors preload.ts performance namespace.
    // multiGpuDetected: false in the response means the UI section stays hidden.
    performance: {
      get: () => invoke('performance:get-config'),
      set: (preferPowerSaving: boolean) =>
        invoke('performance:set-config', { preferPowerSaving }),
    },
    // WHY: named 'app:restart' (not 'performance:restart') so any future
    // restart-required setting can reuse this single generic channel.
    app: {
      restart: () => invoke('app:restart'),
    },
    // Native runtime — desktop Electron only. false on Android/remote-browser
    // so the renderer gates the runtime selector without platform branching.
    native: {
      supported: false,
      // Object payloads match how remote-server.ts's WS cases read them
      // (payload.sessionId / payload.text / payload.binding).
      // M1: invoke — returns {status,reason} so remote UI matches desktop
      send: (sessionId: string, text: string, attachments?: string[]) => invoke('native:send', { sessionId, text, attachments }),
      // Task 11: cancel/edit a queued message — request/response (mirrors preload.ts).
      queueRemove: (sessionId: string, queueId: string) => invoke('native:queue-remove', { sessionId, queueId }),
      // Fire-and-forget: no response expected
      interrupt: (sessionId: string) => fire('native:interrupt', { sessionId }),
      // Fire-and-forget like interrupt above — the stalled card needs no answer.
      retry: (sessionId: string) => fire('native:retry', { sessionId }),
      // Request/response (mirrors preload.ts) — the remote UI needs the same
      // {ok, reason} so a refused compaction explains itself over remote too.
      compact: (sessionId: string) => invoke('native:compact', { sessionId }),
      clear: (sessionId: string) => invoke('native:clear', { sessionId }),
      invokeSkill: (sessionId: string, skill: string, args?: string) => invoke('native:invoke-skill', { sessionId, skill, args }),
      setBinding: (sessionId: string, binding: unknown) => invoke('native:set-binding', { sessionId, binding }),
      setPermissionMode: (sessionId: string, mode: string) => invoke('native:set-permission-mode', { sessionId, mode }),
      getPermissionMode: (sessionId: string) => invoke('native:get-permission-mode', { sessionId }),
      getStepGuard: () => invoke('native:get-step-guard'),
      setStepGuard: (value: number | null) => invoke('native:set-step-guard', { value }),
      sessionsList: () => invoke('native:sessions-list'),
      // G-1: NOT gated on `supported` — a phone must be able to Stop a command
      // running on the DESKTOP, whose runtime is the one that owns it.
      killShell: (sessionId: string, shellId: string) => invoke('native:kill-shell', { sessionId, shellId }),
      // One file's text for the session-context panel. NOT gated on `supported`,
      // for the same reason killShell is not: the desktop owns the session and
      // its files, and a phone looking at that chat must be able to read them.
      sessionContextText: (sessionId: string, kind: 'project' | 'user' | 'skill', id?: string) =>
        invoke('native:session-context-text', { sessionId, kind, id }),
      onSessionContext: (cb: (e: unknown) => void) => {
        const handler: Callback = (payload: any) => cb(payload);
        addListener('native:session-context', handler);
        return () => removeListener('native:session-context', handler);
      },
      onModelState: (cb: (s: unknown) => void) => {
        const handler: Callback = (payload: any) => cb(payload);
        addListener('native:model-state', handler);
        return () => removeListener('native:model-state', handler);
      },
    },
    // Provider registry — WS transport. upsert sends the config as the whole
    // payload (remote-server reads `payload` directly); remove/test read
    // payload.id; set-key reads payload.id + payload.key.
    providers: {
      list: () => invoke('provider:list'),
      upsert: (config: unknown) => invoke('provider:upsert', config),
      remove: (id: string) => invoke('provider:remove', { id }),
      test: (id: string) => invoke('provider:test', { id }),
      setKey: (id: string, key: string) => invoke('provider:set-key', { id, key }),
      catalog: () => invoke('provider:catalog'),
    },
    // Sign in with ChatGPT (backend design 2026-09-05 §5) — WS transport, no
    // payload (none of the four takes an argument). `supported: false` on
    // purpose (review R1-9): the renderer gates the card on `=== true`, and a
    // remote browser cannot run the sign-in — the browser tab and the
    // 127.0.0.1:1455 listener live on the desktop. The four invokes still exist
    // so the five-surface parity test holds and a remote caller gets an honest
    // answer (status real, sign-in false, cancel / sign-out real) instead of
    // an undefined namespace.
    chatgpt: {
      supported: false,
      status: () => invoke('chatgpt:status'),
      signIn: () => invoke('chatgpt:sign-in'),
      cancelSignIn: () => invoke('chatgpt:cancel-sign-in'),
      signOut: () => invoke('chatgpt:sign-out'),
    },
    // Claude Code's live sign-in (2026-09-09). Real over the wire: remote-server
    // answers from the DESKTOP's probe, which is the machine the session
    // actually runs on. A browser has no `claude` binary of its own, so asking
    // locally would be meaningless.
    claudeCode: {
      status: (opts?: { refresh?: boolean }) => invoke('claude-code:status', opts),
    },
    // WebSearch providers (Phase 2 Plan B) — WS transport. Object payloads match
    // remote-server's WS case reads (payload.backend / payload.key).
    search: {
      list: () => invoke('search:list'),
      setKey: (backend: string, key: string) => invoke('search:set-key', { backend, key }),
      removeKey: (backend: string) => invoke('search:remove-key', { backend }),
      test: (backend: string, key: string) => invoke('search:test', { backend, key }),
    },
    // Remembered "Always allow" rules (Settings → Permissions, M5 2a) — WS
    // transport. Object payloads match remote-server's WS case reads
    // (payload.slug / payload.rule); the desktop preload passes the same values
    // positionally. The section is NOT gated on native.supported, so this route
    // is the one a phone over remote access actually uses.
    // Object payload (this transport's convention) — remote-server.ts reads
    // payload.filePath / payload.maxBytes. Same clamp + deny list as desktop.
    fs: {
      readHead: (filePath: string, maxBytes?: number) => invoke('fs:read-head', { filePath, maxBytes }),
    },
    // Games arcade scores (spec §6.1). Object payload (this transport's
    // convention) — remote-server.ts reads payload.game / payload.score.
    arcade: {
      status: () => invoke('arcade:status'),
      leaderboard: (game: string) => invoke('arcade:leaderboard', { game }),
      submitScore: (game: string, score: number) => invoke('arcade:submit-score', { game, score }),
      // Head-to-head records. `game` is optional; the far side reads
      // payload.game and treats an absent one as "every game".
      records: (game?: string) => invoke('arcade:records', { game }),
    },
    permissions: {
      list: () => invoke('permissions:list'),
      remove: (slug: string, rule: unknown) => invoke('permissions:remove', { slug, rule }),
      removeProject: (slug: string) => invoke('permissions:remove-project', { slug }),
    },
    // Specialists 1c (Task 8) — object payloads, matching every other remote-
    // shim namespace above (permissions, search) — preload takes positional
    // args instead, same split as those.
    specialists: {
      list: (opts?: { cwd?: string; ensurePersonalFolder?: boolean }) => invoke('specialists:list', opts ?? {}),
      getDelegatedModels: () => invoke('specialists:delegated-get'),
      setDelegatedModel: (tier: 'budget' | 'frontier', binding: { providerId: string; modelId: string } | null) =>
        invoke('specialists:delegated-set', { tier, binding }),
      steer: (sessionId: string, childId: string, text: string) => invoke('specialists:steer', { sessionId, childId, text }),
      interrupt: (sessionId: string, childId: string) => invoke('specialists:interrupt', { sessionId, childId }),
    },
    // Local llama.cpp engine (Plan B). Server pushes engine:install-progress /
    // engine:status-changed via the WS dispatcher; subscriptions return an
    // unsubscribe, matching provider/dev patterns above.
    engine: {
      status: () => invoke('engine:status'),
      install: () => invoke('engine:install'),
      restart: () => invoke('engine:restart'),
      // Plan C context-length knob. Object payload matches remote-server's
      // WS case read (payload.contextSize).
      setContext: (contextSize: number) => invoke('engine:set-context', { contextSize }),
      // Every engine-wide setting in one write. The payload IS the patch —
      // remote-server reads the whole object, not a named field.
      setConfig: (patch: { contextSize?: number; speed?: { speculative?: boolean; compressCache?: boolean } }) =>
        invoke('engine:set-config', patch),
      // Opens a plain-shell session on the HOST machine and types the command
      // onto its prompt (never runs it). The remote client selects the returned
      // session the same way the desktop renderer does — through the
      // session:created broadcast that follows.
      runInTerminal: (command: string) => invoke('engine:run-in-terminal', { command }) as Promise<{ sessionId: string }>,
      // Object payload matches remote-server's WS case read (payload.backend).
      prereqs: (backend: string) => invoke('engine:prereqs', { backend }),
      onInstallProgress: (cb: (p: unknown) => void) => {
        const handler: Callback = (payload: any) => cb(payload);
        addListener('engine:install-progress', handler);
        return () => removeListener('engine:install-progress', handler);
      },
      onStatusChanged: (cb: (s: unknown) => void) => {
        const handler: Callback = (payload: any) => cb(payload);
        addListener('engine:status-changed', handler);
        return () => removeListener('engine:status-changed', handler);
      },
      models: () => invoke('engine:models'),
      onModelsChanged: (cb: (models: unknown) => void) => {
        const handler: Callback = (payload: any) => cb(payload);
        addListener('engine:models-changed', handler);
        return () => removeListener('engine:models-changed', handler);
      },
    },
    // Model manager (Plan C) — WS transport. Positional-ish payloads match how
    // remote-server.ts's WS cases read them (payload.query / payload.repo /
    // payload.quant / payload.downloadId / payload.id / payload.backend). The
    // server pushes models:download-progress via the WS dispatcher above.
    models: {
      curated: () => invoke('models:curated'),
      search: (query: string) => invoke('models:search', { query }),
      quants: (repo: string) => invoke('models:quants', { repo }),
      download: (repo: string, quant: unknown) => invoke('models:download', { repo, quant }),
      downloadCancel: (downloadId: string) => invoke('models:download-cancel', { downloadId }),
      delete: (id: string) => invoke('models:delete', { id }),
      installed: () => invoke('models:installed'),
      resume: (modelId: string) => invoke('models:resume', { modelId }),
      // Per-model settings + vision (2026-09-05). Object payloads, matching how
      // remote-server's WS cases read them (payload.modelId / payload.patch).
      // These read and write the HOST machine's engine — the remote browser is
      // only a window onto it — so the answers are the same ones the desktop
      // window gets.
      settings: (modelId: string) => invoke('models:settings', { modelId }),
      setSettings: (modelId: string, patch: unknown) => invoke('models:set-settings', { modelId, patch }),
      addVision: (modelId: string) => invoke('models:add-vision', { modelId }) as Promise<{ downloadId: string }>,
      detectEndpoints: () => invoke('endpoints:detect'),
      setBackend: (backend: string) => invoke('engine:set-backend', { backend }),
      memoryCheck: (modelId: string) => invoke('models:memory-check', { modelId }),
      load: (modelId: string) => invoke('models:load', { modelId }),
      onDownloadProgress: (cb: (p: unknown) => void) => {
        const handler: Callback = (payload: any) => cb(payload);
        addListener('models:download-progress', handler);
        return () => removeListener('models:download-progress', handler);
      },
    },
  };

  // The one intentional gap in the shared shape: voice typing exists on the
  // Android app and on the desktop, and NOWHERE else. Deleting the namespace
  // here — rather than never writing it above — is what lets the workbench's
  // indent-anchored contract scan still see it in the source.
  //
  // A remote browser tab reaches this line (its page is http/https, not file:),
  // so it gets no `voice` at all, the composer's `supported` is false, and no
  // microphone button is drawn: contract row R7.
  if (!isAndroidLocal()) delete (window as any).claude.voice;
}
