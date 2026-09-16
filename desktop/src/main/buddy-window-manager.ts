import { BrowserWindow, screen, type Display } from 'electron';
import type { WindowRegistry } from './window-registry';
import {
  BAR_SIZE, MASCOT_SIZE, CHAT_SIZE, computeBarPosition, computeGroupLayout,
  mascotXRangeForChat, type GroupLayout,
} from './buddy-bar-geometry';
import { BarVisibilityTracker } from './buddy-bar-visibility';
import {
  dockReducer, detectSnapEdge, dockPosition, FREE_DOCK, SNAP_THRESHOLD_PX,
  type DockState, type DockEvent, type DockEdge,
} from './buddy-dock';
// Rect/Point/Size/clampToWorkArea used to be DEFINED in this file; they now
// live in src/shared/buddy-geometry.ts so the renderer overlay window can use
// them too (renderer code can never import from src/main/, which pulls in
// electron). Imported here for this file's own use, and re-exported below so
// every existing `from './buddy-window-manager'` import keeps working.
import { clampToWorkArea, type Rect, type Point, type Size } from '../shared/buddy-geometry';
// The rename channel that moves buddy windows on native-Wayland Linux, where
// the app is not allowed to move its own windows. buddy-caption.ts has the WHY.
import { buildCaption, type BuddyRole } from '../shared/buddy-caption';
// WHY: `implements BuddyManager` is compile-time proof this class still
// satisfies the shape main.ts depends on after the capture/attach refactor.
import type { BuddyManager } from './buddy-manager';

// Push-channel names (kept as local consts — this module deliberately doesn't
// import shared/types; values must match IPC.* in src/shared/types.ts).
const IPC_BAR_STATE = 'buddy:bar-state';
const IPC_CHAT_STATE = 'buddy:chat-state';
const IPC_MASCOT_STATE = 'buddy:mascot-state';

// How close (px) the raw drag target must get to a screen edge, WITH the chat
// open, to read as "put him away" — close the chat and peek. Deliberately much
// smaller than SNAP_THRESHOLD_PX: the chat-open x-pin already parks the mascot
// ~17px off the left edge, so a 24px test would fire on ordinary positioning.
const PEEK_PAST_EDGE_PX = 6;

// How long after the buddy stops moving before his position is written to disk.
// The same 300ms the old (Wayland-dead) 'move' listener used — see persistMascot.
const POSITION_SAVE_DEBOUNCE_MS = 300;

// The size of each buddy window, by role. These are the very constants the
// BrowserWindows are built with, which is what makes it safe for rectOf() to
// report a window's rectangle without asking the OS for it.
const ROLE_SIZE: Record<BuddyRole, Size> = {
  mascot: MASCOT_SIZE,
  chat: CHAT_SIZE,
  bar: BAR_SIZE,
};

export { clampToWorkArea } from '../shared/buddy-geometry';
export type { Rect, Point, Size } from '../shared/buddy-geometry';

// Window sizes + all position math live in buddy-bar-geometry.ts (pure,
// unit-tested); main.ts imports the same constants so the BrowserWindow
// dimensions and the positioning math can't drift.

/**
 * Where the buddy is allowed to sit on a given screen — the screen minus
 * whatever the desktop reserves (the Plasma panel, a dock, a taskbar).
 *
 * WHY this is handed in rather than read from Electron: on native-Wayland Linux
 * Electron's own answer is the WHOLE screen. Measured 2026-09-04 — Electron
 * reported 1707x1067 while KDE had reserved 52 px at the bottom for the
 * taskbar. Using Electron's number parks the buddy ON TOP of the clock and
 * system tray, and because the app never gets told where the compositor really
 * put him, nothing ever corrects it. buddy-work-area.ts asks the desktop
 * directly and answers here.
 *
 * Structural on purpose: WorkAreaResolver satisfies it, and a test can hand in
 * a fake with no compositor anywhere.
 */
export interface BuddyWorkAreaSource {
  /** True once a lookup has finished — NOT "the answer is a real one". */
  readonly ready: boolean;
  /** Ask the desktop again. Never rejects: a failed lookup is a fallback rectangle. */
  refresh(): Promise<void>;
  areaFor(display: Display): { rect: Rect; resolved: boolean };
}

export interface BuddyWindowManagerDeps {
  createBuddyWindow(
    variant: 'mascot' | 'chat' | 'bar',
    opts: {
      x: number;
      y: number;
      /**
       * The window's NAME at construction — set only on native-Wayland Linux,
       * where the name is how the window gets positioned at all (see
       * buddy-caption.ts).
       *
       * WHY it must be in the constructor and cannot be set a moment later: the
       * helper inside the compositor decides whether to watch a window the
       * instant that window appears. A window that appears nameless is never
       * watched, so the buddy would show up and then refuse to move — the exact
       * symptom this whole feature exists to remove.
       */
      title?: string;
    },
  ): BrowserWindow;
  getPersistedPosition(key: 'mascot'): Point | null;
  setPersistedPosition(key: 'mascot', pos: Point): void;
  /** Persisted dock edge (buddy-positions.json `dock` key) so a docked/peeking
   *  buddy is still docked after a restart (spec §6.1). */
  getPersistedDock(): DockEdge | null;
  setPersistedDock(edge: DockEdge | null): void;
  registry: WindowRegistry;
  mainWindow: () => BrowserWindow | null;
  /** Broadcast { dismissed, visible } to all windows (buddy:status-changed). */
  onStatusChanged(status: { dismissed: boolean; visible: boolean }): void;
  /**
   * Supplied ONLY on native-Wayland Linux. Absent everywhere else — Windows,
   * macOS, Linux/X11, and a Wayland desktop running this app through XWayland
   * all keep Electron's own work area, byte-for-byte what they use today.
   */
  workArea?: BuddyWorkAreaSource;
  /**
   * True when the app cannot move its own windows AND the KWin helper is
   * installed and running, so renaming a window is what moves it.
   *
   * Must answer instantly — it is asked on every frame of a drag — so whoever
   * supplies it caches the helper's status instead of re-checking it here.
   * Absent (or false) means every position is applied the ordinary way, which
   * is what every other platform does and must keep doing.
   */
  captionChannelLive?: () => boolean;
}

/**
 * Owns the buddy mascot + chat BrowserWindows, their positions, and the
 * session-subscription handoff when the chat switches sessions.
 *
 * Lifecycle:
 *   - `show()` creates (or re-shows) the mascot window, clamped to a visible
 *     workArea so a saved position from a disconnected monitor can't hide it.
 *   - `toggleChat()` lazily creates the chat window on first click; subsequent
 *     toggles hide/show the same window (state preserved between toggles).
 *   - `hide()` destroys both windows.
 *   - Window crashes (`render-process-gone`) trigger `hide()` — user re-enables via settings.
 */
