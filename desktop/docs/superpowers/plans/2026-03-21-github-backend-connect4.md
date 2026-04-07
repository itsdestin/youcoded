# GitHub Backend for Connect 4 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Superseded (replaced by PartyKit architecture — see `specs/2026-03-27-partykit-game-backend-design.md`)

**Goal:** Replace the WebSocket relay + leaderboard servers with a GitHub repo as the backend, so multiplayer Connect 4 works across the internet with zero infrastructure.

**Architecture:** A single GitHub repo stores all game state as JSON files. The Electron main process provides the GitHub auth token (via `gh auth token`). The renderer makes GitHub API calls directly via `fetch` to `api.github.com`. Polling replaces real-time WebSocket. Identity = GitHub username (no registration needed).

**Tech Stack:** GitHub REST API, `gh` CLI (for auth token), `fetch`, existing React/TypeScript

**Spec:** `docs/superpowers/specs/2026-03-20-connect-four-multiplayer-design.md` (original spec — this plan diverges on networking layer)

**Previous plan:** `docs/superpowers/plans/2026-03-20-connect-four-multiplayer.md` (WebSocket-based — being replaced)

---

## Repo Structure

The GitHub repo (e.g., `destinclaude-connect4`) will contain:

```
games/
  ABCDEF.json        # active/finished game state
presence.json         # { "username": timestamp, ... }
leaderboard.json      # { "username": { wins, losses, draws }, ... }
challenges/
  target_from.json    # pending challenge
```

### Game file format (`games/ABCDEF.json`):
```json
{
  "code": "ABCDEF",
  "red": "alice",
  "yellow": "bob",
  "board": [[0,0,0,0,0,0], ...],
  "turn": "red",
  "status": "playing",
  "chat": [
    { "from": "alice", "text": "gg", "timestamp": 1234567890 }
  ]
}
```

### Presence file format (`presence.json`):
```json
{
  "alice": { "timestamp": 1234567890, "status": "idle" },
  "bob": { "timestamp": 1234567891, "status": "in-game" }
}
```

### Leaderboard file format (`leaderboard.json`):
```json
{
  "alice": { "wins": 5, "losses": 2, "draws": 1 },
  "bob": { "wins": 3, "losses": 4, "draws": 0 }
}
```

### Challenge file format (`challenges/bob_alice.json`):
Filename is `{target}_{from}.json`. Existence = pending challenge. Contains:
```json
{ "from": "alice", "target": "bob", "code": "ABCDEF", "timestamp": 1234567890 }
```

---

## Polling Intervals (per user request)

| What | Interval | Condition |
|---|---|---|
| Game state | 10 seconds | Only when opponent's turn |
| Waiting for join | 10 seconds | On waiting screen |
| Presence write | 60 seconds | While app is open |
| Presence read | 60 seconds | On lobby screen |
| Offline threshold | 5 minutes | Stale heartbeat |
| Leaderboard | Once | On lobby enter |
| Chat | Piggybacks on game poll | No extra requests |
| Challenges | 60 seconds | On lobby screen (part of presence poll) |

---

## File Map

### Delete
- `server/` — entire directory (relay + leaderboard servers)
- `src/main/game-servers.ts` — server launcher
- `src/renderer/hooks/useGameConnection.ts` — WebSocket hook
- `src/renderer/game/config.ts` — server URLs config

### Create
- `src/renderer/game/github-api.ts` — low-level GitHub API wrapper (CRUD for repo files)
- `src/renderer/game/github-game.ts` — game-specific operations (create game, make move, etc.)
- `src/renderer/hooks/useGitHubGame.ts` — React hook replacing useGameConnection (polling, actions)

