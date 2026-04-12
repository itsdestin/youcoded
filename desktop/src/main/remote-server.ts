import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { EventEmitter } from 'events';
import type { SessionManager } from './session-manager';
import type { HookRelay } from './hook-relay';
import type { RemoteConfig } from './remote-config';
import type { LocalSkillProvider } from './skill-provider';
import { BrowserWindow } from 'electron';
import { readTranscriptMeta } from './transcript-utils';
import { listPastSessions, loadHistory } from './session-browser';
import { getSyncStatus, getSyncConfig, setSyncConfig, forceSync, getSyncLog, dismissWarning, addBackend, removeBackend, updateBackend, pushBackend, pullBackend } from './sync-state';
import { checkSyncPrereqs, installRclone, checkGdriveRemote, authGdrive, authGithub, createGithubRepo } from './sync-setup-handlers';

const PTY_BUFFER_SIZE = 4 * 1024 * 1024; // 4MB per session — enough for full conversation replay
const HOOK_BUFFER_SIZE = 10_000; // ~10MB max, covers full conversations without excessive memory
const AUTH_TIMEOUT_MS = 5000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_FAILURES = 5;

interface AuthenticatedClient {
  id: string;
  ws: WebSocket;
  token: string;
  ip: string;
  connectedAt: number;
}

export interface ClientInfo {
  id: string;
  ip: string;
  connectedAt: number;
}

export class RemoteServer {
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private clients = new Set<AuthenticatedClient>();
  private tokens = new Map<string, boolean>(); // token → valid
  private tokensPath: string;
  private ptyBuffers = new Map<string, string>(); // sessionId → rolling PTY output
  private hookBuffers = new Map<string, any[]>(); // sessionId → rolling hook events
  private transcriptBuffers = new Map<string, any[]>();
  // statusInterval removed — status data now fed by ipc-handlers.ts via broadcastStatusData()
  private failedAttempts = new Map<string, { count: number; resetAt: number }>();
  // Last-known topic names, fed by ipc-handlers.ts via setLastTopic()
  private lastTopics = new Map<string, string>();
  // Last-known context remaining %, fed by ipc-handlers.ts via broadcastStatusData()
  private contextMap: Record<string, number> = {};

  constructor(
    private sessionManager: SessionManager,
    private hookRelay: HookRelay,
    private config: RemoteConfig,
    private skillProvider?: LocalSkillProvider,
  ) {
    this.tokensPath = path.join(os.homedir(), '.claude', '.remote-tokens.json');
    this.loadTokens();
  }

  private loadTokens(): void {
    try {
      const data = JSON.parse(fs.readFileSync(this.tokensPath, 'utf8'));
      if (Array.isArray(data)) {
        for (const t of data) this.tokens.set(t, true);
      }
    } catch { /* no persisted tokens yet */ }
  }

  private saveTokens(): void {
    try {
      fs.mkdirSync(path.dirname(this.tokensPath), { recursive: true });
      // Security: restrict file permissions to owner-only (prevents other users reading tokens)
      fs.writeFileSync(this.tokensPath, JSON.stringify(Array.from(this.tokens.keys())), { mode: 0o600 });
    } catch { /* best effort */ }
  }

