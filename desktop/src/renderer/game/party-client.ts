import PartySocket from "partysocket";

// Injected by Vite's `define` config when VITE_PARTYKIT_HOST is set;
// falls back to the production URL at build time.
// WHY api.youcoded.ai: hosted PartyKit shut down 2026-10-23. The Connect 4 and
// Chess rooms now run inside the marketplace Worker, at
// wss://api.youcoded.ai/parties/<connectfour|chess>/<room>. partysocket's
// default URL prefix is already "parties", so no extra option is needed.
// Builds from before this change still point at the dead PartyKit host.
declare const __PARTYKIT_HOST__: string | undefined;
const PARTYKIT_HOST =
  (typeof __PARTYKIT_HOST__ !== 'undefined' ? __PARTYKIT_HOST__ : null)
  ?? "api.youcoded.ai";

// Structural subset of PartySocket (really: ReconnectingWebSocket) that this
// file actually calls. The real PartySocket satisfies it automatically; a
// workbench fake only has to implement these five members, not the whole
// partysocket surface.
interface PartySocketSubset {
  addEventListener(type: string, cb: (event: any) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
}

// Workbench-only injection point (Task 7c). usePartyGame.ts constructs
// `new PartyClient(options)` with no way to pass a socket class, so a module-
// level override is the only seam that doesn't touch that production hook.
// Only dev/workbench/install-mock.ts ever calls this — it is gated there on
// the same `?signedIn=1` switch the rest of the workbench mock uses, and this
// stays null (real `PartySocket`, real server) in every shipped build.
type PartySocketCtor = new (options: { host: string; room?: string; party?: string; query?: Record<string, string | undefined | null> }) => PartySocketSubset;
let socketFactoryOverride: PartySocketCtor | null = null;
export function __setPartySocketFactory(factory: PartySocketCtor | null): void {
  socketFactoryOverride = factory;
}

export type MessageHandler = (data: any) => void;

// Close info forwarded to onClose so callers can surface the reason a socket
// dropped (e.g., 4001 superseded, 4003 heartbeat timeout, 1006 abnormal).
export interface CloseInfo {
  code: number;
  reason: string;
}

export interface PartyClientOptions {
  host?: string;
  party?: string;
  room: string;
  username: string;
  onMessage: MessageHandler;
  onOpen?: () => void;
  onClose?: (info: CloseInfo) => void;
  onError?: (error: Event) => void;
  /** Fires if the socket hasn't opened after `slowConnectMs`. Used so the UI
   * can swap the bare "Connecting…" spinner for a friendlier "taking longer
   * than usual" message + probe the server to classify the cause. */
  onSlowConnect?: () => void;
  /** Default 10_000 ms. Partysocket's own backoff is opaque to callers, so
   * we wrap it with a single "is this dragging on?" timer. */
  slowConnectMs?: number;
}

const DEFAULT_SLOW_MS = 10_000;

// Standard WebSocket readyState constants — hoisted so this file can be
// bundled into the Android WebView without depending on `WebSocket` globals
// at module evaluation time.
const WS_OPEN = 1;

export class PartyClient {
  private socket: PartySocketSubset;
  private slowTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: PartyClientOptions) {
    const SocketCtor: PartySocketCtor = socketFactoryOverride ?? PartySocket;
    this.socket = new SocketCtor({
      host: options.host ?? PARTYKIT_HOST,
      room: options.room,
      party: options.party,
      query: { username: options.username },
    });

    this.socket.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(event.data);
        options.onMessage(data);
      } catch {
        // Ignore non-JSON messages
      }
    });

    // Start the slow-connect timer. If the socket opens first, clear it;
    // otherwise fire onSlowConnect so callers can surface a friendlier state
    // without waiting on partysocket's silent reconnect loop.
    if (options.onSlowConnect) {
      const ms = options.slowConnectMs ?? DEFAULT_SLOW_MS;
      this.slowTimer = setTimeout(() => {
        this.slowTimer = null;
        if (this.socket.readyState !== WS_OPEN) {
          options.onSlowConnect!();
        }
      }, ms);
    }

    this.socket.addEventListener("open", () => {
      if (this.slowTimer) {
        clearTimeout(this.slowTimer);
        this.slowTimer = null;
      }
      options.onOpen?.();
    });
    if (options.onClose) {
      // Forward code/reason so the caller can show *why* the socket dropped
      this.socket.addEventListener("close", (event: CloseEvent) => {
        options.onClose!({ code: event.code, reason: event.reason });
      });
    }
    if (options.onError) {
      this.socket.addEventListener("error", options.onError);
    }
  }

  send(data: any): void {
    this.socket.send(JSON.stringify(data));
  }

  close(): void {
    if (this.slowTimer) {
      clearTimeout(this.slowTimer);
      this.slowTimer = null;
    }
    this.socket.close();
  }

  get readyState(): number {
    return this.socket.readyState;
  }
}
