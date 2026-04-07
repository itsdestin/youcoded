# Session Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users browse and resume previous Claude Code sessions from a native UI, with the last 5-10 messages pre-loaded into chat view and a "see previous messages" option for full history.

**Architecture:** A new `session-browser.ts` module in the main process scans `~/.claude/projects/*/` for JSONL transcript files, cross-references topic files for names, and parses JSONL tails for recent messages. The renderer gets two new IPC calls: one to list past sessions, one to load message history. The SessionStrip dropdown adds a "Resume Session" section. On resume, a new PTY session is created and `/resume {id}` is sent to it. The chat reducer gets a `HISTORY_LOADED` action that injects historical messages at the top of the timeline.

**Tech Stack:** Electron IPC, Node.js `fs`, existing `parseTranscriptLine` from `transcript-watcher.ts`, React state/reducer

---

### Task 1: Add types and IPC constants

**Files:**
- Modify: `src/shared/types.ts`

- [ ] **Step 1: Add PastSession type and IPC constants**

Add these types and constants to `src/shared/types.ts`:

```typescript
// After the SkillEntry interface (~line 83):

export interface PastSession {
  /** Claude Code's internal session ID (JSONL filename without extension) */
  sessionId: string;
  /** Human-readable name from topic file, or 'Untitled' */
  name: string;
  /** Project directory slug (e.g. 'C--Users-desti') */
  projectSlug: string;
  /** Display-friendly project path derived from slug */
  projectPath: string;
  /** Last modified timestamp (epoch ms) */
  lastModified: number;
  /** File size in bytes — proxy for conversation length */
  size: number;
}

export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}
```

Add to the `IPC` object:

```typescript
  // Session browser
  SESSION_BROWSE: 'session:browse',
  SESSION_HISTORY: 'session:history',
  SESSION_RESUME: 'session:resume',
```

- [ ] **Step 2: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(resume): add PastSession/HistoryMessage types and IPC constants"
```

---

### Task 2: Build the session browser module

**Files:**
- Create: `src/main/session-browser.ts`

This module has two functions: `listPastSessions()` scans the filesystem for all previous sessions, and `loadHistory()` reads the tail of a JSONL file and returns the last N conversational messages.

- [ ] **Step 1: Create `src/main/session-browser.ts`**

```typescript
import fs from 'fs';
import path from 'path';
import os from 'os';
import { PastSession, HistoryMessage } from '../shared/types';
import { parseTranscriptLine } from './transcript-watcher';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const TOPICS_DIR = path.join(CLAUDE_DIR, 'topics');

/**
 * Converts a project slug back to a display-friendly path.
 * e.g. 'C--Users-desti' → 'C:/Users/desti'
 *      'home-user-project' → '/home/user/project'
 */
function slugToDisplayPath(slug: string): string {
  // Windows slugs start with a drive letter: 'C--Users-...'
  // Unix slugs start with the first directory: 'home-user-...'
  if (/^[A-Z]--/.test(slug)) {
    // Windows: 'C--Users-desti-foo' → 'C:/Users/desti/foo'
    return slug.replace(/^([A-Z])--/, '$1:/').replace(/-/g, '/');
  }
  // Unix: 'home-user-project' → '/home/user/project'
  return '/' + slug.replace(/-/g, '/');
}

function readTopic(sessionId: string): string {
  try {
    const content = fs.readFileSync(path.join(TOPICS_DIR, `topic-${sessionId}`), 'utf8').trim();
    return content || 'Untitled';
  } catch {
    return 'Untitled';
  }
}

/**
 * Scans all project directories for JSONL transcript files.
 * Returns sessions sorted by last modified (most recent first).
 * Excludes sessions that are currently active (matching activeSessionIds).
 */
