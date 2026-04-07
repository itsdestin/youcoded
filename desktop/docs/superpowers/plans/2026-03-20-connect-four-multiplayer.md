# Connect 4 Multiplayer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Superseded (WebSocket → GitHub Issues → PartyKit. Current: `specs/2026-03-27-partykit-game-backend-design.md`)

**Goal:** Add multiplayer Connect 4 with game chat, leaderboard, and online presence to the destinclaude desktop app.

**Architecture:** Two backend services (WebSocket relay server + REST leaderboard API) plus a client-side game module in the Electron renderer. The relay handles real-time gameplay, chat, and presence. The leaderboard stores accounts and stats in SQLite. The client renders a right-side game panel with lobby, board, and chat.

**Tech Stack:** Node.js, `ws` (WebSocket), Express, `better-sqlite3`, `bcrypt`, React, Vitest, TypeScript

**Spec:** `docs/superpowers/specs/2026-03-20-connect-four-multiplayer-design.md`

---

## File Map

### Shared Game Logic
- **Create:** `shared/connect-four.ts` — pure game functions used by both client and server

### Leaderboard API (`server/leaderboard/`)
- **Create:** `server/leaderboard/package.json` — dependencies (express, better-sqlite3, bcrypt, cors)
- **Create:** `server/leaderboard/tsconfig.json` — TypeScript config
- **Create:** `server/leaderboard/src/index.ts` — Express server entry point
- **Create:** `server/leaderboard/src/db.ts` — SQLite setup + query functions
- **Create:** `server/leaderboard/src/routes.ts` — route handlers
- **Create:** `server/leaderboard/src/types.ts` — request/response types
- **Create:** `server/leaderboard/tests/db.test.ts` — database layer tests
- **Create:** `server/leaderboard/tests/routes.test.ts` — API endpoint tests

### Relay Server (`server/relay/`)
- **Create:** `server/relay/package.json` — dependencies (ws)
- **Create:** `server/relay/tsconfig.json` — TypeScript config
- **Create:** `server/relay/src/index.ts` — WebSocket server entry point
- **Create:** `server/relay/src/presence.ts` — online user tracking + broadcasts
- **Create:** `server/relay/src/room-manager.ts` — room creation/destruction, code generation
- **Create:** `server/relay/src/room.ts` — single game room: players, board, chat, turns
- **Create:** `server/relay/src/types.ts` — message protocol types
- **Create:** `server/relay/tests/presence.test.ts` — presence tracking tests
- **Create:** `server/relay/tests/room.test.ts` — room + game logic tests
- **Create:** `server/relay/tests/room-manager.test.ts` — room manager tests

### Client Game Module (`src/renderer/`)
- **Create:** `src/renderer/game/connect-four.ts` — re-exports or copies shared logic for renderer
- **Create:** `src/renderer/state/game-types.ts` — GameState, GameAction union
- **Create:** `src/renderer/state/game-reducer.ts` — game state reducer
- **Create:** `src/renderer/state/game-context.ts` — React context + provider
- **Create:** `src/renderer/hooks/useGameConnection.ts` — WebSocket hook
- **Create:** `src/renderer/components/game/GamePanel.tsx` — right panel container
- **Create:** `src/renderer/components/game/GameLobby.tsx` — create/join/online users
- **Create:** `src/renderer/components/game/ConnectFourBoard.tsx` — interactive board
- **Create:** `src/renderer/components/game/GameChat.tsx` — in-game chat widget
- **Create:** `src/renderer/components/game/GameOverlay.tsx` — game over / rematch
- **Modify:** `src/renderer/App.tsx` — add GameProvider, GamePanel, toggle button
- **Modify:** `src/renderer/components/HeaderBar.tsx` — add game panel toggle button

---

## Task 1: Shared Game Logic

**Files:**
- Create: `shared/connect-four.ts`
- Create: `tests/connect-four.test.ts`

- [ ] **Step 1: Write failing tests for core game functions**

