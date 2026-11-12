import type { WebglAddon } from '@xterm/addon-webgl';

/**
 * The terminals' WebGL drawing layers, kept within the browser's limit.
 *
 * WHY (card 106, 2026-11-11): the browser allows a page only 16 live WebGL contexts
 * and silently kills the oldest when a 17th is made. Every Claude Code or shell chat
 * builds a WebGL layer for its terminal, so 20 open chats meant 12 context losses at
 * creation, 4 terminals left without working graphics and freezes when switching
 * chats (perf lab, `suspects-b.mjs --only sessions`). Nothing else in the page uses
 * WebGL, so the 16 slots belong to the terminals.
 *
 * The pool: while fewer than 16 layers exist, every terminal keeps its layer exactly
 * as before (built when the terminal mounts, kept while it is hidden — so 16 or fewer
 * chats behave and cost exactly what they did). When one more is needed for a terminal
 * being SHOWN, the hidden terminal shown least recently gives its layer back first and
 * falls back to xterm's DOM drawing, which the render pause keeps idle; it gets a fresh
 * layer the next time it is shown. A terminal mounted hidden while the pool is full
 * simply starts without one. A visible terminal's layer is never taken; if every layer
 * belongs to a visible terminal, a new one is built anyway (the browser then behaves as
 * it always did). Measured on the perf lab's software-drawn screen: always releasing a
 * hidden terminal's layer made every switch into a terminal 30-50 ms slower (a context
 * is rebuilt on each show), so release happens only when the limit forces it.
 *
 * Module state is per page: each window has its own limit and its own pool.
 */
export const WEBGL_LAYER_LIMIT = 16;

export interface WebglHolder {
  /** Is this terminal on screen now? A visible holder's layer is never taken. */
  isVisible(): boolean;
  /** Give the layer back (the pool calls this to make room; it must call releaseWebglSlot). */
  evict(): void;
}

// WHY 16 (and not fewer on Android): 16 is Chromium desktop's per-page limit. Android's WebView may allow fewer;
// if so, a phone with 9-16 terminals behaves as before the pool (the oldest contexts are lost and TerminalView's
// context-loss recovery rebuilds them). Unverified on a real phone, so the limit is not lowered there.
const holders = new Set<WebglHolder>();
// WHY separate from the pool (card 106 review): when each terminal was last shown, kept even while it holds no
// layer. A terminal never shown (a chat opened in the background) has no entry and ranks as least recently shown;
// before, it was stamped as if shown just now and could keep its layer over genuinely recent ones.
const lastShown = new WeakMap<WebglHolder, number>();
let clock = 0;

/** Room for one more layer without taking one? (a terminal mounted hidden builds only then) */
export function webglSlotFree(): boolean {
  return holders.size < WEBGL_LAYER_LIMIT;
}

/** Take back the layer of the hidden holder shown least recently; false when every holder is on screen. */
function evictOldestHidden(): boolean {
  let oldest: WebglHolder | null = null;
  let oldestAt = Infinity;
  for (const h of holders) {
    const at = lastShown.get(h) ?? 0;
    if (!h.isVisible() && at < oldestAt) { oldest = h; oldestAt = at; }
  }
  if (!oldest) return false;
  oldest.evict();
  holders.delete(oldest);   // evict() releases its slot; this only guarantees the loops below end
  return true;
}

/** Take a slot for `holder`, first taking back the least recently shown hidden layer(s) if the pool is full. */
export function claimWebglSlot(holder: WebglHolder): void {
  if (holders.has(holder)) return;
  // A terminal mounted on screen claims before it is ever noted as shown (React runs the mount effect after the
  // visibility layout effect): it IS being shown, so it ranks as the most recent.
  if (holder.isVisible()) lastShown.set(holder, ++clock);
  while (holders.size >= WEBGL_LAYER_LIMIT && evictOldestHidden()) { /* make room */ }
  holders.add(holder);
}

/** The terminal was just shown: it is now the most recently used. */
export function noteWebglShown(holder: WebglHolder): void {
  lastShown.set(holder, ++clock);
}

