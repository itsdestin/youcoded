# Connect 4 Multiplayer — Design Document

**Date:** 2026-03-20
**Status:** Superseded (replaced by PartyKit architecture — see `specs/2026-03-27-partykit-game-backend-design.md`)
**Project:** destinclaude-desktop

## Overview

Add a multiplayer Connect 4 game to the destinclaude desktop app. Players compete over the internet via direct invite codes, with persistent accounts, an in-game chat, a global leaderboard, and live online presence.

## Decisions Log

| Decision | Choice | Alternatives Considered |
|----------|--------|------------------------|
| Game | Connect 4 (7x6 grid) | Checkers |
| Multiplayer mode | Internet, user-initiated | AI opponent, local two-player |
| Matchmaking | Direct invite via 6-char game codes | Lobby browser, matchmaking queue |
| Networking | WebSocket relay server | WebRTC P2P, Firebase |
| Architecture | Split services (relay + leaderboard API) | Monolith, serverless |
| Layout | Right side panel alongside chat | Floating overlay, bottom drawer |
| Identity | Pick-a-username with simple password (bcrypt hashed) | Device-bound ID, OAuth |
| Social | In-game chat + global leaderboard | Minimal (no chat), spectator mode |
| Presence | Persistent WebSocket connection on app launch | None (connect only during games) |

## Architecture

```
┌─────────────────────────────────────┐
│  Electron App (destinclaude-desktop)│
│                                     │
│  ┌───────────┐  ┌────────────────┐  │
│  │ Chat View │  │ Game Panel     │  │
│  │ (existing)│  │ (new, right)   │  │
│  └───────────┘  └───┬───────┬────┘  │
│                     │       │       │
└─────────────────────┼───────┼───────┘
                      │       │
              WebSocket│       │REST
                      │       │
              ┌───────▼──┐  ┌─▼──────────┐
              │  Relay   │  │ Leaderboard│
              │  Server  │  │ API        │
              │(ws+chat+ │  │(REST+SQLite│
              │ presence) │  │  +bcrypt)  │
              └──────────┘  └────────────┘
```

### Relay Server

Lightweight Node.js + `ws` library. Responsibilities:

- **Presence tracking** — maintains a map of all connected, authenticated users and their status (`idle` | `in-game`). Broadcasts presence updates to all clients.
- **Game rooms** — creates rooms with 6-char alphanumeric codes, manages two-player game sessions.
- **Move validation** — authoritative game logic. Validates moves, updates board state, detects win/draw.
- **Chat relay** — forwards in-game chat messages between room participants.
- **Result reporting** — calls the Leaderboard API when a game ends to record the outcome.

Stateless by design — game state lives in memory per room and is discarded when the room closes. Presence is connection-based (disconnect = offline).

**Directory:** `server/relay/`

```
server/relay/
  index.ts            — WebSocket server entry point, connection handling
  presence.ts         — online user tracking, presence broadcasts
  room-manager.ts     — creates/destroys rooms, maps codes to rooms
  room.ts             — single game room: two players, board state, chat
  connect-four.ts     — pure game logic (shared with client)
  types.ts            — message types, room types
```

### Leaderboard API

Node.js + Express/Fastify + SQLite + bcrypt. Responsibilities:

- **Player accounts** — register username + password, verify credentials.
- **Stats tracking** — wins, losses, draws per player.
- **Leaderboard** — sorted rankings.
- **Result recording** — accepts game results from the relay server (authenticated via shared secret).

**Directory:** `server/leaderboard/`

**Data model:**

```sql
CREATE TABLE players (
  username      TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  wins          INTEGER DEFAULT 0,
  losses        INTEGER DEFAULT 0,
  draws         INTEGER DEFAULT 0,
  created_at    TEXT DEFAULT CURRENT_TIMESTAMP
);
```

**Endpoints:**

| Method | Route | Auth | Purpose |
|--------|-------|------|---------|
| `POST` | `/players` | None | Register. Body: `{ username, password }`. 201 or 409. |
| `POST` | `/players/verify` | None | Verify credentials. 200 or 401. |
| `GET` | `/players/:username` | None | Public stats (no password). |
| `GET` | `/leaderboard` | None | Top players by wins. `?limit=` (default 20). |
| `POST` | `/results` | Shared secret (`Authorization` header) | Record game result. Called by relay only. |

### Client Game Module

New React components in the renderer, following existing patterns (context + reducer + hooks).

**New files:**

```
src/renderer/
  components/game/
    GamePanel.tsx           — right panel container, visibility toggle
    GameLobby.tsx           — create/join UI, username setup, online users
    ConnectFourBoard.tsx    — 7x6 board, click-to-drop, animations
    GameChat.tsx            — chat widget within the panel
    GameOverlay.tsx         — win/loss/draw result + rematch prompt
  hooks/
    useGameConnection.ts    — WebSocket lifecycle, message send/receive
  state/
    game-types.ts           — GameState, GameAction discriminated union
    game-reducer.ts         — reducer for game state
    game-context.ts         — React context provider
  game/
    connect-four.ts         — pure game logic functions (no React)
```

**Layout integration:**

Current `App.tsx` layout: `[Sidebar] [Chat/Terminal + InputBar]`

New layout: `[Sidebar] [Chat/Terminal + InputBar] [GamePanel (conditional)]`

`GamePanel` is 320px fixed width on the right, rendered when toggled open. A button in `HeaderBar` or sidebar opens/closes it. Chat area flexes to fill remaining space.

**State management:**

