import { BrowserWindow, screen } from 'electron';
import type { WebContents } from 'electron';
import type { WindowRegistry } from './window-registry';
import { clampToWorkArea, MASCOT_SIZE, type Rect, type Point } from '../shared/buddy-geometry';
import type { DockEdge } from '../shared/buddy-dock';
import type { BuddyManager } from './buddy-manager';
import { IPC } from '../shared/types';

// WHY: Task 8's KWin script matches windows by title to apply keep-above —
// this string is the contract between that script and window creation, so it
// lives here (not inlined at the call site) to make the coupling visible.
export const OVERLAY_TITLE = 'YouCoded Buddy';

// WHY exported (not inlined in the class): main.ts's construction site needs
// the shape to build the deps object, and later tasks (4, 8) extend/consume
// individual fields (applyKeepAbove is a real KWin runner from Task 8 on).
export interface BuddyOverlayDeps {
  createOverlayWindow(opts: { width: number; height: number }): BrowserWindow;
  getPersisted(): { mascot: Point | null; dock: DockEdge | null; keepAbove: boolean };
  persist(state: { mascot: Point; dock: DockEdge | null }): void;
  registry: WindowRegistry;
  mainWindow: () => BrowserWindow | null;
  onStatusChanged(status: { dismissed: boolean; visible: boolean }): void;
  /** Task 8: wired at main.ts's construction site to a fire-and-forget call
   *  into kwin-keep-above.ts's applyKwinKeepAbove(OVERLAY_TITLE, true) —
   *  the real KWin scripting DBus runner. Silently does nothing on
   *  GNOME/wlroots/anywhere qdbus or the KWin scripting service is absent. */
  applyKeepAbove(win: BrowserWindow): void;
}

export interface OverlayInit {
  /** WINDOW-LOCAL: displayWorkArea offset by -displayBounds.x/y. The overlay
   *  window is constructed at exactly displayBounds size and position 0,0
   *  relative to itself, so this is the only work-area frame the renderer
   *  can use — getBounds()/getPosition() are stale/echoed on Wayland. */
  workArea: Rect;
  /** Window-local, pre-clamped into workArea, or null if nothing was
   *  persisted yet (renderer picks its own default position). */
  mascot: Point | null;
  dock: DockEdge | null;
}

/**
 * Pure payload builder for the overlay's boot geometry (served to the
 * renderer's `overlayReady()` pull via initPayloadForSender). Kept free of
 * Electron/window state so it's unit-testable without a display server —
 * see tests/buddy-overlay-manager.test.ts.
 *
 * Converts the (screen-absolute) persisted mascot position and the
 * (screen-absolute) display work area into the overlay window's own
 * coordinate frame, which is always displayBounds's top-left at (0,0)
 * because construct-at-size IS how the overlay is positioned (never
 * setPosition/maximize — see buddy-overlay-manager show()).
 */
export function overlayInitPayload(
  displayBounds: Rect,
  displayWorkArea: Rect,
  persisted: { mascot: Point | null; dock: DockEdge | null },
): OverlayInit {
  const workArea: Rect = {
    x: displayWorkArea.x - displayBounds.x,
    y: displayWorkArea.y - displayBounds.y,
    width: displayWorkArea.width,
    height: displayWorkArea.height,
  };
  const mascot = persisted.mascot
    ? clampToWorkArea(
        { x: persisted.mascot.x - displayBounds.x, y: persisted.mascot.y - displayBounds.y },
        MASCOT_SIZE,
        workArea,
      )
    : null;
  return { workArea, mascot, dock: persisted.dock };
}