export class BuddyWindowManager implements BuddyManager {
  private mascot: BrowserWindow | null = null;
  private chat: BrowserWindow | null = null;
  // 3-button action-bar window pinned below the mascot while the chat is
  // open. Hidden (not destroyed) on chat-close so toggling doesn't rebuild
  // the renderer every time.
  private bar: BrowserWindow | null = null;
  private viewedSessionId: string | null = null;
  // Decides bar visibility — chat-open only, as of Destin's 2026-07-16 pass
  // (see buddy-bar-visibility.ts for why hover no longer reveals it). The bar
  // BrowserWindow stays shown once created; reveals are CSS fades driven by
  // the buddy:bar-state push, and click-through is toggled alongside so the
  // invisible bar never eats clicks meant for windows underneath.
  private readonly barVisibility = new BarVisibilityTracker((visible) => this.applyBarVisible(visible));
  private barCssVisible = false;
  // "Hide until restart": set by the bar's hide button (buddy:dismiss), cleared
  // by any show(). localStorage['youcoded-buddy-enabled'] is untouched — the
  // preference stays on; only this run's windows go away. (spec §7)
  private dismissed = false;
  // Dock/peek state machine (spec §6) — pure reducer in buddy-dock.ts; this
  // class owns the timers, the windows, and the persistence.
  private dockState: DockState = FREE_DOCK;
  private glideTimer: NodeJS.Timeout | null = null;
  private attentionNeeded = false;
  /**
   * Where this app believes each of its three buddy windows is. The app owns
   * these numbers now — it does not ask the OS for them.
   *
   * WHY: on native-Wayland Linux the OS refuses to answer honestly. Measured
   * 2026-09-04 — after four moves through the rename channel, asking Electron
   * where the window was still returned 0,0 every single time. Every read that
   * used to ask (where a snap animation starts from, where the chat opens, where
   * the button bar hangs, what gets saved for next launch) would have frozen at
   * the position the window was born at. So the app remembers instead.
   */
  private readonly pos: Record<BuddyRole, Point> = {
    mascot: { x: 0, y: 0 },
    chat: { x: 0, y: 0 },
    bar: { x: 0, y: 0 },
  };
  // A show() that is waiting on the usable-screen-area lookup. Cleared by
  // hide(), so switching the buddy off during that wait doesn't bring him back.
  private pendingShow = false;
  // True once that wait has been paid, whatever it produced. The wait happens
  // AT MOST ONCE per run: it exists so the first buddy of a session isn't placed
  // against a number we haven't got yet, and if the lookup somehow never
  // finishes, a buddy in slightly the wrong place beats no buddy at all.
  private workAreaAwaited = false;
  // True between the first frame of a drag and its release. Used only to re-ask
  // for the usable screen area once per gesture instead of once per frame.
  private dragging = false;
  /**
   * Save the mascot's position, 300ms after he stops moving.
   *
   * WHY this moved off Electron's "the window moved" event: that event NEVER
   * FIRES for a move the compositor made (measured 2026-09-04 — four moves,
   * zero events), so on Linux the buddy's position was silently never saved and
   * he came back in the corner every launch. Saving from place(), the one place
   * a buddy window is ever moved, works on every platform.
   */
  private readonly persistMascot = debounce(() => {
    this.deps.setPersistedPosition('mascot', { ...this.pos.mascot });
  }, POSITION_SAVE_DEBOUNCE_MS);

  constructor(private readonly deps: BuddyWindowManagerDeps) {}

  // ——— one write path, one read path, one work-area path ————————————————
  // Everything in this block exists so that "where is the buddy" and "move the
  // buddy" each happen in exactly ONE place, and that place can behave
  // differently on native-Wayland Linux without any of the code below knowing.

  /** True when moving a window means renaming it (native-Wayland Linux with the
   *  helper running). False on every other platform, always. */
  /**
   * MUST NOT flip from true to false while buddy windows exist. A false→true
   * flip is self-healing (place() writes this.pos on both branches, so the next
   * rename moves the window to the owned coordinates), but true→false makes
   * rectOf start returning getBounds(), which on Wayland is frozen at the
   * constructor position — the chat and bar would then re-anchor to the corner
   * while the mascot stays put. What guarantees it: removing the helper forces
   * the buddy off (design §6, R4 — no helper, no buddy), so no window survives
   * the flip.
   */
  private captionLive(): boolean {
    return this.deps.captionChannelLive?.() === true;
  }

  /** Which of the three windows this is, or null when it isn't one of ours. */
  private roleOf(win: BrowserWindow): BuddyRole | null {
    if (win === this.mascot) return 'mascot';
    if (win === this.chat) return 'chat';
    if (win === this.bar) return 'bar';
    return null;
  }

  /**
   * Where a buddy window is, as a full rectangle.
   *
   * A rectangle rather than just a point because six of the nine reads this
   * replaced pass the whole rectangle onward — to "which monitor is this on",
   * to the docking maths, to the button-bar placement.
   *
   * On every platform that answers honestly this still asks the OS, so nothing
   * whatsoever changes for Windows, macOS or Linux/X11. Only when the rename
   * channel is in use — where the OS is known to lie — does it report what the
   * app itself last asked for.
   */
  private rectOf(win: BrowserWindow): Rect {
    const role = this.roleOf(win);
    // Not one of our three windows, so there is nothing owned to report.
    if (!role) return win.getBounds();
    if (!this.captionLive()) {
      const b = win.getBounds();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    }
    return { ...this.pos[role], ...ROLE_SIZE[role] };
  }

  /** The usable rectangle of one screen — see BuddyWorkAreaSource. */
  private workAreaFor(display: Display): Rect {
    const source = this.deps.workArea;
    if (!source) return display.workArea; // sanctioned-raw-work-area
    return source.areaFor(display).rect;
  }

  /** The usable rectangle of the main screen. */
  private primaryWorkArea(): Rect {
    return this.workAreaFor(screen.getPrimaryDisplay());
  }

  /**
   * Build one of the three buddy windows at a position.
   *
   * On native-Wayland Linux the window's NAME is what positions it, so creating
   * the window and placing it are one act — see BuddyWindowManagerDeps. Before
   * this, all three windows were built with plain x/y coordinates that Wayland
   * ignores exactly as it ignores a later move, so all three appeared wherever
   * KWin happened to drop them.
   */
  private create(role: BuddyRole, at: Point): BrowserWindow {
    const x = Math.round(at.x);
    const y = Math.round(at.y);
    this.pos[role] = { x, y };
    const title = this.captionLive() ? buildCaption(role, x, y) : undefined;
    return this.deps.createBuddyWindow(role, { x, y, title });
  }