### Modify
- `src/main/main.ts` — remove game-servers import, add IPC for GitHub token
- `src/main/preload.ts` — expose GitHub token IPC channel
- `src/renderer/App.tsx` — replace `useGameConnection` with `useGitHubGame`
- `src/renderer/state/game-types.ts` — simplify: remove `connected`/`authenticated`/`authError`, identity is just GitHub username
- `src/renderer/state/game-reducer.ts` — match type changes
- `src/renderer/components/game/GamePanel.tsx` — update connection interface
- `src/renderer/components/game/GameLobby.tsx` — remove register/login form (GitHub username is automatic), update connection interface
- `src/renderer/components/game/ConnectFourBoard.tsx` — update connection interface
- `src/renderer/components/game/GameChat.tsx` — update connection interface
- `src/renderer/components/game/GameOverlay.tsx` — update connection interface

---

## Task 1: GitHub API Wrapper

**Files:**
- Create: `src/renderer/game/github-api.ts`
- Create: `tests/github-api.test.ts`

This module handles raw GitHub REST API operations: read a file, write a file (create or update), delete a file, list files in a directory. All operations need the repo name, auth token, and file path.

GitHub's Contents API requires the file's SHA for updates (optimistic concurrency). The wrapper must handle this transparently.

- [ ] **Step 1: Write failing tests**

```typescript
// tests/github-api.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubAPI } from '../src/renderer/game/github-api';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

let api: GitHubAPI;

beforeEach(() => {
  mockFetch.mockReset();
  api = new GitHubAPI('test-token', 'owner/repo');
});

describe('readFile', () => {
  it('returns parsed JSON content when file exists', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: btoa(JSON.stringify({ hello: 'world' })),
        sha: 'abc123',
      }),
    });
    const result = await api.readFile('test.json');
    expect(result).toEqual({ data: { hello: 'world' }, sha: 'abc123' });
  });

  it('returns null when file does not exist (404)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
    const result = await api.readFile('missing.json');
    expect(result).toBeNull();
  });
});

describe('writeFile', () => {
  it('creates a new file when no sha provided', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: { sha: 'new-sha' } }),
    });
    const result = await api.writeFile('new.json', { data: true }, 'create file');
    expect(result).toEqual({ sha: 'new-sha' });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/contents/new.json'),
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('updates a file when sha provided', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: { sha: 'updated-sha' } }),
    });
    const result = await api.writeFile('existing.json', { data: true }, 'update file', 'old-sha');
    expect(result).toEqual({ sha: 'updated-sha' });
  });

  it('returns null on conflict (409)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 409 });
    const result = await api.writeFile('conflict.json', { data: true }, 'update', 'stale-sha');
    expect(result).toBeNull();
  });
});

describe('deleteFile', () => {
  it('deletes a file with sha', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    await api.deleteFile('old.json', 'abc123', 'cleanup');
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/contents/old.json'),
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});

describe('listFiles', () => {
  it('returns array of filenames in a directory', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { name: 'ABCDEF.json', type: 'file' },
        { name: 'GHIJKL.json', type: 'file' },
      ],
    });
    const result = await api.listFiles('games');
    expect(result).toEqual(['ABCDEF.json', 'GHIJKL.json']);
  });

  it('returns empty array for missing directory', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
    const result = await api.listFiles('nonexistent');
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/github-api.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement github-api.ts**

```typescript
// src/renderer/game/github-api.ts

export interface FileResult {
  data: any;
  sha: string;
}

export interface WriteResult {
  sha: string;
}

export class GitHubAPI {
  private token: string;
  private repo: string;
  private baseUrl: string;

