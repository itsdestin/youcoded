# Model Selector Chip — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a cycling model selector chip to the StatusBar on both Android and Desktop apps, with optimistic mid-session switching verified against the transcript JSONL.

**Architecture:** The chip lives in the StatusBar React component (shared pattern, separate codebases). On tap it cycles Sonnet → Opus → Haiku. At session launch, the selected model is passed via `--model` CLI flag. Mid-session, `/model <name>\r` is sent through the PTY. Verification reads the `message.model` field from the next assistant entry in the session's transcript JSONL file.

**Tech Stack:** Kotlin (Android), TypeScript/React (Desktop), compiled JS (Android web UI)

**Spec:** `docs/specs/model-selector-design (04-03-2026).md`

---

## File Map

### Desktop (`youcoded-core/desktop`)

| File | Action | Responsibility |
|------|--------|---------------|
| `src/shared/types.ts` | Modify | Add `model` to `CreateSessionOpts` |
| `src/main/session-manager.ts` | Modify | Pass `--model` flag in args array |
| `src/main/ipc-handlers.ts` | Modify | Add model to `buildStatusData()`, add `model:read-transcript` IPC handler |
| `src/main/preload.ts` | Modify | Expose `model:read-transcript` IPC channel, add `modelSwitch` to `session` API |
| `src/renderer/components/StatusBar.tsx` | Modify | Add model cycling chip |
| `src/renderer/components/App.tsx` | Modify | Wire model state, verification logic, persistence |

### Android (`youcoded`)

| File | Action | Responsibility |
|------|--------|---------------|
| `app/src/main/kotlin/com/destin/code/runtime/PtyBridge.kt` | Modify | Accept `model` param, append `--model` to launch command |
| `app/src/main/kotlin/com/destin/code/runtime/SessionRegistry.kt` | Modify | Pass model to PtyBridge constructor |
| `app/src/main/kotlin/com/destin/code/runtime/SessionService.kt` | Modify | Handle `model:switch` and `model:get-preference` bridge messages |
| `app/src/main/assets/web/components/StatusBar.js` | Modify | Add model cycling chip |
| `app/src/main/assets/web/App.js` | Modify | Wire model state, send `model:switch` messages |
| `app/src/main/assets/web/remote-shim.js` | Modify | Add `model:switch`, `model:get-preference` message types |

---

## Part 1: Desktop App (`youcoded-core/desktop`)