  /**
   * Move one of the three buddy windows. THE ONLY place a buddy window is ever
   * moved — every drag frame, every snap, every dock, every chat re-anchor.
   *
   * Two ways to move a window, one decision made here:
   *  - Ordinary desktops: ask the OS to move it, exactly as before.
   *  - Native-Wayland Linux with the helper: rename the window, and the helper
   *    running inside the compositor moves it. Asking the OS there does nothing
   *    at all, and the OS does not even report the failure.
   */
  private place(role: BuddyRole, win: BrowserWindow | null, at: Point): void {
    if (!win || win.isDestroyed()) return;
    // REFUSE a non-finite coordinate; do not substitute one. 0 is the CORNER of
    // the screen, not a neutral value, and this writes `this.pos` — so a single
    // NaN arriving from the renderer's drag payload (main.ts forwards it
    // unvalidated, and clampToWorkArea propagates NaN through Math.min/max
    // rather than absorbing it) would park the buddy in the top-left and
    // corrupt the app's own idea of where he is, permanently, with no error.
    // On the old setPosition path Electron threw instead — loud, and the stored
    // position survived. Skipping one frame of a drag is invisible; teleporting
    // to the corner and staying there is the exact "stuck" symptom this whole
    // feature exists to remove.
    if (!Number.isFinite(at.x) || !Number.isFinite(at.y)) return;
    // Whole pixels only: a finger on a 150%-scaled display reports fractions,
    // and Electron throws on a fractional window coordinate.
    const x = Math.round(at.x);
    const y = Math.round(at.y);
    this.pos[role] = { x, y };
    if (this.captionLive()) win.setTitle(buildCaption(role, x, y));
    else win.setPosition(x, y);
    // Only the mascot's position is remembered between runs; the chat and the
    // bar are always re-anchored to him when they open.
    if (role === 'mascot') this.persistMascot();
  }

  /**
   * Ask the desktop for the usable screen area again, at the start of a gesture.
   *
   * WHY here, and not on a timer or an event: moving the taskbar or setting it
   * to auto-hide fires NO event an app can hear — there is nothing to subscribe
   * to (checked 2026-09-04: the desktop's own strut service publishes zero
   * signals). The cheapest honest moment to re-ask is when the user starts
   * moving the buddy.
   *
   * The answer arrives asynchronously, so A DRAG RUNS ON THE RECTANGLE THAT WAS
   * CACHED WHEN IT STARTED. That is intended, and it is written down here so it
   * is not rediscovered later as a bug. Every per-frame read is a pure read of
   * that cache; nothing in a drag frame talks to the desktop.
   */
  private refreshWorkArea(): void {
    const source = this.deps.workArea;
    if (!source) return;
    void source.refresh().catch(() => { /* never rejects; a failed lookup is a fallback rectangle */ });
  }

  private dispatchDock(event: DockEvent): void {
    const next = dockReducer(this.dockState, event);
    if (next.mode === this.dockState.mode && next.edge === this.dockState.edge) return;
    this.dockState = next;
    this.deps.setPersistedDock(next.mode === 'free' ? null : next.edge);
    this.pushMascotState();
  }

  /** Reconcile the dock with the reasons the buddy has to stay out: an open
   *  chat, or something needing attention. Anything that changes either calls
   *  this rather than dispatching engage/disengage itself, so the two reasons
   *  can't fight (closing the chat while attention is pending must NOT sink him). */
  private syncEngagement(): void {
    const engaged = this.barVisibility.wantsVisible() || this.attentionNeeded;
    this.dispatchDock({ type: engaged ? 'engage' : 'disengage' });
    // Self-heal the peek position. `peeking` is only guaranteed flush-to-edge
    // when moveMascot's live drag-peek enters it (it sets the window flush in
    // the same step). Reaching `peeking` via disengage — chat closed, or
    // attention cleared — only changes the POSE; if opening the chat had
    // pushed the mascot off his edge to make room (computeGroupLayout tier-3
    // bounce), he'd otherwise lean + grip in mid-air with no screen edge under
    // him (Destin 2026-07-17: "peek occasionally hangs off of nothing").
    this.reconcilePeekPosition();
  }

  /** Glide a peeking mascot flush against his dock edge if he isn't already.
   *  No-op unless the state is `peeking` (free/docked own their positions) and
   *  he's actually off the edge — the common left-edge case opens the chat to
   *  his free side and never moves him, so this costs nothing there. */
  private reconcilePeekPosition(): void {
    const { mode, edge } = this.dockState;
    if (mode !== 'peeking' || !edge) return;
    if (!this.mascot || this.mascot.isDestroyed()) return;
    const mb = this.rectOf(this.mascot);
    const display = screen.getDisplayMatching(mb) ?? screen.getPrimaryDisplay();
    const flush = dockPosition(edge, { x: mb.x, y: mb.y }, MASCOT_SIZE, this.workAreaFor(display));
    if (Math.round(mb.x) === Math.round(flush.x) && Math.round(mb.y) === Math.round(flush.y)) return;
    this.glideGroup(flush);
  }

  private pushMascotState(): void {
    if (this.mascot && !this.mascot.isDestroyed()) {
      this.mascot.webContents.send(IPC_MASCOT_STATE, this.dockState);
    }
  }

  /** Called by main.ts from the attention aggregation broadcast — attention
   *  pops a peeking buddy out and holds him there until it clears (spec §6.2). */
  setAttentionNeeded(needed: boolean): void {
    if (needed === this.attentionNeeded) return;
    this.attentionNeeded = needed;
    this.syncEngagement();
  }