  constructor(token: string, repo: string) {
    this.token = token;
    this.repo = repo;
    this.baseUrl = `https://api.github.com/repos/${repo}/contents`;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    };
  }

  async readFile(path: string): Promise<FileResult | null> {
    const res = await fetch(`${this.baseUrl}/${path}`, { headers: this.headers() });
    if (!res.ok) return null;
    const json = await res.json();
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(json.content), c => c.charCodeAt(0)));
    const content = JSON.parse(decoded);
    return { data: content, sha: json.sha };
  }

  async writeFile(
    path: string,
    data: any,
    message: string,
    sha?: string,
  ): Promise<WriteResult | null> {
    const body: any = {
      message,
      content: btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(data, null, 2)))),
    };
    if (sha) body.sha = sha;

    const res = await fetch(`${this.baseUrl}/${path}`, {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return { sha: json.content.sha };
  }

  async deleteFile(path: string, sha: string, message: string): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/${path}`, {
      method: 'DELETE',
      headers: this.headers(),
      body: JSON.stringify({ message, sha }),
    });
    return res.ok;
  }

  async listFiles(dirPath: string): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/${dirPath}`, { headers: this.headers() });
    if (!res.ok) return [];
    const json = await res.json();
    if (!Array.isArray(json)) return [];
    return json.filter((f: any) => f.type === 'file').map((f: any) => f.name);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/github-api.test.ts`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/renderer/game/github-api.ts tests/github-api.test.ts
git commit -m "feat(game): add GitHub API wrapper for repo-backed game state"
```

---

## Task 2: Game Operations Layer

**Files:**
- Create: `src/renderer/game/github-game.ts`
- Create: `tests/github-game.test.ts`

This module provides game-specific operations built on top of GitHubAPI: create game, join game, make move, send chat, update presence, read leaderboard, challenge player, etc.

- [ ] **Step 1: Write failing tests**