/**
 * Translate a WINDOW-LOCAL point (the frame the overlay renderer works in —
 * see OverlayInit's doc comment above) to SCREEN-ABSOLUTE, the frame
 * buddy-positions.json is contracted to hold. Inverse of overlayInitPayload's
 * mascot conversion above.
 *
 * WHY this exists (coordinator review finding 2): the renderer only ever
 * knows window-local coordinates, but persistFromRenderer writes straight to
 * disk without converting — and overlayInitPayload's LOAD path (above)
 * unconditionally subtracts displayBounds.x/y, i.e. it assumes whatever it
 * reads back is screen-absolute. On any display whose bounds don't start at
 * (0,0) — a secondary monitor, or a primary monitor offset in a multi-monitor
 * layout — that mismatch drifted the mascot by the display's offset on every
 * restart, and corrupted the file's frame contract shared with the
 * three-window model (BuddyWindowManager), which persists screen-absolute
 * positions. Exported as a small pure function (not inlined at the
 * persistFromRenderer call site) so the translation is unit-testable without
 * spinning up a display server.
 */
export function localToScreenPoint(local: Point, displayBounds: Rect): Point {
  return { x: local.x + displayBounds.x, y: local.y + displayBounds.y };
}

/** The primary-display geometry an overlay window was built for. */
export interface DisplayGeometry {
  bounds: Rect;
  workArea: Rect;
  scaleFactor: number;
}

const rectsEqual = (a: Rect, b: Rect): boolean =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

// WHY this exists (2026-07-23 black-flash loop, probe-verified): on KWin
// Wayland, merely SHOWING a window fires display-metrics-changed with
// changedMetrics=[] and completely unchanged geometry — three times within
// 200ms of showInactive(). Rebuilding the overlay on every event therefore
// self-sustained (create -> spurious event -> destroy+recreate -> spurious
// event -> ...), flashing the whole screen black at ~2Hz until Electron hit
// a V8 fatal. The overlay only cares whether the geometry it was BUILT FOR
// went stale, so handleDisplayChange compares before rebuilding. Pure and
// exported for the pinning tests.
export function displayGeometryChanged(builtFor: DisplayGeometry, current: DisplayGeometry): boolean {
  return (
    builtFor.scaleFactor !== current.scaleFactor ||
    !rectsEqual(builtFor.bounds, current.bounds) ||
    !rectsEqual(builtFor.workArea, current.workArea)
  );
}

/**
 * One screen-sized, click-through-by-default BrowserWindow hosting the whole
 * buddy floater (mascot + chat + bar) as DOM, for platforms where Electron
 * cannot reposition windows (Linux Wayland — see chooseBuddyStrategy).
 *
 * Everywhere else (`BuddyWindowManager`) drags/docks the mascot by moving
 * BrowserWindows around the screen. That's not possible here, so:
 *   - the window is constructed AT the primary display's bounds and never
 *     moved — construct-at-size is the entire positioning mechanism;
 *   - all mascot drag/dock/peek logic moves into the renderer (DOM/CSS),
 *     which is why moveMascot/dragEnded below are no-ops on this class;
 *   - a display change (monitor plugged in, resolution change) can't be
 *     handled by resizing/repositioning either, so the fix is destroy +
 *     recreate at the new bounds (see handleDisplayChange).
 */
export class BuddyOverlayManager implements BuddyManager {
  private win: BrowserWindow | null = null;
  private dismissed = false;
  private viewedSessionId: string | null = null;
  // Debounces bursty display-metrics-changed/display-added/display-removed
  // events (e.g. a monitor hotplug fires several in quick succession) into
  // one destroy+recreate rather than rebuilding the renderer repeatedly.
  private recreateTimer: NodeJS.Timeout | null = null;
  // Geometry the current window was built for — the rebuild guard's baseline
  // (see displayGeometryChanged's WHY comment). Set by createWindow.
  private builtFor: DisplayGeometry | null = null;
  // Current input-region state — re-asserted on restore/show because Wayland
  // remaps drop it (see applyInputRegion's WHY comment).
  private interactive = false;

