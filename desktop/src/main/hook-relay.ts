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

export class HookRelay extends EventEmitter {
  private server: net.Server | null = null;
  private running = false;
  // requestId → held socket + owning session. The sessionId is tracked so
  // hasPendingPermission() can tell automated PTY writers (e.g. the
  // /reload-plugins broadcast) that this session's terminal currently shows
  // a live permission/AskUserQuestion menu and must not be typed into.
  private pendingSockets = new Map<string, { socket: net.Socket; sessionId: string }>();
  private pipeName: string;

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