```typescript
// tests/github-game.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GameOps } from '../src/renderer/game/github-game';
import { GitHubAPI } from '../src/renderer/game/github-api';

vi.mock('../src/renderer/game/github-api');

let ops: GameOps;
let mockApi: any;

beforeEach(() => {
  mockApi = {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    deleteFile: vi.fn(),
    listFiles: vi.fn(),
  };
  ops = new GameOps(mockApi as unknown as GitHubAPI, 'testuser');
});

describe('createGame', () => {
  it('creates a game file and returns a code', async () => {
    mockApi.writeFile.mockResolvedValueOnce({ sha: 'abc' });
    const code = await ops.createGame();
    expect(code).toMatch(/^[A-Z0-9]{6}$/);
    expect(mockApi.writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/^games\/[A-Z0-9]{6}\.json$/),
      expect.objectContaining({
        red: 'testuser',
        yellow: null,
        status: 'waiting',
      }),
      expect.any(String),
    );
  });
});

describe('joinGame', () => {
  it('joins an existing waiting game', async () => {
    mockApi.readFile.mockResolvedValueOnce({
      data: { code: 'ABCDEF', red: 'alice', yellow: null, status: 'waiting', board: [], chat: [] },
      sha: 'sha1',
    });
    mockApi.writeFile.mockResolvedValueOnce({ sha: 'sha2' });
    const result = await ops.joinGame('ABCDEF');
    expect(result.ok).toBe(true);
  });

  it('rejects joining a full game', async () => {
    mockApi.readFile.mockResolvedValueOnce({
      data: { code: 'ABCDEF', red: 'alice', yellow: 'bob', status: 'playing', board: [], chat: [] },
      sha: 'sha1',
    });
    const result = await ops.joinGame('ABCDEF');
    expect(result.ok).toBe(false);
  });
});

describe('makeMove', () => {
  it('updates board and switches turn', async () => {
    const board = Array.from({ length: 7 }, () => Array(6).fill(0));
    mockApi.readFile.mockResolvedValueOnce({
      data: { code: 'ABCDEF', red: 'testuser', yellow: 'bob', board, turn: 'red', status: 'playing', chat: [] },
      sha: 'sha1',
    });
    mockApi.writeFile.mockResolvedValueOnce({ sha: 'sha2' });
    const result = await ops.makeMove('ABCDEF', 3);
    expect(result.ok).toBe(true);
    // Verify the write was called with updated board
    const writtenData = mockApi.writeFile.mock.calls[0][1];
    expect(writtenData.board[3][0]).toBe(1); // red piece at bottom
    expect(writtenData.turn).toBe('yellow');
  });

  it('rejects move when not your turn', async () => {
    const board = Array.from({ length: 7 }, () => Array(6).fill(0));
    mockApi.readFile.mockResolvedValueOnce({
      data: { code: 'ABCDEF', red: 'alice', yellow: 'testuser', board, turn: 'red', status: 'playing', chat: [] },
      sha: 'sha1',
    });
    const result = await ops.makeMove('ABCDEF', 3);
    expect(result.ok).toBe(false);
  });
});

describe('updatePresence', () => {
  it('writes username with timestamp to presence file', async () => {
    mockApi.readFile.mockResolvedValueOnce({
      data: { otheruser: { timestamp: 100, status: 'idle' } },
      sha: 'sha1',
    });
    mockApi.writeFile.mockResolvedValueOnce({ sha: 'sha2' });
    await ops.updatePresence('idle');
    const writtenData = mockApi.writeFile.mock.calls[0][1];
    expect(writtenData.testuser).toBeDefined();
    expect(writtenData.testuser.status).toBe('idle');
    expect(writtenData.otheruser).toBeDefined();
  });
});

describe('getOnlineUsers', () => {
  it('returns users with timestamps within 5 minutes', async () => {
    const now = Date.now();
    mockApi.readFile.mockResolvedValueOnce({
      data: {
        alice: { timestamp: now - 60000, status: 'idle' },        // 1 min ago — online
        bob: { timestamp: now - 400000, status: 'idle' },          // 6.6 min ago — offline
      },
      sha: 'sha1',
    });
    const users = await ops.getOnlineUsers();
    expect(users.length).toBe(1);
    expect(users[0].username).toBe('alice');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/github-game.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement github-game.ts**

This file contains the `GameOps` class with methods:
- `createGame()` → creates a game JSON file, returns the code
- `joinGame(code)` → reads game file, adds yellow player, writes back
- `makeMove(code, column)` → reads game, applies move via `dropPiece`, checks win/draw, writes back. Returns the new game state.
- `sendChat(code, text)` → reads game, appends chat message, writes back
- `readGame(code)` → reads game file, returns current state
- `updatePresence(status)` → read-modify-write `presence.json` with current timestamp
- `getOnlineUsers()` → reads `presence.json`, filters to users active within 5 minutes
- `getLeaderboard()` → reads `leaderboard.json`, returns sorted entries
- `recordResult(winner, loser, isDraw)` → read-modify-write `leaderboard.json`
- `challengePlayer(target)` → creates challenge file + game file
- `getMyChallenge()` → checks `challenges/` for files targeting this user
- `respondToChallenge(from, accept)` → deletes challenge file, joins game if accepted
- `leaveGame(code)` → updates game status to finished, records forfeit
- `requestRematch(code)` → adds rematch vote to game file, resets if both voted

Key implementation details:
- All read-modify-write operations use SHA-based optimistic concurrency. If the write returns null (409 conflict), re-read and retry once.
- The `createGame` function generates a 6-char code from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`.
- The game logic functions (`dropPiece`, `checkWin`, `checkDraw`) are imported from `./connect-four`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/github-game.test.ts`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/renderer/game/github-game.ts tests/github-game.test.ts
git commit -m "feat(game): add game operations layer for GitHub backend"
```

---

## Task 3: GitHub Auth Token via IPC

**Files:**
- Modify: `src/main/main.ts`
- Modify: `src/main/preload.ts`

The renderer needs the GitHub auth token and username to make API calls. The main process obtains these by running `gh auth token` and `gh api user --jq '.login'`.

- [ ] **Step 1: Add IPC handler in main.ts**

Remove the `game-servers` import and `startGameServers`/`stopGameServers` calls. Add an IPC handler:

```typescript
import { execFile } from 'child_process';
import { promisify } from 'util';
const execFileAsync = promisify(execFile);

ipcMain.handle('github:auth', async () => {
  try {
    const { stdout: token } = await execFileAsync('gh', ['auth', 'token']);
    const { stdout: username } = await execFileAsync('gh', ['api', 'user', '--jq', '.login']);
    return { token: token.trim(), username: username.trim() };
  } catch {
    return null;
  }
});
```

