// @vitest-environment jsdom
// The Appearance pickers' first choice — "keep whatever this theme does" — is named "Theme"
// everywhere (Destin, final-review#ST-22: "replace "auto" with "theme""): the layout tiles, the
// glass strip, the particles strip and its hint. "Auto" suggested the app picks for you.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GlassSettings, LayoutSettings, LookSettings } from '../src/renderer/components/appearance/LookSettings';

const wallpaper = { background: { type: 'image', value: 'x.png' }, layout: { 'chrome-style': 'float' } } as any;

it('names the theme\'s-own choice "Theme", never "Auto"', () => {
  render(<>
    <LayoutSettings />
    <LookSettings />
    <GlassSettings active={wallpaper} raw={wallpaper} look={{}} set={() => {}} reducedEffects={false} />
  </>);
  expect(screen.getAllByText('Theme').length).toBeGreaterThan(0);
  expect(screen.queryByText('Auto')).toBeNull();
  expect(document.body.textContent).not.toMatch(/\bAuto\b/);
});