```typescript
// tests/connect-four.test.ts
import { describe, it, expect } from 'vitest';
import {
  createBoard,
  dropPiece,
  checkWin,
  checkDraw,
  getValidColumns,
  ROWS,
  COLS,
} from '../shared/connect-four';

describe('createBoard', () => {
  it('creates a 7x6 board filled with zeros', () => {
    const board = createBoard();
    expect(board.length).toBe(COLS);
    expect(board[0].length).toBe(ROWS);
    expect(board.flat().every((cell) => cell === 0)).toBe(true);
  });
});

describe('dropPiece', () => {
  it('drops piece to bottom of empty column', () => {
    const board = createBoard();
    const result = dropPiece(board, 3, 1);
    expect(result).not.toBeNull();
    expect(result!.row).toBe(0);
    expect(result!.board[3][0]).toBe(1);
  });

  it('stacks pieces in same column', () => {
    let board = createBoard();
    board = dropPiece(board, 3, 1)!.board;
    const result = dropPiece(board, 3, 2);
    expect(result).not.toBeNull();
    expect(result!.row).toBe(1);
    expect(result!.board[3][1]).toBe(2);
  });

  it('returns null for full column', () => {
    let board = createBoard();
    for (let i = 0; i < ROWS; i++) {
      board = dropPiece(board, 0, i % 2 === 0 ? 1 : 2)!.board;
    }
    expect(dropPiece(board, 0, 1)).toBeNull();
  });

  it('does not mutate original board', () => {
    const board = createBoard();
    const original = JSON.stringify(board);
    dropPiece(board, 3, 1);
    expect(JSON.stringify(board)).toBe(original);
  });
});

describe('checkWin', () => {
  it('detects horizontal win', () => {
    let board = createBoard();
    for (let c = 0; c < 4; c++) {
      board = dropPiece(board, c, 1)!.board;
    }
    const result = checkWin(board, { col: 3, row: 0 });
    expect(result).not.toBeNull();
    expect(result!.length).toBe(4);
  });

  it('detects vertical win', () => {
    let board = createBoard();
    for (let i = 0; i < 4; i++) {
      board = dropPiece(board, 0, 1)!.board;
    }
    const result = checkWin(board, { col: 0, row: 3 });
    expect(result).not.toBeNull();
    expect(result!.length).toBe(4);
  });

  it('detects diagonal win (ascending)', () => {
    let board = createBoard();
    board = dropPiece(board, 0, 1)!.board;
    board = dropPiece(board, 1, 2)!.board;
    board = dropPiece(board, 1, 1)!.board;
    board = dropPiece(board, 2, 2)!.board;
    board = dropPiece(board, 2, 2)!.board;
    board = dropPiece(board, 2, 1)!.board;
    board = dropPiece(board, 3, 2)!.board;
    board = dropPiece(board, 3, 2)!.board;
    board = dropPiece(board, 3, 2)!.board;
    board = dropPiece(board, 3, 1)!.board;
    const result = checkWin(board, { col: 3, row: 3 });
    expect(result).not.toBeNull();
    expect(result!.length).toBe(4);
  });

  it('returns null when no win', () => {
    let board = createBoard();
    board = dropPiece(board, 0, 1)!.board;
    board = dropPiece(board, 1, 2)!.board;
    expect(checkWin(board, { col: 1, row: 0 })).toBeNull();
  });
});

describe('checkDraw', () => {
  it('returns false for non-full board', () => {
    expect(checkDraw(createBoard())).toBe(false);
  });

  it('returns true when board is full', () => {
    const board = createBoard();
    for (let c = 0; c < COLS; c++) {
      for (let r = 0; r < ROWS; r++) {
        board[c][r] = (c + r) % 2 === 0 ? 1 : 2;
      }
    }
    expect(checkDraw(board)).toBe(true);
  });
});

describe('getValidColumns', () => {
  it('returns all columns for empty board', () => {
    expect(getValidColumns(createBoard())).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('excludes full columns', () => {
    let board = createBoard();
    for (let i = 0; i < ROWS; i++) {
      board = dropPiece(board, 0, 1)!.board;
    }
    const valid = getValidColumns(board);
    expect(valid).not.toContain(0);
    expect(valid.length).toBe(6);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/connect-four.test.ts`
Expected: FAIL — module `../shared/connect-four` not found

- [ ] **Step 3: Implement connect-four.ts**

```typescript
// shared/connect-four.ts
export const ROWS = 6;
export const COLS = 7;

/** Board is column-major: board[col][row], row 0 = bottom */
export type Board = number[][];

export interface DropResult {
  board: Board;
  row: number;
}

export function createBoard(): Board {
  return Array.from({ length: COLS }, () => Array(ROWS).fill(0));
}

export function cloneBoard(board: Board): Board {
  return board.map((col) => [...col]);
}

export function dropPiece(board: Board, col: number, player: number): DropResult | null {
  if (col < 0 || col >= COLS) return null;
  const column = board[col];
  const row = column.indexOf(0);
  if (row === -1) return null;
  const next = cloneBoard(board);
  next[col][row] = player;
  return { board: next, row };
}

export function checkWin(
  board: Board,
  lastMove: { col: number; row: number },
): [number, number][] | null {
  const { col, row } = lastMove;
  const player = board[col][row];
  if (player === 0) return null;

  const directions = [
    [1, 0],  // horizontal
    [0, 1],  // vertical
    [1, 1],  // diagonal ascending
    [1, -1], // diagonal descending
  ];

  for (const [dc, dr] of directions) {
    const line: [number, number][] = [[col, row]];

    for (let i = 1; i < 4; i++) {
      const c = col + dc * i;
      const r = row + dr * i;
      if (c < 0 || c >= COLS || r < 0 || r >= ROWS || board[c][r] !== player) break;
      line.push([c, r]);
    }

    for (let i = 1; i < 4; i++) {
      const c = col - dc * i;
      const r = row - dr * i;
      if (c < 0 || c >= COLS || r < 0 || r >= ROWS || board[c][r] !== player) break;
      line.push([c, r]);
    }

    if (line.length >= 4) return line;
  }

  return null;
}

export function checkDraw(board: Board): boolean {
  return board.every((col) => col.every((cell) => cell !== 0));
}

export function getValidColumns(board: Board): number[] {
  return board
    .map((col, i) => (col[ROWS - 1] === 0 ? i : -1))
    .filter((i) => i !== -1);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/connect-four.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add shared/connect-four.ts tests/connect-four.test.ts
git commit -m "feat(game): add Connect 4 game logic with tests"
```

---

## Task 2: Leaderboard API — Database Layer

**Files:**
- Create: `server/leaderboard/package.json`
- Create: `server/leaderboard/tsconfig.json`
- Create: `server/leaderboard/src/types.ts`
- Create: `server/leaderboard/src/db.ts`
- Create: `server/leaderboard/tests/db.test.ts`

- [ ] **Step 1: Initialize the leaderboard server package**

```json
// server/leaderboard/package.json
{
  "name": "connect-four-leaderboard",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "test": "vitest run"
  },
  "dependencies": {
    "better-sqlite3": "^11.0.0",
    "bcrypt": "^5.1.1",
    "cors": "^2.8.5",
    "express": "^5.1.0"
  },
  "devDependencies": {
    "@types/bcrypt": "^5.0.2",
    "@types/better-sqlite3": "^7.6.12",
    "@types/cors": "^2.8.17",
    "@types/express": "^5.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.9.3",
    "vitest": "^4.1.0"
  }
}
```

```json
// server/leaderboard/tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 2: Install dependencies**

Run: `cd server/leaderboard && npm install`

- [ ] **Step 3: Create types**

```typescript
// server/leaderboard/src/types.ts
export interface Player {
  username: string;
  wins: number;
  losses: number;
  draws: number;
  created_at: string;
}

