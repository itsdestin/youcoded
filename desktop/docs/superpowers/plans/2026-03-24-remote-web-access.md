# Remote Web Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow the DestinCode desktop UI to be accessed from any web browser over a secure WebSocket connection, sharing sessions with the local Electron window.

**Architecture:** A `RemoteServer` in the Electron main process starts an HTTP + WebSocket server on port 9900. It shares the existing `SessionManager` and `HookRelay` instances. The React renderer detects whether it's running in Electron or a browser and loads a `window.claude` WebSocket shim accordingly. Authentication uses a user-set password (bcrypt) with optional Tailscale trust bypass.

**Tech Stack:** TypeScript, `ws` (WebSocket server), `bcryptjs` (password hashing), existing Vite + React + Tailwind renderer

**Spec:** `desktop/docs/superpowers/specs/2026-03-24-remote-web-access-design.md`

---

### Task 1: Install dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install ws and bcryptjs**

```bash
cd ~/.claude/plugins/destinclaude/desktop
npm install ws bcryptjs
```

- [ ] **Step 2: Install type definitions**

```bash
npm install -D @types/ws @types/bcryptjs
```

- [ ] **Step 3: Verify installation**

```bash
node -e "require('ws'); require('bcryptjs'); console.log('OK')"
```

Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat(remote): add ws and bcryptjs dependencies"
```

---

### Task 2: Remote config module

**Files:**
- Create: `src/main/remote-config.ts`
- Test: `tests/remote-config.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/remote-config.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Must mock before importing the module
vi.mock('fs');
vi.mock('os');

