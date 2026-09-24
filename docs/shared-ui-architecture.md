---
origin: youcoded-dev@1f60c2a:docs/shared-ui-architecture.md
---

> Migrated from youcoded-dev docs/PITFALLS.md (2026-07-15 triage). The path-scoped rules youcoded-dev/.claude/rules/{ipc-bridge,react-renderer}.md are the terse always-injected layer; this doc is the depth (incl. the overlay layer system).

# Shared UI Architecture

Desktop and Android render the **same React UI**. This is the most important architectural fact about YouCoded.

## How it works

- Source of truth: `youcoded/desktop/src/renderer/` (React app)
- Desktop: Electron hosts the React app natively
- Android: `WebViewHost.kt` loads the React build from bundled assets (`file:///android_asset/web/`). The React bundle is generated from the desktop source via `scripts/build-web-ui.sh`.
- Platform detection: `remote-shim.ts` checks `location.protocol === 'file:'` (Android) and routes IPC via WebSocket (`ws://localhost:9901`). Desktop uses Electron IPC directly.
- Both platforms communicate via the **same JSON protocol** — the WebSocket transport and Electron IPC carry identical message shapes.

## Practical implication

Most features work on both platforms automatically because the UI is shared. Only features requiring native Android APIs (camera, file picker, package bootstrap, tier selection) need Kotlin code. When evaluating feature gaps between platforms, check whether the IPC handler exists in `SessionService.handleBridgeMessage()` — the UI itself is shared.

## Adding Cross-Platform Features (IPC Pattern)

1. **React side** (`youcoded/desktop/src/renderer/remote-shim.ts`): Add method to `window.claude` using `invoke('type:name', payload)` (request-response) or `fire('type:name', payload)` (fire-and-forget)
2. **Desktop side** (`youcoded/desktop/src/main/ipc-handlers.ts`): Add `ipcMain.handle(IPC.CHANNEL, handler)` for request-response, or `ipcMain.on()` for fire-and-forget
3. **Android side** (`youcoded/app/.../runtime/SessionService.kt`): Add a `when` case in `handleBridgeMessage()` matching the same type string. Respond with `bridgeServer.respond(ws, msg.type, msg.id, payload)` if `msg.id` is present

Two more surfaces carry the same string on desktop: `youcoded/desktop/src/main/preload.ts` (the Electron `window.claude` + the `IPC` constant) and `youcoded/desktop/src/main/remote-server.ts` (the WebSocket host a remote browser talks to — its `default:` answers `{unsupported:true}`, so a channel skipped there is dead over remote). The message type string (e.g., `"skills:install"`) must be **identical across all five files**. `SessionService.handleBridgeMessage()` has a `when` branch per channel — hundreds; the workspace `ipc-bridge.md` rule carries the latest count.

## Critical parity requirement

`preload.ts` and `remote-shim.ts` must expose the **same shared `window.claude` shape**. If one has a shared API the other lacks, React components crash on that platform. When adding features, always update both.

### Intentional platform-exclusive namespaces

These are NOT parity violations — they're by design:
- **Electron only** (preload.ts): `window.claude.window` (minimize/maximize/close/onFullscreenChanged) — browser cannot do window control
- **Android only** (remote-shim.ts): `window.claude.android` — desktop doesn't need Android-specific APIs

## Protocol format

- Request: `{ "type": "...", "id": "msg-1", "payload": {...} }`
- Response: `{ "type": "...:response", "id": "msg-1", "payload": {...} }`
- Push event: `{ "type": "...", "payload": {...} }` (no id, broadcast)

## Response shape normalization

Desktop handlers return raw values (e.g., `string[]`). Android wraps in JSONObject (e.g., `{paths: [...]}`). The shim should normalize differences so React sees a consistent shape.

## Overlay Layer System

All popups, modals, drawers, and floating menus share a single set of theme-driven overlay tokens. This is how YouCoded keeps popup styling consistent across themes and avoids per-component hardcoded scrims/shadows/blur.