  /** buddy:drag-ended — run snap detection against final window bounds, then
   *  settle the whole group. */
  dragEnded(): void {
    if (!this.mascot || this.mascot.isDestroyed()) return;
    // The gesture is over; the next one re-asks for the usable screen area.
    this.dragging = false;
    const mb = this.rectOf(this.mascot);
    const display = screen.getDisplayMatching(mb) ?? screen.getPrimaryDisplay();
    // Peek is a chat-CLOSED state. While the chat is open the mascot is x-pinned
    // ~17px off the left edge (and y-free on top/bottom), which used to false-
    // snap into peek at a non-flush spot on release — and that inconsistent
    // "peeking + chat open" state then survived closing the chat (Destin
    // 2026-07-17). Putting him away now goes through the shove-past-edge path in
    // moveMascot, which closes the chat first; so if the chat is STILL open on
    // release, never peek — just settle the pair back onto its layout.
    const chatOpen = !!(this.chatOpenIntent && this.chat && !this.chat.isDestroyed());
    const edge = chatOpen ? null : detectSnapEdge({ x: mb.x, y: mb.y }, MASCOT_SIZE, this.workAreaFor(display));
    this.dispatchDock({ type: 'drag-release', snapEdge: edge });
    // Glide even when nothing snapped (the mascot then stays put): the
    // satellites still need to settle back onto their anchors. While dragging
    // they only track the mascot's delta and clamp at the workArea edges, so a
    // drag toward an edge leaves the chat out of position — possibly overlapping
    // the mascot, or on the side it no longer fits. Release is the natural
    // moment to reconcile that, and glideGroup animates it rather than teleporting.
    const target = edge
      ? dockPosition(edge, { x: mb.x, y: mb.y }, MASCOT_SIZE, this.workAreaFor(display))
      : { x: mb.x, y: mb.y };
    this.glideGroup(target);
  }

  /**
   * The one sanctioned window-bounds animation (spec §6.1): a short eased
   * settle at the end of a drag. Moves the mascot to `mascotTarget` and both
   * satellites to the anchors that target implies, on a SINGLE timer so they
   * arrive together and read as one object. Canceled by any new drag.
   *
   * WHY the satellites are in here: this used to be a mascot-only `glideTo`,
   * so an edge snap left the chat behind by up to SNAP_THRESHOLD_PX and the
   * bar teleported into place at the end. Anything that moves the mascot must
   * move what hangs off it, which is why every movement path routes through
   * one helper now (2026-07-16).
   *
   * Anchors are derived from where the mascot is GOING, not where it is — the
   * satellites must aim at their final homes, not chase the mascot's old ones.
   */
  private glideGroup(mascotTarget: Point, ms = 200): void {
    if (this.glideTimer) { clearInterval(this.glideTimer); this.glideTimer = null; }
    const win = this.mascot;
    if (!win || win.isDestroyed()) return;

    // Gate on the INTENT to have the chat open, not live isVisible() — during
    // the 140ms close fade the window is still shown but chatOpenIntent is
    // already false, and a reconcile-to-peek glide must move ONLY the mascot
    // (leaving the fading chat to fade in place), not chase it to layout.mascot.
    const chatVisible = !!(this.chatOpenIntent && this.chat && !this.chat.isDestroyed() && this.chat.isVisible());
    const layout = this.layoutFor({ ...mascotTarget, ...MASCOT_SIZE });
    // The mascot only gets pushed back to the pinned distance while the chat is
    // OPEN. With the chat closed the buddy is free to sit anywhere, including
    // the band where a chat couldn't fit — shoving him out of it would be a
    // baffling drag that refuses to end where you dropped it.
    const mascotFinal = chatVisible ? layout.mascot : mascotTarget;
    const finalRect: Rect = { ...mascotFinal, ...MASCOT_SIZE };

    // Each leg carries its role so every animation step can go through place(),
    // the single write path.
    const legs: Array<{ role: BuddyRole; win: BrowserWindow; from: Point; to: Point }> = [];
    const addLeg = (role: BuddyRole, w: BrowserWindow | null, to: Point) => {
      if (!w || w.isDestroyed()) return;
      const { x, y } = this.rectOf(w);
      // Skip windows already home — a plain click (no drag, no snap) must not
      // spin up a timer that repositions three windows onto themselves.
      if (Math.round(x) === Math.round(to.x) && Math.round(y) === Math.round(to.y)) return;
      legs.push({ role, win: w, from: { x, y }, to });
    };
    addLeg('mascot', win, mascotFinal);
    if (chatVisible) addLeg('chat', this.chat, layout.chat);
    // Bar follows its CSS visibility, not Electron's — see moveMascot.
    if (this.bar && !this.bar.isDestroyed() && this.barCssVisible) {
      addLeg('bar', this.bar, this.currentBarPosition(finalRect));
    }
    if (legs.length === 0) return;

    const t0 = Date.now();
    this.glideTimer = setInterval(() => {
      const t = Math.min(1, (Date.now() - t0) / ms);
      const ease = 1 - Math.pow(1 - t, 3);
      let alive = false;
      for (const leg of legs) {
        if (leg.win.isDestroyed()) continue;
        alive = true;
        this.place(leg.role, leg.win, {
          x: leg.from.x + (leg.to.x - leg.from.x) * ease,
          y: leg.from.y + (leg.to.y - leg.from.y) * ease,
        });
      }
      if (t >= 1 || !alive) {
        if (this.glideTimer) clearInterval(this.glideTimer);
        this.glideTimer = null;
      }
    }, 16);
  }

  /**
   * Keep the buddy and his buttons ABOVE the chat panel.
   *
   * All three windows sit at the same 'screen-saver' always-on-top level, so
   * their order within that band is just whoever was shown last — and every
   * chat toggle calls chat.show(), which raises it over the bar (the bar window
   * is created once and never hidden, so it never re-raises). You could only see
   * it when the chat slid past during an above/below flip: the mascot stayed on
   * top but the buttons went behind (Destin 2026-07-17).
   *
   * It also has to hold for the negative above-gap in computeGroupLayout, which
   * deliberately overlaps the chat with the mascot's transparent headroom.
   *
   * moveTop() does not focus, so this is safe immediately after chat.show().
   * Bar first, then the mascot, so the buddy himself ends up highest.
   */
  private raiseSatellites(): void {
    if (this.bar && !this.bar.isDestroyed() && this.bar.isVisible()) this.bar.moveTop();
    if (this.mascot && !this.mascot.isDestroyed() && this.mascot.isVisible()) this.mascot.moveTop();
  }

  private applyBarVisible(visible: boolean): void {
    this.barCssVisible = visible;
    if (visible) {
      // Reposition-before-reveal: mascot may have moved while the bar was
      // hidden (the Task 3 bug class — never show at a stale position).
      this.showBar();
      const bar = this.bar;
      if (bar && !bar.isDestroyed()) {
        bar.setIgnoreMouseEvents(false);
        bar.webContents.send(IPC_BAR_STATE, { visible: true });
      }
    } else {
      const bar = this.bar;
      if (bar && !bar.isDestroyed()) {
        bar.webContents.send(IPC_BAR_STATE, { visible: false });
        // Let the CSS fade finish, then make the window click-through so the
        // invisible bar doesn't eat clicks meant for whatever is underneath.
        // (forward:true kept mousemove flowing to the page back when hover could
        // re-summon the bar; the bar now opens only with the chat and nothing
        // reads hover, so no forwarding is needed.)
        setTimeout(() => {
          if (this.bar && !this.bar.isDestroyed() && !this.barCssVisible) {
            this.bar.setIgnoreMouseEvents(true);
          }
        }, 180);
      }
    }
  }