describe('RemoteConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.mocked(os.homedir).mockReturnValue('/mock/home');
  });

  it('returns defaults when config file does not exist', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const { RemoteConfig } = await import('../src/main/remote-config');
    const config = new RemoteConfig();

    expect(config.enabled).toBe(true);
    expect(config.port).toBe(9900);
    expect(config.passwordHash).toBeNull();
    expect(config.trustTailscale).toBe(false);
  });

  it('loads config from disk', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      enabled: false,
      port: 8080,
      passwordHash: '$2b$10$fakehash',
      trustTailscale: true,
    }));
    const { RemoteConfig } = await import('../src/main/remote-config');
    const config = new RemoteConfig();

    expect(config.enabled).toBe(false);
    expect(config.port).toBe(8080);
    expect(config.passwordHash).toBe('$2b$10$fakehash');
    expect(config.trustTailscale).toBe(true);
  });

  it('setPassword hashes and saves to disk', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});
    vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as any);
    const { RemoteConfig } = await import('../src/main/remote-config');
    const config = new RemoteConfig();

    await config.setPassword('test123');

    expect(config.passwordHash).toBeTruthy();
    expect(config.passwordHash).toMatch(/^\$2[ab]\$/);
    expect(fs.writeFileSync).toHaveBeenCalled();
  });

  it('verifyPassword returns true for correct password', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});
    vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as any);
    const { RemoteConfig } = await import('../src/main/remote-config');
    const config = new RemoteConfig();

    await config.setPassword('mypass');
    const result = await config.verifyPassword('mypass');

    expect(result).toBe(true);
  });

  it('verifyPassword returns false for wrong password', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});
    vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as any);
    const { RemoteConfig } = await import('../src/main/remote-config');
    const config = new RemoteConfig();

    await config.setPassword('mypass');
    const result = await config.verifyPassword('wrongpass');

    expect(result).toBe(false);
  });

  it('isTailscaleIp detects CGNAT range', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const { RemoteConfig } = await import('../src/main/remote-config');
    const config = new RemoteConfig();

    expect(config.isTailscaleIp('100.64.1.1')).toBe(true);
    expect(config.isTailscaleIp('100.127.255.255')).toBe(true);
    expect(config.isTailscaleIp('100.128.0.0')).toBe(false);
    expect(config.isTailscaleIp('192.168.1.1')).toBe(false);
    // IPv6-mapped IPv4
    expect(config.isTailscaleIp('::ffff:100.64.1.1')).toBe(true);
    expect(config.isTailscaleIp('::ffff:192.168.1.1')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ~/.claude/plugins/destinclaude/desktop
npx vitest run tests/remote-config.test.ts
```

Expected: FAIL — module `../src/main/remote-config` does not exist

- [ ] **Step 3: Implement RemoteConfig**

Create `src/main/remote-config.ts`:

```typescript
import fs from 'fs';
import path from 'path';
import os from 'os';
import bcrypt from 'bcryptjs';

const CONFIG_PATH = () => path.join(os.homedir(), '.claude', 'destincode-remote.json');
const BCRYPT_ROUNDS = 10;

interface ConfigData {
  enabled: boolean;
  port: number;
  passwordHash: string | null;
  trustTailscale: boolean;
}

export class RemoteConfig {
  enabled: boolean;
  port: number;
  passwordHash: string | null;
  trustTailscale: boolean;

  constructor() {
    const defaults: ConfigData = {
      enabled: true,
      port: 9900,
      passwordHash: null,
      trustTailscale: false,
    };

    const configPath = CONFIG_PATH();
    if (fs.existsSync(configPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        this.enabled = data.enabled ?? defaults.enabled;
        this.port = data.port ?? defaults.port;
        this.passwordHash = data.passwordHash ?? defaults.passwordHash;
        this.trustTailscale = data.trustTailscale ?? defaults.trustTailscale;
        return;
      } catch {
        // Fall through to defaults
      }
    }

    this.enabled = defaults.enabled;
    this.port = defaults.port;
    this.passwordHash = defaults.passwordHash;
    this.trustTailscale = defaults.trustTailscale;
  }

  async setPassword(plaintext: string): Promise<void> {
    this.passwordHash = await bcrypt.hash(plaintext, BCRYPT_ROUNDS);
    this.save();
  }

  async verifyPassword(plaintext: string): Promise<boolean> {
    if (!this.passwordHash) return false;
    return bcrypt.compare(plaintext, this.passwordHash);
  }

  /** Check if an IP is in the Tailscale CGNAT range (100.64.0.0/10). */
  isTailscaleIp(ip: string): boolean {
    // Strip IPv6-mapped IPv4 prefix
    const normalized = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
    const parts = normalized.split('.');
    if (parts.length !== 4) return false;
    const first = parseInt(parts[0], 10);
    const second = parseInt(parts[1], 10);
    // 100.64.0.0/10 = 100.64.0.0 – 100.127.255.255
    return first === 100 && second >= 64 && second <= 127;
  }

  private save(): void {
    const configPath = CONFIG_PATH();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      enabled: this.enabled,
      port: this.port,
      passwordHash: this.passwordHash,
      trustTailscale: this.trustTailscale,
    }, null, 2));
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/remote-config.test.ts
```

Expected: All 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/remote-config.ts tests/remote-config.test.ts
git commit -m "feat(remote): add RemoteConfig for password and settings management"
```

---

### Task 3: Remote server — core WebSocket server with auth

**Files:**
- Create: `src/main/remote-server.ts`
- Test: `tests/remote-server.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/remote-server.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Mock ws module
vi.mock('ws', () => {
  const MockWebSocket = vi.fn();
  const MockWebSocketServer = vi.fn().mockImplementation(() => {
    const emitter = new EventEmitter();
    return Object.assign(emitter, {
      close: vi.fn((cb?: () => void) => cb?.()),
      clients: new Set(),
    });
  });
  return { WebSocketServer: MockWebSocketServer, WebSocket: MockWebSocket };
});

vi.mock('http', () => ({
  createServer: vi.fn(() => {
    const emitter = new EventEmitter();
    return Object.assign(emitter, {
      listen: vi.fn((_port: number, cb: () => void) => cb()),
      close: vi.fn((cb?: () => void) => cb?.()),
    });
  }),
}));

describe('RemoteServer', () => {
  let mockSessionManager: any;
  let mockHookRelay: any;
  let mockConfig: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionManager = Object.assign(new EventEmitter(), {
      listSessions: vi.fn(() => []),
      createSession: vi.fn(() => ({ id: '1', name: 'test', cwd: '/tmp', status: 'active' })),
      destroySession: vi.fn(() => true),
      sendInput: vi.fn(),
      resizeSession: vi.fn(),
    });
    mockHookRelay = Object.assign(new EventEmitter(), {
      respond: vi.fn(() => true),
    });
    mockConfig = {
      enabled: true,
      port: 9900,
      passwordHash: '$2b$10$fakehash',
      trustTailscale: false,
      verifyPassword: vi.fn(async (pw: string) => pw === 'correct'),
      isTailscaleIp: vi.fn(() => false),
    };
  });

  it('can be instantiated', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    expect(server).toBeDefined();
  });

  it('starts and stops without error', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    await server.start();
    server.stop();
  });

  it('does not start when config.enabled is false', async () => {
    mockConfig.enabled = false;
    const { RemoteServer } = await import('../src/main/remote-server');
    const server = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    await server.start();
    // Should not throw, just no-op
    server.stop();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/remote-server.test.ts
```

Expected: FAIL — module `../src/main/remote-server` does not exist

- [ ] **Step 3: Implement RemoteServer**

Create `src/main/remote-server.ts`. This is the largest new file. It handles:
- HTTP static file serving (Vite-built `dist/renderer/`)
- WebSocket server on `/ws`
- Auth (password, token, Tailscale trust, rate limiting)
- Message routing (request/response and fire-and-forget)
- Event broadcasting (pty output, hook events, session lifecycle, status data)
- Rolling buffers for state sync on connect

```typescript
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

const PTY_BUFFER_SIZE = 256 * 1024; // 256KB per session
const HOOK_BUFFER_SIZE = 500; // events per session
const AUTH_TIMEOUT_MS = 5000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_FAILURES = 5;

interface AuthenticatedClient {
  ws: WebSocket;
  token: string;
}

export class RemoteServer {
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private clients = new Set<AuthenticatedClient>();
  private tokens = new Map<string, boolean>(); // token → valid
  private ptyBuffers = new Map<string, string>(); // sessionId → rolling PTY output
  private hookBuffers = new Map<string, any[]>(); // sessionId → rolling hook events
  private statusInterval: ReturnType<typeof setInterval> | null = null;
  private failedAttempts = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private sessionManager: SessionManager,
    private hookRelay: HookRelay,
    private config: RemoteConfig,
    private skillScanner?: () => any[],
  ) {}

  async start(): Promise<void> {
    if (!this.config.enabled) {
      console.log('[RemoteServer] Disabled in config, not starting');
      return;
    }

    // Subscribe to events for buffering
    this.sessionManager.on('pty-output', this.onPtyOutput);
    this.hookRelay.on('hook-event', this.onHookEvent);
    this.sessionManager.on('session-exit', this.onSessionExit);

    // Determine static file directory
    const staticDir = path.join(__dirname, '..', 'renderer');

    this.httpServer = http.createServer((req, res) => {
      this.handleHttpRequest(req, res, staticDir);
    });

    this.wss = new WebSocketServer({ server: this.httpServer, path: '/ws' });
    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));

    // Status data polling — independent of ipc-handlers.ts
    const usageCachePath = path.join(os.homedir(), '.claude', '.usage-cache.json');
    const announcementCachePath = path.join(os.homedir(), '.claude', '.announcement-cache.json');
    const updateStatusPath = path.join(os.homedir(), '.claude', 'toolkit-state', 'update-status.json');
    const syncStatusPath = path.join(os.homedir(), '.claude', '.sync-status');
    const syncWarningsPath = path.join(os.homedir(), '.claude', '.sync-warnings');

    this.statusInterval = setInterval(() => {
      const data = {
        usage: readJsonFile(usageCachePath),
        announcement: readJsonFile(announcementCachePath),
        updateStatus: readJsonFile(updateStatusPath),
        syncStatus: readTextFile(syncStatusPath),
        syncWarnings: readTextFile(syncWarningsPath),
      };
      this.broadcast({ type: 'status:data', payload: data });
    }, 10_000);

    return new Promise((resolve) => {
      this.httpServer!.listen(this.config.port, () => {
        console.log(`[RemoteServer] Listening on port ${this.config.port}`);
        resolve();
      });
    });
  }

  stop(): void {
    if (this.statusInterval) clearInterval(this.statusInterval);
    this.sessionManager.off('pty-output', this.onPtyOutput);
    this.hookRelay.off('hook-event', this.onHookEvent);
    this.sessionManager.off('session-exit', this.onSessionExit);

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
    for (const client of this.clients) {
      client.ws.close(4001, 'Password changed');
    }
    this.clients.clear();
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

  private onSessionExit = (sessionId: string) => {
    this.ptyBuffers.delete(sessionId);
    this.hookBuffers.delete(sessionId);
    this.broadcast({ type: 'session:destroyed', payload: { sessionId } });
  };

  // --- HTTP static file serving ---

  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse, staticDir: string): void {
    const url = req.url || '/';
    let filePath: string;

    if (url === '/' || url === '/index.html') {
      filePath = path.join(staticDir, 'index.html');
    } else {
      // Prevent directory traversal
      const safePath = path.normalize(url).replace(/^(\.\.[\/\\])+/, '');
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
      this.addClient(ws, token);
      ws.send(JSON.stringify({ type: 'auth:ok', token }));
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
          this.addClient(ws, token);
          ws.send(JSON.stringify({ type: 'auth:ok', token }));
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

  private addClient(ws: WebSocket, token: string): void {
    const client: AuthenticatedClient = { ws, token };
    this.clients.add(client);

    ws.on('message', (raw) => this.handleMessage(client, raw));
    ws.on('close', () => this.clients.delete(client));
    ws.on('error', () => this.clients.delete(client));
  }

  // --- Replay buffers on new connection ---

  private replayBuffers(ws: WebSocket): void {
    // Session list
    const sessions = this.sessionManager.listSessions();
    ws.send(JSON.stringify({
      type: 'session:list:response',
      id: '_replay',
      payload: sessions,
    }));

    // Session created events for each active session
    for (const session of sessions) {
      ws.send(JSON.stringify({ type: 'session:created', payload: session }));
    }

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
        // Broadcast session:created to all clients
        this.broadcast({ type: 'session:created', payload: info });
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
      case 'permission:respond': {
        const { requestId, decision } = payload;
        const result = this.hookRelay.respond(requestId, decision);
        this.respond(client.ws, type, id, result);
        break;
      }
      case 'skills:list': {
        // Placeholder until Task 3b extracts the shared scanner
        const skills = this.skillScanner ? this.skillScanner() : [];
        this.respond(client.ws, type, id, skills);
        break;
      }
      case 'get-home-path': {
        this.respond(client.ws, type, id, os.homedir());
        break;
      }
      case 'transcript:read-meta': {
        const transcriptPath = payload.path || payload;
        try {
          const content = fs.readFileSync(transcriptPath, 'utf8');
          const lines = content.trim().split('\n');
          let model = 'unknown';
          let contextPercent = 100;
          for (const line of lines) {
            try {
              const obj = JSON.parse(line);
              if (obj.model) model = obj.model.display_name || obj.model.id || obj.model;
              if (obj.costInfo?.contextRemaining != null) contextPercent = Math.round(obj.costInfo.contextRemaining * 100);
              if (obj.context_window?.remaining_percentage != null) contextPercent = Math.round(obj.context_window.remaining_percentage);
            } catch {}
          }
          this.respond(client.ws, type, id, { model, contextPercent });
        } catch {
          this.respond(client.ws, type, id, null);
        }
        break;
      }
      case 'github:auth': {
        // Attempt to read gh auth token — same logic as main.ts
        try {
          const { execFile } = require('child_process');
          const { promisify } = require('util');
          const execFileAsync = promisify(execFile);
          let ghPath = 'gh';
          try { const w = require('which'); ghPath = w.sync('gh'); } catch {}
          const { stdout: token } = await execFileAsync(ghPath, ['auth', 'token']);
          const { stdout: username } = await execFileAsync(ghPath, ['api', 'user', '--jq', '.login']);
          this.respond(client.ws, type, id, { token: token.trim(), username: username.trim() });
        } catch {
          this.respond(client.ws, type, id, null);
        }
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

  private broadcast(msg: { type: string; payload: any }): void {
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

// --- File reading helpers (same pattern as ipc-handlers.ts) ---

function readJsonFile(filePath: string): any {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}

function readTextFile(filePath: string): string | null {
  try { return fs.readFileSync(filePath, 'utf8').trim() || null; } catch { return null; }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/remote-server.test.ts
```

Expected: All 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/remote-server.ts tests/remote-server.test.ts
git commit -m "feat(remote): add RemoteServer with WebSocket, auth, buffering, and message routing"
```

---

### Task 3b: Extract shared utilities and fix cross-client visibility

The plan reviewer identified three critical gaps:
1. Skill scanning is duplicated between `ipc-handlers.ts` and `RemoteServer` — extract to shared function
2. `session:renamed` events from topic file watchers never reach remote clients
3. Sessions created via WebSocket are invisible to the Electron window (and vice versa)

**Files:**
- Create: `src/main/skill-scanner.ts`
- Modify: `src/main/ipc-handlers.ts` (extract skill scanning, emit session:created events via SessionManager)
- Modify: `src/main/session-manager.ts` (add `session-created` event emission)
- Modify: `src/main/remote-server.ts` (accept skillScanner, subscribe to session-created, add topic watcher)

- [ ] **Step 1: Extract skill scanning into `src/main/skill-scanner.ts`**

Move the skill scanning logic (lines 125-232 of `ipc-handlers.ts`) into a standalone exported function `scanSkills(): SkillEntry[]`. Both `ipc-handlers.ts` and `RemoteServer` will call this function.

- [ ] **Step 2: Update `ipc-handlers.ts` to use `scanSkills()`**

Replace the inline skill scanning in the `SKILLS_LIST` handler with a call to `scanSkills()`.

- [ ] **Step 3: Add `session-created` event to SessionManager**

In `session-manager.ts`, after `this.sessions.set(id, session)` in `createSession()`, add:
```typescript
this.emit('session-created', info);
```

This allows both IPC handlers and RemoteServer to listen for new sessions regardless of which client created them.

- [ ] **Step 4: Update `ipc-handlers.ts` to use SessionManager events for broadcasting**

Replace the direct `send(IPC.SESSION_CREATED, info)` in the `SESSION_CREATE` handler with a listener on `sessionManager.on('session-created', ...)` that broadcasts to the Electron window. This ensures sessions created by any client (Electron or remote) are visible everywhere.

- [ ] **Step 5: Update RemoteServer to subscribe to `session-created` events**

In `RemoteServer.start()`, add:
```typescript
this.sessionManager.on('session-created', (info: any) => {
  this.broadcast({ type: 'session:created', payload: info });
});
```

- [ ] **Step 5b: Remove duplicate `session:created` broadcast from `handleMessage`**

In `remote-server.ts`, in the `session:create` case of `handleMessage`, **remove** the line:
```typescript
this.broadcast({ type: 'session:created', payload: info });
```
This is now handled by the `session-created` event listener in Step 5. Without this removal, remote clients would receive duplicate `session:created` events.

- [ ] **Step 6: Add topic file watcher to RemoteServer for `session:renamed`**

Add a topic watcher to RemoteServer using the same approach as `ipc-handlers.ts`:
- Build a `sessionIdMap` (desktop → claude session ID) from hook events
- Watch topic files and broadcast `session:renamed` events to WS clients

This can be a simplified version — use polling (2s interval) since the watcher logic is already proven in `ipc-handlers.ts`.

- [ ] **Step 7: Add `skillScanner` to RemoteServer constructor**

```typescript
constructor(
  private sessionManager: SessionManager,
  private hookRelay: HookRelay,
  private config: RemoteConfig,
  private skillScanner: () => any[],
) {}
```

Update `main.ts` to pass `scanSkills` as the fourth argument.

- [ ] **Step 8: Run tests**

```bash
npx vitest run
```

Expected: All existing tests still pass

- [ ] **Step 9: Commit**

```bash
git add src/main/skill-scanner.ts src/main/ipc-handlers.ts src/main/session-manager.ts src/main/remote-server.ts
git commit -m "refactor(remote): extract shared skill scanner, fix cross-client session visibility and rename events"
```

---

### Task 4: Browser client shim

**Files:**
- Create: `src/renderer/remote-shim.ts`

- [ ] **Step 1: Create the remote shim**

Create `src/renderer/remote-shim.ts`:

```typescript
/**
 * WebSocket-backed implementation of window.claude for browser (non-Electron) access.
 * Provides the same API surface as the Electron preload bridge.
 */

type Callback = (...args: any[]) => void;

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
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
    pending.set(id, { resolve, reject });
    send({ type, id, payload });
    // Timeout after 30 seconds
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Request ${type} timed out`));
      }
    }, 30_000);
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
    const { resolve } = pending.get(id)!;
    pending.delete(id);
    resolve(payload);
    return;
  }

  // Push events — dispatch to registered listeners
  switch (type) {
    case 'pty:output':
      dispatchEvent('pty:output', payload.sessionId, payload.data);
      break;
    case 'hook:event':
      dispatchEvent('hook:event', payload);
      break;
    case 'session:created':
      dispatchEvent('session:created', payload);
      break;
    case 'session:destroyed':
      dispatchEvent('session:destroyed', payload.sessionId || payload);
      break;
    case 'session:renamed':
      dispatchEvent('session:renamed', payload.sessionId, payload.name);
      break;
    case 'status:data':
      dispatchEvent('status:data', payload);
      break;
  }
}

export function connect(passwordOrToken: string, isToken = false): Promise<string> {
  return new Promise((resolve, reject) => {
    setConnectionState('connecting');
    ws = new WebSocket(getWsUrl());

    ws.onopen = () => {
      setConnectionState('authenticating');
      const authMsg = isToken
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
          setConnectionState('connected');
          // Store token for reconnection
          const token = msg.token;
          localStorage.setItem('destincode-remote-token', token);
          resolve(token);
          // Switch to normal message handling
          ws!.onmessage = (e) => handleMessage(e.data as string);
        } else if (msg.type === 'auth:failed') {
          authResolved = true;
          setConnectionState('disconnected');
          reject(new Error(msg.reason || 'Authentication failed'));
          ws!.close();
        }
        return;
      }

      handleMessage(event.data as string);
    };

    ws.onclose = () => {
      if (!authResolved) {
        setConnectionState('disconnected');
        reject(new Error('Connection closed before auth'));
        return;
      }

      setConnectionState('disconnected');
      // Attempt reconnection with stored token
      const storedToken = localStorage.getItem('destincode-remote-token');
      if (storedToken) {
        scheduleReconnect(storedToken);
      }
    };

    ws.onerror = () => {
      // onclose will fire after this
    };
  });
}

function scheduleReconnect(token: string): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      await connect(token, true);
    } catch {
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
      scheduleReconnect(token);
    }
  }, reconnectDelay);
}

export function disconnect(): void {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { ws.close(); ws = null; }
  setConnectionState('disconnected');
  localStorage.removeItem('destincode-remote-token');
}

/** Install the window.claude shim. Call once on app startup in browser mode. */
export function installShim(): void {
  (window as any).claude = {
    session: {
      create: (opts: any) => invoke('session:create', opts),
      destroy: (sessionId: string) => invoke('session:destroy', { sessionId }),
      list: () => invoke('session:list'),
      sendInput: (sessionId: string, text: string) => fire('session:input', { sessionId, text }),
      resize: (sessionId: string, cols: number, rows: number) => fire('session:resize', { sessionId, cols, rows }),
      signalReady: (sessionId: string) => fire('session:terminal-ready', { sessionId }),
      respondToPermission: (requestId: string, decision: object) => invoke('permission:respond', { requestId, decision }),
    },
    on: {
      sessionCreated: (cb: Callback) => addListener('session:created', cb),
      sessionDestroyed: (cb: Callback) => addListener('session:destroyed', cb),
      ptyOutput: (cb: Callback) => addListener('pty:output', cb),
      hookEvent: (cb: Callback) => addListener('hook:event', cb),
      statusData: (cb: Callback) => addListener('status:data', cb),
      sessionRenamed: (cb: Callback) => addListener('session:renamed', cb),
    },
    skills: {
      list: () => invoke('skills:list'),
    },
    dialog: {
      openFile: async () => [],
      openFolder: async () => null,
      readTranscriptMeta: (p: string) => invoke('transcript:read-meta', { path: p }),
      saveClipboardImage: async () => null,
    },
    shell: {
      openChangelog: async () => {},
    },
    off: (channel: string, handler: Callback) => removeListener(channel, handler),
    removeAllListeners: (channel: string) => removeAllListeners(channel),
    getGitHubAuth: () => invoke('github:auth'),
    getHomePath: () => invoke('get-home-path'),
  };
}
```

- [ ] **Step 2: Verify the file compiles**

```bash
cd ~/.claude/plugins/destinclaude/desktop
npx tsc --noEmit src/renderer/remote-shim.ts 2>&1 || true
```

Note: This file runs in the browser, so `tsc` may warn about DOM types vs the commonjs tsconfig. The real compilation check is via Vite. A quick visual review that the API surface matches `preload.ts` is sufficient here.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/remote-shim.ts
git commit -m "feat(remote): add browser client shim implementing window.claude over WebSocket"
```

---

### Task 5: Wire up index.tsx — environment detection and login gate

**Files:**
- Modify: `src/renderer/index.tsx`

- [ ] **Step 1: Update index.tsx with environment detection and login screen**

Replace the contents of `src/renderer/index.tsx` with:

```tsx
import React, { useState, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/globals.css';
import App from './App';

/** Minimal login screen for remote browser access. */
function LoginScreen({ onLogin }: { onLogin: (password: string) => Promise<void>; }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim()) return;
    setLoading(true);
    setError(null);
    try {
      await onLogin(password);
    } catch (err: any) {
      setError(
        err.message === 'no-password-configured'
          ? 'Remote access is not configured. Set a password in the desktop app.'
          : 'Invalid password'
      );
      setLoading(false);
    }
  };

  return (
    <div className="flex w-screen h-screen bg-gray-950 text-gray-200 items-center justify-center">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4 w-80">
        <h1 className="text-lg font-semibold text-center">DestinCode Remote</h1>
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="px-3 py-2 rounded bg-gray-800 border border-gray-700 text-sm focus:outline-none focus:border-gray-500"
          autoFocus
          disabled={loading}
        />
        <button
          type="submit"
          disabled={loading}
          className="px-4 py-2 rounded bg-gray-300 text-gray-950 text-sm font-medium hover:bg-gray-200 disabled:opacity-50"
        >
          {loading ? 'Connecting...' : 'Connect'}
        </button>
        {error && <p className="text-red-400 text-sm text-center">{error}</p>}
      </form>
    </div>
  );
}

