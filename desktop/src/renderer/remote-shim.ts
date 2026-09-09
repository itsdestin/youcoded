/**
 * WebSocket-backed implementation of window.claude for browser (non-Electron) access.
 * Provides the same API surface as the Electron preload bridge.
 */

// Type-only, so nothing is added to the bundle the Android WebView loads.
import type { VoiceReadiness } from '../shared/voice-types';

// ── Marketplace types re-declared locally ─────────────────────────────────────
// WHY: remote-shim.ts lives in renderer/ and cannot import from main/ (Node.js
import { REMOTE_UNSUPPORTED_EVENT, remoteFeatureName, remoteUnsupportedMessage } from './remote-unsupported';
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
}

export type RemoteConnectionState = 'disconnected' | 'connecting' | 'authenticating' | 'connected';

let ws: WebSocket | null = null;
let messageId = 0;
const pending = new Map<string, PendingRequest>();
const listeners = new Map<string, Set<Callback>>();
let connectionState: RemoteConnectionState = 'disconnected';
let stateChangeCallback: ((state: RemoteConnectionState) => void) | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30_000;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

/** Override WebSocket target — set by connectToHost(), cleared by disconnectFromHost() */
let targetUrl: string | null = null;
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
let pendingSendQueue: string[] = [];

function setConnectionState(state: RemoteConnectionState) {
  connectionState = state;
  stateChangeCallback?.(state);
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

function send(msg: any): void {
  const data = JSON.stringify(msg);
  // Only send directly when both the socket is OPEN AND auth has completed.
  // If OPEN but still 'authenticating', the auth message has been sent but
  // 'auth:ok' hasn't arrived — the bridge rejects application messages here,
  // so we still queue.
  if (ws?.readyState === WebSocket.OPEN && connectionState === 'connected') {
    ws.send(data);
    return;
  }
  if (pendingSendQueue.length >= MAX_QUEUE) {
    console.warn('[remote-shim] send queue overflow — dropping oldest');
    pendingSendQueue.shift();
  }
  pendingSendQueue.push(data);
}

// Flush queued application messages once auth:ok has resolved.
// Called ONLY from inside the auth:ok branch — never from ws.onopen, since
// the bridge rejects application traffic before auth completes.
function flushSendQueue(): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const queued = pendingSendQueue;
  pendingSendQueue = [];
  for (const data of queued) {
    try { ws.send(data); } catch (e) {
      console.error('[remote-shim] flush failed:', e);
    }
  }
}