### Task 1: Add `--model` flag to session launch

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/main/session-manager.ts`

- [ ] **Step 1: Add `model` to `CreateSessionOpts`**

In `src/shared/types.ts`, find the `CreateSessionOpts` interface (it's in `session-manager.ts` actually — check both). Add the optional `model` field:

```typescript
// In src/main/session-manager.ts, CreateSessionOpts interface:
export interface CreateSessionOpts {
  name: string;
  cwd: string;
  skipPermissions: boolean;
  cols?: number;
  rows?: number;
  resumeSessionId?: string;
  model?: string;  // Add this line
}
```

- [ ] **Step 2: Pass `--model` in the args array**

In `src/main/session-manager.ts`, in the `createSession()` method, after the existing `resumeSessionId` args block (around line 47), add:

```typescript
if (opts.model) {
  args.push('--model', opts.model);
}
```

This goes right after:
```typescript
if (opts.resumeSessionId) {
  args.push('--resume', opts.resumeSessionId);
}
```

- [ ] **Step 3: Verify build compiles**

Run: `cd youcoded-core/desktop && npx tsc --noEmit`
Expected: No new errors

- [ ] **Step 4: Commit**

```bash
git add src/shared/types.ts src/main/session-manager.ts
git commit -m "feat(session): pass --model flag to Claude Code on session launch"
```

---

### Task 2: Model preference persistence (Desktop)

**Files:**
- Modify: `src/main/ipc-handlers.ts`
- Modify: `src/main/preload.ts`

The desktop stores the user's preferred model in a JSON file at `~/.claude/youcoded-model.json`. Format: `{ "model": "sonnet" }`.

- [ ] **Step 1: Add model preference read/write to ipc-handlers.ts**

At the top of the `registerIpcHandlers` function, after the existing file path constants (around line 13), add:

```typescript
const modelPrefPath = path.join(os.homedir(), '.claude', 'youcoded-model.json');
```

Then add two IPC handlers after the existing session handlers:

```typescript
ipcMain.handle('model:get-preference', async () => {
  try {
    const raw = fs.readFileSync(modelPrefPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed.model || 'sonnet';
  } catch {
    return 'sonnet';
  }
});

ipcMain.handle('model:set-preference', async (_event, model: string) => {
  try {
    fs.mkdirSync(path.dirname(modelPrefPath), { recursive: true });
    fs.writeFileSync(modelPrefPath, JSON.stringify({ model }));
    return true;
  } catch {
    return false;
  }
});
```

- [ ] **Step 2: Expose in preload.ts**

In `src/main/preload.ts`, add the IPC channel constants alongside the existing ones:

```typescript
MODEL_GET_PREFERENCE: 'model:get-preference',
MODEL_SET_PREFERENCE: 'model:set-preference',
```

In the `contextBridge.exposeInMainWorld('claude', ...)` block, add to the `session` object (or create a `model` namespace):

```typescript
model: {
  getPreference: (): Promise<string> => ipcRenderer.invoke('model:get-preference'),
  setPreference: (model: string): Promise<boolean> => ipcRenderer.invoke('model:set-preference', model),
},
```

- [ ] **Step 3: Verify build compiles**

Run: `cd youcoded-core/desktop && npx tsc --noEmit`
Expected: No new errors

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc-handlers.ts src/main/preload.ts
git commit -m "feat(model): add model preference persistence via IPC"
```

---

### Task 3: Transcript model verification (Desktop)

**Files:**
- Modify: `src/main/ipc-handlers.ts`
- Modify: `src/main/preload.ts`

We already have `transcript-utils.ts` that reads `message.model` from transcript files. We'll add an IPC handler that reads the last model from the active session's transcript.

- [ ] **Step 1: Add transcript model reader IPC**

In `src/main/ipc-handlers.ts`, add a handler that reads the last assistant model from a transcript:

```typescript
ipcMain.handle('model:read-last', async (_event, transcriptPath: string) => {
  try {
    const content = fs.readFileSync(transcriptPath, 'utf-8');
    const lines = content.trim().split('\n');
    // Read from end, find last assistant message with model
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === 'assistant' && entry.message?.model) {
          return entry.message.model;
        }
      } catch { continue; }
    }
    return null;
  } catch {
    return null;
  }
});
```

- [ ] **Step 2: Expose in preload.ts**

Add to the IPC constants:

```typescript
MODEL_READ_LAST: 'model:read-last',
```

Add to the exposed API:

```typescript
// Inside the model namespace from Task 2:
readLastModel: (transcriptPath: string): Promise<string | null> =>
  ipcRenderer.invoke('model:read-last', transcriptPath),
```

- [ ] **Step 3: Verify build compiles**

Run: `cd youcoded-core/desktop && npx tsc --noEmit`
Expected: No new errors

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc-handlers.ts src/main/preload.ts
git commit -m "feat(model): add transcript model verification IPC"
```

---

### Task 4: Model cycling chip in StatusBar (Desktop)

**Files:**
- Modify: `src/renderer/components/StatusBar.tsx`

- [ ] **Step 1: Add model constants and chip component**

At the top of `StatusBar.tsx`, after the existing imports and before the `utilizationColor` function, add:

```typescript
const MODELS = ['sonnet', 'opus', 'haiku'] as const;
type ModelAlias = typeof MODELS[number];

const MODEL_DISPLAY: Record<ModelAlias, { label: string; color: string; bg: string; border: string }> = {
  sonnet: { label: 'Sonnet', color: '#9CA3AF', bg: 'rgba(156,163,175,0.15)', border: 'rgba(156,163,175,0.25)' },
  opus:   { label: 'Opus',   color: '#818CF8', bg: 'rgba(129,140,248,0.15)', border: 'rgba(129,140,248,0.25)' },
  haiku:  { label: 'Haiku',  color: '#2DD4BF', bg: 'rgba(45,212,191,0.15)',  border: 'rgba(45,212,191,0.25)' },
};

function nextModel(current: ModelAlias): ModelAlias {
  const idx = MODELS.indexOf(current);
  return MODELS[(idx + 1) % MODELS.length];
}
```

- [ ] **Step 2: Add model props to StatusBar**

Update the `Props` interface:

```typescript
interface Props {
  statusData: StatusData;
  onRunSync?: () => void;
  model: ModelAlias;
  onCycleModel: () => void;
}
```

Update the function signature:

```typescript
export default function StatusBar({ statusData, onRunSync, model, onCycleModel }: Props) {
```

- [ ] **Step 3: Add the chip to the JSX**

After the context percent pill and before the sync warnings, add:

```tsx
{/* Model selector chip */}
<button
  onClick={onCycleModel}
  className="px-1.5 py-0.5 rounded border cursor-pointer hover:brightness-125 transition-colors"
  style={{
    backgroundColor: MODEL_DISPLAY[model].bg,
    color: MODEL_DISPLAY[model].color,
    borderColor: MODEL_DISPLAY[model].border,
  }}
  title={`Model: ${MODEL_DISPLAY[model].label} (click to cycle)`}
>
  {MODEL_DISPLAY[model].label}
</button>
```

- [ ] **Step 4: Verify build compiles**

Run: `cd youcoded-core/desktop && npx tsc --noEmit`
Expected: No new errors (App.tsx will need updating in the next task to pass the new props, but StatusBar itself should compile)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/StatusBar.tsx
git commit -m "feat(ui): add model cycling chip to StatusBar"
```

---

### Task 5: Wire model state in App (Desktop)

**Files:**
- Modify: `src/renderer/components/App.tsx` (or wherever StatusBar is rendered — verify the actual file)

This task wires everything together: loads the persisted preference, passes model to session creation, handles cycling (optimistic update + PTY command), and runs deferred transcript verification.

- [ ] **Step 1: Find where StatusBar is rendered**

Check the import/render of StatusBar in the desktop's main App component. It may be in `App.tsx` or a layout wrapper. Read the file to find the exact location and how `statusData` is currently passed.

- [ ] **Step 2: Add model state**

Near the top of the component, add:

```typescript
const [model, setModel] = useState<'sonnet' | 'opus' | 'haiku'>('sonnet');
const [pendingModel, setPendingModel] = useState<string | null>(null);
const consecutiveFailures = useRef(0);
```

- [ ] **Step 3: Load persisted preference on mount**

```typescript
useEffect(() => {
  window.claude.model.getPreference().then((m: string) => {
    if (['sonnet', 'opus', 'haiku'].includes(m)) {
      setModel(m as 'sonnet' | 'opus' | 'haiku');
    }
  });
}, []);
```

- [ ] **Step 4: Add cycle handler**

```typescript
const cycleModel = useCallback(() => {
  const MODELS = ['sonnet', 'opus', 'haiku'] as const;
  const idx = MODELS.indexOf(model);
  const next = MODELS[(idx + 1) % MODELS.length];
  setModel(next);
  setPendingModel(next);

  // Send /model command to the active session's PTY
  if (sessionId) {
    window.claude.session.sendInput(sessionId, `/model ${next}\r`);
  }
}, [model, sessionId]);
```

- [ ] **Step 5: Add transcript verification**

After the model state, add a verification effect that runs when transcript events arrive. The key insight: we already listen for `transcript:event` in the app. When a `TurnComplete` event fires, check the transcript for the actual model used:

```typescript
useEffect(() => {
  if (!pendingModel) return;

  const handler = window.claude.on.transcriptEvent?.((event: any) => {
    if (event.type !== 'turn_complete') return;
    if (!event.sessionId || event.sessionId !== sessionId) return;

    // Read the transcript to verify the model
    // The transcriptPath is available from the session's transcript watcher
    // For now, we check via the readLastModel IPC
    const projectsDir = `${process.env.HOME || ''}/.claude/projects`;
    // We need the Claude session ID, not the desktop session ID
    // This is available from hook events — for simplicity, defer to the
    // statusData.model field once we wire it in buildStatusData()
  });

  return () => { /* cleanup */ };
}, [pendingModel, sessionId]);
```

**Note to implementer:** The exact transcript path resolution depends on knowing the Claude Code session ID (different from the desktop session ID). The desktop already maps these via `hookRelay` session ID tracking. The simplest approach: extend `buildStatusData()` to include the last model from the current session's transcript (it already polls every 10s). Then the verification becomes: when `statusData.model` updates, compare against `pendingModel`.

- [ ] **Step 6: Extend buildStatusData() with model from transcript**

In `src/main/ipc-handlers.ts`, modify `buildStatusData()` to include the model from the latest transcript. The `readTranscriptMeta()` function already exists and reads `model` — reuse it:

```typescript
function buildStatusData() {
  const usage = readJsonFile(usageCachePath);
  const announcement = readJsonFile(announcementCachePath);
  const updateStatus = readJsonFile(updateStatusPath);
  const syncStatus = readTextFile(syncStatusPath);
  const syncWarnings = readTextFile(syncWarningsPath);
  // New: include last known model from current transcript
  // (populated by the statusData handler in the renderer)
  return { usage, announcement, updateStatus, syncStatus, syncWarnings };
}
```

Actually, the cleaner approach is to check `statusData.model` from the `readTranscriptMeta` that already exists. Add the model to the `status:data` payload by reading the most recent transcript file:

```typescript
// In the statusInterval callback (around line 324):
const statusInterval = setInterval(() => {
  const data = buildStatusData();
  // Find the latest transcript and extract model
  try {
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    // Use the session ID map from hookRelay to find the transcript
    // This requires access to sessionManager — pass it through or read the most recent .jsonl
  } catch {}
  send(IPC.STATUS_DATA, data);
}, 10000);
```

**Simpler alternative for the implementer:** Add the model field to the `status:data` listener in `App.tsx`. When the renderer receives a `transcript:event` of type `assistant_text` or `turn_complete`, read the `model` from the event payload if available, or call `readLastModel()` IPC. Store it in state and use it for verification.

- [ ] **Step 7: Complete verification with error handling and persistence**

```typescript
// In the transcript event handler or statusData handler:
// When the actual model is confirmed:
const verifyModel = (actualModelId: string) => {
  if (!pendingModel) return;
  const matches = actualModelId.includes(pendingModel);
  if (matches) {
    setPendingModel(null);
    consecutiveFailures.current = 0;
    window.claude.model.setPreference(pendingModel);
  } else {
    // Revert
    const actual = ['sonnet', 'opus', 'haiku'].find(m => actualModelId.includes(m));
    if (actual) setModel(actual as any);
    setPendingModel(null);
    consecutiveFailures.current += 1;
    // Show toast
    if (consecutiveFailures.current >= 2) {
      showToast("Model switch failed again. Ask Claude to diagnose with /model, or report a bug.");
    } else {
      showToast(`Couldn't switch to ${pendingModel}`);
    }
  }
};
```

**Note:** The desktop may not have a toast/snackbar system yet. If not, use a temporary state variable that renders a dismissable message at the bottom of the screen, or use the existing announcement system.

- [ ] **Step 8: Pass model to session creation**

Where `createSession` is called (both from the UI "New Session" button and the IPC handler), include the current model:

```typescript
// In the session creation handler:
const info = sessionManager.createSession({
  ...opts,
  model: currentModel, // from the persisted preference
});
```

- [ ] **Step 9: Pass new props to StatusBar**

Where `<StatusBar>` is rendered, add the new props:

```tsx
<StatusBar
  statusData={statusData}
  onRunSync={handleRunSync}
  model={model}
  onCycleModel={cycleModel}