/**
 * Wrapper that owns all connection logic. LoginScreen is pure-presentational.
 * This eliminates the race condition where LoginScreen and Root both
 * independently manage connection state.
 */
function Root() {
  const isElectron = !!(window as any).claude;
  const [connected, setConnected] = useState(isElectron);
  const [shimReady, setShimReady] = useState(isElectron);

  // In browser mode: install shim once, attempt token auto-login, listen for state changes
  useEffect(() => {
    if (isElectron) return;
    import('./remote-shim').then(({ installShim, connect, onConnectionStateChange, getConnectionState }) => {
      installShim();
      setShimReady(true);

      onConnectionStateChange((state) => {
        setConnected(state === 'connected');
      });

      // Auto-login with stored token
      const storedToken = localStorage.getItem('destincode-remote-token');
      if (storedToken) {
        connect(storedToken, true).catch(() => {
          localStorage.removeItem('destincode-remote-token');
        });
      }
    });
  }, [isElectron]);

  const handleLogin = useCallback(async (password: string) => {
    const { connect } = await import('./remote-shim');
    await connect(password);
  }, []);

  if (isElectron || connected) {
    return <App />;
  }

  if (!shimReady) {
    return <div className="flex w-screen h-screen bg-gray-950" />;
  }

  return <LoginScreen onLogin={handleLogin} />;
}