- [ ] **Step 2: Expose in preload.ts**

Add to the contextBridge:

```typescript
getGitHubAuth: () => ipcRenderer.invoke('github:auth'),
```

- [ ] **Step 3: Commit**

```bash
git add src/main/main.ts src/main/preload.ts
git commit -m "feat: add GitHub auth IPC channel, remove game server launcher"
```

---

## Task 4: GitHub Game Hook (replaces useGameConnection)

**Files:**
- Create: `src/renderer/hooks/useGitHubGame.ts`
- Delete: `src/renderer/hooks/useGameConnection.ts`
- Delete: `src/renderer/game/config.ts`

This hook replaces the WebSocket connection hook. It:
1. On mount: gets GitHub auth via IPC, creates `GitHubAPI` and `GameOps` instances
2. Starts polling loops for presence (60s on lobby) and game state (10s during game)
3. Exposes the same action interface as the old hook (so UI components need minimal changes)

The hook should dispatch the same `GameAction` types to the existing reducer. Key differences:
- No `CONNECTION_STATUS` / `AUTHENTICATED` — GitHub auth is instant or fails
- `SET_USERNAME` is dispatched immediately from GitHub username
- Screen goes directly to `lobby` on successful auth (no `setup` screen needed for GitHub users)
- Polling loops use `setInterval`, cleaned up on unmount or screen change

The returned connection object matches the same interface as `useGameConnection` so downstream components don't need changes beyond the import.

The config constant `GITHUB_REPO` (e.g., `itsdestin/destinclaude-connect4`) should be defined at the top of this file or in a small config module. This is the repo that all game state is stored in.

- [ ] **Step 1: Implement useGitHubGame.ts**

The hook structure:
```typescript
export function useGitHubGame() {
  const dispatch = useGameDispatch();
  const state = useGameState();
  const apiRef = useRef<GitHubAPI | null>(null);
  const opsRef = useRef<GameOps | null>(null);

  // Initialize: get GitHub auth on mount
  useEffect(() => {
    (window as any).claude?.getGitHubAuth?.().then((auth) => {
      if (!auth) {
        dispatch({ type: 'GITHUB_ERROR', message: 'GitHub CLI not authenticated. Run: gh auth login' });
        return;
      }
      apiRef.current = new GitHubAPI(auth.token, GITHUB_REPO);
      opsRef.current = new GameOps(apiRef.current, auth.username);
      dispatch({ type: 'GITHUB_READY', username: auth.username });
    });
  }, [dispatch]);

  // Presence write loop (60s, always while authenticated)
  useEffect(() => { /* interval that calls opsRef.current.updatePresence() */ }, [...]);

  // Presence read loop (60s, on lobby screen)
  useEffect(() => { /* interval that calls opsRef.current.getOnlineUsers() and dispatches PRESENCE_UPDATE */ }, [...]);

  // Game state poll (10s, during opponent's turn)
  useEffect(() => { /* interval that calls opsRef.current.readGame() and dispatches GAME_STATE/GAME_OVER */ }, [...]);

  // Challenge poll (60s, on lobby screen — check for incoming challenges)
  useEffect(() => { /* interval that calls opsRef.current.getMyChallenge() and dispatches CHALLENGE_RECEIVED */ }, [...]);

  // Action functions (same interface as useGameConnection)
  const createGame = useCallback(async () => { ... dispatch ROOM_CREATED ... }, []);
  const joinGame = useCallback(async (code) => { ... dispatch GAME_START ... }, []);
  const makeMove = useCallback(async (column) => { ... dispatch GAME_STATE/GAME_OVER ... }, []);
  const sendChat = useCallback(async (text) => { ... dispatch CHAT_MESSAGE ... }, []);
  const requestRematch = useCallback(async () => { ... }, []);
  const leaveGame = useCallback(async () => { ... dispatch RETURN_TO_LOBBY ... }, []);
  const challengePlayer = useCallback(async (target) => { ... }, []);
  const respondToChallenge = useCallback(async (from, accept) => { ... dispatch GAME_START or CLEAR_CHALLENGE ... }, []);

  // register and authenticate are no-ops for GitHub (identity is automatic)
  const register = useCallback(async () => ({ ok: true }), []);
  const authenticate = useCallback(() => {}, []);

  return { register, authenticate, createGame, joinGame, makeMove, sendChat, requestRematch, leaveGame, challengePlayer, respondToChallenge };
}
```

