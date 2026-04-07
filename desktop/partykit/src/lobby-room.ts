// partykit/src/lobby-room.ts
import type * as Party from "partykit/server";

const HEARTBEAT_INTERVAL = 30_000; // 30s — matches client ping interval
const HEARTBEAT_TIMEOUT = 65_000;  // miss ~2 pings → evict

interface UserInfo {
  username: string;
  status: "idle" | "in-game";
  lastSeen: number;
}

export default class LobbyRoom implements Party.Server {
  private users = new Map<string, UserInfo>(); // connectionId → user info
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(readonly room: Party.Room) {}

  onConnect(connection: Party.Connection, ctx: Party.ConnectionContext) {
    const url = new URL(ctx.request.url);
    const username = url.searchParams.get("username");
    if (!username) {
      connection.close(4000, "Missing username");
      return;
    }

    // Evict stale connections for the same username (reconnect / duplicate tab)
    for (const [connId, info] of this.users) {
      if (info.username === username && connId !== connection.id) {
        this.users.delete(connId);
        // Close the stale socket so the other end knows
        for (const conn of this.room.getConnections()) {
          if (conn.id === connId) {
            conn.close(4001, "Superseded by new connection");
            break;
          }
        }
      }
    }

    this.users.set(connection.id, { username, status: "idle", lastSeen: Date.now() });

    // Send full user list to the new connection
    connection.send(JSON.stringify({
      type: "presence",
      users: this.getUserList(),
    }));

    // Broadcast join to everyone else
    this.room.broadcast(
      JSON.stringify({ type: "user-joined", username, status: "idle" }),
      [connection.id],
    );

    // Start heartbeat sweep if not already running
    if (!this.sweepTimer) {
      this.sweepTimer = setInterval(() => this.sweepStale(), HEARTBEAT_INTERVAL);
    }
  }

  onMessage(message: string | ArrayBuffer, sender: Party.Connection) {
    if (typeof message !== "string") return;

    let data: any;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }

    const senderInfo = this.users.get(sender.id);
    if (!senderInfo) return;

    // Any message counts as a heartbeat
    senderInfo.lastSeen = Date.now();

    switch (data.type) {
      case "ping":
        // Heartbeat — lastSeen already updated above, nothing else to do
        break;

      case "status": {
        senderInfo.status = data.status;
        this.room.broadcast(JSON.stringify({
          type: "user-status",
          username: senderInfo.username,
          status: data.status,
        }));
        break;
      }

      case "challenge": {
        const targetConn = this.findConnectionByUsername(data.target);
        if (targetConn) {
          targetConn.send(JSON.stringify({
            type: "challenge",
            from: senderInfo.username,
            gameType: data.gameType,
            code: data.code,
          }));
        }
        break;
      }

      case "challenge-response": {
        const challengerConn = this.findConnectionByUsername(data.from);
        if (challengerConn) {
          challengerConn.send(JSON.stringify({
            type: "challenge-response",
            from: senderInfo.username,
            accept: data.accept,
          }));
        }
        break;
      }
    }
  }

  onClose(connection: Party.Connection) {
    const info = this.users.get(connection.id);
    if (info) {
      this.users.delete(connection.id);
      this.room.broadcast(JSON.stringify({
        type: "user-left",
        username: info.username,
      }));
    }
    this.stopSweepIfEmpty();
  }

  onError(connection: Party.Connection) {
    this.onClose(connection);
  }

  private sweepStale() {
    const now = Date.now();
    for (const [connId, info] of this.users) {
      if (now - info.lastSeen > HEARTBEAT_TIMEOUT) {
        this.users.delete(connId);
        this.room.broadcast(JSON.stringify({
          type: "user-left",
          username: info.username,
        }));
        // Also close the dead socket
        for (const conn of this.room.getConnections()) {
          if (conn.id === connId) {
            conn.close(4003, "Heartbeat timeout");
            break;
          }
        }
      }
    }
    this.stopSweepIfEmpty();
  }

  private stopSweepIfEmpty() {
    if (this.users.size === 0 && this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  private getUserList(): Array<{ username: string; status: string }> {
    return Array.from(this.users.values()).map(({ username, status }) => ({ username, status }));
  }

  private findConnectionByUsername(username: string): Party.Connection | null {
    for (const conn of this.room.getConnections()) {
      const info = this.users.get(conn.id);
      if (info && info.username === username) return conn;
    }
    return null;
  }
}