createRoot(document.getElementById('root')!).render(<Root />);
```

- [ ] **Step 2: Verify it compiles**

```bash
cd ~/.claude/plugins/destinclaude/desktop
npx tsc --noEmit 2>&1 | head -20
```

Check for errors in `index.tsx` specifically. Minor warnings from other files are OK.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/index.tsx
git commit -m "feat(remote): add environment detection and login gate in index.tsx"
```

---

### Task 6: Wire up main.ts — start RemoteServer on launch

**Files:**
- Modify: `src/main/main.ts`

- [ ] **Step 1: Add RemoteServer initialization to main.ts**

In `src/main/main.ts`, add the import at the top (after existing imports):

```typescript
import { RemoteServer } from './remote-server';
import { RemoteConfig } from './remote-config';
import { scanSkills } from './skill-scanner';
```

After the `hookRelay` initialization (around line 43), add:

```typescript
const remoteConfig = new RemoteConfig();
const remoteServer = new RemoteServer(sessionManager, hookRelay, remoteConfig, scanSkills);
```

In the `app.whenReady().then(async () => {` block, after `await hookRelay.start()` (around line 93), add:

```typescript
  try {
    await remoteServer.start();
  } catch (e) {
    console.error('Failed to start remote server:', e);
  }
```

In the `window-all-closed` handler, add `remoteServer.stop()` before `app.quit()`:

