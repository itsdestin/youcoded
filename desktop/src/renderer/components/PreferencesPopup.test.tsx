// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import PreferencesPopup from './PreferencesPopup';

// jsdom doesn't implement ResizeObserver; a no-op stub is enough since this
// test never asserts on scroll-fade behavior itself.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe('PreferencesPopup', () => {
  beforeEach(() => {
    (global as any).ResizeObserver = NoopResizeObserver;
    // Minimal window.claude surface: PreferencesPopup calls window.claude.settings
    // on mount to load preferences from ~/.claude/settings.json.
    (window as any).claude = {
      settings: {
        get: vi.fn().mockResolvedValue(undefined),
        set: vi.fn().mockResolvedValue(undefined),
      },
    };
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows Advanced button by default', async () => {
    const onClose = vi.fn();
    const onOpenAdvanced = vi.fn();

    render(
      <PreferencesPopup
        open={true}
        onClose={onClose}
        onOpenAdvanced={onOpenAdvanced}
      />,
    );

    // Wait for the preferences to load and the Advanced button to appear
    await waitFor(() => {
      expect(screen.getByText(/Advanced \(terminal\)/)).toBeInTheDocument();
    });
  });

  it('hides Advanced button when showAdvanced={false}', async () => {
    const onClose = vi.fn();
    const onOpenAdvanced = vi.fn();

    render(
      <PreferencesPopup
        open={true}
        onClose={onClose}
        onOpenAdvanced={onOpenAdvanced}
        showAdvanced={false}
      />,
    );

    // Wait for preferences to load, then verify the button is NOT rendered
    await waitFor(() => {
      expect(screen.getByText('Default permission mode')).toBeInTheDocument();
    });

    const advancedButton = screen.queryByText(/Advanced \(terminal\)/);
    expect(advancedButton).not.toBeInTheDocument();
  });

  it('shows Advanced button when showAdvanced={true}', async () => {
    const onClose = vi.fn();
    const onOpenAdvanced = vi.fn();

    render(
      <PreferencesPopup
        open={true}
        onClose={onClose}
        onOpenAdvanced={onOpenAdvanced}
        showAdvanced={true}
      />,
    );

    // Wait for the preferences to load and the Advanced button to appear
    await waitFor(() => {
      expect(screen.getByText(/Advanced \(terminal\)/)).toBeInTheDocument();
    });
  });

  it('does not render if open={false}', () => {
    const onClose = vi.fn();
    const onOpenAdvanced = vi.fn();

    const { container } = render(
      <PreferencesPopup
        open={false}
        onClose={onClose}
        onOpenAdvanced={onOpenAdvanced}
      />,
    );

    // When closed, the component returns null, so the container should be empty
    expect(container.querySelector('[role="dialog"]')).not.toBeInTheDocument();
  });
});
