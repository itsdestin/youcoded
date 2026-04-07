# PartyKit Game Backend — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the GitHub Issues game backend with PartyKit for real-time multiplayer, keeping GitHub Issues for persistent stats/leaderboard only.

**Architecture:** PartyKit server with per-game room classes (LobbyRoom + ConnectFourRoom) deployed to Cloudflare edge. Client uses `partysocket` for WebSocket connections. Two new React hooks (`usePartyLobby`, `usePartyGame`) replace the single `useGitHubGame` hook. Favorites stored locally. GitHub Issues retained for leaderboard/stats.

**Tech Stack:** PartyKit (server), partysocket (client), TypeScript, React, existing GitHub API for stats

**Spec:** `docs/superpowers/specs/2026-03-27-partykit-game-backend-design.md`

---

## File Map

### PartyKit Server (new project)

```
partykit/
├── package.json
├── partykit.json
├── tsconfig.json
└── src/
    ├── lobby-room.ts          — presence + challenges for all users
    └── connect-four-room.ts   — relay for a single C4 game session
```

### Desktop Client — New Files

```
src/renderer/game/party-client.ts       — typed PartyKit connection wrapper
src/renderer/hooks/usePartyLobby.ts     — lobby presence + challenges hook
src/renderer/hooks/usePartyGame.ts      — gameplay hook (moves, chat, rematch)
```

### Desktop Client — Delete

```
src/renderer/game/github-game.ts        — replaced by PartyKit
src/renderer/hooks/useGitHubGame.ts     — replaced by usePartyLobby + usePartyGame
```

### Desktop Client — Modify

```
src/renderer/game/github-api.ts         — slim to stats-only (remove Issue search/comments)
src/renderer/state/game-types.ts        — swap GITHUB_* actions for PARTY_* actions
src/renderer/state/game-reducer.ts      — match new actions
src/renderer/App.tsx                    — swap useGitHubGame for new hooks
src/renderer/components/game/GamePanel.tsx    — update connection type
src/renderer/components/game/GameLobby.tsx    — update connection type, add favorites UI
src/renderer/components/game/ConnectFourBoard.tsx — update connection type
src/renderer/components/game/GameChat.tsx     — update connection type
src/renderer/components/game/GameOverlay.tsx  — update connection type
src/main/main.ts                        — add favorites IPC handlers
src/main/preload.ts                     — expose favorites IPC
package.json                            — add partysocket dependency
```

---

## Task 1: PartyKit Server Project Setup

**Files:**
- Create: `partykit/package.json`
- Create: `partykit/partykit.json`
- Create: `partykit/tsconfig.json`

- [ ] **Step 1: Create the partykit directory**

```bash
mkdir -p partykit/src
```

- [ ] **Step 2: Create package.json**

```json
{
  "name": "destinclaude-games",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "npx partykit dev",
    "deploy": "npx partykit deploy"
  },
  "dependencies": {
    "partykit": "latest"
  }
}
```

Write to `partykit/package.json`.

- [ ] **Step 3: Create partykit.json**

```json
{
  "name": "destinclaude-games",
  "main": "src/lobby-room.ts",
  "parties": {
    "connect-four": "src/connect-four-room.ts"
  }
}
```

Write to `partykit/partykit.json`.

The `main` party is the lobby (all users connect to it). The `connect-four` party handles individual game sessions. Each party type can have unlimited room instances (one per game code).

- [ ] **Step 4: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}
```

Write to `partykit/tsconfig.json`.

- [ ] **Step 5: Install dependencies**

```bash
cd partykit && npm install
```

- [ ] **Step 6: Commit**

```bash
git add partykit/package.json partykit/partykit.json partykit/tsconfig.json partykit/package-lock.json
git commit -m "feat(partykit): scaffold PartyKit server project"
```

---

## Task 2: LobbyRoom Server

**Files:**
- Create: `partykit/src/lobby-room.ts`

The LobbyRoom maintains an in-memory map of all connected users. When a user connects, it adds them to the map and broadcasts the full user list to everyone. When a user disconnects, it removes them and broadcasts the departure. Challenge messages are forwarded to the target user.

- [ ] **Step 1: Implement lobby-room.ts**

```typescript
// partykit/src/lobby-room.ts
import type * as Party from "partykit/server";

interface UserInfo {
  username: string;
  status: "idle" | "in-game";
}

export default class LobbyRoom implements Party.Server {
  readonly options = { hibernate: true };
  private users = new Map<string, UserInfo>(); // connectionId → user info

  constructor(readonly room: Party.Room) {}