  constructor(private readonly deps: BuddyOverlayDeps) {
    // WHY these three (not the brief's literal 'display-metrics-changed' |
    // 'primary-display-changed'): Electron's Screen API (checked against the
    // installed v41 typings) has no 'primary-display-changed' event — it
    // never existed in the public API. 'display-metrics-changed' covers
    // resolution/scale/rotation changes; 'display-added'/'display-removed'
    // cover monitor hotplug, which is the actual "primary display changed"
    // case (unplugging the primary monitor, or plugging in a new one that
    // becomes primary) — together a strict superset of what the brief asked
    // to debounce.
    screen.on('display-metrics-changed', () => this.handleDisplayChange());
    screen.on('display-added', () => this.handleDisplayChange());
    screen.on('display-removed', () => this.handleDisplayChange());
  }

  private handleDisplayChange(): void {
    if (this.recreateTimer) clearTimeout(this.recreateTimer);
    this.recreateTimer = setTimeout(() => {
      this.recreateTimer = null;
      // Only rebuild while actually shown — a hidden overlay has nothing to
      // resize, and the next show() will read the current display anyway.
      if (!this.win || this.win.isDestroyed()) return;
      // Spurious-event guard (see displayGeometryChanged's WHY comment):
      // KWin Wayland fires display-metrics-changed just from showing a
      // window, with nothing actually changed. Rebuilding then would fire
      // more spurious events and loop forever, flashing the screen black.
      // Only rebuild when the geometry this window was built for is stale.
      const d = screen.getPrimaryDisplay();
      const current: DisplayGeometry = { bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor };
      if (this.builtFor && !displayGeometryChanged(this.builtFor, current)) return;
      const old = this.win;
      this.win = null;
      old.destroy();
      this.createWindow();
    }, 300);
  }

  /** Build (or rebuild) the overlay window at the primary display's current
   *  bounds and wire it up. Callers (show(), handleDisplayChange()) are
   *  responsible for having cleared `this.win` first. */
  private createWindow(): void {
    const primary = screen.getPrimaryDisplay();
    // Snapshot the geometry this window is being built for — the rebuild
    // guard in handleDisplayChange compares against exactly this.
    this.builtFor = { bounds: primary.bounds, workArea: primary.workArea, scaleFactor: primary.scaleFactor };
    const win = this.deps.createOverlayWindow({ width: primary.bounds.width, height: primary.bounds.height });
    this.win = win;
    // WHY preventDefault BEFORE setTitle (2026-07-23, found live): Electron
    // windows adopt the page's document.title on load, which CLOBBERED
    // OVERLAY_TITLE with the app's generic "YouCoded" — silently breaking
    // every caption-matched KWin integration (Task 8 keep-above matches
    // the exact caption 'YouCoded Buddy' and matched nothing).
    win.on('page-title-updated', (e) => e.preventDefault());
    win.setTitle(OVERLAY_TITLE);
    win.setAlwaysOnTop(true, 'screen-saver'); // harmless request; Task 8's applyKeepAbove does the real work
    // WHY immediately, before showInactive(): the overlay must NEVER eat
    // clicks by default. Setting this after showing would leave a window
    // that briefly swallows clicks the instant it appears.
    this.interactive = false;
    win.setIgnoreMouseEvents(true, { forward: true });
    // Wayland remaps (minimize→restore) get a fresh surface with NO input
    // region — re-assert ours or the overlay eats every desktop click.
    win.on('restore', () => this.applyInputRegion());
    win.on('show', () => this.applyInputRegion());
    const persisted = this.deps.getPersisted();
    // WHY it's fine that a toggle-time apply can fail transiently and leave
    // the CURRENT window's KWin keepAbove state stale (e.g. Settings' toggle
    // flips to "off" but a momentary DBus hiccup means the compositor never
    // got the unpin — see SettingsPanel.tsx's toggleKeepAbove for the fuller
    // reasoning on why the toggle doesn't try to detect/revert that): KWin's
    // keepAbove is a property of THIS window instance, not something that
    // persists across recreation. Every recreate constructs a brand-new
    // window that starts unpinned, and this guard is the only place
    // keepAbove ever gets (re)applied — so any stale pin/unpin state is
    // wiped the next time the overlay is torn down and rebuilt (display
    // change, or the next show() after a hide()), not accumulated forever.
    if (persisted.keepAbove) this.deps.applyKeepAbove(win);
    win.showInactive();
    // NOTE deliberately NO did-finish-load init push here (2026-07-23
    // dead-floater lesson): did-finish-load fires before React mounts —
    // in dev, before Vite even loads the module graph — so a one-shot push
    // sent here was dropped before the renderer could subscribe, and the
    // overlay rendered nothing forever. The renderer PULLS its init payload
    // instead (initPayloadForSender below, via IPC.BUDDY_OVERLAY_READY)
    // once it has actually mounted; a recreated window's fresh renderer
    // pulls again on its own mount, so the recreate path needs nothing here.
    // Mirrors BuddyWindowManager's crash handling: non-clean renderer exits
    // (crash, OOM, force-kill) tear the buddy down; clean exits (dev hot
    // reload) must NOT, or the buddy would vanish on every HMR reload.
    win.webContents.on('render-process-gone', (_evt, details) => {
      if (details.reason !== 'clean-exit') this.hide();
    });
    win.on('closed', () => {
      // Guard by identity: a display-change recreate destroys the old window
      // and immediately assigns a new one to `this.win` — if the old
      // window's 'closed' event fires after that reassignment, it must not
      // null out the NEW window's reference.
      if (this.win === win) this.win = null;
    });
  }

