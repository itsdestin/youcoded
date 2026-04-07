# Remote Access Settings & Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a settings panel with remote access configuration (password, Tailscale, QR code) and a `remote-setup` skill that installs Tailscale and walks users through end-to-end setup.

**Architecture:** A `SettingsPanel` React component slides out from the left when a gear icon in the header is clicked. It communicates with the main process via new IPC channels (`remote:get-config`, `remote:set-password`, `remote:detect-tailscale`, `remote:set-config`) to read/write remote config and detect Tailscale. A `qrcode.react` component renders QR codes for the Tailscale URL. A separate `remote-setup` Claude Code skill handles Tailscale installation, auth, password creation, and phone setup guidance.

**Tech Stack:** TypeScript, React, `qrcode.react` (QR rendering), existing Tailwind CSS, Electron IPC, Claude Code skill system

**Spec:** `desktop/docs/superpowers/specs/2026-03-24-remote-web-access-design.md`

---

### File Structure

**New files:**
- `src/renderer/components/SettingsPanel.tsx` — Slide-out settings panel with Remote Access section
- `~/.claude/skills/remote-setup/SKILL.md` — Claude Code skill for Tailscale + remote setup

**Modified files:**
- `src/renderer/components/HeaderBar.tsx` — Add gear icon (top left)
- `src/renderer/App.tsx` — Add SettingsPanel state and rendering
- `src/main/preload.ts` — Add `remote.*` IPC channels
- `src/main/ipc-handlers.ts` — Add `remote:*` IPC handlers
- `src/main/remote-config.ts` — Add `toSafeObject()` and `detectTailscale()`, make `save()` public
- `src/main/remote-server.ts` — Add `getClientCount()` method
- `src/shared/types.ts` — Add `IPC.REMOTE_*` channel constants
- `src/renderer/remote-shim.ts` — Add `remote.*` shim methods
- `src/renderer/data/skill-registry.json` — Add `remote-setup` skill entry
- `~/.claude/skills/setup-wizard/SKILL.md` — Add Phase 5c for remote access setup
- `package.json` — Add `qrcode.react` dependency

---

### Task 1: Install qrcode.react dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install qrcode.react**

```bash
npm install qrcode.react
```

Note: `qrcode.react` has zero native dependencies and works in both Electron and browser contexts. It renders QR codes as inline SVG — no canvas or image generation needed.

- [ ] **Step 2: Verify installation**

```bash
node -e "require('qrcode.react'); console.log('OK')"
```

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat(remote): add qrcode.react dependency"
```

---

### Task 2: Extend types and RemoteConfig

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/main/remote-config.ts`
- Modify: `src/main/remote-server.ts`

- [ ] **Step 1: Add IPC channel constants**

In `src/shared/types.ts`, add to the `IPC` object:

```typescript
  // Remote settings
  REMOTE_GET_CONFIG: 'remote:get-config',
  REMOTE_SET_PASSWORD: 'remote:set-password',
  REMOTE_SET_CONFIG: 'remote:set-config',
  REMOTE_DETECT_TAILSCALE: 'remote:detect-tailscale',
  REMOTE_GET_CLIENT_COUNT: 'remote:get-client-count',
```

- [ ] **Step 2: Add `toSafeObject()` to RemoteConfig**

In `src/main/remote-config.ts`, add a method that returns the config without the password hash (safe to send to the renderer):

```typescript
  /** Return config data safe for the renderer (no password hash). */
  toSafeObject(): { enabled: boolean; port: number; hasPassword: boolean; trustTailscale: boolean } {
    return {
      enabled: this.enabled,
      port: this.port,
      hasPassword: !!this.passwordHash,
      trustTailscale: this.trustTailscale,
    };
  }
```

- [ ] **Step 3: Make `save()` public and add `detectTailscale()` to RemoteConfig**

In `src/main/remote-config.ts`:

Change `private save()` to `save()` (remove the `private` modifier).

Add a static method for Tailscale detection (shared by both IPC handlers and RemoteServer):

