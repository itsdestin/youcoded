// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EscCloseProvider } from '../src/renderer/hooks/use-esc-close';
import ContextSettings, { DEFAULT_CONTEXT_PREFERENCES, type ContextPreferences } from '../src/renderer/components/assistant-settings/ContextSettings';

afterEach(cleanup);

const group = (provider: string) => within(screen.getByRole('tablist', { name: `${provider} context` }));

describe('Context settings preview', () => {
  it('shows two separately labelled groups, both defaulting to 250k', () => {
    const onChange = vi.fn();
    render(<ContextSettings value={DEFAULT_CONTEXT_PREFERENCES} onChange={onChange} />);
    expect(screen.getByRole('region', { name: 'Context' })).toBeTruthy();
    expect(screen.getAllByRole('tablist')).toHaveLength(2);
    for (const provider of ['OpenRouter', 'ChatGPT']) {
      expect(group(provider).getAllByRole('tab')).toHaveLength(2);
      expect(group(provider).getByRole('tab', { name: '250k', selected: true })).toBeTruthy();
      expect(group(provider).getByRole('tab', { name: '1M', selected: false })).toBeTruthy();
    }
    expect(onChange).not.toHaveBeenCalled();
  });

  it('changes each provider independently and waits for its controlled value', () => {
    const onChange = vi.fn();
    const initial: ContextPreferences = { openrouter: 'standard', chatgpt: 'standard' };
    const { rerender } = render(<ContextSettings value={initial} onChange={onChange} />);
    fireEvent.click(group('OpenRouter').getByRole('tab', { name: '1M' }));
    expect(onChange).toHaveBeenLastCalledWith({ openrouter: 'long', chatgpt: 'standard' });
    expect(group('OpenRouter').getByRole('tab', { name: '250k', selected: true })).toBeTruthy();
    expect(initial).toEqual({ openrouter: 'standard', chatgpt: 'standard' });

    rerender(<ContextSettings value={{ openrouter: 'long', chatgpt: 'standard' }} onChange={onChange} />);
    expect(group('OpenRouter').getByRole('tab', { name: '1M', selected: true })).toBeTruthy();
    fireEvent.click(group('ChatGPT').getByRole('tab', { name: '1M' }));
    expect(onChange).toHaveBeenLastCalledWith({ openrouter: 'long', chatgpt: 'long' });

    rerender(<ContextSettings value={{ openrouter: 'long', chatgpt: 'long' }} onChange={onChange} />);
    fireEvent.click(group('OpenRouter').getByRole('tab', { name: '250k' }));
    expect(onChange).toHaveBeenLastCalledWith({ openrouter: 'standard', chatgpt: 'long' });
    fireEvent.keyDown(group('ChatGPT').getByRole('tab', { name: '1M' }), { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith({ openrouter: 'long', chatgpt: 'standard' });
  });

  it('opens the explainer with approximate sizes, tradeoffs and scope caveats', () => {
    render(<EscCloseProvider><ContextSettings value={DEFAULT_CONTEXT_PREFERENCES} onChange={vi.fn()} /></EscCloseProvider>);
    expect(screen.queryByText(/how much of the conversation/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'About context' }));
    expect(screen.getByText(/how much of the conversation the model can use/i)).toBeTruthy();
    expect(screen.getByText(/approximate.*smaller models.*below 250k.*800k–1.2M.*model and provider/i)).toBeTruthy();
    expect(screen.getByText(/fewer summaries.*cost more.*plan allowance/i)).toBeTruthy();
    expect(screen.getByText(/selecting 1M does not send a million tokens.*sent and generated/i)).toBeTruthy();
    expect(screen.getByText(/local models are unchanged/i)).toBeTruthy();
    expect(screen.getByText(/250k is the default for both providers/i)).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByText(/how much of the conversation/i)).toBeNull();
  });
});