  show(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.showInactive();
      return;
    }
    this.createWindow();
    // Any show() clears "hidden until restart" — mirrors BuddyWindowManager
    // (Settings' "Show now" is just buddy.show()). The hide button (dismiss())
    // sets it after calling hide(), so this order is safe.
    this.dismissed = false;
    this.deps.onStatusChanged(this.getStatus());
  }

  getStatus(): { dismissed: boolean; visible: boolean } {
    return { dismissed: this.dismissed, visible: !!(this.win && !this.win.isDestroyed()) };
  }

  hide(): void {
    if (this.recreateTimer) { clearTimeout(this.recreateTimer); this.recreateTimer = null; }
    const win = this.win;
    this.win = null;
    if (win && !win.isDestroyed()) win.destroy();
    // Reset so a subsequent show() + setViewedSession(sameId) doesn't
    // early-return in setViewedSession and skip re-subscription — same
    // reasoning as BuddyWindowManager.hide().
    this.viewedSessionId = null;
    this.dismissed = false;
    this.deps.onStatusChanged(this.getStatus());
  }

  /** Hide-for-this-run (bar hide button). Preference untouched — the bar's
   *  hide button must NOT write the localStorage preference (PITFALLS). */
  dismiss(): void {
    this.hide();
    this.dismissed = true;
    this.deps.onStatusChanged(this.getStatus());
  }

  toggleChat(): void {
    // External callers only (e.g. tray/menu). Mascot clicks toggle the chat
    // renderer-local, since the whole floater is DOM inside this one window.
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send(IPC.BUDDY_OVERLAY_TOGGLE_CHAT);
    }
  }

  /** Move the overlay's session subscription from the previous session to
   *  the new one — identical dance to BuddyWindowManager.setViewedSession,
   *  just against the overlay's single webContents.id. */
  setViewedSession(sessionId: string): void {
    const prev = this.viewedSessionId;
    if (prev === sessionId) return;
    if (this.win && !this.win.isDestroyed()) {
      const wcId = this.win.webContents.id;
      if (prev) this.deps.registry.unsubscribe(prev, wcId);
      this.deps.registry.subscribe(sessionId, wcId);
    }
    this.viewedSessionId = sessionId;
  }

  getViewedSession(): string | null {
    return this.viewedSessionId;
  }

  // WHY no-op: the three-window model uses attention-needed to drive the
  // dock/peek state machine's forced "come out and stay" (buddy-dock.ts
  // engage/disengage), which exists because a peeking mascot is parked off-
  // screen at an edge and has to be dragged back into view by moving its
  // BrowserWindow. The overlay's mascot is DOM inside an always-full-screen
  // window — there's no window-level "pop out"; if attention visuals need
  // to react, that's a renderer-side concern for a later task to wire.
  setAttentionNeeded(_needed: boolean): void {}

  isBuddyWindow(win: BrowserWindow): boolean {
    return win === this.win;
  }

  captureWindows(): BrowserWindow[] {
    return this.win && !this.win.isDestroyed() ? [this.win] : [];
  }

  chatWebContents(): WebContents | null {
    return this.win && !this.win.isDestroyed() ? this.win.webContents : null;
  }

  // WHY a public method rather than exposing `deps.persist` directly: `deps`
  // is a private constructor param, so main.ts's IPC handler (which only
  // holds a `BuddyManager` reference, not this class's internals) has no
  // other way to reach it. This just forwards to the same persist function
  // the class already uses internally — no second storage location.
  persistFromRenderer(state: { mascot: Point; dock: DockEdge | null }): void {
    // WHY translate here (coordinator review finding 2): `state.mascot` comes
    // from the renderer, which only ever knows window-local coordinates (see
    // OverlayInit's doc comment) — but buddy-positions.json must stay
    // screen-absolute, the one frame contract shared with the three-window
    // model. The overlay is always constructed at the CURRENT primary
    // display's bounds (createWindow above), so that's the same display to
    // translate against here; overlayInitPayload's did-finish-load call site
    // likewise re-reads screen.getPrimaryDisplay() rather than trusting a
    // stale snapshot, for the same reason.
    const bounds = screen.getPrimaryDisplay().bounds;
    this.deps.persist({ mascot: localToScreenPoint(state.mascot, bounds), dock: state.dock });
  }

  /** Renderer pull for its boot geometry (IPC.BUDDY_OVERLAY_READY handler).
   *  Sender-guarded like the other overlay channels: only the live overlay
   *  window's own webContents gets a payload — anything else gets null. */
  initPayloadForSender(sender: Electron.WebContents): OverlayInit | null {
    if (!this.win || this.win.isDestroyed() || this.win.webContents !== sender) return null;
    // Read the display and persisted state fresh at pull time — the renderer
    // may mount well after window construction, and a display change or a
    // persist could have happened in between.
    const display = screen.getPrimaryDisplay();
    const persisted = this.deps.getPersisted();
    return overlayInitPayload(display.bounds, display.workArea, {
      mascot: persisted.mascot,
      dock: persisted.dock,
    });
  }

  setInteractive(interactive: boolean): void {
    this.interactive = interactive;
    this.applyInputRegion();
  }

  // WHY a separate re-appliable method (2026-07-23, found live): on Wayland,
  // minimize→restore gives the window a NEW wl_surface, and Chromium does
  // not re-apply the empty input region to it — a restored overlay silently
  // becomes a full-screen click-eater (the overlay has a taskbar entry on
  // Wayland because skipTaskbar is a no-op there, so users CAN minimize it).
  // Re-asserting on 'restore'/'show' keeps the failure direction safe.
  private applyInputRegion(): void {
    if (!this.win || this.win.isDestroyed()) return;
    if (this.interactive) {
      this.win.setIgnoreMouseEvents(false);
    } else {
      this.win.setIgnoreMouseEvents(true, { forward: true });
    }
  }

  // WHY no-op: per-frame BrowserWindow.setPosition dragging is the
  // three-window model's mechanism (see BuddyWindowManager.moveMascot). The
  // overlay is one screen-sized window that's never repositioned — the
  // mascot moves via DOM/CSS transform inside it, driven entirely by the
  // renderer, so main never needs a per-frame drag target here.
  moveMascot(_targetX: number, _targetY: number): void {}
  moveMascotFromPointer(_localDx: number, _localDy: number): void {}

  // WHY no-op: see moveMascot — drag-release snap detection also has to
  // live renderer-side for the overlay model, since there's no per-mascot
  // BrowserWindow bounds for main to read edge proximity from.
  dragEnded(): void {}
}
