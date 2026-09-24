// @vitest-environment jsdom
// ResumeBrowser — the Resume browser, mounted for real with window.claude mocked.
// WHY a second file: ResumeBrowser-filter-row.test.tsx replaces
// use-narrow-viewport with a file-wide vi.mock, while every section here drives
// the real hook through window.matchMedia; a vi.mock cannot be scoped to part of
// a file.
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// Counts card renders: every list card with a recorded model resolves its brand
// once per render, keyed by a model id unique to that card.
const brandCalls = vi.hoisted(() => new Map<string, number>());
vi.mock('../src/renderer/components/provider-brand', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/components/provider-brand')>();
  return {
    ...actual,
    resolveModelBrand: (modelId: string, providerType?: any) => {
      brandCalls.set(modelId, (brandCalls.get(modelId) ?? 0) + 1);
      return actual.resolveModelBrand(modelId, providerType);
    },
  };
});

import ResumeBrowser from '../src/renderer/components/ResumeBrowser';
import { claudeAliasForModelId, isPlaceholderModelId } from '../src/shared/model-ids';
import { previewPage } from './helpers/preview-page';
import { installFiringIntersectionObserver } from './helpers/firing-intersection-observer';
import { REVEAL_CHUNK } from '../src/renderer/hooks/use-chunked-reveal';

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

// WHY: each section below was its own file and so started without
// window.matchMedia (jsdom has none, which the narrow-viewport hook reads as
// "wide"). A section that stubs it removes the stub when it ends, so the next
// section starts from the same place its own file did.
const restoreViewport = () => { delete (window as any).matchMedia; };

