// @vitest-environment jsdom
// The Appearance theme card's picture (components/appearance/ThemeCard.tsx).
//
// Installing a community theme downloads its manifest and assets but never its
// preview.png, so on a real install the card's own picture always fails and every
// community card fell through to the colour gradient (found 2026-09-24). The card
// now tries the theme library's copy of the preview before giving up.
import { describe, it, expect, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { ThemeCard } from '../src/renderer/components/appearance/ThemeCard';
import type { LoadedTheme } from '../src/renderer/themes/theme-types';

afterEach(cleanup);

const tokens = { canvas: '#111111', accent: '#ff0066', fg: '#eeeeee' } as unknown as LoadedTheme['tokens'];
const community = { slug: 'meadow-mist', name: 'Meadow Mist', source: 'community', tokens } as unknown as LoadedTheme;
const LIBRARY = 'https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/meadow-mist/preview.png';

function card(fallbackPreview?: string) {
  return render(
    <ThemeCard theme={community} active={false} favorite onSelect={() => {}} onToggleFavorite={() => {}} fallbackPreview={fallbackPreview} />,
  );
}

describe('ThemeCard preview', () => {
  it('shows the theme\'s own preview.png first', () => {
    const { container } = card(LIBRARY);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('theme-asset://meadow-mist/preview.png');
  });

  it('falls back to the theme library\'s copy when the own preview is missing', () => {
    const { container } = card(LIBRARY);
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(LIBRARY);
  });

  it('draws the colour gradient only when both pictures fail', () => {
    const { container } = card(LIBRARY);
    fireEvent.error(container.querySelector('img')!);
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();
  });

  it('keeps the star visible without hovering (touch has no hover)', () => {
    const { getByLabelText } = card();
    const star = getByLabelText('Remove Meadow Mist from favorites');
    expect(star.className).not.toMatch(/opacity-0/);
    expect(star.parentElement?.className ?? '').not.toMatch(/opacity-0/);
  });
});
