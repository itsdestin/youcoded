// @vitest-environment jsdom
// desktop/tests/development-popup.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { DevelopmentPopup } from '../src/renderer/components/development/DevelopmentPopup';
import { BugReportPopup } from '../src/renderer/components/development/BugReportPopup';
import { ContributePopup } from '../src/renderer/components/development/ContributePopup';

// WHY: createPortal renders into document.body — cleanup after each test prevents
// DOM accumulation that causes "multiple elements found" errors in subsequent tests.
afterEach(cleanup);

describe('DevelopmentPopup', () => {
  it('renders all three rows', () => {
    render(<DevelopmentPopup open={true} onClose={() => undefined} onOpenBug={() => undefined} onOpenContribute={() => undefined} />);
    expect(screen.getByText(/Report a Bug or Request a Feature/i)).toBeInTheDocument();
    expect(screen.getByText(/Contribute to YouCoded/i)).toBeInTheDocument();
    expect(screen.getByText(/Known Issues and Planned Features/i)).toBeInTheDocument();
  });

  it('opens the GitHub issues URL when Known Issues is clicked', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const onClose = vi.fn();
    render(<DevelopmentPopup open={true} onClose={onClose} onOpenBug={() => undefined} onOpenContribute={() => undefined} />);
    fireEvent.click(screen.getByText(/Known Issues and Planned Features/i));
    expect(openSpy).toHaveBeenCalledWith('https://github.com/itsdestin/youcoded/issues', '_blank');
    expect(onClose).toHaveBeenCalled();
    openSpy.mockRestore();
  });

  // P-15 (2026-08-25 UI audit): the popup used to hand-roll an uppercase
  // <h3> and had no close button at all — Escape was the only exit.
  it('carries the shared dialog header: a title and a ✕', () => {
    render(<DevelopmentPopup open={true} onClose={() => undefined} onOpenBug={() => undefined} onOpenContribute={() => undefined} />);
    expect(screen.getByRole('heading', { name: 'Development' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close Development' })).toBeInTheDocument();
  });

  it('calls onOpenBug when Report row is clicked', () => {
    const onOpenBug = vi.fn();
    render(<DevelopmentPopup open={true} onClose={() => undefined} onOpenBug={onOpenBug} onOpenContribute={() => undefined} />);
    fireEvent.click(screen.getByText(/Report a Bug or Request a Feature/i));
    expect(onOpenBug).toHaveBeenCalled();
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

  // P-15: titleless before, so no ✕. The title follows the Bug/Feature switch.
  it('titles itself after the selected report kind and offers a ✕', () => {
    const onClose = vi.fn();
    render(<BugReportPopup open={true} onClose={onClose} />);
    expect(screen.getByRole('heading', { name: 'Report a bug' })).toBeInTheDocument();
    fireEvent.click(screen.getByText(/^Feature$/));
    expect(screen.getByRole('heading', { name: 'Request a feature' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close Request a feature' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('disables Continue until description is at least 10 chars', () => {
    render(<BugReportPopup open={true} onClose={() => undefined} />);
    const cont = screen.getByText(/^Continue$/) as HTMLButtonElement;
    expect(cont).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/What's happening/i), { target: { value: 'short' } });
    expect(cont).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/What's happening/i), { target: { value: 'this is long enough' } });
    expect(cont).not.toBeDisabled();
  });

  it('passes the bug label when submitting from Bug toggle', async () => {
    render(<BugReportPopup open={true} onClose={() => undefined} />);
    fireEvent.change(screen.getByPlaceholderText(/What's happening/i), { target: { value: 'a real bug description' } });
    fireEvent.click(screen.getByText(/^Continue$/));
    // Wait for summarize to resolve and Submit button to render.
    await screen.findByText(/Submit as GitHub Issue/i);
    fireEvent.click(screen.getByText(/Submit as GitHub Issue/i));
    await screen.findByText(/Issue created/i);
    expect((window as any).claude.dev.submitIssue).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'bug' }),
    );
  });

  it('passes the enhancement label when Feature toggle is selected', async () => {
    render(<BugReportPopup open={true} onClose={() => undefined} />);
    fireEvent.click(screen.getByText(/^Feature$/));
    fireEvent.change(screen.getByPlaceholderText(/What's happening/i), { target: { value: 'a real feature description' } });
    fireEvent.click(screen.getByText(/^Continue$/));
    await screen.findByText(/Submit as GitHub Issue/i);
    fireEvent.click(screen.getByText(/Submit as GitHub Issue/i));
    await screen.findByText(/Issue created/i);
    expect((window as any).claude.dev.submitIssue).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'enhancement' }),
    );
  });

  it('passes raw fields (kind, summary, description) instead of a pre-built body', async () => {
    render(<BugReportPopup open={true} onClose={() => undefined} />);
    fireEvent.change(screen.getByPlaceholderText(/What's happening/i), { target: { value: 'a real bug description' } });
    fireEvent.click(screen.getByText(/^Continue$/));
    await screen.findByText(/Submit as GitHub Issue/i);
    fireEvent.click(screen.getByText(/Submit as GitHub Issue/i));
    await screen.findByText(/Issue created/i);
    const callArgs = (window as any).claude.dev.submitIssue.mock.calls[0][0];
    // New contract: renderer passes raw fields, not a pre-assembled body string.
    expect(callArgs).toHaveProperty('kind', 'bug');
    expect(callArgs).toHaveProperty('summary');
    expect(callArgs).toHaveProperty('description');
    expect(callArgs).not.toHaveProperty('body');
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
