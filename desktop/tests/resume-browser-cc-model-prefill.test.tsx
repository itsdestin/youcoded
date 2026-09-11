// @vitest-environment jsdom
// desktop/tests/resume-browser-cc-model-prefill.test.tsx
//
// Fix (2026-08-26): an expanded Claude Code row's model dropdown used to open
// on `defaultModel` — the app-wide Settings default — regardless of what that
// conversation had actually run on. Resuming an Opus conversation silently
// offered whatever the global default was, while the card's own model chip
// showed Opus two lines above. These tests pin the per-row prefill and, just as
// importantly, the cases that must still fall back rather than guess.
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import ResumeBrowser from '../src/renderer/components/ResumeBrowser';
import { claudeAliasForModelId, isPlaceholderModelId } from '../src/shared/model-ids';

// These pin the SINGLE-COLUMN browser — the layout a phone, a narrow window or
// Android gets, where clicking a card still expands the resume controls inside
// it. On a wide desktop the same click fills the preview panel instead and the
// controls live in the card at its foot (the 2026-09-10 design rounds), so
// without this stub jsdom (which has no matchMedia, hence "wide") would run
// these against a layout whose cards deliberately never expand.
(window as any).matchMedia = (q: string) => ({
  matches: q === '(max-width: 639.98px)',
  media: q,
  addEventListener: () => {},
  removeEventListener: () => {},
});

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