  /**
   * NOTE ON TIMING: this returns before the mascot exists. When a work-area
   * source is supplied and has not settled, construction is deferred onto
   * refresh() — so on a slow KDE login (plasmashell has not yet claimed the bus
   * name, and the resolver retries with 150 ms + 450 ms of backoff) the buddy
   * can appear up to about 700 ms after BUDDY_SHOW has already resolved. A
   * getStatus() in that window reports visible:false; onStatusChanged is what
   * settles the settings row. Deliberate — design §0.6 forbids constructing a
   * window against an unresolved work area, because there is no readback to
   * correct it afterwards — but undocumented until now, and it reads as a hang.
   */
  show(): void {
    if (this.mascot && !this.mascot.isDestroyed()) {
      this.mascot.showInactive();
      return;
    }
    // WAIT FOR THE USABLE SCREEN AREA BEFORE BUILDING THE FIRST WINDOW.
    //
    // WHY this gate exists: the buddy's resting place is measured up from the
    // bottom of the usable screen, and on native-Wayland Linux that number has
    // to be fetched from the desktop, which takes a few milliseconds. Build the
    // window before it arrives and the very first buddy a user ever sees sits
    // 52 px too low — standing on the taskbar, covering the clock — and because
    // the app never gets told where the compositor really put him, NOTHING EVER
    // CORRECTS IT. If he never drags the buddy, it is wrong all session.
    //
    // Every other platform hands in no work-area source at all, so this whole
    // branch is skipped and show() stays synchronous exactly as it is today.
    const area = this.deps.workArea;
    if (area) {
      if (!area.ready && !this.workAreaAwaited) {
        if (this.pendingShow) return;
        this.pendingShow = true;
        void area
          .refresh()
          .catch(() => { /* never rejects; an unresolved area falls back, it does not fail */ })
          .then(() => {
            this.workAreaAwaited = true;
            // hide() during the wait means the user switched him off — don't
            // bring him back.
            if (!this.pendingShow) return;
            this.pendingShow = false;
            this.show();
          });
        return;
      }
      // Already looked up: re-ask in the background, because the taskbar may
      // have moved or gone auto-hidden since and nothing announces that.
      this.refreshWorkArea();
    }
    this.pendingShow = false;
    const saved = this.deps.getPersistedPosition('mascot');
    const primary = this.primaryWorkArea();
    const defaultPos = { x: primary.x + primary.width - MASCOT_SIZE.width - 24, y: primary.y + primary.height - MASCOT_SIZE.height - 24 };
    const raw = saved ?? defaultPos;
    // getDisplayMatching picks the display containing the window's bounds;
    // if the saved position is off-screen entirely, fall back to primary.
    const display = screen.getDisplayMatching({ ...raw, ...MASCOT_SIZE }) ?? screen.getPrimaryDisplay();
    const clamped = clampToWorkArea(raw, MASCOT_SIZE, this.workAreaFor(display));
    this.mascot = this.create('mascot', clamped);
    this.wireMascotLifecycle(this.mascot);
    this.mascot.showInactive();
    // Restore a persisted dock: place flush on the saved edge and re-enter
    // docked state (spec §6.1 — a docked buddy survives restarts).
    const savedEdge = this.deps.getPersistedDock();
    if (savedEdge) {
      const mb = this.rectOf(this.mascot);
      const d = screen.getDisplayMatching(mb) ?? screen.getPrimaryDisplay();
      const flush = dockPosition(savedEdge, { x: mb.x, y: mb.y }, MASCOT_SIZE, this.workAreaFor(d));
      this.place('mascot', this.mascot, flush);
      // A buddy put away on an edge comes back put away — peeking is the
      // resting state at an edge now, not a timer's eventual destination.
      this.dockState = { mode: 'peeking', edge: savedEdge };
      // Renderer may not have loaded yet — replay state when it has.
      this.mascot.webContents.once('did-finish-load', () => this.pushMascotState());
      this.pushMascotState();
    }
    // Any show() clears "hidden until restart" — Settings' "Show now" is
    // just buddy.show(). Broadcast so open Settings panels update live.
    this.dismissed = false;
    this.deps.onStatusChanged(this.getStatus());
  }

  getStatus(): { dismissed: boolean; visible: boolean } {
    return {
      dismissed: this.dismissed,
      visible: !!(this.mascot && !this.mascot.isDestroyed()),
    };
  }

  /** Hide-for-this-run (bar hide button). Preference untouched. */
  dismiss(): void {
    this.hide();
    this.dismissed = true;
    this.deps.onStatusChanged(this.getStatus());
  }

  hide(): void {
    // Drop tracker state silently so a torn-down buddy doesn't fire a
    // stale visibility callback against destroyed windows. The PERSISTED dock
    // edge stays — a dismissed buddy should come back on its edge.
    if (this.glideTimer) { clearInterval(this.glideTimer); this.glideTimer = null; }
    // Cancel a show() still waiting on the usable-screen-area lookup — without
    // this, switching the buddy off during that wait would bring him back.
    this.pendingShow = false;
    this.dragging = false;
    this.dockState = FREE_DOCK;
    this.barVisibility.reset();
    this.barCssVisible = false;
    if (this.bar && !this.bar.isDestroyed()) this.bar.destroy();
    if (this.chat && !this.chat.isDestroyed()) this.chat.destroy();
    if (this.mascot && !this.mascot.isDestroyed()) this.mascot.destroy();
    this.bar = null;
    this.chat = null;
    this.mascot = null;
    // Reset so a subsequent show() + setViewedSession(sameId) doesn't
    // early-return in setViewedSession and skip re-subscription.
    this.viewedSessionId = null;
    // Settings-off also clears the dismissed flag — a disabled buddy isn't
    // "hidden until restart". (dismiss() re-sets the flag AFTER calling
    // hide(), so this order works; it then broadcasts the final value.)
    this.dismissed = false;
    this.deps.onStatusChanged(this.getStatus());
  }

