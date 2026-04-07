import PartySocket from "partysocket";

// Update this after deploying
export const PARTYKIT_HOST = "destinclaude-games.itsdestin.partykit.dev";

export type MessageHandler = (data: any) => void;

export interface PartyClientOptions {
  host?: string;
  party?: string;
  room: string;
  username: string;
  onMessage: MessageHandler;
  onOpen?: () => void;
  onClose?: () => void;
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
      this.socket.addEventListener("close", options.onClose);
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
