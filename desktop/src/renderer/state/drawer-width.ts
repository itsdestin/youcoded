/** Right-pane width preferences (youcoded#105; games arcade spec §4.3).
 *
 * The active right pane's width is distributed to the layout through ONE CSS
 * var, `--right-pane-width` (see react-renderer rule — the chrome-glass cutout
 * and .drawer-pane both read it). This module owns the USER-CHOSEN widths
 * behind it, and there are TWO of them, deliberately kept independent:
 *
 *   `--drawer-width`      the artifact drawer   (key 'youcoded-drawer-width')
 *   `--game-pane-width`   the games pane        (key 'youcoded-game-pane-width')
 *
 * WHY two: a single shared width would mean widening the chess board also
 * widens the user's document drawer — a change in a panel they weren't even
 * looking at. Both are set on <html> by ThemeProvider and referenced by
 * App.tsx's inline style; App picks which one `--right-pane-width` follows.
 * Live drag writes the <html> var directly (no React re-render per mousemove);
 * pointer-up commits through ThemeProvider (state + localStorage).
 *
 * Both share ONE clamp (`clampDrawerWidth`) so the two panes can never disagree
 * about what is too thin or too wide.
 */

export const DRAWER_WIDTH_KEY = 'youcoded-drawer-width';
export const DRAWER_WIDTH_VAR = '--drawer-width';
export const DEFAULT_DRAWER_WIDTH = 480; // matches the pre-resize fixed width
export const MIN_DRAWER_WIDTH = 320;     // thinner is unreadable
const MAX_DRAWER_FRACTION = 0.6;  // leave the chat pane usable

/** Clamp a candidate width to [320, 60% of window], defaulting to 480 for
 *  non-finite input (e.g. corrupt localStorage). Always returns an integer. */
export function clampDrawerWidth(width: number, windowWidth: number): number {
  if (!Number.isFinite(width)) return DEFAULT_DRAWER_WIDTH;
  const max = Math.max(MIN_DRAWER_WIDTH, Math.floor(windowWidth * MAX_DRAWER_FRACTION));
  return Math.round(Math.min(max, Math.max(MIN_DRAWER_WIDTH, width)));
}

/** Write one live width var on <html>. Used by ThemeProvider (committed value)
 *  AND by the drag handlers (per-frame preview). Takes the var name so the
 *  artifact drawer and the games pane share this one writer instead of each
 *  growing their own copy. */
export function applyPaneWidthVar(varName: string, px: number): void {
  const value = `${px}px`;
  const style = document.documentElement.style;
  // WHY skip an identical write: every write to a var on <html> makes the browser
  // restyle the whole page (all elements inherit it) and recompute the frame's
  // cut-out shape. During a drag the pointer often moves without the clamped width
  // changing (pinned at the min/max, or a sub-pixel move), and ThemeProvider re-applies
  // the committed width on pointer-up — those writes changed nothing on screen.
  // The drag handlers already coalesce to one write per animation frame (rAF).
  if (style.getPropertyValue(varName) === value) return;
  style.setProperty(varName, value);
}

/** Artifact-drawer flavour of {@link applyPaneWidthVar}. Kept as its own export
 *  with its original signature because SessionDrawer and ImageView call it. */
export function applyDrawerWidthVar(px: number): void {
  applyPaneWidthVar(DRAWER_WIDTH_VAR, px);
}

// ─── Games pane (spec §4.3) ─────────────────────────────────────────────────

export const GAME_WIDTH_KEY = 'youcoded-game-pane-width';
export const GAME_WIDTH_VAR = '--game-pane-width';
/** Fallback when no game has declared a width and the user has never resized —
 *  the picker's comfortable width. Per-game defaults live on the registry's
 *  `defaultPaneWidth`. */
export const DEFAULT_GAME_WIDTH = 420;

/** Write the live games-pane width var on <html>. */
export function applyGameWidthVar(px: number): void {
  applyPaneWidthVar(GAME_WIDTH_VAR, px);
}

/** Has the user ever dragged the games pane?
 *
 *  WHY the key's mere PRESENCE is the answer: "the stored number happens to
 *  equal the default" is NOT the same fact as "the user never touched it", and
 *  inferring one from the other would silently throw away a deliberate resize
 *  to 420. Storing the fact explicitly means a reset (removeItem) genuinely
 *  hands control back to the per-game defaults. */
export function hasStoredGameWidth(): boolean {
  try { return localStorage.getItem(GAME_WIDTH_KEY) !== null; } catch { return false; }
}

/** The width a game should OPEN at: the user's remembered width once they have
 *  resized the pane even once, otherwise that game's own default. */
export function gameWidthForOpen(gameDefaultPx: number, storedPx: number): number {
  return hasStoredGameWidth() ? storedPx : gameDefaultPx;
}