  /**
   * Animated chat close: cue the renderer's fade, hide the window once it plays,
   * and fade the action bar out alongside it. `chatOpenIntent` flips false
   * immediately (before the delayed hide) so drag logic treats the chat as gone
   * at once, and it also guards the timeout against a rapid re-open.
   *
   * Does NOT reconcile the dock — callers decide what happens next: toggleChat
   * syncs engagement (sink back to peek), the drag-to-peek path dispatches
   * drag-peek itself.
   */
  private closeChat(): void {
    if (!this.chat || this.chat.isDestroyed() || !this.chat.isVisible()) return;
    this.chatOpenIntent = false;
    this.chat.webContents.send(IPC_CHAT_STATE, { visible: false });
    const chatRef = this.chat;
    setTimeout(() => {
      if (chatRef && !chatRef.isDestroyed() && chatRef === this.chat && !this.chatOpenIntent) {
        chatRef.hide();
      }
    }, 140);
    this.barVisibility.setChatOpen(false);
  }

  toggleChat(): void {
    if (!this.chat || this.chat.isDestroyed()) {
      this.createChat();
      return;
    }
    if (this.chat.isVisible()) {
      this.closeChat();
      this.syncEngagement(); // chat closed — sink back to peek unless attention holds him
    } else {
      // Re-anchor to current mascot position before showing — the user may
      // have dragged the mascot while the chat was hidden, and the chat
      // should open "wherever the icon is" rather than at its stale last
      // position.
      this.chatOpenIntent = true;
      const layout = this.layoutFor();
      this.place('chat', this.chat, layout.chat);
      this.chat.show();
      this.chat.webContents.send(IPC_CHAT_STATE, { visible: true });
      this.barVisibility.setChatOpen(true);
      // Opening the chat is what actually brings a peeking buddy out — and keeps
      // him out, unlike the hover hop.
      this.syncEngagement();
      // chat.show() just raised the chat over the bar — put them back.
      this.raiseSatellites();
      // The chat may have had to claim space the mascot was standing in (see
      // computeGroupLayout tier 3) — glide him out to the pinned distance.
      this.glideGroup(layout.mascot);
    }
  }

  /**
   * Resolve the group layout for a given mascot rect. The placement ladder
   * itself is pure (buddy-bar-geometry.ts → computeGroupLayout); this only
   * picks the rect and the display to run it against.
   *
   * `mascotRect` defaults to the mascot's live bounds; glideGroup passes the
   * mascot's POST-snap rect so the chat aims at where the buddy will land.
   */
  private layoutFor(mascotRect?: Rect): GroupLayout {
    const mb = mascotRect ?? (this.mascot && !this.mascot.isDestroyed() ? this.rectOf(this.mascot) : null);
    if (!mb) {
      const primary = this.primaryWorkArea();
      const fallback = { x: primary.x + primary.width - CHAT_SIZE.width - 24, y: primary.y + primary.height - CHAT_SIZE.height - 24 };
      return { mascot: fallback, chat: fallback };
    }
    const display = screen.getDisplayMatching(mb) ?? screen.getPrimaryDisplay();
    return computeGroupLayout(mb, this.workAreaFor(display));
  }

  /** Move the chat's subscription from the previous session to the new one. */
  setViewedSession(sessionId: string): void {
    const prev = this.viewedSessionId;
    if (prev === sessionId) return;
    if (this.chat && !this.chat.isDestroyed()) {
      const wcId = this.chat.webContents.id;
      if (prev) this.deps.registry.unsubscribe(prev, wcId);
      this.deps.registry.subscribe(sessionId, wcId);
    }
    this.viewedSessionId = sessionId;
  }

  getViewedSession(): string | null {
    return this.viewedSessionId;
  }

  /** True iff `win` is one of the buddy windows this manager owns
   *  (mascot, chat, or the action-bar window). main.ts uses this
   *  to decide when to tear the buddy down — spec §7.6 says buddy closes
   *  with the last main window. */
  isBuddyWindow(win: BrowserWindow): boolean {
    return win === this.mascot || win === this.chat || win === this.bar;
  }

  /** Read-only accessors for the main-process capture handler, which needs
   *  to hide every buddy window before calling desktopCapturer. */
  getMascotWindow(): BrowserWindow | null { return this.mascot; }
  getChatWindow(): BrowserWindow | null { return this.chat; }
  getBarWindow(): BrowserWindow | null { return this.bar; }

  // WHY: BuddyManager interface methods — main.ts's capture handler and the
  // BUDDY_ATTACH_FILE sender go through these instead of the three getters
  // above, so main.ts works unchanged against the overlay manager (Task 3).
  captureWindows(): BrowserWindow[] {
    return [this.mascot, this.chat, this.bar].filter((w): w is BrowserWindow => !!w && !w.isDestroyed());
  }
  chatWebContents(): Electron.WebContents | null {
    return this.chat && !this.chat.isDestroyed() ? this.chat.webContents : null;
  }

  /**
   * Place the mascot at an absolute screen position, already resolved by
   * moveMascotFromPointer (or by a test). Clamps to the visible workArea.
   * Replaces CSS -webkit-app-region: drag, which on Windows consumes all
   * pointer events via WM_NCHITTEST → HTCAPTION and breaks click detection.
   *
   * Still anchor-based, not delta-based: the caller recomputes the whole
   * offset from the grab point every frame and NOTHING accumulates, so the
   * per-move rounding that made the mascot "slide under my cursor" on
   * fractional-scale displays (125 / 150%) has nothing to compound into.
   */
  /**
   * The drag entry point the renderer actually calls.
   *
   * `localDx/localDy` is how far the cursor has moved from the pixel it grabbed
   * him by, MEASURED INSIDE THE MASCOT'S OWN WINDOW. That is the only cursor
   * coordinate that is true on every platform, so the conversion to a screen
   * position happens here, where the app's own idea of where the window sits is
   * authoritative:  target = where he is now + how far the finger has strayed.
   *
   * WHY NOT the cursor's screen position, which is what the renderer used to
   * send (Destin, 2026-09-04 — "the buddy flickers all over the screen when
   * dragging"): a renderer's screen coordinates are its window's origin plus
   * the cursor's position inside it, and ON WAYLAND THAT ORIGIN IS FROZEN AT
   * 0,0 FOREVER — measured in probe Round 8: KWin moved the window to 500,300,
   * then 900,600, then 200,150, and window.screenX read 0 every single time.
   * So the "screen" position the renderer reported changed by the SAME amount
   * the window had just been moved, in the opposite direction. Every frame
   * therefore undid the last one and the buddy bounced between two points as
   * fast as the pointer fired. Window-local coordinates cannot do that: they
   * are measured against wherever the window actually is at that instant, so
   * the loop closes instead of oscillating, and it stays exact when the mascot
   * is pinned at an edge and cannot follow the finger at all.
   *
   * The arithmetic is identical to the old one on Windows, macOS and X11
   * (there, position + offset-inside-window IS the cursor's screen position),
   * so nothing changes for them — this is one path, not a Linux branch.
   */
  moveMascotFromPointer(localDx: number, localDy: number): void {
    if (!this.mascot || this.mascot.isDestroyed()) return;
    // Refuse a non-finite offset here rather than letting it become a NaN
    // target: same reasoning as place(), one step earlier.
    if (!Number.isFinite(localDx) || !Number.isFinite(localDy)) return;
    const here = this.rectOf(this.mascot);
    this.moveMascot(here.x + localDx, here.y + localDy);
  }