// An expanded Claude Code row's model dropdown used to open on `defaultModel`
// — the app-wide Settings default — regardless of what that conversation had
// actually run on. Resuming an Opus conversation silently offered whatever the
// global default was, while the card's own model chip showed Opus two lines
// above. These tests pin the per-row prefill and, just as importantly, the
// cases that must still fall back rather than guess.
describe('model prefill for Claude Code rows', () => {
  // These pin the SINGLE-COLUMN browser — the layout a phone, a narrow window or
  // Android gets, where clicking a card still expands the resume controls inside
  // it. On a wide desktop the same click fills the preview panel instead and the
  // controls live in the card at its foot (the 2026-09-10 design rounds), so
  // without this stub jsdom (which has no matchMedia, hence "wide") would run
  // these against a layout whose cards deliberately never expand.
  beforeAll(() => {
    (window as any).matchMedia = (q: string) => ({
      matches: q === '(max-width: 639.98px)',
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    });
  });
  afterAll(restoreViewport);

  // One ready native provider so the picker's catalog fetch resolves normally;
  // no CC row ever reads it.
  const PROVIDERS = [
    { id: 'ulid-openrouter', type: 'openrouter', label: 'OpenRouter', enabled: true, builtIn: true, hasKey: true, ready: true },
  ];
  const CATALOG = [{ id: 'anthropic/claude-sonnet-4.5', providerId: 'ulid-openrouter', label: 'Claude Sonnet 4.5' }];

  function ccRow(overrides: Record<string, unknown> = {}) {
    return {
      sessionId: 'cc-1',
      name: 'CC Chat',
      projectSlug: 'proj',
      projectPath: '/tmp/proj',
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

  const expandRow = async (name: string) => fireEvent.click(await screen.findByText(name));

  /** The alias the Resume click actually forwards — 4th positional arg. */
  const forwardedAlias = (onResume: ReturnType<typeof vi.fn>) => onResume.mock.calls[0][3];

  async function resumeAndReadAlias(onResume: ReturnType<typeof vi.fn>) {
    fireEvent.click(await screen.findByRole('button', { name: 'Resume Session' }));
    await waitFor(() => expect(onResume).toHaveBeenCalled());
    return forwardedAlias(onResume);
  }

  describe('claudeAliasForModelId', () => {
    it('maps every family, dated or not, to the alias the picker offers', () => {
      expect(claudeAliasForModelId('claude-opus-5')).toBe('opus[1m]');
      expect(claudeAliasForModelId('claude-opus-4-5-20251101')).toBe('opus[1m]');
      expect(claudeAliasForModelId('claude-sonnet-4-6')).toBe('sonnet');
      expect(claudeAliasForModelId('claude-haiku-4-5-20251001')).toBe('haiku');
      expect(claudeAliasForModelId('claude-fable-5')).toBe('fable');
      // A transcript sometimes records the bare alias the user typed.
      expect(claudeAliasForModelId('sonnet')).toBe('sonnet');
      expect(claudeAliasForModelId('OPUS')).toBe('opus[1m]');
    });

    it('returns null for anything outside the four families', () => {
      // `<synthetic>` should never reach here (every caller drops it first), but
      // the mapping must not invent a pick if one ever does.
      expect(claudeAliasForModelId('<synthetic>')).toBeNull();
      expect(claudeAliasForModelId('gpt-5.6-sol')).toBeNull();
      expect(claudeAliasForModelId('')).toBeNull();
      expect(claudeAliasForModelId('   ')).toBeNull();
    });
  });

  describe('isPlaceholderModelId', () => {
    it('matches CC placeholders, padded or not, and nothing else', () => {
      expect(isPlaceholderModelId('<synthetic>')).toBe(true);
      expect(isPlaceholderModelId('  <synthetic>  ')).toBe(true);
      expect(isPlaceholderModelId('<>')).toBe(true);
      expect(isPlaceholderModelId('claude-opus-5')).toBe(false);
      expect(isPlaceholderModelId('')).toBe(false);
      // Not a placeholder just because it CONTAINS brackets.
      expect(isPlaceholderModelId('claude-opus-5<beta')).toBe(false);
    });
  });

  describe('ResumeBrowser — Claude Code model prefill', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it('opens on the model the row last ran on, not the app-wide default', async () => {
      const onResume = vi.fn();
      mockWindowClaude([ccRow({
        lastUsedModel: { modelId: 'claude-opus-5', providerType: 'claude-code', providerLabel: 'Claude Code' },
      })]);
      render(<ResumeBrowser open={true} onClose={() => {}} onResume={onResume} defaultModel="sonnet" />);
      await expandRow('CC Chat');

      // Visible without opening the dropdown — the trigger names the resolved pick.
      expect(await screen.findByRole('button', { name: 'Model' })).toHaveTextContent(/Opus/);
      expect(await resumeAndReadAlias(onResume)).toBe('opus[1m]');
    });

    it('falls back to the app-wide default when the row records no model', async () => {
      const onResume = vi.fn();
      mockWindowClaude([ccRow()]);
      render(<ResumeBrowser open={true} onClose={() => {}} onResume={onResume} defaultModel="haiku" />);
      await expandRow('CC Chat');
      expect(await resumeAndReadAlias(onResume)).toBe('haiku');
    });

    it('falls back to the app-wide default for an unrecognised model id', async () => {
      const onResume = vi.fn();
      mockWindowClaude([ccRow({
        lastUsedModel: { modelId: '<synthetic>', providerType: 'claude-code', providerLabel: 'Claude Code' },
      })]);
      render(<ResumeBrowser open={true} onClose={() => {}} onResume={onResume} defaultModel="sonnet" />);
      await expandRow('CC Chat');
      expect(await resumeAndReadAlias(onResume)).toBe('sonnet');
    });

    it('re-derives per row: collapsing an Opus row and expanding a Sonnet row does not carry Opus over', async () => {
      // The prefill lives in ONE piece of state shared by every card, so a stale
      // value leaking between rows is the obvious way this breaks.
      const onResume = vi.fn();
      mockWindowClaude([
        ccRow({ sessionId: 'cc-opus', name: 'Opus Chat', lastUsedModel: { modelId: 'claude-opus-5', providerType: 'claude-code', providerLabel: 'Claude Code' } }),
        ccRow({ sessionId: 'cc-haiku', name: 'Haiku Chat', lastUsedModel: { modelId: 'claude-haiku-4-5-20251001', providerType: 'claude-code', providerLabel: 'Claude Code' } }),
      ]);
      render(<ResumeBrowser open={true} onClose={() => {}} onResume={onResume} defaultModel="sonnet" />);

      await expandRow('Opus Chat');
      await waitFor(() => expect(screen.getByRole('button', { name: 'Model' })).toHaveTextContent(/Opus/));
      await expandRow('Opus Chat');   // collapse
      await expandRow('Haiku Chat');
      await waitFor(() => expect(screen.getByRole('button', { name: 'Model' })).toHaveTextContent(/Haiku/));
      expect(await resumeAndReadAlias(onResume)).toBe('haiku');
    });

    it('a manual pick still wins over the prefill', async () => {
      const onResume = vi.fn();
      mockWindowClaude([ccRow({
        lastUsedModel: { modelId: 'claude-opus-5', providerType: 'claude-code', providerLabel: 'Claude Code' },
      })]);
      render(<ResumeBrowser open={true} onClose={() => {}} onResume={onResume} defaultModel="sonnet" />);
      await expandRow('CC Chat');

      fireEvent.click(await screen.findByRole('button', { name: 'Model' }));
      fireEvent.change(await screen.findByPlaceholderText('Search all models…'), { target: { value: 'Fable' } });
      fireEvent.click(await screen.findByText(/Fable/));
      expect(await resumeAndReadAlias(onResume)).toBe('fable');
    });

    it('a native row whose recorded id merely CONTAINS a family word does not set the CC alias', async () => {
      // `anthropic/claude-sonnet-4.5` on OpenRouter would map to 'sonnet' if the
      // gate on provider were dropped. A native row must forward the app default
      // in the CC-alias slot — the real pick rides the 8th arg as a binding.
      const onResume = vi.fn();
      mockWindowClaude([{
        sessionId: 'native-1', name: 'Native Chat', projectSlug: 'p', projectPath: '/tmp/p',
        lastModified: Date.now(), size: 10, provider: 'native', harnessId: 'assistant',
        lastUsedModel: { modelId: 'anthropic/claude-sonnet-4.5', providerType: 'openrouter', providerLabel: 'OpenRouter' },
      }]);
      render(<ResumeBrowser open={true} onClose={() => {}} onResume={onResume} defaultModel="haiku" />);
      await expandRow('Native Chat');

      const resumeBtn = await screen.findByRole('button', { name: 'Resume Session' });
      await waitFor(() => expect(resumeBtn).not.toBeDisabled());
      fireEvent.click(resumeBtn);
      await waitFor(() => expect(onResume).toHaveBeenCalled());
      expect(forwardedAlias(onResume)).toBe('haiku');
      expect(onResume.mock.calls[0][7]).toEqual({ providerId: 'ulid-openrouter', modelId: 'anthropic/claude-sonnet-4.5' });
    });
  });
});

// The Resume browser's speed, pinned as behaviour (2026-09-11). A click used to
// re-render every card in the list several times, and read and format its
// conversation from scratch — even one just looked at. Each test below is one
// of those costs that must not come back.
describe('speed', () => {
  beforeAll(() => {
    // Wide viewport, declared (narrow-viewport rule): the panel only exists there.
    (window as any).matchMedia = (q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {} });
    Element.prototype.scrollIntoView = vi.fn();
    window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  });
  afterEach(() => { cleanup(); brandCalls.clear(); });
  afterAll(restoreViewport);

  const idFor = (i: number) => `a3f2aaaa-1111-4111-8111-${String(i).padStart(12, '0')}`;
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({
    sessionId: idFor(i),
    name: `Conversation ${i}`,
    projectSlug: 'proj',
    projectPath: '/tmp/youcoded',
    lastModified: Date.now() - i * 60_000,
    size: 200,
    provider: 'claude',
    lastUsedModel: { modelId: `model-for-row-${i}`, providerLabel: 'Test', providerType: 'anthropic' },
  }));

  function mockClaude(sessions: any[]) {
    const read = vi.fn(async (req: { id: string }) => previewPage(req.id, [`text of ${req.id}`]));
    (window as any).claude = {
      session: {
        browse: vi.fn().mockResolvedValue(sessions),
        setFlag: vi.fn().mockResolvedValue({ ok: true }),
        setTag: vi.fn().mockResolvedValue({ ok: true }),
        setNote: vi.fn().mockResolvedValue({ ok: true }),
        getMeta: vi.fn().mockResolvedValue({ tags: [], note: '' }),
      },
      tags: { list: vi.fn().mockResolvedValue([]) },
      providers: { catalog: vi.fn().mockResolvedValue([]), list: vi.fn().mockResolvedValue([]) },
      chatsearch: { read },
      on: {},
    };
    return read;
  }

  const open = () => render(<ResumeBrowser open={true} onClose={() => {}} onResume={() => {}} defaultModel="sonnet" />);
  const readsOf = (read: ReturnType<typeof mockClaude>, id: string) => read.mock.calls.filter(([req]) => req.id === id).length;
  // The layer showing a conversation is the one not hidden.
  const isShown = (id: string) => {
    const text = screen.queryByText(`text of ${id}`);
    const layer = text?.closest('[style*="visibility"]') as HTMLElement | null;
    return !!layer && layer.style.visibility === 'visible';
  };

  describe('Resume browser — conversations kept built', () => {
    it('brings back a conversation read a moment ago without reading it again', async () => {
      const read = mockClaude(rows(3));
      open();
      fireEvent.click(await screen.findByText('Conversation 0'));
      await waitFor(() => expect(isShown(idFor(0))).toBe(true));
      fireEvent.click(screen.getByText('Conversation 1'));
      await waitFor(() => expect(isShown(idFor(1))).toBe(true));
      expect(isShown(idFor(0))).toBe(false);

      fireEvent.click(screen.getByText('Conversation 0'));
      await waitFor(() => expect(isShown(idFor(0))).toBe(true));
      expect(readsOf(read, idFor(0))).toBe(1);
    });

    it('starts reading a row the pointer rests on, so the click finds it ready', async () => {
      const read = mockClaude(rows(3));
      open();
      const card = (await screen.findByText('Conversation 2')).closest('.rounded-lg')!;
      fireEvent.pointerEnter(card, { pointerType: 'mouse' });
      await waitFor(() => expect(readsOf(read, idFor(2))).toBe(1));
      // Warming is silent: nothing is on screen until the row is picked.
      expect(isShown(idFor(2))).toBe(false);

      fireEvent.click(screen.getByText('Conversation 2'));
      await waitFor(() => expect(isShown(idFor(2))).toBe(true));
      expect(readsOf(read, idFor(2))).toBe(1);
    });

    // The top row of a card is the name, then empty space, then the tag and
    // complete icons. That empty space used to do nothing (Destin, 2026-09-11).
    it('opens a conversation from the empty space beside its name', async () => {
      mockClaude(rows(2));
      open();
      const nameControl = (await screen.findByText('Conversation 1')).closest('button')!;
      fireEvent.click(nameControl.parentElement!);
      await waitFor(() => expect(isShown(idFor(1))).toBe(true));
    });

    it('passes the row’s project folder so main can open the file without a lookup', async () => {
      const read = mockClaude(rows(1));
      open();
      fireEvent.click(await screen.findByText('Conversation 0'));
      await waitFor(() => expect(read).toHaveBeenCalledWith(expect.objectContaining({ id: idFor(0), projectSlug: 'proj' })));
    });
  });

  describe('Resume browser — a click re-renders only the cards it changes', () => {
    it('leaves every card whose highlight did not move alone', async () => {
      mockClaude(rows(20));
      open();
      fireEvent.click(await screen.findByText('Conversation 0'));
      await waitFor(() => expect(isShown(idFor(0))).toBe(true));

      brandCalls.clear();
      fireEvent.click(screen.getByText('Conversation 1'));
      await waitFor(() => expect(isShown(idFor(1))).toBe(true));

      // Row 0 lost its highlight and row 1 gained it (and row 1 is drawn again
      // as the sheet's header card). Rows 2–19 changed nothing; before this they
      // re-rendered on every state change the click caused.
      for (let i = 2; i < 20; i++) expect(brandCalls.get(`model-for-row-${i}`) ?? 0).toBe(0);
      expect(brandCalls.get('model-for-row-1') ?? 0).toBeGreaterThan(0);
    });
  });

  // WHY: the Resume browser was the first list to draw only what is near the
  // screen (its reveal window became hooks/use-chunked-reveal.ts). Until the
  // render-cost consolidation nothing here noticed if it went back to drawing
  // every conversation: every suite above stayed green with the window removed.
  // With a firing observer stub, 1,000 conversations must open as one chunk and
  // grow by a chunk each time the sentinel is reached.
  describe('Resume browser — a long history draws one chunk at a time', () => {
    let io: ReturnType<typeof installFiringIntersectionObserver>;
    beforeEach(() => { io = installFiringIntersectionObserver(); });
    afterEach(() => io.restore());

    const cardsDrawn = () => screen.queryAllByText(/^Conversation \d+$/).length;

    it('opens 1,000 conversations as one chunk of cards and draws more on scroll', async () => {
      mockClaude(rows(1000));
      open();
      await screen.findByText('Conversation 0');
      // Date headers share the window with cards, so a chunk holds at most
      // REVEAL_CHUNK cards, never the whole history.
      const first = cardsDrawn();
      expect(first).toBeGreaterThan(0);
      expect(first).toBeLessThanOrEqual(REVEAL_CHUNK);

      act(() => io.fireAll());
      const second = cardsDrawn();
      expect(second).toBeGreaterThan(first);
      expect(second).toBeLessThanOrEqual(2 * REVEAL_CHUNK);
    });
  });
});