- [ ] **Step 2: Delete old files**

```bash
rm src/renderer/hooks/useGameConnection.ts
rm src/renderer/game/config.ts
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/hooks/useGitHubGame.ts
git rm src/renderer/hooks/useGameConnection.ts src/renderer/game/config.ts
git commit -m "feat(game): replace WebSocket hook with GitHub-backed polling hook"
```

---

## Task 5: Update State Types and Reducer

**IMPORTANT:** This task MUST be completed before Task 4. The hook in Task 4 dispatches `GITHUB_READY` and `GITHUB_ERROR`, which need to exist in the types/reducer first.

**Files:**
- Modify: `src/renderer/state/game-types.ts`
- Modify: `src/renderer/state/game-reducer.ts`

Simplify the state now that GitHub auth is automatic:
- Remove `authenticated` and `authError` from state (GitHub auth is all-or-nothing — `connected` covers it)
- Replace `AUTHENTICATED` action with `GITHUB_READY` (sets username + goes to lobby) and `GITHUB_ERROR` (shows error)
- Add `githubError: string | null` to state
- `connected` = true means GitHub API is reachable (set by `GITHUB_READY`)
- `setup` screen is repurposed as a "GitHub not configured" error screen (no form)

- [ ] **Step 1: Update game-types.ts**

- Remove `authenticated` and `authError` from `GameState` interface and `createInitialGameState`
- Add `githubError: string | null` to `GameState` (init to `null`)
- Replace `AUTHENTICATED` action with:
  ```typescript
  | { type: 'GITHUB_READY'; username: string }
  | { type: 'GITHUB_ERROR'; message: string }
  ```
- Remove `SET_USERNAME` action (GITHUB_READY handles both username and screen transition)

- [ ] **Step 2: Update game-reducer.ts**

- Remove `SET_USERNAME` and `AUTHENTICATED` cases
- Add:
  ```typescript
  case 'GITHUB_READY':
    return { ...state, connected: true, username: action.username, screen: 'lobby', githubError: null };
  case 'GITHUB_ERROR':
    return { ...state, connected: false, githubError: action.message };
  ```