export interface RegisterRequest {
  username: string;
  password: string;
}

export interface VerifyRequest {
  username: string;
  password: string;
}

export interface RecordResultRequest {
  winner: string;
  loser: string;
  draw?: boolean;
}
```

- [ ] **Step 4: Write failing tests for the database layer**

```typescript
// server/leaderboard/tests/db.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, registerPlayer, verifyPlayer, getPlayer, getLeaderboard, recordResult } from '../src/db';

let db: ReturnType<typeof createDb>;

beforeEach(() => {
  db = createDb(':memory:');
});

describe('registerPlayer', () => {
  it('registers a new player and returns the player record', async () => {
    const player = await registerPlayer(db, 'alice', 'pass123');
    expect(player.username).toBe('alice');
    expect(player.wins).toBe(0);
  });

  it('throws on duplicate username', async () => {
    await registerPlayer(db, 'alice', 'pass123');
    await expect(registerPlayer(db, 'alice', 'other')).rejects.toThrow();
  });
});

describe('verifyPlayer', () => {
  it('returns true for correct password', async () => {
    await registerPlayer(db, 'alice', 'pass123');
    expect(await verifyPlayer(db, 'alice', 'pass123')).toBe(true);
  });

  it('returns false for wrong password', async () => {
    await registerPlayer(db, 'alice', 'pass123');
    expect(await verifyPlayer(db, 'alice', 'wrong')).toBe(false);
  });

  it('returns false for nonexistent user', async () => {
    expect(await verifyPlayer(db, 'nobody', 'pass')).toBe(false);
  });
});

describe('getPlayer', () => {
  it('returns player stats', async () => {
    await registerPlayer(db, 'alice', 'pass123');
    const player = getPlayer(db, 'alice');
    expect(player).not.toBeNull();
    expect(player!.username).toBe('alice');
  });

  it('returns null for unknown player', () => {
    expect(getPlayer(db, 'nobody')).toBeNull();
  });
});

describe('recordResult', () => {
  it('increments winner wins and loser losses', async () => {
    await registerPlayer(db, 'alice', 'p1');
    await registerPlayer(db, 'bob', 'p2');
    recordResult(db, 'alice', 'bob', false);
    expect(getPlayer(db, 'alice')!.wins).toBe(1);
    expect(getPlayer(db, 'bob')!.losses).toBe(1);
  });

  it('increments draws for both players', async () => {
    await registerPlayer(db, 'alice', 'p1');
    await registerPlayer(db, 'bob', 'p2');
    recordResult(db, 'alice', 'bob', true);
    expect(getPlayer(db, 'alice')!.draws).toBe(1);
    expect(getPlayer(db, 'bob')!.draws).toBe(1);
  });
});

describe('getLeaderboard', () => {
  it('returns players sorted by wins descending', async () => {
    await registerPlayer(db, 'alice', 'p1');
    await registerPlayer(db, 'bob', 'p2');
    recordResult(db, 'bob', 'alice', false);
    recordResult(db, 'bob', 'alice', false);
    recordResult(db, 'alice', 'bob', false);
    const lb = getLeaderboard(db, 10);
    expect(lb[0].username).toBe('bob');
    expect(lb[0].wins).toBe(2);
    expect(lb[1].username).toBe('alice');
  });

  it('respects limit parameter', async () => {
    await registerPlayer(db, 'a', 'p');
    await registerPlayer(db, 'b', 'p');
    await registerPlayer(db, 'c', 'p');
    const lb = getLeaderboard(db, 2);
    expect(lb.length).toBe(2);
  });
});
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `cd server/leaderboard && npx vitest run tests/db.test.ts`
Expected: FAIL — module not found

- [ ] **Step 6: Implement db.ts**

```typescript
// server/leaderboard/src/db.ts
import Database from 'better-sqlite3';
import bcrypt from 'bcrypt';
import { Player } from './types.js';

const SALT_ROUNDS = 10;

export function createDb(path: string) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS players (
      username      TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      wins          INTEGER DEFAULT 0,
      losses        INTEGER DEFAULT 0,
      draws         INTEGER DEFAULT 0,
      created_at    TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  return db;
}

export async function registerPlayer(
  db: Database.Database,
  username: string,
  password: string,
): Promise<Player> {
  const hash = await bcrypt.hash(password, SALT_ROUNDS);
  db.prepare('INSERT INTO players (username, password_hash) VALUES (?, ?)').run(username, hash);
  return getPlayer(db, username)!;
}

export async function verifyPlayer(
  db: Database.Database,
  username: string,
  password: string,
): Promise<boolean> {
  const row = db
    .prepare('SELECT password_hash FROM players WHERE username = ?')
    .get(username) as { password_hash: string } | undefined;
  if (!row) return false;
  return bcrypt.compare(password, row.password_hash);
}

export function getPlayer(db: Database.Database, username: string): Player | null {
  const row = db
    .prepare('SELECT username, wins, losses, draws, created_at FROM players WHERE username = ?')
    .get(username) as Player | undefined;
  return row ?? null;
}

export function getLeaderboard(db: Database.Database, limit: number): Player[] {
  return db
    .prepare('SELECT username, wins, losses, draws, created_at FROM players ORDER BY wins DESC LIMIT ?')
    .all(limit) as Player[];
}

export function recordResult(
  db: Database.Database,
  winner: string,
  loser: string,
  isDraw: boolean,
): void {
  if (isDraw) {
    db.prepare('UPDATE players SET draws = draws + 1 WHERE username = ?').run(winner);
    db.prepare('UPDATE players SET draws = draws + 1 WHERE username = ?').run(loser);
  } else {
    db.prepare('UPDATE players SET wins = wins + 1 WHERE username = ?').run(winner);
    db.prepare('UPDATE players SET losses = losses + 1 WHERE username = ?').run(loser);
  }
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd server/leaderboard && npx vitest run tests/db.test.ts`
Expected: All tests PASS