/**
 * A terminal was just hidden: if more than 16 layers exist (only when more than 16 terminals were on screen at
 * once, every one of them keeping its layer), give hidden ones back until the pool is at its limit again.
 * WHY (card 106 review): otherwise the pool stayed over the browser's limit until a chat closed.
 */
export function trimWebglPool(): void {
  while (holders.size > WEBGL_LAYER_LIMIT && evictOldestHidden()) { /* back to the limit */ }
}

/** The holder no longer has a layer (released, lost, or the terminal closed). */
export function releaseWebglSlot(holder: WebglHolder): void {
  holders.delete(holder);
}

/**
 * The character cell a WebGL layer measures, remembered for terminals that have no layer right now.
 *
 * WHY (card 106 review): the WebGL layer rounds a cell's width down to whole device pixels; plain DOM drawing keeps
 * it exact (WebglRenderer / DomRenderer `_updateDimensions` in @xterm), so the two give a different column count.
 * On a phone a HIDDEN terminal tells its program the size it will have when shown (terminal-hidden-size.ts), and the
 * size lock keeps that size only while the cell is unchanged (terminal-size-lock.ts). A hidden terminal left without a
 * layer by the pool would size its program by the DOM cell, then again by the WebGL cell when shown — Claude Code then
 * prints its screen twice (the 2026-11-03 bug). So a terminal without a layer sizes itself by this remembered WebGL
 * cell instead. One per window: every terminal in a window uses the same font. `key` is the character measure and
 * the device pixel ratio, so a font, font-size or zoom change makes the old measure unusable until a layer measures
 * again.
 */
let webglCell: { key: string; width: number; height: number } | null = null;
let webglWorks = false;

/** A WebGL layer was built in this window (so a terminal without one will get one when shown). */
export function noteWebglWorks(): void {
  webglWorks = true;
}
/** Has any WebGL layer been built in this window? If never, every terminal draws (and measures) with DOM. */
export function webglWorksHere(): boolean {
  return webglWorks;
}
/** Remember the cell a terminal WITH a layer measures, for the character measure + zoom `key`. */
export function rememberWebglCell(key: string, cell: { width: number; height: number }): void {
  if (webglCell?.key === key && webglCell.width === cell.width && webglCell.height === cell.height) return;
  webglCell = { key, width: cell.width, height: cell.height };
}
/** The cell a WebGL layer measured for `key`; undefined when none has been measured at this font and zoom. */
export function webglCellFor(key: string): { width: number; height: number } | undefined {
  return webglCell?.key === key ? { width: webglCell.width, height: webglCell.height } : undefined;
}

/** How many layers the pool counts — rig/test instrument. */
export function webglLayerCount(): number {
  return holders.size;
}

/**
 * Take a terminal's WebGL drawing layer off AND give its graphics context back to
 * the browser at once.
 *
 * `addon.dispose()` alone is not enough: it only removes the canvas from the page,
 * and the browser keeps counting that canvas's context until garbage collection
 * happens to free it — an unknown time later. WEBGL_lose_context hands it back now.
 * It runs AFTER dispose, which has already removed the addon's own
 * `webglcontextlost` listener, so the deliberate release never reaches the
 * context-loss recovery in TerminalView.
 *
 * The context is a private member of the installed addon (`_renderer._gl`, checked
 * against @xterm/addon-webgl 0.19; the names survive its minified build). If a
 * future version renames it, the layer is still disposed and the context is freed
 * by garbage collection as before — and tests/terminal-webgl.test.ts fails against
 * the real package so the bump cannot silently lose the release.
 */
export function releaseWebgl(addon: WebglAddon): void {
  const gl = webglContextOf(addon);
  try { addon.dispose(); } catch { /* already disposed or never activated */ }
  loseWebglContext(gl);
}

/** The layer's graphics context, read BEFORE the layer is disposed (see releaseWebgl for the private member). */
export function webglContextOf(addon: WebglAddon): WebGL2RenderingContext | null {
  return (addon as unknown as { _renderer?: { _gl?: WebGL2RenderingContext | null } })._renderer?._gl ?? null;
}

/** Hand a context back to the browser now (call after its layer is disposed, so no loss handler sees it). */
export function loseWebglContext(gl: WebGL2RenderingContext | null): void {
  try { gl?.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* context already gone */ }
}
