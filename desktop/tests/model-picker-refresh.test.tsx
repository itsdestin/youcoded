// @vitest-environment jsdom
// model-picker-refresh.test.tsx — the new-session model list catches up.
//
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
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import ModelPicker from '../src/renderer/components/model/ModelPicker';

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
