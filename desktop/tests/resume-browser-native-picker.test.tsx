// @vitest-environment jsdom
// desktop/tests/resume-browser-native-picker.test.tsx
// Task 6 — Destin's ruling: native resume ALWAYS offers the provider-scoped
// model selector, pre-filled from lastUsedModel ONLY when it matches a model
// available on THIS device; the selection becomes the binding; Resume never
// launches without one. This file exercises the ResumeBrowser wiring end to
// end (real ResumeBrowser + real NativeModelSelect, window.claude mocked) —
// the same jsdom + window.claude mocking pattern as development-popup.test.tsx.
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import ResumeBrowser from '../src/renderer/components/ResumeBrowser';

// jsdom does not implement ResizeObserver; stub it so useScrollFade (the
// session list's scroll-fade hook) can mount without throwing.
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

const CATALOG = [
  { id: 'gpt-5', providerId: 'ulid-openrouter', label: 'GPT-5' },
  { id: 'claude-x', providerId: 'ulid-anthropic', label: 'Claude X' },
];
const PROVIDERS = [
  { id: 'ulid-openrouter', type: 'openrouter', label: 'OpenRouter', enabled: true, builtIn: true, hasKey: true, ready: true },
  { id: 'ulid-anthropic', type: 'anthropic', label: 'Anthropic', enabled: true, builtIn: false, hasKey: true, ready: true },
];

function nativeRow(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'native-1',
    name: 'Native Chat',
    projectSlug: 'proj',
    projectPath: '/tmp/proj',
    lastModified: Date.now(),
    size: 100,
    provider: 'native',
    harnessId: 'assistant',
    ...overrides,
  };
}

function ccRow(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'cc-1',
    name: 'CC Chat',
    projectSlug: 'proj2',
    projectPath: '/tmp/proj2',
    lastModified: Date.now(),
    size: 200,
    provider: 'claude',
    ...overrides,
  };
}

function mockWindowClaude(sessions: any[]) {
  (window as any).claude = {
    session: {
      browse: vi.fn().mockResolvedValue(sessions),
      setFlag: vi.fn().mockResolvedValue({ ok: true }),
      setTag: vi.fn().mockResolvedValue({ ok: true }),
      setNote: vi.fn().mockResolvedValue({ ok: true }),
    },
    tags: { list: vi.fn().mockResolvedValue([]) },
    providers: {
      catalog: vi.fn().mockResolvedValue(CATALOG),
      list: vi.fn().mockResolvedValue(PROVIDERS),
    },
    on: {},
  };
}

// Expands a row by clicking its name text (handleSelectSession).
async function expandRow(name: string) {
  fireEvent.click(await screen.findByText(name));
}

/** The model list moved behind a dropdown (2026-07-30, unified ModelPicker), so
 *  reaching a model row now takes a click on the trigger first. Every
 *  BEHAVIOURAL assertion below is unchanged — what moved is the DOM path to it.
 *  In particular "prefill enables Resume without any click" still asserts
 *  exactly that: it checks the button BEFORE opening the dropdown. */
async function openModelPicker() {
  fireEvent.click(await screen.findByRole('button', { name: 'Model' }));
  return screen.findByPlaceholderText('Search all models…');
}