```typescript
  /** Detect Tailscale installation and connection status. */
  static async detectTailscale(port: number): Promise<{ installed: boolean; ip: string | null; hostname: string | null; url: string | null }> {
    try {
      const { execFile } = require('child_process');
      const { promisify } = require('util');
      const execFileAsync = promisify(execFile);
      let tsPath = 'tailscale';
      try { const w = require('which'); tsPath = w.sync('tailscale'); } catch {}

      const { stdout: ip } = await execFileAsync(tsPath, ['ip', '-4']);
      const tailscaleIp = ip.trim();

      let hostname = '';
      try {
        const { stdout: statusJson } = await execFileAsync(tsPath, ['status', '--json']);
        const status = JSON.parse(statusJson);
        hostname = status.Self?.HostName || '';
      } catch {}

      return { installed: true, ip: tailscaleIp, hostname, url: `http://${tailscaleIp}:${port}` };
    } catch {
      return { installed: false, ip: null, hostname: null, url: null };
    }
  }
```

- [ ] **Step 4: Add `getClientCount()` to RemoteServer**

In `src/main/remote-server.ts`, add a public method:

```typescript
  /** Number of currently connected remote clients. */
  getClientCount(): number {
    return this.clients.size;
  }
```

- [ ] **Step 4: Commit**

```bash
git add src/shared/types.ts src/main/remote-config.ts src/main/remote-server.ts
git commit -m "feat(remote): add IPC channels, safe config export, client count"
```

---

### Task 3: Add IPC handlers for remote settings

**Files:**
- Modify: `src/main/ipc-handlers.ts`
- Modify: `src/main/main.ts` (pass remoteConfig and remoteServer to registerIpcHandlers)

- [ ] **Step 1: Update `registerIpcHandlers` signature**

In `src/main/ipc-handlers.ts`, update the function signature to accept `remoteConfig` and `remoteServer`:

```typescript
export function registerIpcHandlers(
  ipcMain: IpcMain,
  sessionManager: SessionManager,
  mainWindow: BrowserWindow,
  hookRelay?: HookRelay,
  remoteConfig?: RemoteConfig,
  remoteServer?: RemoteServer,
) {
```

Add the imports at the top:

```typescript
import { RemoteConfig } from './remote-config';
import { RemoteServer } from './remote-server';
```

- [ ] **Step 2: Add remote IPC handlers**

After the skills list handler, add:

```typescript
  // --- Remote access settings ---
  if (remoteConfig) {
    ipcMain.handle(IPC.REMOTE_GET_CONFIG, async () => {
      return {
        ...remoteConfig.toSafeObject(),
        clientCount: remoteServer?.getClientCount() ?? 0,
      };
    });

    ipcMain.handle(IPC.REMOTE_SET_PASSWORD, async (_event, password: string) => {
      await remoteConfig.setPassword(password);
      remoteServer?.invalidateTokens();
      return true;
    });

    ipcMain.handle(IPC.REMOTE_SET_CONFIG, async (_event, updates: { enabled?: boolean; trustTailscale?: boolean }) => {
      if (typeof updates.enabled === 'boolean') remoteConfig.enabled = updates.enabled;
      if (typeof updates.trustTailscale === 'boolean') remoteConfig.trustTailscale = updates.trustTailscale;
      remoteConfig.save();
      return remoteConfig.toSafeObject();
    });

    ipcMain.handle(IPC.REMOTE_DETECT_TAILSCALE, async () => {
      return RemoteConfig.detectTailscale(remoteConfig.port);
    });

    ipcMain.handle(IPC.REMOTE_GET_CLIENT_COUNT, async () => {
      return remoteServer?.getClientCount() ?? 0;
    });
  }
```

- [ ] **Step 3: Update main.ts to pass remoteConfig and remoteServer**

In `src/main/main.ts`, update the `registerIpcHandlers` call:

```typescript
  cleanupIpcHandlers = registerIpcHandlers(ipcMain, sessionManager, mainWindow, hookRelay, remoteConfig, remoteServer);
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/ipc-handlers.test.ts tests/remote-config.test.ts tests/remote-server.test.ts
```

Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc-handlers.ts src/main/main.ts
git commit -m "feat(remote): add IPC handlers for remote settings management"
```

---

### Task 4: Update preload bridge and remote shim

**Files:**
- Modify: `src/main/preload.ts`
- Modify: `src/renderer/remote-shim.ts`

- [ ] **Step 1: Add remote channels to preload.ts**

In `src/main/preload.ts`, add to the IPC constants:

```typescript
  REMOTE_GET_CONFIG: 'remote:get-config',
  REMOTE_SET_PASSWORD: 'remote:set-password',
  REMOTE_SET_CONFIG: 'remote:set-config',
  REMOTE_DETECT_TAILSCALE: 'remote:detect-tailscale',
  REMOTE_GET_CLIENT_COUNT: 'remote:get-client-count',
```

Add to the `contextBridge.exposeInMainWorld('claude', {...})` object, after the `shell` section:

```typescript
    remote: {
      getConfig: () => ipcRenderer.invoke(IPC.REMOTE_GET_CONFIG),
      setPassword: (password: string) => ipcRenderer.invoke(IPC.REMOTE_SET_PASSWORD, password),
      setConfig: (updates: { enabled?: boolean; trustTailscale?: boolean }) =>
        ipcRenderer.invoke(IPC.REMOTE_SET_CONFIG, updates),
      detectTailscale: () => ipcRenderer.invoke(IPC.REMOTE_DETECT_TAILSCALE),
      getClientCount: () => ipcRenderer.invoke(IPC.REMOTE_GET_CLIENT_COUNT),
    },
```

- [ ] **Step 2: Add remote methods to remote-shim.ts**

In `src/renderer/remote-shim.ts`, add to the `installShim()` function's `window.claude` object, after the `shell` section:

```typescript
    remote: {
      getConfig: () => invoke('remote:get-config'),
      setPassword: (password: string) => invoke('remote:set-password', password),
      setConfig: (updates: { enabled?: boolean; trustTailscale?: boolean }) =>
        invoke('remote:set-config', updates),
      detectTailscale: () => invoke('remote:detect-tailscale'),
      getClientCount: () => invoke('remote:get-client-count'),
    },
```

- [ ] **Step 3: Add remote message types to RemoteServer**

In `src/main/remote-server.ts`, add these cases to the `handleMessage` switch:

```typescript
      case 'remote:get-config': {
        const config = {
          ...this.config.toSafeObject(),
          clientCount: this.getClientCount(),
        };
        this.respond(client.ws, type, id, config);
        break;
      }
      case 'remote:set-password': {
        await this.config.setPassword(payload);
        this.invalidateTokens();
        this.respond(client.ws, type, id, true);
        break;
      }
      case 'remote:set-config': {
        if (typeof payload.enabled === 'boolean') this.config.enabled = payload.enabled;
        if (typeof payload.trustTailscale === 'boolean') this.config.trustTailscale = payload.trustTailscale;
        this.config.save();
        this.respond(client.ws, type, id, this.config.toSafeObject());
        break;
      }
      case 'remote:detect-tailscale': {
        const { RemoteConfig } = require('./remote-config');
        const result = await RemoteConfig.detectTailscale(this.config.port);
        this.respond(client.ws, type, id, result);
        break;
      }
      case 'remote:get-client-count': {
        this.respond(client.ws, type, id, this.getClientCount());
        break;
      }
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/main/preload.ts src/renderer/remote-shim.ts src/main/remote-server.ts
git commit -m "feat(remote): add remote settings to preload bridge and WebSocket shim"
```

---

### Task 5: Create SettingsPanel component

**Files:**
- Create: `src/renderer/components/SettingsPanel.tsx`

This is the largest UI task. The panel slides in from the left with a backdrop overlay, following the CommandDrawer pattern but oriented horizontally.

- [ ] **Step 1: Create SettingsPanel.tsx**

```tsx
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { QRCodeSVG } from 'qrcode.react';

interface RemoteConfig {
  enabled: boolean;
  port: number;
  hasPassword: boolean;
  trustTailscale: boolean;
  clientCount: number;
}

interface TailscaleInfo {
  installed: boolean;
  ip: string | null;
  hostname: string | null;
  url: string | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSendInput: (text: string) => void;
  hasActiveSession: boolean;
}

export default function SettingsPanel({ open, onClose, onSendInput, hasActiveSession }: Props) {
  const [config, setConfig] = useState<RemoteConfig | null>(null);
  const [tailscale, setTailscale] = useState<TailscaleInfo | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [passwordStatus, setPasswordStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [loading, setLoading] = useState(true);
  const panelRef = useRef<HTMLDivElement>(null);

  // Load config and detect Tailscale on open
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    const claude = (window as any).claude;
    if (!claude?.remote) { setLoading(false); return; }
    Promise.all([
      claude.remote.getConfig(),
      claude.remote.detectTailscale(),
    ]).then(([cfg, ts]: [RemoteConfig, TailscaleInfo]) => {
      setConfig(cfg);
      setTailscale(ts);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  const handleSetPassword = useCallback(async () => {
    if (!newPassword.trim()) return;
    setPasswordStatus('saving');
    try {
      await (window as any).claude.remote.setPassword(newPassword);
      setConfig(prev => prev ? { ...prev, hasPassword: true } : prev);
      setNewPassword('');
      setPasswordStatus('saved');
      setTimeout(() => setPasswordStatus('idle'), 2000);
    } catch {
      setPasswordStatus('idle');
    }
  }, [newPassword]);

  const handleToggleEnabled = useCallback(async () => {
    if (!config) return;
    const updated = await (window as any).claude.remote.setConfig({ enabled: !config.enabled });
    setConfig(prev => prev ? { ...prev, ...updated } : prev);
  }, [config]);

  const handleToggleTailscaleTrust = useCallback(async () => {
    if (!config) return;
    const updated = await (window as any).claude.remote.setConfig({ trustTailscale: !config.trustTailscale });
    setConfig(prev => prev ? { ...prev, ...updated } : prev);
  }, [config]);

  const handleRunSetup = useCallback(() => {
    if (!hasActiveSession) return;
    onSendInput('/remote-setup');
    onClose();
  }, [hasActiveSession, onSendInput, onClose]);

  const isSetUp = config?.hasPassword && tailscale?.installed;

  return (
    <>
      {/* Backdrop */}
      {open && (
        <div
          className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40"
          onClick={onClose}
        />
      )}

      {/* Panel */}
      <div
        ref={panelRef}
        className={`fixed top-0 left-0 h-full w-80 bg-gray-900 border-r border-gray-700/50 z-50 transform transition-transform duration-300 ease-out ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex flex-col h-full overflow-y-auto">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
            <h2 className="text-sm font-bold text-gray-200">Settings</h2>
            <button
              onClick={onClose}
              className="text-gray-500 hover:text-gray-300 text-lg leading-none"
            >
              ✕
            </button>
          </div>

          {loading ? (
            <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">
              Loading...
            </div>
          ) : (
            <div className="flex-1 px-4 py-4 space-y-6">
              {/* Setup prompt — shown when not fully configured */}
              {!isSetUp && (
                <div className="bg-blue-500/10 border border-blue-500/25 rounded-lg p-3">
                  <p className="text-xs text-blue-400 mb-2">
                    Remote access lets you use DestinCode from any device — phone, tablet, or another computer.
                  </p>
                  <button
                    onClick={handleRunSetup}
                    disabled={!hasActiveSession}
                    className="w-full px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                    title={!hasActiveSession ? 'Create a session first' : ''}
                  >
                    Set Up Remote Access
                  </button>
                  {!hasActiveSession && (
                    <p className="text-[10px] text-gray-500 mt-1 text-center">Create a session first to run setup</p>
                  )}
                </div>
              )}

              {/* Remote Access section */}
              <section>
                <h3 className="text-[10px] font-medium text-gray-500 tracking-wider uppercase mb-3">Remote Access</h3>

                {/* Enable/disable toggle */}
                <label className="flex items-center justify-between py-2 cursor-pointer">
                  <span className="text-xs text-gray-300">Enabled</span>
                  <button
                    onClick={handleToggleEnabled}
                    className={`w-8 h-4 rounded-full transition-colors relative ${
                      config?.enabled ? 'bg-green-600' : 'bg-gray-700'
                    }`}
                  >
                    <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
                      config?.enabled ? 'left-4' : 'left-0.5'
                    }`} />
                  </button>
                </label>

                {/* Password */}
                <div className="py-2">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-gray-300">Password</span>
                    {config?.hasPassword && (
                      <span className="text-[10px] text-green-400">Set</span>
                    )}
                  </div>
                  <div className="flex gap-1">
                    <input
                      type="password"
                      placeholder={config?.hasPassword ? 'Change password...' : 'Set password...'}
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleSetPassword()}
                      className="flex-1 px-2 py-1 rounded bg-[#1C1C1C] border border-gray-700/50 text-xs text-gray-200 focus:outline-none focus:border-gray-500"
                    />
                    <button
                      onClick={handleSetPassword}
                      disabled={!newPassword.trim() || passwordStatus === 'saving'}
                      className="px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-xs disabled:opacity-50"
                    >
                      {passwordStatus === 'saved' ? '✓' : passwordStatus === 'saving' ? '...' : 'Set'}
                    </button>
                  </div>
                </div>

                {/* Connected clients */}
                {config && config.clientCount > 0 && (
                  <div className="py-2 flex items-center justify-between">
                    <span className="text-xs text-gray-300">Remote clients</span>
                    <span className="text-xs text-gray-400">{config.clientCount} connected</span>
                  </div>
                )}
              </section>

              {/* Tailscale section */}
              <section>
                <h3 className="text-[10px] font-medium text-gray-500 tracking-wider uppercase mb-3">Tailscale</h3>

                {tailscale?.installed ? (
                  <>
                    {/* Status */}
                    <div className="py-2 flex items-center justify-between">
                      <span className="text-xs text-gray-300">Status</span>
                      <span className="text-[10px] text-green-400">
                        Connected{tailscale.hostname ? ` · ${tailscale.hostname}` : ''}
                      </span>
                    </div>

                    {/* Tailscale IP */}
                    <div className="py-2 flex items-center justify-between">
                      <span className="text-xs text-gray-300">IP</span>
                      <span className="text-xs text-gray-400 font-mono">{tailscale.ip}</span>
                    </div>

                    {/* Trust toggle */}
                    <label className="flex items-center justify-between py-2 cursor-pointer">
                      <span className="text-xs text-gray-300">Skip password on Tailscale</span>
                      <button
                        onClick={handleToggleTailscaleTrust}
                        className={`w-8 h-4 rounded-full transition-colors relative ${
                          config?.trustTailscale ? 'bg-green-600' : 'bg-gray-700'
                        }`}
                      >
                        <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
                          config?.trustTailscale ? 'left-4' : 'left-0.5'
                        }`} />
                      </button>
                    </label>

                    {/* QR Code */}
                    {tailscale.url && config?.hasPassword && (
                      <div className="py-3">
                        <p className="text-[10px] text-gray-500 mb-2">Scan to open on your phone:</p>
                        <div className="flex justify-center bg-white rounded-lg p-3 w-fit mx-auto">
                          <QRCodeSVG value={tailscale.url} size={160} />
                        </div>
                        <p className="text-[10px] text-gray-500 mt-2 text-center font-mono">{tailscale.url}</p>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="py-2">
                    <p className="text-xs text-gray-500 mb-2">
                      Tailscale is not installed. It creates a secure private network so you can access DestinCode from anywhere.
                    </p>
                    <button
                      onClick={handleRunSetup}
                      disabled={!hasActiveSession}
                      className="px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-xs disabled:opacity-50"
                    >
                      Install with Setup Skill
                    </button>
                  </div>
                )}
              </section>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Note: The renderer uses Vite for actual bundling; `tsc --noEmit` may warn about JSX/DOM types vs the Node tsconfig. A quick check that Vite serves it is the real test.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/SettingsPanel.tsx
git commit -m "feat(remote): add SettingsPanel component with password, Tailscale, and QR code"
```

---

### Task 6: Wire SettingsPanel into HeaderBar and App

**Files:**
- Modify: `src/renderer/components/HeaderBar.tsx`
- Modify: `src/renderer/App.tsx`

- [ ] **Step 1: Add gear icon and settings state to HeaderBar**

In `src/renderer/components/HeaderBar.tsx`, add to the Props interface:

```typescript
  settingsOpen: boolean;
  onToggleSettings: () => void;
```

At the **beginning** of the left section (the first `<div className="flex-1 flex ...">` child), add the gear icon button:

```tsx
<button
  onClick={onToggleSettings}
  className={`p-1 rounded hover:bg-gray-800 transition-colors ${settingsOpen ? 'text-gray-200' : 'text-gray-500'}`}
  title="Settings"
>
  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
  </svg>
</button>
```

- [ ] **Step 2: Add SettingsPanel to App.tsx**

In `src/renderer/App.tsx`:

Add import:
```typescript
import SettingsPanel from './components/SettingsPanel';
```

Add state:
```typescript
const [settingsOpen, setSettingsOpen] = useState(false);
```

Pass to HeaderBar:
```typescript
<HeaderBar
  // ... existing props ...
  settingsOpen={settingsOpen}
  onToggleSettings={() => setSettingsOpen(prev => !prev)}
/>
```

Add SettingsPanel rendering (just before the closing `</div>` of the main container):
```tsx
<SettingsPanel
  open={settingsOpen}
  onClose={() => setSettingsOpen(false)}
  onSendInput={(text) => {
    if (activeSessionId) {
      const claude = (window as any).claude;
      claude.session.sendInput(activeSessionId, text + '\r');
    }
  }}
  hasActiveSession={!!activeSessionId}
/>
```

- [ ] **Step 3: Verify it compiles and renders**

Start dev server and check:
```bash
npx tsc --noEmit
```

Then visually verify: the gear icon should appear at the top left, clicking it should open the settings panel.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/HeaderBar.tsx src/renderer/App.tsx
git commit -m "feat(remote): wire SettingsPanel into HeaderBar and App"
```

---

### Task 7: Add remote-setup skill entry to command drawer

**Files:**
- Modify: `src/renderer/data/skill-registry.json`

- [ ] **Step 1: Add remote-setup entry**

Add to `src/renderer/data/skill-registry.json`:

```json
  "remote-setup": {
    "displayName": "Remote Setup",
    "description": "Set up remote access — installs Tailscale, configures your password, and gets your phone connected",
    "category": "admin",
    "prompt": "/remote-setup",
    "source": "destinclaude"
  }
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/data/skill-registry.json
git commit -m "feat(remote): add remote-setup skill to command drawer registry"
```

---

### Task 8: Create the remote-setup skill

**Files:**
- Create: `~/.claude/skills/remote-setup/SKILL.md`

This skill handles the full end-to-end setup:
1. Detects platform (Windows/macOS/Linux)
2. Installs Tailscale CLI non-interactively
3. Runs `tailscale up` — opens browser for auth (only manual step)
4. Sets the DestinCode remote password
5. Guides phone setup (install Tailscale app, join network, open URL)
6. Verifies everything works

- [ ] **Step 1: Create the skill file**

Create `~/.claude/skills/remote-setup/SKILL.md`:

```markdown
---
name: remote-setup
description: Set up remote access for DestinCode — installs Tailscale, configures password, and walks you through connecting from your phone. Use when the user says "set up remote access", "remote setup", "I want to use DestinCode from my phone", or similar.
---

# Remote Access Setup

You are setting up remote access for DestinCode so the user can access it from their phone or any other device. Be conversational and explain things simply — the user may not be technical.

**Goal:** By the end, the user will have:
1. Tailscale installed and authenticated
2. A remote access password set
3. DestinCode accessible from their phone

---

## Step 1: Check current state

Before doing anything, check what's already set up:

```bash
# Check if Tailscale is installed
tailscale version 2>/dev/null && echo "TAILSCALE_INSTALLED=true" || echo "TAILSCALE_INSTALLED=false"

# Check if Tailscale is connected
tailscale status 2>/dev/null && echo "TAILSCALE_CONNECTED=true" || echo "TAILSCALE_CONNECTED=false"

# Check if remote config exists
cat ~/.claude/destincode-remote.json 2>/dev/null || echo "NO_CONFIG"

# Detect platform
uname -s 2>/dev/null || echo "Windows"
```

If everything is already set up (Tailscale connected + password configured), tell the user and skip to Step 5 (phone setup).

---

## Step 2: Install Tailscale

Explain to the user:
> "Tailscale creates a private network between your devices — like a secure tunnel that only you can use. It's free for personal use and takes about a minute to set up."

### Windows

```powershell
# Download and install Tailscale silently
winget install --id Tailscale.Tailscale --accept-package-agreements --accept-source-agreements
```

If `winget` is not available, tell the user:
> "I can't install Tailscale automatically on your system. Please download it from https://tailscale.com/download/windows and run the installer. Let me know when it's done."

### macOS

```bash
brew install --cask tailscale
```

If `brew` is not available:
> "Please download Tailscale from https://tailscale.com/download/mac and install it. Let me know when it's done."

### Linux

```bash
curl -fsSL https://tailscale.com/install.sh | sh
```

After installation, verify:
```bash
tailscale version
```

---

## Step 3: Connect Tailscale

```bash
tailscale up
```

This will output a URL. Tell the user:

> "Tailscale needs you to log in to create your private network. It just opened a link in your browser (or printed one above). Sign in with Google, Microsoft, GitHub, or Apple — whichever you prefer. This is a one-time step."

Wait for them to confirm they've authenticated, then verify:

```bash
tailscale ip -4
```

This should return a `100.x.x.x` IP address. Save this — it's their Tailscale IP.

```bash
tailscale status --json | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');const s=JSON.parse(d);console.log('Hostname:', s.Self?.HostName || 'unknown')"
```

Tell the user their Tailscale IP and hostname.

---

## Step 4: Configure remote access password

> "Now let's set a password for remote access. This is what you'll type when connecting from your phone."

Ask the user to choose a password. Then set it:

```bash
node -e "
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const os = require('os');
const password = process.argv[1];
const hash = bcrypt.hashSync(password, 10);
const configPath = path.join(os.homedir(), '.claude', 'destincode-remote.json');
let config = { enabled: true, port: 9900, passwordHash: null, trustTailscale: true };
try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
config.passwordHash = hash;
config.enabled = true;
config.trustTailscale = true;
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log('Password set and Tailscale trust enabled.');
" "USER_PASSWORD_HERE"
```

Replace `USER_PASSWORD_HERE` with the password the user chose.

> "I've set your password and enabled Tailscale trust mode. When you're on your Tailscale network, you won't even need to type the password — Tailscale handles authentication for you."

---

## Step 5: Phone setup

> "Last step — let's get your phone connected. Here's what to do:"

Tell the user:

> **1. Install Tailscale on your phone**
> - iPhone: Search "Tailscale" in the App Store
> - Android: Search "Tailscale" in the Google Play Store
>
> **2. Sign in with the same account** you just used on your computer
>
> **3. Open your browser** and go to:
> `http://TAILSCALE_IP:9900`
>
> That's it! You should see the DestinCode login screen. If you enabled Tailscale trust, you'll be logged in automatically.

Replace `TAILSCALE_IP` with their actual Tailscale IP from Step 3.

> "You can also find this URL anytime by clicking the gear icon in DestinCode and looking under the Tailscale section. There's a QR code you can scan too."

---

## Step 6: Verify

> "Let me verify everything is working..."

```bash
# Check Tailscale is connected
tailscale status | head -5

# Check remote server config
node -e "
const fs = require('fs');
const os = require('os');
const path = require('path');
const configPath = path.join(os.homedir(), '.claude', 'destincode-remote.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
console.log('Remote access:', config.enabled ? 'enabled' : 'disabled');
console.log('Password:', config.passwordHash ? 'set' : 'NOT SET');
console.log('Tailscale trust:', config.trustTailscale ? 'enabled' : 'disabled');
console.log('Port:', config.port);
"

# Check remote server is listening
node -e "
const http = require('http');
http.get('http://localhost:9900', (res) => {
  console.log('Remote server: listening (HTTP', res.statusCode, ')');
}).on('error', () => {
  console.log('Remote server: NOT RUNNING — restart DestinCode to activate');
});
"
```

Summarize:
> "Here's your setup:
> - Tailscale IP: `100.x.x.x`
> - Remote URL: `http://100.x.x.x:9900`
> - Password: set
> - Tailscale trust: enabled (no password needed from your devices)
>
> Open that URL on your phone to start using DestinCode remotely. The settings gear in DestinCode has a QR code you can scan too."
```

- [ ] **Step 2: Commit**

```bash
git add ~/.claude/skills/remote-setup/SKILL.md
git commit -m "feat(remote): add remote-setup skill for Tailscale + password configuration"
```

---

### Task 9: Add remote setup offer to setup wizard

**Files:**
- Modify: `~/.claude/skills/setup-wizard/SKILL.md`

- [ ] **Step 1: Add Phase 5c after Phase 5b**

In `~/.claude/skills/setup-wizard/SKILL.md`, after the `## Phase 5b: DestinCode Desktop App (Optional)` section, add:

```markdown
## Phase 5c: Remote Access (Optional)

If the DestinCode desktop app was installed (Phase 5b), offer remote access setup:

> "Would you like to set up remote access? This lets you use DestinCode from your phone or any other device using Tailscale — a free, secure private network."
>
> 1. Yes — set it up now
> 2. No — I'll do this later (you can run `/remote-setup` anytime)

If the user chooses **1**, invoke the remote-setup skill by saying: "Let me run the remote setup skill."
Then use the Skill tool to invoke `remote-setup`.

If the user chooses **2**, continue to Phase 6.
```

- [ ] **Step 2: Commit**

```bash
git add ~/.claude/skills/setup-wizard/SKILL.md
git commit -m "feat(remote): add remote access setup offer to setup wizard"
```

---

### Task 10: Run full test suite and verify

**Files:** None (testing only)

- [ ] **Step 1: Run all tests**

```bash
cd ~/.claude/plugins/destinclaude/desktop
npx vitest run
```

Expected: All previously passing tests still pass. The `session-manager.test.ts` failures are pre-existing (Electron `app.isPackaged` mock issue).

- [ ] **Step 2: Build check**

```bash
npx tsc --noEmit
```

Expected: No TypeScript errors

- [ ] **Step 3: Visual verification**

Start the dev server:
```bash
VITE_DEV_SERVER_URL=http://localhost:5174 npx electron .
```

Verify:
- Gear icon visible in top-left of header bar
- Clicking gear opens settings panel from the left
- Remote Access section shows enable/disable toggle and password field
- Tailscale section shows detected or "not installed" state
- QR code appears when Tailscale is connected and password is set
- Settings panel closes on Escape or backdrop click
- "Set Up Remote Access" button visible when not fully configured

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix(remote): address issues found during visual verification"
```