- [ ] **Step 3: Verify TypeScript compiles** (will have errors until Task 4 + 6 update consumers — that's expected)

- [ ] **Step 4: Commit**

```bash
git add src/renderer/state/game-types.ts src/renderer/state/game-reducer.ts
git commit -m "refactor(game): simplify state types for GitHub auth model"
```

---

## Task 6: Update UI Components

**Files:**
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/components/game/GamePanel.tsx`
- Modify: `src/renderer/components/game/GameLobby.tsx`
- Modify: `src/renderer/components/game/ConnectFourBoard.tsx`
- Modify: `src/renderer/components/game/GameChat.tsx`
- Modify: `src/renderer/components/game/GameOverlay.tsx`

### App.tsx
- Replace `import { useGameConnection }` with `import { useGitHubGame }`
- Change `useGameConnection()` call to `useGitHubGame()`
- `gameConnected` prop in HeaderBar still works (reads `gameState.connected`)

### GamePanel.tsx
- Update connection interface type to match new hook return type (register returns `Promise<{ ok: boolean }>`, authenticate is a no-op)

### GameLobby.tsx
- **Remove the SetupScreen** entirely (no registration needed — GitHub username is automatic)
- Replace setup screen with a simple error screen shown when `state.githubError` is set:
  ```tsx
  function ErrorScreen() {
    const state = useGameState();
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 px-4 py-8">
        <p className="text-sm text-red-400">{state.githubError}</p>
        <p className="text-xs text-gray-500">Make sure GitHub CLI is installed and authenticated: gh auth login</p>
      </div>
    );
  }
  ```
- Update the screen routing: `setup` renders `ErrorScreen`, `lobby` renders `LobbyScreen`, `waiting` renders `WaitingScreen`
- Remove the LEADERBOARD_URL import (leaderboard now comes from GameOps, piped through state)
- Lobby screen fetches leaderboard via connection object instead of direct fetch

### ConnectFourBoard.tsx, GameChat.tsx, GameOverlay.tsx
- Update connection interface type (same shape, different import)

- [ ] **Step 1: Update App.tsx** — swap hook import

- [ ] **Step 2: Update GamePanel.tsx** — update connection type

- [ ] **Step 3: Update GameLobby.tsx** — remove SetupScreen, add ErrorScreen, remove LEADERBOARD_URL import

- [ ] **Step 4: Update ConnectFourBoard.tsx, GameChat.tsx, GameOverlay.tsx** — update connection types

- [ ] **Step 5: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add src/renderer/App.tsx src/renderer/components/game/*.tsx
git commit -m "refactor(game): update UI components for GitHub backend"
```

---

## Task 7: Delete Server Infrastructure

**Files:**
- Delete: `server/` directory
- Delete: `src/main/game-servers.ts`
- Modify: `package.json` — remove `dev:leaderboard`, `dev:relay`, `dev:all` scripts
- Modify: `.gitignore` — remove `server/leaderboard/data/`
- Delete: `server/.env.example`

- [ ] **Step 1: Remove server directory and related files**

```bash
rm -rf server/
rm src/main/game-servers.ts
```

- [ ] **Step 2: Update package.json** — remove server-related scripts

- [ ] **Step 3: Update .gitignore** — remove `server/leaderboard/data/`

- [ ] **Step 4: Commit**

```bash
git rm -r server/
git rm src/main/game-servers.ts
git add package.json .gitignore
git commit -m "chore: remove WebSocket/leaderboard servers (replaced by GitHub backend)"
```

---

## Task 8: Create the GitHub Repo

**Files:** None (repo setup via `gh` CLI)

- [ ] **Step 1: Create the repo**

```bash
gh repo create destinclaude-connect4 --public --description "Connect 4 multiplayer game state for destinclaude users"
```

- [ ] **Step 2: Initialize with empty state files**

```bash
cd /tmp && mkdir connect4-init && cd connect4-init
git init
echo '{}' > presence.json
echo '{}' > leaderboard.json
mkdir games challenges
echo '# destinclaude Connect 4\n\nMultiplayer game state repo. Do not edit manually.' > README.md
git add -A && git commit -m "init: empty game state"
git remote add origin https://github.com/itsdestin/destinclaude-connect4.git
git push -u origin main
```

- [ ] **Step 3: Update GITHUB_REPO constant in useGitHubGame.ts** to `itsdestin/destinclaude-connect4`

- [ ] **Step 4: Commit**

```bash
git add src/renderer/hooks/useGitHubGame.ts
git commit -m "chore: point game to live destinclaude-connect4 repo"
```

---

## Task 9: End-to-End Test

- [ ] **Step 1: Build and run the app**

```bash
npm run dev
```

- [ ] **Step 2: Verify GitHub auth works** — game panel should go straight to lobby showing your GitHub username

- [ ] **Step 3: Create a game** — verify game file appears in the GitHub repo

- [ ] **Step 4: Open test-player.html** — update it to use GitHub API instead of WebSocket, or manually join via the repo

- [ ] **Step 5: Play a game** — verify moves sync via polling, chat works, game over records to leaderboard

- [ ] **Step 6: Verify presence** — check that online users list shows players who are active
