import net from 'net';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { HookEvent } from '../shared/types';
import { log } from './logger';

const DEFAULT_PIPE_NAME = process.platform === 'win32'
  ? '\\\\.\\pipe\\claude-desktop-hooks'
  : path.join(os.tmpdir(), 'claude-desktop-hooks.sock');

/**
 * Which Claude Code process owns a session's hooks.
 *
 * WHY (2026-09-23, roadmap claude-code-integration, security): the session id
 * the app hands Claude Code (CLAUDE_DESKTOP_SESSION_ID) is inherited by every
 * process that session starts, so a `claude` launched from inside it — the
 * Bash tool, a script, a background job — reported its hooks as OURS. That
 * once repointed a live chat view at a foreign transcript, and a foreign
 * permission request would show up as a card the user could approve.
 *
 * Claude Code writes its own process id into every hook's environment
 * (CLAUDE_PID, checked on 2.1.281), and the relay forwards it. A desktop
 * session runs exactly ONE Claude Code process for its whole life (no respawn
 * under the same id), and that process fires SessionStart before it can run
 * anything that could start another — so the pid of the first SessionStart
 * for a session is the owner, and any other pid is a nested process. /clear, /resume and
 * subagents all stay inside the owner process. No pid (older Claude Code, an
 * old relay script) fails OPEN, exactly as before.
 */
export class HookOwnerGate {
  private owners = new Map<string, string>();
  // First pid that sent a NON-SessionStart hook before any owner was claimed.
  private firstToolPid = new Map<string, string>();

  /** True when this event may be attributed to `sessionId`.
   *  WHY only a SessionStart claims (review F2): a nested process whose hook
   *  happened to arrive first must never become the owner and lock the real
   *  session out. Before a claim, everything passes (fail open).
   *  WHY a claim can go to an EARLIER pid (review C2): relay.js tries once and
   *  exits quietly, so the real process's SessionStart can be lost. Its tool
   *  hooks then arrive with no owner, and a nested `claude`'s SessionStart
   *  would otherwise claim the session and drop every real hook from then on.
   *  A nested process only exists after the real one has run a tool, and the
   *  real one fires SessionStart before any tool — so a pid that sent tool
   *  hooks before any claim is the real one, and it is claimed instead. */
  accept(sessionId: string, claudePid: unknown, isSessionStart: boolean): boolean {
    if (!sessionId || typeof claudePid !== 'string' || !claudePid) return true;
    const owner = this.owners.get(sessionId);
    if (owner !== undefined) return owner === claudePid;
    if (!isSessionStart) {
      if (!this.firstToolPid.has(sessionId)) this.firstToolPid.set(sessionId, claudePid);
      return true;
    }
    const claimed = this.firstToolPid.get(sessionId) ?? claudePid;
    this.owners.set(sessionId, claimed);
    this.firstToolPid.delete(sessionId);
    return claimed === claudePid;
  }
}

export class HookRelay extends EventEmitter {
  private server: net.Server | null = null;
  private running = false;
  // requestId → held socket + owning session. The sessionId is tracked so
  // hasPendingPermission() can tell automated PTY writers (e.g. the
  // /reload-plugins broadcast) that this session's terminal currently shows
  // a live permission/AskUserQuestion menu and must not be typed into.
  private pendingSockets = new Map<string, { socket: net.Socket; sessionId: string }>();
  private pipeName: string;
  private owners = new HookOwnerGate();
  private warnedForeign = new Set<string>();

  constructor(pipeName?: string) {
    super();
    this.pipeName = pipeName || DEFAULT_PIPE_NAME;
  }

  private parseHookPayload(data: string): HookEvent {
    const parsed = JSON.parse(data);
    return {
      type: parsed.hook_event_name || 'unknown',
      // Prefer our injected desktop session ID over Claude Code's internal session_id
      sessionId: parsed._desktop_session_id || parsed.session_id || '',
      payload: parsed,
      timestamp: Date.now(),
    };
  }

