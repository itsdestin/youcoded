// @vitest-environment jsdom
// context-popup.test.tsx — tests for the StatusBar context chip popup.

import React from 'react';
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import ContextPopup from '../src/renderer/components/ContextPopup';

// jsdom does not implement ResizeObserver; stub it so SettingsExplainer's
// useScrollFade hook can mount without throwing.
beforeAll(() => {
  if (typeof window.ResizeObserver === 'undefined') {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

afterEach(cleanup);

function renderPopup(overrides: Partial<React.ComponentProps<typeof ContextPopup>> = {}) {
  const onClose = vi.fn();
  const onDispatch = vi.fn();
  const defaults: React.ComponentProps<typeof ContextPopup> = {
    open: true,
    onClose,
    sessionId: 'sess-1',
    contextPercent: 72,
    contextTokens: 143_200,
    onDispatch,
  };
  const props = { ...defaults, ...overrides };
  return { ...render(<ContextPopup {...props} />), onClose, onDispatch };
}

describe('ContextPopup — main view', () => {
  it('renders title, percent, tokens, and the high-band hint', () => {
    renderPopup({ contextPercent: 72, contextTokens: 143_200 });
    expect(screen.getByText('Context')).toBeInTheDocument();
    expect(screen.getByText('72%')).toBeInTheDocument();
    expect(screen.getByText(/143,200 tokens remaining/)).toBeInTheDocument();
    expect(screen.getByText(/Plenty of room/i)).toBeInTheDocument();
  });

  it('shows the mid-band hint between 20% and 60%', () => {
    renderPopup({ contextPercent: 35 });
    expect(screen.getByText(/Getting tight/i)).toBeInTheDocument();
  });

  it('shows the low-band hint under 20%', () => {
    renderPopup({ contextPercent: 8 });
    expect(screen.getByText(/Very low/i)).toBeInTheDocument();
  });

  it('omits the tokens line when contextTokens is null', () => {
    renderPopup({ contextTokens: null });
    expect(screen.queryByText(/tokens remaining/)).toBeNull();
  });

  it('returns null when open is false', () => {
    const { container } = renderPopup({ open: false });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('calls onClose when the X button is clicked', () => {
    const { onClose } = renderPopup();
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when the scrim is clicked', () => {
    const { onClose } = renderPopup();
    // Scrim is the backdrop rendered alongside the dialog. Find by its layer-scrim class.
    const scrim = document.querySelector('.layer-scrim');
    expect(scrim).not.toBeNull();
    fireEvent.click(scrim!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not bubble clicks from inside the panel to the scrim', () => {
    const { onClose } = renderPopup();
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('ContextPopup — info view', () => {
  it('shows the (i) button in the header of the main view', () => {
    renderPopup();
    expect(screen.getByLabelText('What is this?')).toBeInTheDocument();
  });

  it('swaps to the explainer when (i) is clicked', () => {
    renderPopup();
    fireEvent.click(screen.getByLabelText('What is this?'));
    expect(screen.getByText('About Context')).toBeInTheDocument();
    // Main-view hint should no longer be visible
    expect(screen.queryByText(/Plenty of room/i)).toBeNull();
  });

  it('returns to the main view when Back is clicked', () => {
    renderPopup();
    fireEvent.click(screen.getByLabelText('What is this?'));
    fireEvent.click(screen.getByLabelText('Back to settings'));
    expect(screen.getByText(/Plenty of room/i)).toBeInTheDocument();
    expect(screen.queryByText('About Context')).toBeNull();
  });

  it('closes the whole popup when the explainer Close is clicked', () => {
    const { onClose } = renderPopup();
    fireEvent.click(screen.getByLabelText('What is this?'));
    // Explainer renders its own Close button; main-view header is not mounted when showInfo is true.
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('ContextPopup — actions', () => {
  it('renders the "Clear and start over" button with explanatory note', () => {
    renderPopup();
    expect(screen.getByRole('button', { name: /Clear and start over/i })).toBeInTheDocument();
    expect(screen.getByText(/Erases the visible timeline/i)).toBeInTheDocument();
  });

  it('dispatches /clear and closes the popup when Clear is clicked', () => {
    const { onDispatch, onClose } = renderPopup();
    fireEvent.click(screen.getByRole('button', { name: /Clear and start over/i }));
    expect(onDispatch).toHaveBeenCalledWith('/clear');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('disables Clear when sessionId is null', () => {
    renderPopup({ sessionId: null });
    const btn = screen.getByRole('button', { name: /Clear and start over/i });
    expect(btn).toBeDisabled();
  });

  it('renders the Compact split-button', () => {
    renderPopup();
    expect(screen.getByRole('button', { name: /^Compact conversation$/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/Customize compact instructions/i)).toBeInTheDocument();
  });

  it('dispatches /compact and closes when the main Compact button is clicked', () => {
    const { onDispatch, onClose } = renderPopup();
    fireEvent.click(screen.getByRole('button', { name: /^Compact conversation$/i }));
    expect(onDispatch).toHaveBeenCalledWith('/compact');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('disables both Compact controls when sessionId is null', () => {
    renderPopup({ sessionId: null });
    expect(screen.getByRole('button', { name: /^Compact conversation$/i })).toBeDisabled();
    expect(screen.getByLabelText(/Customize compact instructions/i)).toBeDisabled();
  });

  it('opens the inline editor when the chevron is clicked', () => {
    renderPopup();
    fireEvent.click(screen.getByLabelText(/Customize compact instructions/i));
    expect(screen.getByPlaceholderText(/keep code decisions/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Compact with instructions/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Back$/i })).toBeInTheDocument();
    // The default compact button should no longer be visible in editor mode
    expect(screen.queryByRole('button', { name: /^Compact conversation$/i })).toBeNull();
  });

  it('returns to the default actions view when Back is clicked in editor mode', () => {
    renderPopup();
    fireEvent.click(screen.getByLabelText(/Customize compact instructions/i));
    fireEvent.click(screen.getByRole('button', { name: /^Back$/i }));
    expect(screen.getByRole('button', { name: /^Compact conversation$/i })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/keep code decisions/i)).toBeNull();
  });

  it('disables submit while the textarea is empty or whitespace-only', () => {
    renderPopup();
    fireEvent.click(screen.getByLabelText(/Customize compact instructions/i));
    const submit = screen.getByRole('button', { name: /Compact with instructions/i });
    expect(submit).toBeDisabled();
    const textarea = screen.getByPlaceholderText(/keep code decisions/i);
    fireEvent.change(textarea, { target: { value: '   ' } });
    expect(submit).toBeDisabled();
    fireEvent.change(textarea, { target: { value: 'keep code' } });
    expect(submit).toBeEnabled();
  });

  it('dispatches /compact <trimmed instructions> and closes on submit', () => {
    const { onDispatch, onClose } = renderPopup();
    fireEvent.click(screen.getByLabelText(/Customize compact instructions/i));
    const textarea = screen.getByPlaceholderText(/keep code decisions/i);
    fireEvent.change(textarea, { target: { value: '   keep architecture decisions  ' } });
    fireEvent.click(screen.getByRole('button', { name: /Compact with instructions/i }));
    expect(onDispatch).toHaveBeenCalledWith('/compact keep architecture decisions');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
