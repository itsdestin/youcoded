# PartyKit Game Backend — Design Spec

**Date:** 2026-03-27
**Status:** Active
**Version:** 1.1
**Replaces:** GitHub Issues game backend (`github-game.ts`, `useGitHubGame.ts`)
**Supersedes:** `specs/2026-03-20-connect-four-multiplayer-design.md`, `plans/2026-03-21-github-backend-connect4.md`

---

## Summary

Replace the GitHub Issues-based game backend with PartyKit (Cloudflare Durable Objects) for real-time multiplayer. GitHub Issues retained only for persistent stats/leaderboard. Per-game server room classes allow game-specific networking behavior. Client-trusted game logic.

## Goals

- Instant move delivery via WebSocket (replacing 10s polling)
- Instant presence and challenge delivery (replacing 60s polling)
- Fix broken challenge system
- Architecture that supports both turn-based and real-time games
- Local favorites list for the lobby
- Zero infrastructure cost (PartyKit free tier)

## Non-Goals

- Server-side game validation (client-trusted)
- Supporting non-DestinCode users (no web client)
- Replacing GitHub Issues for persistent data

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                   DestinCode App                      │
│                                                       │
│  React Client                                         │
│  ├── usePartyLobby hook (presence, challenges)        │
│  ├── usePartyGame hook (gameplay, chat, rematch)      │
│  ├── Game logic (connect-four.ts, future games)       │
│  └── Favorites list (local JSON)                      │
│         │                                             │
│         │ WebSocket (partysocket)                      │
│         ▼                                             │
│  ┌──────────────────────────────────────────────┐     │
│  │        PartyKit Server (Cloudflare Edge)      │     │
│  │                                               │     │
│  │  LobbyRoom         ─ presence, challenges     │     │
│  │  ConnectFourRoom    ─ C4 message relay         │     │
│  │  (future) PongRoom  ─ real-time relay          │     │
│  └──────────────────────────────────────────────┘     │
│         │                                             │
│         │ GitHub API (from client, stats only)        │
│         ▼                                             │
│  ┌──────────────────────────────────────────────┐     │
│  │  GitHub Issues (itsdestin/destinclaude-games)  │    │
│  │  ─ Leaderboard/stats (persistent)             │    │
│  └──────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────┘
```

---

## PartyKit Server

### Directory Structure

```
~/.claude/plugins/destinclaude/desktop/partykit/
├── package.json
├── partykit.json
├── tsconfig.json
└── src/
    ├── lobby-room.ts
    └── connect-four-room.ts
```

Deployed via `npx partykit deploy` to the free managed platform.

### LobbyRoom (Single Global Instance)

One room all DestinCode users connect to on app launch. Room ID: `global-lobby`.

**Responsibilities:**
- Maintain authoritative list of online users with status
- Broadcast join/leave/status-change events instantly
- Relay challenge messages (including game code) between specific users
- Send full user list to newly connected clients

**Server-side state (in-memory):**
```typescript
Map<connectionId, { username: string; status: "idle" | "in-game" }>
```

**Note:** With `hibernate: true`, this map is cleared when all connections close. The list self-heals as clients reconnect and send `onConnect` events.

### ConnectFourRoom (One Per Game Session)

Created when a player starts a new game. Room ID = 6-character game code.

**Responsibilities:**
- Track the two player connections
- Relay messages (moves, chat, rematch votes) between players
- Broadcast join/leave events
- Auto-hibernate when both players disconnect (Durable Object lifecycle)

**Server-side state (in-memory):**
```typescript
Map<connectionId, string>  // connectionId → username
```

### Future Game Rooms

Each new game type gets its own room class with game-appropriate behavior:
- PongRoom: high-frequency relay, pause-on-disconnect
- SnakeRoom: tick-based updates, spectator support
- etc.

Adding a game = new room class + client components + redeploy.

---

## Message Protocol

### Common Envelope

All messages are JSON with a `type` field. Username is passed as a query parameter on WebSocket connect, not in every message.

### Lobby Messages

```typescript
// Client → Server
{ type: "status", status: "idle" | "in-game" }
{ type: "challenge", target: string, gameType: string, code: string }
{ type: "challenge-response", from: string, accept: boolean }

