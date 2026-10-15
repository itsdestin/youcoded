import { OverlayPanel } from '../overlays/Overlay';
import { Button } from './Button';

/**
 * The zoom control for a picture-like artifact: [ − | 120% | + | ⌕ ].
 *
 * Always visible while a zoomable file is open — deliberately NOT hover-revealed.
 * A hover fade would never appear on Android (no pointer-enter at all), and an
 * `opacity-0` control stays in the tab order, which is the bug the Edit cluster
 * already has. It also makes the magnifier findable: an icon nobody can see is
 * a feature nobody has.
 *
 * Presentational only — it holds no zoom state of its own.
 */
export interface ZoomPillProps {
  /** Whole-number display scale. 100 = actual size. */
  percent: number;
  canZoomIn: boolean;
  canZoomOut: boolean;
  /** Shown as the `+` tooltip when it is disabled. Design guide §4.7: a disabled
   *  control owes the user a reason, not just 50% opacity. */
  zoomInDisabledReason?: string;
  onZoomIn(): void;
  onZoomOut(): void;
  onReset(): void;
  /** Null/undefined renders no magnifier button — which is the right answer on a
   *  touch screen, where there is no cursor for a lens to follow. */
  loupe?: { on: boolean; onToggle(): void } | null;
  className?: string;
}

export function ZoomPill({
  percent, canZoomIn, canZoomOut, zoomInDisabledReason,
  onZoomIn, onZoomOut, onReset, loupe, className = '',
}: ZoomPillProps) {
  return (
    // data-pinned-control: a control that stays on screen, not a popup — so the
    // screen checker (scripts/shoot/explore-page.mjs listLayers) doesn't expect
    // Escape to close it. In the Browser panel nothing closes on Escape.
    <OverlayPanel layer={1} data-loupe-block data-pinned-control className={`flex items-center px-0.5 py-0.5 ${className}`.trim()}>
      <Button
        size="icon"
        variant="ghost"
        aria-label="Zoom out"
        disabled={!canZoomOut}
        title={canZoomOut ? 'Zoom out' : 'Already fitted to the pane'}
        onClick={onZoomOut}
      >
        −
      </Button>

      <Button
        size="sm"
        variant="ghost"
        onClick={onReset}
        className="min-w-[2.5rem] px-1 justify-center tabular-nums"
        // The name says what clicking does; the label says where you are.
        aria-label={`Reset to fit (currently ${percent}%)`}
        title="Reset to fit"
      >
        {percent}%
      </Button>

      <Button
        size="icon"
        variant="ghost"
        aria-label="Zoom in"
        disabled={!canZoomIn}
        title={canZoomIn ? 'Zoom in' : (zoomInDisabledReason ?? 'Already at the largest size')}
        onClick={onZoomIn}
      >
        +
      </Button>

      {loupe && (
        <Button
          size="icon"
          variant="ghost"
          aria-label="Magnify on hover"
          aria-pressed={loupe.on}
          title="Magnify on hover"
          className={loupe.on ? 'bg-inset text-fg' : undefined}
          onClick={loupe.onToggle}
        >
          ⌕
        </Button>
      )}
    </OverlayPanel>
  );
}
