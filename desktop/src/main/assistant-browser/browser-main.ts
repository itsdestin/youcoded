// The Browser's main-process lifecycle (2026-10-13), lifted out of main.ts:
// pushes to windows, the Claude Code relay, closing a conversation's tabs when
// it ends, and shutdown. Spec docs/active/specs/2026-10-13-assistant-browser-design.md.
import { app } from 'electron';
import { log } from '../logger';
import { wireBrowserPushes } from '../ipc/browser';
import { browserClientIfCreated, getBrowserClient } from './browser-electron';
import { BrowserRelayServer, deployBrowserRelay, setBrowserRelayAttachment } from './claude-code-browser-mcp';

interface Sessions {
  getSession(id: string): { provider?: string } | undefined;
  on(event: 'session-exit', cb: (id: string) => void): unknown;
  on(event: 'session-created', cb: () => void): unknown;
}

let relay: BrowserRelayServer | null = null;

/** Startup: state pushes reach windows from the first tool call, and the Claude
 *  Code relay starts in the background — a Claude Code session that starts
 *  first simply goes without the Browser. Native sessions reach the Browser
 *  in-process (create-runtime.ts). Never forks the worker or a browser. */
export function startBrowserSupport(sessions: Sessions): void {
  wireBrowserPushes();
  void startRelay(sessions).catch((e) => log('WARN', 'Browser', 'relay did not start — Claude Code sessions start without the Browser', { error: String(e) }));
}

async function startRelay(sessions: Sessions): Promise<void> {
  const server = new BrowserRelayServer({
    callTool: (sessionId, tool, args, opts) => getBrowserClient().callTool(sessionId, tool, args, opts),
    isClaudeSession: (id) => sessions.getSession(id)?.provider === 'claude',
    log: (level, msg, data) => log(level, 'Browser', msg, data),
  });
  const socketPath = await server.start();
  relay = server;
  // WHY: a deleted socket file would silently cut every Claude Code session off
  // the Browser until restart — re-create it as each session starts.
  sessions.on('session-created', () => { void server.ensureListening(); });
  // The same interpreter the PTY worker and the other app MCP servers use
  // (system Node), resolved without blocking.
  let nodePath = 'node';
  try { nodePath = await (require('which') as (cmd: string) => Promise<string>)('node'); } catch { /* bare 'node' */ }
  setBrowserRelayAttachment(await deployBrowserRelay(app.getPath('userData'), nodePath, socketPath, server.token));
}

/** What native sessions get as `services.browser`. Forks nothing until the first call. */
export function browserToolService() {
  return { callTool: (sessionId: string, tool: string, args: unknown, opts: { signal?: AbortSignal; vision: boolean }) => getBrowserClient().callTool(sessionId, tool, args, opts) };
}

/** A conversation that ends closes its Browser tabs (both session kinds emit session-exit). */
export function wireBrowserSessionCleanup(sessions: Sessions): void {
  sessions.on('session-exit', (id: string) => {
    browserClientIfCreated()?.commandIfAlive({ cmd: 'close-session', sessionId: id, forget: true });
  });
}

/** Quit: close the browser it launched (never the person's own Chrome) and stop
 *  the relay. BrowserClient.dispose() is bounded (3 s, then kill). */
export function stopBrowserSupport(): Promise<void> {
  return Promise.all([browserClientIfCreated()?.dispose(), relay?.stop()]).then(() => undefined, () => undefined);
}
