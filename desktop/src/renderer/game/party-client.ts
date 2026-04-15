import PartySocket from "partysocket";

// Injected by Vite's `define` config when VITE_PARTYKIT_HOST is set;
// falls back to the production URL at build time.
declare const __PARTYKIT_HOST__: string | undefined;
export const PARTYKIT_HOST =
  (typeof __PARTYKIT_HOST__ !== 'undefined' ? __PARTYKIT_HOST__ : null)
  ?? "destinclaude-games.itsdestin.partykit.dev";

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
  private socket: PartySocket;
  private slowTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: PartyClientOptions) {
    this.socket = new PartySocket({
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