// Native resume ALWAYS offers the provider-scoped model selector, pre-filled
// from lastUsedModel ONLY when it matches a model available on THIS device; the
// selection becomes the binding; Resume never launches without one. This
// section exercises the ResumeBrowser wiring end to end (real ResumeBrowser +
// real NativeModelSelect, window.claude mocked).
describe('native resume', () => {
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

  describe('ResumeBrowser — native resume model selector', () => {
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
        'Native Chat',
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
        'Native Chat',
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
        read: vi.fn(async (req: { id: string }) => previewPage(req.id, ['hello'])),
      };
      render(<ResumeBrowser open={true} onClose={() => {}} onResume={() => {}} />);

      fireEvent.click(await screen.findByText('First Chat'));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Model' })).toHaveTextContent('GPT-5'));

      fireEvent.click(screen.getByText('Second Chat'));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Model' })).toHaveTextContent('Claude X'));
      delete (window as any).matchMedia;
    });
  });
});

// The Resume Browser's per-card organize affordances: the Complete check icon
// on the card, and the tag icon that opens an in-card sheet holding tags + note.
// Four of these behaviours are design decisions that are easy to undo by
// accident, so they are pinned here rather than left to a visual pass:
//
//   1. Complete is reachable in ONE click from the card, not behind the sheet.
//   2. Priority is applied through the tag picker like any other tag, but is
//      not a registry tag — toggling it writes a FLAG, and it never appears in
//      the tag manager (so it can't be renamed or deleted out from under the
//      sort that reads it).
//   3. The resume pane and the tag sheet are MUTUALLY EXCLUSIVE — a card shows
//      one or the other, never both stacked.
//   4. A row that cannot be resumed on this device can still be organized.
//      Inert rows never expand, and the sheet opens independently of expansion,
//      which is the only reason those rows are reachable at all.
describe('organizing', () => {
  // These pin the SINGLE-COLUMN browser — the layout a phone, a narrow window or
  // Android gets, where clicking a card still expands the resume controls inside
  // it. On a wide desktop the same click fills the preview panel instead and the
  // controls live in the card at its foot (the 2026-09-10 design rounds), so
  // without this stub jsdom (which has no matchMedia, hence "wide") would run
  // these against a layout whose cards deliberately never expand.
  beforeAll(() => {
    (window as any).matchMedia = (q: string) => ({
      matches: q === '(max-width: 639.98px)',
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    });
  });
  afterAll(restoreViewport);

  const TAGS = [{ id: 'tag_a', label: 'Research', color: 'tag-blue', archived: false, createdAt: '' }];

  function row(overrides: Record<string, unknown> = {}) {
    return {
      sessionId: 'cc-1',
      name: 'CC Chat',
      projectSlug: 'proj',
      projectPath: '/tmp/proj',
      lastModified: Date.now(),
      size: 200,
      provider: 'claude',
      ...overrides,
    };
  }

  function mockWindowClaude(sessions: any[] = [row()]) {
    (window as any).claude = {
      session: {
        browse: vi.fn().mockResolvedValue(sessions),
        setFlag: vi.fn().mockResolvedValue({ ok: true }),
        setTag: vi.fn().mockResolvedValue({ ok: true }),
        setNote: vi.fn().mockResolvedValue({ ok: true }),
      },
      tags: {
        list: vi.fn().mockResolvedValue(TAGS),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
      providers: { catalog: vi.fn().mockResolvedValue([]), list: vi.fn().mockResolvedValue([]) },
      on: {},
    };
  }

  const mount = () => render(<ResumeBrowser open={true} onClose={() => {}} onResume={() => {}} />);

  describe('ResumeBrowser — organizing a conversation', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      mockWindowClaude();
    });

    it('opens rename from the full accessible name without expanding or resuming the card', async () => {
      (window as any).claude.sessionNaming = {
        title: vi.fn().mockResolvedValue({ title: 'CC Chat', manual: false }),
      };
      const onResume = vi.fn();
      const bubbled = vi.fn();
      render(<div onClick={bubbled}><ResumeBrowser open onClose={() => {}} onResume={onResume} /></div>);
      const name = await screen.findByText('CC Chat');
      const button = screen.getByRole('button', { name: 'Rename CC Chat' });
      expect(button).toContainElement(name);
      expect(button).toHaveAttribute('type', 'button');
      expect(button).toHaveAttribute('aria-haspopup', 'dialog');
      expect(button).toHaveClass('coarse-hit');
      button.focus();
      expect(button).toHaveFocus();
      fireEvent.click(name);
      expect(await screen.findByDisplayValue('CC Chat')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Resume Session' })).not.toBeInTheDocument();
      expect(onResume).not.toHaveBeenCalled();
      expect(bubbled).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByDisplayValue('CC Chat')).not.toBeInTheDocument();
      expect(screen.getByText('CC Chat')).toBeInTheDocument();
    });

    it('opens rename on Enter without relying on a synthesized click', async () => {
      (window as any).claude.sessionNaming = {
        title: vi.fn().mockResolvedValue({ title: 'CC Chat', manual: false }),
      };
      mount();
      const name = await screen.findByRole('button', { name: 'Rename CC Chat' });
      fireEvent.keyDown(name, { key: 'Enter' });
      expect(await screen.findByDisplayValue('CC Chat')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Resume Session' })).not.toBeInTheDocument();
    });

    // WHY (Plan B review of u6, 2026-09-16): the retired "matches the file viewer
    // styling" case scraped SessionDrawer.tsx for its expectations; this keeps only
    // its source-free half — R5-1, both rename cues (dotted underline on the name,
    // the pencil) are visible at rest, never revealed on hover/focus. A phone has
    // no hover, so a hover-only cue is an invisible one there.
    it('keeps both rename cues visible at rest, with no hover or focus reveal', async () => {
      (window as any).claude.sessionNaming = {};
      mount();
      const button = await screen.findByRole('button', { name: 'Rename CC Chat' });
      const name = screen.getByText('CC Chat');
      expect(button).toContainElement(name);
      expect(name).toHaveClass('underline', 'decoration-dotted', 'decoration-fg-muted');
      const pencil = button.querySelector('svg')!.parentElement!;
      for (const cue of [name, pencil]) {
        expect(cue.className).not.toMatch(/hover:|focus:|opacity-0|invisible|hidden|touch-reveal/);
      }
    });

    it('marks a session complete from the card, without opening the menu', async () => {
      mount();
      fireEvent.click(await screen.findByRole('button', { name: 'Mark CC Chat complete' }));
      expect((window as any).claude.session.setFlag).toHaveBeenCalledWith('cc-1', 'complete', true);
    });

    it('offers to undo once complete', async () => {
      mockWindowClaude([row({ flags: { complete: true } })]);
      mount();
      // Complete rows are filtered out by default — turn Show Complete on so the
      // row is listed, then assert the icon has flipped to its undo affordance.
      fireEvent.click(await screen.findByRole('switch', { name: 'Show Complete' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Mark CC Chat not complete' }));
      expect((window as any).claude.session.setFlag).toHaveBeenCalledWith('cc-1', 'complete', false);
    });

    it('applies Priority through the tag picker but writes a flag, not a tag', async () => {
      mount();
      fireEvent.click(await screen.findByRole('button', { name: /Organize CC Chat/ }));
      // Listed among the tags, ahead of the registry ones.
      fireEvent.click(await screen.findByRole('button', { name: /^Priority/ }));
      expect((window as any).claude.session.setFlag).toHaveBeenCalledWith('cc-1', 'priority', true);
      expect((window as any).claude.session.setTag).not.toHaveBeenCalled();
    });

    it('keeps the "pins to top" explanation next to Priority', async () => {
      mount();
      fireEvent.click(await screen.findByRole('button', { name: /Organize CC Chat/ }));
      expect(await screen.findByText('pins to top')).toBeInTheDocument();
    });

    it('does not offer Priority for renaming or deletion in the tag manager', async () => {
      mount();
      fireEvent.click(await screen.findByRole('button', { name: /Organize CC Chat/ }));
      fireEvent.click(await screen.findByText('Manage tags…'));
      // The registry tag is editable there; the built-in has no row at all.
      expect(await screen.findByRole('textbox', { name: 'Rename Research' })).toBeInTheDocument();
      expect(screen.queryByRole('textbox', { name: 'Rename Priority' })).not.toBeInTheDocument();
    });

    it('shows the resume pane OR the tag sheet, never both', async () => {
      mount();
      // Expand to resume…
      fireEvent.click(await screen.findByText('CC Chat'));
      expect(await screen.findByRole('button', { name: 'Resume Session' })).toBeInTheDocument();

      // …opening tags replaces it rather than stacking a second panel under it,
      // which is what would push the Resume button down the screen as you typed.
      fireEvent.click(await screen.findByRole('button', { name: /Organize CC Chat/ }));
      expect(await screen.findByPlaceholderText('Search or create a tag…')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Resume Session' })).not.toBeInTheDocument();

      // …and back the other way.
      fireEvent.click(await screen.findByText('CC Chat'));
      expect(await screen.findByRole('button', { name: 'Resume Session' })).toBeInTheDocument();
      expect(screen.queryByPlaceholderText('Search or create a tag…')).not.toBeInTheDocument();
    });

    it('organizes a row that cannot be resumed on this device', async () => {
      mockWindowClaude([row({ sessionId: 'cc-2', name: 'Synced Elsewhere', missingProject: true })]);
      mount();
      fireEvent.click(await screen.findByRole('button', { name: /Organize Synced Elsewhere/ }));
      expect(await screen.findByPlaceholderText('Search or create a tag…')).toBeInTheDocument();
    });
  });
});

// The two-pane Resume browser.
//
// The organizing and Claude Code model prefill sections above pin the
// SINGLE-COLUMN layout, where a card still expands its resume controls in
// place. This one pins the wide layout, where that click fills the preview
// panel instead — the behaviour those two would otherwise have silently
// stopped covering when the panel shipped.
describe('preview panel', () => {
  // Wide: jsdom has no matchMedia, and the hook already treats its absence as
  // wide — stubbed anyway so the intent is on the page rather than inherited
  // from a gap in the environment.
  const setViewport = (narrow: boolean) => {
    (window as any).matchMedia = (q: string) => ({
      matches: narrow && q === '(max-width: 639.98px)',
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    });
  };

  beforeAll(() => {
    // jsdom implements neither; the chat components the preview renders may
    // call scrollIntoView, and the sheet measures itself with ResizeObserver.
    Element.prototype.scrollIntoView = vi.fn();
    if (typeof window.ResizeObserver === 'undefined') {
      window.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      } as unknown as typeof ResizeObserver;
    }
  });
  afterEach(() => { cleanup(); delete (window as any).__PLATFORM__; });
  afterAll(restoreViewport);

  const row = (o: Record<string, unknown> = {}) => ({
    sessionId: 'a3f2aaaa-1111-4111-8111-111111111111',
    name: 'Permission ask timeout',
    projectSlug: 'proj',
    projectPath: '/tmp/youcoded',
    lastModified: Date.now(),
    size: 200,
    provider: 'claude',
    ...o,
  });

  function mockClaude(sessions: any[]) {
    (window as any).claude = {
      session: {
        browse: vi.fn().mockResolvedValue(sessions),
        setFlag: vi.fn().mockResolvedValue({ ok: true }),
        setTag: vi.fn().mockResolvedValue({ ok: true }),
        setNote: vi.fn().mockResolvedValue({ ok: true }),
        getMeta: vi.fn().mockResolvedValue({ tags: [], note: '' }),
      },
      tags: { list: vi.fn().mockResolvedValue([]) },
      providers: { catalog: vi.fn().mockResolvedValue([]), list: vi.fn().mockResolvedValue([]) },
      chatsearch: {
        read: vi.fn(async (req: { id: string }) => previewPage(req.id, ['why did the ask time out'])),
      },
      on: {},
    };
  }

  const open = () => render(<ResumeBrowser open={true} onClose={() => {}} onResume={() => {}} defaultModel="sonnet" />);

  describe('Resume browser — the preview panel', () => {
    it('fills the panel with the conversation instead of expanding the card', async () => {
      setViewport(false);
      mockClaude([row()]);
      open();
      // Nothing is previewed until a row is clicked (R2: "blank" — the panel
      // never opens the most recent conversation by itself).
      expect(screen.queryByText(/why did the ask time out/)).not.toBeInTheDocument();
      expect((window as any).claude.chatsearch.read).not.toHaveBeenCalled();

      fireEvent.click(await screen.findByText('Permission ask timeout'));
      await waitFor(() => expect(screen.getByText(/why did the ask time out/)).toBeInTheDocument());
      // The card in the LIST does not grow its own resume controls any more —
      // they live in the card at the foot of the panel, which is the only
      // Resume Session button on screen.
      expect(screen.getAllByRole('button', { name: 'Resume Session' })).toHaveLength(1);
    });

    // The arrival is keyed on the transcript having SETTLED, not on the click:
    // reading one off disk takes real time, and keyed on the click the spring
    // played out over a loading line while the bubbles landed after it.
    it('waits for the transcript before it animates the sheet in', async () => {
      setViewport(false);
      mockClaude([row()]);
      let release: (v: unknown) => void = () => {};
      (window as any).claude.chatsearch.read = vi.fn((req: { id: string }) => new Promise((r) => {
        release = () => r(previewPage(req.id, ['why did the ask time out']));
      }));
      const { container } = open();
      fireEvent.click(await screen.findByText('Permission ask timeout'));
      // Still reading: nothing is wearing the arrival yet.
      await waitFor(() => expect((window as any).claude.chatsearch.read).toHaveBeenCalled());
      expect(container.querySelector('.switch-arrival')).toBeNull();

      release(null);
      await waitFor(() => expect(container.querySelector('.switch-arrival')).not.toBeNull());
      // …and the bubbles are already there when it starts, which is the point.
      expect(container.querySelector('.switch-arrival')!.textContent).toContain('why did the ask time out');
    });

    // Destin, 2026-09-11: "when scrolling up through a conversation preview in
    // resume browser, the top card should slide up and hide. it should slide
    // back down when i scroll down". jsdom lays nothing out, so the scroller's
    // position and height are driven by hand.
    const pickAndGrabScroller = async () => {
      const { container } = open();
      fireEvent.click(await screen.findByText('Permission ask timeout'));
      await waitFor(() => expect(container.querySelector('.preview-header-slide')).not.toBeNull());
      const strip = container.querySelector('.preview-header-slide')!;
      const scroller = container.querySelector('[data-preview-id] .overflow-y-auto') as HTMLElement;
      const pos = { top: 1000, height: 3000 };
      Object.defineProperty(scroller, 'scrollTop', { configurable: true, get: () => pos.top });
      Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => pos.height });
      const scrollTo = (top: number, height = pos.height) => { pos.top = top; pos.height = height; fireEvent.scroll(scroller); };
      scrollTo(1000); // the first scroll only takes a bearing
      return { strip, scrollTo };
    };

    it('tucks the header card away while you scroll up, and brings it back as you scroll down', async () => {
      setViewport(false);
      mockClaude([row()]);
      const { strip, scrollTo } = await pickAndGrabScroller();
      expect(strip).not.toHaveAttribute('data-tucked');
      scrollTo(900);
      expect(strip).toHaveAttribute('data-tucked');
      scrollTo(903); // a nudge under the threshold moves nothing
      expect(strip).toHaveAttribute('data-tucked');
      scrollTo(1000);
      expect(strip).not.toHaveAttribute('data-tucked');
    });

    it('keeps the card tucked when Load older pushes the conversation down without anyone scrolling', async () => {
      setViewport(false);
      mockClaude([row()]);
      const { strip, scrollTo } = await pickAndGrabScroller();
      scrollTo(0);
      expect(strip).toHaveAttribute('data-tucked');
      // Older messages land above: taller content, position pushed down to match.
      scrollTo(2000, 5000);
      expect(strip).toHaveAttribute('data-tucked');
    });

    it('brings a tucked card back when keyboard focus lands on it', async () => {
      setViewport(false);
      mockClaude([row()]);
      const { strip, scrollTo } = await pickAndGrabScroller();
      scrollTo(0);
      expect(strip).toHaveAttribute('data-tucked');
      act(() => { (strip.querySelector('button') as HTMLButtonElement).focus(); });
      expect(strip).not.toHaveAttribute('data-tucked');
    });

    it('reads the conversation ONCE per row, not on every keystroke in the search box', async () => {
      setViewport(false);
      mockClaude([row()]);
      open();
      fireEvent.click(await screen.findByText('Permission ask timeout'));
      await waitFor(() => expect((window as any).claude.chatsearch.read).toHaveBeenCalledTimes(1));

      const search = screen.getByPlaceholderText('Search sessions...');
      fireEvent.change(search, { target: { value: 'p' } });
      fireEvent.change(search, { target: { value: 'pe' } });
      fireEvent.change(search, { target: { value: 'per' } });
      expect((window as any).claude.chatsearch.read).toHaveBeenCalledTimes(1);
    });

    it('stays single-column on a narrow viewport', async () => {
      setViewport(true);
      mockClaude([row()]);
      open();
      fireEvent.click(await screen.findByText('Permission ask timeout'));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Resume Session' })).toBeInTheDocument());
      expect((window as any).claude.chatsearch.read).not.toHaveBeenCalled();
    });

    // Resume needs the project folder; reading does not. A conversation synced in
    // from another device is exactly what a preview is for, so it previews — and
    // says why there is no Resume button instead of offering a broken one.
    it('previews a conversation whose project folder is not on this device', async () => {
      setViewport(false);
      mockClaude([row({ missingProject: true, projectPath: '', projectSlug: '' })]);
      open();
      fireEvent.click(await screen.findByText('Permission ask timeout'));
      await waitFor(() => expect(screen.getByText(/why did the ask time out/)).toBeInTheDocument());
      expect(screen.getByText(/has to be resumed where its folder lives/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Resume Session' })).not.toBeInTheDocument();
    });

    // The transcript itself has not arrived, so there is nothing to show.
    it('leaves a not-yet-synced conversation inert', async () => {
      setViewport(false);
      mockClaude([row({ notSyncedYet: true })]);
      open();
      fireEvent.click(await screen.findByText('Permission ask timeout'));
      expect((window as any).claude.chatsearch.read).not.toHaveBeenCalled();
    });

    // chatsearch:read answers not-implemented-on-mobile (SessionService.kt), so
    // the panel could only ever show an error there. A tablet is wide enough to
    // pass the width test, which is the case this covers.
    it('stays single-column on Android even when the viewport is wide', async () => {
      setViewport(false);
      (window as any).__PLATFORM__ = 'android';
      mockClaude([row()]);
      open();
      fireEvent.click(await screen.findByText('Permission ask timeout'));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Resume Session' })).toBeInTheDocument());
      expect((window as any).claude.chatsearch.read).not.toHaveBeenCalled();
    });
  });
});
