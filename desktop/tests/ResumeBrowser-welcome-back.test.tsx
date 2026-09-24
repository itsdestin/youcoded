// @vitest-environment jsdom
// ResumeBrowser's Welcome back mode (design: docs/active/specs/2026-09-24-welcome-back-design.md
// §5-6 in the workspace). Same component as the everyday Resume browser, gated
// by the `welcomeBack` prop — these tests pin only what that mode changes:
// seeded ticks, the disabled/unticked state for a row that can't be resumed
// here, Complete unticking a row, the footer label, the needs-model note, the
// no-accidental-dismiss rule (Escape/scrim), and both ways out (empty list,
// Start fresh) calling onDone.
//
// WHY a separate file rather than folding into ResumeBrowser.test.tsx: that
// file already declares its own per-section viewport stubs (see its header
// comment); Welcome back needs its own wide-viewport declaration up front
// (narrow-viewport.md: "a test rendering a viewport-branching component must
// declare the viewport" — jsdom has no matchMedia, which the hook reads as
// wide, so this makes that reading explicit rather than accidental).
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import ResumeBrowser from '../src/renderer/components/ResumeBrowser';
import { EscCloseProvider } from '../src/renderer/hooks/use-esc-close';

beforeAll(() => {
  if (typeof window.ResizeObserver === 'undefined') {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  // Declare the wide/desktop branch explicitly (see file header WHY).
  (window as any).matchMedia = (q: string) => ({
    matches: false,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  // jsdom does not implement scrollIntoView (same stub as ResumeBrowser.test.tsx,
  // SessionDrawer.test.tsx, ui-primitives.test.tsx) — U1 below calls it on the
  // row whose Organize sheet just opened.
  Element.prototype.scrollIntoView = vi.fn();
});
afterAll(() => { delete (window as any).matchMedia; });
afterEach(cleanup);

function row(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'sess-1',
    name: 'Session A',
    projectSlug: 'proj',
    projectPath: '/tmp/proj',
    lastModified: Date.now(),
    size: 100,
    provider: 'claude',
    ...overrides,
  };
}

const PROVIDERS = [
  { id: 'ulid-openrouter', type: 'openrouter', label: 'OpenRouter', enabled: true, builtIn: true, hasKey: true, ready: true },
];
const CATALOG = [{ id: 'anthropic/claude-sonnet-4.5', providerId: 'ulid-openrouter', label: 'Claude Sonnet 4.5' }];

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

function welcomeBack(ids: string[], overrides: Partial<{ onResumeMany: any; onDone: any }> = {}) {
  return {
    ids,
    onResumeMany: overrides.onResumeMany ?? vi.fn().mockResolvedValue([]),
    onDone: overrides.onDone ?? vi.fn(),
  };
}

describe('ResumeBrowser — Welcome back mode', () => {
  it('seeds every resumable row ticked', async () => {
    mockWindowClaude([row(), row({ sessionId: 'sess-2', name: 'Session B' })]);
    render(<ResumeBrowser open onClose={() => {}} onResume={() => {}} welcomeBack={welcomeBack(['sess-1', 'sess-2'])} />);

    const a = await screen.findByRole('checkbox', { name: 'Reopen Session A' });
    const b = await screen.findByRole('checkbox', { name: 'Reopen Session B' });
    await waitFor(() => expect(a).toHaveAttribute('aria-checked', 'true'));
    expect(b).toHaveAttribute('aria-checked', 'true');
  });

  it('starts a row that cannot be resumed here unticked and disabled — missing project folder', async () => {
    mockWindowClaude([
      row(),
      row({ sessionId: 'sess-2', name: 'Session B', missingProject: true }),
    ]);
    render(<ResumeBrowser open onClose={() => {}} onResume={() => {}} welcomeBack={welcomeBack(['sess-1', 'sess-2'])} />);

    const a = await screen.findByRole('checkbox', { name: 'Reopen Session A' });
    await waitFor(() => expect(a).toHaveAttribute('aria-checked', 'true'));
    const b = screen.getByRole('checkbox', { name: 'Reopen Session B' });
    expect(b).toHaveAttribute('aria-checked', 'false');
    expect(b).toBeDisabled();
  });

  it('starts a row that cannot be resumed here unticked and disabled — transcript not synced yet', async () => {
    mockWindowClaude([
      row(),
      row({ sessionId: 'sess-2', name: 'Session B', notSyncedYet: true }),
    ]);
    render(<ResumeBrowser open onClose={() => {}} onResume={() => {}} welcomeBack={welcomeBack(['sess-1', 'sess-2'])} />);

    const a = await screen.findByRole('checkbox', { name: 'Reopen Session A' });
    await waitFor(() => expect(a).toHaveAttribute('aria-checked', 'true'));
    const b = screen.getByRole('checkbox', { name: 'Reopen Session B' });
    expect(b).toHaveAttribute('aria-checked', 'false');
    expect(b).toBeDisabled();
  });

  it('marking a row complete unticks it', async () => {
    mockWindowClaude([row()]);
    render(<ResumeBrowser open onClose={() => {}} onResume={() => {}} welcomeBack={welcomeBack(['sess-1'])} />);

    const checkbox = await screen.findByRole('checkbox', { name: 'Reopen Session A' });
    await waitFor(() => expect(checkbox).toHaveAttribute('aria-checked', 'true'));

    fireEvent.click(await screen.findByRole('button', { name: 'Mark Session A complete' }));
    await waitFor(() => expect(checkbox).toHaveAttribute('aria-checked', 'false'));
  });

  it('does not close on Escape', async () => {
    const onClose = vi.fn();
    const onDone = vi.fn();
    mockWindowClaude([row()]);
    render(
      <EscCloseProvider>
        <ResumeBrowser open onClose={onClose} onResume={() => {}} welcomeBack={welcomeBack(['sess-1'], { onDone })} />
      </EscCloseProvider>,
    );
    await screen.findByRole('checkbox', { name: 'Reopen Session A' });

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('does not close on a scrim click', async () => {
    const onClose = vi.fn();
    const onDone = vi.fn();
    mockWindowClaude([row()]);
    const { container } = render(
      <ResumeBrowser open onClose={onClose} onResume={() => {}} welcomeBack={welcomeBack(['sess-1'], { onDone })} />,
    );
    await screen.findByRole('checkbox', { name: 'Reopen Session A' });

    const scrim = container.ownerDocument.querySelector('.layer-scrim') ?? document.querySelector('.layer-scrim');
    expect(scrim).toBeTruthy();
    fireEvent.click(scrim as Element);
    expect(onClose).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('footer label: "Resume all N" when every row is ticked', async () => {
    mockWindowClaude([row(), row({ sessionId: 'sess-2', name: 'Session B' })]);
    render(<ResumeBrowser open onClose={() => {}} onResume={() => {}} welcomeBack={welcomeBack(['sess-1', 'sess-2'])} />);

    expect(await screen.findByRole('button', { name: 'Resume all 2' })).toBeInTheDocument();
  });

  it('footer label: "Resume N" once a row is unticked', async () => {
    mockWindowClaude([row(), row({ sessionId: 'sess-2', name: 'Session B' })]);
    render(<ResumeBrowser open onClose={() => {}} onResume={() => {}} welcomeBack={welcomeBack(['sess-1', 'sess-2'])} />);

    await screen.findByRole('button', { name: 'Resume all 2' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Reopen Session B' }));
    expect(await screen.findByRole('button', { name: 'Resume 1' })).toBeInTheDocument();
  });

  it('footer label: bare "Resume" (disabled) once nothing is ticked', async () => {
    mockWindowClaude([row()]);
    render(<ResumeBrowser open onClose={() => {}} onResume={() => {}} welcomeBack={welcomeBack(['sess-1'])} />);

    const checkbox = await screen.findByRole('checkbox', { name: 'Reopen Session A' });
    await waitFor(() => expect(checkbox).toHaveAttribute('aria-checked', 'true'));
    fireEvent.click(checkbox);
    const btn = await screen.findByRole('button', { name: 'Resume' });
    expect(btn).toBeDisabled();
  });

  it('shows the needs-model note for a native row whose last model is not set up here', async () => {
    mockWindowClaude([
      row({
        sessionId: 'native-1', name: 'Native Chat', provider: 'native', harnessId: 'assistant',
        // No provider on this device has this type — resolveNativeBinding misses.
        lastUsedModel: { modelId: 'gpt-5', providerType: 'openai', providerLabel: 'OpenAI' },
      }),
    ]);
    render(<ResumeBrowser open onClose={() => {}} onResume={() => {}} welcomeBack={welcomeBack(['native-1'])} />);

    expect(await screen.findByText("Its last model isn't set up here — Resume will ask you to pick one.")).toBeInTheDocument();
  });

  it('calls onDone when the list is empty', async () => {
    const onDone = vi.fn();
    mockWindowClaude([]);
    render(<ResumeBrowser open onClose={() => {}} onResume={() => {}} welcomeBack={welcomeBack([], { onDone })} />);

    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it('Start fresh calls onDone', async () => {
    const onDone = vi.fn();
    mockWindowClaude([row()]);
    render(<ResumeBrowser open onClose={() => {}} onResume={() => {}} welcomeBack={welcomeBack(['sess-1'], { onDone })} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Start fresh' }));
    expect(onDone).toHaveBeenCalled();
  });

  // U1 (UX review 2026-09-24): the list shares its column with a fixed
  // Resume/Start fresh footer, so a row's tag/note sheet growing that row
  // taller can push it past the still-visible area with nothing on screen
  // saying to scroll. Opening the sheet must scroll that row into view
  // instead of leaving the user to discover the hidden scrollbar themselves.
  it("opening a row's Organize sheet scrolls that row into view", async () => {
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    mockWindowClaude([
      row(),
      row({ sessionId: 'sess-2', name: 'Session B' }),
      row({ sessionId: 'sess-3', name: 'Session C' }),
    ]);
    render(<ResumeBrowser open onClose={() => {}} onResume={() => {}} welcomeBack={welcomeBack(['sess-1', 'sess-2', 'sess-3'])} />);
    await screen.findByRole('checkbox', { name: 'Reopen Session A' });
    scrollSpy.mockClear(); // drop any incidental calls from the initial mount/seed

    const organizeBtn = screen.getByRole('button', { name: 'Organize Session B' });
    fireEvent.click(organizeBtn);

    // TagPicker only renders once the sheet is open — its presence confirms
    // the click actually opened Session B's sheet before we check the scroll.
    await screen.findByPlaceholderText('Search or create a tag…');
    await waitFor(() => expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest', behavior: 'smooth' }));
  });

  it('does not scroll when nothing is open (no row erroneously grabs focus on mount)', async () => {
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    mockWindowClaude([row(), row({ sessionId: 'sess-2', name: 'Session B' })]);
    render(<ResumeBrowser open onClose={() => {}} onResume={() => {}} welcomeBack={welcomeBack(['sess-1', 'sess-2'])} />);
    await screen.findByRole('checkbox', { name: 'Reopen Session A' });

    expect(scrollSpy).not.toHaveBeenCalled();
  });

  // U2 (UX review 2026-09-24): a Resume press that reopens some but not all
  // ticked rows used to say nothing — the panel just shrank and its heading
  // quietly went plural to singular. It must say how many reopened and why
  // the rest stayed.
  it('a partial Resume press says how many reopened and that the rest need a model', async () => {
    const onResumeMany = vi.fn().mockResolvedValue(['sess-1']); // only Session A actually reopens
    mockWindowClaude([
      row(),
      row({
        sessionId: 'sess-2', name: 'Session B', provider: 'native', harnessId: 'assistant',
        // No provider on this device has this type — resolveNativeBinding misses,
        // matching the "shows the needs-model note" fixture above.
        lastUsedModel: { modelId: 'gpt-5', providerType: 'openai', providerLabel: 'OpenAI' },
      }),
    ]);
    render(<ResumeBrowser open onClose={() => {}} onResume={() => {}} welcomeBack={welcomeBack(['sess-1', 'sess-2'], { onResumeMany })} />);

    await screen.findByRole('checkbox', { name: 'Reopen Session A' });
    // Confirms needsModel has been worked out (this session's fixture) before
    // the press, so the status line's reason is real, not guessed afterwards.
    await screen.findByText("Its last model isn't set up here — Resume will ask you to pick one.");

    fireEvent.click(await screen.findByRole('button', { name: 'Resume all 2' }));
    expect(await screen.findByText('1 reopened. The one left needs a model picked first.')).toBeInTheDocument();
  });

  it('pluralizes the status line for more than one row left', async () => {
    const onResumeMany = vi.fn().mockResolvedValue(['sess-1']);
    const needsModelRow = (id: string, name: string) => row({
      sessionId: id, name, provider: 'native', harnessId: 'assistant',
      lastUsedModel: { modelId: 'gpt-5', providerType: 'openai', providerLabel: 'OpenAI' },
    });
    mockWindowClaude([row(), needsModelRow('sess-2', 'Session B'), needsModelRow('sess-3', 'Session C')]);
    render(<ResumeBrowser open onClose={() => {}} onResume={() => {}} welcomeBack={welcomeBack(['sess-1', 'sess-2', 'sess-3'], { onResumeMany })} />);

    await screen.findByRole('checkbox', { name: 'Reopen Session A' });
    await screen.findAllByText("Its last model isn't set up here — Resume will ask you to pick one.");

    fireEvent.click(await screen.findByRole('button', { name: 'Resume all 3' }));
    expect(await screen.findByText('1 reopened. The 2 left need a model picked first.')).toBeInTheDocument();
  });

  it('clears the status line on the next Resume press', async () => {
    const onResumeMany = vi.fn()
      .mockResolvedValueOnce(['sess-1']) // first press: partial
      .mockResolvedValueOnce(['sess-2']); // second press: the rest goes
    mockWindowClaude([
      row(),
      row({
        sessionId: 'sess-2', name: 'Session B', provider: 'native', harnessId: 'assistant',
        lastUsedModel: { modelId: 'anthropic/claude-sonnet-4.5', providerType: 'openrouter', providerLabel: 'OpenRouter' },
      }),
    ]);
    render(<ResumeBrowser open onClose={() => {}} onResume={() => {}} welcomeBack={welcomeBack(['sess-1', 'sess-2'], { onResumeMany })} />);

    await screen.findByRole('checkbox', { name: 'Reopen Session A' });
    fireEvent.click(await screen.findByRole('button', { name: 'Resume all 2' }));
    expect(await screen.findByText('1 reopened. The one left didn’t reopen.')).toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: 'Resume 1' }));
    await waitFor(() => expect(screen.queryByText('1 reopened. The one left didn’t reopen.')).not.toBeInTheDocument());
  });

  it('Start fresh clears any status line from an earlier partial Resume press', async () => {
    const onResumeMany = vi.fn().mockResolvedValue(['sess-1']);
    const onDone = vi.fn();
    mockWindowClaude([
      row(),
      row({
        sessionId: 'sess-2', name: 'Session B', provider: 'native', harnessId: 'assistant',
        lastUsedModel: { modelId: 'gpt-5', providerType: 'openai', providerLabel: 'OpenAI' },
      }),
    ]);
    render(<ResumeBrowser open onClose={() => {}} onResume={() => {}} welcomeBack={welcomeBack(['sess-1', 'sess-2'], { onResumeMany, onDone })} />);

    await screen.findByRole('checkbox', { name: 'Reopen Session A' });
    fireEvent.click(await screen.findByRole('button', { name: 'Resume all 2' }));
    expect(await screen.findByText('1 reopened. The one left needs a model picked first.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Start fresh' }));
    expect(onDone).toHaveBeenCalled();
    expect(screen.queryByText('1 reopened. The one left needs a model picked first.')).not.toBeInTheDocument();
  });
});