- [ ] **Step 8: Commit**

```bash
git add server/leaderboard/
git commit -m "feat(leaderboard): add database layer with player accounts and stats"
```

---

## Task 3: Leaderboard API — HTTP Routes

**Files:**
- Create: `server/leaderboard/src/routes.ts`
- Create: `server/leaderboard/src/index.ts`
- Create: `server/leaderboard/tests/routes.test.ts`

- [ ] **Step 1: Write failing tests for HTTP routes**

```typescript
// server/leaderboard/tests/routes.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../src/routes';
import { createDb } from '../src/db';
import { createServer } from 'http';

let app: ReturnType<typeof createApp>;

beforeEach(() => {
  const db = createDb(':memory:');
  app = createApp(db, 'test-secret');
});

async function request(method: string, path: string, body?: object, headers?: Record<string, string>) {
  return new Promise<{ status: number; body: any }>((resolve) => {
    const server = createServer(app);
    server.listen(0, () => {
      const addr = server.address() as { port: number };
      const url = `http://localhost:${addr.port}${path}`;
      const opts: RequestInit = {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: body ? JSON.stringify(body) : undefined,
      };
      fetch(url, opts)
        .then(async (res) => {
          const text = await res.text();
          let json;
          try { json = JSON.parse(text); } catch { json = text; }
          resolve({ status: res.status, body: json });
        })
        .finally(() => server.close());
    });
  });
}

describe('POST /players', () => {
  it('registers a new player (201)', async () => {
    const res = await request('POST', '/players', { username: 'alice', password: 'pass123' });
    expect(res.status).toBe(201);
    expect(res.body.username).toBe('alice');
  });

  it('rejects duplicate username (409)', async () => {
    await request('POST', '/players', { username: 'alice', password: 'pass123' });
    const res = await request('POST', '/players', { username: 'alice', password: 'other' });
    expect(res.status).toBe(409);
  });
});

describe('POST /players/verify', () => {
  it('returns 200 for valid credentials', async () => {
    await request('POST', '/players', { username: 'alice', password: 'pass123' });
    const res = await request('POST', '/players/verify', { username: 'alice', password: 'pass123' });
    expect(res.status).toBe(200);
  });

  it('returns 401 for invalid credentials', async () => {
    await request('POST', '/players', { username: 'alice', password: 'pass123' });
    const res = await request('POST', '/players/verify', { username: 'alice', password: 'wrong' });
    expect(res.status).toBe(401);
  });
});

describe('GET /players/:username', () => {
  it('returns player stats', async () => {
    await request('POST', '/players', { username: 'alice', password: 'pass123' });
    const res = await request('GET', '/players/alice');
    expect(res.status).toBe(200);
    expect(res.body.username).toBe('alice');
  });

  it('returns 404 for unknown player', async () => {
    const res = await request('GET', '/players/nobody');
    expect(res.status).toBe(404);
  });
});

describe('GET /leaderboard', () => {
  it('returns sorted leaderboard', async () => {
    await request('POST', '/players', { username: 'alice', password: 'p1' });
    await request('POST', '/players', { username: 'bob', password: 'p2' });
    await request('POST', '/results', { winner: 'bob', loser: 'alice' }, { Authorization: 'Bearer test-secret' });
    const res = await request('GET', '/leaderboard');
    expect(res.status).toBe(200);
    expect(res.body[0].username).toBe('bob');
  });
});

describe('POST /results', () => {
  it('rejects requests without shared secret (401)', async () => {
    const res = await request('POST', '/results', { winner: 'a', loser: 'b' });
    expect(res.status).toBe(401);
  });

  it('accepts requests with valid secret', async () => {
    await request('POST', '/players', { username: 'alice', password: 'p1' });
    await request('POST', '/players', { username: 'bob', password: 'p2' });
    const res = await request('POST', '/results', { winner: 'alice', loser: 'bob' }, { Authorization: 'Bearer test-secret' });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server/leaderboard && npx vitest run tests/routes.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement routes.ts**

```typescript
// server/leaderboard/src/routes.ts
import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import { registerPlayer, verifyPlayer, getPlayer, getLeaderboard, recordResult } from './db.js';

export function createApp(db: Database.Database, sharedSecret: string) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.post('/players', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
      res.status(400).json({ error: 'username and password required' });
      return;
    }
    try {
      const player = await registerPlayer(db, username, password);
      res.status(201).json(player);
    } catch {
      res.status(409).json({ error: 'username taken' });
    }
  });

  app.post('/players/verify', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
      res.status(400).json({ error: 'username and password required' });
      return;
    }
    const valid = await verifyPlayer(db, username, password);
    if (valid) {
      res.status(200).json({ valid: true });
    } else {
      res.status(401).json({ valid: false });
    }
  });

  app.get('/players/:username', (req, res) => {
    const player = getPlayer(db, req.params.username);
    if (!player) {
      res.status(404).json({ error: 'player not found' });
      return;
    }
    res.json(player);
  });

  app.get('/leaderboard', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const leaderboard = getLeaderboard(db, limit);
    res.json(leaderboard);
  });

  app.post('/results', (req, res) => {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${sharedSecret}`) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const { winner, loser, draw } = req.body;
    if (!winner || !loser) {
      res.status(400).json({ error: 'winner and loser required' });
      return;
    }
    recordResult(db, winner, loser, !!draw);
    res.json({ ok: true });
  });

  return app;
}
```

- [ ] **Step 4: Implement index.ts (server entry point)**

```typescript
// server/leaderboard/src/index.ts
import { createDb } from './db.js';
import { createApp } from './routes.js';

