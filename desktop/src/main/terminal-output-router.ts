// PTY output routing to desktop terminals, with buffering until a terminal mounts and flow control
// (extracted from ipc-handlers.ts, 2026-10-04 review round). See terminal-flow.ts for the brake rules.
import { TerminalFlow, watchWebContents } from './terminal-flow';

// Output waiting for a terminal to mount is capped at the newest this-many characters — the same
// "keep the tail" rule as the remote ring buffer — instead of growing without bound.
const PENDING_CAP = 4 * 1024 * 1024;

export interface RouterDeps {
  ipcMain: { on(channel: string, fn: (event: any, ...args: any[]) => void): unknown };
  sessionManager: {
    on(event: string, fn: (...args: any[]) => void): unknown;
    ackOutput(sessionId: string, chars: number): unknown;
  };
  windowRegistry?: { on(event: string, fn: () => void): unknown; getOwner(sessionId: string): number | undefined };
  routeTargets(sessionId: string): number[];
  sendForSession(sessionId: string, channel: string, ...args: any[]): void;
  fromId(id: number): { isDestroyed(): boolean; on(e: string, f: (...a: any[]) => void): unknown; removeListener(e: string, f: (...a: any[]) => void): unknown } | undefined;
  channels: { ready: string; ack: string };
}

/** Wire pty-output -> windows, terminal ready/ack handling and flow control. Returns the session-exit cleanup. */
export function createTerminalOutputRouter(d: RouterDeps): (sessionId: string) => void {
  // Buffer output per-session until the renderer signals its terminal is mounted. This prevents losing the
  // initial trust prompt on slow systems where PTY output arrives before TerminalView registers its listener.
  const pendingOutput = new Map<string, string[]>();
  const pendingChars = new Map<string, number>();
  const readySessions = new Set<string>();

  const reconcile = (lost: string[] = []) => {
    flow.recompute();
    // A session nobody can draw falls back to buffering until a terminal mounts again.
    for (const sid of readySessions) if (lost.includes(sid) || !flow.hasConsumer(sid)) readySessions.delete(sid);
  };
  const flow: TerminalFlow = new TerminalFlow({
    targets: d.routeTargets,
    isOwner: (sid, wid) => d.windowRegistry?.getOwner(sid) === wid,
    alive: (wid) => { const wc = d.fromId(wid); return !!wc && !wc.isDestroyed(); },
    release: (sid, n) => { d.sessionManager.ackOutput(sid, n); },
    now: () => Date.now(),
    watch: (wid, gone) => { const wc = d.fromId(wid); if (wc) watchWebContents(wc, gone); },
    lost: (sids) => reconcile(sids),
  });
  d.windowRegistry?.on('changed', () => reconcile());

  // Perf: output goes to the per-session channel only (the old global broadcast is gone — App.tsx subscribes per session).
  d.sessionManager.on('pty-output', (sessionId: string, data: string) => {
    const routed = readySessions.has(sessionId);
    if (routed) {
      d.sendForSession(sessionId, `pty:output:${sessionId}`, data);
    } else {
      let buf = pendingOutput.get(sessionId);
      if (!buf) { buf = []; pendingOutput.set(sessionId, buf); }
      buf.push(data);
      let held = (pendingChars.get(sessionId) ?? 0) + data.length;
      while (held > PENDING_CAP && buf.length > 1) held -= buf.shift()!.length;
      pendingChars.set(sessionId, held);
    }
    flow.output(sessionId, data.length, routed);
  });

  // A terminal mounted in the sending window.
  d.ipcMain.on(d.channels.ready, (event, sessionId: string) => {
    const wid = event.sender.id;
    if (!d.routeTargets(sessionId).includes(wid)) return;   // output is not sent to this window: it cannot be a terminal for the session
    const ownerId = d.windowRegistry?.getOwner(sessionId);
    // Only the session's PRIMARY terminal opens the pre-mount buffer; a second window mounting joins as a
    // consumer without touching anyone else's books.
    const primary = ownerId == null || ownerId === wid;
    flow.ready(sessionId, wid, primary ? (pendingChars.get(sessionId) ?? 0) : 0);
    if (!primary) return;
    readySessions.add(sessionId);
    const buffered = pendingOutput.get(sessionId);
    pendingOutput.delete(sessionId);
    pendingChars.delete(sessionId);
    for (const data of buffered ?? []) d.sendForSession(sessionId, `pty:output:${sessionId}`, data);
  });

  // The terminal finished drawing `chars`: believed from any window that is a terminal for this session and
  // receives its output; the program follows the slowest of them.
  d.ipcMain.on(d.channels.ack, (event, sessionId: string, chars: number) => {
    if (typeof sessionId !== 'string' || typeof chars !== 'number' || !Number.isFinite(chars) || chars <= 0) return;
    flow.ack(sessionId, event.sender.id, Math.min(chars, 1e9));
  });

  return (sessionId: string) => {
    pendingOutput.delete(sessionId); pendingChars.delete(sessionId); flow.end(sessionId); readySessions.delete(sessionId);
  };
}