  private createServer(): net.Server {
    return net.createServer((socket) => {
      let data = '';
      let processed = false;
      socket.setEncoding('utf8');

      socket.on('error', (err) => {
        // Log connection-level errors for debugging (ECONNRESET, EPIPE, etc.)
        log('WARN', 'HookRelay', 'Socket error', { error: String(err.message) });
      });

      const processPayload = (payload: string) => {
        if (processed) return;
        processed = true;
        try {
          const parsed = JSON.parse(payload);
          const event = this.parseHookPayload(payload);

          // A hook from a `claude` nested inside one of our sessions — see
          // HookOwnerGate. Dropped before anything can map, watch or show it.
          // Ending the socket with no reply lets a blocking relay exit cleanly,
          // so the nested process falls back to its own permission prompt.
          if (parsed._desktop_session_id && !this.owners.accept(parsed._desktop_session_id, parsed._claude_pid, parsed.hook_event_name === 'SessionStart')) {
            // Once per nested process, not per hook — a nested session fires many.
            const key = `${parsed._desktop_session_id}:${parsed._claude_pid}`;
            if (!this.warnedForeign.has(key)) {
              this.warnedForeign.add(key);
              log('WARN', 'HookRelay', 'ignoring hooks from a nested claude process', {
                sessionId: parsed._desktop_session_id, event: parsed.hook_event_name, pid: parsed._claude_pid,
              });
            }
            socket.end();
            return;
          }

          if (parsed.hook_event_name === 'PermissionRequest') {
            // Hold the socket open — relay-blocking.js is waiting for a response
            const requestId = randomUUID();
            this.pendingSockets.set(requestId, { socket, sessionId: event.sessionId });
            event.payload._requestId = requestId;
            this.emit('hook-event', event);

            // When the socket closes (relay timeout, Claude Code kills hook,
            // or network error), notify listeners so the UI can clear the
            // awaiting-approval state instead of leaving dead buttons.
            socket.on('close', () => {
              const wasOpen = this.pendingSockets.delete(requestId);
              if (wasOpen) {
                this.emit('permission-expired', event.sessionId, requestId);
              }
            });
          } else {
            this.emit('hook-event', event);
            socket.end();
          }
        } catch (err: any) {
          log('WARN', 'HookRelay', 'Invalid hook payload', { error: String(err.message) });
          socket.end();
        }
      };

      socket.on('data', (chunk) => {
        data += chunk;
        // Process all complete newline-delimited messages in the buffer
        let nlIndex: number;
        while ((nlIndex = data.indexOf('\n')) >= 0) {
          processPayload(data.substring(0, nlIndex));
          data = data.substring(nlIndex + 1);
        }
      });

      socket.on('end', () => {
        // Fallback: if no newline was found, parse whatever we have
        if (data.length > 0) {
          processPayload(data);
        }
      });
    });
  }

  async start(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.tryListen();
        return;
      } catch (err: any) {
        if (err.code === 'EADDRINUSE' && attempt < 2) {
          // Stale pipe from a previous process — try to release it
          await this.forceReleasePipe();
        } else {
          throw err;
        }
      }
    }
  }

  private tryListen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = this.createServer();
      this.server.listen(this.pipeName, () => {
        this.running = true;
        resolve();
      });
      this.server.on('error', reject);
    });
  }

  private async forceReleasePipe(): Promise<void> {
    // On Unix, try unlinking the stale socket file directly — this is the
    // most reliable way to clear a dead socket from a crashed process.
    if (process.platform !== 'win32') {
      try { fs.unlinkSync(this.pipeName); } catch { /* may not exist */ }
      return;
    }

    // On Windows, named pipes held by dead processes can't be released by
    // client connection alone. We need to try connecting (which may error),
    // wait, and also try unlinking the pipe path as a filesystem entry.
    await new Promise<void>((resolve) => {
      const client = net.createConnection(this.pipeName, () => {
        client.end();
        setTimeout(resolve, 1000);
      });
      client.on('error', () => {
        setTimeout(resolve, 1000);
      });
      client.setTimeout(2000, () => {
        client.destroy();
        setTimeout(resolve, 1000);
      });
    });
  }

  respond(requestId: string, decision: object): boolean {
    const pending = this.pendingSockets.get(requestId);
    if (!pending || pending.socket.destroyed) {
      this.pendingSockets.delete(requestId);
      return false;
    }
    pending.socket.write(JSON.stringify(decision) + '\n');
    pending.socket.end();
    this.pendingSockets.delete(requestId);
    // Remote access batch 2 (§7): say the ask is closed, the way the native
    // permission broker does (permission-broker.ts removeEntry). RemoteServer
    // purges its replay buffer on this and a phone that could not see the
    // answer clears its card with a neutral note. Without it a Claude Code ask
    // answered on the computer was replayed to every reconnecting phone as a
    // live question.
    //
    // On a microtask (T2 review, 7): respond() is often called from INSIDE another
    // hook-event listener — main.ts auto-approves while the Request is still being
    // emitted. A synchronous Resolved reached listeners registered after that one
    // before they had seen the Request (RemoteServer, when remote access is switched on
    // after launch), so it purged nothing and the answered Request stayed buffered as
    // open forever. After the current emit, every listener has seen the Request first.
    const sessionId = pending.sessionId;
    queueMicrotask(() => {
      this.emit('hook-event', {
        sessionId,
        type: 'PermissionResolved',
        payload: { _requestId: requestId },
        timestamp: Date.now(),
      });
    });
    return true;
  }

  /**
   * True while a PermissionRequest for this session is held open. In that
   * window Claude Code's TUI is showing a live Ink select menu — automated
   * PTY writers must not send bytes to the session or they will act as menu
   * keystrokes (a trailing `\r` selects the highlighted option).
   */
  hasPendingPermission(sessionId: string): boolean {
    for (const pending of this.pendingSockets.values()) {
      if (pending.sessionId === sessionId) return true;
    }
    return false;
  }

  stop(): void {
    // Clean up all pending permission sockets
    for (const [, pending] of this.pendingSockets) {
      if (!pending.socket.destroyed) {
        pending.socket.end();
      }
    }
    this.pendingSockets.clear();

    if (this.server) {
      this.server.close();
      this.server = null;
      this.running = false;
    }
    // Clean up Unix socket file
    if (process.platform !== 'win32') {
      try { fs.unlinkSync(this.pipeName); } catch { /* may already be gone */ }
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  async simulateEvent(jsonPayload: string): Promise<void> {
    const event = this.parseHookPayload(jsonPayload);
    this.emit('hook-event', event);
  }
}