  moveMascot(targetX: number, targetY: number): void {
    if (!this.mascot || this.mascot.isDestroyed()) return;
    // A live drag cancels any in-flight snap glide.
    if (this.glideTimer) { clearInterval(this.glideTimer); this.glideTimer = null; }
    // Once per gesture, never once per frame: re-ask the desktop how much of the
    // screen is usable (see refreshWorkArea — a taskbar change fires no event).
    if (!this.dragging) {
      this.dragging = true;
      this.refreshWorkArea();
    }
    const { x: oldX, y: oldY } = this.rectOf(this.mascot);
    const raw = { x: targetX, y: targetY };
    const display = screen.getDisplayMatching({ ...raw, ...MASCOT_SIZE }) ?? screen.getPrimaryDisplay();
    const wa = this.workAreaFor(display);
    // Gate on the INTENT to have the chat open, not the window's live
    // isVisible() — the exit animation keeps the window shown for 140ms after a
    // close, and drag logic must treat the chat as already gone the instant it
    // starts closing (so the shove-to-peek below hands off cleanly).
    const chatOpen = !!(this.chatOpenIntent && this.chat && !this.chat.isDestroyed());
    let clamped = clampToWorkArea(raw, MASCOT_SIZE, wa);

    if (chatOpen) {
      // With the chat open the pair are horizontally rigid, so the mascot is
      // x-pinned to keep the chat on-screen. But dragging the buddy ALL THE WAY
      // to a screen edge means "put him away": shoving the cursor past the edge
      // (the raw target lands within PEEK_PAST_EDGE_PX of it, i.e. essentially
      // flush) closes the chat + bar (animated) and hands straight off to the
      // edge-peek — Destin 2026-07-17. A small threshold, NOT SNAP_THRESHOLD_PX:
      // the left pin already parks the mascot ~17px off the edge, so a 24px test
      // would false-trigger on ordinary positioning.
      const shove = detectSnapEdge(clamped, MASCOT_SIZE, wa, PEEK_PAST_EDGE_PX);
      if (shove) {
        this.closeChat(); // fades chat + bar out; chatOpenIntent flips false now
        this.dispatchDock({ type: 'drag-peek', edge: shove });
        const pos = dockPosition(shove, clamped, MASCOT_SIZE, wa);
        this.place('mascot', this.mascot, pos);
        return;
      }
      if (this.dockState.mode !== 'free') this.dispatchDock({ type: 'drag-start' });
      // Horizontal pin only. Pinning Y would shrink the draggable band to a
      // sliver (chat 480 tall vs 852 workArea) and fight edge docking; vertical
      // is reconciled at release by computeGroupLayout's tier-3 bounce.
      const range = mascotXRangeForChat({ ...clamped, ...MASCOT_SIZE }, wa);
      clamped = { x: Math.max(range.min, Math.min(clamped.x, range.max)), y: clamped.y };
    } else {
      // Chat closed: live edge-peek. Dragging the buddy against an edge snaps
      // him into peek mid-drag and he slides along it; pulling away past the
      // threshold frees him (the renderer plays the swing-out on peeking→free).
      // Hysteresis: enter at SNAP_THRESHOLD_PX, hold until the cursor pulls 2.5×
      // further away, so a hand at the boundary can't flutter him in and out
      // (each toggle would fire the 380ms swing).
      const peeking = this.dockState.mode === 'peeking';
      const threshold = peeking ? SNAP_THRESHOLD_PX * 2.5 : SNAP_THRESHOLD_PX;
      const edge = detectSnapEdge(clamped, MASCOT_SIZE, wa, threshold);
      if (edge) {
        this.dispatchDock({ type: 'drag-peek', edge });
        const pos = dockPosition(edge, clamped, MASCOT_SIZE, wa);
        this.place('mascot', this.mascot, pos);
        return; // flush against the edge; chat closed → no satellites to follow
      }
      this.dispatchDock({ type: 'drag-start' }); // in open space → free/idle
    }
    // setPosition requires integer args. Pointer screenX/Y on HiDPI displays
    // can be fractional, so targetX/Y (and therefore clamped.x/y) may be
    // floats — passing a float throws "Error processing argument at index 1,
    // conversion failure" from Electron's native bridge.
    const newX = Math.round(clamped.x);
    const newY = Math.round(clamped.y);
    this.place('mascot', this.mascot, { x: newX, y: newY });
    // Move the chat by the SAME delta the mascot actually moved (not the
    // requested delta, which may have been clamped). Clamp the follow-
    // position to the chat's own display's workArea — the mascot may be
    // pinned at an edge where the chat would otherwise overflow.
    //
    // Skip the follow entirely when the chat is hidden: toggleChat() always
    // re-anchors chat to the current mascot position via
    // computeChatAnchoredPosition() on show, so there's nothing a hidden
    // chat can do with a pending position. Every extra setPosition on a
    // frameless Windows BrowserWindow hits DWM, and stacking three per
    // pointermove (mascot + chat + action bar) was a measurable source
    // of "squishy" drag latency.
    const actualDx = newX - oldX;
    const actualDy = newY - oldY;
    if ((actualDx !== 0 || actualDy !== 0) && this.chat && !this.chat.isDestroyed() && chatOpen) {
      const cb = this.rectOf(this.chat);
      const chatRaw = { x: cb.x + actualDx, y: cb.y + actualDy };
      const chatDisplay = screen.getDisplayMatching({ ...chatRaw, ...CHAT_SIZE }) ?? screen.getPrimaryDisplay();
      const chatClamped = clampToWorkArea(chatRaw, CHAT_SIZE, this.workAreaFor(chatDisplay));
      this.place('chat', this.chat, chatClamped);
    }
    // Bar follows its own CSS visibility (not Electron isVisible() — the
    // window stays Electron-shown once created; reveals are CSS fades).
    // Recompute from scratch on visible: if the mascot lands on a bottom
    // edge the bar needs to flip above automatically.
    if (this.bar && !this.bar.isDestroyed() && this.barCssVisible) {
      const pos = this.currentBarPosition();
      this.place('bar', this.bar, pos);
    }
  }