/>
```

- [ ] **Step 10: Remove dead model label from HeaderBar**

The `HeaderBar` currently renders `statusData.model` as a read-only gray text label. Since it's always null, remove it:

Find in the HeaderBar rendering:
```tsx
{model && (
  <span className="text-[10px] text-gray-500 truncate max-w-[120px] hidden sm:inline">
    {model}
  </span>
)}
```
Remove this block. Also remove the `model` prop from the HeaderBar props interface and its callsite.

- [ ] **Step 11: Verify it runs**

Run: `cd youcoded-core/desktop && npm run dev`
- StatusBar should show a "Sonnet" chip (default)
- Clicking should cycle through Sonnet → Opus → Haiku
- Creating a new session should pass `--model` to Claude Code

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "feat(model): wire model cycling state, verification, and persistence"
```

---

## Part 2: Android App (`youcoded`)

### Task 6: Add `--model` flag to PtyBridge

**Files:**
- Modify: `app/src/main/kotlin/com/destin/code/runtime/PtyBridge.kt`

- [ ] **Step 1: Add `model` parameter to PtyBridge constructor**

In `PtyBridge.kt`, add `model` to the constructor parameters:

```kotlin
class PtyBridge(
    private val bootstrap: Bootstrap,
    private val apiKey: String? = null,
    private val socketName: String = "${bootstrap.homeDir.absolutePath}/.claude-mobile/parser.sock",
    private val cwd: File = bootstrap.homeDir,
    private val dangerousMode: Boolean = false,
    val mobileSessionId: String? = null,
    private val resumeSessionId: String? = null,
    private val model: String? = null,  // Add this line
) {
```

