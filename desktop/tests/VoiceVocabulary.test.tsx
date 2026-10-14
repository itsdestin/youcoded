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
  return screen.findByRole('textbox', { name: 'Add a word' });
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
    expect(screen.getByText(/stay on this computer/)).toBeTruthy();
    expect(screen.getByText(/next recording/)).toBeTruthy();
    // WHY: fidelity notes belong in the review deck, never painted into the app UI.
    expect(screen.queryByText(/UI preview only|Speech recognition is not connected/)).toBeNull();
    // vocab-chips-2#D-1/#D-2: saves as you go and adds on Enter — no Save, no Add button.
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
    expect((field as HTMLInputElement).placeholder).toContain('press Enter');
  });

  it('trims hints, prevents case-insensitive duplicates and saves each change at once', async () => {
    const bridge = install().voiceVocabulary;
    const save = vi.spyOn(bridge, 'save');
    const field = await open();
    fireEvent.click(screen.getByRole('button', { name: 'Remove YouCoded' }));
    await waitFor(() => expect(save).toHaveBeenLastCalledWith(['Zoë', 'Côte d’Ivoire']));
    add(field, '  zoë  ');
    add(field, '\n\n');
    add(field, ' WeCoded themes \n');
    await waitFor(() => expect(save).toHaveBeenLastCalledWith(['Zoë', 'Côte d’Ivoire', 'WeCoded themes']));
    expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(3);
    expect(await bridge.get()).toEqual(['Zoë', 'Côte d’Ivoire', 'WeCoded themes']);
  });

  it('starts empty and lets a saved vocabulary be cleared by removing its chips', async () => {
    const bridge = install('/?scenario=empty', 'empty').voiceVocabulary;
    const field = await open();
    expect(screen.getByText('No words yet.')).toBeTruthy();
    add(field, 'Parakeet');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove Parakeet' })).toHaveProperty('disabled', false));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Parakeet' }));
    await waitFor(async () => expect(await bridge.get()).toEqual([]));
    expect(screen.getByText('No words yet.')).toBeTruthy();
  });

  it('renders at most 50 chips initially from 1,200 hints and keeps the field outside the bounded scroller', async () => {
    install('/?scenario=stress', 'stress');
    const field = await open();
    expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(50);
    const list = screen.getByRole('region', { name: 'Vocabulary phrases' });
    expect(list.className).toContain('max-h-48');
    expect(list.className).toContain('overflow-y-auto');
    expect(list.contains(field)).toBe(false);
  });

  it('explains duplicates, refuses them, and a word added before closing is already saved', async () => {
    const bridge = install().voiceVocabulary;
    const field = await open();
    fireEvent.change(field, { target: { value: 'Youcoded' } });
    expect(screen.getByText('Already in your vocabulary.')).toBeTruthy();
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(3);
    add(field, 'New phrase');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove New phrase' })).toHaveProperty('disabled', false));
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Voice vocabulary' })).toBeNull());
    expect(await bridge.get()).toEqual(['YouCoded', 'Zoë', 'Côte d’Ivoire', 'New phrase']);
  });

  it('does not report a failed save as saved and Try again saves it', async () => {
    const bridge = install().voiceVocabulary;
    const save = vi.spyOn(bridge, 'save').mockRejectedValueOnce(new Error('Preview save failed'));
    const field = await open();
    add(field, 'Updated name');
    await screen.findByRole('button', { name: 'Try again' });
    // The word stays on screen so nothing typed is lost.
    expect(screen.getByRole('button', { name: 'Remove Updated name' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull());
    expect(save).toHaveBeenCalledTimes(2);
    expect(await bridge.get()).toContain('Updated name');
  });

  it('shows loading, then a failed read with retry instead of an editable false empty state', async () => {
    const bridge = install().voiceVocabulary;
    vi.spyOn(bridge, 'get').mockRejectedValueOnce(new Error('Preview read failed'));
    mount();
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Speak your message' }));
    expect(screen.getByText('Loading vocabulary…')).toBeTruthy();
    await screen.findByRole('button', { name: 'Try again' });
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('textbox', { name: 'Add a word' });
  });

  it('disables editing while a save is in flight, so changes never race', async () => {
    const bridge = install().voiceVocabulary;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const save = vi.spyOn(bridge, 'save').mockReturnValueOnce(pending);
    const field = await open();
    add(field, 'New phrase');
    expect(field).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Remove YouCoded' })).toHaveProperty('disabled', true);
    expect(save).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() => expect(field).toHaveProperty('disabled', false));
  });

  // WHY (final review, guide "Status and notices"): the bridge's raw words are for a bug report,
  // so the notice says one fixed sentence and the raw text waits under a Details fold.
  it('a failed save says a plain sentence with Try again and keeps the raw words under Details', async () => {
    const bridge = install().voiceVocabulary;
    vi.spyOn(bridge, 'save').mockRejectedValueOnce(new Error('EACCES: permission denied, open vocab.json'));
    const field = await open();
    add(field, 'New phrase');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Your changes couldn’t be saved.');
    expect(alert.textContent).not.toContain('EACCES');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByText(/EACCES/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Details/ }));
    expect(screen.getByText(/EACCES/)).toBeTruthy();
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
