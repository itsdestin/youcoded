// @vitest-environment jsdom
/**
 * Fix pass (Task 10 review, finding 2) — Settings -> Specialists used to fire
 * TWO concurrent specialists:list calls on every mount: useSpecialistRoster's
 * own auto-load effect (no ensurePersonalFolder) and SpecialistsSection's own
 * separate mount effect (ensurePersonalFolder: true), racing each other —
 * whichever wrote the cache last won, a timing assumption rather than a
 * guarantee. Consolidated into the ONE auto-load effect the hook already
 * runs, now parameterized by ensurePersonalFolder (see useSpecialists.ts).
 * This pins: mounting the section issues exactly one specialists.list call,
 * carrying ensurePersonalFolder: true.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor, fireEvent, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import SpecialistsSection from '../src/renderer/components/SpecialistsSection';
// Read-only import — NOT_IMPLEMENTED_ON_MOBILE is the pinned machine string
// SessionService.kt (and remote-shim, over a not-yet-upgraded peer) answers
// with for every specialists:* channel. Reusing the real constant instead of
// a hand-typed copy means this test breaks the moment that string changes,
// instead of silently testing the wrong thing.
import { NOT_IMPLEMENTED_ON_MOBILE } from '../src/renderer/hooks/useSpecialists';

afterEach(() => { cleanup(); delete (window as any).claude; });

function mockClaude(list: ReturnType<typeof vi.fn>) {
  (window as any).claude = {
    specialists: {
      list,
      getDelegatedModels: vi.fn().mockResolvedValue({ budget: null, frontier: null }),
      setDelegatedModel: vi.fn(),
    },
    // ModelPicker (rendered by the two tier rows) reads these on mount.
    providers: {
      list: vi.fn().mockResolvedValue([]),
      catalog: vi.fn().mockResolvedValue([]),
    },
    shell: { openPath: vi.fn() },
  };
}

describe('SpecialistsSection mount', () => {
  it('issues exactly one specialists.list call, ensuring the personal folder — not two racing calls', async () => {
    const list = vi.fn().mockResolvedValue({
      definitions: [], skipped: [], folders: { personal: '/p', claudeUser: '/c' },
    });
    mockClaude(list);

    render(<SpecialistsSection cwd="cwd-settings-mount-once" />);

    await waitFor(() => expect(list).toHaveBeenCalled());
    // Give a second, racing call a chance to land before asserting the count.
    await new Promise((r) => setTimeout(r, 30));
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith({ cwd: 'cwd-settings-mount-once', ensurePersonalFolder: true });
  });

  // Task 10 review, fix pass 2 — the reachable broken state: the roster cache
  // is a module-level Map that lives for the renderer process, never cleared.
  // Settings genuinely unmounts/remounts on every open (the dialog returns
  // null when closed), so a SECOND mount for a cwd whose cache is already
  // 'ready' must still re-ensure — otherwise Open folder stays enabled (it's
  // gated on a computed path, not on the folder existing) and silently does
  // nothing for a folder that was never created, or was deleted and the
  // stale cache entry never noticed.
  it('re-ensures the personal folder on a second mount even though the cache is already warm', async () => {
    const list = vi.fn().mockResolvedValue({
      definitions: [], skipped: [], folders: { personal: '/p', claudeUser: '/c' },
    });
    mockClaude(list);
    const cwd = 'cwd-settings-remount-warm';

    const first = render(<SpecialistsSection cwd={cwd} />);
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    first.unmount();

    render(<SpecialistsSection cwd={cwd} />);
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(list).toHaveBeenLastCalledWith({ cwd, ensurePersonalFolder: true });
  });
});

describe('Open folder', () => {
  it('surfaces the real error string when shell.openPath resolves with one, instead of failing silently', async () => {
    const list = vi.fn().mockResolvedValue({
      definitions: [], skipped: [],
      folders: { personal: '/p', claudeUser: '/c' },
    });
    mockClaude(list);
    (window as any).claude.shell.openPath = vi.fn().mockResolvedValue('Access is denied.');

    render(<SpecialistsSection cwd="cwd-open-folder-fails" />);
    const button = await screen.findByRole('button', { name: 'Open folder' });
    fireEvent.click(button);

    await waitFor(() => expect(screen.getByText('Access is denied.')).toBeInTheDocument());
    expect((window as any).claude.shell.openPath).toHaveBeenCalledWith('/p');
  });

  it('shows nothing when shell.openPath resolves with the empty-string success value', async () => {
    const list = vi.fn().mockResolvedValue({
      definitions: [], skipped: [],
      folders: { personal: '/p', claudeUser: '/c' },
    });
    mockClaude(list);
    (window as any).claude.shell.openPath = vi.fn().mockResolvedValue('');

    render(<SpecialistsSection cwd="cwd-open-folder-succeeds" />);
    const button = await screen.findByRole('button', { name: 'Open folder' });
    fireEvent.click(button);

    await waitFor(() => expect((window as any).claude.shell.openPath).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

// Task 13 — telling "still loading", "genuinely failed", and "this device
// can't do this yet" apart, so a real failure never reads as "nothing set".
describe('roster status: loading / failed / unavailable', () => {
  it('loading shows LoadingState("specialists"), never a bare "Loading…"', async () => {
    // A promise that never resolves during the test keeps the roster in
    // 'loading' the whole time — the pin is what's on screen WHILE waiting.
    const list = vi.fn(() => new Promise(() => {}));
    mockClaude(list);

    render(<SpecialistsSection cwd="cwd-loading" />);

    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(await screen.findByText(/Loading specialists…/)).toBeInTheDocument();
    // The literal bare string a spinner-less "Loading…" would have used —
    // must never appear anywhere on the screen, including the tier rows.
    expect(screen.queryByText('Loading…')).toBeNull();
  });

  it('a rejected list shows ErrorState recoverable with the real error text and Retry re-calls list', async () => {
    const list = vi.fn()
      .mockRejectedValueOnce(new Error('ENOENT: could not read the specialists folder'))
      .mockResolvedValueOnce({ definitions: [], skipped: [], folders: { personal: '/p', claudeUser: '/c' } });
    mockClaude(list);

    render(<SpecialistsSection cwd="cwd-list-failed" />);

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('ENOENT: could not read the specialists folder')).toBeInTheDocument();

    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it('a not-implemented list shows the desktop-only state (no spinner, no Retry)', async () => {
    const list = vi.fn().mockResolvedValue({ ok: false, error: NOT_IMPLEMENTED_ON_MOBILE });
    mockClaude(list);

    render(<SpecialistsSection cwd="cwd-unavailable" />);

    expect(await screen.findByText('Specialists run on the desktop app. Open settings there to add or edit them.')).toBeInTheDocument();
    // Whole-section takeover, not a per-widget fallback: the tier pickers
    // above the roster must not render alongside this message either.
    expect(screen.queryByText('Models specialists run on')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.queryByLabelText('Model')).toBeNull();
  });
});

describe('model tiers: load and write failures are shown, never swallowed into "not set"', () => {
  it('a rejected getDelegatedModels shows the tier error, not "not set"', async () => {
    const list = vi.fn().mockResolvedValue({ definitions: [], skipped: [], folders: { personal: '/p', claudeUser: '/c' } });
    mockClaude(list);
    (window as any).claude.specialists.getDelegatedModels = vi.fn().mockRejectedValue(new Error('Could not reach the harness.'));

    render(<SpecialistsSection cwd="cwd-tier-load-failed" />);

    await waitFor(() => expect(screen.getByText('Could not reach the harness.')).toBeInTheDocument());
    expect(screen.queryByText(/Not set/)).toBeNull();
  });

  it('setDelegatedModel {ok:false} reverts the picker and shows the error', async () => {
    const list = vi.fn().mockResolvedValue({ definitions: [], skipped: [], folders: { personal: '/p', claudeUser: '/c' } });
    mockClaude(list);
    (window as any).claude.specialists.getDelegatedModels = vi.fn().mockResolvedValue({
      budget: { providerId: 'openrouter', modelId: 'x/y', label: 'My Budget Model' },
      frontier: null,
    });
    (window as any).claude.specialists.setDelegatedModel = vi.fn().mockResolvedValue({ ok: false, error: 'Model no longer available.' });

    render(<SpecialistsSection cwd="cwd-tier-write-failed" />);

    // WHY assert on the picker's own trigger text, not a separate "Set to …"
    // line (round 4 — that line is gone, it only repeated this value): the
    // test's provider/catalog mocks are empty, so the trigger falls back to
    // the raw modelId ("x/y") rather than the label — see ModelPicker's
    // `currentLabel`. Open-then-click "No selection" replaces the removed
    // Clear button, matching how a real pick is made.
    const budgetRow = await screen.findByTestId('tier-row-budget');
    await within(budgetRow).findByText('x/y');
    fireEvent.click(within(budgetRow).getByRole('button', { name: 'Model' }));
    fireEvent.click(await screen.findByRole('button', { name: 'No selection' }));

    // Reverts: the previous value is still shown, not cleared.
    await waitFor(() => expect(within(budgetRow).getByText('x/y')).toBeInTheDocument());
    // The real refusal text is shown verbatim, not swallowed.
    expect(screen.getByText(/Model no longer available\./)).toBeInTheDocument();
  });

  // Fix 1 (review): the write-failure message used to be a hand-rolled
  // <div className="… text-danger"> — no role="alert", so a screen reader
  // never announced it. It now goes through the shared FieldError component
  // (components/ui/states.tsx), which carries role="alert" by construction.
  // This test pins that specifically, not just "the text is on screen"
  // (which the test above already covers) — screen.getByText alone would
  // pass equally whether or not the accessibility role was ever wired up.
  it('the write-failure message is announced as an alert, with the backend text verbatim', async () => {
    const list = vi.fn().mockResolvedValue({ definitions: [], skipped: [], folders: { personal: '/p', claudeUser: '/c' } });
    mockClaude(list);
    (window as any).claude.specialists.getDelegatedModels = vi.fn().mockResolvedValue({
      budget: { providerId: 'openrouter', modelId: 'x/y', label: 'My Budget Model' },
      frontier: null,
    });
    (window as any).claude.specialists.setDelegatedModel = vi.fn().mockResolvedValue({ ok: false, error: 'Model no longer available.' });

    render(<SpecialistsSection cwd="cwd-tier-write-alert" />);

    const budgetRow = await screen.findByTestId('tier-row-budget');
    await within(budgetRow).findByText('x/y');
    fireEvent.click(within(budgetRow).getByRole('button', { name: 'Model' }));
    fireEvent.click(await screen.findByRole('button', { name: 'No selection' }));

    // role="alert" does not compute its accessible NAME from content (ARIA:
    // "alert" is name-from-author, not name-from-content) — find the alert,
    // then assert its text content directly rather than filtering by name.
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText("Couldn’t save the budget model. Model no longer available.")).toBeInTheDocument();
  });

  // Fix 2 (review): "roster: never a bare 'Loading…'" test resolved the tier
  // call synchronously off an already-resolved mock, so by assertion time the
  // row had almost certainly already settled — it would have passed whether
  // or not the loading copy was correct. A tier call that never resolves
  // during the test keeps the row in its loading branch for the whole run,
  // the same technique the roster-loading test above already uses.
  it('the tier rows show their own named loading state while getDelegatedModels is still pending', async () => {
    const list = vi.fn().mockResolvedValue({ definitions: [], skipped: [], folders: { personal: '/p', claudeUser: '/c' } });
    mockClaude(list);
    (window as any).claude.specialists.getDelegatedModels = vi.fn(() => new Promise(() => {}));

    render(<SpecialistsSection cwd="cwd-tier-loading" />);

    expect(await screen.findByText(/Loading the budget model…/)).toBeInTheDocument();
    expect(await screen.findByText(/Loading the frontier model…/)).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).toBeNull();
  });

  // Fix (small item, review): the roster-load equivalent of this test
  // already existed; the tier-load one did not, so Retry on a tier failure
  // was unverified.
  it('a rejected getDelegatedModels shows Retry, and Retry re-calls getDelegatedModels', async () => {
    const list = vi.fn().mockResolvedValue({ definitions: [], skipped: [], folders: { personal: '/p', claudeUser: '/c' } });
    mockClaude(list);
    const getDelegatedModels = vi.fn()
      .mockRejectedValueOnce(new Error('Could not reach the harness.'))
      .mockResolvedValueOnce({ budget: null, frontier: null });
    (window as any).claude.specialists.getDelegatedModels = getDelegatedModels;

    render(<SpecialistsSection cwd="cwd-tier-load-retry" />);

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Could not reach the harness.')).toBeInTheDocument();

    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(getDelegatedModels).toHaveBeenCalledTimes(2));
  });
});

// Fix 2 (review, Important): the desktop-only takeover is supposed to fire on
// TWO independent signals — the roster call reporting not-implemented, OR the
// tier call reporting it on its own while the roster loads fine (tracked via
// `tiersUnavailable` in SpecialistsSection). Every existing desktop-only test
// drove the roster's own status; none drove this second path.
describe('desktop-only takeover: the tier-call signal, independent of the roster', () => {
  it('shows the desktop-only state when the roster loads fine but getDelegatedModels reports not-implemented', async () => {
    const list = vi.fn().mockResolvedValue({
      definitions: [
        { id: 'explorer', displayName: 'Explorer', description: 'Searches.', charter: 'read-only', allowedTools: ['Read'], source: 'builtin', warnings: [], offered: true },
      ],
      skipped: [],
      folders: { personal: '/p', claudeUser: '/c' },
    });
    mockClaude(list);
    (window as any).claude.specialists.getDelegatedModels = vi.fn().mockResolvedValue({ ok: false, error: NOT_IMPLEMENTED_ON_MOBILE });

    render(<SpecialistsSection cwd="cwd-tiers-unavailable" />);

    expect(await screen.findByText('Specialists run on the desktop app. Open settings there to add or edit them.')).toBeInTheDocument();
    // Whole-section takeover — the roster that DID load must not show through.
    expect(screen.queryByText('Models specialists run on')).toBeNull();
    expect(screen.queryByText('Explorer')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});

// Small item (review): no test pinned the footer copy.
describe('roster footer copy', () => {
  it('shows the re-read-on-send footer text verbatim', async () => {
    const list = vi.fn().mockResolvedValue({
      definitions: [], skipped: [], folders: { personal: '/p', claudeUser: '/c' },
    });
    mockClaude(list);

    render(<SpecialistsSection cwd="cwd-footer-copy" />);

    expect(await screen.findByText('Files are re-read each time you send a message; Refresh to re-read now.')).toBeInTheDocument();
  });
});

describe('roster rows', () => {
  it('groups render Built in / Your specialists / Claude Code agents with the definedBy line; skipped and not-offered files show their reason', async () => {
    const list = vi.fn().mockResolvedValue({
      definitions: [
        {
          id: 'explorer', displayName: 'Explorer', description: 'Searches.', charter: 'read-only',
          allowedTools: ['Read', 'Glob', 'Grep'], source: 'builtin', warnings: [], offered: true,
        },
        {
          id: 'my-helper', displayName: 'My Helper', description: 'Does a thing.', charter: 'read-only',
          allowedTools: ['Read'], source: 'personal', path: '/home/x/.youcoded/specialists/my-helper.md',
          warnings: [], offered: true,
        },
        {
          id: 'over-cap', displayName: 'Over Cap', description: 'Too many defined.', charter: 'read-only',
          allowedTools: ['Read'], source: 'claude-code', path: '/home/x/.claude/agents/over-cap.md',
          warnings: ["not offered to the assistant — more than 20 specialists are defined for this folder; remove or move some"],
          offered: false,
        },
      ],
      skipped: [
        { path: '/home/x/.youcoded/specialists/dup.md', source: 'personal', error: "id 'my-helper' is already used by another specialist — this file was skipped" },
      ],
      folders: { personal: '/home/x/.youcoded/specialists', claudeUser: '/home/x/.claude/agents' },
    });
    mockClaude(list);

    render(<SpecialistsSection cwd="cwd-roster-groups" />);

    // Destin (workbench pass): "Built in" appears exactly ONCE — the group
    // heading. The builtin row used to repeat it as its own provenance line,
    // directly under the heading that already said it. This assertion is the
    // guard against that redundancy creeping back.
    expect(await screen.findAllByText('Built in')).toHaveLength(1);
    expect(screen.getByText('Your specialists')).toBeInTheDocument();
    expect(screen.getByText('Claude Code agents')).toBeInTheDocument();

    // definedBy lines. Same reason as above: under a "Your specialists"
    // heading only the FILENAME earns its place. The Claude Code line keeps
    // its full prefix — that one heading covers two different folders.
    expect(screen.getByText('my-helper.md')).toBeInTheDocument();
    expect(screen.queryByText(/Your specialists folder ·/)).not.toBeInTheDocument();
    expect(screen.getByText('Your ~/.claude/agents/over-cap.md')).toBeInTheDocument();

    // Not-offered file shows its reason inline (not just greyed out silently).
    expect(screen.getByText(/not offered to the assistant — more than 20 specialists/)).toBeInTheDocument();

    // Skipped file shows its own filename and its reason.
    expect(screen.getByText('dup.md')).toBeInTheDocument();
    expect(screen.getByText(/id 'my-helper' is already used by another specialist/)).toBeInTheDocument();
  });

  it('shows the full description when it was shortened for the assistant, with the warning explaining why', async () => {
    const list = vi.fn().mockResolvedValue({
      definitions: [
        {
          id: 'long-desc', displayName: 'Long Desc', description: 'Short cut…', charter: 'read-only',
          allowedTools: ['Read'], source: 'personal', path: '/home/x/.youcoded/specialists/long-desc.md',
          warnings: ["description shortened to 300 characters for the assistant's tool list — the full text is here"],
          offered: true,
          fullDescription: 'Short cut… and then quite a lot more text that the assistant never sees, kept here for Settings only.',
        },
      ],
      skipped: [],
      folders: { personal: '/home/x/.youcoded/specialists', claudeUser: '/home/x/.claude/agents' },
    });
    mockClaude(list);

    render(<SpecialistsSection cwd="cwd-full-description" />);

    expect(await screen.findByText('Short cut… and then quite a lot more text that the assistant never sees, kept here for Settings only.')).toBeInTheDocument();
    expect(screen.queryByText('Short cut…')).toBeNull();
  });
});

describe('no leftover "shadows" language', () => {
  it('the section contains no shadows text', async () => {
    const list = vi.fn().mockResolvedValue({
      definitions: [
        { id: 'explorer', displayName: 'Explorer', description: 'Searches.', charter: 'read-only', allowedTools: ['Read'], source: 'builtin', warnings: [], offered: true },
      ],
      skipped: [
        { path: '/home/x/.youcoded/specialists/dup.md', source: 'personal', error: "id 'explorer' is already used by another specialist — this file was skipped" },
      ],
      folders: { personal: '/p', claudeUser: '/c' },
    });
    mockClaude(list);

    const { container } = render(<SpecialistsSection cwd="cwd-no-shadows" />);
    await screen.findByText('Explorer');

    expect(container.textContent?.toLowerCase()).not.toContain('shadow');
  });
});
