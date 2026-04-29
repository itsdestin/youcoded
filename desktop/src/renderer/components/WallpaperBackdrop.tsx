import React from 'react';
import { useTheme } from '../state/theme-context';

// Pre-blurred wallpaper layer. Mirrors the treatment TerminalView uses to
// keep terminal text readable on image themes:
//   - Preferred source: theme-author-supplied `terminal-value` asset, which
//     is already blurred + darkened (zero runtime cost).
//   - Fallback: the sharp wallpaper with a runtime CSS filter (one-shot on
//     a static image, much cheaper than backdrop-filter which recomposites
//     every frame). Skipped under reduced-effects.
//
// Used by MarketplaceScreen + LibraryScreen so their full-screen surfaces
// look like the terminal does — wallpaper-backed canvas with the same
// readability treatment, instead of the previous flat panel color.
//
// Renders nothing if the theme has no image wallpaper.
export default function WallpaperBackdrop() {
  const { activeTheme, reducedEffects } = useTheme();
  const bg = activeTheme?.background;
  const hasWallpaper = bg?.type === 'image' && !!bg.value;
  if (!hasWallpaper) return null;

  const terminalBgAsset = bg?.['terminal-value'];
  const terminalBgFallback = !terminalBgAsset && !reducedEffects ? bg?.value : undefined;
  const terminalBg = terminalBgAsset ?? terminalBgFallback;
  if (!terminalBg) return null;

  const needsRuntimeBlur = !!terminalBgFallback;

  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        inset: 0,
        backgroundImage: `url("${terminalBg}")`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        // Runtime filter on a static image paints once — unlike backdrop-filter
        // which recomposites every frame. Values come from theme-engine's
        // CSS variables so Appearance sliders update the preview live.
        filter: needsRuntimeBlur
          ? 'blur(var(--terminal-bg-blur)) brightness(var(--terminal-bg-brightness))'
          : undefined,
        // Blur expands beyond bounds; scale up so soft edges don't reveal
        // clipped pixels even at the max slider blur.
        transform: needsRuntimeBlur ? 'scale(1.06)' : undefined,
        // Sit behind the screen content. The content is flow content (not
        // positioned), so even z:0 keeps the backdrop underneath as long as
        // it's the first child of the positioned ancestor.
        zIndex: 0,
        pointerEvents: 'none',
      }}
    />
  );
}