describe('ResumeBrowser — native resume model selector (Task 6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('offers the model picker for a native row, listing every native model, and no CC skip-permissions control', async () => {
    mockWindowClaude([nativeRow()]);
    render(<ResumeBrowser open={true} onClose={() => {}} onResume={() => {}} />);
    await expandRow('Native Chat');

    // Searching (not the default favourites view) is what lists the catalogue.
    // Queried by ROLE because each row's text is split across two elements —
    // the model label and the " · <source>" span — so a text matcher misses it.
    await openModelPicker();
    const field = screen.getByPlaceholderText('Search all models…');

    fireEvent.change(field, { target: { value: 'GPT' } });
    expect(await screen.findByText(/GPT-5/)).toBeInTheDocument();

    fireEvent.change(field, { target: { value: 'Claude X' } });
    expect(await screen.findByText(/Claude X/)).toBeInTheDocument();
    // CC-only controls must NOT appear for a native row.
    expect(screen.queryByText('Skip Permissions')).not.toBeInTheDocument();
  });

  it('prefill match auto-selects the matching model and enables Resume without any click', async () => {
    const onResume = vi.fn();
    mockWindowClaude([nativeRow({
      lastUsedModel: { modelId: 'gpt-5', providerType: 'openrouter', providerLabel: 'OpenRouter' },
    })]);
    render(<ResumeBrowser open={true} onClose={() => {}} onResume={onResume} />);
    await expandRow('Native Chat');

    // THE point of this test: no interaction at all. The prefill resolves and
    // Resume enables without the dropdown ever being opened.
    const resumeBtn = await screen.findByRole('button', { name: 'Resume Session' });
    await waitFor(() => expect(resumeBtn).not.toBeDisabled());
    // And the trigger names the resolved model, so the pick is visible unopened.
    await waitFor(() => expect(screen.getByText(/GPT-5/)).toBeInTheDocument());

    fireEvent.click(resumeBtn);
    expect(onResume).toHaveBeenCalledWith(
      'native-1', 'proj', '/tmp/proj',
      expect.anything(), expect.anything(), expect.anything(),
      'native',
      { providerId: 'ulid-openrouter', modelId: 'gpt-5' },
    );
  });

  it('prefill miss leaves nothing selected and Resume disabled until a manual pick', async () => {
    const onResume = vi.fn();
    // modelId not present in the catalog at all — never substitute, never error.
    mockWindowClaude([nativeRow({
      lastUsedModel: { modelId: 'gpt-4-nonexistent', providerType: 'openrouter', providerLabel: 'OpenRouter' },
    })]);
    render(<ResumeBrowser open={true} onClose={() => {}} onResume={onResume} />);
    await expandRow('Native Chat');

    // Nothing pre-selected — Resume stays disabled, unopened.
    const resumeBtn = await screen.findByRole('button', { name: 'Resume Session' });
    expect(resumeBtn).toBeDisabled();

    // Manual pick enables Resume and flows through onResume as the 8th arg.
    await openModelPicker();
    fireEvent.change(screen.getByPlaceholderText('Search all models…'), { target: { value: 'Claude X' } });
    fireEvent.click(await screen.findByText(/Claude X/));
    await waitFor(() => expect(resumeBtn).not.toBeDisabled());
    fireEvent.click(resumeBtn);
    expect(onResume).toHaveBeenCalledWith(
      'native-1', 'proj', '/tmp/proj',
      expect.anything(), expect.anything(), expect.anything(),
      'native',
      { providerId: 'ulid-anthropic', modelId: 'claude-x' },
    );
  });

  it('leaves a Claude Code row unaffected: still shows the CC model/skip-permissions row, no NativeModelSelect', async () => {
    mockWindowClaude([ccRow()]);
    render(<ResumeBrowser open={true} onClose={() => {}} onResume={() => {}} />);
    await expandRow('CC Chat');

    expect(await screen.findByText('Skip Permissions')).toBeInTheDocument();
    // The picker is closed by default, so its search field is absent until opened.
    expect(screen.queryByPlaceholderText('Search all models…')).not.toBeInTheDocument();
    // CC Resume never gates on a native binding.
    const resumeBtn = screen.getByRole('button', { name: 'Resume Session' });
    expect(resumeBtn).not.toBeDisabled();
  });

  // The preview panel's action card stays mounted while you move between
  // conversations, and the picker pre-fills once per mount — so only the FIRST
  // conversation previewed used to get its last model; the next opened on
  // "Choose a model…" (Destin, 2026-09-11).
  it('pre-fills each previewed conversation with ITS last model, not only the first one', async () => {
    // Wide viewport, declared: the preview panel only exists there.
    (window as any).matchMedia = (q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {} });
    Element.prototype.scrollIntoView = vi.fn();
    mockWindowClaude([
      nativeRow({ sessionId: 'a3f2aaaa-1111-4111-8111-000000000001', name: 'First Chat',
        lastUsedModel: { modelId: 'gpt-5', providerType: 'openrouter', providerLabel: 'OpenRouter' } }),
      nativeRow({ sessionId: 'a3f2aaaa-1111-4111-8111-000000000002', name: 'Second Chat',
        lastUsedModel: { modelId: 'claude-x', providerType: 'anthropic', providerLabel: 'Anthropic' } }),
    ]);
    (window as any).claude.chatsearch = {
      read: vi.fn(async () => ({ ok: true, messages: [{ role: 'user', content: 'hello', timestamp: 1, seq: 0, droppedToolCalls: 0 }], hasMore: false })),
    };
    render(<ResumeBrowser open={true} onClose={() => {}} onResume={() => {}} />);

    fireEvent.click(await screen.findByText('First Chat'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Model' })).toHaveTextContent('GPT-5'));

    fireEvent.click(screen.getByText('Second Chat'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Model' })).toHaveTextContent('Claude X'));
    delete (window as any).matchMedia;
  });
});
