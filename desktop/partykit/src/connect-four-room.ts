// partykit/src/connect-four-room.ts
import type * as Party from "partykit/server";

const MAX_PLAYERS = 2;

export default class ConnectFourRoom implements Party.Server {
  private players = new Map<string, string>(); // connectionId → username

  constructor(readonly room: Party.Room) {}

  onConnect(connection: Party.Connection, ctx: Party.ConnectionContext) {
    const url = new URL(ctx.request.url);
    const username = url.searchParams.get("username");
    if (!username) {
      connection.close(4000, "Missing username");
      return;
    }

    // Handle reconnection: if this username is already in the room,
    // replace the stale connection instead of adding a duplicate
    let isReconnect = false;
    for (const [connId, name] of this.players) {
      if (name === username && connId !== connection.id) {
        this.players.delete(connId);
        for (const conn of this.room.getConnections()) {
          if (conn.id === connId) {
            conn.close(4001, "Superseded by reconnection");
            break;
          }
        }
        isReconnect = true;
        break;
      }
    }

    // Reject if room is full (2 different players already present)
    if (!isReconnect && this.players.size >= MAX_PLAYERS) {
      connection.send(JSON.stringify({ type: "room-full" }));
      connection.close(4002, "Room is full");
      return;
    }

    this.players.set(connection.id, username);

    // Tell the new/reconnecting player about everyone already in the room
    for (const [connId, name] of this.players) {
      if (connId !== connection.id) {
        connection.send(JSON.stringify({ type: "player-joined", username: name }));
      }
    }

    // Notify existing players — but mark reconnections so clients
    // can differentiate a new opponent from a socket blip
    this.room.broadcast(
      JSON.stringify({
        type: "player-joined",
        username,
        reconnect: isReconnect,
      }),
      [connection.id],
    );
  }

  onMessage(message: string | ArrayBuffer, sender: Party.Connection) {
    if (typeof message !== "string") return;
    this.room.broadcast(message, [sender.id]);
  }

  onClose(connection: Party.Connection) {
    const username = this.players.get(connection.id);
    if (username) {
      this.players.delete(connection.id);
      this.room.broadcast(JSON.stringify({
        type: "player-left",
        username,
      }));
    }
  }

  onError(connection: Party.Connection) {
    this.onClose(connection);
  }
}
