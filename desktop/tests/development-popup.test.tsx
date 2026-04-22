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
        summarizeIssue: vi.fn().mockResolvedValue({ title: 'T', summary: 'S', flagged_strings: [] }),
        submitIssue: vi.fn().mockResolvedValue({ ok: true, url: 'https://github.com/itsdestin/youcoded/issues/1' }),
        installWorkspace: vi.fn().mockResolvedValue({ path: '/h/youcoded-dev', alreadyInstalled: false }),
        onInstallProgress: vi.fn(() => () => undefined),
        openSessionIn: vi.fn().mockResolvedValue({ id: 's1' }),
      },
    };
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
  beforeEach(() => {
    (window as any).claude = {
      dev: {
        installWorkspace: vi.fn().mockResolvedValue({ path: '/h/youcoded-dev', alreadyInstalled: false }),
        onInstallProgress: vi.fn(() => () => undefined),
        openSessionIn: vi.fn().mockResolvedValue({ id: 's1' }),
      },
    };
  });

  it('shows install button initially and triggers install on click', async () => {
    render(<ContributePopup open={true} onClose={() => undefined} />);
    expect(screen.getByText(/Install Workspace/i)).toBeInTheDocument();
    fireEvent.click(screen.getByText(/Install Workspace/i));
    await screen.findByText(/Workspace installed at/i);
    expect((window as any).claude.dev.installWorkspace).toHaveBeenCalled();
  });

  it('opens new session when "Open in New Session" is clicked', async () => {
    const onClose = vi.fn();
    render(<ContributePopup open={true} onClose={onClose} />);
    fireEvent.click(screen.getByText(/Install Workspace/i));
    await screen.findByText(/Open in New Session/i);
    fireEvent.click(screen.getByText(/Open in New Session/i));
    await new Promise((r) => setTimeout(r, 0)); // let async settle
    expect((window as any).claude.dev.openSessionIn).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/h/youcoded-dev' })
    );
    expect(onClose).toHaveBeenCalled();
  });
});
