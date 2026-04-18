import { BrowserWindow, screen } from 'electron';
import type { WindowRegistry } from './window-registry';

export interface Rect { x: number; y: number; width: number; height: number; }
export interface Point { x: number; y: number; }
export interface Size { width: number; height: number; }

/**
 * Clamp a position so the window stays fully inside the workArea.
 * Pure function — no electron deps — so it's unit-testable.
 */
export function clampToWorkArea(pos: Point, size: Size, workArea: Rect): Point {
  const maxX = workArea.x + workArea.width - size.width;
  const maxY = workArea.y + workArea.height - size.height;
  return {
    x: Math.max(workArea.x, Math.min(pos.x, maxX)),
    y: Math.max(workArea.y, Math.min(pos.y, maxY)),
  };
}

const MASCOT_SIZE: Size = { width: 80, height: 80 };
const CHAT_SIZE: Size = { width: 320, height: 480 };

export interface BuddyWindowManagerDeps {
  createBuddyWindow(variant: 'mascot' | 'chat', opts: { x: number; y: number }): BrowserWindow;
  getPersistedPosition(key: 'mascot' | 'chat'): Point | null;
  setPersistedPosition(key: 'mascot' | 'chat', pos: Point): void;
  registry: WindowRegistry;
  mainWindow: () => BrowserWindow | null;
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
export class BuddyWindowManager {
  private mascot: BrowserWindow | null = null;
  private chat: BrowserWindow | null = null;
  private viewedSessionId: string | null = null;

  constructor(private readonly deps: BuddyWindowManagerDeps) {}

  show(): void {
    if (this.mascot && !this.mascot.isDestroyed()) {
      this.mascot.showInactive();
      return;
    }
    const saved = this.deps.getPersistedPosition('mascot');
    const primary = screen.getPrimaryDisplay().workArea;
    const defaultPos = { x: primary.x + primary.width - 104, y: primary.y + primary.height - 104 };
    const raw = saved ?? defaultPos;
    // getDisplayMatching picks the display containing the window's bounds;
    // if the saved position is off-screen entirely, fall back to primary.
    const display = screen.getDisplayMatching({ ...raw, ...MASCOT_SIZE }) ?? screen.getPrimaryDisplay();
    const clamped = clampToWorkArea(raw, MASCOT_SIZE, display.workArea);
    this.mascot = this.deps.createBuddyWindow('mascot', clamped);
    this.wireMascotLifecycle(this.mascot);
    this.mascot.showInactive();
  }

  hide(): void {
    if (this.chat && !this.chat.isDestroyed()) this.chat.destroy();
    if (this.mascot && !this.mascot.isDestroyed()) this.mascot.destroy();
    this.chat = null;
    this.mascot = null;
    // Reset so a subsequent show() + setViewedSession(sameId) doesn't
    // early-return in setViewedSession and skip re-subscription.
    this.viewedSessionId = null;
  }

  toggleChat(): void {
    if (!this.chat || this.chat.isDestroyed()) {
      this.createChat();
      // On first-open only: dock the mascot to the chat's bottom-left so the
      // chat window doesn't cover the mascot (spec §7.5 anchors chat above the
      // mascot, but workArea clamping near the right edge pulls chat left,
      // causing overlap — which then blocks click-to-toggle-off). Subsequent
      // show/hide does NOT reposition, so a user's drag preference persists.
      this.dockMascotToChatBottomLeft();
      return;
    }
    if (this.chat.isVisible()) this.chat.hide();
    else this.chat.show();
  }

  private dockMascotToChatBottomLeft(): void {
    if (!this.mascot || this.mascot.isDestroyed()) return;
    if (!this.chat || this.chat.isDestroyed()) return;
    const cb = this.chat.getBounds();
    // Sit the mascot just outside the chat's bottom-left corner, aligned with
    // the chat's bottom edge. 8px gap so they visually associate without
    // touching. Fallback to chat's bottom-right if there's no room on the left.
    const leftRaw = { x: cb.x - MASCOT_SIZE.width - 8, y: cb.y + cb.height - MASCOT_SIZE.height };
    const display = screen.getDisplayMatching({ ...leftRaw, ...MASCOT_SIZE }) ?? screen.getPrimaryDisplay();
    const leftClamped = clampToWorkArea(leftRaw, MASCOT_SIZE, display.workArea);
    // If clamping moved the mascot INTO the chat horizontally (i.e., not
    // enough workArea to the left), try the right side instead.
    const overlapsX = leftClamped.x + MASCOT_SIZE.width > cb.x && leftClamped.x < cb.x + cb.width;
    const target = overlapsX
      ? clampToWorkArea({ x: cb.x + cb.width + 8, y: cb.y + cb.height - MASCOT_SIZE.height }, MASCOT_SIZE, display.workArea)
      : leftClamped;
    this.mascot.setPosition(target.x, target.y);
    // Persist so next launch respects the docked position.
    this.deps.setPersistedPosition('mascot', target);
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

  /**
   * Move the mascot window by a pointer-drag delta, clamped to the visible
   * workArea of whichever display the window ends up on. Replaces CSS
   * -webkit-app-region: drag, which on Windows consumes all pointer events
   * via WM_NCHITTEST → HTCAPTION and breaks click detection.
   */
  moveMascot(dx: number, dy: number): void {
    if (!this.mascot || this.mascot.isDestroyed()) return;
    const [x, y] = this.mascot.getPosition();
    const raw = { x: x + dx, y: y + dy };
    const display = screen.getDisplayMatching({ ...raw, ...MASCOT_SIZE }) ?? screen.getPrimaryDisplay();
    const clamped = clampToWorkArea(raw, MASCOT_SIZE, display.workArea);
    this.mascot.setPosition(clamped.x, clamped.y);
  }

  private createChat(): void {
    const saved = this.deps.getPersistedPosition('chat');
    let raw: Point;
    if (saved) {
      raw = saved;
    } else if (this.mascot && !this.mascot.isDestroyed()) {
      // First-ever chat: anchor to the right of the mascot so it reads as
      // "summoned by" the mascot. Subsequent shows use the saved position.
      const mb = this.mascot.getBounds();
      raw = { x: mb.x + 92, y: mb.y - 200 };
    } else {
      const primary = screen.getPrimaryDisplay().workArea;
      raw = { x: primary.x + primary.width - 344, y: primary.y + primary.height - 580 };
    }
    const display = screen.getDisplayMatching({ ...raw, ...CHAT_SIZE }) ?? screen.getPrimaryDisplay();
    const clamped = clampToWorkArea(raw, CHAT_SIZE, display.workArea);
    this.chat = this.deps.createBuddyWindow('chat', clamped);
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
  }

  private wireMascotLifecycle(win: BrowserWindow): void {
    const save = debounce(() => {
      if (win.isDestroyed()) return;
      const { x, y } = win.getBounds();
      this.deps.setPersistedPosition('mascot', { x, y });
    }, 300);
    win.on('move', save);
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
    const save = debounce(() => {
      if (win.isDestroyed()) return;
      const { x, y } = win.getBounds();
      this.deps.setPersistedPosition('chat', { x, y });
    }, 300);
    win.on('move', save);
    win.webContents.on('render-process-gone', (_evt, details) => {
      if (details.reason !== 'clean-exit') this.hide();
    });
    win.on('closed', () => { this.chat = null; });
  }
}

function debounce<T extends (...a: any[]) => void>(fn: T, ms: number): T {
  let t: NodeJS.Timeout | null = null;
  return ((...args: any[]) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  }) as T;
}
