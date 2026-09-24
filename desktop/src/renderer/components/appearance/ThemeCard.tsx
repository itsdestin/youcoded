// One theme in Settings → Appearance's themes box. Pulled out of ThemeScreen for the
// card redesign (Destin, 2026-09-24, after appearance-panel-review-7: "improve the actual
// theme cards themselves" — shape, style, preview). The favourite star is always shown,
// in the Resume browser's card-icon style (a bare icon, faint at rest, stronger on hover),
// never hover-only: hover never reaches touch screens (narrow-viewport.md).
//
// MOCKUP SWITCH: Destin asked to see alternatives, so three card styles live here for
// the review deck. Once he picks, the losing styles and this switch are deleted.
//   inset    — the theme's preview as a framed picture inside an app-coloured card
//   palette  — no picture: a tiny chat drawn live in the theme's own colours
//   bleed    — the preview fills the whole card, name over its lower edge

import { useState, type KeyboardEvent } from 'react';
import type { LoadedTheme } from '../../themes/theme-types';
import { themePreviewSrc } from '../../themes/builtin/previews';

type ThemeCardStyle = 'inset' | 'palette' | 'bleed';
const THEME_CARD_STYLE: ThemeCardStyle = 'inset';

type Props = {
  theme: LoadedTheme;
  active: boolean;
  favorite: boolean;
  onSelect: () => void;
  onToggleFavorite: () => void;
  /** Present only on the user's own themes — the pencil that opens the editor. */
  onEdit?: () => void;
};

const StarGlyph = ({ filled }: { filled: boolean }) => (
  <svg width={16} height={16} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={filled ? 0 : 1.8} strokeLinejoin="round" aria-hidden>
    <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
  </svg>
);
const PencilGlyph = () => (
  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
);

/** The card's icon buttons — Resume browser's recipe (px-1 py-1.5, faint → stronger on
 *  hover, a filled star in the accent). `onImage` swaps to white-with-shadow for the
 *  full-bleed style, where the icons sit on the picture itself. */
function CardIcons({ favorite, onToggleFavorite, onEdit, name, onImage = false }: {
  favorite: boolean; onToggleFavorite: () => void; onEdit?: () => void; name: string; onImage?: boolean;
}) {
  const tone = onImage
    ? 'text-white/80 hover:text-white drop-shadow'
    : 'text-fg-faint hover:text-fg-2';
  const btn = 'px-1 py-1.5 rounded-sm coarse-hit focus:outline-none focus-visible:ring-2 focus-visible:ring-accent transition-colors';
  return (
    <div className="flex items-center shrink-0">
      {onEdit && (
        <button type="button" onClick={(e) => { e.stopPropagation(); onEdit(); }} aria-label={`Edit ${name}`} title="Edit theme" className={`${btn} ${tone}`}>
          <PencilGlyph />
        </button>
      )}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onToggleFavorite(); }}
        aria-label={favorite ? `Remove ${name} from favorites` : `Add ${name} to favorites`}
        aria-pressed={favorite}
        title={favorite ? 'Remove from favorites' : 'Add to favorites'}
        className={`${btn} ${favorite ? (onImage ? 'text-white drop-shadow' : 'text-accent') : tone}`}
      >
        <StarGlyph filled={favorite} />
      </button>
    </div>
  );
}

/** The theme's preview picture, falling back to its colours when there is none. */
function Preview({ theme, className }: { theme: LoadedTheme; className: string }) {
  const [failed, setFailed] = useState(false);
  const src = themePreviewSrc(theme);
  if (!src || failed) {
    return <div className={className} style={{ background: `linear-gradient(135deg, ${theme.tokens.canvas}, ${theme.tokens.accent})` }} aria-hidden="true" />;
  }
  return <img src={src} alt="" className={`${className} object-cover object-top`} onError={() => setFailed(true)} />;
}

/** A tiny chat drawn in the theme's OWN colours (inline, since these are another
 *  theme's tokens, not the active one's): header, a reply, your message, the box. */
function PaletteRender({ theme }: { theme: LoadedTheme }) {
  const t = theme.tokens;
  const bg = theme.background?.type === 'gradient' && theme.background.value ? theme.background.value : t.canvas;
  return (
    <div className="relative w-full h-full overflow-hidden" style={{ background: bg }} aria-hidden="true">
      <div className="absolute inset-x-0 top-0 h-3 flex items-center gap-1 px-2" style={{ background: t.panel, borderBottom: `1px solid ${t['edge-dim']}` }}>
        <span className="w-1.5 h-1.5 rounded-full" style={{ background: t.fg }} />
        <span className="w-8 h-1 rounded-full" style={{ background: t['fg-muted'] }} />
      </div>
      <div className="absolute right-2 top-4 w-1/2 h-2.5 rounded-md rounded-br-none" style={{ background: t.accent }} />
      <div className="absolute left-2 top-7 w-3/5 h-2.5 rounded-md rounded-bl-none" style={{ background: t.inset, border: `1px solid ${t['edge-dim']}` }} />
      <div className="absolute inset-x-2 bottom-1 h-3 rounded-md flex items-center justify-end px-1" style={{ background: t.panel, border: `1px solid ${t.edge}` }}>
        <span className="w-2 h-2 rounded-full" style={{ background: t.accent }} />
      </div>
    </div>
  );
}

export function ThemeCard({ theme, active, favorite, onSelect, onToggleFavorite, onEdit }: Props) {
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

  if (THEME_CARD_STYLE === 'bleed') {
    return (
      <div {...shell} className={`group relative h-24 rounded-lg overflow-hidden cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-accent border ${active ? 'border-accent ring-1 ring-accent' : 'border-edge-dim hover:border-edge'}`}>
        <Preview theme={theme} className="absolute inset-0 w-full h-full" />
        <div className="absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-black/70 to-transparent" aria-hidden="true" />
        <div className="absolute top-0 right-0 pr-1">
          <CardIcons favorite={favorite} onToggleFavorite={onToggleFavorite} onEdit={onEdit} name={theme.name} onImage />
        </div>
        <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 px-2 pb-1.5">
          <span className="text-xs font-semibold text-white truncate drop-shadow">{theme.name}</span>
          {active && <span className="shrink-0 text-4xs font-medium px-1.5 py-0.5 rounded-full bg-white/25 text-white">Active</span>}
        </div>
      </div>
    );
  }

  return (
    <div {...shell} className={`relative rounded-lg overflow-hidden cursor-pointer bg-panel border p-1 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${active ? 'border-accent' : 'border-edge-dim hover:border-edge'}`}>
      <div className="h-14 rounded-md overflow-hidden border border-edge-dim">
        {THEME_CARD_STYLE === 'palette'
          ? <PaletteRender theme={theme} />
          : <Preview theme={theme} className="w-full h-full" />}
      </div>
      <div className="flex items-center gap-1.5 pl-1 pt-0.5">
        <span className="text-xs font-medium text-fg truncate">{theme.name}</span>
        {activePill}
        <span className="flex-1" />
        <CardIcons favorite={favorite} onToggleFavorite={onToggleFavorite} onEdit={onEdit} name={theme.name} />
      </div>
    </div>
  );
}
