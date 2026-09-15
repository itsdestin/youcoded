// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ModelPicker, { type ModelChoice } from '../src/renderer/components/model/ModelPicker';

let providers: any[];
let catalog: any[];
let storedFavorites: string | null = null;

const favoriteStorage = {
  getItem: (key: string) => key === 'youcoded-model-favorites' ? storedFavorites : null,
  setItem: (key: string, value: string) => { if (key === 'youcoded-model-favorites') storedFavorites = value; },
  removeItem: (key: string) => { if (key === 'youcoded-model-favorites') storedFavorites = null; },
  clear: () => { storedFavorites = null; },
};

function bridge() {
  (globalThis as any).window.claude = {
    providers: {
      list: vi.fn(async () => providers),
      catalog: vi.fn(async () => catalog),
    },
    models: {
      onDownloadProgress: () => () => {},
    },
  };
}

function modelRows(): HTMLButtonElement[] {
  const panel = document.querySelector('[data-model-picker-portal]') ?? document.body;
  return [...panel.querySelectorAll('button')]
    .filter((button) => button.textContent?.includes(' · ')) as HTMLButtonElement[];
}

function rowLabels(): string[] {
  return modelRows().map((button) => button.textContent?.replace(/\s+/g, ' ').trim() ?? '');
}

const chatgptChoice: ModelChoice = { runtime: 'native', providerId: 'chatgpt', modelId: 'astra-chatgpt' };

beforeEach(() => {
  (globalThis as any).window = (globalThis as any).window ?? {};
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: favoriteStorage });
  favoriteStorage.clear();
  providers = [];
  catalog = [];
  bridge();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ModelPicker selectable-first ordering', () => {
  it('puts a searched selectable Astra result above an unavailable OpenRouter result without changing selected or disabled behavior', async () => {
    providers = [
      { id: 'openrouter', type: 'openrouter', label: 'OpenRouter', ready: false },
      { id: 'chatgpt', type: 'chatgpt', label: 'ChatGPT', ready: true },
    ];
    catalog = [
      { id: 'astra-openrouter', providerId: 'openrouter', label: 'Astra OpenRouter' },
      { id: 'astra-chatgpt', providerId: 'chatgpt', label: 'Astra ChatGPT' },
    ];

    render(<ModelPicker value={chatgptChoice} onSelect={() => {}} includeClaude={false} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Model' }));
    fireEvent.change(await screen.findByPlaceholderText('Search all models…'), { target: { value: 'Astra' } });

    await waitFor(() => expect(rowLabels()).toEqual([
      'Astra ChatGPT · ChatGPT',
      'Astra OpenRouter · OpenRouter',
    ]));
    const selectable = modelRows().find((button) => button.textContent?.includes('Astra ChatGPT'))!;
    const unavailable = modelRows().find((button) => button.textContent?.includes('Astra OpenRouter'))!;
    expect(selectable.getAttribute('aria-pressed')).toBe('true');
    expect(selectable.disabled).toBe(false);
    expect(unavailable.disabled).toBe(true);
  });

  it('keeps catalogue order stable within the selectable and unavailable groups', async () => {
    providers = [
      { id: 'off-one', type: 'openrouter', label: 'Off one', ready: false },
      { id: 'on-one', type: 'chatgpt', label: 'On one', ready: true },
      { id: 'off-two', type: 'openrouter', label: 'Off two', ready: false },
      { id: 'on-two', type: 'chatgpt', label: 'On two', ready: true },
    ];
    catalog = [
      { id: 'off-one', providerId: 'off-one', label: 'Astra unavailable first' },
      { id: 'on-one', providerId: 'on-one', label: 'Astra selectable first' },
      { id: 'off-two', providerId: 'off-two', label: 'Astra unavailable second' },
      { id: 'on-two', providerId: 'on-two', label: 'Astra selectable second' },
    ];

    render(<ModelPicker value={null} onSelect={() => {}} includeClaude={false} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Model' }));
    fireEvent.change(await screen.findByPlaceholderText('Search all models…'), { target: { value: 'Astra' } });

    await waitFor(() => expect(rowLabels()).toEqual([
      'Astra selectable first · On one',
      'Astra selectable second · On two',
      'Astra unavailable first · Off one',
      'Astra unavailable second · Off two',
    ]));
  });

  it('does not let a pinned unavailable selected non-favourite outrank selectable favourites, while retaining its unavailable-group position', async () => {
    providers = [
      { id: 'offline-selected', type: 'openrouter', label: 'Offline selected', ready: false },
      { id: 'offline-favourite', type: 'openrouter', label: 'Offline favourite', ready: false },
      { id: 'ready-favourite', type: 'chatgpt', label: 'Ready favourite', ready: true },
    ];
    catalog = [
      { id: 'selected', providerId: 'offline-selected', label: 'Astra selected offline' },
      { id: 'offline-favourite', providerId: 'offline-favourite', label: 'Astra favourite offline' },
      { id: 'ready-favourite', providerId: 'ready-favourite', label: 'Astra favourite ready' },
    ];
    localStorage.setItem('youcoded-model-favorites', JSON.stringify([
      'offline-favourite:offline-favourite',
      'ready-favourite:ready-favourite',
    ]));

    render(
      <ModelPicker
        value={{ runtime: 'native', providerId: 'offline-selected', modelId: 'selected' }}
        onSelect={() => {}}
        includeClaude={false}
        defaultOpen
        layout="inline"
        pinSelectedToTop
      />,
    );

    await waitFor(() => expect(rowLabels()).toEqual([
      'Astra favourite ready · Ready favourite',
      'Astra selected offline · Offline selected',
      'Astra favourite offline · Offline favourite',
    ]));
  });
});