### Layers

| Layer | Name | z-scrim | z-content | Examples |
|-------|------|---------|-----------|----------|
| L0 | Content | — | — | App chrome (chat, header, input, status) |
| L1 | Drawer | 40 | 50 | SettingsPanel, CommandDrawer, ResumeBrowser |
| L2 | Popup | 60 | 61 | PreferencesPopup, ModelPickerPopup, ShareSheet, ThemeShareSheet, SkillEditor, StatusBar WidgetConfigPopup, ShortcutsPopup |
| L3 | Critical | 70 | 71 | Destructive confirmations (DiscardConfirmDialog, DonateConfirm, ProjectView delete, ModelProvidersPopup, SyncPanel, ModelPickerPopup) |
| L4 | System | 100 | 100 | Toasts, always-visible indicators |

**Exception:** `SessionStrip` dropdown lives at `z-[9000]`. It's load-bearing — `.header-bar`'s `backdrop-filter` creates a stacking context that would trap lower z-index values. Don't "fix" it. `OverflowMenu` also uses `z-[9000]`; `ProjectHero` moved to L4 and `ProjectView` is a `z-40` screen layer (the `z-[8000]` comment in App.tsx is stale).

**Popover escape tier:** a floating menu/panel *spawned from* one of those z-9000 hosts must render above its host, or it lands behind it and is unclickable. Use the named `POPOVER_Z` constant (`= 9001`) from `components/overlays/Overlay.tsx` — never a hand-rolled `9001`. `FolderSwitcher`'s panel and `ModelPicker` (its filter menu at `POPOVER_Z + 1`) use it directly; `Select` offers an `escapeHost` prop for the same case (no production caller today, so RuntimeBinding's dropdowns inside the SessionStrip new-session form). Because these popovers portal to `document.body`, host menus' `contains()` outside-click checks can't see them — they're marked (`data-folder-switcher-portal` / `data-select-portal`) so the host (and sibling Selects) don't close on a mousedown that actually landed inside the popover.

### Primitives

Use `<Scrim>` and `<OverlayPanel>` from `components/overlays/Overlay.tsx` instead of hardcoding. They wrap the `.layer-scrim` / `.layer-surface` CSS classes, set the correct z-index per layer, and emit the right `data-*` attributes.

```tsx
<Scrim layer={2} onClick={onClose} />
<OverlayPanel layer={2} destructive={false} className="...">
  {children}
</OverlayPanel>
```

For anchored popovers that don't need a scrim (dropdowns, context menus, info tooltips), use `.layer-surface` class directly — it still gets theme-driven background, border, shadow, and glass treatment.

### What the tokens do

Computed in `theme-engine.ts` from existing theme color tokens; no new manifest fields required:

- `--scrim`, `--scrim-heavy` — theme-tinted backdrop (derived from `canvas`, not cold `bg-black/40`)
- `--panels-opacity` / `--panels-blur` — emitted by `theme-engine.ts`; `.layer-surface` mixes `--panel` with `--panels-opacity` and blurs by `--panels-blur` (0 in reduced-effects mode). (`--overlay-bg`/`--overlay-blur` no longer exist; one stale comment in `globals.css` still names them.)
- `--shadow-strength` — adapts to theme lightness (stronger on light themes)
- `--destructive`, `--destructive-dim` — destructive-variant border/ring for L3

### Do NOT

- Do NOT hardcode `bg-black/40`, `bg-canvas/60`, `backdrop-blur-sm`, `shadow-xl`, or `rounded-xl` on popup surfaces — use `.layer-surface` / `<OverlayPanel>` so theme tokens drive it
- Do NOT pick arbitrary z-index values — pick a layer (1-4) and let the primitive set z-index
- Do NOT add `.layer-scrim` with its own background-color override — that defeats the theme tinting
