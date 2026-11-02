// host-bridge.ts — the headless backend's line to the app that started it.
//
// WHY (2026-10-14, Android clean rebuild P1): on a phone the backend is a plain Node process the
// Android app starts. Things only the phone can do — open a link in the browser, keep the CPU
// awake, show a notification, pick a file — are asked of the app over one local socket, one JSON
// object per line: {id, method, params} → {id, result} | {id, error}. The app names the socket in
// YOUCODED_HOST_SOCKET (a Linux abstract socket name, written "@name"). Without it (the backend run
// on a laptop for testing) every call answers locally: links are printed, the rest are no-ops.
import net from 'net';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

let socket: net.Socket | null = null;
let connecting: Promise<net.Socket | null> | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();
const HOST_CALL_TIMEOUT_MS = 60_000;

function socketPath(): string | null {
  const name = process.env.YOUCODED_HOST_SOCKET;
  if (!name) return null;
  // Node addresses a Linux abstract socket with a leading NUL byte.
  return name.startsWith('@') ? `\0${name.slice(1)}` : name;
}

function connect(): Promise<net.Socket | null> {
  if (socket) return Promise.resolve(socket);
  if (connecting) return connecting;
  const target = socketPath();
  if (!target) return Promise.resolve(null);
  connecting = new Promise((resolve) => {
    const s = net.createConnection(target);
    let buf = '';
    s.setEncoding('utf8');
    s.on('connect', () => { socket = s; connecting = null; resolve(s); });
    s.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: string; event?: string; params?: unknown };
          if (msg.event) { for (const l of eventListeners) l(msg.event, msg.params); continue; }
          const p = msg.id != null ? pending.get(msg.id) : undefined;
          if (!p) continue;
          pending.delete(msg.id!);
          if (msg.error) p.reject(new Error(msg.error)); else p.resolve(msg.result);
        } catch { /* a malformed line from the host is dropped, never fatal */ }
      }
    });
    const fail = () => {
      socket = null; connecting = null;
      for (const p of pending.values()) p.reject(new Error('The app stopped answering.'));
      pending.clear();
      resolve(null);
    };
    s.on('error', fail);
    s.on('close', fail);
  });
  return connecting;
}

/** True when an app is on the other end (a phone), false when run bare (a laptop test). */
export function hasHost(): boolean {
  return socketPath() !== null;
}

/** Ask the host app to do something only it can. Rejects when the host refuses or is gone. */
export async function hostCall<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const s = await connect();
  if (!s) throw new Error(`No host app to handle ${method}.`);
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`The app did not answer ${method}.`)); }, HOST_CALL_TIMEOUT_MS);
    timer.unref?.();
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v as T); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    s.write(JSON.stringify({ id, method, params }) + '\n');
  });
}

/** Fire-and-forget form for calls whose answer nobody waits on (keep-awake, notifications). */
export function hostNotify(method: string, params: Record<string, unknown> = {}): void {
  if (!hasHost()) return;
  void hostCall(method, params).catch((e) => console.warn(`[host-bridge] ${method} failed:`, e instanceof Error ? e.message : e));
}

/** WHY (2026-11-01 phone test): after a web sign-in (Claude, ChatGPT) the person was stranded on the browser's
 *  "you can close this window". Tell the app to bring YouCoded back to the front. No-op on a computer. */
export function returnToApp(): void {
  hostNotify('bringToFront');
}

const eventListeners = new Set<(event: string, params: unknown) => void>();
/** Events the host pushes on its own (network changed, app backgrounded). */
export function onHostEvent(listener: (event: string, params: unknown) => void): () => void {
  eventListeners.add(listener);
  if (hasHost()) void connect();
  return () => { eventListeners.delete(listener); };
}
