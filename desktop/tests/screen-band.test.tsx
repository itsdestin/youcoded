// @vitest-environment jsdom
// WHY: pins the full-screen band as Destin approved it (decisions "Full-screen titles", H-1, and
// "Way back to chat", H-5): the screen's icon beside its centred title, and the way out a FILLED
// small button reading "Esc · Back to chat" with the key first. Before this the band read
// "Back to chat · Esc" in an inset pill, and Marketplace/Library had their own ghost exits.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ArtifactProvider } from '../src/renderer/state/ArtifactContext';
import { initialArtifactState } from '../src/renderer/state/artifact-tracker';
import { ScreenBand } from '../src/renderer/components/ScreenBand';

vi.mock('../src/renderer/components/pages/use-pages', () => ({
  usePages: () => ({ pages: [], loaded: true, failed: false, pinnedTotal: 0 }),
}));

function mount(onBack = vi.fn()) {
  render(
    <ArtifactProvider value={{ state: initialArtifactState, dispatch: () => {} }}>
      <ScreenBand
        settingsOpen={false}
        onToggleSettings={() => {}}
        active={null}
        icon={<svg data-testid="screen-icon" />}
        title="Marketplace"
        onBack={onBack}
      />
    </ArtifactProvider>,
  );
  return onBack;
}

describe('ScreenBand', () => {
  it('reads "Esc · Back to chat", key first, as a filled button', () => {
    const onBack = mount();
    const back = screen.getByRole('button', { name: 'Back to chat' });
    // The key and its dot are one span, the words another (the button's gap spaces them).
    expect(back.textContent).toMatch(/^Esc\s*·\s*Back to chat$/);
    expect(back.className).toContain('bg-accent');
    fireEvent.click(back);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('draws the screen icon beside the title', () => {
    mount();
    expect(screen.getByTestId('screen-icon')).toBeInTheDocument();
    expect(screen.getByText('Marketplace')).toBeInTheDocument();
  });
});