- [ ] **Step 2: Append `--model` to the launch command**

In the `start()` function, after the `resumeFlag` line (around line 128), add:

```kotlin
val modelFlag = if (model != null) " --model $model" else ""
```

Then update the `launchCmd`:

```kotlin
val launchCmd = "exec /system/bin/linker64 ${nodePath.absolutePath} ${wrapperPath.absolutePath} ${claudePath.absolutePath}$dangerousFlag$resumeFlag$modelFlag"
```

- [ ] **Step 3: Verify build**

Run: `cd youcoded && ./gradlew assembleDebug`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add app/src/main/kotlin/com/destin/code/runtime/PtyBridge.kt
git commit -m "feat(pty): accept model parameter and pass --model to Claude Code"
```

---

### Task 7: Pass model through SessionRegistry

**Files:**
- Modify: `app/src/main/kotlin/com/destin/code/runtime/SessionRegistry.kt`

- [ ] **Step 1: Add `model` parameter to `createSession`**

```kotlin
fun createSession(
    bootstrap: Bootstrap,
    cwd: File,
    dangerousMode: Boolean,
    apiKey: String?,
    titlesDir: File,
    resumeSessionId: String? = null,
    model: String? = null,  // Add this line
): ManagedSession {
```

- [ ] **Step 2: Pass model to PtyBridge constructor**

In the `createSession` body, update the PtyBridge instantiation:

```kotlin
val bridge = PtyBridge(
    bootstrap = bootstrap,
    apiKey = apiKey,
    socketName = socketName,
    cwd = cwd,
    dangerousMode = dangerousMode,
    mobileSessionId = sessionId,
    resumeSessionId = resumeSessionId,
    model = model,  // Add this line
)
```

- [ ] **Step 3: Update `resumeSession` to pass model**

In the `resumeSession` method, pass model through:

```kotlin
fun resumeSession(
    pastSession: SessionBrowser.PastSession,
    bootstrap: Bootstrap,
    apiKey: String?,
    titlesDir: File,
    model: String? = null,  // Add this line
): ManagedSession {
    val cwd = SessionBrowser.slugToCwd(pastSession.projectSlug, bootstrap.homeDir)
    val session = createSession(
        bootstrap = bootstrap,
        cwd = cwd,
        dangerousMode = false,
        apiKey = apiKey,
        titlesDir = titlesDir,
        resumeSessionId = pastSession.sessionId,
        model = model,  // Add this line
    )
    return session
}
```

- [ ] **Step 4: Verify build**

Run: `cd youcoded && ./gradlew assembleDebug`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
git add app/src/main/kotlin/com/destin/code/runtime/SessionRegistry.kt
git commit -m "feat(session): thread model parameter through SessionRegistry"
```

---

### Task 8: Model preference persistence + bridge messages (Android)

**Files:**
- Modify: `app/src/main/kotlin/com/destin/code/runtime/SessionService.kt`
- Modify: `app/src/main/assets/web/remote-shim.js`

- [ ] **Step 1: Add model preference file handling to SessionService**

In `SessionService.kt`, add a helper to read/write the model preference. The file lives at `~/.claude-mobile/model-preference.json`:

Find the message handler switch in SessionService (the `when (msg.type)` block that handles `session:create`, `session:destroy`, etc.) and add:

```kotlin
"model:get-preference" -> {
    val prefFile = File(bootstrap!!.homeDir, ".claude-mobile/model-preference.json")
    val model = try {
        val json = org.json.JSONObject(prefFile.readText())
        json.optString("model", "sonnet")
    } catch (_: Exception) { "sonnet" }
    msg.id?.let { bridgeServer.respond(ws, msg.type, it, model) }
}
"model:set-preference" -> {
    val model = msg.payload.optString("model", "sonnet")
    val prefFile = File(bootstrap!!.homeDir, ".claude-mobile/model-preference.json")
    prefFile.parentFile?.mkdirs()
    prefFile.writeText(org.json.JSONObject().put("model", model).toString())
    msg.id?.let { bridgeServer.respond(ws, msg.type, it, true) }
}
"model:switch" -> {
    // Send /model command to the active session's PTY
    val sessionId = msg.payload.optString("sessionId", "")
    val model = msg.payload.optString("model", "")
    val session = sessionRegistry.sessions.value[sessionId]
    session?.writeInput("/model $model\r")
    msg.id?.let { bridgeServer.respond(ws, msg.type, it, true) }
}
```

- [ ] **Step 2: Add model message types to remote-shim.js**

In `remote-shim.js`, find the `session` object in the `window.claude` shim (around line 330-380). Add to the session or create a model namespace:

```javascript
model: {
    getPreference: () => invoke('model:get-preference'),
    setPreference: (model) => invoke('model:set-preference', { model }),
    switch: (sessionId, model) => invoke('model:switch', { sessionId, model }),
},
```

- [ ] **Step 3: Update session creation to pass model**

Find where `session:create` is handled in SessionService.kt and pass the model from the preference:

```kotlin
"session:create" -> {
    val cwd = msg.payload.optString("cwd", bootstrap!!.homeDir.absolutePath)
    val dangerous = msg.payload.optBoolean("skipPermissions", false)
    // Read model preference
    val prefFile = File(bootstrap!!.homeDir, ".claude-mobile/model-preference.json")
    val model = try {
        val json = org.json.JSONObject(prefFile.readText())
        json.optString("model", "sonnet")
    } catch (_: Exception) { "sonnet" }
    val session = sessionRegistry.createSession(
        bootstrap!!, File(cwd), dangerous, apiKey, titlesDir,
        model = model  // Pass model
    )
    // ... rest of existing handler
}
```

- [ ] **Step 4: Verify build**

Run: `cd youcoded && ./gradlew assembleDebug`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
git add app/src/main/kotlin/com/destin/code/runtime/SessionService.kt app/src/main/assets/web/remote-shim.js
git commit -m "feat(model): add model preference persistence and PTY switch for Android"
```

---

### Task 9: Model cycling chip in Android StatusBar + App.js

**Files:**
- Modify: `app/src/main/assets/web/components/StatusBar.js`
- Modify: `app/src/main/assets/web/App.js`

**Important:** The Android web UI is compiled JS (not TypeScript source). Edit the `.js` files directly, following the existing code style.

- [ ] **Step 1: Add model constants and chip to StatusBar.js**

At the top of `StatusBar.js`, after the `"use strict"` line and before `exports.default`, add:

```javascript
const MODELS = ['sonnet', 'opus', 'haiku'];
const MODEL_DISPLAY = {
    sonnet: { label: 'Sonnet', color: '#9CA3AF', bg: 'rgba(156,163,175,0.15)', border: 'rgba(156,163,175,0.25)' },
    opus:   { label: 'Opus',   color: '#818CF8', bg: 'rgba(129,140,248,0.15)', border: 'rgba(129,140,248,0.25)' },
    haiku:  { label: 'Haiku',  color: '#2DD4BF', bg: 'rgba(45,212,191,0.15)',  border: 'rgba(45,212,191,0.25)' },
};
```

Update the `StatusBar` function signature to accept `model` and `onCycleModel`:

```javascript
function StatusBar({ statusData, onRunSync, model, onCycleModel }) {
```

In the JSX children array (inside the `(0, jsx_runtime_1.jsxs)("div", { ... children: [` block), after the context percent element and before the `warnings.map(...)`, add:

```javascript
model && ((0, jsx_runtime_1.jsx)("button", {
    onClick: onCycleModel,
    className: "px-1.5 py-0.5 rounded border cursor-pointer hover:brightness-125 transition-colors",
    style: {
        backgroundColor: MODEL_DISPLAY[model].bg,
        color: MODEL_DISPLAY[model].color,
        borderColor: MODEL_DISPLAY[model].border,
    },
    title: "Model: " + MODEL_DISPLAY[model].label + " (tap to cycle)",
    children: MODEL_DISPLAY[model].label,
})),
```

- [ ] **Step 2: Wire model state in App.js**

In `App.js`, in the `AppInner` function, add state near the other `useState` calls:

```javascript
const [model, setModel] = (0, react_1.useState)('sonnet');
const [pendingModel, setPendingModel] = (0, react_1.useState)(null);
const consecutiveFailures = (0, react_1.useRef)(0);
```

Add a load-on-mount effect:

```javascript
(0, react_1.useEffect)(() => {
    window.claude.model.getPreference().then((m) => {
        if (['sonnet', 'opus', 'haiku'].includes(m)) setModel(m);
    });
}, []);
```

Add the cycle handler:

```javascript
const cycleModel = (0, react_1.useCallback)(() => {
    const MODELS = ['sonnet', 'opus', 'haiku'];
    const idx = MODELS.indexOf(model);
    const next = MODELS[(idx + 1) % MODELS.length];
    setModel(next);
    setPendingModel(next);
    if (sessionId) {
        window.claude.model.switch(sessionId, next);
    }
}, [model, sessionId]);
```

- [ ] **Step 3: Add transcript verification via transcript events**

Add a verification effect that checks model on turn completion:

```javascript
(0, react_1.useEffect)(() => {
    if (!pendingModel) return;
    const handler = window.claude.on.transcriptEvent?.((event) => {
        if (event.type !== 'turn_complete' || !sessionId) return;
        if (event.sessionId !== sessionId) return;
        // After turn completes, the model used is in the last assistant message
        // We need to check it — for now use the model from the transcript event
        // if available, or check statusData.model once we wire it
    });
    return handler;
}, [pendingModel, sessionId]);
```

**Note to implementer:** The exact verification path depends on how the transcript events expose the model. The `TranscriptEvent.AssistantText` may include the model if the `TranscriptWatcher` extracts it. If not, you'll need to either:
1. Extend `TranscriptWatcher` to include `model` in its events, OR
2. Read the transcript file directly via a new bridge message (e.g., `model:read-last-transcript`)

The simpler approach: extend `TranscriptSerializer.assistantText()` to include the `model` field from the JSONL entry.

- [ ] **Step 4: Pass model props to StatusBar**

Find where `StatusBar` is rendered in App.js and add the new props:

```javascript
(0, jsx_runtime_1.jsx)(StatusBar_1.default, {
    statusData: { ... },
    onRunSync: ...,
    model: model,
    onCycleModel: cycleModel,
})
```

- [ ] **Step 5: Remove dead model label from HeaderBar**

In the `HeaderBar` rendering in App.js (around line 605), the `model` prop is passed as `statusData.model` (always null). Remove the `model` prop from the HeaderBar call. In `HeaderBar.js`, remove the conditional rendering block:

```javascript
model && ((0, jsx_runtime_1.jsx)("span", { className: "text-[10px] text-gray-500 truncate max-w-[120px] hidden sm:inline", children: model }))
```

- [ ] **Step 6: Verify build**

Run: `cd youcoded && ./gradlew assembleDebug`
Expected: Build succeeds

- [ ] **Step 7: Commit**

```bash
git add app/src/main/assets/web/components/StatusBar.js app/src/main/assets/web/App.js app/src/main/assets/web/components/HeaderBar.js
git commit -m "feat(ui): add model cycling chip to Android StatusBar with verification"
```

---

## Part 3: Verification & Polish

### Task 10: Extend TranscriptWatcher to include model (Android)

**Files:**
- Modify: `app/src/main/kotlin/com/destin/code/parser/TranscriptEvent.kt`
- Modify: `app/src/main/kotlin/com/destin/code/parser/TranscriptWatcher.kt`
- Modify: `app/src/main/kotlin/com/destin/code/bridge/TranscriptSerializer.kt`

The transcript JSONL entries for assistant messages contain `message.model`. We need to surface this through the existing event pipeline so the React UI can verify model switches.

- [ ] **Step 1: Add model field to AssistantText event**

In `TranscriptEvent.kt`, add `model` to `AssistantText`:

```kotlin
data class AssistantText(
    val sessionId: String,
    val uuid: String,
    val timestamp: String,
    val text: String,
    val model: String? = null,  // Add this
) : TranscriptEvent()
```

- [ ] **Step 2: Parse model from transcript in TranscriptWatcher**

In `TranscriptWatcher.kt`, where `AssistantText` events are created from JSONL entries, extract the model:

Find the block that creates `AssistantText` and add model extraction:

```kotlin
val model = entry.optJSONObject("message")?.optString("model", null)
```

Pass it to the constructor:

```kotlin
TranscriptEvent.AssistantText(
    sessionId = mobileSessionId,
    uuid = uuid,
    timestamp = timestamp,
    text = text,
    model = model,
)
```

- [ ] **Step 3: Include model in TranscriptSerializer**

In `TranscriptSerializer.kt`, update the `assistantText()` function to include model:

```kotlin
fun assistantText(sessionId: String, uuid: String, timestamp: String, text: String, model: String? = null): JSONObject {
    return JSONObject().apply {
        put("type", "assistant_text")
        put("sessionId", sessionId)
        put("uuid", uuid)
        put("timestamp", timestamp)
        put("text", text)
        if (model != null) put("model", model)
    }
}
```

Update the callsite in `ManagedSession.kt` where `TranscriptSerializer.assistantText()` is called:

```kotlin
is TranscriptEvent.AssistantText -> TranscriptSerializer.assistantText(event.sessionId, event.uuid, event.timestamp, event.text, event.model)
```

- [ ] **Step 4: Wire verification in App.js**

Now that transcript events include the model, update the verification in App.js:

```javascript
(0, react_1.useEffect)(() => {
    if (!pendingModel) return;
    const handler = window.claude.on.transcriptEvent?.((event) => {
        if (event.type !== 'assistant_text' || !event.model) return;
        if (event.sessionId !== sessionId) return;
        const actualModel = event.model;
        const matches = actualModel.includes(pendingModel);
        if (matches) {
            setPendingModel(null);
            consecutiveFailures.current = 0;
            window.claude.model.setPreference(pendingModel);
        } else {
            // Revert
            const actual = ['sonnet', 'opus', 'haiku'].find(m => actualModel.includes(m));
            if (actual) setModel(actual);
            setPendingModel(null);
            consecutiveFailures.current += 1;
            // Toast logic — use a simple state variable for now
        }
    });
    return handler;
}, [pendingModel, sessionId]);
```

- [ ] **Step 5: Verify build**

Run: `cd youcoded && ./gradlew assembleDebug`
Expected: Build succeeds

- [ ] **Step 6: Commit**

```bash
git add app/src/main/kotlin/com/destin/code/parser/TranscriptEvent.kt \
       app/src/main/kotlin/com/destin/code/parser/TranscriptWatcher.kt \
       app/src/main/kotlin/com/destin/code/bridge/TranscriptSerializer.kt \
       app/src/main/kotlin/com/destin/code/runtime/ManagedSession.kt \
       app/src/main/assets/web/App.js
git commit -m "feat(transcript): surface model field through event pipeline for verification"
```

---

### Task 11: Error toast UI (Android)

**Files:**
- Modify: `app/src/main/assets/web/App.js`

- [ ] **Step 1: Add toast state**

```javascript
const [toast, setToast] = (0, react_1.useState)(null);
```

- [ ] **Step 2: Add toast rendering**

At the end of the main JSX, before the closing `]` of the root children array, add:

```javascript
toast && ((0, jsx_runtime_1.jsx)("div", {
    className: "fixed bottom-16 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-gray-800 border border-gray-700 text-sm text-gray-200 shadow-lg animate-fade-in",
    children: toast,
}))
```

- [ ] **Step 3: Wire toast into verification**

In the verification effect from Task 10, replace the comment with actual toast calls:

```javascript
// On mismatch:
if (consecutiveFailures.current >= 2) {
    setToast("Model switch failed again. Ask Claude to diagnose with /model, or report a bug.");
} else {
    setToast("Couldn't switch to " + pendingModel.charAt(0).toUpperCase() + pendingModel.slice(1));
}
// Auto-dismiss after 4 seconds
setTimeout(() => setToast(null), 4000);
```

- [ ] **Step 4: Commit**

```bash
git add app/src/main/assets/web/App.js
git commit -m "feat(ui): add error toast for failed model switches"
```

---

### Task 12: End-to-end testing

- [ ] **Step 1: Test Android — session launch with model**

1. Build and deploy: `./gradlew installDebug`
2. Open YouCoded, create a new session
3. StatusBar should show "Sonnet" chip (default)
4. Ask Claude "what model are you?" — should report Sonnet

- [ ] **Step 2: Test Android — mid-session cycling**

1. Tap the model chip → should cycle to "Opus" (purple)
2. Send a message to Claude
3. After response, the model should be verified (chip stays Opus)
4. Ask "what model are you?" — should report Opus

- [ ] **Step 3: Test Android — persistence**

1. Close the app
2. Re-open and create a new session
3. Chip should show "Opus" (persisted from last switch)

- [ ] **Step 4: Test Desktop — same flow**

1. Run `npm run dev` in the desktop app
2. Verify the model chip appears in StatusBar
3. Test cycling, verification, and persistence
4. Test that new sessions use the persisted model

- [ ] **Step 5: Test error handling**

1. Switch to a model while offline or with an invalid API key
2. Send a message — verification should fail
3. Chip should revert, toast should appear
4. Try again — second failure should show the escalated message
