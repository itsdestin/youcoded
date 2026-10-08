// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BugReportPopup } from './BugReportPopup';
import { ContributePopup } from './ContributePopup';
import { HelpPopup } from '../HelpPopup';

beforeEach(() => window.history.replaceState({}, '', '/?mode=workbench'));
afterEach(() => { cleanup(); window.history.replaceState({}, '', '/'); });
// Every Contribute render now reads setup status on mount (R6-24: "you can close
// this and setup keeps going" is only true if the screen can ask where it got to).
const idle = () => Promise.resolve({ state: 'idle' as const });

describe('development design safety', () => {
  // Development's rows live in Help & feedback since 2026-09-28 (help-merge#HM-1..3).
  it('keeps the walkthrough inside Contribute and public navigation usable', () => {
    const openExternal = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<HelpPopup open onClose={() => {}} onOpenBug={() => {}} onOpenContribute={() => {}} />);
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
    // Each choice explains itself in its own row (submit-ticket-1#ST-1/ST-13), not behind an (i).
    expect(screen.getByText(/last 200 lines of activity/)).toBeTruthy();
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
  it('reviews editable evidence without calling a provider and keeps the draft through review', async () => {
    // Rewritten after code review C15. Two of its assertions proved nothing:
    //   - `logTail` was never called by ANY path, so "not called" was true for ever
    //     rather than "not called until you ask". It now ticks the box and asserts
    //     the read happens THEN, which is the actual promise.
    //   - the draft check rerendered with open={false}, which does not unmount, so it
    //     held for any component keeping state in hooks — including one with no draft
    //     handling at all. It now goes to review and back, which is the journey a user
    //     actually makes and the one that could lose their words.
    const dev = { summarizeIssue: vi.fn(), diagnostics: vi.fn(), logTail: vi.fn().mockResolvedValue('line one'), installWorkspace: vi.fn() };
    Object.assign(window, { claude: { dev } });
    render(<BugReportPopup open onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'The menu closes' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Opening the menu closes the window.' } });
    expect(dev.logTail).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('switch', { name: 'Include recent logs' }));
    await vi.waitFor(() => expect(dev.logTail).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText('Review ticket'));
    expect(screen.getByText('Optional AI help')).toBeTruthy();
    expect(dev.summarizeIssue).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Back to draft' }));
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('The menu closes');
    expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value)
      .toBe('Opening the menu closes the window.');
  });

  it('shows the approved ticket screen to a user with no workbench flag', () => {
    // WHY this exists (code review C15, then the grader): every other test in this
    // file runs inside `?mode=workbench`, so for a while the whole suite was green on
    // a screen no user could open — `main.ts` never puts a mode on a packaged window.
    // Thirteen signed contract rows were unmet for that one reason. This pins which
    // screen a real user gets, so the answer can never again be "not the one we
    // tested".
    window.history.replaceState({}, '', '/');
    Object.assign(window, { claude: { dev: { logTail: vi.fn(), diagnostics: vi.fn(), summarizeIssue: vi.fn() } } });
    render(<BugReportPopup open onClose={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Submit a ticket' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Report a bug' })).toBeNull();
  });
  it('reviews selected logs before AI and keeps fields through back without demo controls', () => {
    render(<BugReportPopup open onClose={() => {}} />);
    expect(screen.queryByText('Optional AI help')).toBeNull();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'A retained title' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'A retained description' } });
    expect(screen.getByRole('switch', { name: 'Include recent logs' }).getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByRole('switch', { name: 'Include recent logs' }));
    expect(screen.queryByLabelText('Logs to review')).toBeNull();
    fireEvent.click(screen.getByText('Review ticket'));
    // The logs are a folded row on review (submit-ticket-1#ST-C1 "folded"); open it to edit.
    fireEvent.click(screen.getByRole('button', { name: /^Recent logs/ }));
    fireEvent.change(screen.getByLabelText('Logs to review'), { target: { value: 'Sample log' } });
    fireEvent.click(screen.getByRole('button', { name: 'Optional AI help' }));
    expect(screen.getByText(/Nothing is sent automatically/)).toBeTruthy();
    expect(screen.queryByText('Preview a submission error')).toBeNull();
    fireEvent.click(screen.getByText('Back to draft'));
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('A retained title');
    expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe('A retained description');
    fireEvent.click(screen.getByRole('switch', { name: 'Finish with attachments in GitHub' }));
    expect(screen.getByText(/GitHub uploads a file as soon as you attach it/)).toBeTruthy();
    fireEvent.click(screen.getByText('Review ticket'));
    // The logs fold is still open from before — what you opened stays open.
    expect((screen.getByLabelText('Logs to review') as HTMLTextAreaElement).value).toBe('Sample log');
  });
  // WHY: four nouns for one object (ticket / report / bug report / issue) read as four
  // different actions. Pin the single noun so a future copy edit cannot reintroduce the split.
  it('calls the ticket a ticket at every step', () => {
    render(<BugReportPopup open onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'A title' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'A description' } });
    fireEvent.click(screen.getByText('Review ticket'));
    expect(screen.getByText('Your ticket')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Submit public ticket' })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/bug report|feature request|public issue/i);
  });

  // WHY: Destin, 2026-09-09 — "the workbench shouldn't have code that makes it look different
  // from the real app, that defeats the whole point." No prototype captions on any design screen.
  // Widened after code review C5: the live screen carried "Sample text only — no logs
