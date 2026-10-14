// @vitest-environment jsdom
// WHY: pins the full-screen band as Destin approved it (decisions "Full-screen titles", H-1, and
// "Way back to chat", H-5): the screen's icon beside its centred title, and the way out reading
// "Esc · Back to chat" with the key first. final-review#FV-6 (2026-10-14) took back H-5's FILL:
// the way out is the light inset pill again, like the window buttons beside it, never accent.
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
  it('reads "Esc · Back to chat", key first, as a light (unfilled) button', () => {
    const onBack = mount();
    const back = screen.getByRole('button', { name: 'Back to chat' });
    // The key, its dot and the words are three spans (the button's gap spaces them).
    expect(back.textContent).toMatch(/^Esc\s*·\s*Back to chat$/);
    expect(back.className).not.toContain('bg-accent');
    expect(back.parentElement?.className).toContain('bg-inset');
    fireEvent.click(back);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('draws the screen icon beside the title', () => {
    mount();
    expect(screen.getByTestId('screen-icon')).toBeInTheDocument();
    expect(screen.getByText('Marketplace')).toBeInTheDocument();
  });
});
