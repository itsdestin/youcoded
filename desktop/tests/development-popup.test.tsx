// @vitest-environment jsdom
// desktop/tests/development-popup.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { HelpPopup } from '../src/renderer/components/HelpPopup';
import { BugReportPopup } from '../src/renderer/components/development/BugReportPopup';
import { ContributePopup } from '../src/renderer/components/development/ContributePopup';

// WHY: createPortal renders into document.body — cleanup after each test prevents
// DOM accumulation that causes "multiple elements found" errors in subsequent tests.
afterEach(cleanup);

// Development's rows moved into Help & feedback (2026-09-28, help-merge#HM-1..3); the
// promises the old DevelopmentPopup suite kept are kept here against their new home.
describe('Help & feedback carries the development rows', () => {
  const renderHelp = (over: Partial<Parameters<typeof HelpPopup>[0]> = {}) =>
    render(<HelpPopup open={true} onClose={() => undefined} onOpenBug={() => undefined} onOpenContribute={() => undefined} {...over} />);

  it('renders every row Development had', () => {
    renderHelp();
    expect(screen.getByText(/Report a bug or request a feature/i)).toBeInTheDocument();
    expect(screen.getByText(/Contribute to YouCoded/i)).toBeInTheDocument();
    expect(screen.getByText(/^Known issues$/)).toBeInTheDocument();
    // Roadmap was designed and approved, then shipped invisible once already
    // (grader, 2026-09-10) — keep it pinned.
    expect(screen.getByText(/^Roadmap$/)).toBeInTheDocument();
  });

  it('opens the GitHub issues URL when Known issues is clicked', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const onClose = vi.fn();
    renderHelp({ onClose });
    fireEvent.click(screen.getByText(/^Known issues$/));
    expect(openSpy).toHaveBeenCalledWith('https://github.com/itsdestin/youcoded/issues', '_blank');
    expect(onClose).toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it('carries the shared dialog header: a title and a ✕', () => {
    renderHelp();
    expect(screen.getByRole('heading', { name: 'Help & feedback' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close Help & feedback' })).toBeInTheDocument();
  });

  it('opens the report and contribute screens from their rows', () => {
    const onOpenBug = vi.fn();
    const onOpenContribute = vi.fn();
    renderHelp({ onOpenBug, onOpenContribute });
    fireEvent.click(screen.getByText(/Report a bug or request a feature/i));
    fireEvent.click(screen.getByText(/Contribute to YouCoded/i));
    expect(onOpenBug).toHaveBeenCalled();
    expect(onOpenContribute).toHaveBeenCalled();
  });
});

describe('BugReportPopup', () => {
  beforeEach(() => {
    (window as any).claude = {
      dev: {
        logTail: vi.fn().mockResolvedValue(''),
        diagnostics: vi.fn().mockResolvedValue('=== YouCoded Diagnostics ===\nfake\n=== End Diagnostics ==='),
        summarizeIssue: vi.fn().mockResolvedValue({ title: 'T', summary: 'S', flagged_strings: [] }),
        submitIssue: vi.fn().mockResolvedValue({ ok: true, url: 'https://github.com/itsdestin/youcoded/issues/1' }),
        installWorkspace: vi.fn().mockResolvedValue({ path: '/h/youcoded-dev', alreadyInstalled: false }),
        onInstallProgress: vi.fn(() => () => undefined),
        openSessionIn: vi.fn().mockResolvedValue({ id: 's1' }),
      },
    };
  });

  // Rewritten 2026-09-10, when the gate came off and the legacy screen was deleted.
  // The promises below are real and kept; only the screen carrying them changed.
  // The one that did NOT survive is "the title follows the Bug/Feature switch" —
  // R2-10 replaced it with a single "Submit a ticket" heading for both tabs, which
  // Destin approved, so asserting the old behaviour would pin a reverted decision.
  it('keeps one heading for both kinds, and offers a ✕', () => {
    const onClose = vi.fn();
    render(<BugReportPopup open={true} onClose={onClose} />);
    expect(screen.getByRole('heading', { name: 'Submit a ticket' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Feature' }));
    expect(screen.getByRole('heading', { name: 'Submit a ticket' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Close/ }));
    expect(onClose).toHaveBeenCalled();
  });

  it('will not move on until there is something to send', () => {
    render(<BugReportPopup open={true} onClose={() => undefined} />);
    const review = screen.getByRole('button', { name: 'Review ticket' }) as HTMLButtonElement;
    expect(review).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'The menu closes' } });
    expect(review).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Opening the menu closes the window.' } });
    expect(review).not.toBeDisabled();
  });

  const fill = (kind?: 'Feature') => {
    if (kind) fireEvent.click(screen.getByRole('tab', { name: kind }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'The menu closes' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Opening the menu closes the window.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review ticket' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit public ticket' }));
  };

  it('passes the bug label when submitting from the Bug tab', async () => {
    render(<BugReportPopup open={true} onClose={() => undefined} />);
    fill();
    await screen.findByText(/Your ticket is submitted/i);
    expect((window as any).claude.dev.submitIssue).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'bug' }),
    );
  });

  it('passes the enhancement label when the Feature tab is selected', async () => {
    render(<BugReportPopup open={true} onClose={() => undefined} />);
    fill('Feature');
    await screen.findByText(/Your ticket is submitted/i);
    expect((window as any).claude.dev.submitIssue).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'enhancement' }),
    );
  });

  it('passes raw fields instead of a pre-built body', async () => {
    render(<BugReportPopup open={true} onClose={() => undefined} />);
    fill();
    await screen.findByText(/Your ticket is submitted/i);
    const callArgs = (window as any).claude.dev.submitIssue.mock.calls[0][0];
    // The body is assembled in main, where the real app version and OS live.
    expect(callArgs).toHaveProperty('kind', 'bug');
    expect(callArgs).toHaveProperty('description');
    expect(callArgs).not.toHaveProperty('body');
    // And no AI summary was produced, because none was asked for (R12).
    expect((window as any).claude.dev.summarizeIssue).not.toHaveBeenCalled();
  });
});

