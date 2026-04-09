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

    // Multi-connection per username is allowed: a single GitHub user can
    // legitimately be in the lobby from Mac + Windows + remote browser at
    // the same time. The previous version forcibly evicted older connections
    // with code 4001, which created a supersede war when two real clients
    // held the same username — each new connection kicked the other and they
    // ping-pong reconnected forever (the lobby flicker bug). Heartbeat sweep
    // (65s) cleans up genuinely-dead duplicates instead.
    const alreadyPresent = this.hasUsername(username);

    this.users.set(connection.id, { username, status: "idle", lastSeen: Date.now() });
    console.log(`[lobby] connect ${username} (${this.users.size} conns, alreadyPresent=${alreadyPresent})`);

    // Send the deduplicated presence list to the new connection
    connection.send(JSON.stringify({
      type: "presence",
      users: this.getUserList(),
    }));

    // Only broadcast user-joined when this is a brand-new user — additional
    // connections from an already-present user are silent so the UI doesn't
    // churn when the user is signed in on multiple devices.
    if (!alreadyPresent) {
      this.room.broadcast(
        JSON.stringify({ type: "user-joined", username, status: "idle" }),
        [connection.id],
      );
    }

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
        // Heartbeat — respond with full presence list so clients self-correct
        // any missed user-joined/user-left events (fixes asymmetric visibility)
        sender.send(JSON.stringify({
          type: "pong",
          users: this.getUserList(),
        }));
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
        const targetConns = this.findConnectionsByUsername(data.target);
        if (targetConns.length > 0) {
          // Fan out to every connection for this user — they may be on
          // multiple devices and we want all of them to see the challenge
          const msg = JSON.stringify({
            type: "challenge",
            from: senderInfo.username,
            gameType: data.gameType,
            code: data.code,
          });
          for (const conn of targetConns) conn.send(msg);
        } else {
          console.log(`[lobby] challenge ${senderInfo.username} → ${data.target} (no target)`);
          // Target not found — tell challenger so they aren't stuck waiting
          sender.send(JSON.stringify({
            type: "challenge-failed",
            target: data.target,
          }));
        }
        break;
      }

      case "challenge-response": {
        const challengerConns = this.findConnectionsByUsername(data.from);
        const msg = JSON.stringify({
          type: "challenge-response",
          from: senderInfo.username,
          accept: data.accept,
        });
        for (const conn of challengerConns) conn.send(msg);
        break;
      }
    }
  }

  onClose(connection: Party.Connection) {
    const info = this.users.get(connection.id);
    if (info) {
      this.users.delete(connection.id);
      const stillPresent = this.hasUsername(info.username);
      console.log(`[lobby] disconnect ${info.username} (${this.users.size} conns, stillPresent=${stillPresent})`);
      // Only broadcast user-left when this was the user's LAST connection.
      // Multi-connection support — see onConnect for the rationale.
      if (!stillPresent) {
        this.room.broadcast(JSON.stringify({
          type: "user-left",
          username: info.username,
        }));
      }
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
        console.log(`[lobby] sweep evict ${info.username} (idle ${Math.round((now - info.lastSeen) / 1000)}s)`);
        // Same multi-connection logic as onClose: only broadcast user-left
        // when no other live connections remain for this username
        if (!this.hasUsername(info.username)) {
          this.room.broadcast(JSON.stringify({
            type: "user-left",
            username: info.username,
          }));
        }
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

  private hasUsername(username: string): boolean {
    for (const info of this.users.values()) {
      if (info.username === username) return true;
    }
    return false;
  }

  private getUserList(): Array<{ username: string; status: string }> {
    // Dedupe by username (multi-connection support). 'in-game' wins over
    // 'idle' so the lobby reflects the most-occupied state when a user
    // is signed in on multiple devices.
    const seen = new Map<string, string>();
    for (const info of this.users.values()) {
      const existing = seen.get(info.username);
      if (!existing || (existing === "idle" && info.status === "in-game")) {
        seen.set(info.username, info.status);
      }
    }
    return Array.from(seen.entries()).map(([username, status]) => ({ username, status }));
  }

  private findConnectionsByUsername(username: string): Party.Connection[] {
    const targetIds = new Set<string>();
    for (const [connId, info] of this.users) {
      if (info.username === username) targetIds.add(connId);
    }
    const result: Party.Connection[] = [];
    for (const conn of this.room.getConnections()) {
      if (targetIds.has(conn.id)) result.push(conn);
    }
    return result;
  }
}
