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
      return;
    }
    if (this.chat.isVisible()) {
      this.chat.hide();
    } else {
      // Re-anchor to current mascot position before showing — the user may
      // have dragged the mascot while the chat was hidden, and the chat
      // should open "wherever the icon is" rather than at its stale last
      // position.
      const pos = this.computeChatAnchoredPosition();
      this.chat.setPosition(Math.round(pos.x), Math.round(pos.y));
      this.chat.show();
    }
  }

  /**
   * Choose the chat window's position relative to the current mascot.
   * Prefer right-of-mascot; fall back to left-of-mascot if the right side
   * would clip the workArea. Always clamps to visible workArea as a safety.
   * Top-align chat with mascot so they read as a single unit — icon sits
   * alongside the top of its conversation panel.
   */
  private computeChatAnchoredPosition(): Point {
    if (!this.mascot || this.mascot.isDestroyed()) {
      const primary = screen.getPrimaryDisplay().workArea;
      return { x: primary.x + primary.width - CHAT_SIZE.width - 24, y: primary.y + primary.height - CHAT_SIZE.height - 24 };
    }
    const mb = this.mascot.getBounds();
    const display = screen.getDisplayMatching(mb) ?? screen.getPrimaryDisplay();
    const wa = display.workArea;
    // Top-align chat with the mascot (chat.y === mascot.y) so the buddy
    // icon sits next to the chat's header, not its midpoint or bottom.
    const y = mb.y;
    const rightX = mb.x + mb.width + 12;
    const rightFits = rightX + CHAT_SIZE.width <= wa.x + wa.width;
    const raw = rightFits
      ? { x: rightX, y }
      : { x: mb.x - CHAT_SIZE.width - 12, y };
    return clampToWorkArea(raw, CHAT_SIZE, wa);
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

  /** True iff `win` is one of the two buddy windows this manager owns.
   *  main.ts uses this to decide when to tear the buddy down — spec §7.6
   *  says buddy closes with the last main window. */
  isBuddyWindow(win: BrowserWindow): boolean {
    return win === this.mascot || win === this.chat;
  }

  /**
   * Move the mascot window by a pointer-drag delta, clamped to the visible
   * workArea of whichever display the window ends up on. Replaces CSS
   * -webkit-app-region: drag, which on Windows consumes all pointer events
   * via WM_NCHITTEST → HTCAPTION and breaks click detection.
   */
  moveMascot(dx: number, dy: number): void {
    if (!this.mascot || this.mascot.isDestroyed()) return;
    const [oldX, oldY] = this.mascot.getPosition();
    const raw = { x: oldX + dx, y: oldY + dy };
    const display = screen.getDisplayMatching({ ...raw, ...MASCOT_SIZE }) ?? screen.getPrimaryDisplay();
    const clamped = clampToWorkArea(raw, MASCOT_SIZE, display.workArea);
    // setPosition requires integer args. Pointer screenX/Y on HiDPI displays
    // can be fractional, so dx/dy (and therefore clamped.x/y) may be floats —
    // passing a float throws "Error processing argument at index 1, conversion
    // failure" from Electron's native bridge.
    const newX = Math.round(clamped.x);
    const newY = Math.round(clamped.y);
    this.mascot.setPosition(newX, newY);
    // Move the chat by the SAME delta the mascot actually moved (not the
    // requested delta, which may have been clamped). This keeps the chat
    // anchored to the mascot when the user drags — whether chat is visible
    // or hidden. Hidden chat will pop back at the correct relative position
    // on next show. Destroyed chat is a no-op.
    //
    // Clamp the chat's follow-position to its own display's workArea too:
    // the mascot may be clamped to an edge where the chat would otherwise
    // get pushed off-screen (e.g. mascot pinned to the right edge with
    // chat opened to the RIGHT of mascot = chat shifted past screen).
    // Clamping ensures the chat always stays fully visible; it may lose
    // its exact relative offset to the mascot momentarily, which is the
    // right tradeoff vs. a half-offscreen window.
    const actualDx = newX - oldX;
    const actualDy = newY - oldY;
    if ((actualDx !== 0 || actualDy !== 0) && this.chat && !this.chat.isDestroyed()) {
      const cb = this.chat.getBounds();
      const chatRaw = { x: cb.x + actualDx, y: cb.y + actualDy };
      const chatDisplay = screen.getDisplayMatching({ ...chatRaw, ...CHAT_SIZE }) ?? screen.getPrimaryDisplay();
      const chatClamped = clampToWorkArea(chatRaw, CHAT_SIZE, chatDisplay.workArea);
      this.chat.setPosition(Math.round(chatClamped.x), Math.round(chatClamped.y));
    }
  }

  private createChat(): void {
    // Chat is always anchored to the mascot — saved chat position was
    // intentionally dropped. User's mental model: "chat opens where my
    // buddy is." Drag the mascot, chat follows; open the chat, it's next
    // to the mascot.
    const pos = this.computeChatAnchoredPosition();
    const rounded = { x: Math.round(pos.x), y: Math.round(pos.y) };
    this.chat = this.deps.createBuddyWindow('chat', rounded);
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