  async start(): Promise<void> {
    if (!this.config.enabled) {
      console.log('[RemoteServer] Disabled in config, not starting');
      return;
    }

    // Subscribe to events for buffering and broadcasting
    this.sessionManager.on('pty-output', this.onPtyOutput);
    this.hookRelay.on('hook-event', this.onHookEvent);
    this.sessionManager.on('session-exit', this.onSessionExit);
    this.sessionManager.on('session-created', this.onSessionCreated);

    // Determine static file directory (production) or Vite dev server URL (development)
    const staticDir = path.join(__dirname, '..', 'renderer');
    const viteDevUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
    // In dev mode, dist/renderer/index.html doesn't exist — proxy to Vite
    const hasStaticBuild = fs.existsSync(path.join(staticDir, 'index.html'));

    this.httpServer = http.createServer((req, res) => {
      if (hasStaticBuild) {
        this.handleHttpRequest(req, res, staticDir);
      } else {
        this.proxyToVite(req, res, viteDevUrl);
      }
    });

    // Security: limit message size to 50MB to prevent memory exhaustion attacks
    this.wss = new WebSocketServer({ server: this.httpServer, path: '/ws', maxPayload: 52428800 });
    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));

    // Dev mode: proxy WebSocket upgrades (non-/ws) to Vite for HMR
    if (!hasStaticBuild) {
      this.httpServer.on('upgrade', (req, socket, head) => {
        if (req.url === '/ws') return; // handled by our WebSocketServer
        // Use http:// URL — WebSocket upgrade is an HTTP request with Upgrade header
        const proxyUrl = new URL(req.url || '/', viteDevUrl);
        const proxyReq = http.request(proxyUrl, {
          method: 'GET',
          headers: req.headers,
        });
        proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
          socket.write(
            `HTTP/1.1 101 Switching Protocols\r\n` +
            Object.entries(proxyRes.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') +
            '\r\n\r\n'
          );
          if (proxyHead.length) socket.write(proxyHead);
          proxySocket.pipe(socket);
          socket.pipe(proxySocket);
        });
        proxyReq.on('error', () => socket.destroy());
        proxyReq.end();
      });
    }

    // Status data is now fed by ipc-handlers.ts via broadcastStatusData() —
    // no independent polling needed. This eliminates duplicate file reads.

    // Cleanup uploaded files older than 1 hour
    const uploadDir = path.join(os.tmpdir(), 'claude-desktop-uploads');
    setInterval(async () => {
      try {
        const files = await fs.promises.readdir(uploadDir);
        const now = Date.now();
        for (const file of files) {
          try {
            const stat = await fs.promises.stat(path.join(uploadDir, file));
            if (now - stat.mtimeMs > 3600_000) {
              await fs.promises.unlink(path.join(uploadDir, file));
            }
          } catch {}
        }
      } catch {}
    }, 3600_000);

    // Topic names are tracked by ipc-handlers.ts and forwarded via setLastTopic() + broadcast()

    return new Promise<void>((resolve) => {
      this.httpServer!.listen(this.config.port, () => {
        console.log(`[RemoteServer] Listening on port ${this.config.port}`);
        resolve();
      });
    });
  }

  /** Store a topic name for replay on new connections. Called by ipc-handlers.ts. */
  setLastTopic(desktopId: string, name: string): void {
    this.lastTopics.set(desktopId, name);
  }

  /** Broadcast status data to all connected remote clients. Called by ipc-handlers.ts
   *  so that both the local renderer and remote clients share the same polling cycle. */
  broadcastStatusData(data: Record<string, any>): void {
    this.contextMap = data.contextMap || {};
    this.broadcast({ type: 'status:data', payload: data });
  }

  stop(): void {
    this.lastTopics.clear();
    this.transcriptBuffers.clear();
    this.sessionManager.off('pty-output', this.onPtyOutput);
    this.hookRelay.off('hook-event', this.onHookEvent);
    this.sessionManager.off('session-exit', this.onSessionExit);
    this.sessionManager.off('session-created', this.onSessionCreated);

    for (const client of this.clients) {
      client.ws.close(1001, 'Server shutting down');
    }
    this.clients.clear();
    this.tokens.clear();

    if (this.wss) { this.wss.close(); this.wss = null; }
    if (this.httpServer) { this.httpServer.close(); this.httpServer = null; }
  }

  /** Invalidate all session tokens (e.g., after password change). */
  invalidateTokens(): void {
    this.tokens.clear();
    this.saveTokens();
    for (const client of this.clients) {
      client.ws.close(4001, 'Password changed');
    }
    this.clients.clear();
  }

  /** Number of currently connected remote clients. */
  getClientCount(): number {
    return this.clients.size;
  }

  /** List all connected remote clients. */
  getClientList(): ClientInfo[] {
    return Array.from(this.clients).map(c => ({
      id: c.id,
      ip: c.ip,
      connectedAt: c.connectedAt,
    }));
  }

  /** Disconnect a specific client by ID. */
  disconnectClient(clientId: string): boolean {
    for (const client of this.clients) {
      if (client.id === clientId) {
        client.ws.close(4002, 'Disconnected by admin');
        this.clients.delete(client);
        return true;
      }
    }
    return false;
  }

  // --- Event handlers for buffering ---

  private onPtyOutput = (sessionId: string, data: string) => {
    // Append to rolling buffer
    let buf = this.ptyBuffers.get(sessionId) || '';
    buf += data;
    if (buf.length > PTY_BUFFER_SIZE) {
      buf = buf.slice(buf.length - PTY_BUFFER_SIZE);
    }
    this.ptyBuffers.set(sessionId, buf);

    // Broadcast live
    this.broadcast({ type: 'pty:output', payload: { sessionId, data } });
  };

  private onHookEvent = (event: any) => {
    const sessionId = event.sessionId || '';

    // Append to rolling buffer
    let buf = this.hookBuffers.get(sessionId) || [];
    buf.push(event);
    if (buf.length > HOOK_BUFFER_SIZE) {
      buf = buf.slice(buf.length - HOOK_BUFFER_SIZE);
    }
    this.hookBuffers.set(sessionId, buf);

    // Broadcast live
    this.broadcast({ type: 'hook:event', payload: event });
  };

  private onSessionCreated = (info: any) => {
    this.broadcast({ type: 'session:created', payload: info });
  };

  private onSessionExit = (sessionId: string, exitCode: number = 0) => {
    this.ptyBuffers.delete(sessionId);
    this.hookBuffers.delete(sessionId);
    this.transcriptBuffers.delete(sessionId);
    this.lastTopics.delete(sessionId);
    // Forward exitCode so the remote shim can surface 'session-died' banners
    // when Claude's process dies mid-turn on the host machine.
    this.broadcast({ type: 'session:destroyed', payload: { sessionId, exitCode } });
  };

  bufferTranscriptEvent(event: any): void {
    const sessionId = event.sessionId || '';
    let buf = this.transcriptBuffers.get(sessionId) || [];
    buf.push(event);
    if (buf.length > HOOK_BUFFER_SIZE) {
      buf = buf.slice(buf.length - HOOK_BUFFER_SIZE);
    }
    this.transcriptBuffers.set(sessionId, buf);
  }

  // --- HTTP static file serving ---

  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse, staticDir: string): void {
    const url = req.url || '/';
    let filePath: string;

    if (url === '/' || url === '/index.html') {
      filePath = path.join(staticDir, 'index.html');
    } else {
      // Prevent directory traversal — decode percent-encoding first
      const decoded = decodeURIComponent(url);
      const safePath = path.normalize(decoded).replace(/^(\.\.[\/\\])+/, '');
      filePath = path.join(staticDir, safePath);
    }

    // Verify the resolved path is within staticDir
    if (!filePath.startsWith(staticDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        // SPA fallback — serve index.html for non-file routes
        fs.readFile(path.join(staticDir, 'index.html'), (err2, html) => {
          if (err2) {
            res.writeHead(404);
            res.end('Not found');
          } else {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(html);
          }
        });
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
        '.woff': 'font/woff',
        '.woff2': 'font/woff2',
      };
      res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
      res.end(data);
    });
  }

  // --- Dev mode: proxy HTTP requests to Vite dev server ---

  private proxyToVite(req: http.IncomingMessage, res: http.ServerResponse, viteUrl: string): void {
    const url = new URL(req.url || '/', viteUrl);
    const proxyReq = http.request(url, {
      method: req.method,
      headers: req.headers,
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', () => {
      res.writeHead(502);
      res.end('Vite dev server not available');
    });
    req.pipe(proxyReq);
  }

  // --- WebSocket connection handling ---

  private handleConnection(ws: WebSocket, req: http.IncomingMessage): void {
    const ip = req.socket.remoteAddress || '';

    // Check rate limiting
    if (this.isRateLimited(ip)) {
      ws.close(4029, 'Too many failed attempts');
      return;
    }

    // Auto-accept Tailscale-trusted connections
    if (this.config.trustTailscale && this.config.isTailscaleIp(ip)) {
      const token = randomUUID();
      this.tokens.set(token, true);
      this.saveTokens();
      this.config.markPaired();
      this.addClient(ws, token, ip);
      ws.send(JSON.stringify({ type: 'auth:ok', token, platform: 'desktop' }));
      this.replayBuffers(ws);
      return;
    }

    // Auth timeout
    const timeout = setTimeout(() => {
      ws.close(4000, 'Auth timeout');
    }, AUTH_TIMEOUT_MS);

    // Wait for auth message
    const authHandler = async (raw: Buffer | string) => {
      clearTimeout(timeout);
      ws.off('message', authHandler);

      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type !== 'auth') {
          ws.send(JSON.stringify({ type: 'auth:failed', reason: 'expected-auth' }));
          ws.close(4000, 'Expected auth');
          return;
        }

        // No password configured
        if (!this.config.passwordHash) {
          ws.send(JSON.stringify({ type: 'auth:failed', reason: 'no-password-configured' }));
          ws.close(4000, 'No password configured');
          return;
        }

        let authenticated = false;

        if (msg.token && this.tokens.has(msg.token)) {
          authenticated = true;
        } else if (msg.password) {
          authenticated = await this.config.verifyPassword(msg.password);
        }

        if (authenticated) {
          this.clearFailedAttempts(ip);
          const token = msg.token && this.tokens.has(msg.token) ? msg.token : randomUUID();
          this.tokens.set(token, true);
          this.saveTokens();
          this.config.markPaired();
          this.addClient(ws, token, ip);
          ws.send(JSON.stringify({ type: 'auth:ok', token, platform: 'desktop' }));
          this.replayBuffers(ws);
        } else {
          this.recordFailedAttempt(ip);
          ws.send(JSON.stringify({ type: 'auth:failed', reason: 'invalid-credentials' }));
          ws.close(4001, 'Auth failed');
        }
      } catch {
        ws.send(JSON.stringify({ type: 'auth:failed', reason: 'invalid-message' }));
        ws.close(4000, 'Invalid auth message');
      }
    };

    ws.on('message', authHandler);
  }

  private addClient(ws: WebSocket, token: string, ip: string): void {
    const client: AuthenticatedClient = { id: randomUUID(), ws, token, ip, connectedAt: Date.now() };
    this.clients.add(client);

    ws.on('message', (raw) => this.handleMessage(client, raw as Buffer | string));
    ws.on('close', () => this.clients.delete(client));
    ws.on('error', () => this.clients.delete(client));
  }

  // --- Replay buffers on new connection ---

  private replayBuffers(ws: WebSocket): void {
    // Session list — sent immediately so client can initialize chat state
    const sessions = this.sessionManager.listSessions();
    ws.send(JSON.stringify({
      type: 'session:list:response',
      id: '_replay',
      payload: sessions,
    }));

    for (const session of sessions) {
      ws.send(JSON.stringify({ type: 'session:created', payload: session }));
    }

    // Send current topic names for all mapped sessions
    for (const [desktopId, name] of this.lastTopics) {
      ws.send(JSON.stringify({ type: 'session:renamed', payload: { sessionId: desktopId, name } }));
    }

    // Delay PTY + hook replay to give the client time to process SESSION_INIT.
    // Without this delay, hook events arrive before the chat reducer has
    // initialized the session state, and all events are silently dropped.
    setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) return;

      // PTY buffers
      for (const [sessionId, buf] of this.ptyBuffers) {
        if (buf.length > 0) {
          ws.send(JSON.stringify({ type: 'pty:output', payload: { sessionId, data: buf } }));
        }
      }

      // Hook event buffers
      for (const [_sessionId, events] of this.hookBuffers) {
        for (const event of events) {
          ws.send(JSON.stringify({ type: 'hook:event', payload: event }));
        }
      }

      // Transcript event buffers
      for (const [_sessionId, events] of this.transcriptBuffers) {
        for (const event of events) {
          ws.send(JSON.stringify({ type: 'transcript:event', payload: event }));
        }
      }
    }, 500); // 500ms gives React time to render App and register SESSION_INIT
  }

  // --- Message routing ---

  private async handleMessage(client: AuthenticatedClient, raw: Buffer | string): Promise<void> {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const { type, id, payload } = msg;

    switch (type) {
      // --- Request/response ---
      case 'session:create': {
        const info = this.sessionManager.createSession(payload);
        this.respond(client.ws, type, id, info);
        // session:created broadcast is handled by the onSessionCreated event listener
        break;
      }
      case 'session:destroy': {
        const result = this.sessionManager.destroySession(payload.sessionId || payload);
        this.respond(client.ws, type, id, result);
        if (result) {
          this.broadcast({ type: 'session:destroyed', payload: { sessionId: payload.sessionId || payload } });
        }
        break;
      }
      case 'session:list': {
        const sessions = this.sessionManager.listSessions();
        this.respond(client.ws, type, id, sessions);
        break;
      }
      case 'session:switch': {
        // Session switching is client-side state — acknowledge so the request doesn't time out
        this.respond(client.ws, type, id, { ok: true });
        break;
      }
      case 'session:browse': {
        const activeIds = new Set(this.sessionManager.listSessions().map(s => s.id));
        const sessions = await listPastSessions(activeIds);
        this.respond(client.ws, type, id, sessions);
        break;
      }
      case 'session:history': {
        const { sessionId: histSessionId, count, all } = payload;
        // Find the JSONL file across all project slugs
        const projectsDir = path.join(os.homedir(), '.claude', 'projects');
        const slugs = await fs.promises.readdir(projectsDir).catch(() => [] as string[]);
        let foundSlug = '';
        for (const slug of slugs) {
          const candidate = path.join(projectsDir, slug, histSessionId + '.jsonl');
          try {
            await fs.promises.access(candidate);
            foundSlug = slug;
            break;
          } catch {}
        }
        if (!foundSlug) {
          this.respond(client.ws, type, id, []);
          break;
        }
        const history = await loadHistory(histSessionId, foundSlug, count, all);
        this.respond(client.ws, type, id, history);
        break;
      }
      case 'permission:respond': {
        const { requestId, decision } = payload;
        const result = this.hookRelay.respond(requestId, decision);
        this.respond(client.ws, type, id, result);
        break;
      }
      case 'skills:list': {
        const skills = this.skillProvider ? await this.skillProvider.getInstalled() : [];
        this.respond(client.ws, type, id, skills);
        break;
      }
      case 'skills:list-marketplace': {
        const result = this.skillProvider ? await this.skillProvider.listMarketplace(payload) : [];
        this.respond(client.ws, type, id, result);
        break;
      }
      case 'skills:get-detail': {
        const result = this.skillProvider ? await this.skillProvider.getSkillDetail(payload.id) : null;
        this.respond(client.ws, type, id, result);
        break;
      }
      case 'skills:search': {
        const result = this.skillProvider ? await this.skillProvider.search(payload.query) : [];
        this.respond(client.ws, type, id, result);
        break;
      }
      case 'skills:install': {
        const installResult = this.skillProvider
          ? await this.skillProvider.install(payload.id)
          : { status: 'failed' as const, error: 'Skill provider not initialized' };
        // Reload plugins in all active sessions so Claude Code discovers the
        // new plugin immediately — matches Android behavior (SessionService.kt:458)
        if (installResult.status === 'installed' && 'type' in installResult && installResult.type === 'plugin') {
          for (const s of this.sessionManager.listSessions()) {
            if (s.status === 'active') this.sessionManager.sendInput(s.id, '/reload-plugins\r');
          }
        }
        this.respond(client.ws, type, id, installResult);
        break;
      }
      case 'skills:uninstall': {
        const uninstallResult = this.skillProvider
          ? await this.skillProvider.uninstall(payload.id)
          : { type: 'prompt' as const };
        // Reload plugins so Claude Code drops the uninstalled plugin — matches
        // Android behavior (SessionService.kt:490)
        if (uninstallResult.type === 'plugin') {
          for (const s of this.sessionManager.listSessions()) {
            if (s.status === 'active') this.sessionManager.sendInput(s.id, '/reload-plugins\r');
          }
        }
        this.respond(client.ws, type, id, { ok: true });
        break;
      }
      case 'skills:get-favorites': {
        const result = this.skillProvider ? await this.skillProvider.getFavorites() : [];
        this.respond(client.ws, type, id, result);
        break;
      }
      case 'skills:set-favorite': {
        if (this.skillProvider) await this.skillProvider.setFavorite(payload.id, payload.favorited);
        this.respond(client.ws, type, id, { ok: true });
        break;
      }
      case 'skills:get-chips': {
        const result = this.skillProvider ? await this.skillProvider.getChips() : [];
        this.respond(client.ws, type, id, result);
        break;
      }
      case 'skills:set-chips': {
        if (this.skillProvider) await this.skillProvider.setChips(payload.chips);
        this.respond(client.ws, type, id, { ok: true });
        break;
      }
      case 'skills:get-override': {
        const overrides = this.skillProvider ? await this.skillProvider.getOverrides() : {};
        this.respond(client.ws, type, id, overrides[payload.id] || null);
        break;
      }
      case 'skills:set-override': {
        if (this.skillProvider) await this.skillProvider.setOverride(payload.id, payload.override);
        this.respond(client.ws, type, id, { ok: true });
        break;
      }
      case 'skills:create-prompt': {
        const result = this.skillProvider ? await this.skillProvider.createPromptSkill(payload) : null;
        this.respond(client.ws, type, id, result);
        break;
      }
      case 'skills:delete-prompt': {
        if (this.skillProvider) await this.skillProvider.deletePromptSkill(payload.id);
        this.respond(client.ws, type, id, { ok: true });
        break;
      }
      case 'skills:publish': {
        const result = this.skillProvider ? await this.skillProvider.publish(payload.id) : null;
        this.respond(client.ws, type, id, result);
        break;
      }
      case 'skills:get-share-link': {
        const result = this.skillProvider ? await this.skillProvider.generateShareLink(payload.id) : '';
        this.respond(client.ws, type, id, result);
        break;
      }
      case 'skills:import-from-link': {
        const result = this.skillProvider ? await this.skillProvider.importFromLink(payload.encoded) : null;
        this.respond(client.ws, type, id, result);
        break;
      }
      case 'skills:get-curated-defaults': {
        const result = this.skillProvider ? await this.skillProvider.getCuratedDefaults() : [];
        this.respond(client.ws, type, id, result);
        break;
      }
      case 'file:upload': {
        const uploadDir = path.join(os.tmpdir(), 'claude-desktop-uploads');
        try {
          await fs.promises.mkdir(uploadDir, { recursive: true });
          // Sanitize filename — strip path separators and limit length
          const rawName = String(payload.name || 'upload').replace(/[/\\:*?"<>|]/g, '_').slice(0, 200);
          const filePath = path.join(uploadDir, `${Date.now()}-${rawName}`);
          const buffer = Buffer.from(payload.data, 'base64');
          await fs.promises.writeFile(filePath, buffer);
          this.respond(client.ws, type, id, { path: filePath });
        } catch (err) {
          this.respond(client.ws, type, id, { error: 'Upload failed' });
        }
        break;
      }
      case 'model:get-preference': {
        const modelPrefPath = path.join(os.homedir(), '.claude', 'destincode-model.json');
        try {
          const raw = await fs.promises.readFile(modelPrefPath, 'utf8');
          const parsed = JSON.parse(raw);
          this.respond(client.ws, type, id, parsed.model || 'sonnet');
        } catch {
          this.respond(client.ws, type, id, 'sonnet');
        }
        break;
      }
      case 'model:set-preference': {
        const modelPrefPath = path.join(os.homedir(), '.claude', 'destincode-model.json');
        const model = payload.model || payload;
        try {
          await fs.promises.mkdir(path.dirname(modelPrefPath), { recursive: true });
          await fs.promises.writeFile(modelPrefPath, JSON.stringify({ model }));
          this.respond(client.ws, type, id, true);
        } catch {
          this.respond(client.ws, type, id, false);
        }
        break;
      }
      case 'appearance:get': {
        const appearancePath = path.join(os.homedir(), '.claude', 'destincode-appearance.json');
        try {
          const raw = await fs.promises.readFile(appearancePath, 'utf8');
          this.respond(client.ws, type, id, JSON.parse(raw));
        } catch {
          this.respond(client.ws, type, id, null);
        }
        break;
      }
      case 'appearance:set': {
        const appearancePath = path.join(os.homedir(), '.claude', 'destincode-appearance.json');
        try {
          let existing: Record<string, any> = {};
          try {
            existing = JSON.parse(await fs.promises.readFile(appearancePath, 'utf8'));
          } catch {}
          const merged = { ...existing, ...payload };
          await fs.promises.mkdir(path.dirname(appearancePath), { recursive: true });
          await fs.promises.writeFile(appearancePath, JSON.stringify(merged));
          this.respond(client.ws, type, id, true);
        } catch {
          this.respond(client.ws, type, id, false);
        }
        break;
      }
      case 'defaults:get': {
        const defaultsPrefPath = path.join(os.homedir(), '.claude', 'destincode-defaults.json');
        const DEFAULTS_INITIAL = { skipPermissions: false, model: 'sonnet', projectFolder: '' };
        try {
          const raw = await fs.promises.readFile(defaultsPrefPath, 'utf8');
          this.respond(client.ws, type, id, { ...DEFAULTS_INITIAL, ...JSON.parse(raw) });
        } catch {
          this.respond(client.ws, type, id, { ...DEFAULTS_INITIAL });
        }
        break;
      }
      case 'defaults:set': {
        const defaultsPrefPath = path.join(os.homedir(), '.claude', 'destincode-defaults.json');
        const DEFAULTS_INITIAL = { skipPermissions: false, model: 'sonnet', projectFolder: '' };
        try {
          let current = { ...DEFAULTS_INITIAL };
          try { current = { ...current, ...JSON.parse(await fs.promises.readFile(defaultsPrefPath, 'utf8')) }; } catch {}
          const merged = { ...current, ...payload };
          await fs.promises.writeFile(defaultsPrefPath, JSON.stringify(merged, null, 2));
          this.respond(client.ws, type, id, merged);
        } catch {
          this.respond(client.ws, type, id, null);
        }
        break;
      }
      case 'get-home-path': {
        this.respond(client.ws, type, id, os.homedir());
        break;
      }
      // Claude Code settings.json bridge — mirrors ipc-handlers.ts 'settings:get'/'settings:set'.
      // Dot-path keys supported (e.g. 'permissions.defaultMode').
      case 'settings:get': {
        const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
        try {
          const raw = await fs.promises.readFile(claudeSettingsPath, 'utf-8');
          const parsed = JSON.parse(raw);
          const field: string = (payload as any)?.field ?? '';
          const value = field.split('.').reduce((obj: any, k) => (obj == null ? undefined : obj[k]), parsed);
          this.respond(client.ws, type, id, value);
        } catch {
          this.respond(client.ws, type, id, undefined);
        }
        break;
      }
      // Fast + effort mode persistence — mirrors ipc-handlers.ts 'modes:get'/'modes:set'.
      case 'modes:get': {
        const modelModesPath = path.join(os.homedir(), '.claude', 'destincode-model-modes.json');
        try {
          const raw = await fs.promises.readFile(modelModesPath, 'utf-8');
          this.respond(client.ws, type, id, JSON.parse(raw));
        } catch {
          this.respond(client.ws, type, id, { fast: false, effort: 'auto' });
        }
        break;
      }
      case 'modes:set': {
        const modelModesPath = path.join(os.homedir(), '.claude', 'destincode-model-modes.json');
        try {
          let current = { fast: false, effort: 'auto' } as Record<string, any>;
          try { current = { ...current, ...JSON.parse(await fs.promises.readFile(modelModesPath, 'utf-8')) }; } catch {}
          const merged = { ...current, ...(payload as Record<string, any>) };
          await fs.promises.mkdir(path.dirname(modelModesPath), { recursive: true });
          await fs.promises.writeFile(modelModesPath, JSON.stringify(merged));
          this.respond(client.ws, type, id, merged);
        } catch {
          this.respond(client.ws, type, id, null);
        }
        break;
      }
      case 'settings:set': {
        const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
        try {
          let existing: Record<string, any> = {};
          try { existing = JSON.parse(await fs.promises.readFile(claudeSettingsPath, 'utf-8')); } catch {}
          const field: string = (payload as any)?.field ?? '';
          const value = (payload as any)?.value;
          const keys = field.split('.');
          let cursor = existing;
          for (let i = 0; i < keys.length - 1; i++) {
            const k = keys[i];
            if (cursor[k] == null || typeof cursor[k] !== 'object') cursor[k] = {};
            cursor = cursor[k];
          }
          if (value === null || value === undefined) {
            delete cursor[keys[keys.length - 1]];
          } else {
            cursor[keys[keys.length - 1]] = value;
          }
          await fs.promises.mkdir(path.dirname(claudeSettingsPath), { recursive: true });
          await fs.promises.writeFile(claudeSettingsPath, JSON.stringify(existing, null, 2));
          this.respond(client.ws, type, id, true);
        } catch {
          this.respond(client.ws, type, id, false);
        }
        break;
      }
      case 'folders:list': {
        const foldersPrefPath = path.join(os.homedir(), '.claude', 'destincode-folders.json');
        try {
          const raw = await fs.promises.readFile(foldersPrefPath, 'utf8');
          let folders = JSON.parse(raw);
          if (!Array.isArray(folders)) folders = [];
          if (folders.length === 0) {
            const home = os.homedir();
            folders = [{ path: home, nickname: 'Home', addedAt: Date.now() }];
            await fs.promises.writeFile(foldersPrefPath, JSON.stringify(folders, null, 2));
          }
          const annotated = folders.map((f: any) => ({ ...f, exists: fs.existsSync(f.path) }));
          this.respond(client.ws, type, id, annotated);
        } catch {
          const home = os.homedir();
          const folders = [{ path: home, nickname: 'Home', addedAt: Date.now(), exists: true }];
          this.respond(client.ws, type, id, folders);
        }
        break;
      }
      case 'folders:add': {
        const foldersPrefPath = path.join(os.homedir(), '.claude', 'destincode-folders.json');
        try {
          let folders: any[] = [];
          try { folders = JSON.parse(await fs.promises.readFile(foldersPrefPath, 'utf8')); } catch {}
          if (!Array.isArray(folders)) folders = [];
          const normalized = path.resolve(payload.folderPath);
          if (folders.some((f: any) => path.resolve(f.path) === normalized)) {
            this.respond(client.ws, type, id, folders.find((f: any) => path.resolve(f.path) === normalized));
            break;
          }
          const entry = { path: normalized, nickname: payload.nickname || path.basename(normalized), addedAt: Date.now() };
          folders.unshift(entry);
          await fs.promises.mkdir(path.dirname(foldersPrefPath), { recursive: true });
          await fs.promises.writeFile(foldersPrefPath, JSON.stringify(folders, null, 2));
          this.respond(client.ws, type, id, entry);
        } catch {
          this.respond(client.ws, type, id, null);
        }
        break;
      }
      case 'folders:remove': {
        const foldersPrefPath = path.join(os.homedir(), '.claude', 'destincode-folders.json');
        try {
          let folders: any[] = [];
          try { folders = JSON.parse(await fs.promises.readFile(foldersPrefPath, 'utf8')); } catch {}
          if (!Array.isArray(folders)) folders = [];
          const normalized = path.resolve(payload.folderPath);
          const filtered = folders.filter((f: any) => path.resolve(f.path) !== normalized);
          if (filtered.length === folders.length) { this.respond(client.ws, type, id, false); break; }
          await fs.promises.writeFile(foldersPrefPath, JSON.stringify(filtered, null, 2));
          this.respond(client.ws, type, id, true);
        } catch {
          this.respond(client.ws, type, id, false);
        }
        break;
      }
      case 'folders:rename': {
        const foldersPrefPath = path.join(os.homedir(), '.claude', 'destincode-folders.json');
        try {
          let folders: any[] = [];
          try { folders = JSON.parse(await fs.promises.readFile(foldersPrefPath, 'utf8')); } catch {}
          if (!Array.isArray(folders)) folders = [];
          const normalized = path.resolve(payload.folderPath);
          const entry = folders.find((f: any) => path.resolve(f.path) === normalized);
          if (!entry) { this.respond(client.ws, type, id, false); break; }
          entry.nickname = payload.nickname;
          await fs.promises.writeFile(foldersPrefPath, JSON.stringify(folders, null, 2));
          this.respond(client.ws, type, id, true);
        } catch {
          this.respond(client.ws, type, id, false);
        }
        break;
      }
      case 'favorites:get': {
        const favPath = path.join(os.homedir(), '.claude', 'destinclaude-favorites.json');
        try {
          const data = await fs.promises.readFile(favPath, 'utf8');
          this.respond(client.ws, type, id, JSON.parse(data));
        } catch {
          this.respond(client.ws, type, id, { favorites: [] });
        }
        break;
      }
      case 'favorites:set': {
        const favPath = path.join(os.homedir(), '.claude', 'destinclaude-favorites.json');
        let existing: Record<string, any> = {};
        try { existing = JSON.parse(await fs.promises.readFile(favPath, 'utf8')); } catch {}
        existing.favorites = payload.favorites ?? payload;
        await fs.promises.writeFile(favPath, JSON.stringify(existing, null, 2));
        this.respond(client.ws, type, id, { ok: true });
        break;
      }
      case 'game:getIncognito': {
        const gPath = path.join(os.homedir(), '.claude', 'destinclaude-favorites.json');
        try {
          const data = JSON.parse(await fs.promises.readFile(gPath, 'utf8'));
          this.respond(client.ws, type, id, data.incognito ?? false);
        } catch {
          this.respond(client.ws, type, id, false);
        }
        break;
      }
      case 'game:setIncognito': {
        const gPath = path.join(os.homedir(), '.claude', 'destinclaude-favorites.json');
        let existing: Record<string, any> = {};
        try { existing = JSON.parse(await fs.promises.readFile(gPath, 'utf8')); } catch {}
        existing.incognito = payload;
        await fs.promises.writeFile(gPath, JSON.stringify(existing, null, 2));
        this.respond(client.ws, type, id, { ok: true });
        break;
      }
      case 'transcript:read-meta': {
        const transcriptPath = payload.path || payload;
        const claudeProjects = path.join(os.homedir(), '.claude', 'projects');
        const resolvedPath = path.resolve(transcriptPath);
        if (!resolvedPath.startsWith(claudeProjects)) {
          this.respond(client.ws, type, id, null);
          break;
        }
        try {
          const meta = await readTranscriptMeta(transcriptPath);
          this.respond(client.ws, type, id, meta);
        } catch {
          this.respond(client.ws, type, id, null);
        }
        break;
      }
      case 'github:auth': {
        try {
          const { execFile } = require('child_process');
          const { promisify } = require('util');
          const execFileAsync = promisify(execFile);
          let ghPath = 'gh';
          try { const w = require('which'); ghPath = w.sync('gh'); } catch { /* use bare 'gh' */ }
          const { stdout: username } = await execFileAsync(ghPath, ['api', 'user', '--jq', '.login']);
          console.log(`[remote] github:auth — username '${username.trim()}' requested by ${(client.ws as any)._socket?.remoteAddress || 'unknown'}`);
          // Return username only — raw token is not forwarded to remote clients
          this.respond(client.ws, type, id, { username: username.trim() });
        } catch {
          this.respond(client.ws, type, id, null);
        }
        break;
      }
      case 'remote:get-config': {
        const config = {
          ...this.config.toSafeObject(),
          clientCount: this.getClientCount(),
        };
        this.respond(client.ws, type, id, config);
        break;
      }
      case 'remote:set-password': {
        // Security: only allow password changes from local connections (not remote clients)
        const isLocal = client.ip === '127.0.0.1' || client.ip === '::1' || client.ip === '::ffff:127.0.0.1';
        if (!isLocal) {
          this.respond(client.ws, type, id, { error: 'Password change only allowed from local connection' });
          break;
        }
        await this.config.setPassword(payload);
        this.invalidateTokens();
        this.respond(client.ws, type, id, true);
        break;
      }
      case 'remote:set-config': {
        if (typeof payload.enabled === 'boolean') this.config.enabled = payload.enabled;
        if (typeof payload.trustTailscale === 'boolean') this.config.trustTailscale = payload.trustTailscale;
        if (typeof payload.keepAwakeHours === 'number') this.config.keepAwakeHours = payload.keepAwakeHours;
        this.config.save();
        this.respond(client.ws, type, id, this.config.toSafeObject());
        break;
      }
      case 'remote:detect-tailscale': {
        const { RemoteConfig } = require('./remote-config');
        const result = await RemoteConfig.detectTailscale(this.config.port);
        this.respond(client.ws, type, id, result);
        break;
      }
      case 'remote:get-client-count': {
        this.respond(client.ws, type, id, this.getClientCount());
        break;
      }
      case 'remote:get-client-list': {
        this.respond(client.ws, type, id, this.getClientList());
        break;
      }
      case 'remote:disconnect-client': {
        const result = this.disconnectClient(payload.clientId || payload);
        this.respond(client.ws, type, id, result);
        break;
      }

      // --- Sync management ---
      case 'sync:get-status': {
        const syncStatus = await getSyncStatus();
        this.respond(client.ws, type, id, syncStatus);
        break;
      }
      case 'sync:get-config': {
        const syncConfig = await getSyncConfig();
        this.respond(client.ws, type, id, syncConfig);
        break;
      }
      case 'sync:set-config': {
        const updatedConfig = await setSyncConfig(payload.updates || payload);
        this.respond(client.ws, type, id, updatedConfig);
        break;
      }
      case 'sync:force': {
        const syncResult = await forceSync();
        this.respond(client.ws, type, id, syncResult);
        break;
      }
      case 'sync:get-log': {
        const logLines = await getSyncLog(payload?.lines);
        this.respond(client.ws, type, id, logLines);
        break;
      }
      case 'sync:dismiss-warning': {
        await dismissWarning(payload.warning || payload);
        this.respond(client.ws, type, id, { ok: true });
        break;
      }

      // V2: Per-instance backend management (remote browser parity)
      case 'sync:add-backend': {
        const added = await addBackend(payload);
        this.respond(client.ws, type, id, added);
        break;
      }
      case 'sync:remove-backend': {
        await removeBackend(payload.id || payload);
        this.respond(client.ws, type, id, { ok: true });
        break;
      }
      case 'sync:update-backend': {
        const updated = await updateBackend(payload.id, payload.updates);
        this.respond(client.ws, type, id, updated);
        break;
      }
      case 'sync:push-backend': {
        const pushResult = await pushBackend(payload.id || payload);
        this.respond(client.ws, type, id, pushResult);
        break;
      }
      case 'sync:pull-backend': {
        const pullResult = await pullBackend(payload.id || payload);
        this.respond(client.ws, type, id, pullResult);
        break;
      }
      case 'sync:open-folder': {
        // Remote clients can't open local folders — return the URL for them to open manually.
        // For Drive, resolve the actual sync folder ID via rclone so the client deep-links
        // to the synced folder, not just drive.google.com's homepage.
        const cfg = await getSyncConfig();
        const backend = cfg.backends.find((b: any) => b.id === (payload.id || payload));
        let url = '';
        if (backend?.type === 'drive') {
          const rcloneRemote = backend.config?.rcloneRemote || 'gdrive';
          const driveRoot = backend.config?.DRIVE_ROOT || 'Claude';
          try {
            const { execFile } = require('child_process');
            const stdout: string = await new Promise((resolve, reject) => {
              execFile(
                'rclone',
                ['lsjson', `${rcloneRemote}:${driveRoot}/Backup`, '--dirs-only'],
                { timeout: 15000 },
                (err: any, out: string) => (err ? reject(err) : resolve(String(out || ''))),
              );
            });
            const entries = JSON.parse(stdout) as Array<{ Name: string; ID?: string }>;
            const match = entries.find((e) => e.Name === 'personal' && e.ID);
            url = match?.ID
              ? `https://drive.google.com/drive/folders/${match.ID}`
              : 'https://drive.google.com';
          } catch {
            url = 'https://drive.google.com';
          }
        } else if (backend?.type === 'github') {
          url = backend.config?.PERSONAL_SYNC_REPO || '';
        }
        this.respond(client.ws, type, id, { url });
        break;
      }

      // Guided setup wizard (prerequisite detection, install, OAuth, repo creation)
      case 'sync:setup:check-prereqs': {
        const prereqs = await checkSyncPrereqs(payload.backend || payload);
        this.respond(client.ws, type, id, prereqs);
        break;
      }
      case 'sync:setup:install-rclone': {
        const installResult = await installRclone();
        this.respond(client.ws, type, id, installResult);
        break;
      }
      case 'sync:setup:check-gdrive': {
        const gdriveCheck = await checkGdriveRemote();
        this.respond(client.ws, type, id, gdriveCheck);
        break;
      }
      case 'sync:setup:auth-gdrive': {
        const gdriveAuth = await authGdrive();
        this.respond(client.ws, type, id, gdriveAuth);
        break;
      }
      case 'sync:setup:auth-github': {
        const ghAuth = await authGithub();
        this.respond(client.ws, type, id, ghAuth);
        break;
      }
      case 'sync:setup:create-repo': {
        const repoResult = await createGithubRepo(payload.repoName || payload);
        this.respond(client.ws, type, id, repoResult);
        break;
      }

      // --- UI state sync: broadcast actions to all OTHER clients ---
      case 'ui:action': {
        const data = JSON.stringify({ type: 'ui:action', payload });
        for (const c of this.clients) {
          if (c !== client && c.ws.readyState === WebSocket.OPEN) {
            c.ws.send(data);
          }
        }
        // Also forward to Electron window via IPC if this came from a remote client
        this.sessionManager.emit('ui-action', payload);
        break;
      }

      // --- Zoom controls (applies to the desktop Electron window) ---
      case 'zoom:in':
      case 'zoom:out':
      case 'zoom:reset':
      case 'zoom:get': {
        const win = BrowserWindow.getAllWindows()[0];
        if (!win || win.isDestroyed()) {
          this.respond(client.ws, type, id, 100);
          break;
        }
        const ZOOM_STEP = 0.5;
        const ZOOM_MIN = -3;
        const ZOOM_MAX = 5;
        const toPercent = (l: number) => Math.round(Math.pow(1.2, l) * 100);
        const wc = win.webContents;
        if (type === 'zoom:in') {
          wc.setZoomLevel(Math.min(wc.getZoomLevel() + ZOOM_STEP, ZOOM_MAX));
        } else if (type === 'zoom:out') {
          wc.setZoomLevel(Math.max(wc.getZoomLevel() - ZOOM_STEP, ZOOM_MIN));
        } else if (type === 'zoom:reset') {
          wc.setZoomLevel(0);
        }
        this.respond(client.ws, type, id, toPercent(wc.getZoomLevel()));
        break;
      }

      // --- Fire-and-forget ---
      case 'session:input': {
        this.sessionManager.sendInput(payload.sessionId, payload.text);
        break;
      }
      case 'session:resize': {
        this.sessionManager.resizeSession(payload.sessionId, payload.cols, payload.rows);
        break;
      }
      case 'session:terminal-ready': {
        // Remote clients don't need the buffering gate that ipc-handlers uses,
        // because we replay the PTY buffer on connect instead.
        break;
      }
    }
  }

  // --- Helpers ---

  private respond(ws: WebSocket, type: string, id: string, payload: any): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: `${type}:response`, id, payload }));
    }
  }

  broadcast(msg: { type: string; payload: any }): void {
    const data = JSON.stringify(msg);
    for (const client of this.clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data);
      }
    }
  }

  // --- Rate limiting ---

  private isRateLimited(ip: string): boolean {
    const entry = this.failedAttempts.get(ip);
    if (!entry) return false;
    if (Date.now() > entry.resetAt) {
      this.failedAttempts.delete(ip);
      return false;
    }
    return entry.count >= RATE_LIMIT_MAX_FAILURES;
  }

  private recordFailedAttempt(ip: string): void {
    const entry = this.failedAttempts.get(ip);
    if (entry && Date.now() < entry.resetAt) {
      entry.count++;
    } else {
      this.failedAttempts.set(ip, { count: 1, resetAt: Date.now() + RATE_LIMIT_WINDOW_MS });
    }
  }

  private clearFailedAttempts(ip: string): void {
    this.failedAttempts.delete(ip);
  }
}

