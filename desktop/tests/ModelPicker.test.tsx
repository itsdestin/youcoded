// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen, waitFor, act } from '@testing-library/react';
import ModelPicker, { type ModelChoice } from '../src/renderer/components/model/ModelPicker';
import { installFiringIntersectionObserver } from './helpers/firing-intersection-observer';
import { REVEAL_CHUNK } from '../src/renderer/hooks/use-chunked-reveal';

// ── A failed provider load ───────────────────────────────────────────────────
/**
 * "You have not set up any model providers" means none are set up — not that the list
 * could not be read.
 *
 * Error inventory 2026-09-10, false message 9. ModelPicker loads providers and the model
 * catalog with `.catch(() => [])` on each call, so a failed load produced no rows,
 * `anyPickable` went false, and a native-only picker (a native session's model dialog,
 * Resume options) told someone with providers configured that they had none — and
 * offered "Add provider" for things they already had. A remote timeout reaches this too.
 * Pickers that include Claude were spared only because Claude rows survive a failed load.
 */
describe('ModelPicker — a failed provider load is not "no providers set up"', () => {
  function bridge(list: ReturnType<typeof vi.fn>, catalog: ReturnType<typeof vi.fn>) {
    (globalThis as any).window.claude = {
      providers: { list, catalog },
      models: { onDownloadProgress: () => () => {} },
    };
  }

  const openPanel = async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Model' }));
  };

  beforeEach(() => { (globalThis as any).window = (globalThis as any).window ?? {}; });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); delete (window as any).claude; });

  it('a provider list that failed says it could not load, with Retry', async () => {
    bridge(
      vi.fn().mockRejectedValue(new Error("Error invoking remote method 'providers:list': Error: config unreadable")),
      vi.fn().mockResolvedValue([]),
    );
    render(<ModelPicker value={null} onSelect={() => {}} includeClaude={false} />);
    await openPanel();

    expect(await screen.findByText(/couldn.t load your models/i)).toBeInTheDocument();
    expect(screen.queryByText('You have not set up any model providers.')).toBeNull();
    expect(screen.queryByText(/Error invoking remote method/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('a catalog that failed says so too', async () => {
    bridge(
      vi.fn().mockResolvedValue([{ id: 'openrouter', type: 'openrouter', label: 'OpenRouter', ready: true }]),
      vi.fn().mockRejectedValue(new Error('Request providers:catalog timed out')),
    );
    render(<ModelPicker value={null} onSelect={() => {}} includeClaude={false} />);
    await openPanel();

    expect(await screen.findByText(/couldn.t load your models/i)).toBeInTheDocument();
    expect(screen.queryByText('You have not set up any model providers.')).toBeNull();
  });

  it('Retry loads again, and a real empty result may then say none are set up', async () => {
    const list = vi.fn().mockRejectedValueOnce(new Error('not readable')).mockResolvedValue([]);
    bridge(list, vi.fn().mockResolvedValue([]));
    render(<ModelPicker value={null} onSelect={() => {}} includeClaude={false} />);
    await openPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('You have not set up any model providers.')).toBeInTheDocument();
  });
});

// ── The list catches up after a download ─────────────────────────────────────
// WHAT DESTIN DID (2026-09-06): opened the new-session menu, went off and set up
// a local model, came back to the STILL-OPEN menu and searched for it. Nothing.
// "the model list doesn't refresh unless i close that new session menu and
// re-open it." The fetch ran once when the picker mounted and never again, so
// the list was a snapshot of whatever existed when the screen was built.
//
// NOT `engine.onModelsChanged`. That channel is declared in the preload and in
// shared/types.ts, the renderer can subscribe to it, and NOTHING in the main
// process ever sends it:
//   $ rg -n "ENGINE_MODELS_CHANGED" src/
//   src/shared/types.ts:1833  src/main/preload.ts:385  src/main/preload.ts:1395-1396
// (a declaration and a listener, no sender). Even wired up it only fires while
// the engine PROCESS is running, and the engine is not running while you are
// downloading a model — it starts on your first message. The download-progress
// push, which the Local Models screen already uses, is the signal that actually
// fires at the moment the list changes.
describe('list refresh after a download', () => {
  const BEFORE = [{ id: 'gpt-5', providerId: 'openrouter', label: 'GPT-5' }];
  const AFTER = [...BEFORE, { id: 'Qwen3.5-9B-UD-Q4_K_XL', providerId: 'local', label: 'Qwen3.5 9B' }];

  let catalogRows: any[];
  let subscribers: Array<(p: any) => void>;
  let unsubscribes: number;

  function bridge() {
    subscribers = [];
    unsubscribes = 0;
    (globalThis as any).window.claude = {
      providers: {
        list: vi.fn(async () => [
          { id: 'openrouter', type: 'openrouter', label: 'OpenRouter', ready: true },
          { id: 'local', type: 'local-engine', label: 'Local', ready: true },
        ]),
        catalog: vi.fn(async () => catalogRows),
      },
      models: {
        onDownloadProgress: (cb: (p: any) => void) => {
          subscribers.push(cb);
          return () => { unsubscribes += 1; subscribers = subscribers.filter((s) => s !== cb); };
        },
      },
    };
  }

  const openPanel = async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Model' }));
    return screen.findByPlaceholderText('Search all models…');
  };
  const search = (q: string) => fireEvent.change(screen.getByPlaceholderText('Search all models…'), { target: { value: q } });

  beforeEach(() => {
    (globalThis as any).window = (globalThis as any).window ?? {};
    catalogRows = BEFORE;
    bridge();
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  describe('ModelPicker keeps its list current', () => {
    it("a model downloaded while the menu is OPEN shows up without closing it — Destin's case", async () => {
      render(<ModelPicker value={null} onSelect={() => {}} />);
      const field = await openPanel();
      expect(field).toBeTruthy();
      search('Qwen');
      await waitFor(() => expect(screen.queryByText(/Qwen3.5 9B/)).toBeNull());

      // The download finishes somewhere else in the app, with this menu still open.
      catalogRows = AFTER;
      expect(subscribers.length, 'the picker is listening at all').toBeGreaterThan(0);
      subscribers.forEach((cb) => cb({ downloadId: 'd1', state: 'done' }));

      await waitFor(() => expect(screen.getByText(/Qwen3.5 9B/)).toBeTruthy());
    });

    it('a download still in progress does NOT refetch — only a finished one does', async () => {
      render(<ModelPicker value={null} onSelect={() => {}} />);
      await openPanel();
      await waitFor(() => expect((window.claude.providers.catalog as any).mock.calls.length).toBeGreaterThan(0));
      const before = (window.claude.providers.catalog as any).mock.calls.length;
      subscribers.forEach((cb) => cb({ downloadId: 'd1', state: 'downloading' }));
      subscribers.forEach((cb) => cb({ downloadId: 'd1', state: 'verifying' }));
      await new Promise((r) => setTimeout(r, 30));
      expect((window.claude.providers.catalog as any).mock.calls.length).toBe(before);
    });

    it('opening the menu again asks for a fresh list — "went away and came back"', async () => {
      render(<ModelPicker value={null} onSelect={() => {}} />);
      await waitFor(() => expect((window.claude.providers.catalog as any).mock.calls.length).toBe(1));
      const trigger = await screen.findByRole('button', { name: 'Model' });
      fireEvent.click(trigger);                       // open
      await waitFor(() => expect((window.claude.providers.catalog as any).mock.calls.length).toBe(2));
      fireEvent.click(trigger);                       // close — must NOT refetch
      await new Promise((r) => setTimeout(r, 30));
      expect((window.claude.providers.catalog as any).mock.calls.length).toBe(2);
      catalogRows = AFTER;
      fireEvent.click(trigger);                       // open again
      await waitFor(() => expect((window.claude.providers.catalog as any).mock.calls.length).toBe(3));
      search('Qwen');
      await waitFor(() => expect(screen.getByText(/Qwen3.5 9B/)).toBeTruthy());
    });

    it('stops listening when the picker goes away', () => {
      const view = render(<ModelPicker value={null} onSelect={() => {}} />);
      expect(subscribers.length).toBe(1);
      view.unmount();
      expect(unsubscribes, 'the subscription is torn down').toBe(1);
      expect(subscribers.length).toBe(0);
    });
  });

  // ── The in-session picker, same fix ──────────────────────────────────────────
  // ModelPickerPopup is the one you get from a session's header. Worth knowing
  // before reading these: its model LIST is the shared <ModelPicker> above, so the
  // fix arrives there. What the popup fetches for itself is only used to work out
  // which row is the session's current model, and it had the same one-shot
  // problem — after downloading a model and switching to it, the popup could not
  // name its provider until it was reopened. Two subscriptions per render is
  // therefore correct: the popup's own, and the nested picker's.
  describe('ModelPickerPopup keeps its list current', () => {
    const props = {
      open: true, onClose: () => {}, sessionId: 's1', currentModel: null,
      onSelectModel: () => {}, provider: 'native' as const, sendPtyCommand: () => true,
    };

    function nativeBridge() {
      bridge();
      (window.claude as any).native = { sessionsList: async () => [] };
    }

    it('a model downloaded with the popup open appears without reopening it', async () => {
      nativeBridge();
      const { default: ModelPickerPopup } = await import('../src/renderer/components/ModelPickerPopup');
      render(<ModelPickerPopup {...props} />);
      // No click needed: the popup's picker now opens straight to the
      // search+list view (status-bar chip default-expand change), so a click on
      // the "Model" trigger here would TOGGLE it closed instead of opening it.
      fireEvent.change(await screen.findByPlaceholderText(/Search/i), { target: { value: 'Qwen' } });
      await waitFor(() => expect(screen.queryByText(/Qwen3.5 9B/)).toBeNull());

      catalogRows = AFTER;
      expect(subscribers.length, 'the popup and its picker are both listening').toBe(2);
      subscribers.forEach((cb) => cb({ downloadId: 'd1', state: 'done' }));
      await waitFor(() => expect(screen.getByText(/Qwen3.5 9B/)).toBeTruthy());
    });

    it('the popup re-reads its own catalog when a download lands', async () => {
      nativeBridge();
      const { default: ModelPickerPopup } = await import('../src/renderer/components/ModelPickerPopup');
      render(<ModelPickerPopup {...props} />);
      await waitFor(() => expect((window.claude.providers.catalog as any).mock.calls.length).toBe(2));
      subscribers.forEach((cb) => cb({ downloadId: 'd1', state: 'done' }));
      // 4, not 3: the popup re-reads, and so does the picker inside it — its
      // panel now opens by default (status-bar chip default-expand change), so
      // it has a visible list to correct rather than a shut one to leave alone.
      await waitFor(() => expect((window.claude.providers.catalog as any).mock.calls.length).toBe(4));
    });

    it('stops listening when the popup goes away', async () => {
      nativeBridge();
      const { default: ModelPickerPopup } = await import('../src/renderer/components/ModelPickerPopup');
      const view = render(<ModelPickerPopup {...props} />);
      expect(subscribers.length).toBe(2);
      view.unmount();
      expect(unsubscribes, 'both subscriptions are torn down').toBe(2);
      expect(subscribers.length).toBe(0);
    });
  });
});

// ── Selectable models sort first ─────────────────────────────────────────────
describe('ModelPicker selectable-first ordering', () => {
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

  // WHY: a big catalog (an OpenRouter-class provider is dozens of models; stress
  // scale is 300+) used to draw every matching row at once — ~24,000 page
  // elements for a one-letter query. Search results now share the same
  // draw-50-then-grow-on-scroll window every other long list uses.
  describe('search results reveal', () => {
    let io: ReturnType<typeof installFiringIntersectionObserver>;
    beforeEach(() => { io = installFiringIntersectionObserver(); });
    afterEach(() => io.restore());

    it('draws one chunk of a 400-model search result and grows it on scroll', async () => {
      providers = [{ id: 'astra', type: 'openrouter', label: 'Astra', ready: true }];
      catalog = Array.from({ length: 400 }, (_, i) => ({
        id: `astra-${i}`, providerId: 'astra', label: `Astra Model ${i}`,
      }));

      render(<ModelPicker value={null} onSelect={() => {}} includeClaude={false} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Model' }));
      fireEvent.change(await screen.findByPlaceholderText('Search all models…'), { target: { value: 'a' } });

      await waitFor(() => expect(modelRows().length).toBe(REVEAL_CHUNK));
      act(() => io.fireAll());
      await waitFor(() => expect(modelRows().length).toBe(REVEAL_CHUNK * 2));
    });
  });
});
