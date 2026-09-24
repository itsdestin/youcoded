import type { Terminal } from '@xterm/xterm';

/**
 * Pause an xterm's DRAWING while it is hidden, without touching its buffer.
 *
 * WHY: every open session keeps a mounted TerminalView; the inactive ones are
 * hidden with CSS `visibility:hidden` (see TerminalView for why not
 * display:none). xterm already knows how to stop drawing an off-screen
 * terminal — its RenderService watches the screen element with an
 * IntersectionObserver and, while "not intersecting", turns every redraw
 * request into a single "needs a full refresh" flag that it honours the moment
 * the terminal is on screen again. But `visibility:hidden` still counts as
 * intersecting, so a background session that prints kept drawing rows and
 * uploading glyphs to the GPU for a pane nobody can see. With ten sessions
 * open that is ten terminals repainting.
 *
 * This feeds xterm's OWN pause switch (RenderService._handleIntersectionChange)
 * the answer "off screen" while we know the pane is hidden, and passes xterm's
 * real observer answer through unchanged otherwise. Only drawing pauses: the
 * parser still runs on every write(), so the buffer — which the prompt
 * detector and attention classifier read for hidden sessions on purpose —
 * stays exactly as up to date as before.
 *
 * The hook-in is a private xterm member (checked against @xterm/xterm 6.0.0;
 * names survive its minified build). If a future xterm renames it, this returns
 * null and the terminal simply keeps drawing while hidden, as it always did —
 * and tests/xterm-render-pause.test.ts fails against the real package, so the
 * bump cannot silently lose the saving.
 */
export interface RenderPause {
  /** Hidden → pause drawing. Shown → resume and repaint the whole screen once. */
  setHidden(hidden: boolean): void;
  /** Restore xterm's own observer handling (call before terminal.dispose()). */
  dispose(): void;
}

interface IntersectionLike { isIntersecting?: boolean; intersectionRatio?: number }
interface RenderServiceInternals {
  _isPaused?: boolean;
  _handleIntersectionChange?: (entry: IntersectionLike) => void;
}

export function attachRenderPause(terminal: Terminal): RenderPause | null {
  const rs = (terminal as unknown as { _core?: { _renderService?: RenderServiceInternals } })._core?._renderService;
  const original = rs?._handleIntersectionChange;
  if (!rs || typeof original !== 'function') return null;
  const hadOwn = Object.prototype.hasOwnProperty.call(rs, '_handleIntersectionChange');

  // xterm's own verdict from its IntersectionObserver. Starts from its current
  // state so a terminal we never hide behaves exactly as before.
  let onScreen = rs._isPaused !== true;
  let hidden = false;
  const apply = () => original.call(rs, { isIntersecting: onScreen && !hidden });

  // The observer callback looks this method up on the instance at call time
  // (`e => this._handleIntersectionChange(...)`), so an own-property override
  // intercepts it. Same normalisation xterm applies to the entry itself.
  rs._handleIntersectionChange = (entry: IntersectionLike) => {
    onScreen = entry.isIntersecting === undefined ? entry.intersectionRatio !== 0 : entry.isIntersecting;
    apply();
  };

  return {
    setHidden(next: boolean) {
      if (next === hidden) return;
      hidden = next;
      apply();
      // On show, xterm only repaints if something was drawn-over while paused.
      // Force one full refresh regardless so the first frame the user sees is
      // the current screen. It is rAF-debounced, so it merges with xterm's own
      // resume refresh (and the glyph-atlas heal's) into a single draw.
      if (!next) terminal.refresh(0, terminal.rows - 1);
    },
    dispose() {
      if (hadOwn) rs._handleIntersectionChange = original;
      else delete rs._handleIntersectionChange;
    },
  };
}