describe('ContributePopup', () => {
  // Rewritten 2026-09-10. These two tests protected real behaviour — setup runs,
  // then you can open the project — but against the legacy screen's fixed-folder
  // installer, which was deleted. Same promises, current mechanism: contract R9
  // (never touch an existing folder) is why dev:setup-workspace exists, and R10
  // ("setup finishes and the project opens") is why "Open it" must actually open it.
  beforeEach(() => {
    (window as any).claude = {
      dev: {
        setupWorkspace: vi.fn().mockResolvedValue({ ok: true, path: '/h/YouCoded/Development/youcoded-workspace' }),
        setupStatus: vi.fn().mockResolvedValue({ state: 'idle' }),
        openSessionIn: vi.fn().mockResolvedValue({ id: 's1' }),
        // Present so a wrong call is a FAILED ASSERTION rather than a TypeError that
        // could be mistaken for an unrelated crash.
        installWorkspace: vi.fn(),
      },
    };
  });

  it('sets the workspace up and never uses the fixed-folder installer', async () => {
    render(<ContributePopup open={true} onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Set up development workspace' }));
    await screen.findByText(/Your development workspace is ready/i);
    expect((window as any).claude.dev.setupWorkspace).toHaveBeenCalled();
    expect((window as any).claude.dev.installWorkspace).not.toHaveBeenCalled();
  });

  it('opens the finished project in a session', async () => {
    const onClose = vi.fn();
    render(<ContributePopup open={true} onClose={onClose} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Set up development workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open it' }));
    await vi.waitFor(() => expect((window as any).claude.dev.openSessionIn).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/h/YouCoded/Development/youcoded-workspace' }),
    ));
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
