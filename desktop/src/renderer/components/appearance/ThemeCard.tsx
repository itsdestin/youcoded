// One theme in Settings → Appearance's themes box. Pulled out of ThemeScreen for the
// card redesign (Destin, 2026-09-24, after appearance-panel-review-7: "improve the actual
// theme cards themselves" — shape, style, preview). The favourite star is always shown,
// in the Resume browser's card-icon style (a bare icon, faint at rest, stronger on hover),
// never hover-only: hover never reaches touch screens (narrow-viewport.md).
//
// Style (Destin, theme-cards-review TC-1): the "framed picture" card, with the strip under
// the picture made "MUCH thinner so the actual image takes more of the space". The
// full-bleed and live-colour styles were shown and not taken.

import { useState, type KeyboardEvent } from 'react';
import type { LoadedTheme } from '../../themes/theme-types';
import { themePreviewSrc } from '../../themes/builtin/previews';

type Props = {
  theme: LoadedTheme;
  active: boolean;
  favorite: boolean;
  onSelect: () => void;
  onToggleFavorite: () => void;
  /** Present only on the user's own themes — the share icon that publishes it
   *  (appearance-questions AQ-3, 2026-10-01: it replaces the removed editor's pencil). */
  onShare?: () => void;
  /** The theme library's copy of the preview (registry `preview` URL). Used when the
   *  theme has no preview.png of its own on this device. */
  fallbackPreview?: string;
};

const StarGlyph = ({ filled }: { filled: boolean }) => (
  <svg width={14} height={14} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={filled ? 0 : 1.8} strokeLinejoin="round" aria-hidden>
    <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
  </svg>
);
// The same share glyph the marketplace detail page uses for its Share button.
const ShareGlyph = () => (
  <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
    <line x1="8.6" y1="13.5" x2="15.4" y2="17.5" /><line x1="15.4" y1="6.5" x2="8.6" y2="10.5" />
  </svg>
);

/** The card's icon buttons — Resume browser's recipe (bare icons, faint → stronger on
 *  hover, a filled star in the accent). */
function CardIcons({ favorite, onToggleFavorite, onShare, name }: {
  favorite: boolean; onToggleFavorite: () => void; onShare?: () => void; name: string;
}) {
  const tone = 'text-fg-faint hover:text-fg-2';
  // py-0.5 (not Resume's py-1.5): the strip is 20px tall. coarse-hit keeps a 44px
  // target on touch.
  const btn = 'px-1 py-0.5 rounded-sm coarse-hit focus:outline-none focus-visible:ring-2 focus-visible:ring-accent transition-colors';
  return (
    <div className="flex items-center shrink-0">
      {onShare && (
        <button type="button" onClick={(e) => { e.stopPropagation(); onShare(); }} aria-label={`Publish ${name} to the marketplace`} title="Publish to Marketplace" className={`${btn} ${tone}`}>
          <ShareGlyph />
        </button>
      )}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onToggleFavorite(); }}
        aria-label={favorite ? `Remove ${name} from favorites` : `Add ${name} to favorites`}
        aria-pressed={favorite}
        title={favorite ? 'Remove from favorites' : 'Add to favorites'}
        className={`${btn} ${favorite ? 'text-accent' : tone}`}
      >
        <StarGlyph filled={favorite} />
      </button>
    </div>
  );
}

/** The theme's preview picture: its own preview.png, else the theme library's copy,
 *  else its colours. WHY the library's copy (2026-09-24): installing a community theme
 *  downloads its manifest and assets but NOT preview.png, so on a real install every
 *  community card fell through to the colour gradient — only built-ins ever showed a
 *  picture. The registry already carries the preview's URL (the Marketplace cards use
 *  it), so the card borrows it. */
function Preview({ theme, fallback, className }: { theme: LoadedTheme; fallback?: string; className: string }) {
  const own = themePreviewSrc(theme);
  const sources = [own, fallback].filter((x): x is string => !!x);
  const [attempt, setAttempt] = useState(0);
  const src = sources[attempt];
  if (!src) {
    return <div className={className} style={{ background: `linear-gradient(135deg, ${theme.tokens.canvas}, ${theme.tokens.accent})` }} aria-hidden="true" />;
  }
  return <img src={src} alt="" className={`${className} object-cover object-top`} onError={() => setAttempt((n) => n + 1)} />;
}

export function ThemeCard({ theme, active, favorite, onSelect, onToggleFavorite, onShare, fallbackPreview }: Props) {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); }
  };
  // Outer element is div+role=button (not <button>) so the nested icon buttons are
  // valid HTML. Deliberately NOT .layer-surface: N cards = N backdrop-filters, the
  // Windows paint bug (react-renderer.md → Overlays).
  const shell = {
    'data-active-theme': active || undefined,
    role: 'button' as const,
    tabIndex: 0,
    'aria-label': `${theme.name}${active ? ' (active)' : ''}`,
    'aria-pressed': active,
    onClick: onSelect,
    onKeyDown,
  };
  const activePill = active && (
    <span className="shrink-0 text-4xs font-medium px-1.5 py-0.5 rounded-full bg-accent/15 text-accent">Active</span>
  );

  return (
    <div {...shell} className={`relative rounded-lg overflow-hidden cursor-pointer bg-panel border p-1 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${active ? 'border-accent' : 'border-edge-dim hover:border-edge'}`}>
      {/* The picture takes nearly all of the card: 16:9, the preview's own shape less a
          sliver, so almost the whole window shows rather than its top strip. */}
      <div className="aspect-video rounded-md overflow-hidden border border-edge-dim">
        <Preview theme={theme} fallback={fallbackPreview} className="w-full h-full" />
      </div>
      {/* The slim strip: one small line — name, Active, then the icons. */}
      <div className="flex items-center gap-1 pl-1 h-5">
        <span className="text-2xs font-medium text-fg truncate">{theme.name}</span>
        {activePill}
        <span className="flex-1" />
        <CardIcons favorite={favorite} onToggleFavorite={onToggleFavorite} onShare={onShare} name={theme.name} />
      </div>
    </div>
  );
}
