// @vitest-environment jsdom
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { VoiceButton } from '../src/renderer/components/VoiceButton';
import { EscCloseProvider } from '../src/renderer/hooks/use-esc-close';
import { createMockShim, setLatency } from '../src/renderer/dev/workbench/mock-shim';
import { createStore } from '../src/renderer/dev/workbench/mock-store';
import { DESKTOP_WINDOW_CAPABILITIES, ANDROID_LOCAL_CAPABILITIES, REMOTE_SCREEN_CAPABILITIES } from '../src/shared/capabilities';

setLatency(0);
function install(query = '/', scenario: 'default' | 'empty' | 'stress' = 'default') {
  window.history.replaceState({}, '', query);
  const shim = createMockShim(createStore(scenario));
  // WHY: production exposes a plain namespace. The workbench proxy reads its
  // cached wrappers instead of spy replacements, so spy on a plain facade.
  const voiceVocabulary = { get: shim.voiceVocabulary!.get, save: shim.voiceVocabulary!.save };
  window.claude = { ...shim, voiceVocabulary } as unknown as Window['claude'];
  return window.claude as Window['claude'] & { voiceVocabulary: { get: () => Promise<string[]>; save: (phrases: string[]) => Promise<void> } };
}
function mount(phase: 'idle' | 'listening' = 'idle') {
  const handlers = { onStart: vi.fn(), onStop: vi.fn(), onDownload: vi.fn(), onRecheck: vi.fn(), onClearError: vi.fn() };
  render(<EscCloseProvider><VoiceButton phase={phase} readiness={{ state: 'ready', engine: 'Parakeet' }} level={0} seconds={0} error={null} {...handlers} /></EscCloseProvider>);
  return handlers;
}
async function open() {
  mount();
  fireEvent.contextMenu(screen.getByRole('button', { name: 'Speak your message' }));
  return screen.findByRole('textbox', { name: 'Add word or phrase' });
}
beforeEach(() => {
  install();
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} unobserve() {} });
});
afterEach(() => { window.history.replaceState({}, '', '/'); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function add(field: HTMLElement, value: string) {
  fireEvent.change(field, { target: { value } });
  fireEvent.keyDown(field, { key: 'Enter' });
}

describe('Voice vocabulary preview', () => {
  it.each(['idle', 'listening'] as const)('right-click does not record or stop while %s; left-click remains unchanged', (phase) => {
    const handlers = mount(phase);
    const mic = screen.getByRole('button', { name: phase === 'idle' ? 'Speak your message' : 'Stop listening' });
    fireEvent.contextMenu(mic, { clientX: 20, clientY: 30 });
    expect(screen.getByRole('dialog', { name: 'Voice vocabulary' })).toBeTruthy();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(handlers.onStart).not.toHaveBeenCalled();
    expect(handlers.onStop).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Voice vocabulary' })).toBeNull();
    fireEvent.click(mic);
    expect(phase === 'idle' ? handlers.onStart : handlers.onStop).toHaveBeenCalledTimes(1);
  });

  it.each([{ key: 'ContextMenu' }, { key: 'F10', shiftKey: true }])('opens vocabulary directly from the keyboard without starting voice', (event) => {
    const handlers = mount();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Speak your message' }), event);
    expect(screen.getByRole('dialog', { name: 'Voice vocabulary' })).toBeTruthy();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(handlers.onStart).not.toHaveBeenCalled();
  });

  it('opens directly from the mic and explains recognition hints, privacy and recording timing', async () => {
    const field = await open();
    expect((field as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('button', { name: 'Remove YouCoded' })).toBeTruthy();
    expect(screen.getByText(/hints for Parakeet, not text replacements/)).toBeTruthy();
    expect(screen.getByText(/stays on this computer/)).toBeTruthy();
    expect(screen.getByText(/next recording/)).toBeTruthy();
    // WHY: fidelity notes belong in the review deck, never painted into the app UI.
    expect(screen.queryByText(/UI preview only|Speech recognition is not connected/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
  });

  it('trims hints, prevents case-insensitive duplicates and saves whole Unicode phrases', async () => {
    const bridge = install().voiceVocabulary;
    const save = vi.spyOn(bridge, 'save');
    const field = await open();
    fireEvent.click(screen.getByRole('button', { name: 'Remove YouCoded' }));
    add(field, '  zoë  ');
    add(field, '\n\n');
    add(field, ' WeCoded themes \n');
    expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(3);
    expect(screen.getByRole('status').textContent).toContain('3 phrases · Unsaved changes');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(['Zoë', 'Côte d’Ivoire', 'WeCoded themes']));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Saved'));
    expect(await bridge.get()).toEqual(['Zoë', 'Côte d’Ivoire', 'WeCoded themes']);
  });

  it('starts empty and lets a saved vocabulary be cleared by removing its chips', async () => {
    install('/?scenario=empty', 'empty');
    const field = await open();
    expect((field as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('status').textContent).toContain('0 phrases');
    add(field, 'Parakeet');
    expect(screen.getByRole('status').textContent).toContain('1 phrase · Unsaved changes');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Parakeet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('0 phrases · Saved'));
  });

  it('renders at most 50 chips initially from 1,200 hints and keeps Add and Save outside the bounded scroller', async () => {
    install('/?scenario=stress', 'stress');
    await open();
    expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(50);
    const list = screen.getByRole('region', { name: 'Vocabulary phrases' });
    expect(list.className).toContain('max-h-48');
    expect(list.className).toContain('overflow-y-auto');
    expect(list.contains(screen.getByRole('button', { name: 'Add' }))).toBe(false);
    expect(list.contains(screen.getByRole('button', { name: 'Save' }))).toBe(false);
    expect(screen.getByRole('status').textContent).toContain('1200 phrases');
  });

  it('adds with the button, explains duplicates, and closes without saving pending edits', async () => {
    const bridge = install().voiceVocabulary;
    const field = await open();
    fireEvent.change(field, { target: { value: 'Youcoded' } });
    expect(screen.getByRole('button', { name: 'Add' })).toHaveProperty('disabled', true);
    expect(screen.getByText('Already in your vocabulary.')).toBeTruthy();
    fireEvent.change(field, { target: { value: 'New phrase' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('button', { name: 'Remove New phrase' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Voice vocabulary' })).toBeNull());
    expect(await bridge.get()).toEqual(['YouCoded', 'Zoë', 'Côte d’Ivoire']);
  });

  it('does not report a failed save as saved and offers retry', async () => {
    const bridge = install().voiceVocabulary;
    vi.spyOn(bridge, 'save').mockRejectedValueOnce(new Error('Preview save failed'));
    const field = await open();
    add(field, 'Updated name');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('button', { name: 'Retry' });
    expect(screen.getByRole('status').textContent).toContain('Unsaved changes');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Saved'));
  });

  it('shows loading, then a failed read with retry instead of an editable false empty state', async () => {
    const bridge = install().voiceVocabulary;
    vi.spyOn(bridge, 'get').mockRejectedValueOnce(new Error('Preview read failed'));
    mount();
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Speak your message' }));
      expect(screen.getByText('Loading vocabulary…')).toBeTruthy();
    await screen.findByRole('button', { name: 'Retry' });
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('textbox', { name: 'Add word or phrase' });
  });

  it('disables editing and duplicate saves until the preview acknowledges the write', async () => {
    const bridge = install().voiceVocabulary;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const save = vi.spyOn(bridge, 'save').mockReturnValueOnce(pending);
    const field = await open();
    add(field, 'New phrase');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(field).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Saving…' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('status').textContent).toContain('Saving…');
    expect(save).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Saved'));
  });

  it.each([ANDROID_LOCAL_CAPABILITIES, REMOTE_SCREEN_CAPABILITIES])('hides the vocabulary menu without local desktop capabilities', (capabilities) => {
    window.claude = { ...window.claude, capabilities };
    mount();
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Speak your message' }));
    expect(screen.queryByRole('dialog', { name: 'Voice vocabulary' })).toBeNull();
  });

  it('never exposes a fake production save when the preview bridge is absent', () => {
    window.claude = { capabilities: DESKTOP_WINDOW_CAPABILITIES } as Window['claude'];
    mount();
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Speak your message' }));
    expect(screen.queryByRole('dialog', { name: 'Voice vocabulary' })).toBeNull();
  });
});