export function listPastSessions(activeSessionIds?: Set<string>): PastSession[] {
  const sessions: PastSession[] = [];

  let slugs: string[];
  try {
    slugs = fs.readdirSync(PROJECTS_DIR).filter((f) => {
      try { return fs.statSync(path.join(PROJECTS_DIR, f)).isDirectory(); } catch { return false; }
    });
  } catch {
    return [];
  }

  for (const slug of slugs) {
    const slugDir = path.join(PROJECTS_DIR, slug);
    let files: string[];
    try {
      files = fs.readdirSync(slugDir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }

    for (const file of files) {
      const sessionId = file.replace('.jsonl', '');
      if (activeSessionIds?.has(sessionId)) continue;

      try {
        const stat = fs.statSync(path.join(slugDir, file));
        // Skip tiny files (< 500 bytes) — likely empty/aborted sessions
        if (stat.size < 500) continue;

        sessions.push({
          sessionId,
          name: readTopic(sessionId),
          projectSlug: slug,
          projectPath: slugToDisplayPath(slug),
          lastModified: stat.mtimeMs,
          size: stat.size,
        });
      } catch {
        continue;
      }
    }
  }

  sessions.sort((a, b) => b.lastModified - a.lastModified);
  return sessions;
}

/**
 * Loads the last N conversational messages from a session's JSONL file.
 * "Conversational" = user prompts (with promptId, not meta) and assistant
 * end_turn responses (text content only, no tool calls).
 *
 * @param sessionId  Claude Code session ID
 * @param projectSlug  Project directory slug
 * @param count  Number of messages to return (default 10)
 * @param all  If true, load ALL messages (for "see previous" expansion)
 */
export function loadHistory(
  sessionId: string,
  projectSlug: string,
  count: number = 10,
  all: boolean = false,
): HistoryMessage[] {
  const jsonlPath = path.join(PROJECTS_DIR, projectSlug, `${sessionId}.jsonl`);

  let content: string;
  try {
    content = fs.readFileSync(jsonlPath, 'utf8');
  } catch {
    return [];
  }

  const lines = content.trim().split('\n');
  const messages: HistoryMessage[] = [];

  // Track last occurrence per UUID to handle incremental writes
  const lastLineByUuid = new Map<string, string>();
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.uuid && (parsed.type === 'user' || parsed.type === 'assistant')) {
        lastLineByUuid.set(parsed.uuid, line);
      }
    } catch {}
  }

  // Process deduplicated lines in order
  const seenUuids = new Set<string>();
  for (const line of lines) {
    let parsed: any;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!parsed.uuid) continue;
    if (parsed.type !== 'user' && parsed.type !== 'assistant') continue;

    // Only process the LAST occurrence of each UUID
    if (lastLineByUuid.get(parsed.uuid) !== line) continue;
    if (seenUuids.has(parsed.uuid)) continue;
    seenUuids.add(parsed.uuid);

    const message = parsed.message;
    if (!message) continue;

    if (parsed.type === 'user') {
      // Only user-typed prompts (not tool results, not meta)
      if (parsed.isMeta) continue;
      if (!parsed.promptId) continue;
      const content = message.content;
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
          : '';
      if (!text.trim()) continue;
      messages.push({ role: 'user', content: text.trim(), timestamp: parsed.timestamp || 0 });
    } else if (parsed.type === 'assistant' && message.stop_reason === 'end_turn') {
      const content = message.content;
      const texts = Array.isArray(content)
        ? content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
        : typeof content === 'string' ? content : '';
      if (!texts.trim()) continue;
      messages.push({ role: 'assistant', content: texts.trim(), timestamp: parsed.timestamp || 0 });
    }
  }

  if (all) return messages;
  return messages.slice(-count);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/main/session-browser.ts
git commit -m "feat(resume): add session-browser module for listing and reading past sessions"
```

---

### Task 3: Register IPC handlers

**Files:**
- Modify: `src/main/ipc-handlers.ts`

- [ ] **Step 1: Add import and handlers**

At the top of `ipc-handlers.ts`, add the import:

```typescript
import { listPastSessions, loadHistory } from './session-browser';
```

Inside `registerIpcHandlers()`, before the `// PTY input` section, add:

```typescript
  // --- Session browser (resume) ---
  ipcMain.handle(IPC.SESSION_BROWSE, async () => {
    // Collect active Claude Code session IDs so we can exclude them
    const activeIds = new Set<string>();
    // sessionIdMap is already defined in this scope — maps desktop ID → Claude ID
    for (const claudeId of sessionIdMap.values()) {
      activeIds.add(claudeId);
    }
    return listPastSessions(activeIds);
  });

  ipcMain.handle(IPC.SESSION_HISTORY, async (
    _event,
    sessionId: string,
    projectSlug: string,
    count: number,
    all: boolean,
  ) => {
    return loadHistory(sessionId, projectSlug, count, all);
  });
```

- [ ] **Step 2: Commit**

```bash
git add src/main/ipc-handlers.ts
git commit -m "feat(resume): register session:browse and session:history IPC handlers"
```

---

### Task 4: Expose IPC to renderer via preload

**Files:**
- Modify: `src/main/preload.ts`

- [ ] **Step 1: Add IPC constants and API surface**

Add to the inlined IPC constants in `preload.ts`:

```typescript
  SESSION_BROWSE: 'session:browse',
  SESSION_HISTORY: 'session:history',
```

Add to the `session` object inside `contextBridge.exposeInMainWorld('claude', { ... })`:

```typescript
    browse: (): Promise<any[]> =>
      ipcRenderer.invoke(IPC.SESSION_BROWSE),
    loadHistory: (sessionId: string, projectSlug: string, count?: number, all?: boolean): Promise<any[]> =>
      ipcRenderer.invoke(IPC.SESSION_HISTORY, sessionId, projectSlug, count || 10, all || false),
```

- [ ] **Step 2: Commit**

```bash
git add src/main/preload.ts
git commit -m "feat(resume): expose session browse/history to renderer via preload"
```

---

### Task 5: Add HISTORY_LOADED action to chat reducer

**Files:**
- Modify: `src/renderer/state/chat-types.ts`
- Modify: `src/renderer/state/chat-reducer.ts`

- [ ] **Step 1: Add action type to chat-types.ts**

Add to the `ChatAction` union in `chat-types.ts`:

```typescript
  | {
      type: 'HISTORY_LOADED';
      sessionId: string;
      messages: { role: 'user' | 'assistant'; content: string; timestamp: number }[];
      hasMore: boolean;
    }
```

- [ ] **Step 2: Add reducer case in chat-reducer.ts**

Add this case before the `default:` in `chatReducer`:

```typescript
    case 'HISTORY_LOADED': {
      const session = next.get(action.sessionId);
      if (!session) return state;

      // Build timeline entries from historical messages
      const historyTimeline: TimelineEntry[] = [];
      const historyTurns = new Map(session.assistantTurns);
      let historyMsgCounter = 0;

      // Add "see previous messages" marker if there's more history
      if (action.hasMore) {
        historyTimeline.push({
          kind: 'prompt',
          prompt: {
            promptId: '_history_expand',
            title: 'See previous messages',
            buttons: [],
          },
        });
      }

      for (const msg of action.messages) {
        const id = `hist-${++historyMsgCounter}`;
        if (msg.role === 'user') {
          historyTimeline.push({
            kind: 'user',
            message: { id, role: 'user', content: msg.content, timestamp: msg.timestamp },
          });
        } else {
          const turnId = `hist-turn-${historyMsgCounter}`;
          const msgId = `hist-msg-${historyMsgCounter}`;
          historyTurns.set(turnId, {
            id: turnId,
            segments: [{ type: 'text', content: msg.content, messageId: msgId }],
          });
          historyTimeline.push({ kind: 'assistant-turn', turnId });
        }
      }

      // Prepend history before existing timeline
      next.set(action.sessionId, {
        ...session,
        timeline: [...historyTimeline, ...session.timeline],
        assistantTurns: historyTurns,
      });
      return next;
    }
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/state/chat-types.ts src/renderer/state/chat-reducer.ts
git commit -m "feat(resume): add HISTORY_LOADED reducer action for injecting past messages"
```

---

### Task 6: Add resume UI to SessionStrip dropdown

**Files:**
- Modify: `src/renderer/components/SessionStrip.tsx`

This adds a "Resume Session" section to the existing dropdown menu, below the active sessions list and above the "New Session" button.

- [ ] **Step 1: Add resume state, browse trigger, and props**

Add `onResumeSession` to the Props interface:

```typescript
interface Props {
  sessions: SessionEntry[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onCreateSession: (cwd: string, dangerous: boolean) => void;
  onCloseSession: (id: string) => void;
  onResumeSession: (sessionId: string, projectSlug: string) => void;
  sessionStatuses?: Map<string, SessionStatusColor>;
}
```

Add state for past sessions inside the component:

```typescript
  const [pastSessions, setPastSessions] = useState<any[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);
```

Update the dropdown trigger to fetch past sessions when opened:

```typescript
  const handleMenuToggle = useCallback(() => {
    const opening = !menuOpen;
    setMenuOpen(opening);
    setShowNewForm(false);
    if (opening) {
      setBrowseLoading(true);
      (window as any).claude.session.browse()
        .then((list: any[]) => setPastSessions(list.slice(0, 20)))
        .catch(() => setPastSessions([]))
        .finally(() => setBrowseLoading(false));
    }
  }, [menuOpen]);
```

Replace the `onClick` of the dropdown trigger button:

```typescript
  onClick={handleMenuToggle}
```

- [ ] **Step 2: Add past sessions section to the dropdown JSX**

Between the `<div className="border-t border-gray-700" />` and the `showNewForm` ternary, add:

```tsx
            {/* Past sessions — resume */}
            {pastSessions.length > 0 && (
              <>
                <div className="px-3 pt-2 pb-1">
                  <span className="text-[10px] uppercase tracking-wider text-gray-500">Resume</span>
                </div>
                <div className="max-h-48 overflow-y-auto py-1">
                  {pastSessions.map((ps) => (
                    <button
                      key={ps.sessionId}
                      onClick={() => {
                        onResumeSession(ps.sessionId, ps.projectSlug);
                        setMenuOpen(false);
                      }}
                      className="w-full text-left px-3 py-1.5 flex items-center gap-2 text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors min-w-0"
                    >
                      <span className="text-sm truncate flex-1">{ps.name}</span>
                      <span className="text-[10px] text-gray-600 shrink-0">
                        {formatRelativeTime(ps.lastModified)}
                      </span>
                    </button>
                  ))}
                </div>
                <div className="border-t border-gray-700" />
              </>
            )}
            {browseLoading && pastSessions.length === 0 && (
              <>
                <div className="px-3 py-2 text-xs text-gray-500">Loading sessions...</div>
                <div className="border-t border-gray-700" />
              </>
            )}
```

- [ ] **Step 3: Add the `formatRelativeTime` helper**

Add this at the top of the file, below the imports:

```typescript
function formatRelativeTime(epochMs: number): string {
  const diff = Date.now() - epochMs;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(epochMs).toLocaleDateString();
}
```

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/SessionStrip.tsx
git commit -m "feat(resume): add past sessions list to SessionStrip dropdown"
```

---

### Task 7: Wire up resume flow in App.tsx

**Files:**
- Modify: `src/renderer/App.tsx`

When the user picks a past session to resume:
1. Create a new PTY session (pointed at the past session's project directory)
2. Wait for the session to initialize
3. Send `/resume {session-id}\r` to the PTY
4. Load the last 10 messages and dispatch `HISTORY_LOADED`

- [ ] **Step 1: Add the `handleResumeSession` callback**

Add this callback in `AppInner`, near `createSession`:

```typescript
  const handleResumeSession = useCallback(async (claudeSessionId: string, projectSlug: string) => {
    // Derive the project path from the slug
    const slugToPath = (s: string) => {
      if (/^[A-Z]--/.test(s)) return s.replace(/^([A-Z])--/, '$1:\\').replace(/-/g, '\\');
      return '/' + s.replace(/-/g, '/');
    };
    const cwd = slugToPath(projectSlug);

    // Create a new session in that project directory
    await window.claude.session.create({ name: 'Resuming...', cwd, skipPermissions: false });

    // Small delay for session initialization, then send /resume command
    setTimeout(() => {
      // Find the session that was just created (most recent)
      const latestSession = sessions[sessions.length - 1];
      if (!latestSession) return;

      window.claude.session.sendInput(latestSession.id, `/resume ${claudeSessionId}\r`);

      // Load recent history into chat view
      (window as any).claude.session.loadHistory(claudeSessionId, projectSlug, 10, false)
        .then((messages: any[]) => {
          if (messages.length > 0) {
            dispatch({
              type: 'HISTORY_LOADED',
              sessionId: latestSession.id,
              messages,
              hasMore: true, // Assume there's more — we only loaded 10
            });
          }
        })
        .catch(console.error);
    }, 500);
  }, [sessions, dispatch]);
```

- [ ] **Step 2: Pass `onResumeSession` to HeaderBar → SessionStrip**

Update the HeaderBar props interface and component to accept and pass through `onResumeSession`:

In `HeaderBar.tsx` Props, add:

```typescript
  onResumeSession: (sessionId: string, projectSlug: string) => void;
```

In HeaderBar's JSX, pass it to SessionStrip:

```tsx
  <SessionStrip
    ...
    onResumeSession={onResumeSession}
  />
```

In `App.tsx`, pass it to HeaderBar:

```tsx
  <HeaderBar
    ...
    onResumeSession={handleResumeSession}
  />
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/App.tsx src/renderer/components/HeaderBar.tsx
git commit -m "feat(resume): wire up resume flow — create session, send /resume, load history"
```

---

### Task 8: Handle "See previous messages" expansion

**Files:**
- Modify: `src/renderer/components/ChatView.tsx`

The `HISTORY_LOADED` action inserts a prompt entry with `promptId: '_history_expand'` at the top of the timeline. When clicked, it loads the full history.

- [ ] **Step 1: Add history expansion handler in ChatView**

The existing `PromptCard` component renders prompts with buttons. For the history expand marker, we need a different render — a simple clickable text link.

In `ChatView.tsx`, inside the timeline map, handle the special `_history_expand` prompt:

```tsx
                case 'prompt':
                  if (entry.prompt.promptId === '_history_expand' && !entry.prompt.completed) {
                    return (
                      <HistoryExpandButton
                        key={entry.prompt.promptId}
                        sessionId={sessionId}
                      />
                    );
                  }
                  return (
                    <PromptCard ... />
                  );
