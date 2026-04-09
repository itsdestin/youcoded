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
}

export class PartyClient {
  private socket: PartySocket;

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

    if (options.onOpen) {
      this.socket.addEventListener("open", options.onOpen);
    }
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
    this.socket.close();
  }

  get readyState(): number {
    return this.socket.readyState;
  }
}
