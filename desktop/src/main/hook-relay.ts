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

  /** True when this event may be attributed to `sessionId`.
   *  WHY only a SessionStart claims (review F2): a nested process whose hook
   *  happened to arrive first must never become the owner and lock the real
   *  session out. Before a SessionStart claims, everything passes (fail open). */
  accept(sessionId: string, claudePid: unknown, isSessionStart: boolean): boolean {
    if (!sessionId || typeof claudePid !== 'string' || !claudePid) return true;
    const owner = this.owners.get(sessionId);
    if (owner === undefined) {
      if (isSessionStart) this.owners.set(sessionId, claudePid);
      return true;
    }
    return owner === claudePid;
  }
}

// The app OWNS the permission-ask clock (2026-07-30 permission-ask-timeout spec
// §1, ported from PR #278 on 2026-09-23). Three tiers, each 30 minutes apart:
//   app hold 2h (here, and EventBridge.kt on Android)
//   < relay backstop 2h30m (relay-blocking.js / hook-relay-blocking.js)
//   < Claude Code's own hook timeout 3h (install-hooks.js / Bootstrap.kt).
// The margins are load-bearing: if Claude Code's timeout ever fires first it
// kills the hook with NO decision, and AskUserQuestion then waits forever on
// Claude Code's default-"never" question timeout — the silent wedge the old
// equal 5-minute values produced. Do not tidy them back to equal. Pinned by
// tests/permission-timeout-margins.test.ts.
// NOTE: setTimeout does not advance while the machine sleeps, so the hold can
// stretch past 2h of wall-clock on a laptop — expected, not a bug.
const APP_HOLD_MS = 7_200_000;

/** Why a held ask ended without a user decision (rides as payload._reason). */
// WHY not exported: nothing outside this file imports it, and an unused exported
// type trips the knip ratchet (combined-branch fix). It types the reason armHold emits.
type PermissionExpiryReason = 'app-timeout' | 'hook-closed';

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
  // requestId → the app-owned hold timer for that ask. Cleared on every path
  // that ends it (respond, socket close, stop): a leaked timer would fire
  // respond() into a dead or reused socket.
  private holdTimers = new Map<string, NodeJS.Timeout>();
  private sessionGate: ((sessionId: string) => boolean) | null = null;
  private readonly holdMs: number;

  constructor(pipeName?: string, holdMs: number = APP_HOLD_MS) {
    super();
    this.pipeName = pipeName || DEFAULT_PIPE_NAME;
    this.holdMs = holdMs;
  }

  /** main.ts wires this to SessionManager.hasSession (mirrors setReloadPluginsGate).
   *  An ask from a session this app does not own is passed straight back to
   *  Claude Code with no decision — see processPayload. */
  setSessionGate(gate: (sessionId: string) => boolean): void {
    this.sessionGate = gate;
  }

  private clearHold(requestId: string): void {
    const t = this.holdTimers.get(requestId);
    if (t) { clearTimeout(t); this.holdTimers.delete(requestId); }
  }

  /** Arm the app-owned hold for one ask: when it fires, the app answers with a
   *  labelled deny, so Claude Code moves on and the card can say what happened. */
  private armHold(requestId: string, sessionId: string): void {
    this.holdTimers.set(requestId, setTimeout(() => {
      this.holdTimers.delete(requestId);
      const hours = Math.round(this.holdMs / 3_600_000);
      // Nested { decision: {...} } is load-bearing — relay-blocking.js reads
      // appDecision.decision; a flat shape would ship `decision: undefined`.
      // The message lands verbatim in the denied tool result the model reads,
      // so it says what happened and invites a re-ask.
      const delivered = this.respond(requestId, {
        decision: {
          behavior: 'deny',
          message: `YouCoded auto-denied this request after ${hours} hour${hours === 1 ? '' : 's'} with no response — ask again if it is still needed.`,
        },
      });
      // respond() deletes the pending entry BEFORE the socket's 'close' fires,
      // so the close handler's wasOpen guard stays silent for app-initiated
      // endings — they must emit their own reason. Only claim an auto-deny if
      // one was actually written (docs/error-message-standards.md).
      if (delivered) {
        const reason: PermissionExpiryReason = 'app-timeout';
        this.emit('permission-expired', sessionId, requestId, reason);
      }
    }, this.holdMs));
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

          // WHY two gates, in this order (combined branch: integrations'
          // HookOwnerGate meets plan-approval's pass-through). The owner gate
          // above drops EVERY hook from a `claude` nested inside one of our
          // sessions (same session id, different pid). This one handles an ask
          // whose session id is not one of ours at all: it is passed back to
          // Claude Code at once. An ask that clears both is ours and is held.
          if (parsed.hook_event_name === 'PermissionRequest'
              && this.sessionGate && !this.sessionGate(event.sessionId)) {
            // NOT OURS: no live session of this app has this id — e.g. a claude
            // that inherited the pipe from a closed session, or one reporting
            // under its own Claude Code id. No card could ever show it, so do
            // not hold it and do not decide it: end the socket WITHOUT writing.
            // The relay then exits 0 printing nothing and Claude Code shows its
            // own terminal prompt at once, with no YouCoded wording (measured
            // on 2.1.281 for a file write and for AskUserQuestion:
            // tests/fixtures/plan-menu/cc-2.1.281-passthrough-*.json). This
            // replaced a 60s hold ending in a YouCoded deny, which denied asks
            // the user could see and answer in their own terminal (review
            // 2026-09-23, F2). Session ids are registered before the process
            // starts (session-manager.ts), so no owned session is ever "not
            // yet registered" here.
            log('INFO', 'HookRelay', 'Passing through an ask for a session this app does not own', { sessionId: event.sessionId });
            socket.end();
            return;
          }

          if (parsed.hook_event_name === 'PermissionRequest') {
            // Hold the socket open — relay-blocking.js is waiting for a response
            const requestId = randomUUID();
            this.pendingSockets.set(requestId, { socket, sessionId: event.sessionId });
            event.payload._requestId = requestId;
            this.emit('hook-event', event);
            // Armed AFTER the emit: main.ts auto-approves some asks from inside
            // that emit, and respond() then clears this request — arming after
            // means an already-answered ask never gets a timer.
            if (this.pendingSockets.has(requestId)) this.armHold(requestId, event.sessionId);

            // When the socket closes on its own (relay backstop, Claude Code
            // killing the hook, the relay dying), the far end went away FIRST —
            // app-initiated endings delete the entry before this fires. That
            // asymmetry is what lets 'hook-closed' mean "Claude Code's own menu
            // may still be on screen": the card keeps waiting instead of
            // clearing while the session is actually blocked (spec §2).
            socket.on('close', () => {
              this.clearHold(requestId);
              const wasOpen = this.pendingSockets.delete(requestId);
              if (wasOpen) {
                this.emit('permission-expired', event.sessionId, requestId, 'hook-closed');
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
    this.clearHold(requestId);
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
    // Clear the hold timers first so none fires into a socket being torn down.
    for (const t of this.holdTimers.values()) clearTimeout(t);
    this.holdTimers.clear();

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