// Server → Client
{ type: "presence", users: { username: string, status: string }[] }
{ type: "user-joined", username: string, status: string }
{ type: "user-left", username: string }
{ type: "user-status", username: string, status: string }
{ type: "challenge", from: string, gameType: string, code: string }
{ type: "challenge-response", from: string, accept: boolean }
```

### Connect Four Messages

```typescript
// Client → Server (relayed to other player)
{ type: "move", username: string, column: number }
{ type: "chat", username: string, text: string }
{ type: "leave", username: string }
{ type: "rematch", username: string }

// Server → Client
{ type: "player-joined", username: string }
{ type: "player-left", username: string }
// All other game messages relayed as-is
```

---

## Client-Side Architecture

### File Map

**New files:**
- `src/renderer/game/party-client.ts` — PartyKit connection manager (wrapper around `partysocket`)
- `src/renderer/hooks/usePartyLobby.ts` — lobby presence/challenges hook
- `src/renderer/hooks/usePartyGame.ts` — gameplay hook

**Deleted:**
- `src/renderer/game/github-game.ts` — replaced by PartyKit
- `src/renderer/hooks/useGitHubGame.ts` — replaced by new hooks

**Modified:**
- `src/renderer/game/github-api.ts` — slimmed to stats/leaderboard only (removed `addComment`, `getComments`, `getCommentsSince`, `Comment` interface)
- `src/renderer/state/game-types.ts` — new actions, `GameConnection` interface, challenge code tracking, rematch state
- `src/renderer/state/game-reducer.ts` — handles all PartyKit actions
- `src/renderer/App.tsx` — composes `usePartyLobby` + `usePartyGame` into `gameConnection`
- `src/renderer/components/game/*.tsx` — use shared `GameConnection` interface
- `src/main/main.ts` — favorites IPC handlers
- `src/main/preload.ts` — favorites IPC exposure
- `src/renderer/remote-shim.ts` — favorites IPC for remote browser clients

### party-client.ts

Wrapper around `partysocket` (PartyKit's client SDK):
- Manages WebSocket connection to a specific room
- Automatic reconnection (built into partysocket)
- JSON message serialization/deserialization
- Typed event callbacks for incoming messages
- Host configured via `PARTYKIT_HOST` constant

### usePartyLobby Hook

Active whenever the app is open. Connects to the global LobbyRoom.

- Gets GitHub auth on mount (for username identity)
- Dispatches `PARTY_CONNECTED` on WebSocket open
- Dispatches `PRESENCE_UPDATE` on full user list, `USER_JOINED`/`USER_LEFT`/`USER_STATUS` for incremental updates
- Dispatches `CHALLENGE_RECEIVED` with both `from` and `code` on incoming challenges
- Exposes `updateStatus(status)`, `challengePlayer(target, gameType, code)`, `respondToChallenge(from, accept)`

### usePartyGame Hook

Active during gameplay. Connects to a game-specific room. Takes `lobbyStatusUpdate` and `lobbyChallenge` callbacks as parameters.

- All game logic runs client-side (board state in refs, `dropPiece`/`checkWin`/`checkDraw` from `connect-four.ts`)
- Optimistic local moves — applies move locally, then sends to server for relay
- Turn tracking via `turnRef` — always updated regardless of win/draw outcome
- Mutual rematch via `rematchRequestedRef` — both players must click Rematch to start a new game
- Exposes `createGame()`, `joinGame(code)`, `makeMove(column)`, `sendChat(text)`, `requestRematch()`, `leaveGame()`, `challengePlayer(target)`

### Challenge Flow

1. Player A clicks "Challenge" on a user in the lobby
2. `usePartyGame.challengePlayer(target)` generates a game code, connects to the room, and calls `lobbyChallenge(target, gameType, code)` to send the challenge through the lobby
3. Player B receives `CHALLENGE_RECEIVED` with `from` and `code` stored in state
4. Player B clicks "Accept" → calls `respondToChallenge(from, true)` (sends lobby response) AND `joinGame(challengeCode)` (connects to the game room)
5. Both players receive `player-joined` events → `GAME_START` dispatched

### Rematch Flow

1. Player A clicks "Rematch" → sends `{ type: "rematch" }`, sets `rematchRequestedRef = true`, dispatches `REMATCH_REQUESTED`
2. Player B sees "Rematch Requested" button state
3. Player B clicks "Rematch" → sends `{ type: "rematch" }`, sets `rematchRequestedRef = true`
4. Player B receives Player A's rematch message, sees `rematchRequestedRef` is true → both agreed → resets board, dispatches `GAME_START`
5. Player A receives Player B's rematch message, sees `rematchRequestedRef` is true → both agreed → resets board, dispatches `GAME_START`

### Favorites

Stored locally at `~/.claude/destinclaude-favorites.json`:
```json
{ "favorites": ["alice", "bob"] }
```

- Read/written via IPC from main process (`favorites:get`, `favorites:set`)
- Also available to remote browser clients via remote-shim
- Lobby UI shows favorited users at top of online list with star (★/☆) toggle
- One-sided (no mutual acceptance required)
- Favorited users shown even when offline (grayed out)

### GitHub Issues (Stats Only)

Existing `GitHubAPI` class retained with only: `createIssue`, `updateIssue`, `searchIssues`, `getIssue`.

Operations:
- `recordResult(winner, loser, isDraw)` — updates stats issues after game ends
- `getLeaderboard()` — fetches stats on lobby entry

**Note:** Leaderboard integration is not yet wired up in the UI — the lobby shows a static "No stats yet" placeholder. The API methods are ready for future connection.

---

## State

### GameState Shape

```typescript
interface GameState {
  connected: boolean;
  partyError: string | null;
  username: string | null;
  onlineUsers: OnlineUser[];
  screen: GameScreen;  // 'setup' | 'lobby' | 'waiting' | 'playing' | 'game-over'
  roomCode: string | null;
  myColor: PlayerColor | null;
  opponent: string | null;
  board: number[][];
  turn: PlayerColor;
  lastMove: { col: number; row: number } | null;
  winner: PlayerColor | 'draw' | null;
  winLine: [number, number][] | null;
  chatMessages: ChatMessage[];
  panelOpen: boolean;
  challengeFrom: string | null;
  challengeCode: string | null;
  challengeDeclinedBy: string | null;
  rematchRequested: boolean;
}
```

### GameConnection Interface

```typescript
interface GameConnection {
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

### Reducer Actions

```typescript
type GameAction =
  | { type: 'PARTY_CONNECTED'; username: string }
  | { type: 'PARTY_DISCONNECTED' }
  | { type: 'PARTY_ERROR'; message: string }
  | { type: 'PRESENCE_UPDATE'; online: OnlineUser[] }
  | { type: 'USER_JOINED'; username: string; status: string }
  | { type: 'USER_LEFT'; username: string }
  | { type: 'USER_STATUS'; username: string; status: string }
  | { type: 'ROOM_CREATED'; code: string; color: PlayerColor }
  | { type: 'GAME_START'; board: number[][]; you: PlayerColor; opponent: string }
  | { type: 'GAME_STATE'; board: number[][]; turn: PlayerColor; lastMove: {...}; winner?; winLine? }
  | { type: 'GAME_OVER'; winner: PlayerColor | 'draw'; line?: [number, number][] }
  | { type: 'CHAT_MESSAGE'; from: string; text: string }
  | { type: 'OPPONENT_DISCONNECTED' }
  | { type: 'REMATCH_REQUESTED' }
  | { type: 'TOGGLE_PANEL' }
  | { type: 'RETURN_TO_LOBBY' }
  | { type: 'RESET' }
  | { type: 'CHALLENGE_RECEIVED'; from: string; code: string }
  | { type: 'CHALLENGE_DECLINED'; by: string }
  | { type: 'CLEAR_CHALLENGE' }
```

---

## Deployment

### Target: PartyKit Free Managed Tier

- 10 projects (using 1)
- 100,000 requests/day (more than sufficient)
- Storage wipes every 24 hours (irrelevant — persistent data in GitHub Issues)
- Zero cost

### Deploy Command

```bash
cd partykit && npx partykit deploy
```

First run prompts for browser login. Deploys to `destinclaude-games.<username>.partykit.dev`.

### Local Development

```bash
cd partykit && npx partykit dev
```

Opens local server on `localhost:1999`. Set `PARTYKIT_HOST` in `party-client.ts` to `localhost:1999` for testing.

### Upgrade Path

If usage grows, deploy to own Cloudflare account:
- Change `partykit.json` to target CF account
- Run `npx partykit deploy`
- No code changes

---

## Change Log

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-03-27 | Initial design |
| 1.1 | 2026-03-27 | Post-implementation update: added challenge code tracking, mutual rematch flow, incremental presence actions (USER_JOINED/LEFT/STATUS), GameConnection interface, REMATCH_REQUESTED action, remote-shim favorites, corrected file map to reflect actual implementation |
