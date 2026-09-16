import { spawn, ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { app } from 'electron';
import { SessionInfo, SessionProvider } from '../shared/types';
import type { ModelBinding } from '../shared/provider-types';
import { EventEmitter } from 'events';
import { log } from './logger';
import { deployClaudeCodeLinkMcp } from './claude-code-mcp';

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
  /** Which CLI backend to launch — defaults to 'claude' */
  provider?: SessionProvider;
  /** Native-runtime model binding (provider='native' only). Required for a
   *  fresh native session; on resume the binding comes from the stored header. */
  binding?: ModelBinding;
  /** Native-runtime harness preset id (provider='native', fresh create only) —
   *  'assistant' | 'coder'. On resume the preset comes from the stored header.
   *  ipc-handlers threads it into nativeHost.create() and re-stamps the resolved
   *  id back onto the returned SessionInfo. */
  preset?: string;
  /** Optional text to prefill into the input bar after the session is selected.
   *  Forwarded into SessionInfo so the renderer can pick it up on session-created. */
  initialInput?: string;
  /** provider='shell' only: proof that this session was built by
   *  prepareRunInTerminal() and its command was therefore validated. A module
   *  -private Symbol, so it cannot be forged from a JSON payload or written by
   *  a caller that did not import it — see the check in createSession. */
  shellToken?: symbol;
  /** provider='shell' only: a command to TYPE onto the shell's prompt. It is
   *  never run for the user — no trailing carriage return is written, so the
   *  line just sits there and the user presses Enter (or edits it, or clears
   *  it). Written after the PTY's first output; see the flush below. */
  initialCommand?: string;
}

/** Which shell a `provider: 'shell'` session spawns.
 *  WHY $SHELL and not a hardcoded bash: this session exists so the user can run
 *  a command in THEIR terminal, and a command they'd paste into fish should
 *  behave the way it does in fish. Windows has no $SHELL, so PowerShell — the
 *  shell every supported Windows build ships — is the fixed answer there. */
export function resolveShellCommand(): string {
  if (process.platform === 'win32') return 'powershell.exe';
  return process.env.SHELL || '/bin/sh';
}

/** 'fish' from '/usr/bin/fish', 'powershell' from 'powershell.exe'.
 *  The session strip and header show this, so it has to read like a name. */
export function shellDisplayName(command: string): string {
  return path.basename(command).replace(/\.(exe|cmd|bat)$/i, '');
}

// Minted only by prepareRunInTerminal below, and demanded by createSession for
// every provider:'shell' session. This is what makes "the validator cannot be
// skipped" a fact rather than a convention: a second creation site written any
// other way — a different quoting style, a const, a spread, a whole new file —
// throws instead of opening an unvalidated shell.
const RUN_IN_TERMINAL_TOKEN = Symbol('run-in-terminal');

// Characters that must never appear in a command the app types onto a shell
// prompt. TAB is in the set too: at a prompt it triggers completion, which can
// rewrite the very line the user is about to press Enter on.
const CONTROL_CHARS = /[\r\n\t\x00-\x08\x0b-\x1f\x7f]/;
const CONTROL_CHAR_NAMES: Record<string, string> = {
  '\r': 'a carriage return',
  '\n': 'a line feed',
  '\t': 'a tab',
};

/**
 * Resolve the shell for a "Run in terminal" session and refuse anything that
 * must not be typed into it. THROWS with the real reason; both entry points
 * (the Electron handler and the remote WebSocket case) go through here so
 * neither can skip a check the other makes.
 *
 * WHY a carriage return is the whole point of this function: the command is
 * written to the PTY verbatim and the app deliberately does not append a
 * carriage return, because pressing Enter is the user's decision. But a `\r`
 * ALREADY INSIDE the string is the same keypress — measured on real bash, zsh
 * and fish, `echo a\recho b` runs on its own with nobody touching the keyboard.
 * "We didn't add one" is not the same property as "there isn't one", and the
 * command reaches here from a WebSocket frame an authenticated remote browser
 * controls, and (in future) from a prerequisite table that could be CRLF-shaped
 * on Windows.
 *
 * A LINE FEED SUBMITS TOO, and is refused for exactly the same reason: GNU
 * readline binds C-j to accept-line just as it binds C-m, so `\n` runs the
 * line on bash and zsh (measured, both). Do not "relax" this to allow it.
 * What IS allowed, deliberately, is everything a real install command needs —
 * `;`, `&&`, `|`, `$( )`, quotes, spaces and non-ASCII all pass, because none
 * of them submits a line.
 */
