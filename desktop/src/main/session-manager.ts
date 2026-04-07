import { spawn, ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { app } from 'electron';
import { SessionInfo } from '../shared/types';
import { EventEmitter } from 'events';
import { log } from './logger';

// Optional — which may not be installed; fall back to bare command name
let whichSync: ((cmd: string) => string) | null = null;
try { const w = require('which'); whichSync = w.sync; } catch { /* noop */ }

export interface CreateSessionOpts {
  name: string;
  cwd: string;
  skipPermissions: boolean;
  cols?: number;
  rows?: number;
  /** Resume a previous session by its Claude Code session ID */
  resumeSessionId?: string;
  model?: string;
}

interface ManagedSession {
  info: SessionInfo;
  worker: ChildProcess;
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, ManagedSession>();
  private pipeName: string = '';

  setPipeName(name: string) {
    this.pipeName = name;
  }

  createSession(opts: CreateSessionOpts): SessionInfo {
    const id = randomUUID();
    // Resolve CWD: fall back to home directory if empty or nonexistent
    const resolvedCwd = (opts.cwd && fs.existsSync(opts.cwd)) ? opts.cwd : os.homedir();
    const args: string[] = [];
    if (opts.skipPermissions) {
      args.push('--dangerously-skip-permissions');
    }
    if (opts.resumeSessionId) {
      args.push('--resume', opts.resumeSessionId);
    }
    if (opts.model) {
      args.push('--model', opts.model);
    }

    // Spawn a separate Node.js process for node-pty so it uses Node's
    // native binary instead of Electron's (which requires electron-rebuild).
    // We use spawn with 'node' (system Node) + IPC channel instead of fork()
    // because fork() uses Electron's Node.js which has the same ABI mismatch.
    // In packaged builds, pty-worker.js is unpacked from the asar archive
    // so that system Node.js can access it (node can't read asar files).
    let workerPath = path.join(__dirname, 'pty-worker.js');
    if (app.isPackaged) {
      const unpackedPath = workerPath.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
      if (fs.existsSync(unpackedPath)) {
        workerPath = unpackedPath;
      } else {
        log('ERROR', 'SessionManager', 'Unpacked worker not found, using asar path', { path: unpackedPath });
      }
    }
    // Always use system Node.js — Electron's binary can't load node-pty.
    // Resolve via which() for Windows where Electron's PATH may differ.
    let nodePath = 'node';
    try { if (whichSync) nodePath = whichSync('node'); } catch { /* use bare 'node' */ }
    const worker = spawn(nodePath, [workerPath], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });

    const info: SessionInfo = {
      id,
      name: opts.name,
      cwd: resolvedCwd,
      permissionMode: opts.skipPermissions ? 'bypass' : 'normal',
      skipPermissions: opts.skipPermissions,
      status: 'active',
      createdAt: Date.now(),
    };

    const session: ManagedSession = { info, worker };
    this.sessions.set(id, session);
    this.emit('session-created', info);

    // Handle spawn failure (e.g., node not on PATH) — without this,
    // the unhandled 'error' event would crash the Electron main process.
    worker.on('error', (err) => {
      log('ERROR', 'SessionManager', 'Worker spawn failed', { sessionId: id, error: String(err) });
      if (this.sessions.has(id)) {
        this.sessions.get(id)!.info.status = 'destroyed';
        this.sessions.delete(id);
        this.emit('session-exit', id, 1);
      }
    });

    // Drain stderr so the pipe buffer doesn't fill up and cause backpressure.
    worker.stderr?.on('data', (chunk: Buffer) => {
      log('ERROR', 'SessionManager', 'Worker stderr', { sessionId: id, output: chunk.toString() });
    });

    worker.on('message', (msg: any) => {
      switch (msg.type) {
        case 'data':
          this.emit('pty-output', id, msg.data);
          break;
        case 'exit':
          if (!this.sessions.has(id)) return;
          const exitingSession = this.sessions.get(id)!;
          exitingSession.info.status = 'destroyed';
          this.emit('session-exit', id, msg.exitCode);
          this.sessions.delete(id);
          break;
      }
    });

    worker.on('exit', () => {
      if (!this.sessions.has(id)) return;
      const exitingSession = this.sessions.get(id)!;
      exitingSession.info.status = 'destroyed';
      this.emit('session-exit', id, 0);
      this.sessions.delete(id);
    });

    // Tell the worker to spawn claude, passing our session ID
    // so hook events can be correlated back to this session.
    // Wrapped in try/catch because send() throws synchronously if
    // the spawn failed (IPC channel never opened), which happens
    // before the async 'error' event fires.
    try {
      worker.send({
        type: 'spawn',
        command: 'claude',
        args,
        cwd: resolvedCwd,
        cols: opts.cols || 80,
        rows: opts.rows || 24,
        sessionId: id,
        pipeName: this.pipeName,
      });
    } catch {
      // The 'error' handler above will clean up the session asynchronously.
    }

    return info;
  }

  destroySession(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.info.status = 'destroyed';
    this.sessions.delete(id);
    this.emit('session-exit', id, 0);
    try {
      session.worker.send({ type: 'kill' });
      session.worker.disconnect();
    } catch {
      // Worker IPC already closed (e.g., process crashed or exited)
    }
    return true;
  }

  sendInput(id: string, text: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    try { session.worker.send({ type: 'input', data: text }); } catch { return false; }
    return true;
  }

  resizeSession(id: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    try { session.worker.send({ type: 'resize', cols, rows }); } catch { return false; }
    return true;
  }

  listSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map(s => s.info);
  }

  getSession(id: string): SessionInfo | undefined {
    return this.sessions.get(id)?.info;
  }

  destroyAll(): void {
    for (const [id] of this.sessions) {
      this.destroySession(id);
    }
  }
}