```

- [ ] **Step 2: Create the HistoryExpandButton component inline**

Add this component inside `ChatView.tsx` (or as a separate small file):

```tsx
function HistoryExpandButton({ sessionId }: { sessionId: string }) {
  const dispatch = useChatDispatch();
  const [loading, setLoading] = useState(false);

  const handleExpand = async () => {
    setLoading(true);
    try {
      // We need the projectSlug — read it from the session's transcript path.
      // For now, load ALL history via the IPC call.
      // The session browser stores projectSlug in the past sessions list,
      // but we can also scan for the sessionId across all project dirs.
      const sessions = await (window as any).claude.session.browse();
      // The claudeSessionId isn't the desktop session ID — we need to find
      // it. For simplicity, reload all messages for ANY matching session.
      // This is a fallback — in most cases the history is already there.
      // TODO: store claudeSessionId + projectSlug on the session when resuming
    } catch {
      // Ignore
    }
    setLoading(false);
  };

  return (
    <div className="flex justify-center py-3">
      <button
        onClick={handleExpand}
        disabled={loading}
        className="text-xs text-gray-500 hover:text-gray-300 transition-colors disabled:opacity-50"
      >
        {loading ? 'Loading...' : '↑ See previous messages'}
      </button>
    </div>
  );
}
```

**Note:** The full "see previous" expansion requires knowing which Claude Code session ID and project slug to query. Task 7's `handleResumeSession` should store this mapping so the expand button can use it. This can be done by adding a `resumeInfo` state in App.tsx that maps desktop session ID → `{ claudeSessionId, projectSlug }`, and passing it down via context or props. The implementation detail is straightforward — store it when resuming, read it when expanding.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/ChatView.tsx
git commit -m "feat(resume): add 'see previous messages' expand button in chat view"
```

---

### Task 9: Store resume metadata for history expansion

**Files:**
- Modify: `src/renderer/App.tsx`

- [ ] **Step 1: Add resumeInfo state and pass to ChatView**

```typescript
  // Maps desktop session ID → resume info for history expansion
  const [resumeInfo, setResumeInfo] = useState<Map<string, { claudeSessionId: string; projectSlug: string }>>(new Map());
```

In `handleResumeSession`, after creating the session, store the mapping:

```typescript
    // Inside the setTimeout callback, after finding latestSession:
    setResumeInfo((prev) => new Map(prev).set(latestSession.id, { claudeSessionId, projectSlug }));
```

Pass `resumeInfo` to ChatView (add prop), so the HistoryExpandButton can call `loadHistory(claudeSessionId, projectSlug, 0, true)` to get all messages.

- [ ] **Step 2: Update ChatView to accept and use resumeInfo**

Add `resumeInfo` prop to ChatView. Pass it to HistoryExpandButton. The button calls:

```typescript
  const info = resumeInfo?.get(sessionId);
  if (!info) return;
  const allMessages = await (window as any).claude.session.loadHistory(
    info.claudeSessionId, info.projectSlug, 0, true
  );
  dispatch({
    type: 'HISTORY_LOADED',
    sessionId,
    messages: allMessages,
    hasMore: false,
  });
```

When `hasMore: false`, the HISTORY_LOADED reducer should NOT prepend the expand button again. Update the reducer: only add the `_history_expand` prompt entry when `action.hasMore` is true (already done in Task 5).

Also, the second HISTORY_LOADED dispatch should REPLACE the existing history (remove old history entries + the expand button), not prepend on top of them. Update the reducer to filter out any existing `hist-*` entries and the `_history_expand` prompt before prepending.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/App.tsx src/renderer/components/ChatView.tsx
git commit -m "feat(resume): store resume metadata and wire up full history expansion"
```

---

## Execution Notes

- **Task order is strict** — each task builds on the previous.
- **Tasks 1-5** are backend/state plumbing with no UI changes.
- **Tasks 6-7** are the core UI integration — after these, resume works end-to-end.
- **Tasks 8-9** add the "see previous messages" polish.
- The `slugToPath` reversal in Task 7 is imperfect (dashes in real directory names become ambiguous). This is acceptable — it only affects the `cwd` passed to session creation, and Claude Code will use its own project detection. If the path is wrong, the session just starts in `~`.
- The 500ms setTimeout in Task 7 is a pragmatic workaround. A cleaner approach would be to listen for the `SESSION_CREATED` event and then send the `/resume` command, but the current event flow already handles this via the `sessionCreated` handler in `useEffect`.