export function prepareRunInTerminal(command: unknown): { shell: string; command: string; shellToken: symbol } {
  if (typeof command !== 'string' || !command.trim()) {
    throw new Error('Run in terminal was given no command to type.');
  }
  const found = CONTROL_CHARS.exec(command);
  if (found) {
    const ch = found[0];
    const name = CONTROL_CHAR_NAMES[ch] ?? `a control character (U+${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')})`;
    // Counted the way a person counts: characters, starting at 1. found.index is
    // a UTF-16 offset, which is off by one from that and wrong again for every
    // astral character (an emoji in a path) sitting before the offender.
    const position = [...command.slice(0, found.index)].length + 1;
    throw new Error(
      `Run in terminal refused this command: it contains ${name} at character ${position}, ` +
      `which would run it without you pressing Enter. Copy the command instead.`
    );
  }
  const shell = resolveShellCommand();
  // A $SHELL pointing at a shell that is no longer installed would otherwise
  // spawn-fail asynchronously, AFTER this call has already resolved — the user
  // would see Settings close, a session pill flash and vanish, and no error at
  // all. Name the actual path so the message is actionable.
  // Only absolute paths are checked: Windows spawns the bare name
  // 'powershell.exe' and lets the PTY worker resolve it through PATH.
  if (path.isAbsolute(shell) && !fs.existsSync(shell)) {
    throw new Error(`Run in terminal could not start a terminal: your shell (${shell}) does not exist on this computer.`);
  }
  return { shell, command, shellToken: RUN_IN_TERMINAL_TOKEN };
}

interface ManagedSession {
  info: SessionInfo;
  // Native sessions have NO PTY worker — their turn loop lives in a
  // HarnessSession owned by NativeSessionHost (ipc-handlers wires it up after
  // createSession returns). Every `session.worker.X` access is guarded.
  worker?: ChildProcess;
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, ManagedSession>();
  private pipeName: string = '';

  setPipeName(name: string) {
    this.pipeName = name;
  }