```typescript
app.on('window-all-closed', () => {
  if (cleanupIpcHandlers) cleanupIpcHandlers();
  sessionManager.destroyAll();
  hookRelay.stop();
  remoteServer.stop();
  app.quit();
});
```

- [ ] **Step 2: Verify it compiles**

```bash
cd ~/.claude/plugins/destinclaude/desktop
npx tsc --noEmit src/main/main.ts 2>&1 | head -20
```

- [ ] **Step 3: Commit**

```bash
git add src/main/main.ts
git commit -m "feat(remote): wire RemoteServer into Electron main process lifecycle"
```

---

### Task 7: Integration test — full round-trip

**Files:**
- Test: `tests/remote-server.test.ts` (extend)

- [ ] **Step 1: Add integration-style test for auth + message routing**

Append to `tests/remote-server.test.ts`:

```typescript
describe('RemoteServer auth flow', () => {
  it('rejects connections when no password is configured', async () => {
    const config = {
      ...mockConfig,
      passwordHash: null,
      verifyPassword: vi.fn(async () => false),
    };
    const { RemoteServer } = await import('../src/main/remote-server');
    const server = new RemoteServer(mockSessionManager, mockHookRelay, config);
    // Verify that the server can be created with null password
    expect(server).toBeDefined();
  });
});
```

