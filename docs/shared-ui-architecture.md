---
origin: youcoded-dev@1f60c2a:docs/shared-ui-architecture.md
---

> Migrated from youcoded-dev docs/PITFALLS.md (2026-07-15 triage). The path-scoped rules youcoded-dev/.claude/rules/{ipc-bridge,react-renderer}.md are the terse always-injected layer; this doc is the depth (incl. the overlay layer system).

# Shared UI Architecture

Desktop and Android render the **same React UI**. This is the most important architectural fact about YouCoded.

## How it works

- Source of truth: `youcoded/desktop/src/renderer/` (React app)
- Desktop: Electron hosts the React app natively
- Android: `ui/AppWebView.kt` loads the React build from bundled assets (`file:///android_asset/web/index.html`). The React bundle is generated from the desktop source via `scripts/build-web-ui.sh`.
- Android runs the desktop backend headlessly in a bundled Node process. Its page uses `remote-shim.ts` to connect to that backend over a loopback WebSocket with a per-run token and the port supplied by the shell. Desktop uses Electron IPC directly. See [Android runtime](android-runtime.md).
- Both platforms communicate via the **same JSON protocol** — the WebSocket transport and Electron IPC carry identical message shapes.

## Practical implication

Most features share both their UI and backend. Kotlin implements only phone-specific services such as the file picker, QR scanner, voice input and lifecycle. Check a feature's capabilities and channel policy rather than adding a second backend implementation in Kotlin. The Android page connected to its own backend is its local owner; an Android page paired to a computer is a remote visitor.

## Adding Cross-Platform Features (IPC Pattern)

1. **Contract:** add the request/response types in `desktop/src/shared/backend-contract.ts` (`ChannelTypes`) and the channel name in `IPC`.
2. **Shared handler:** add one `defineChannel` entry in `desktop/src/main/ipc/<family>.ts` and register its family in `channel-table.ts`. Both Electron and WebSocket requests use this entry; do not add separate feature handlers to `ipc-handlers.ts` or `remote-server.ts`.
3. **Desktop bridge:** expose the method in `desktop/src/main/preload.ts` as needed and regenerate its channel list with `node scripts/generate-preload-channels.mjs` from `desktop/`.
4. **Socket bridge:** expose the matching method in `desktop/src/renderer/remote-shim.ts`. Keep the shared `window.claude` interface consistent with preload.
5. **Policy and verification:** declare remote restrictions on the channel entry (`desktopOnly`, `remoteAllowed`, guards and refusal/reply shaping). Check `ipc-channels.test.ts`, `channel-table-complete.test.ts` and `generate-preload-channels.test.ts`.

Phone-only calls are separate: `invokeAndroidHost` communicates with `HostJsBridge.kt`. Add those calls to both sides and run `android-host-channels.test.ts`. Ordinary shared features need no Kotlin handler. The local-owner policy in `serveRemoteChannel` bypasses visitor restrictions, so use the capability contract to determine which interface a device can actually offer.

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

Both transports run the same channel handler. Where the socket transport needs a different wire shape, declare it on the entry with `remoteReply`/`remoteOnError` and normalize it in the shim so React sees the same shared API. The phone does not maintain a second set of Kotlin response serializers.

## Overlay Layer System

All popups, modals, drawers, and floating menus share a single set of theme-driven overlay tokens. This is how YouCoded keeps popup styling consistent across themes and avoids per-component hardcoded scrims/shadows/blur.

### Layers

| Layer | Name | z-scrim | z-content | Examples |
|-------|------|---------|-----------|----------|
| L0 | Content | — | — | App chrome (chat, header, input, status) |
| L1 | Drawer | 40 | 50 | SettingsPanel, CommandDrawer, ResumeBrowser |
| L2 | Popup | 60 | 61 | PreferencesPopup, ModelPickerPopup, ShareSheet, ThemeShareSheet, StatusBar WidgetConfigPopup, ShortcutsPopup |
| L3 | Critical | 70 | 71 | Destructive confirmations (DiscardConfirmDialog, DonateConfirm, ProjectView delete, ModelProvidersPopup, SyncPanel, ModelPickerPopup) |
| L4 | System | 100 | 100 | Toasts, always-visible indicators |

**A popup over a popup** (same layer) is lifted 2 per depth (`useOverlayDepth` / `stackLift` in `Overlay.tsx`, capped at 4 so it never reaches the next layer): its scrim then sits above the popup beneath, so the blur and dim cover it too (final-review#CT-8). `Dialog` does this for its scrim and panel; a bare `<Scrim>` registers its own depth. Pinned by `tests/dialog-shell.test.tsx`.

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