  createSession(opts: CreateSessionOpts): SessionInfo {
    const provider: SessionProvider = opts.provider || 'claude';
    // Resolve CWD: fall back to home directory if empty or nonexistent.
    const cwdExists = !!opts.cwd && fs.existsSync(opts.cwd);
    // Diagnostic (2026-07-12): a RESUME whose cwd was provided but doesn't exist
    // means upstream row resolution produced a bad path — silently falling back
    // to $HOME then runs `claude --resume` in the WRONG project (this is exactly
    // how the greedy-slug bug surfaced as "every session resumed from home"). The
    // Resume Browser now gates resume on resolvable rows and the slug walk is
    // fixed, so this should be rare; the warning makes any regression VISIBLE
    // instead of a silent wrong-directory resume. Behavior is unchanged.
    if (!cwdExists && opts.cwd && opts.resumeSessionId) {
      // Persisted breadcrumb (2026-08-12): this was a bare console.warn, which goes
      // only to Electron stdout — invisible in a shipped build. log() lands it in
      // ~/.claude/desktop.log where the next wrong-resume investigation can find it.
      log('WARN', 'SessionManager', 'resume cwd does not exist — falling back to home; resume may open the wrong project', {
        resumeSessionId: opts.resumeSessionId, cwd: opts.cwd,
      });
    }
    const resolvedCwd = cwdExists ? opts.cwd! : os.homedir();

    // Native branch (platform roadmap Phase 1): no PTY worker — the turn loop
    // runs in a HarnessSession that ipc-handlers starts AFTER this returns
    // (SessionManager stays PTY-focused; it does not construct HarnessSession).
    // On resume the id MUST equal the resumed id so the HarnessSession the host
    // rebuilds and the SessionInfo the renderer holds share one identity.
    if (provider === 'native') {
      // Resume reads the binding from the stored session header; a fresh native
      // session must be given one up front.
      if (!opts.resumeSessionId && !opts.binding) {
        throw new Error('SessionManager: a new native session requires a model binding.');
      }
      const nativeId = opts.resumeSessionId || randomUUID();
      const nativeInfo: SessionInfo = {
        id: nativeId,
        name: opts.name,
        cwd: resolvedCwd,
        permissionMode: 'normal',
        skipPermissions: false,
        status: 'active',
        createdAt: Date.now(),
        provider: 'native',
        model: opts.binding?.modelId,
        // Seed the resolved-preset badge on the FIRST push for a fresh create
        // (opts.preset is the user's pick, which equals the resolved id for the
        // two built-ins). ipc-handlers re-stamps the authoritative resolved id
        // after nativeHost.create/resume. On RESUME the id is header-derived and
        // unknown here (left absent). It does NOT reach the live pill via the
        // re-stamp — session:created is sent before create/resume awaits, so the
        // renderer patches the pill from the SESSION_CREATE invoke's RETURN value
        // (App.createSession / handleResumeSession), which carries the re-stamped id.
        ...(opts.preset && !opts.resumeSessionId ? { harnessId: opts.preset } : {}),
        ...(opts.initialInput !== undefined ? { initialInput: opts.initialInput } : {}),
      };
      this.sessions.set(nativeId, { info: nativeInfo });
      this.emit('session-created', nativeInfo);
      return nativeInfo;
    }

    const id = randomUUID();

    // A shell session is the plain terminal: the user's own shell, no args, and
    // none of the Claude Code wiring below (no --resume/--model flags, no
    // SendUserLink MCP config, and — set at the spawn message — no hook pipe and
    // no session id for hooks to correlate, so nothing watches a transcript for
    // it because there is no transcript).
    const isShell = provider === 'shell';
    // The validator cannot be skipped. Every shell session must carry the token
    // prepareRunInTerminal mints, so there is no second way to open one: a
    // remote client's JSON payload cannot contain a Symbol, and a new call site
    // in main that forgets the validator fails here instead of handing the user
    // an unchecked command — or an attacker-chosen cwd — at a live prompt.
    if (isShell && opts.shellToken !== RUN_IN_TERMINAL_TOKEN) {
      throw new Error('SessionManager: a shell session must be created through prepareRunInTerminal().');
    }
    const shellCommand = isShell ? resolveShellCommand() : '';

    // Always use system Node.js — Electron's binary can't load node-pty.
    // Resolve via which() for Windows where Electron's PATH may differ.
    // Resolved HERE, ahead of the args, because the SendUserLink MCP config
    // below names this same interpreter for Claude Code to spawn the server with.
    let nodePath = 'node';
    try { if (whichSync) nodePath = whichSync('node'); } catch { /* use bare 'node' */ }

    // Build Claude CLI args. A shell session takes none of them — `$SHELL`
    // spawns bare.
    const args: string[] = [];
    if (!isShell) {
      if (opts.skipPermissions) {
        args.push('--dangerously-skip-permissions');
      }
      if (opts.resumeSessionId) {
        args.push('--resume', opts.resumeSessionId);
      }
      if (opts.model) {
        args.push('--model', opts.model);
      }
      // Give this session YouCoded's SendUserLink tool (claude-code-mcp.ts) —
      // Claude Code has no link deliverable of its own. Best-effort: if the
      // deploy throws (read-only userData, disk full) the session still starts,
      // just without the link tool. Pushing a --mcp-config path that does not
      // exist would instead be a hard startup failure for the whole session.
      try {
        args.push(...deployClaudeCodeLinkMcp(app.getPath('userData'), nodePath).args);
      } catch (err) {
        log('WARN', 'SessionManager', 'SendUserLink MCP deploy failed — this session starts without the link tool', { error: String(err) });
      }
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
      provider,
      // A shell session has no model — nothing in it talks to one.
      model: isShell ? undefined : opts.model,
      // Carry initialInput through so the renderer can prefill the input bar.
      // Omit the key entirely when undefined to keep the object clean.
      ...(opts.initialInput !== undefined ? { initialInput: opts.initialInput } : {}),
      // The shell's own name is how the strip and header label this session —
      // it has no model alias and no harness preset to label it with.
      ...(isShell ? { shellName: shellDisplayName(shellCommand) } : {}),
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

    // The command a "Run in terminal" shell session was created for. It waits
    // here until the shell has produced its FIRST OUTPUT.
    //
    // WHY not write it at spawn time: a shell that is still starting up may
    // never see input typed before its line editor exists, and the terminal
    // then opens empty with no sign of what the user was meant to run. Writing
    // on spawn only works because the kernel's tty buffer happens to hold the
    // bytes until the shell reads them — luck, not a guarantee, and a shell
    // that flushes its input at startup would silently swallow it.
    // Waiting for output costs nothing and does not depend on that.
    // (The first frame is usually the shell's terminal-capability QUERY rather
    // than its prompt; by the time it lands, the shell is reading input.
    // Measured on fish, zsh and bash by test-engine/probe-shell-command.mjs,
    // which also carries the fallback to reach for if a shell ever fails:
    // wait for output to go quiet, not just to start.)
    let pendingCommand: string | null =
      isShell && opts.initialCommand ? opts.initialCommand : null;
    const flushCommand = () => {
      if (pendingCommand === null) return;
      const command = pendingCommand;
      pendingCommand = null;
      clearTimeout(commandFallbackTimer);
      // NO trailing carriage return: the app never runs a set-up command for
      // the user. The line sits on the prompt for them to read, edit or Enter.
      //
      // 'input-chunked', not sendInput: this is the one write with no trailing
      // \r that can be long, and Windows ConPTY silently truncates a single
      // write over ~600 chars — a truncated command would sit half-typed on the
      // prompt for the user to run. Ordinary typing and paste keep the single
      // unchunked write they have always had.
      const session = this.sessions.get(id);
      try { session?.worker?.send({ type: 'input-chunked', data: command }); }
      catch { /* worker IPC already closed — the session is gone */ }
    };
    // Backstop for a shell that reads input before it writes anything: without
    // it the command would never be typed and the terminal would sit blank
    // forever with no hint of what the user was meant to run. Waiting is still
    // the rule; this only decides how long "waiting" lasts.
    const commandFallbackTimer = pendingCommand === null
      ? undefined
      : setTimeout(flushCommand, SessionManager.COMMAND_FALLBACK_MS);

    worker.on('message', (msg: any) => {
      switch (msg.type) {
        case 'data':
          this.emit('pty-output', id, msg.data);
          // Type the command onto the prompt, exactly once.
          flushCommand();
          break;
        case 'exit':
          clearTimeout(commandFallbackTimer);
          if (!this.sessions.has(id)) return;
          const exitingSession = this.sessions.get(id)!;
          exitingSession.info.status = 'destroyed';
          this.emit('session-exit', id, msg.exitCode);
          this.sessions.delete(id);
          break;
      }
    });

    worker.on('exit', () => {
      clearTimeout(commandFallbackTimer);
      if (!this.sessions.has(id)) return;
      const exitingSession = this.sessions.get(id)!;
      exitingSession.info.status = 'destroyed';
      this.emit('session-exit', id, 0);
      this.sessions.delete(id);
    });

    // Tell the worker to spawn the CLI, passing our session ID
    // so hook events can be correlated back to this session.
    // Wrapped in try/catch because send() throws synchronously if
    // the spawn failed (IPC channel never opened), which happens
    // before the async 'error' event fires.
    try {
      worker.send({
        type: 'spawn',
        command: isShell ? shellCommand : 'claude',
        args,
        cwd: resolvedCwd,
        cols: opts.cols || 80,
        rows: opts.rows || 24,
        // Session ID + pipe name for hook event correlation. Both are blanked
        // for a shell session: there is no hook pipe for it, so if the user
        // happens to start Claude Code inside this terminal it must not report
        // its hooks as if they belonged to this session (which would attach a
        // transcript, and a chat view, to a plain shell).
        sessionId: isShell ? '' : id,
        pipeName: isShell ? '' : this.pipeName,
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
    // Uniform teardown: native sessions (no worker) still emit session-exit so
    // downstream cleanup (window release, remote broadcast) runs identically.
    this.emit('session-exit', id, 0);
    if (session.worker) {
      try {
        session.worker.send({ type: 'kill' });
        session.worker.disconnect();
      } catch {
        // Worker IPC already closed (e.g., process crashed or exited)
      }
    }
    return true;
  }

  sendInput(id: string, text: string): boolean {
    const session = this.sessions.get(id);
    if (!session || !session.worker) return false; // native sessions have no PTY
    try { session.worker.send({ type: 'input', data: text }); } catch { return false; }
    return true;
  }

  resizeSession(id: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(id);
    if (!session || !session.worker) return false; // native sessions have no PTY
    try { session.worker.send({ type: 'resize', cols, rows }); } catch { return false; }
    return true;
  }

  listSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map(s => s.info);
  }

  // Optional per-session hold for broadcastReloadPlugins. Wired to
  // HookRelay.hasPendingPermission in main.ts: while a permission /
  // AskUserQuestion request is pending, the session's TUI shows a live Ink
  // select menu, and typing "/reload-plugins\r" into it would press Enter on
  // the highlighted option — silently answering the prompt (2026-07-09
  // stray-Enter fix). Returns true when the session must NOT receive input.
  private reloadPluginsGate: ((sessionId: string) => boolean) | null = null;

  setReloadPluginsGate(gate: (sessionId: string) => boolean): void {
    this.reloadPluginsGate = gate;
  }

  /** How long a shell session waits for its first output before typing the
   *  command anyway. Measured (test-engine/probe-shell-command.mjs): fish, the
   *  slowest of the three shells here, produces its first frame in ~50 ms even
   *  when it then blocks on a terminal query, so this only fires for a shell
   *  that writes nothing at all. */
  private static readonly COMMAND_FALLBACK_MS = 3000;

  private static readonly RELOAD_RETRY_MS = 5000;
  private static readonly RELOAD_MAX_RETRIES = 24; // ~2 minutes of deferral

  /**
   * Send `/reload-plugins` to every active session after a short delay.
   * The delay gives Claude Code time to (a) flush its cached plugin state
   * and (b) be ready for input at the prompt. Firing immediately after an
   * install races with both and the reload silently no-ops.
   *
   * Sessions the gate reports blocked are retried every RELOAD_RETRY_MS for
   * up to RELOAD_MAX_RETRIES (so the reload still lands once the user answers
   * the prompt), then dropped — a missed reload is recoverable (next install
   * or a manual /reload-plugins), an auto-answered prompt is not.
   */
  broadcastReloadPlugins(delayMs: number = 1500): void {
    setTimeout(() => {
      for (const s of this.listSessions()) {
        // Only Claude Code understands /reload-plugins. A shell session has a
        // real PTY, so without this guard the literal text "/reload-plugins"
        // plus an Enter would be typed into — and RUN by — the user's shell.
        if (s.status === 'active' && s.provider !== 'shell') this.sendReloadWhenClear(s.id, 0);
      }
    }, delayMs);
  }

  private sendReloadWhenClear(id: string, attempt: number): void {
    const session = this.sessions.get(id);
    if (!session || session.info.status !== 'active') return;
    if (this.reloadPluginsGate?.(id)) {
      if (attempt >= SessionManager.RELOAD_MAX_RETRIES) return;
      setTimeout(
        () => this.sendReloadWhenClear(id, attempt + 1),
        SessionManager.RELOAD_RETRY_MS,
      );
      return;
    }
    this.sendInput(id, '/reload-plugins\r');
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