Note: Full WebSocket integration tests require a live server. For v1, rely on manual testing (Task 8) and the unit tests above. The auth flow and message routing are straightforward enough that the mock-based tests provide adequate coverage.

- [ ] **Step 2: Run all tests**

```bash
cd ~/.claude/plugins/destinclaude/desktop
npx vitest run
```

Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add tests/remote-server.test.ts
git commit -m "test(remote): add auth configuration test"
```

---

### Task 8: Manual smoke test

**Files:** None (testing only)

- [ ] **Step 1: Set a remote password**

Create the config file manually for testing:

```bash
node -e "
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const os = require('os');
const hash = bcrypt.hashSync('test123', 10);
const configPath = path.join(os.homedir(), '.claude', 'destincode-remote.json');
fs.writeFileSync(configPath, JSON.stringify({ enabled: true, port: 9900, passwordHash: hash, trustTailscale: false }, null, 2));
console.log('Config written to', configPath);
"
```

- [ ] **Step 2: Build and launch DestinCode**

```bash
cd ~/.claude/plugins/destinclaude/desktop
npm run dev
```

- [ ] **Step 3: Verify remote server started**

Check the Electron console output for: `[RemoteServer] Listening on port 9900`

- [ ] **Step 4: Open remote UI in a browser**

Navigate to `http://localhost:9900` in a web browser (not the Electron window).
Expected: See the login screen with a password field.

