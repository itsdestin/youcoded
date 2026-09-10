// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BugReportPopup } from './BugReportPopup';
import { ContributePopup } from './ContributePopup';
import { DevelopmentPopup } from './DevelopmentPopup';

beforeEach(() => window.history.replaceState({}, '', '/?mode=workbench'));
afterEach(() => { cleanup(); window.history.replaceState({}, '', '/'); });
// Every Contribute render now reads setup status on mount (R6-24: "you can close
// this and setup keeps going" is only true if the screen can ask where it got to).
const idle = () => Promise.resolve({ state: 'idle' as const });

describe('development design safety', () => {
  it('keeps the walkthrough inside Contribute and public navigation usable', () => {
    const openExternal = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<DevelopmentPopup open onClose={() => {}} onOpenBug={() => {}} onOpenContribute={() => {}} />);
    expect(screen.queryByRole('button', { name: 'How contributing works' })).toBeNull();
    fireEvent.click(screen.getByText('Roadmap'));
    expect(openExternal).toHaveBeenCalledWith('https://github.com/itsdestin/youcoded-dev/blob/master/ROADMAP.md', '_blank', 'noopener,noreferrer');
    fireEvent.click(screen.getByText('Known issues'));
    expect(openExternal).toHaveBeenCalledWith('https://github.com/itsdestin/youcoded/issues', '_blank');
    openExternal.mockRestore();
  });
  it('uses one ticket heading for both report types and discloses evidence on demand', () => {
    render(<BugReportPopup open onClose={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Submit a ticket' })).toBeTruthy();
    expect(screen.queryByText(/Logs record app activity/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'About recent logs' }));
    expect(screen.getByText(/Logs record app activity/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Feature' }));
    expect(screen.getByRole('heading', { name: 'Submit a ticket' })).toBeTruthy();
  });
  it('removes technical disclosures, gray warning and example states', () => {
    window.history.replaceState({}, '', '/?mode=workbench&contributionState=backup-failed');
    render(<ContributePopup open onClose={() => {}} />);
    expect(screen.queryByText('Workspace details')).toBeNull();
    expect(screen.queryByText(/Example state/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'How contributing works' }));
    expect(screen.queryByText(/Private backup saves/)).toBeNull();
    expect(screen.getByText('Choose whether to propose it')).toBeTruthy();
  });
  it('reviews editable evidence without calling a provider and preserves the draft on close', () => {
    const dev = { summarizeIssue: vi.fn(), diagnostics: vi.fn(), logTail: vi.fn(), installWorkspace: vi.fn() };
    Object.assign(window, { claude: { dev } });
    const view = render(<BugReportPopup open onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'The menu closes' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Opening the menu closes the window.' } });
    fireEvent.click(screen.getByText('Review ticket'));
    expect(screen.getByText('Optional AI help')).toBeTruthy();
    expect(dev.summarizeIssue).not.toHaveBeenCalled();
    expect(dev.logTail).not.toHaveBeenCalled();
    view.rerender(<BugReportPopup open={false} onClose={() => {}} />);
    view.rerender(<BugReportPopup open onClose={() => {}} />);
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('The menu closes');
  });
  it('reviews selected logs before AI and keeps fields through back without demo controls', () => {
    render(<BugReportPopup open onClose={() => {}} />);
    expect(screen.queryByText('Optional AI help')).toBeNull();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'A retained title' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'A retained description' } });
    expect(screen.getByRole('checkbox', { name: 'Include recent logs' }).getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include recent logs' }));
    expect(screen.queryByLabelText('Logs to review')).toBeNull();
    fireEvent.click(screen.getByText('Review ticket'));
    fireEvent.change(screen.getByLabelText('Logs to review'), { target: { value: 'Sample log' } });
    fireEvent.click(screen.getByRole('button', { name: 'Optional AI help' }));
    expect(screen.getByText(/Nothing is sent automatically/)).toBeTruthy();
    expect(screen.queryByText('Preview a submission error')).toBeNull();
    fireEvent.click(screen.getByText('Back to draft'));
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('A retained title');
    expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe('A retained description');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Finish with attachments in GitHub' }));
    expect(screen.getByText(/GitHub uploads a file as soon as you attach it/)).toBeTruthy();
    fireEvent.click(screen.getByText('Review ticket'));
    expect((screen.getByLabelText('Logs to review') as HTMLTextAreaElement).value).toBe('Sample log');
  });
  // WHY: four nouns for one object (ticket / report / bug report / issue) read as four
  // different actions. Pin the single noun so a future copy edit cannot reintroduce the split.
  it('calls the ticket a ticket at every step', () => {
    render(<BugReportPopup open onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'A title' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'A description' } });
    fireEvent.click(screen.getByText('Review ticket'));
    expect(screen.getByText('Review your ticket')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Submit public ticket' })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/bug report|feature request|public issue/i);
  });

  // WHY: Destin, 2026-09-09 — "the workbench shouldn't have code that makes it look different
  // from the real app, that defeats the whole point." No prototype captions on any design screen.
  const CAPTION = /in this preview|prototype ·|prototype:|not connected|unavailable in this/i;

  it('never captions the contribution screen as a preview or prototype', () => {
    render(<ContributePopup open onClose={() => {}} />);
    expect(document.body.textContent).not.toMatch(CAPTION);
    fireEvent.click(screen.getByRole('button', { name: 'How contributing works' }));
    expect(document.body.textContent).not.toMatch(CAPTION);
  });

  it('never captions the ticket screens as a preview or prototype', () => {
    render(<BugReportPopup open onClose={() => {}} />);
    expect(document.body.textContent).not.toMatch(CAPTION);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'A title' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'A description' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include recent logs' }));
    fireEvent.click(screen.getByText('Review ticket'));
    expect(document.body.textContent).not.toMatch(CAPTION);
    fireEvent.click(screen.getByRole('button', { name: 'Optional AI help' }));
    expect(document.body.textContent).not.toMatch(CAPTION);
  });

  it('does not collect logs for feature requests', () => {
    render(<BugReportPopup open onClose={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Feature' }));
    expect(screen.queryByRole('checkbox', { name: 'Include recent logs' })).toBeNull();
  });
  it('never connects managed setup to the old installer', async () => {
    const installWorkspace = vi.fn();
    const setupWorkspace = vi.fn().mockResolvedValue({ ok: true, path: '/home/you/YouCoded/Projects/w' });
    Object.assign(window, { claude: { dev: { installWorkspace, setupWorkspace, setupStatus: idle } } });
    render(<ContributePopup open onClose={() => {}} />);
    // WHY: the guard is that the legacy installer is never reached — not that the button looks
    // dead. Destin rejected the disabled/greyed treatment: the workbench must look like the app.
    // It now also asserts the NEW path IS taken: "installWorkspace was not called" alone stays
    // true if the button does nothing at all, which is how a dead button passes a safety test.
    fireEvent.click(screen.getByRole('button', { name: 'Set up development workspace' }));
    expect(setupWorkspace).toHaveBeenCalledTimes(1);
    expect(installWorkspace).not.toHaveBeenCalled();
    await screen.findByText(/Your development workspace is ready/);
  });

  it('finds setup still running when you close and come back', async () => {
    // WHY: the setting-up screen tells you "you can close this — setup keeps going,
    // and you'll find it here when you come back" (Destin, R6-24). A sentence like
    // that is a promise; this is what makes it one. Reopening asks the main process
    // where setup got to instead of showing the start button over a running setup.
    const setupStatus = vi.fn().mockResolvedValue({ state: 'running' });
    Object.assign(window, { claude: { dev: { setupStatus, setupWorkspace: vi.fn() } } });
    render(<ContributePopup open onClose={() => {}} />);
    await screen.findByText(/Setting up your development workspace/);
    expect(screen.queryByRole('button', { name: 'Set up development workspace' })).toBeNull();
  });

  it('shows a setup that finished while you were away', async () => {
    const setupStatus = vi.fn().mockResolvedValue({ state: 'ready', path: '/home/you/YouCoded/Projects/w' });
    Object.assign(window, { claude: { dev: { setupStatus, setupWorkspace: vi.fn() } } });
    render(<ContributePopup open onClose={() => {}} />);
    await screen.findByText(/Your development workspace is ready/);
  });

  it('offers a way forward when setup fails, and never just Done', async () => {
    // WHY: the legacy screen's only action on failure was Done (audit E-08), which
    // discards what already succeeded. The reason shown is the one the operation
    // gave — never a guess (docs/error-message-standards.md).
    const setupWorkspace = vi.fn().mockResolvedValue({ ok: false, error: 'Could not reach github.com.' });
    Object.assign(window, { claude: { dev: { setupWorkspace, setupStatus: idle } } });
    render(<ContributePopup open onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Set up development workspace' }));
    await screen.findByText(/Could not reach github\.com\./);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('keeps the draft and offers a retry when a ticket cannot be sent', async () => {
    // Contract R23. A failure must not be a dead end that costs the user their words.
    const submitIssue = vi.fn().mockResolvedValue({ ok: false, error: 'GitHub rejected the request.' });
    Object.assign(window, { claude: { dev: { submitIssue } } });
    render(<BugReportPopup open onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'The menu closes' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Opening the menu closes the window.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review ticket' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit public ticket' }));
    await screen.findByText('GitHub rejected the request.');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    // This file does not load jest-dom, so read the values directly.
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('The menu closes');
    expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value)
      .toBe('Opening the menu closes the window.');
  });

  it('finishes an attachment ticket in the browser without filing it first', async () => {
    // Design review F4: the old flow mapped attachments onto the no-credential
    // fallback, so a SIGNED-IN user had the issue created immediately and never
    // reached GitHub to attach anything. browserOnly says "prefill, create nothing".
    const submitIssue = vi.fn().mockResolvedValue({
      ok: false, needsBrowser: true, truncated: false, fallbackUrl: 'https://github.com/x/y/issues/new',
    });
    const openExternal = vi.fn();
    Object.assign(window, { claude: { dev: { submitIssue }, shell: { openExternal } } });
    render(<BugReportPopup open onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'The menu closes' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Opening the menu closes the window.' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Finish with attachments in GitHub' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review ticket' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue in GitHub' }));
    await screen.findByText(/Finish your ticket in GitHub/);
    expect(submitIssue).toHaveBeenCalledWith(expect.objectContaining({ browserOnly: true }));
    // WHY openExternal and not window.open: window.open is a dead call on Android
    // and remote, so the hand-off would silently do nothing there.
    expect(openExternal).toHaveBeenCalledWith('https://github.com/x/y/issues/new');
  });

  it('says so when the browser link had to drop part of the ticket', async () => {
    // Audit E-07: the prefill shortens the body to fit a URL cap. It used to do that
    // silently, so evidence vanished between here and GitHub with nothing said.
    const submitIssue = vi.fn().mockResolvedValue({
      ok: false, needsBrowser: true, truncated: true, fallbackUrl: 'https://github.com/x/y/issues/new',
    });
    Object.assign(window, { claude: { dev: { submitIssue }, shell: { openExternal: vi.fn() } } });
    render(<BugReportPopup open onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'The menu closes' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Opening the menu closes the window.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review ticket' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit public ticket' }));
    await screen.findByText(/part of the details was left out/);
  });

  it('does not treat "not signed in" as a failure', async () => {
    // It is an ordinary branch, not an error: the ticket is finished in the browser.
    const submitIssue = vi.fn().mockResolvedValue({
      ok: false, needsBrowser: true, truncated: false, fallbackUrl: 'https://github.com/x/y/issues/new',
    });
    Object.assign(window, { claude: { dev: { submitIssue }, shell: { openExternal: vi.fn() } } });
    render(<BugReportPopup open onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'The menu closes' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Opening the menu closes the window.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review ticket' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit public ticket' }));
    await screen.findByText(/Finish your ticket in GitHub/);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('starts a report from an error with the failure already in it', async () => {
    // Audit E-01: the popup took only open/close, so the failure you were reporting
    // was gone the moment you clicked Report and you described it from memory.
    Object.assign(window, { claude: { dev: { submitIssue: vi.fn() } } });
    render(<BugReportPopup open onClose={() => {}} context={{ surface: 'Settings → Permissions', error: 'EACCES: permission denied' }} />);
    expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value)
      .toContain('Settings → Permissions');
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Permissions will not load' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review ticket' }));
    // Shown for review BEFORE anything is sent — never attached unseen (R11).
    expect(screen.getByText('EACCES: permission denied')).toBeTruthy();
  });

  it('keeps Diagnose an assistant action, not a blank form', async () => {
    // Design review F11: five general errors across the app route "Diagnose with
    // the assistant" into this screen. Moving the AI call behind a disclosure would have
    // quietly turned all five into a button that opens an empty ticket.
    Object.assign(window, { claude: { dev: { submitIssue: vi.fn() } } });
    render(<BugReportPopup open onClose={() => {}} context={{ surface: 'Local model settings', diagnose: true }} />);
    expect(screen.getByRole('heading', { name: 'Review your ticket' })).toBeTruthy();
    expect(screen.getByText(/Only this draft and selected details go to your chosen assistant/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Improve wording with the assistant' })).toBeTruthy();
  });

  it('says what remote access cannot do, not a channel name', async () => {
    // Audit E-14: over remote the bridge rejects with `remote-unsupported:
    // dev:submit-issue`. Showing that raw would be a channel id on screen. The
    // existing helper turns it into a sentence — E-15 recorded that it existed and
    // was adopted at four call sites in the whole app.
    const submitIssue = vi.fn().mockRejectedValue(new Error('remote-unsupported: dev:submit-issue'));
    Object.assign(window, { claude: { dev: { submitIssue } } });
    render(<BugReportPopup open onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'The menu closes' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Opening the menu closes the window.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review ticket' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit public ticket' }));
    await screen.findByText(/Developer tools isn.t available via remote access yet/);
    expect(document.body.textContent).not.toContain('remote-unsupported');
    // The draft survives it, like any other failure (R23).
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('The menu closes');
  });

  it('sends a ticket with no AI call at all', async () => {
    // Contract R12. Asking an assistant is a separate choice, so submitting must
    // never reach a provider.
    const summarizeIssue = vi.fn();
    const submitIssue = vi.fn().mockResolvedValue({ ok: true, url: 'https://github.com/itsdestin/youcoded/issues/471' });
    Object.assign(window, { claude: { dev: { submitIssue, summarizeIssue } } });
    render(<BugReportPopup open onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'The menu closes' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Opening the menu closes the window.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review ticket' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit public ticket' }));
    await screen.findByText(/Your ticket is submitted/);
    expect(summarizeIssue).not.toHaveBeenCalled();
  });
});
