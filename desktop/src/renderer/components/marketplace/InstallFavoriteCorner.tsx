import FavoriteStar from './FavoriteStar';
import BrailleSpinner from '../BrailleSpinner';

interface Props {
  installed: boolean;
  installing: boolean;
  favorited: boolean;
  onInstall: () => void;
  onToggleFavorite: () => void;
  /** Round 3 (Destin, 2026-08-28): render in the flow of the title row, right
   *  beside the INSTALLED pill, instead of floating in the card's corner. */
  inline?: boolean;
}

/**
 * Three-state corner affordance for marketplace tiles.
 *   not installed  → download arrow (click installs)
 *   installing     → braille spinner (click disabled)
 *   installed      → FavoriteStar (click toggles favorite)
 *
 * All three states share the same top-right coordinates so swapping between
 * them does not shift surrounding card content.
 */
export default function InstallFavoriteCorner({
  installed, installing, favorited, onInstall, onToggleFavorite, inline = false,
}: Props) {
  const place = inline ? '' : 'absolute top-1.5 right-1.5 bg-panel/90';

  if (installed) {
    return (
      <FavoriteStar
        corner={!inline}
        size="sm"
        filled={favorited}
        onToggle={onToggleFavorite}
      />
    );
  }

  if (installing) {
    // Perf: no backdrop-blur — same compositing-cost removal FavoriteStar
    // documented; bg-panel/90 keeps the corner legible over card art.
    // WHY <BrailleSpinner> (simplification audit W20): this used to carry its
    // own 80 ms timer and frame list — one timer per in-flight install — while
    // BrailleSpinner already drives every spinner off ONE shared tick. Same
    // glyphs, same 80 ms cadence; colorCycle off gives the steady single
    // colour every other non-cycling spinner uses (fg-dim) — the old copy was
    // text-accent, the one visible nuance of this swap.
    return (
      <span
        role="status"
        aria-label="Installing"
        className={`${place} p-1 rounded-md font-mono leading-none select-none`}
      >
        <BrailleSpinner size="sm" colorCycle={false} />
      </span>
    );
  }

  // Not installed — download affordance.
  // Perf: no backdrop-blur — matches FavoriteStar's documented removal.
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onInstall(); }}
      aria-label="Install"
      title="Install"
      className={`${place} p-1 rounded-md text-fg-dim hover:text-fg transition-colors`}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
    </button>
  );
}
