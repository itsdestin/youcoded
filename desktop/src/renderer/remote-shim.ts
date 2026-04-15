/**
 * WebSocket-backed implementation of window.claude for browser (non-Electron) access.
 * Provides the same API surface as the Electron preload bridge.
 */

// ── Marketplace types re-declared locally ─────────────────────────────────────
// WHY: remote-shim.ts lives in renderer/ and cannot import from main/ (Node.js
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

function setConnectionState(state: RemoteConnectionState) {
  connectionState = state;
  stateChangeCallback?.(state);
}

export function getConnectionState(): RemoteConnectionState {
  return connectionState;
}

export function onConnectionStateChange(cb: (state: RemoteConnectionState) => void) {
  stateChangeCallback = cb;
}

function getWsUrl(): string {
  // If a remote host override is set, use it (connectToHost sets this)
  if (targetUrl) return targetUrl;
  // Android WebView loads from file:// — connect to local bridge server
  if (location.protocol === 'file:') {
    return 'ws://localhost:9901';
  }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

function send(msg: any): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function invoke(type: string, payload?: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = `msg-${++messageId}`;
    const timeout = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Request ${type} timed out`));
      }
    }, 30_000);
    pending.set(id, { resolve, reject, timeout });
    send({ type, id, payload });
  });
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
    entry.resolve(payload);
    return;
  }

  // Push events — dispatch to registered listeners
  switch (type) {
    case 'pty:output':
      dispatchEvent('pty:output', payload.sessionId, payload.data);              // global (App.tsx mode detection)
      dispatchEvent(`pty:output:${payload.sessionId}`, payload.data);            // per-session (TerminalView)
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
    case 'session:meta-changed':
      dispatchEvent('session:meta-changed', payload.sessionId, { flag: payload.flag, value: payload.value });
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
    case 'sync:restore:progress':
      // Restore progress events flow to any listener registered via
      // window.claude.sync.restore.onProgress(). Broadcast (no sessionId).
      dispatchEvent('sync:restore:progress', payload);
      break;
  }
}

export function connect(passwordOrToken: string, isToken = false): Promise<string> {
  return new Promise((resolve, reject) => {
    setConnectionState('connecting');
    ws = new WebSocket(getWsUrl());

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
          // Store token for reconnection
          const token = msg.token;
          localStorage.setItem('destincode-remote-token', token);
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

    ws.onclose = () => {
      clearTimeout(connectTimeout);
      if (!authResolved) {
        console.error('[remote-shim] ws closed before auth, url=', getWsUrl());
        setConnectionState('disconnected');
        reject(new Error('Connection closed before auth'));
        return;
      }

      setConnectionState('disconnected');
      // Attempt reconnection — local bridge uses its own retry (token comes
      // from the URL each time), remote connections use stored session tokens.
      const isLocalBridge = location.protocol === 'file:' && !targetUrl;
      if (isLocalBridge) {
        retryLocalBridge();
      } else {
        const storedToken = localStorage.getItem('destincode-remote-token');
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
    reconnectAttempts = 0;
    reconnectDelay = 1000;
    targetUrl = null;
    localStorage.removeItem('destincode-remote-target');
    localStorage.removeItem('destincode-remote-token');
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

export function disconnect(): void {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { ws.close(); ws = null; }
  setConnectionState('disconnected');
  localStorage.removeItem('destincode-remote-token');
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
  for (const [id, entry] of pending) {
    clearTimeout(entry.timeout);
    entry.reject(new Error('Server switched'));
  }
  pending.clear();

  // Point at the desktop server (defer localStorage until auth succeeds)
  targetUrl = `ws://${host}:${port}/ws`;
  preservePlatform = true;

  try {
    await connect(password, false);
    // Connection succeeded — persist remote target for session restore
    localStorage.setItem('destincode-remote-target', targetUrl);
    preservePlatform = false;
    setConnectionMode('remote');
  } catch (err) {
    console.error('[remote-shim] connectToHost failed:', (err as Error)?.message);
    // Reset remote state and reconnect to local bridge
    targetUrl = null;
    preservePlatform = false;
    localStorage.removeItem('destincode-remote-target');
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

  for (const [id, entry] of pending) {
    clearTimeout(entry.timeout);
    entry.reject(new Error('Server switched'));
  }
  pending.clear();

  // Clear remote target — getWsUrl() falls back to localhost:9901
  targetUrl = null;
  localStorage.removeItem('destincode-remote-target');
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
    input.accept = 'image/*,text/*,.pdf,.json,.csv,.md,.ts,.tsx,.js,.jsx,.py,.rs,.go,.java,.c,.cpp,.h';
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
    localStorage.removeItem('destincode-remote-target');
    localStorage.removeItem('destincode-remote-token');
  } else {
    // Browser: restore remote target from previous session (e.g., page reload while in remote mode)
    const savedTarget = localStorage.getItem('destincode-remote-target');
    if (savedTarget) {
      targetUrl = savedTarget;
      preservePlatform = true; // Will be set on next auth:ok
      // Restore connection mode synchronously so components render correctly on first paint
      import('./platform').then(({ setConnectionMode }) => setConnectionMode('remote'));
    }
  }

  (window as any).claude = {
    session: {
      create: (opts: any) => invoke('session:create', opts),
      destroy: (sessionId: string) => invoke('session:destroy', { sessionId }),
      list: () => invoke('session:list'),
      browse: () => invoke('session:browse'),
      loadHistory: (sessionId: string, count?: number, all?: boolean, projectSlug?: string) =>
        invoke('session:history', { sessionId, count, all, projectSlug }),
      switch: (sessionId: string) => invoke('session:switch', { sessionId }),
      // Set a named flag on a past session (complete, priority, helpful).
      setFlag: (sessionId: string, flag: string, value: boolean) =>
        invoke('session:set-flag', { sessionId, flag, value }),
      sendInput: (sessionId: string, text: string) => fire('session:input', { sessionId, text }),
      resize: (sessionId: string, cols: number, rows: number) => fire('session:resize', { sessionId, cols, rows }),
      signalReady: (sessionId: string) => fire('session:terminal-ready', { sessionId }),
      respondToPermission: (requestId: string, decision: object) => invoke('permission:respond', { requestId, decision }),
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
      hookEvent: (cb: Callback) => addListener('hook:event', cb),
      statusData: (cb: Callback) => addListener('status:data', cb),
      sessionRenamed: (cb: Callback) => addListener('session:renamed', cb),
      sessionMetaChanged: (cb: Callback) => addListener('session:meta-changed', cb),
      // Android-only push event — see remote-shim handleMessage above for rationale.
      sessionPermissionMode: (cb: Callback) => addListener('session:permission-mode', cb),
      uiAction: (cb: Callback) => addListener('ui:action:received', cb),
      transcriptEvent: (cb: Callback) => addListener('transcript:event', cb),
      transcriptShrink: (cb: Callback) => addListener('transcript:shrink', cb),
      promptShow: (cb: Callback) => addListener('prompt:show', cb),
      promptDismiss: (cb: Callback) => addListener('prompt:dismiss', cb),
      promptComplete: (cb: Callback) => addListener('prompt:complete', cb),
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
    // Marketplace redesign Phase 3 — integrations namespace.
    integrations: {
      list: () => invoke('integrations:list'),
      install: (slug: string) => invoke('integrations:install', { slug }),
      uninstall: (slug: string) => invoke('integrations:uninstall', { slug }),
      status: (slug: string) => invoke('integrations:status', { slug }),
      configure: (slug: string, settings: Record<string, any>) =>
        invoke('integrations:configure', { slug, settings }),
    },
    // Phase 3: unified marketplace (packages map + per-entry config)
    marketplace: {
      getPackages: () => invoke('marketplace:get-packages'),
      getConfig: (id: string) => invoke('marketplace:get-config', { id }),
      setConfig: (id: string, values: Record<string, any>) =>
        invoke('marketplace:set-config', { id, values }),
      invalidateCache: () => invoke('marketplace:invalidate-cache'),
    },
    // Marketplace sign-in (device-code OAuth flow) — same shape as preload.ts.
    // On Android the handlers live in SessionService.kt (Task 13). Until then
    // these will time-out gracefully — no crash, just a pending Promise.
    // start/poll return ApiResult; signedIn/user/signOut have no HTTP call, no ApiResult wrapper.
    marketplaceAuth: {
      start: (): Promise<ApiResult<unknown>> => invoke('marketplace:auth:start'),
      poll: (deviceCode: string): Promise<ApiResult<unknown>> =>
        invoke('marketplace:auth:poll', { deviceCode }),
      signedIn: (): Promise<boolean> => invoke('marketplace:auth:signed-in'),
      user: (): Promise<MarketplaceUser | null> => invoke('marketplace:auth:user'),
      signOut: (): Promise<void> => invoke('marketplace:auth:sign-out'),
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
      onReload: (_cb: Callback) => (() => {}),
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
      openChangelog: async () => {},
      openExternal: async (url: string) => { window.open(url, '_blank'); },
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
      readLastModel: async () => null,
    },
    appearance: {
      get: () => invoke('appearance:get'),
      set: (prefs: Record<string, any>) => invoke('appearance:set', prefs),
      // Cross-window appearance sync is Electron-only; single-window hosts
      // don't need these but renderer code calls them unconditionally.
      broadcast: (_prefs: Record<string, any>) => {},
      onSync: (_cb: (prefs: Record<string, any>) => void) => () => {},
    },
    defaults: {
      get: () => invoke('defaults:get'),
      set: (updates: Record<string, any>) => invoke('defaults:set', updates),
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
      force: () => invoke('sync:force'),
      getLog: (lines?: number) => invoke('sync:get-log', { lines }),
      dismissWarning: (warning: string) => invoke('sync:dismiss-warning', { warning }),
      // V2: Per-instance backend management
      addBackend: (instance: any) => invoke('sync:add-backend', instance),
      removeBackend: (id: string) => invoke('sync:remove-backend', { id }),
      updateBackend: (id: string, updates: any) => invoke('sync:update-backend', { id, updates }),
      pushBackend: (id: string) => invoke('sync:push-backend', { id }),
      pullBackend: (id: string) => invoke('sync:pull-backend', { id }),
      openFolder: (id: string) => invoke('sync:open-folder', { id }),
      // Guided setup wizard
      setup: {
        checkPrereqs: (backend: string) => invoke('sync:setup:check-prereqs', { backend }),
        installRclone: () => invoke('sync:setup:install-rclone'),
        checkGdrive: () => invoke('sync:setup:check-gdrive'),
        authGdrive: () => invoke('sync:setup:auth-gdrive'),
        authGithub: () => invoke('sync:setup:auth-github'),
        createRepo: (repoName: string) => invoke('sync:setup:create-repo', { repoName }),
      },
      // Restore from backup — directional, user-initiated pull. Mirrors the
      // preload surface exactly (see preload.ts sync.restore). Browser/Android
      // transports use WebSocket invoke + a dispatchEvent subscription for progress.
      restore: {
        listVersions: (backendId: string) =>
          invoke('sync:restore:list-versions', { backendId }),
        preview: (opts: any) => invoke('sync:restore:preview', { opts }),
        execute: (opts: any) => invoke('sync:restore:execute', { opts }),
        listSnapshots: () => invoke('sync:restore:list-snapshots'),
        undo: (snapshotId: string) => invoke('sync:restore:undo', { snapshotId }),
        deleteSnapshot: (snapshotId: string) =>
          invoke('sync:restore:delete-snapshot', { snapshotId }),
        probe: (backendId: string) => invoke('sync:restore:probe', { backendId }),
        browseCategory: (backendId: string, category: string, versionRef: string) =>
          invoke('sync:restore:browse-url', { backendId, category, versionRef }),
        onProgress: (cb: (evt: any) => void) => {
          const handler: Callback = (evt: any) => cb(evt);
          addListener('sync:restore:progress', handler);
          return () => removeListener('sync:restore:progress', handler);
        },
      },
    },
    folders: {
      list: () => invoke('folders:list'),
      add: (folderPath: string, nickname?: string) => invoke('folders:add', { folderPath, nickname }),
      remove: (folderPath: string) => invoke('folders:remove', { folderPath }),
      rename: (folderPath: string, nickname: string) => invoke('folders:rename', { folderPath, nickname }),
    },
    // First-run is desktop-only — return COMPLETE so the renderer never enters first-run mode
    firstRun: {
      getState: () => Promise.resolve({ currentStep: 'COMPLETE' }),
      retry: () => Promise.resolve(),
      startAuth: (_mode: string) => Promise.resolve(),
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
    getGitHubAuth: () => invoke('github:auth'),
    getHomePath: () => invoke('get-home-path'),
    config: {
      setExperimentalFlag: (name: string, value: boolean) =>
        invoke('config:set-experimental-flag', { name, value }),
    },
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
      onDirectoryUpdated: (_cb: (dir: any) => void) => () => {},
      onLeaderChanged: (_cb: (id: number) => void) => () => {},
      onOwnershipAcquired: (_cb: (p: any) => void) => () => {},
      onOwnershipLost: (_cb: (p: any) => void) => () => {},
      onCrossWindowCursor: (_cb: (p: any) => void) => () => {},
      detachStart: (_p: any) => {},
      dragStarted: (_p: any) => {},
      dragEnded: () => {},
      dragDropped: (_p: any) => {},
      focusAndSwitch: (_p: any) => {},
      openDetached: (_p: any) => {},
      requestTranscriptReplay: (_sid: string) => {},
      dropResolve: () => Promise.resolve({ targetWindowId: null as number | null }),
    },
  };
}