// collected", a mockup caption these tests were supposed to forbid, and the regex
// walked straight past it.
const CAPTION = /in this preview|prototype ·|prototype:|not connected|unavailable in this|sample text only|no logs collected/i;

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
    fireEvent.click(screen.getByRole('switch', { name: 'Include recent logs' }));
    fireEvent.click(screen.getByText('Review ticket'));
    expect(document.body.textContent).not.toMatch(CAPTION);
    fireEvent.click(screen.getByRole('button', { name: 'Optional AI help' }));
    expect(document.body.textContent).not.toMatch(CAPTION);
  });

  it('does not collect logs for feature requests', () => {
    render(<BugReportPopup open onClose={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Feature' }));
    expect(screen.queryByRole('switch', { name: 'Include recent logs' })).toBeNull();
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
    fireEvent.click(screen.getByRole('button', { name: 'Download YouCoded’s code' }));
    expect(setupWorkspace).toHaveBeenCalledTimes(1);
    expect(installWorkspace).not.toHaveBeenCalled();
    await screen.findByText(/YouCoded’s code is ready on this computer/);
  });

  it('finds setup still running when you close and come back', async () => {
    // WHY: the setting-up screen tells you "you can close this — setup keeps going,
    // and you'll find it here when you come back" (Destin, R6-24). A sentence like
    // that is a promise; this is what makes it one. Reopening asks the main process
    // where setup got to instead of showing the start button over a running setup.
    const setupStatus = vi.fn().mockResolvedValue({ state: 'running' });
    Object.assign(window, { claude: { dev: { setupStatus, setupWorkspace: vi.fn() } } });
    render(<ContributePopup open onClose={() => {}} />);
    await screen.findByText(/Downloading YouCoded’s code/);
    expect(screen.queryByRole('button', { name: 'Download YouCoded’s code' })).toBeNull();
  });

  it('notices setup finishing while the screen is open', async () => {
    // WHY (code review C7/C15): the "still running" test never advanced the status,
    // so it was green with no polling at all — and without polling a reopened dialog
    // sat on the spinner for ever while setup finished perfectly well behind it.
    // This one CHANGES the answer and requires the screen to notice.
    const setupStatus = vi.fn()
      .mockResolvedValueOnce({ state: 'running' })
      .mockResolvedValue({ state: 'ready', path: '/home/you/YouCoded/Development/w' });
    Object.assign(window, { claude: { dev: { setupStatus, setupWorkspace: vi.fn(), clearSetupStatus: vi.fn() } } });
    render(<ContributePopup open onClose={() => {}} />);
    await screen.findByText(/Downloading YouCoded’s code/);
    await screen.findByText(/YouCoded’s code is ready on this computer/, {}, { timeout: 4000 });
  });

  it('shows a setup that finished while you were away', async () => {
    const setupStatus = vi.fn().mockResolvedValue({ state: 'ready', path: '/home/you/YouCoded/Projects/w' });
    Object.assign(window, { claude: { dev: { setupStatus, setupWorkspace: vi.fn() } } });
    render(<ContributePopup open onClose={() => {}} />);
    await screen.findByText(/YouCoded’s code is ready on this computer/);
  });

  it('offers a way forward when setup fails, and never just Done', async () => {
    // WHY: the legacy screen's only action on failure was Done (audit E-08), which
    // discards what already succeeded. The reason shown is the one the operation
    // gave — never a guess (docs/error-message-standards.md).
    const setupWorkspace = vi.fn().mockResolvedValue({ ok: false, error: 'Could not reach github.com.' });
    Object.assign(window, { claude: { dev: { setupWorkspace, setupStatus: idle } } });
    render(<ContributePopup open onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download YouCoded’s code' }));
    // Plain words in the notice box, its Try again inside it (submit-ticket-5#ST5-9);
    // the operation's own text is one fold away, never the message itself.
    const line = await screen.findByText(/The download didn’t finish/);
    const box = line.closest('div.rounded-lg') as HTMLElement;
    expect(box.className).toMatch(/destructive/);
    expect(box.querySelector('button')?.textContent).toBe('Try again');
    expect(screen.queryByText(/Could not reach github\.com\./)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByText(/Could not reach github\.com\./)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
  });

  it('says a conversation that would not open in plain words, with the raw reason folded away', async () => {
    // Destin, submit-ticket-5#ST5-9: "mock failure dev open session in might scare our users.
    // this error is just confusing and unhelpful".
    const setupStatus = vi.fn().mockResolvedValue({ state: 'ready', path: '/home/you/YouCoded/Development/w' });
    const openSessionIn = vi.fn().mockRejectedValue(new Error('spawn claude ENOENT'));
    Object.assign(window, { claude: { dev: { setupStatus, setupWorkspace: vi.fn(), openSessionIn, clearSetupStatus: vi.fn() } } });
    render(<ContributePopup open onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open it' }));
    const line = await screen.findByText(/The new conversation didn’t open/);
    expect((line.closest('div.rounded-lg') as HTMLElement).className).toMatch(/destructive/);
    expect(screen.queryByText(/ENOENT/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByText(/spawn claude ENOENT/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
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
    await screen.findByText(/GitHub rejected the request\./);
    // The notice carries its own Try again (guide: a notice's buttons sit inside it).
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    // The review step shows the ticket read-only; the words are still there, and Back
    // to draft returns them to their boxes untouched.
    expect(screen.getByText('The menu closes')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Back to draft' })[0]);
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
    fireEvent.click(screen.getByRole('switch', { name: 'Finish with attachments in GitHub' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review ticket' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue in GitHub' }));
    await screen.findByText(/open in your browser with everything you wrote/);
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
    await screen.findByText(/open in your browser with everything you wrote/);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('starts a report from an error with the failure already in it', async () => {
    // Audit E-01: the popup took only open/close, so the failure you were reporting
    // was gone the moment you clicked Report and you described it from memory.
    Object.assign(window, { claude: { dev: { submitIssue: vi.fn() } } });
    render(<BugReportPopup open onClose={() => {}} context={{ surface: 'Settings → Permissions', error: 'EACCES: permission denied' }} />);
    // Offered as its own choice, saying where it came from — never typed into the
    // description for you (submit-ticket-1#ST-13).
    expect(screen.getByText(/Adds where it happened \(Settings → Permissions\)/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Permissions will not load' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'It will not load.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review ticket' }));
    // Shown for review BEFORE anything is sent — never attached unseen (R11).
    fireEvent.click(screen.getByRole('button', { name: /^The error you saw/ }));
    expect(screen.getByText(/EACCES: permission denied/)).toBeTruthy();
  });

  it('keeps Diagnose an assistant action, not a blank form', async () => {
    // Design review F11: five general errors across the app route "Diagnose with
    // the assistant" into this screen. Moving the AI call behind a disclosure would have
    // quietly turned all five into a button that opens an empty ticket.
    Object.assign(window, { claude: { dev: { submitIssue: vi.fn() } } });
    render(<BugReportPopup open onClose={() => {}} context={{ surface: 'Local model settings', diagnose: true }} />);
    expect(screen.getByRole('heading', { name: 'Sent with it' })).toBeTruthy();
    expect(screen.getByText(/Only this ticket and what you chose to include go to your assistant/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Improve wording with the assistant' })).toBeTruthy();
  });

  it('does not claim the browser opened when it did not', async () => {
    // UX review U1: this was `void openExternal(...)`, so the screen said "your
    // ticket is open in your browser" without ever learning whether one opened —
    // word for word the same sentence with every operation failing. The tester ran
    // it that way and got the success message.
    const submitIssue = vi.fn().mockResolvedValue({
      ok: false, needsBrowser: true, truncated: false, fallbackUrl: 'https://github.com/x/y/issues/new',
    });
    const openExternal = vi.fn().mockRejectedValue(new Error('No browser is available.'));
    Object.assign(window, { claude: { dev: { submitIssue }, shell: { openExternal } } });
    render(<BugReportPopup open onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'The menu closes' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Opening the menu closes the window.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review ticket' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit public ticket' }));
    await screen.findByText(/No browser is available\./);
    expect(screen.queryByText(/open in your browser with everything you wrote/)).toBeNull();
    // …and the report they wrote is still there.
    expect(screen.getByText('The menu closes')).toBeTruthy();
  });

  it('hands the ticket to Contribute, which starts the conversation with it, without sending it anywhere', async () => {
    // submit-ticket-3#ST3-Q1 "contribute": the ticket no longer downloads anything itself.
    // A finished copy is reused (no second download), the new conversation starts with the
    // ticket's words, nothing is filed, and the ticket comes back saying so.
    const submitIssue = vi.fn();
    const setupWorkspace = vi.fn();
    const setupStatus = vi.fn().mockResolvedValue({ state: 'ready', path: '/home/you/YouCoded/Development/w' });
    const openSessionIn = vi.fn().mockResolvedValue({ id: 's1' });
    Object.assign(window, { claude: { dev: { submitIssue, setupWorkspace, setupStatus, openSessionIn, clearSetupStatus: vi.fn().mockResolvedValue(undefined) } } });
    render(<BugReportPopup open onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'The menu closes' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Opening the menu closes the window.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review ticket' }));
    fireEvent.click(screen.getByRole('button', { name: 'Optional AI help' }));
    fireEvent.click(screen.getByRole('button', { name: 'Let your assistant try to fix it' }));
    // Contribute, in plain words, already knowing the copy is there.
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
    await screen.findByText(/working on a fix in a new conversation/);
    expect(openSessionIn).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/home/you/YouCoded/Development/w',
      initialInput: expect.stringContaining('Opening the menu closes the window.') as unknown as string,
    }));
    expect(setupWorkspace).not.toHaveBeenCalled();
    expect(submitIssue).not.toHaveBeenCalled();
  });

  it('says the download size and keeps the way back to the ticket', async () => {
    const setupStatus = vi.fn().mockResolvedValue({ state: 'idle' });
    Object.assign(window, { claude: { dev: { submitIssue: vi.fn(), setupWorkspace: vi.fn(), setupStatus, openSessionIn: vi.fn() } } });
    render(<BugReportPopup open onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'The menu closes' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Opening the menu closes the window.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review ticket' }));
    fireEvent.click(screen.getByRole('button', { name: 'Optional AI help' }));
    fireEvent.click(screen.getByRole('button', { name: 'Let your assistant try to fix it' }));
    expect(screen.getByText(/about 1 GB/)).toBeTruthy();
    expect(screen.getByText(/will work on “The menu closes”/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back to ticket' }));
    expect(screen.queryByText(/about 1 GB/)).toBeNull();
    expect(screen.getByText('The menu closes')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Submit public ticket' })).toBeTruthy();
  });

  it('rewrites the wording only when something actually rewrote it', async () => {
    // The other half of the disclosure, also untouched by any test until now.
    const summarizeIssue = vi.fn().mockResolvedValue({
      title: 'Menu closes the window', summary: 'Opening the menu closes the whole window.',
      flagged_strings: [], assisted: true,
    });
    Object.assign(window, { claude: { dev: { summarizeIssue, submitIssue: vi.fn() } } });
    render(<BugReportPopup open onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'menu bad' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'it closes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review ticket' }));
    fireEvent.click(screen.getByRole('button', { name: 'Optional AI help' }));
    fireEvent.click(screen.getByRole('button', { name: 'Improve wording with the assistant' }));
    // The review step shows the ticket as it will read, so the new words appear there.
    await screen.findByText('Menu closes the window');
  });

  it('leaves the wording alone, and says so, when nothing rewrote it', async () => {
    // assisted:false means the fields are the user's OWN words. Presenting them as a
    // result is the silent-no-op this feature exists to remove — and it is what
    // happens on a machine with no Claude Code CLI, i.e. a native session.
    const summarizeIssue = vi.fn().mockResolvedValue({
      title: 'menu bad', summary: 'it closes', flagged_strings: [],
      assisted: false, unavailable: 'No assistant is set up on this computer to rewrite it.',
    });
    Object.assign(window, { claude: { dev: { summarizeIssue, submitIssue: vi.fn() } } });
    render(<BugReportPopup open onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'menu bad' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'it closes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review ticket' }));
    fireEvent.click(screen.getByRole('button', { name: 'Optional AI help' }));
    fireEvent.click(screen.getByRole('button', { name: 'Improve wording with the assistant' }));
    await screen.findByText('No assistant is set up on this computer to rewrite it.');
    expect(screen.getByText('menu bad')).toBeTruthy();
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
    expect(screen.getByText('The menu closes')).toBeTruthy();
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
    await screen.findByText(/Submitted to GitHub/);
    expect(summarizeIssue).not.toHaveBeenCalled();
  });
});