const PORT = parseInt(process.env.LEADERBOARD_PORT || '3001');
const DB_PATH = process.env.DATABASE_PATH || './data/leaderboard.db';
const SHARED_SECRET = process.env.SHARED_SECRET || 'dev-secret';

const db = createDb(DB_PATH);
const app = createApp(db, SHARED_SECRET);

app.listen(PORT, () => {
  console.log(`Leaderboard API listening on port ${PORT}`);
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server/leaderboard && npx vitest run`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add server/leaderboard/
git commit -m "feat(leaderboard): add HTTP routes and server entry point"
```

---

## Task 4: Relay Server — Presence & Room Manager

**Files:**
- Create: `server/relay/package.json`
- Create: `server/relay/tsconfig.json`
- Create: `server/relay/src/types.ts`
- Create: `server/relay/src/presence.ts`
- Create: `server/relay/src/room-manager.ts`
- Create: `server/relay/tests/presence.test.ts`
- Create: `server/relay/tests/room-manager.test.ts`

- [ ] **Step 1: Initialize the relay server package**

```json
// server/relay/package.json
{
  "name": "connect-four-relay",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "test": "vitest run"
  },
  "dependencies": {
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/ws": "^8.5.13",
    "tsx": "^4.19.0",
    "typescript": "^5.9.3",
    "vitest": "^4.1.0"
  }
}
```

```json
// server/relay/tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 2: Install dependencies**

Run: `cd server/relay && npm install`

- [ ] **Step 3: Create protocol types**

```typescript
// server/relay/src/types.ts
export type ClientMessage =
  | { type: 'authenticate'; username: string; password: string }
  | { type: 'create' }
  | { type: 'join'; code: string }
  | { type: 'move'; column: number }
  | { type: 'chat'; text: string }
  | { type: 'rematch' };

export type ServerMessage =
  | { type: 'authenticated'; success: boolean }
  | { type: 'presence'; online: { username: string; status: 'idle' | 'in-game' }[] }
  | { type: 'room:created'; code: string; color: 'red' | 'yellow' }
  | { type: 'game:start'; board: number[][]; you: 'red' | 'yellow'; opponent: string }
  | { type: 'game:state'; board: number[][]; turn: 'red' | 'yellow'; lastMove: { col: number; row: number } }
  | { type: 'game:over'; winner: 'red' | 'yellow' | 'draw'; line?: [number, number][] }
  | { type: 'chat:message'; from: string; text: string }
  | { type: 'error'; message: string }
  | { type: 'opponent:disconnected' };

export interface ConnectedUser {
  username: string;
  status: 'idle' | 'in-game';
  roomCode: string | null;
}
```

- [ ] **Step 4: Write failing tests for presence**

```typescript
// server/relay/tests/presence.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { Presence } from '../src/presence';

let presence: Presence;

beforeEach(() => {
  presence = new Presence();
});

describe('Presence', () => {
  it('adds a user and reports them online', () => {
    presence.addUser('alice');
    expect(presence.getOnlineUsers()).toEqual([{ username: 'alice', status: 'idle' }]);
  });

  it('removes a user', () => {
    presence.addUser('alice');
    presence.removeUser('alice');
    expect(presence.getOnlineUsers()).toEqual([]);
  });

  it('updates user status', () => {
    presence.addUser('alice');
    presence.setStatus('alice', 'in-game');
    expect(presence.getOnlineUsers()).toEqual([{ username: 'alice', status: 'in-game' }]);
  });

  it('tracks multiple users', () => {
    presence.addUser('alice');
    presence.addUser('bob');
    expect(presence.getOnlineUsers().length).toBe(2);
  });

  it('isOnline returns correct status', () => {
    presence.addUser('alice');
    expect(presence.isOnline('alice')).toBe(true);
    expect(presence.isOnline('bob')).toBe(false);
  });
});
```

- [ ] **Step 5: Write failing tests for room manager**

```typescript
// server/relay/tests/room-manager.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { RoomManager } from '../src/room-manager';

let manager: RoomManager;

beforeEach(() => {
  manager = new RoomManager();
});

describe('RoomManager', () => {
  it('creates a room and returns a 6-char code', () => {
    const code = manager.createRoom('alice');
    expect(code).toMatch(/^[A-Z0-9]{6}$/);
  });

  it('getRoom returns the room by code', () => {
    const code = manager.createRoom('alice');
    const room = manager.getRoom(code);
    expect(room).not.toBeNull();
    expect(room!.creator).toBe('alice');
  });

  it('getUserRoom finds room by username', () => {
    const code = manager.createRoom('alice');
    expect(manager.getUserRoom('alice')).toBe(manager.getRoom(code));
  });

  it('returns null for unknown code', () => {
    expect(manager.getRoom('XXXXXX')).toBeNull();
  });

  it('destroyRoom removes the room', () => {
    const code = manager.createRoom('alice');
    manager.destroyRoom(code);
    expect(manager.getRoom(code)).toBeNull();
  });

  it('generates unique codes', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 100; i++) {
      codes.add(manager.createRoom(`user${i}`));
    }
    expect(codes.size).toBe(100);
  });
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `cd server/relay && npx vitest run`
Expected: FAIL — modules not found

- [ ] **Step 7: Implement presence.ts**

```typescript
// server/relay/src/presence.ts
export interface OnlineUser {
  username: string;
  status: 'idle' | 'in-game';
}

export class Presence {
  private users = new Map<string, 'idle' | 'in-game'>();

  addUser(username: string): void {
    this.users.set(username, 'idle');
  }

  removeUser(username: string): void {
    this.users.delete(username);
  }

  setStatus(username: string, status: 'idle' | 'in-game'): void {
    if (this.users.has(username)) {
      this.users.set(username, status);
    }
  }

  isOnline(username: string): boolean {
    return this.users.has(username);
  }

  getOnlineUsers(): OnlineUser[] {
    return Array.from(this.users.entries()).map(([username, status]) => ({ username, status }));
  }
}
```

- [ ] **Step 8: Implement room-manager.ts**

```typescript
// server/relay/src/room-manager.ts
import { createBoard, Board } from '../../../shared/connect-four';

export interface Room {
  code: string;
  creator: string;
  players: { red: string | null; yellow: string | null };
  board: Board;
  turn: 'red' | 'yellow';
  status: 'waiting' | 'playing' | 'finished';
  rematchVotes: Set<string>;
}

const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateCode(): string {
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += CHARS[Math.floor(Math.random() * CHARS.length)];
  }
  return code;
}

export class RoomManager {
  private rooms = new Map<string, Room>();
  private userRooms = new Map<string, string>(); // username -> room code

  createRoom(creator: string): string {
    let code: string;
    do { code = generateCode(); } while (this.rooms.has(code));

    this.rooms.set(code, {
      code,
      creator,
      players: { red: creator, yellow: null },
      board: createBoard(),
      turn: 'red',
      status: 'waiting',
      rematchVotes: new Set(),
    });
    this.userRooms.set(creator, code);
    return code;
  }

  getRoom(code: string): Room | null {
    return this.rooms.get(code) ?? null;
  }

  getUserRoom(username: string): Room | null {
    const code = this.userRooms.get(username);
    if (!code) return null;
    return this.rooms.get(code) ?? null;
  }

  addUserToRoom(code: string, username: string): void {
    this.userRooms.set(username, code);
  }

  destroyRoom(code: string): void {
    const room = this.rooms.get(code);
    if (room) {
      if (room.players.red) this.userRooms.delete(room.players.red);
      if (room.players.yellow) this.userRooms.delete(room.players.yellow);
      this.rooms.delete(code);
    }
  }

  removeUserFromRoom(username: string): void {
    this.userRooms.delete(username);
  }

  activeRoomCount(): number {
    return this.rooms.size;
  }
}
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `cd server/relay && npx vitest run`
Expected: All tests PASS

- [ ] **Step 10: Commit**

```bash
git add server/relay/
git commit -m "feat(relay): add presence tracking and room manager"
```

---

## Task 5: Relay Server — Game Room Logic & WebSocket Entry Point

**Files:**
- Create: `server/relay/src/room.ts`
- Create: `server/relay/src/index.ts`
- Create: `server/relay/tests/room.test.ts`

- [ ] **Step 1: Write failing tests for room game logic**

```typescript
// server/relay/tests/room.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { RoomManager } from '../src/room-manager';
import { joinRoom, handleMove, handleRematch } from '../src/room';
import type { Room } from '../src/room-manager';

let manager: RoomManager;

describe('joinRoom', () => {
  let code: string;

  beforeEach(() => {
    manager = new RoomManager();
    code = manager.createRoom('alice');
  });

  it('adds second player as yellow', () => {
    const room = manager.getRoom(code)!;
    const result = joinRoom(room, 'bob');
    expect(result.success).toBe(true);
    expect(room.players.yellow).toBe('bob');
    expect(room.status).toBe('playing');
  });

  it('rejects third player', () => {
    const room = manager.getRoom(code)!;
    joinRoom(room, 'bob');
    expect(joinRoom(room, 'charlie').success).toBe(false);
  });

  it('rejects creator joining own room', () => {
    const room = manager.getRoom(code)!;
    expect(joinRoom(room, 'alice').success).toBe(false);
  });
});

describe('handleMove', () => {
  let room: Room;

  beforeEach(() => {
    manager = new RoomManager();
    const code = manager.createRoom('alice');
    room = manager.getRoom(code)!;
    joinRoom(room, 'bob');
  });

  it('accepts valid move from correct player', () => {
    const result = handleMove(room, 'alice', 3);
    expect(result.success).toBe(true);
    expect(result.row).toBe(0);
    expect(room.turn).toBe('yellow');
  });

  it('rejects move from wrong player', () => {
    expect(handleMove(room, 'bob', 3).success).toBe(false);
  });

  it('rejects invalid column', () => {
    expect(handleMove(room, 'alice', 7).success).toBe(false);
  });

  it('detects a win', () => {
    handleMove(room, 'alice', 0);
    handleMove(room, 'bob', 0);
    handleMove(room, 'alice', 1);
    handleMove(room, 'bob', 1);
    handleMove(room, 'alice', 2);
    handleMove(room, 'bob', 2);
    const result = handleMove(room, 'alice', 3);
    expect(result.winner).toBe('red');
    expect(result.line).not.toBeNull();
    expect(room.status).toBe('finished');
  });
});

describe('handleRematch', () => {
  let room: Room;

  beforeEach(() => {
    manager = new RoomManager();
    const code = manager.createRoom('alice');
    room = manager.getRoom(code)!;
    joinRoom(room, 'bob');
    room.status = 'finished';
  });

  it('does not reset until both vote', () => {
    expect(handleRematch(room, 'alice').ready).toBe(false);
    expect(room.status).toBe('finished');
  });

  it('resets board and swaps colors when both vote', () => {
    handleRematch(room, 'alice');
    const result = handleRematch(room, 'bob');
    expect(result.ready).toBe(true);
    expect(room.status).toBe('playing');
    expect(room.players.red).toBe('bob');
    expect(room.players.yellow).toBe('alice');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server/relay && npx vitest run tests/room.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement room.ts**

```typescript
// server/relay/src/room.ts
import type { Room } from './room-manager.js';
import { dropPiece, checkWin, checkDraw, createBoard } from '../../../shared/connect-four.js';

interface MoveResult {
  success: boolean;
  row?: number;
  winner?: 'red' | 'yellow' | 'draw';
  line?: [number, number][] | null;
  error?: string;
}

interface RematchResult {
  ready: boolean;
}

export function joinRoom(room: Room, username: string): { success: boolean; error?: string } {
  if (room.players.red === username) {
    return { success: false, error: 'Cannot join your own room' };
  }
  if (room.players.yellow !== null) {
    return { success: false, error: 'Room is full' };
  }
  room.players.yellow = username;
  room.status = 'playing';
  return { success: true };
}

export function handleMove(room: Room, username: string, column: number): MoveResult {
  if (room.status !== 'playing') {
    return { success: false, error: 'Game not in progress' };
  }

  const currentPlayer = room.turn === 'red' ? room.players.red : room.players.yellow;
  if (username !== currentPlayer) {
    return { success: false, error: 'Not your turn' };
  }

  const playerNum = room.turn === 'red' ? 1 : 2;
  const result = dropPiece(room.board, column, playerNum);
  if (!result) {
    return { success: false, error: 'Invalid move' };
  }

  room.board = result.board;
  const lastMove = { col: column, row: result.row };

  const winLine = checkWin(room.board, lastMove);
  if (winLine) {
    room.status = 'finished';
    return { success: true, row: result.row, winner: room.turn, line: winLine };
  }

  if (checkDraw(room.board)) {
    room.status = 'finished';
    return { success: true, row: result.row, winner: 'draw' };
  }

  room.turn = room.turn === 'red' ? 'yellow' : 'red';
  return { success: true, row: result.row };
}

export function handleRematch(room: Room, username: string): RematchResult {
  room.rematchVotes.add(username);

  if (room.rematchVotes.size < 2) {
    return { ready: false };
  }

  const oldRed = room.players.red;
  const oldYellow = room.players.yellow;
  room.players.red = oldYellow;
  room.players.yellow = oldRed;
  room.board = createBoard();
  room.turn = 'red';
  room.status = 'playing';
  room.rematchVotes.clear();

  return { ready: true };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server/relay && npx vitest run`
Expected: All tests PASS

- [ ] **Step 5: Implement index.ts (WebSocket server entry point)**

The implementer should write `server/relay/src/index.ts` based on the protocol defined in the spec. Key structure:

- Create `WebSocketServer` on configured port
- Maintain `socketUser` (WebSocket -> username) and `userSocket` (username -> WebSocket) maps
- On `connection`: set up message handler, heartbeat ping interval, close handler
- Message handler switches on `msg.type` and delegates to presence, room-manager, and room modules
- On `authenticate`: verify against leaderboard API via fetch, add to presence, broadcast
- On `create`: create room via room-manager, update presence to `in-game`, send `room:created`
- On `join`: join room, update presence, send `game:start` to both players
- On `move`: find user's room via `getUserRoom()`, call `handleMove()`, broadcast state, handle game over with leaderboard result reporting
- On `chat`: find user's room, broadcast `chat:message` to both players
- On `rematch`: find user's room, call `handleRematch()`, send `game:start` on ready
- On `close`: remove from presence, notify opponent, start 60s disconnect timeout, forfeit on expiry

Environment variables: `RELAY_PORT` (default 3002), `LEADERBOARD_URL` (default http://localhost:3001), `SHARED_SECRET` (default dev-secret)

- [ ] **Step 6: Commit**

```bash
git add server/relay/
git commit -m "feat(relay): add game room logic and WebSocket server"
```

---

## Task 6: Client — Game State Management

**Files:**
- Create: `src/renderer/game/connect-four.ts`
- Create: `src/renderer/state/game-types.ts`
- Create: `src/renderer/state/game-reducer.ts`
- Create: `src/renderer/state/game-context.ts`

- [ ] **Step 1: Create client-side game logic bridge**

Create `src/renderer/game/connect-four.ts` that re-exports from `shared/connect-four.ts`. If Vite can't resolve the path outside its root, the implementer should either:
- Add a `resolve.alias` in `vite.config.ts` mapping `@shared` to the `shared/` directory
- Or copy `shared/connect-four.ts` into `src/renderer/game/` directly

- [ ] **Step 2: Create game state types**

Create `src/renderer/state/game-types.ts` with:
- `GameScreen` type: `'setup' | 'lobby' | 'waiting' | 'playing' | 'game-over'`
- `PlayerColor` type: `'red' | 'yellow'`
- `OnlineUser`, `ChatMessage` interfaces
- `GameState` interface with all fields (connected, authenticated, username, onlineUsers, screen, roomCode, myColor, opponent, board, turn, lastMove, winner, winLine, chatMessages, panelOpen)
- `GameAction` discriminated union matching the spec's action list
- `createInitialGameState()` factory function

- [ ] **Step 3: Implement game reducer**

Create `src/renderer/state/game-reducer.ts` — a pure function `gameReducer(state, action)` handling all `GameAction` types. Follows the same pattern as `src/renderer/state/chat-reducer.ts`.

Key transitions:
- `AUTHENTICATED` with `success: true` -> screen becomes `'lobby'`
- `ROOM_CREATED` -> screen becomes `'waiting'`
- `GAME_START` -> screen becomes `'playing'`, resets chat/winner
- `GAME_OVER` -> screen becomes `'game-over'`
- `RETURN_TO_LOBBY` -> screen becomes `'lobby'`, clears game state

- [ ] **Step 4: Create game context provider**

Create `src/renderer/state/game-context.ts` with `GameProvider`, `useGameState()`, `useGameDispatch()` — mirrors `src/renderer/state/chat-context.ts` pattern.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/game/ src/renderer/state/game-types.ts src/renderer/state/game-reducer.ts src/renderer/state/game-context.ts
git commit -m "feat(client): add game state management (types, reducer, context)"
```

---

## Task 7: Client — WebSocket Hook

**Files:**
- Create: `src/renderer/hooks/useGameConnection.ts`

- [ ] **Step 1: Implement the WebSocket connection hook**

Create `src/renderer/hooks/useGameConnection.ts`:

- Opens WebSocket to relay server URL (configurable, default `ws://localhost:3002`)
- On open: auto-authenticate if `c4_username` / `c4_password` exist in `localStorage`
- On message: parse JSON, dispatch appropriate `GameAction` based on `msg.type`
- On close: dispatch `CONNECTION_STATUS` false, auto-reconnect after 3 seconds
- Exposes action functions: `register()`, `authenticate()`, `createGame()`, `joinGame(code)`, `makeMove(column)`, `sendChat(text)`, `requestRematch()`
- `register()` calls `POST /players` on the leaderboard API, then authenticates on success
- Stores credentials in `localStorage` on successful auth

- [ ] **Step 2: Commit**

```bash
git add src/renderer/hooks/useGameConnection.ts
git commit -m "feat(client): add WebSocket connection hook for game relay"
```

---

## Task 8: Client — Game Panel UI Components

**Files:**
- Create: `src/renderer/components/game/GamePanel.tsx`
- Create: `src/renderer/components/game/GameLobby.tsx`
- Create: `src/renderer/components/game/ConnectFourBoard.tsx`
- Create: `src/renderer/components/game/GameChat.tsx`
- Create: `src/renderer/components/game/GameOverlay.tsx`

Build each component one at a time, testing visually in dev mode.

- [ ] **Step 1: Create GamePanel (container)**

320px fixed width right panel. Reads `useGameState().screen` to render the correct child. Close button dispatches `TOGGLE_PANEL`. Dark background matching app theme (`bg-gray-900`, `border-l border-gray-800`).

- [ ] **Step 2: Create GameLobby**

Three sub-screens based on `screen` state:
- **setup**: Username + password form, calls `register()` from hook
- **lobby**: Player stats bar, online users list, Create Game button, Join Code input, leaderboard preview (fetched from `GET /leaderboard`)
- **waiting**: Large room code display, Copy button, Cancel button

Reference the UX mockups in `.superpowers/brainstorm/53203-1774019890/ux-flow.html` for visual design.

- [ ] **Step 3: Create ConnectFourBoard**

7x6 CSS grid board:
- Blue background, circular cells (empty=dark, red, yellow)
- Column hover: ghost piece preview at top of hovered column
- Click: calls `makeMove(column)`, only active when `turn === myColor`
- Win line: glowing highlight on winning 4 cells
- Drop animation: CSS transition on piece Y position
- Turn indicator bar above board

- [ ] **Step 4: Create GameChat**

Compact chat widget:
- Scrollable message list from `gameState.chatMessages`
- Sender names colored by their player color
- Text input at bottom, sends on Enter via `sendChat()`
- Auto-scroll to newest message

- [ ] **Step 5: Create GameOverlay**

Semi-transparent overlay on game-over:
- "You Win!" / "You Lose!" / "Draw!" text
- Rematch button -> `requestRematch()`
- Back to Lobby button -> dispatches `RETURN_TO_LOBBY`

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/game/
git commit -m "feat(client): add game panel UI components"
```

---

## Task 9: Client — Layout Integration

**Files:**
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/components/HeaderBar.tsx`

- [ ] **Step 1: Read existing files**

Read `src/renderer/App.tsx` and `src/renderer/components/HeaderBar.tsx` to understand current structure.

- [ ] **Step 2: Wrap App with GameProvider**

In `App.tsx`, add `GameProvider` wrapping the existing `ChatProvider`:

```tsx
export default function App() {
  return (
    <GameProvider>
      <ChatProvider>
        <AppInner />
      </ChatProvider>
    </GameProvider>
  );
}
```

- [ ] **Step 3: Add GamePanel to the layout**

In `AppInner`, render `<GamePanel />` as a sibling after the main content div, conditionally on `gameState.panelOpen`:

```tsx
<div className="flex-1 flex flex-col overflow-hidden">
  {/* ...existing content... */}
</div>
{gameState.panelOpen && <GamePanel />}
```

- [ ] **Step 4: Add game toggle button to HeaderBar**

Add a small game icon button that dispatches `TOGGLE_PANEL`. Show green dot when connected to relay. Read existing `HeaderBar.tsx` props/layout first.

- [ ] **Step 5: Initialize WebSocket connection**

Add `useGameConnection()` call in `AppInner` so the WebSocket connects when the app starts.

- [ ] **Step 6: Manual integration test**

Run all three services:
1. `cd server/leaderboard && npm run dev`
2. `cd server/relay && npm run dev`
3. `npm run dev`

Verify: panel toggles, registration works, presence shows, room creation works.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/App.tsx src/renderer/components/HeaderBar.tsx
git commit -m "feat: integrate game panel into main app layout"
```

---

## Task 10: Dev Scripts & Configuration

**Files:**
- Create: `server/.env.example`
- Modify: `package.json`
- Modify: `.gitignore`

- [ ] **Step 1: Create env example**

```env
# server/.env.example
RELAY_PORT=3002
LEADERBOARD_PORT=3001
LEADERBOARD_URL=http://localhost:3001
SHARED_SECRET=change-me-in-production
DATABASE_PATH=./server/leaderboard/data/leaderboard.db
```

- [ ] **Step 2: Add convenience scripts to root package.json**

Add to `scripts`:
```json
"dev:leaderboard": "cd server/leaderboard && npm run dev",
"dev:relay": "cd server/relay && npm run dev",
"dev:all": "concurrently \"npm run dev:leaderboard\" \"npm run dev:relay\" \"npm run dev\""
```

- [ ] **Step 3: Update .gitignore**

Add:
```
server/leaderboard/data/
.superpowers/
```

- [ ] **Step 4: Commit**

```bash
git add server/.env.example package.json .gitignore
git commit -m "chore: add dev scripts and server configuration"
```
