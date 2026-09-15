// @vitest-environment jsdom
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SavedContextSettings from '../src/renderer/components/assistant-settings/SavedContextSettings';
import { DEFAULT_CONTEXT_PREFERENCES, type ContextPreferences } from '../src/shared/context-preferences';

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const tab = (provider: string, name: string) => within(screen.getByRole('tablist', { name: `${provider} context` })).getByRole('tab', { name });
const click = (provider: string, name = '1M') => fireEvent.click(tab(provider, name));
let saved: ContextPreferences;
let get: ReturnType<typeof vi.fn>;
let set: ReturnType<typeof vi.fn>;
beforeEach(() => {
  saved = { ...DEFAULT_CONTEXT_PREFERENCES };
  get = vi.fn(async () => ({ ...saved }));
  set = vi.fn(async (patch: Partial<ContextPreferences>) => { saved = { ...saved, ...patch }; return { ...saved }; });
  (window as any).claude = { native: { getContextPreferences: get, setContextPreferences: set } };
});
async function ready() { await screen.findByRole('tablist', { name: 'ChatGPT context' }); }

describe('saved context settings', () => {
  it('restores saved choices on reopen and sends only changed providers', async () => {
    const view = render(<SavedContextSettings />); await ready();
    click('OpenRouter'); await waitFor(() => expect(set).toHaveBeenCalledWith({ openrouter: 'long' }));
    click('ChatGPT'); await waitFor(() => expect(saved).toEqual({ openrouter: 'long', chatgpt: 'long' }));
    view.unmount(); render(<SavedContextSettings />); await ready();
    expect(tab('OpenRouter', '1M').getAttribute('aria-selected')).toBe('true');
    expect(tab('ChatGPT', '1M').getAttribute('aria-selected')).toBe('true');
  });
  it('serializes rapid choices and never overwrites newer optimistic input', async () => {
    const first = deferred<ContextPreferences>(); set.mockImplementationOnce(() => first.promise);
    render(<SavedContextSettings />); await ready();
    click('OpenRouter'); click('ChatGPT'); click('OpenRouter', '250k');
    expect(set).toHaveBeenCalledTimes(1);
    expect(tab('OpenRouter', '250k').getAttribute('aria-selected')).toBe('true');
    await act(async () => first.resolve({ openrouter: 'long', chatgpt: 'standard' }));
    await waitFor(() => expect(set).toHaveBeenCalledTimes(2));
    expect(set).toHaveBeenLastCalledWith({ chatgpt: 'long', openrouter: 'standard' });
    expect(tab('OpenRouter', '250k').getAttribute('aria-selected')).toBe('true');
  });
  it('does not roll back a superseded failed write', async () => {
    const first = deferred<ContextPreferences>(); set.mockImplementationOnce(() => first.promise);
    render(<SavedContextSettings />); await ready(); click('ChatGPT'); click('ChatGPT', '250k');
    await act(async () => first.reject(new Error('disk failed')));
    await waitFor(() => expect(set).toHaveBeenCalledTimes(2));
    expect(set).toHaveBeenLastCalledWith({ chatgpt: 'standard' });
    expect(tab('ChatGPT', '250k').getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByText(/disk failed/)).toBeNull();
  });
  it('keeps an unsuperseded failure visible and retries the intended choice', async () => {
    set.mockRejectedValueOnce(new Error('disk failed'));
    render(<SavedContextSettings />); await ready(); click('ChatGPT');
    await screen.findByText(/disk failed/);
    expect(tab('ChatGPT', '1M').getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(saved.chatgpt).toBe('long'));
    expect(set).toHaveBeenLastCalledWith({ chatgpt: 'long' });
  });
  it('preserves a failed provider while a later sibling input saves', async () => {
    const first = deferred<ContextPreferences>(); set.mockImplementationOnce(() => first.promise);
    render(<SavedContextSettings />); await ready(); click('OpenRouter'); click('ChatGPT');
    await act(async () => first.reject(new Error('disk failed')));
    await waitFor(() => expect(saved.chatgpt).toBe('long'));
    expect(tab('OpenRouter', '1M').getAttribute('aria-selected')).toBe('true');
    await screen.findByText(/disk failed/);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(saved.openrouter).toBe('long'));
  });
  it('shows loading and retries a failed load without fake defaults', async () => {
    const load = deferred<ContextPreferences>(); get.mockImplementationOnce(() => load.promise);
    render(<SavedContextSettings />);
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getByText(/Loading context/)).toBeTruthy();
    await act(async () => load.reject(new Error('read failed')));
    expect(screen.queryByRole('tablist')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' })); await ready();
    expect(get).toHaveBeenCalledTimes(2); expect(set).not.toHaveBeenCalled();
  });
  it('waits for a previous mount\'s delayed saves before reopening, then allows choosing the lower mode', async () => {
    const first = deferred<ContextPreferences>();
    set.mockImplementationOnce(async (patch: Partial<ContextPreferences>) => {
      await first.promise;
      saved = { ...saved, ...patch };
      return { ...saved };
    });
    const view = render(<SavedContextSettings />); await ready();
    click('ChatGPT'); click('OpenRouter'); view.unmount();
    render(<SavedContextSettings />);
    await act(async () => first.resolve({ openrouter: 'standard', chatgpt: 'long' }));
    await ready();
    await waitFor(() => expect(saved).toEqual({ openrouter: 'long', chatgpt: 'long' }));
    expect(tab('ChatGPT', '1M').getAttribute('aria-selected')).toBe('true');
    expect(tab('OpenRouter', '1M').getAttribute('aria-selected')).toBe('true');
    click('ChatGPT', '250k');
    await waitFor(() => expect(saved.chatgpt).toBe('standard'));
  });

  it('finishes already accepted provider patches after unmount without rendering', async () => {
    const first = deferred<ContextPreferences>();
    set.mockImplementationOnce(async (patch: Partial<ContextPreferences>) => {
      await first.promise;
      saved = { ...saved, ...patch };
      return { ...saved };
    });
    const view = render(<SavedContextSettings />); await ready(); click('ChatGPT'); click('OpenRouter'); view.unmount();
    await act(async () => first.resolve({ openrouter: 'standard', chatgpt: 'long' }));
    await waitFor(() => expect(saved).toEqual({ openrouter: 'long', chatgpt: 'long' }));
    expect(set).toHaveBeenCalledTimes(2);
    expect(set).toHaveBeenLastCalledWith({ openrouter: 'long' });
    expect(view.container.innerHTML).toBe('');
  });
});
