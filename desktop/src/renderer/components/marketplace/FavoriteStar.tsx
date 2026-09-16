
interface Props {
  filled: boolean;
  disabled?: boolean;
  disabledReason?: string;
  onToggle: () => void;
  size?: 'sm' | 'md';
  /** When true, the star is absolutely positioned to sit in the corner of a
   *  card. Default false for header/inline use. */
  corner?: boolean;
  /** Opaque bg-panel backdrop WITHOUT the corner positioning — for a caller
   *  that already places this inside its own absolutely-positioned wrapper
   *  alongside sibling icons (e.g. SkillCard's marketplace icon + star pair),
   *  where each icon needs its own distinct backdrop rather than one shared
   *  pill covering both. */
  bg?: boolean;
}

export default function FavoriteStar({
  filled, disabled = false, disabledReason, onToggle, size = 'md', corner = false, bg = false,
}: Props) {
  const px = size === 'sm' ? 14 : 16;
  // Fix: dropped `bg-panel/80 backdrop-blur-sm`. The card behind is already
  // opaque `bg-panel`, so the translucent panel + 4px backdrop-filter were
  // visually invisible — but each instance still spawned a Chromium
  // compositing layer. With ~20 SkillCards in the open drawer, that was 20
  // backdrop-filter regions inside an animating, overflow-hidden parent;
  // on Windows Electron under the v1.2.2 chat-store re-render churn that
  // caused the drawer body to drop paint frames (cards + bottom half of
  // drawer disappearing). Solid bg-panel keeps the star readable on the
  // card and eliminates the per-star compositing layer.
  const positioning = corner
    ? 'absolute top-1.5 right-1.5 bg-panel'
    // `bg` is scoped to callers that opted in (SkillCard's icon pair) — it
    // also gets the hover backdrop; `corner`'s existing callers (marketplace
    // tiles, ThemeScreen) keep their prior look untouched.
    : (bg ? 'bg-panel hover:bg-inset' : '');
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); if (!disabled) onToggle(); }}
      disabled={disabled}
      aria-label={filled ? 'Unfavorite' : 'Favorite'}
      aria-pressed={filled}
      title={disabled && disabledReason ? disabledReason : (filled ? 'Unfavorite' : 'Favorite')}
      className={`${positioning} p-1 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
        filled ? 'text-accent' : 'text-fg-dim hover:text-fg'
      }`}
    >
      <svg
        width={px} height={px} viewBox="0 0 24 24"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor" strokeWidth={filled ? 0 : 1.8}
        strokeLinejoin="round"
      >
        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
      </svg>
    </button>
  );
}