// Default 30s is fine for anything interactive, but long-running sync
// operations (rclone copy of 100s of files over cellular, git push of a large
// repo, etc.) can legitimately take minutes. Callers pass a larger timeoutMs
// for those — see `sync.force` below.
function invoke(type: string, payload?: any, opts?: { timeoutMs?: number }): Promise<any> {
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  return new Promise((resolve, reject) => {
    const id = `msg-${++messageId}`;
    const timeout = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Request ${type} timed out`));
      }
    }, timeoutMs);
    pending.set(id, { resolve, reject, timeout });
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
  const feature = remoteFeatureName(channel);
  if (announced.has(feature)) return;
  announced.add(feature);
  console.warn(`[remote-shim] not available over remote access: ${channel}`);
  window.dispatchEvent(new CustomEvent(REMOTE_UNSUPPORTED_EVENT, {
    detail: { channel, feature, message: remoteUnsupportedMessage(channel) },
  }));
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

function fire(type: string, payload: any): void {
  send({ type, payload });
}

function addListener(channel: string, cb: Callback): Callback {
  let set = listeners.get(channel);
  if (!set) {
    set = new Set();
    listeners.set(channel, set);
  }
  set.add(cb);
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

function handleMessage(data: string): void {
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
    case 'pty:output':
      dispatchEvent('pty:output', payload.sessionId, payload.data);              // global (App.tsx mode detection)
      dispatchEvent(`pty:output:${payload.sessionId}`, payload.data);            // per-session (TerminalView)
      break;
    case 'pty:raw-bytes':
      // Per-session dispatch only — no global consumer (xterm is per-session).
      // Payload data is base64-encoded raw PTY bytes from Android's
      // RawByteListener (Tier 1). usePtyRawBytes decodes to Uint8Array.
      dispatchEvent(`pty:raw-bytes:${payload.sessionId}`, payload.data);
      break;
    case 'hook:event':
      dispatchEvent('hook:event', payload);
      break;
    case 'session:created':
      dispatchEvent('session:created', payload);
      break;
    case 'session:destroyed':
      // Forward exitCode alongside id so the chat reducer can surface
      // 'session-died' when a turn was in flight. Default 0 for older bridges.
      dispatchEvent(
        'session:destroyed',
        payload.sessionId || payload,
        typeof payload?.exitCode === 'number' ? payload.exitCode : 0,
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
      // Full chat state snapshot sent by the host when a remote client connects.
      // Dispatched into the chat reducer via window.claude.on.chatHydrate in App.tsx.
      dispatchEvent('chat:hydrate', payload);
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
    setConnectionState('connecting');
    ws = new WebSocket(getWsUrl());

    // Track whether the socket ever got to OPEN. Lets onclose tell the difference
    // between "couldn't reach host" (TCP refused, Android cleartext block,
    // firewall) and "reached server but it closed without a proper auth reply"
    // (rate limit 4029, server auth timeout 4000) — the previous generic
    // "Connection closed before auth" error hid both cases.
    let didOpen = false;

    // Timeout if WebSocket stays in CONNECTING state (network unreachable, etc.)
    const connectTimeout = setTimeout(() => {
      if (ws && ws.readyState === WebSocket.CONNECTING) {
        console.error('[remote-shim] connect timeout to', getWsUrl());
        ws.close();
        ws = null;
        setConnectionState('disconnected');
        reject(new Error('Connection timed out'));
      }
    }, 15_000);

    ws.onopen = () => {
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
          ? { type: 'auth', token: passwordOrToken }
          : { type: 'auth', password: passwordOrToken };
      ws!.send(JSON.stringify(authMsg));
    };

    let authResolved = false;

    ws.onmessage = (event) => {
      if (!authResolved) {
        let msg: any;
        try { msg = JSON.parse(event.data); } catch { return; }

        if (msg.type === 'auth:ok') {
          authResolved = true;
          reconnectDelay = 1000; // Reset backoff on success
          reconnectAttempts = 0;
          console.log('[remote-shim] auth:ok from', getWsUrl());
          setConnectionState('connected');
          // Fix: drain any messages queued during the cold-start window
          // (mount-time fetches that fired before auth completed). Must be
          // here, not in ws.onopen — the bridge rejects pre-auth traffic.
          flushSendQueue();
          // Store token for reconnection
          const token = msg.token;
          localStorage.setItem('youcoded-remote-token', token);
          // Preserve __PLATFORM__ when connecting to a remote desktop from Android —
          // the desktop server responds with platform:"electron" but we're still on a phone
          if (!preservePlatform) {
            const platform = msg.platform || 'browser';
            (window as any).__PLATFORM__ = platform;
          }
          resolve(token);
          // Switch to normal message handling
          ws!.onmessage = (e) => handleMessage(e.data as string);
        } else if (msg.type === 'auth:failed') {
          authResolved = true;
          console.error('[remote-shim] auth:failed', msg.reason);
          setConnectionState('disconnected');
          reject(new Error(msg.reason || 'Authentication failed'));
          ws!.close();
        }
        return;
      }

      handleMessage(event.data as string);
    };

    ws.onclose = (event) => {
      clearTimeout(connectTimeout);
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
        reject(new Error(message));
        return;
      }

      setConnectionState('disconnected');
      // Attempt reconnection — local bridge uses its own retry (token comes
      // from the URL each time), remote connections use stored session tokens.
      const isLocalBridge = location.protocol === 'file:' && !targetUrl;
      if (isLocalBridge) {
        retryLocalBridge();
      } else {
        const storedToken = localStorage.getItem('youcoded-remote-token');
        if (storedToken) {
          scheduleReconnect(storedToken);
        }
      }
    };

    ws.onerror = () => {
      // onclose will fire after this
    };
  });
}

function scheduleReconnect(token: string): void {
  // After too many failures, give up and fall back to local mode
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
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
    } catch {
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
      scheduleReconnect(token);
    }
  }, reconnectDelay);
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
  if (ws) { ws.close(); ws = null; }
  setConnectionState('disconnected');
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
      sendInput: (sessionId: string, text: string) => fire('session:input', { sessionId, text }),
      resize: (sessionId: string, cols: number, rows: number) => fire('session:resize', { sessionId, cols, rows }),
      signalReady: (sessionId: string) => fire('session:terminal-ready', { sessionId }),
      respondToPermission: (requestId: string, decision: object) => invoke('permission:respond', { requestId, decision }),
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
      // there, and window.open from a promise callback is a no-op (the same
      // trap SessionService.kt's sync:restore:browse-url comment records) — a
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
      setConfig: (updates: { enabled?: boolean; trustTailscale?: boolean }) =>
        invoke('remote:set-config', updates),
      detectTailscale: () => invoke('remote:detect-tailscale'),
      getClientCount: () => invoke('remote:get-client-count'),
      getClientList: () => invoke('remote:get-client-list'),
      disconnectClient: (clientId: string) => invoke('remote:disconnect-client', clientId),
      broadcastAction: (action: any) => fire('ui:action', action),
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
      // Cross-window appearance sync is Electron-only; single-window hosts
      // don't need these but renderer code calls them unconditionally.
      broadcast: (_prefs: Record<string, any>) => {},
      onSync: (_cb: (prefs: Record<string, any>) => void) => () => {},
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
      status: () => invoke('syncspaces:status'),
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
      listProjectsIndex: (opts?: { withCounts?: boolean }) =>
        invoke('artifacts:list-projects-index', opts ?? {}),
      // This transport sends an OBJECT payload, not positional args — `full`
      // has to be spread in by name or it is dropped silently.
      get: (projectRoot: string, artifactId: string, opts?: { full?: boolean }) =>
        invoke('artifacts:get', { projectRoot, artifactId, full: opts?.full }),
      // NOT bridged by remote-server.ts — this and artifacts:get both fall to
      // its `default:` case and answer { unsupported: true }, so the artifact
      // pane opens nothing at all from a remote browser against a desktop host.
      // Kept wired for when that bridge lands (ROADMAP #remote).
      readBinary: (absolutePath: string) =>
        invoke('artifacts:read-binary', { absolutePath }),
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
      // A REAL call, not a stub. requestTranscriptReplay above shipped as a
      // no-op and silently gave the phone no history for months; paging is the
      // phone's only way back through a long conversation, so it must reach the
      // desktop.
      requestTranscriptPage: (req: { sessionId: string; beforeCursor?: unknown; claudeSessionId?: string; projectSlug?: string }) =>
        invoke('transcript:page', {
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