`GameProvider` wraps `AppInner` alongside `ChatProvider`. Actions:

```typescript
type GameAction =
  | { type: 'SET_USERNAME'; username: string }
  | { type: 'SET_AUTHENTICATED'; success: boolean }
  | { type: 'PRESENCE_UPDATE'; online: { username: string; status: 'idle' | 'in-game' }[] }
  | { type: 'ROOM_CREATED'; code: string; color: 'red' | 'yellow' }
  | { type: 'GAME_START'; board: number[][]; you: 'red' | 'yellow'; opponent: string }
  | { type: 'GAME_STATE'; board: number[][]; turn: 'red' | 'yellow'; lastMove: { col: number; row: number } }
  | { type: 'GAME_OVER'; winner: 'red' | 'yellow' | 'draw'; line?: [number, number][] }
  | { type: 'CHAT_MESSAGE'; from: string; text: string }
  | { type: 'OPPONENT_DISCONNECTED' }
  | { type: 'CONNECTION_STATUS'; connected: boolean };
```

## Game Logic

Pure functions in `connect-four.ts`, used by both client and relay server:

- `createBoard()` → empty 7x6 grid (2D array of `0 | 1 | 2`)
- `dropPiece(board, column, player)` → `{ board, row }` or `null` if column full
- `checkWin(board, lastMove)` → winning line coordinates `[col,row][]` or `null`
- `checkDraw(board)` → `boolean`
- `getValidColumns(board)` → `number[]`

Win detection checks 4 directions (horizontal, vertical, two diagonals) from the last-placed piece. Board representation: `0` = empty, `1` = red, `2` = yellow.

Client uses these for optimistic UI (piece drops immediately on click, server confirms). Server is authoritative.

## WebSocket Protocol

### Connection & Presence

```
Client → Server:
  { type: "authenticate", username: string, password: string }

Server → Client:
  { type: "authenticated", success: boolean }
  { type: "presence", online: [{ username: string, status: "idle" | "in-game" }] }
```

App connects on launch after credentials are available. Server verifies against Leaderboard API, adds to presence map, broadcasts. Heartbeat ping/pong every 30 seconds to detect stale connections.

### Game Room

```
Client → Server:
  { type: "create", username: string }
  { type: "join", code: string, username: string }
  { type: "move", column: number }
  { type: "chat", text: string }
  { type: "rematch" }

Server → Client:
  { type: "room:created", code: string, color: "red" }
  { type: "game:start", board: number[][], you: "red" | "yellow", opponent: string }
  { type: "game:state", board: number[][], turn: "red" | "yellow", lastMove: { col: number, row: number } }
  { type: "game:over", winner: "red" | "yellow" | "draw", line?: [number, number][] }
  { type: "chat", from: string, text: string }
  { type: "error", message: string }
  { type: "opponent:disconnected" }
```

### Room Lifecycle

- Room created with 6-char alphanumeric code (collision-checked against active rooms)
- Creator joins as Red (Red goes first)
- Second player joins as Yellow
- On game over: relay calls `POST /results` on leaderboard API
- Rematch: both players send `rematch`, server resets board and swaps colors
- Disconnect: opponent notified, room stays alive 60 seconds for reconnect, then closes (remaining player gets forfeit win)
- Idle cleanup: rooms destroyed 5 minutes after game over with no rematch

## UX Flow

### Screen 1: First Launch — Username Setup

Shown on first open (no credentials in `localStorage`). Connect 4 branding, username input, password input, "Get Started" button. On success, credentials saved to `localStorage`, WebSocket connection established.

### Screen 2: Lobby

Shown when authenticated and not in a game. Contains:

- **Player info bar** — your username, online indicator, W/L record
- **Online users list** — live-updating, shows idle vs. in-game status
- **Create Game button** — generates room, moves to waiting screen
- **Join Game input** — 6-char code entry
- **Leaderboard preview** — top 3 players, "View All" expands full list

### Screen 3: Waiting Room

Shown after creating a game. Displays the 6-char room code in large styled characters with a "Copy Code" button. Animated spinner with "Waiting for opponent..." text. Cancel button returns to lobby and destroys the room.

### Screen 4: Active Game

Full game experience:

- **Player bar** — both player names with color indicators, turn indicator
- **Connect 4 board** — 7x6 grid with column hover highlights, drop animation on piece placement, winning line highlight on game over
- **Game chat** — scrollable message history below the board, text input at bottom

### Screen 5: Game Over

Overlay on the board showing result (win/loss/draw), final score. "Rematch" and "Back to Lobby" buttons.

## Security

- Passwords bcrypt-hashed in the leaderboard database
- `/results` endpoint protected by shared secret (`Authorization: Bearer <secret>`) — only callable by relay server
- Client never calls `/results` directly
- WebSocket `authenticate` message verified against leaderboard API before granting presence
- Game codes are random 6-char alphanumeric — not guessable, but not secret (knowing the code is the invite mechanism)

## Deployment

Both servers are lightweight and can run on a single VPS or free-tier platform:

- **Relay server** — long-running Node.js process (WebSocket requires persistent connections)
- **Leaderboard API** — standard HTTP server, could also be on the same machine

Both live in `server/` within this repo. Configuration via environment variables:

- `RELAY_PORT` — WebSocket server port
- `LEADERBOARD_PORT` — HTTP API port
- `LEADERBOARD_URL` — URL the relay uses to reach the leaderboard API
- `SHARED_SECRET` — shared auth token between relay and leaderboard
- `DATABASE_PATH` — SQLite file path