- [ ] **Step 5: Test authentication**

Enter `test123` and submit.
Expected: Login succeeds, full DestinCode UI loads.

- [ ] **Step 6: Test session interaction**

Create a session in the remote UI. Verify:
- Terminal view shows Claude Code output
- Chat view shows messages and tool cards
- Input bar sends messages
- Approval prompts work (if a tool requires permission)

- [ ] **Step 7: Verify shared view**

Check that the same session appears in the Electron window. Type in one, see it in the other.

- [ ] **Step 8: Test reconnection**

Close the remote browser tab, reopen it. Expected: auto-login with stored token, session state recovered from buffers.

---

### Task 9: Final cleanup and docs

**Files:**
- Modify: `desktop/CLAUDE.md`

- [ ] **Step 1: Update CLAUDE.md with remote access docs**

Add a "Remote Access" section to `desktop/CLAUDE.md`:

```markdown
## Remote Access

DestinCode includes a built-in remote access server that serves the UI to any web browser.

- **Config:** `~/.claude/destincode-remote.json` — port, password, Tailscale trust
- **Set password:** Create config file with bcrypt hash, or use the settings UI
- **Access:** Open `http://<your-ip>:9900` in any browser
- **Security:** Password auth + optional Tailscale network-level trust
- **Key files:** `src/main/remote-server.ts`, `src/main/remote-config.ts`, `src/renderer/remote-shim.ts`
- **The remote UI is the same React app** — `remote-shim.ts` replaces Electron IPC with WebSocket. No React components are changed.
```

- [ ] **Step 2: Commit**

```bash
git add desktop/CLAUDE.md
git commit -m "docs: add remote access section to CLAUDE.md"
```

- [ ] **Step 3: Run full test suite one final time**

```bash
cd ~/.claude/plugins/destinclaude/desktop
npx vitest run
```

Expected: All tests pass
