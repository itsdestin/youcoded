import type { WebglAddon } from '@xterm/addon-webgl';

/**
 * Take a terminal's WebGL drawing layer off AND give its graphics context back to
 * the browser at once.
 *
 * WHY (card 106, 2026-11-11): the browser allows a page only 16 live WebGL
 * contexts and silently kills the oldest when a 17th is made. Every Claude Code or
 * shell chat used to keep one for its whole life, so 20 open chats meant 12 context
 * losses at creation and 4 terminals left without working graphics, plus 80-170 ms
 * freezes when switching chats (perf lab, `suspects-b.mjs --only sessions`). A
 * hidden terminal now holds none: TerminalView calls this when it is hidden and
 * builds a fresh layer when it is shown.
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
  const gl = (addon as unknown as { _renderer?: { _gl?: WebGL2RenderingContext | null } })._renderer?._gl;
  try { addon.dispose(); } catch { /* already disposed or never activated */ }
  try { gl?.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* context already gone */ }
}