  onConnect(connection: Party.Connection, ctx: Party.ConnectionContext) {
    // Client sends username as query param
    const url = new URL(ctx.request.url);
    const username = url.searchParams.get("username");
    if (!username) {
      connection.close(4000, "Missing username");
      return;
    }

    this.users.set(connection.id, { username, status: "idle" });

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

    switch (data.type) {
      case "status": {
        // User changed status (idle ↔ in-game)
        senderInfo.status = data.status;
        this.room.broadcast(JSON.stringify({
          type: "user-status",
          username: senderInfo.username,
          status: data.status,
        }));
        break;
      }

      case "challenge": {
        // Forward challenge to target user
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
        // Forward response back to challenger
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
  }

  onError(connection: Party.Connection) {
    this.onClose(connection);
  }

  private getUserList(): UserInfo[] {
    return Array.from(this.users.values());
  }

  private findConnectionByUsername(username: string): Party.Connection | null {
    for (const conn of this.room.getConnections()) {
      const info = this.users.get(conn.id);
      if (info && info.username === username) return conn;
    }
    return null;
  }
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd partykit && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add partykit/src/lobby-room.ts
git commit -m "feat(partykit): implement LobbyRoom with presence and challenges"
```

---

## Task 3: ConnectFourRoom Server

**Files:**
- Create: `partykit/src/connect-four-room.ts`

The ConnectFourRoom relays messages between two players in a game session. It tracks who's connected and broadcasts join/leave events. All game logic is client-side — this room just forwards messages.

- [ ] **Step 1: Implement connect-four-room.ts**

```typescript
// partykit/src/connect-four-room.ts
import type * as Party from "partykit/server";

export default class ConnectFourRoom implements Party.Server {
  readonly options = { hibernate: true };
  private players = new Map<string, string>(); // connectionId → username

  constructor(readonly room: Party.Room) {}

  onConnect(connection: Party.Connection, ctx: Party.ConnectionContext) {
    const url = new URL(ctx.request.url);
    const username = url.searchParams.get("username");
    if (!username) {
      connection.close(4000, "Missing username");
      return;
    }

    this.players.set(connection.id, username);

    // Notify the new player of who's already in the room
    for (const [connId, name] of this.players) {
      if (connId !== connection.id) {
        connection.send(JSON.stringify({ type: "player-joined", username: name }));
      }
    }

    // Notify existing players that someone joined
    this.room.broadcast(
      JSON.stringify({ type: "player-joined", username }),
      [connection.id],
    );
  }

  onMessage(message: string | ArrayBuffer, sender: Party.Connection) {
    if (typeof message !== "string") return;

    // Relay to all other connections in the room
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
```

- [ ] **Step 2: Verify it compiles**

```bash
cd partykit && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add partykit/src/connect-four-room.ts
git commit -m "feat(partykit): implement ConnectFourRoom message relay"
```

---

## Task 4: Deploy PartyKit Server

- [ ] **Step 1: Deploy to PartyKit**

```bash
cd partykit && npx partykit deploy
```

This will prompt for login on first run. Follow the browser auth flow. After deploy, note the host URL (e.g., `destinclaude-games.itsdestin.partykit.dev`).

- [ ] **Step 2: Test with dev server locally (optional)**

```bash
cd partykit && npx partykit dev
```

Opens a local server on `localhost:1999` for testing.

- [ ] **Step 3: Record the deployed host**

The host URL will be needed in the client code. It follows the pattern: `destinclaude-games.itsdestin.partykit.dev`. Record this for Task 5.

---

## Task 5: Add partysocket to Desktop App

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install partysocket**

```bash
npm install partysocket
```

- [ ] **Step 2: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add partysocket client dependency"
```

---

## Task 6: PartyKit Client Wrapper

**Files:**
- Create: `src/renderer/game/party-client.ts`

A thin typed wrapper around `PartySocket` that handles JSON serialization and provides a typed event interface.

- [ ] **Step 1: Implement party-client.ts**

```typescript
// src/renderer/game/party-client.ts
import PartySocket from "partysocket";

// Update this after deploying (Task 4)
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
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/game/party-client.ts
git commit -m "feat(game): add PartyKit client wrapper with typed interface"
```

---

## Task 7: Update State Types and Reducer

**Files:**
- Modify: `src/renderer/state/game-types.ts`
- Modify: `src/renderer/state/game-reducer.ts`

Replace GitHub-specific actions with PartyKit-specific ones. Remove `actionCount` and `movePending` (no longer needed — moves are instant, no polling race conditions).

- [ ] **Step 1: Update game-types.ts**

Replace the full `GameAction` type and `GameState` interface:

In `game-types.ts`, replace:
```typescript
export interface GameState {
  connected: boolean;
  githubError: string | null;
  username: string | null;
```
with:
```typescript
export interface GameState {
  connected: boolean;
  partyError: string | null;
  username: string | null;
```

Replace:
```typescript
  /** Monotonic version — total action count from GitHub comments */
  actionCount: number;
  /** True while a move API call is in flight — blocks clicks and polls */
  movePending: boolean;
}
```
with:
```typescript
}
```

Replace the `GameAction` type union. Remove `GITHUB_READY`, `GITHUB_ERROR`, `MOVE_PENDING`, and the `actionCount` field from `GAME_START`/`GAME_STATE`. Add `PARTY_CONNECTED`, `PARTY_DISCONNECTED`, `PARTY_ERROR`:

```typescript
export type GameAction =
  | { type: 'PARTY_CONNECTED'; username: string }
  | { type: 'PARTY_DISCONNECTED' }
  | { type: 'PARTY_ERROR'; message: string }
  | { type: 'PRESENCE_UPDATE'; online: OnlineUser[] }
  | { type: 'ROOM_CREATED'; code: string; color: PlayerColor }
  | { type: 'GAME_START'; board: number[][]; you: PlayerColor; opponent: string }
  | { type: 'GAME_STATE'; board: number[][]; turn: PlayerColor; lastMove: { col: number; row: number }; winner?: PlayerColor | 'draw'; winLine?: [number, number][] }
  | { type: 'GAME_OVER'; winner: PlayerColor | 'draw'; line?: [number, number][] }
  | { type: 'CHAT_MESSAGE'; from: string; text: string }
  | { type: 'OPPONENT_DISCONNECTED' }
  | { type: 'TOGGLE_PANEL' }
  | { type: 'RETURN_TO_LOBBY' }
  | { type: 'RESET' }
  | { type: 'CHALLENGE_RECEIVED'; from: string }
  | { type: 'CHALLENGE_DECLINED'; by: string }
  | { type: 'CLEAR_CHALLENGE' };
```

Update `createInitialGameState`:
```typescript
export function createInitialGameState(): GameState {
  return {
    connected: false,
    partyError: null,
    username: null,
    onlineUsers: [],
    screen: 'setup',
    roomCode: null,
    myColor: null,
    opponent: null,
    board: [],
    turn: 'red',
    lastMove: null,
    winner: null,
    winLine: null,
    chatMessages: [],
    panelOpen: false,
    challengeFrom: null,
    challengeDeclinedBy: null,
  };
}
```

- [ ] **Step 2: Update game-reducer.ts**

Replace `GITHUB_READY` with `PARTY_CONNECTED`, `GITHUB_ERROR` with `PARTY_ERROR`, add `PARTY_DISCONNECTED`, remove `CONNECTION_STATUS` and `MOVE_PENDING`:

```typescript
import { GameState, GameAction, createInitialGameState } from './game-types';

export function gameReducer(state: GameState, action: GameAction): GameState {
  switch (action.type) {
    case 'PARTY_CONNECTED':
      return { ...state, connected: true, username: action.username, screen: 'lobby', partyError: null };

    case 'PARTY_DISCONNECTED':
      return { ...state, connected: false };

    case 'PARTY_ERROR':
      return { ...state, connected: false, partyError: action.message };

    case 'PRESENCE_UPDATE':
      return { ...state, onlineUsers: action.online };

    case 'ROOM_CREATED':
      return {
        ...state,
        roomCode: action.code,
        myColor: action.color,
        screen: 'waiting',
      };

    case 'GAME_START':
      return {
        ...state,
        board: action.board,
        myColor: action.you,
        opponent: action.opponent,
        turn: 'red',
        screen: 'playing',
        winner: null,
        winLine: null,
        chatMessages: [],
        lastMove: null,
      };

    case 'GAME_STATE': {
      const next: GameState = {
        ...state,
        board: action.board,
        turn: action.turn,
        lastMove: action.lastMove,
      };
      if (action.winner) {
        return { ...next, winner: action.winner, winLine: action.winLine ?? null, screen: 'game-over' };
      }
      return next;
    }

    case 'GAME_OVER':
      return {
        ...state,
        winner: action.winner,
        winLine: action.line ?? null,
        screen: 'game-over',
      };

    case 'CHAT_MESSAGE':
      return {
        ...state,
        chatMessages: [
          ...state.chatMessages,
          { from: action.from, text: action.text, timestamp: Date.now() },
        ],
      };

    case 'OPPONENT_DISCONNECTED':
      return { ...state, opponent: null };

    case 'TOGGLE_PANEL':
      return { ...state, panelOpen: !state.panelOpen };

    case 'RETURN_TO_LOBBY':
      return {
        ...state,
        screen: 'lobby',
        roomCode: null,
        myColor: null,
        opponent: null,
        board: [],
        winner: null,
        winLine: null,
        chatMessages: [],
        lastMove: null,
      };

    case 'CHALLENGE_RECEIVED':
      return { ...state, challengeFrom: action.from, panelOpen: true };

    case 'CHALLENGE_DECLINED':
      return { ...state, challengeDeclinedBy: action.by };

    case 'CLEAR_CHALLENGE':
      return { ...state, challengeFrom: null, challengeDeclinedBy: null };

    case 'RESET':
      return createInitialGameState();

    default:
      return state;
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/state/game-types.ts src/renderer/state/game-reducer.ts
git commit -m "refactor(game): update state types for PartyKit (replace GitHub actions)"
```

---

## Task 8: Lobby Hook (usePartyLobby)

**Files:**
- Create: `src/renderer/hooks/usePartyLobby.ts`

This hook connects to the LobbyRoom on mount (once GitHub auth succeeds) and stays connected while the app is open. It handles presence updates and challenge relay.

- [ ] **Step 1: Implement usePartyLobby.ts**

```typescript
// src/renderer/hooks/usePartyLobby.ts
import { useEffect, useRef, useCallback } from 'react';
import { useGameDispatch, useGameState } from '../state/game-context';
import { PartyClient, PARTYKIT_HOST } from '../game/party-client';

export function usePartyLobby() {
  const dispatch = useGameDispatch();
  const state = useGameState();
  const clientRef = useRef<PartyClient | null>(null);
  const usernameRef = useRef<string | null>(null);

  // Initialize: get GitHub auth, connect to lobby
  useEffect(() => {
    let cancelled = false;
    const w = window as any;

    w.claude?.getGitHubAuth?.()
      .then((auth: { token: string; username: string } | null) => {
        if (cancelled) return;
        if (!auth) {
          dispatch({ type: 'PARTY_ERROR', message: 'GitHub CLI not authenticated. Run: gh auth login' });
          return;
        }

        usernameRef.current = auth.username;

        const client = new PartyClient({
          room: 'global-lobby',
          username: auth.username,
          onMessage: (data) => {
            switch (data.type) {
              case 'presence':
                dispatch({ type: 'PRESENCE_UPDATE', online: data.users });
                break;
              case 'user-joined':
                dispatch({ type: 'PRESENCE_UPDATE', online: [] }); // Will be replaced with merge logic below
                break;
              case 'user-left':
              case 'user-status':
                // These are handled by the full presence approach below
                break;
              case 'challenge':
                dispatch({ type: 'CHALLENGE_RECEIVED', from: data.from });
                break;
              case 'challenge-response':
                if (!data.accept) {
                  dispatch({ type: 'CHALLENGE_DECLINED', by: data.from });
                }
                break;
            }
          },
          onOpen: () => {
            dispatch({ type: 'PARTY_CONNECTED', username: auth.username });
          },
          onClose: () => {
            dispatch({ type: 'PARTY_DISCONNECTED' });
          },
          onError: () => {
            dispatch({ type: 'PARTY_ERROR', message: 'Lost connection to game server' });
          },
        });

        clientRef.current = client;
      })
      .catch(() => {
        if (!cancelled) {
          dispatch({ type: 'PARTY_ERROR', message: 'Failed to get GitHub auth' });
        }
      });

    return () => {
      cancelled = true;
      clientRef.current?.close();
      clientRef.current = null;
    };
  }, [dispatch]);

  // However, user-joined / user-left / user-status need to update the online list incrementally.
  // We handle this by keeping a ref of the current user list and merging.
  // Overwrite the naive handler above with a proper one after mount.
  // Actually, let's fix the onMessage handler to be complete:

  // The onMessage handler above needs refinement for incremental presence updates.
  // We'll use a ref to track the current users and merge updates.
  const usersRef = useRef<Map<string, string>>(new Map()); // username → status

  useEffect(() => {
    if (!clientRef.current) return;

    // Replace the message handler with one that does incremental updates
    // Note: PartyClient doesn't support replacing handlers after construction,
    // so the initial handler above dispatches all presence updates.
    // The server sends a full "presence" list on connect, and individual
    // "user-joined"/"user-left"/"user-status" updates thereafter.

    // We actually need to handle this in the initial onMessage callback.
    // Let's update the approach: store the user map in a ref and rebuild
    // the online list for each event.

    // This is handled correctly in the onMessage callback already — the server
    // sends "presence" with the full list on connect. For incremental updates,
    // we need the reducer to handle merging. Let's dispatch specific actions.
  }, []);

  const updateStatus = useCallback((status: 'idle' | 'in-game') => {
    clientRef.current?.send({ type: 'status', status });
  }, []);

  const challengePlayer = useCallback((target: string, gameType: string, code: string) => {
    clientRef.current?.send({ type: 'challenge', target, gameType, code });
  }, []);

  const respondToChallenge = useCallback((from: string, accept: boolean) => {
    clientRef.current?.send({ type: 'challenge-response', from, accept });
  }, []);

  return { updateStatus, challengePlayer, respondToChallenge };
}
```

**Note:** The incremental presence updates (user-joined, user-left, user-status) need to be handled properly. The simplest approach: the server already sends a full `presence` list on connect. For subsequent events, we need new reducer actions. Let's add them now.

- [ ] **Step 2: Add incremental presence actions to game-types.ts**

Add these to the `GameAction` union in `game-types.ts`:

```typescript
  | { type: 'USER_JOINED'; username: string; status: string }
  | { type: 'USER_LEFT'; username: string }
  | { type: 'USER_STATUS'; username: string; status: string }
```

- [ ] **Step 3: Add incremental presence reducers to game-reducer.ts**

Add these cases to `gameReducer`:

```typescript
    case 'USER_JOINED':
      return {
        ...state,
        onlineUsers: [...state.onlineUsers.filter(u => u.username !== action.username), { username: action.username, status: action.status as 'idle' | 'in-game' }],
      };

    case 'USER_LEFT':
      return {
        ...state,
        onlineUsers: state.onlineUsers.filter(u => u.username !== action.username),
      };

    case 'USER_STATUS':
      return {
        ...state,
        onlineUsers: state.onlineUsers.map(u => u.username === action.username ? { ...u, status: action.status as 'idle' | 'in-game' } : u),
      };
```

- [ ] **Step 4: Update the onMessage handler in usePartyLobby.ts**

Replace the `case 'user-joined':` block and the `case 'user-left':` and `case 'user-status':` blocks with proper dispatches:

```typescript
              case 'user-joined':
                dispatch({ type: 'USER_JOINED', username: data.username, status: data.status });
                break;
              case 'user-left':
                dispatch({ type: 'USER_LEFT', username: data.username });
                break;
              case 'user-status':
                dispatch({ type: 'USER_STATUS', username: data.username, status: data.status });
                break;
```

- [ ] **Step 5: Commit**

```bash
git add src/renderer/hooks/usePartyLobby.ts src/renderer/state/game-types.ts src/renderer/state/game-reducer.ts
git commit -m "feat(game): add usePartyLobby hook with real-time presence and challenges"
```

---

## Task 9: Game Hook (usePartyGame)

**Files:**
- Create: `src/renderer/hooks/usePartyGame.ts`

This hook connects to a ConnectFourRoom when a game starts and disconnects when leaving. It handles move relay, chat, rematch, and opponent disconnect detection. All game logic (board updates, win checks) runs client-side.

- [ ] **Step 1: Implement usePartyGame.ts**

```typescript
// src/renderer/hooks/usePartyGame.ts
import { useEffect, useRef, useCallback } from 'react';
import { useGameDispatch, useGameState } from '../state/game-context';
import { PartyClient } from '../game/party-client';
import { createBoard, dropPiece, checkWin, checkDraw } from '../game/connect-four';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateCode(): string {
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

export function usePartyGame(lobbyStatusUpdate: (status: 'idle' | 'in-game') => void) {
  const dispatch = useGameDispatch();
  const state = useGameState();
  const clientRef = useRef<PartyClient | null>(null);
  const gameCodeRef = useRef<string | null>(null);
  const myColorRef = useRef<'red' | 'yellow' | null>(null);
  const boardRef = useRef<number[][]>([]);
  const turnRef = useRef<'red' | 'yellow'>('red');

  // Clean up game connection when leaving
  useEffect(() => {
    return () => {
      clientRef.current?.close();
      clientRef.current = null;
    };
  }, []);

  const connectToRoom = useCallback((code: string, username: string) => {
    // Close any existing connection
    clientRef.current?.close();

    const client = new PartyClient({
      party: 'connect-four',
      room: code,
      username,
      onMessage: (data) => {
        switch (data.type) {
          case 'player-joined': {
            // Opponent joined
            if (data.username !== username) {
              const board = createBoard();
              boardRef.current = board;
              turnRef.current = 'red';
              dispatch({
                type: 'GAME_START',
                board,
                you: myColorRef.current!,
                opponent: data.username,
              });
              lobbyStatusUpdate('in-game');
            }
            break;
          }

          case 'player-left': {
            if (data.username !== username) {
              dispatch({ type: 'OPPONENT_DISCONNECTED' });
            }
            break;
          }

          case 'move': {
            if (data.username === username) break; // ignore echo of own move
            const playerNum = turnRef.current === 'red' ? 1 : 2;
            const result = dropPiece(boardRef.current, data.column, playerNum);
            if (!result) break;

            boardRef.current = result.board;
            const winLine = checkWin(result.board, { col: data.column, row: result.row });
            const isDraw = !winLine && checkDraw(result.board);
            const nextTurn = turnRef.current === 'red' ? 'yellow' : 'red';

            if (winLine) {
              dispatch({
                type: 'GAME_STATE',
                board: result.board,
                turn: nextTurn,
                lastMove: { col: data.column, row: result.row },
                winner: turnRef.current,
                winLine: winLine as [number, number][],
              });
            } else if (isDraw) {
              dispatch({
                type: 'GAME_STATE',
                board: result.board,
                turn: nextTurn,
                lastMove: { col: data.column, row: result.row },
                winner: 'draw',
              });
            } else {
              turnRef.current = nextTurn;
              dispatch({
                type: 'GAME_STATE',
                board: result.board,
                turn: nextTurn,
                lastMove: { col: data.column, row: result.row },
              });
            }
            break;
          }

          case 'chat': {
            if (data.username !== username) {
              dispatch({ type: 'CHAT_MESSAGE', from: data.username, text: data.text });
            }
            break;
          }

          case 'rematch': {
            // Opponent requested rematch — auto-accept and reset
            const board = createBoard();
            boardRef.current = board;
            // Swap colors on rematch
            myColorRef.current = myColorRef.current === 'red' ? 'yellow' : 'red';
            turnRef.current = 'red';
            dispatch({
              type: 'GAME_START',
              board,
              you: myColorRef.current,
              opponent: data.username,
            });
            break;
          }
        }
      },
    });

    clientRef.current = client;
    gameCodeRef.current = code;
  }, [dispatch, lobbyStatusUpdate]);

  const createGame = useCallback(() => {
    if (!state.username) return;
    const code = generateCode();
    myColorRef.current = 'red';
    dispatch({ type: 'ROOM_CREATED', code, color: 'red' });
    connectToRoom(code, state.username);
  }, [state.username, dispatch, connectToRoom]);

  const joinGame = useCallback((code: string) => {
    if (!state.username) return;
    myColorRef.current = 'yellow';
    connectToRoom(code, state.username);
    // The GAME_START dispatch happens when the server confirms the connection
    // and we receive the player-joined event for ourselves + the other player
  }, [state.username, connectToRoom]);

  const makeMove = useCallback((column: number) => {
    if (!clientRef.current || !state.username) return;
    // Apply move locally first (optimistic)
    const playerNum = turnRef.current === 'red' ? 1 : 2;
    const result = dropPiece(boardRef.current, column, playerNum);
    if (!result) return;

    boardRef.current = result.board;
    const winLine = checkWin(result.board, { col: column, row: result.row });
    const isDraw = !winLine && checkDraw(result.board);
    const nextTurn = turnRef.current === 'red' ? 'yellow' : 'red';

    // Send move to server (relayed to opponent)
    clientRef.current.send({ type: 'move', username: state.username, column });

    if (winLine) {
      dispatch({
        type: 'GAME_STATE',
        board: result.board,
        turn: nextTurn,
        lastMove: { col: column, row: result.row },
        winner: turnRef.current,
        winLine: winLine as [number, number][],
      });
    } else if (isDraw) {
      dispatch({
        type: 'GAME_STATE',
        board: result.board,
        turn: nextTurn,
        lastMove: { col: column, row: result.row },
        winner: 'draw',
      });
    } else {
      turnRef.current = nextTurn;
      dispatch({
        type: 'GAME_STATE',
        board: result.board,
        turn: nextTurn,
        lastMove: { col: column, row: result.row },
      });
    }
  }, [state.username, dispatch]);

  const sendChat = useCallback((text: string) => {
    if (!clientRef.current || !state.username) return;
    clientRef.current.send({ type: 'chat', username: state.username, text });
    dispatch({ type: 'CHAT_MESSAGE', from: state.username, text });
  }, [state.username, dispatch]);

  const requestRematch = useCallback(() => {
    if (!clientRef.current || !state.username) return;
    clientRef.current.send({ type: 'rematch', username: state.username });
    // The board reset happens when both players have sent rematch
    // For simplicity: send rematch, wait for opponent's rematch message to trigger reset
  }, [state.username]);

  const leaveGame = useCallback(() => {
    if (clientRef.current && state.username) {
      clientRef.current.send({ type: 'leave', username: state.username });
      clientRef.current.close();
      clientRef.current = null;
    }
    gameCodeRef.current = null;
    myColorRef.current = null;
    boardRef.current = [];
    turnRef.current = 'red';
    lobbyStatusUpdate('idle');
  }, [state.username, lobbyStatusUpdate]);

  return { createGame, joinGame, makeMove, sendChat, requestRematch, leaveGame };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/hooks/usePartyGame.ts
git commit -m "feat(game): add usePartyGame hook with real-time move relay"
```

---

## Task 10: Favorites IPC

**Files:**
- Modify: `src/main/main.ts`
- Modify: `src/main/preload.ts`

Add IPC handlers for reading/writing the local favorites JSON file.

- [ ] **Step 1: Add IPC handlers to main.ts**

Add these handlers alongside the existing `github:auth` handler:

```typescript
import fs from 'fs';
import path from 'path';

const FAVORITES_PATH = path.join(os.homedir(), '.claude', 'destinclaude-favorites.json');

ipcMain.handle('favorites:get', async () => {
  try {
    const data = JSON.parse(fs.readFileSync(FAVORITES_PATH, 'utf8'));
    return data.favorites ?? [];
  } catch {
    return [];
  }
});

ipcMain.handle('favorites:set', async (_event, favorites: string[]) => {
  try {
    fs.writeFileSync(FAVORITES_PATH, JSON.stringify({ favorites }, null, 2));
    return true;
  } catch {
    return false;
  }
});
```

- [ ] **Step 2: Expose in preload.ts**

Add to the `contextBridge.exposeInMainWorld('claude', { ... })` object:

```typescript
  getFavorites: () => ipcRenderer.invoke('favorites:get'),
  setFavorites: (favorites: string[]) => ipcRenderer.invoke('favorites:set', favorites),
```

- [ ] **Step 3: Commit**

```bash
git add src/main/main.ts src/main/preload.ts
git commit -m "feat: add favorites IPC for local player bookmarks"
```

---

## Task 11: Update UI Components

**Files:**
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/components/game/GamePanel.tsx`
- Modify: `src/renderer/components/game/GameLobby.tsx`
- Modify: `src/renderer/components/game/ConnectFourBoard.tsx`
- Modify: `src/renderer/components/game/GameChat.tsx`
- Modify: `src/renderer/components/game/GameOverlay.tsx`

The connection interface changes: `register` and `authenticate` are removed. `challengePlayer` now takes `(target, gameType, code)` instead of just `(target)`. Add favorites UI to the lobby.

- [ ] **Step 1: Define the new connection interface type**

Create a shared type. Add to `game-types.ts`:

```typescript
export interface GameConnection {
  createGame: () => void;
  joinGame: (code: string) => void;
  makeMove: (column: number) => void;
  sendChat: (text: string) => void;
  requestRematch: () => void;
  leaveGame: () => void;
  challengePlayer: (target: string) => void;
  respondToChallenge: (from: string, accept: boolean) => void;
}
```

- [ ] **Step 2: Update App.tsx**

Replace the `useGitHubGame` import and usage:

```typescript
// Remove:
import { useGitHubGame } from './hooks/useGitHubGame';
// Add:
import { usePartyLobby } from './hooks/usePartyLobby';
import { usePartyGame } from './hooks/usePartyGame';
```

Replace `const gameConnection = useGitHubGame();` with:

```typescript
  const lobby = usePartyLobby();
  const game = usePartyGame(lobby.updateStatus);

  const gameConnection = {
    createGame: game.createGame,
    joinGame: game.joinGame,
    makeMove: game.makeMove,
    sendChat: game.sendChat,
    requestRematch: game.requestRematch,
    leaveGame: game.leaveGame,
    challengePlayer: lobby.challengePlayer,
    respondToChallenge: lobby.respondToChallenge,
  };
```

- [ ] **Step 3: Update GamePanel.tsx Props**

Replace the `Props` interface with:

```typescript
import { GameConnection } from '../../state/game-types';

interface Props {
  connection: GameConnection;
}
```

- [ ] **Step 4: Update GameLobby.tsx**

Replace the `Props` interface with the same `GameConnection` import. Update the challenge button's `onClick` to pass all three arguments:

```typescript
onClick={() => connection.challengePlayer(user.username, 'connect-four', '')}
```

The code will be generated by the challengePlayer function in the lobby hook. Actually, looking at the flow: when challenging, we need to create a game first, then challenge with that code. Update the challenge flow:

The `challengePlayer` in `App.tsx` should be a combined function that creates a game room and sends the challenge:

```typescript
  const challengePlayerWithGame = useCallback((target: string) => {
    // Create a game room first, then send challenge through lobby
    const code = game.createGameForChallenge();
    lobby.challengePlayer(target, 'connect-four', code);
  }, [game, lobby]);
```

This requires adding a `createGameForChallenge` method to `usePartyGame` that creates the room and returns the code without dispatching ROOM_CREATED (since we go straight to waiting).

Actually, the simpler approach: keep `challengePlayer` taking just the username, and have it internally call createGame + send challenge. Update `usePartyGame`:

Add to `usePartyGame`:
```typescript
  const challengePlayer = useCallback((target: string) => {
    if (!state.username) return;
    const code = generateCode();
    myColorRef.current = 'red';
    dispatch({ type: 'ROOM_CREATED', code, color: 'red' });
    connectToRoom(code, state.username);
    lobbyChallenge(target, 'connect-four', code);
  }, [state.username, dispatch, connectToRoom, lobbyChallenge]);
```

This means `usePartyGame` needs a reference to the lobby's challenge function. Update the hook signature:

```typescript
export function usePartyGame(
  lobbyStatusUpdate: (status: 'idle' | 'in-game') => void,
  lobbyChallenge: (target: string, gameType: string, code: string) => void,
) {
```

And in `App.tsx`:
```typescript
  const game = usePartyGame(lobby.updateStatus, lobby.challengePlayer);
```

Then the `gameConnection` object keeps `challengePlayer` as `(target: string) => void`:
```typescript
  const gameConnection = {
    ...game,
    respondToChallenge: lobby.respondToChallenge,
  };
```

- [ ] **Step 5: Update GameLobby.tsx — error screen**

Replace `state.githubError` with `state.partyError`:

```tsx
if (state.partyError) return <ErrorScreen />;
```

And in `ErrorScreen`:
```tsx
<p className="text-sm text-red-400 text-center">{state.partyError}</p>
```

- [ ] **Step 6: Update ConnectFourBoard.tsx, GameChat.tsx, GameOverlay.tsx**

Replace the `Props` interface in each file with:

```typescript
import { GameConnection } from '../../state/game-types';

interface Props {
  connection: GameConnection;
}
```

Remove `movePending` usage from `ConnectFourBoard.tsx` — moves are instant now. Replace:
```typescript
const canMove = isMyTurn && isPlaying && !state.movePending;
```
with:
```typescript
const canMove = isMyTurn && isPlaying;
```

- [ ] **Step 7: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Fix any remaining type errors.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/App.tsx src/renderer/state/game-types.ts src/renderer/components/game/*.tsx src/renderer/hooks/usePartyGame.ts
git commit -m "refactor(game): wire UI components to PartyKit hooks"
```

---

## Task 12: Delete Old GitHub Game Code

**Files:**
- Delete: `src/renderer/game/github-game.ts`
- Delete: `src/renderer/hooks/useGitHubGame.ts`
- Modify: `src/renderer/game/github-api.ts` — slim down to stats-only

- [ ] **Step 1: Delete replaced files**

```bash
rm src/renderer/game/github-game.ts
rm src/renderer/hooks/useGitHubGame.ts
```

- [ ] **Step 2: Slim down github-api.ts**

The `GitHubAPI` class stays but only needs: `createIssue`, `updateIssue`, `searchIssues`, `getIssue` (for leaderboard/stats). Remove `getComments`, `addComment`, `getCommentsSince` methods since game moves no longer go through Issues.

Remove these methods from `github-api.ts`:

```typescript
  /** Add a comment to an issue. Any GitHub user can do this on public repos. */
  async addComment(...)

  /** Get all comments on an issue. */
  async getComments(...)

  /** Get comments added after a certain count (for incremental polling). */
  async getCommentsSince(...)
```

Also remove the `Comment` interface export since it's no longer used.

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git rm src/renderer/game/github-game.ts src/renderer/hooks/useGitHubGame.ts
git add src/renderer/game/github-api.ts
git commit -m "chore: remove GitHub Issues game backend (replaced by PartyKit)"
```

---

## Task 13: Add Favorites UI to Lobby

**Files:**
- Modify: `src/renderer/components/game/GameLobby.tsx`

Add a favorites toggle (star icon) next to each username, and show favorited users at the top of the list even when offline.

- [ ] **Step 1: Add favorites state and IPC calls**

Add to `LobbyScreen`:

```typescript
const [favorites, setFavorites] = useState<string[]>([]);

// Load favorites on mount
useEffect(() => {
  (window as any).claude?.getFavorites?.().then((favs: string[]) => {
    if (favs) setFavorites(favs);
  });
}, []);

const toggleFavorite = (username: string) => {
  const updated = favorites.includes(username)
    ? favorites.filter(f => f !== username)
    : [...favorites, username];
  setFavorites(updated);
  (window as any).claude?.setFavorites?.(updated);
};
```

- [ ] **Step 2: Sort online users with favorites first**

Replace the online users list rendering. Build a sorted list that puts favorites first, then other online users:

```typescript
const otherUsers = state.onlineUsers.filter(u => u.username !== state.username);
const onlineFavorites = otherUsers.filter(u => favorites.includes(u.username));
const onlineNonFavorites = otherUsers.filter(u => !favorites.includes(u.username));
const offlineFavorites = favorites
  .filter(f => f !== state.username && !otherUsers.some(u => u.username === f))
  .map(f => ({ username: f, status: 'offline' as const }));

const sortedUsers = [...onlineFavorites, ...onlineNonFavorites, ...offlineFavorites];
```

- [ ] **Step 3: Update the user list JSX**

Replace the `<ul>` in the online users section:

```tsx
<ul className="flex flex-col gap-1">
  {sortedUsers.map((user) => {
    const isOnline = user.status !== 'offline';
    const isFav = favorites.includes(user.username);
    return (
      <li key={user.username} className="flex items-center gap-2">
        <button
          onClick={() => toggleFavorite(user.username)}
          className={`text-xs shrink-0 transition-colors ${isFav ? 'text-yellow-400' : 'text-gray-600 hover:text-gray-400'}`}
          title={isFav ? 'Remove from favorites' : 'Add to favorites'}
        >
          {isFav ? '★' : '☆'}
        </button>
        <span className={`w-2 h-2 rounded-full shrink-0 ${
          !isOnline ? 'bg-gray-600' :
          user.status === 'idle' ? 'bg-green-400' : 'bg-yellow-400'
        }`} />
        <span className={`text-sm truncate flex-1 ${isOnline ? 'text-gray-300' : 'text-gray-600'}`}>
          {user.username}
        </span>
        {isOnline && user.status === 'in-game' ? (
          <span className="text-[10px] text-yellow-500 ml-auto">in game</span>
        ) : isOnline ? (
          <button
            onClick={() => connection.challengePlayer(user.username)}
            className="text-[10px] text-[#66AAFF] hover:text-[#88CCFF] ml-auto transition-colors"
          >
            Challenge
          </button>
        ) : (
          <span className="text-[10px] text-gray-600 ml-auto">offline</span>
        )}
      </li>
    );
  })}
</ul>
```

- [ ] **Step 4: Update the section header count**

```tsx
<div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">
  Players ({otherUsers.length} online{offlineFavorites.length > 0 ? `, ${offlineFavorites.length} favorite offline` : ''})
</div>
```

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/game/GameLobby.tsx
git commit -m "feat(game): add favorites system to lobby with local persistence"
```

---

## Task 14: End-to-End Test

- [ ] **Step 1: Verify PartyKit server is deployed**

```bash
cd partykit && npx partykit deploy
```

- [ ] **Step 2: Build and run the desktop app**

```bash
npm run dev
```

- [ ] **Step 3: Verify lobby connection**

Open the game panel. Should show your GitHub username and connect to the lobby (green dot, no error screen).

- [ ] **Step 4: Test game creation**

Click "Create Game". Should show a room code and "Waiting for opponent..." with the code displayed.

- [ ] **Step 5: Test joining a game (needs second instance or test client)**

Open a second instance or write a quick test script using `partysocket`:

```bash
node -e "
const PartySocket = require('partysocket').default;
const ws = new PartySocket({
  host: 'destinclaude-games.itsdestin.partykit.dev',
  room: 'PASTE_CODE_HERE',
  party: 'connect-four',
  query: { username: 'test-player' },
});
ws.onmessage = (e) => console.log('msg:', e.data);
ws.onopen = () => {
  console.log('connected');
  ws.send(JSON.stringify({ type: 'join', username: 'test-player' }));
};
"
```

- [ ] **Step 6: Verify game flow**

Play a few moves, test chat, test game over + rematch.

- [ ] **Step 7: Verify favorites**

Click the star next to a username. Close and reopen the game panel. The favorite should persist.