  /** Create-if-needed and show the action-bar window.
   *  FIX (youcoded buddy bug): ALWAYS recompute position from the current
   *  mascot bounds before showing. The old code only computed position at
   *  creation, so dragging the mascot while the chat was closed left the
   *  re-shown icon stranded at the mascot's OLD position. */
  private showBar(): void {
    const pos = this.currentBarPosition();
    if (!this.bar || this.bar.isDestroyed()) {
      this.bar = this.create('bar', pos);
      this.wireBarLifecycle(this.bar);
      // First reveal races page load — re-push the current CSS-visibility
      // state once the renderer is actually listening.
      this.bar.webContents.once('did-finish-load', () => {
        if (this.bar && !this.bar.isDestroyed()) {
          this.bar.webContents.send(IPC_BAR_STATE, { visible: this.barCssVisible });
        }
      });
    } else {
      this.place('bar', this.bar, pos);
    }
    if (!this.bar.isVisible()) this.bar.showInactive();
  }

  // WHY: `hideBar` was removed — the buddy bar's visibility is driven by
  // BarVisibilityTracker + CSS fade, not by imperative hide() calls. The
  // method was defined but never invoked. Found in the 2026-08-06 sweep.

  /** Bar position for a given mascot rect (defaults to live bounds; glideGroup
   *  passes the post-snap rect). Falls back to bottom-right of the primary
   *  display when the mascot is gone (mirrors old behavior). */
  private currentBarPosition(mascotRect?: Rect): Point {
    const mb = mascotRect ?? (this.mascot && !this.mascot.isDestroyed() ? this.rectOf(this.mascot) : null);
    if (!mb) {
      const primary = this.primaryWorkArea();
      return {
        x: primary.x + primary.width - BAR_SIZE.width - 24,
        y: primary.y + primary.height - BAR_SIZE.height - 24,
      };
    }
    const display = screen.getDisplayMatching(mb) ?? screen.getPrimaryDisplay();
    return computeBarPosition(mb, this.workAreaFor(display));
  }

  private wireBarLifecycle(win: BrowserWindow): void {
    win.webContents.on('render-process-gone', (_evt, details) => {
      if (details.reason !== 'clean-exit') this.hide();
    });
    win.on('closed', () => { this.bar = null; });
  }

  // True while the user intends the chat visible — set in the show paths,
  // cleared in the hide path. Guards the delayed exit-animation hide()
  // against rapid re-toggles.
  private chatOpenIntent = false;

  private createChat(): void {
    this.chatOpenIntent = true;
    // Chat is always anchored to the mascot — saved chat position was
    // intentionally dropped. User's mental model: "chat opens where my
    // buddy is." Drag the mascot, chat follows; open the chat, it's next
    // to the mascot.
    const layout = this.layoutFor();
    this.chat = this.create('chat', layout.chat);
    this.wireChatLifecycle(this.chat);
    // If a session was already chosen (via setViewedSession) before the
    // chat window was ever opened, subscribe now. Without this, the first
    // render of chat renders empty because no transcript events are
    // reaching this webContents.
    if (this.viewedSessionId) {
      this.deps.registry.subscribe(this.viewedSessionId, this.chat.webContents.id);
    }
    this.chat.show();
    this.chat.focus();
    this.barVisibility.setChatOpen(true);
    this.syncEngagement();
    // setChatOpen(true) created the bar above the chat, but chat.focus() may
    // have re-raised the chat — assert the order rather than rely on timing.
    this.raiseSatellites();
    this.glideGroup(layout.mascot);
  }

  private wireMascotLifecycle(win: BrowserWindow): void {
    // Saving happens inside place() — the one place a buddy window is ever
    // moved — because on Wayland the 'move' event NEVER fires for a move the
    // compositor made (measured 2026-09-04: four moves, zero events), so the
    // Linux buddy's position was silently never saved and he came back in the
    // corner every launch.
    //
    // But place() only knows what the app ASKED for, and on platforms where the
    // event does fire it carries two things place() cannot see: a move the app
    // did not initiate (KDE X11 lets Meta+drag move any window, and these
    // windows are not `movable: false`), and a position the OS adjusted after
    // setPosition. Dropping the listener outright would have made an X11 user's
    // Meta-drag stop being remembered — a platform where the buddy works today.
    // So it stays, gated: off on the caption path where it is dead weight, on
    // everywhere it ever fired.
    if (!this.captionLive()) {
      win.on('move', () => {
        if (win.isDestroyed()) return;
        // Off the caption path this event only fires on platforms where the
        // window genuinely knows where it is, and its whole point is to capture
        // a position the app did not choose.
        const b = win.getBounds(); // sanctioned-real-bounds
        this.pos.mascot = { x: b.x, y: b.y };
        this.persistMascot();
      });
    }
    // Replay dock state on every page load: a renderer reload (crash
    // recovery, dev hot reload) resets the component's local state and there
    // is no pull-side getter — without this a docked/peeking mascot renders
    // free until the next dock transition.
    win.webContents.on('did-finish-load', () => {
      if (!win.isDestroyed()) win.webContents.send(IPC_MASCOT_STATE, this.dockState);
    });
    // Catch non-clean teardowns (crashes, OOM, force-kill). Clean renderer
    // reloads during `npm run dev` fire with reason === 'clean-exit' — those
    // should NOT trigger hide(), otherwise the buddy vanishes on every hot
    // reload in dev mode.
    win.webContents.on('render-process-gone', (_evt, details) => {
      if (details.reason !== 'clean-exit') this.hide();
    });
    // OS-level close (force-quit via Task Manager or app exit). Clear our
    // ref so show() doesn't try to operate on a destroyed BrowserWindow and
    // hide() doesn't double-destroy.
    win.on('closed', () => { this.mascot = null; });
  }

  private wireChatLifecycle(win: BrowserWindow): void {
    // WHY no move-persistence here: chat position was written but never
    // read — the chat is always re-anchored to the mascot on show. Dead
    // code removed; persistence keys narrowed to 'mascot' in the deps.
    win.webContents.on('render-process-gone', (_evt, details) => {
      if (details.reason !== 'clean-exit') this.hide();
    });
    win.on('closed', () => {
      this.chat = null;
      // FIX: an OS-closed chat (not a toggle) used to strand the action bar
      // visible with no chat. Tell the tracker so the bar fades out.
      this.barVisibility.setChatOpen(false);
      this.syncEngagement();
    });
  }
}

function debounce<T extends (...a: any[]) => void>(fn: T, ms: number): T {
  let t: NodeJS.Timeout | null = null;
  return ((...args: any[]) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  }) as T;
}
