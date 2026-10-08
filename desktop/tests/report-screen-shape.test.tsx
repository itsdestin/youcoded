// @vitest-environment jsdom
// The approved ticket screen's SHAPE, pinned.
//
// WHY this file exists: the grader found contract rows with no test that would
// fail if the behaviour were removed — the two stacked footer buttons (R21), AI
// help staying behind its disclosure (R17), the three evidence rows and the
// no-sub-label rule (R18), the real version line (R22), and the walkthrough's
// steps (R2). One of them, R18, was broken for a whole review round and broke no
// test. These assert the rules, not the exact strings that happened to be deleted
// once.
//
// NOT covered here, and said plainly rather than implied: R6 is the CONTRIBUTE
// screen's setup button, and nothing below measures it — an earlier version of
// this header claimed otherwise.
//
// Every test here renders with NO query string, i.e. the screen a user gets.

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent, within } from '@testing-library/react';
import { BugReportPopup } from '../src/renderer/components/development/BugReportPopup';
import { ContributePopup } from '../src/renderer/components/development/ContributePopup';
import { versionLine } from '../src/renderer/app-version';
import { NARROW_VIEWPORT_QUERY } from '../src/renderer/hooks/use-narrow-viewport';

beforeEach(() => {
  window.history.replaceState({}, '', '/');
  Object.assign(window, {
    claude: {
      dev: {
        submitIssue: vi.fn(), summarizeIssue: vi.fn(), logTail: vi.fn().mockResolvedValue(''),
        setupStatus: vi.fn().mockResolvedValue({ state: 'idle' }), setupWorkspace: vi.fn(),
        clearSetupStatus: vi.fn(), openSessionIn: vi.fn(),
      },
      shell: { openExternal: vi.fn() },
    },
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const fillDraft = () => {
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'The menu closes' } });
  fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Opening the menu closes the window.' } });
};

describe('the ticket screen keeps its approved shape', () => {
  it('R21: the review step ends in two buttons — side by side in this wide popup, Submit on the right', () => {
    // R21 ("Submit is the main button with Back to draft beneath it") predates the design
    // guide's button rule; the guide (decisions BP-1, BW-2) puts a pair side by side in a
    // wide popup, filled on the right, and stacks it only at phone width. The 600px ticket
    // popup is wide. Reopened on deck submit-ticket-1 (ST-6). A THIRD button is still a
    // failure here — that is what R21 was really guarding.
    render(<BugReportPopup open onClose={() => {}} />);
    fillDraft();
    fireEvent.click(screen.getByRole('button', { name: 'Review ticket' }));
    const submit = screen.getByRole('button', { name: 'Submit public ticket' });
    const back = screen.getByRole('button', { name: 'Back to draft' });
    const footer = submit.parentElement!;
    expect(back.parentElement).toBe(footer);
    expect(within(footer).getAllByRole('button')).toHaveLength(2);
    // Filled on the right: Back comes first in the row.
    expect(within(footer).getAllByRole('button')[1]).toBe(submit);
    expect(footer.className).toMatch(/justify-end/);
  });

  it('stacks the two review buttons at phone width, Submit on top, both full width', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === NARROW_VIEWPORT_QUERY, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
    render(<BugReportPopup open onClose={() => {}} />);
    fillDraft();
    fireEvent.click(screen.getByRole('button', { name: 'Review ticket' }));
    const submit = screen.getByRole('button', { name: 'Submit public ticket' });
    const footer = submit.parentElement!;
    expect(within(footer).getAllByRole('button')[0]).toBe(submit);
    for (const b of within(footer).getAllByRole('button')) expect(b.className).toContain('w-full');
  });

  it('R17: every AI action sits behind the disclosure, never in the footer', () => {
    render(<BugReportPopup open onClose={() => {}} />);
    fillDraft();
    fireEvent.click(screen.getByRole('button', { name: 'Review ticket' }));
    expect(screen.queryByRole('button', { name: /assistant/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Optional AI help' }));
    // Both of them: rewriting the wording, and handing the whole thing over.
    expect(screen.getByRole('button', { name: 'Improve wording with the assistant' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Let your assistant try to fix it' })).toBeTruthy();
  });

  it('each include choice says in its own row what ticking it adds — no (i) buttons', () => {
    // Replaces R18 ("explained by the (i) on its row"). Destin, submit-ticket-1#ST-1 "the
    // checkbox ux is still odd" and #ST-13 "should explain itself": the explanation is the
    // row's own hint now. Opened from Settings there is no error, so two choices only.
    render(<BugReportPopup open onClose={() => {}} />);
    const section = screen.getByText('Include with ticket').parentElement!;
    expect(within(section).getAllByRole('switch')).toHaveLength(2);
    expect(within(section).queryAllByRole('button', { name: /^About / })).toHaveLength(0);
    expect(within(section).getByText(/last 200 lines/)).toBeTruthy();
    expect(within(section).getByText(/attach them there/)).toBeTruthy();
  });

  it('R22: the version line is the real one, not a fixed string', () => {
    // Under the test runner the Vite define does not exist, so the helper answers
    // without a version — which is exactly why the OLD hardcoded "YouCoded 1.2.4 ·
    // Linux x64 · Electron 41.10.3" could never have been caught here. Assert the
    // screen shows what the helper says, whatever that is.
    render(<BugReportPopup open onClose={() => {}} />);
    fillDraft();
    fireEvent.click(screen.getByRole('button', { name: 'Review ticket' }));
    // Always listed now (submit-ticket-1#ST-Q1): the version goes with every ticket.
    expect(screen.getByText(new RegExp(`^${versionLine().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} — always sent`))).toBeTruthy();
    expect(screen.queryByText(/1\.2\.4/)).toBeNull();
  });
});

describe('a ticket opened from an error', () => {
  it('never pre-fills the description; offers the error as its own choice, saying what it adds', () => {
    // Destin, submit-ticket-1#ST-13: "it shouldn't fill text in the description, but the
    // error details checkbox should explain itself when it applies". Mounted first, then
    // opened with a context — the way every caller does it.
    const { rerender } = render(<BugReportPopup open={false} onClose={() => {}} />);
    rerender(<BugReportPopup open onClose={() => {}} context={{ surface: 'Office', error: 'EBUSY' }} />);
    expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe('');
    expect(screen.getByRole('switch', { name: 'Include error details' })).toBeTruthy();
    expect(screen.getByText(/Adds where it happened \(Office\) and the error message/)).toBeTruthy();
  });

  it('offers no error choice when opened from Settings', () => {
    render(<BugReportPopup open onClose={() => {}} />);
    expect(screen.queryByRole('switch', { name: 'Include error details' })).toBeNull();
  });

  it('sends the error details only while their box is ticked', async () => {
    const submitIssue = window.claude.dev.submitIssue as ReturnType<typeof vi.fn>;
    submitIssue.mockResolvedValue({ ok: true, url: 'u' });
    render(<BugReportPopup open onClose={() => {}} context={{ surface: 'Office', error: 'EBUSY' }} />);
    fillDraft();
    fireEvent.click(screen.getByRole('button', { name: 'Review ticket' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit public ticket' }));
    await vi.waitFor(() => expect(submitIssue).toHaveBeenCalledTimes(1));
    expect(submitIssue.mock.calls[0][0].description).toMatch(/This happened in Office\.\nEBUSY/);
    cleanup();
    render(<BugReportPopup open onClose={() => {}} context={{ surface: 'Office', error: 'EBUSY' }} />);
    fillDraft();
    fireEvent.click(screen.getByRole('switch', { name: 'Include error details' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review ticket' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit public ticket' }));
    await vi.waitFor(() => expect(submitIssue).toHaveBeenCalledTimes(2));
    expect(submitIssue.mock.calls[1][0].description).toBe('Opening the menu closes the window.');
  });

  it('opens Diagnose on the review step with AI help open, even when mounted earlier', () => {
    const { rerender } = render(<BugReportPopup open={false} onClose={() => {}} />);
    rerender(<BugReportPopup open onClose={() => {}} context={{ surface: 'Office', diagnose: true }} />);
    expect(screen.getByRole('button', { name: 'Improve wording with the assistant' })).toBeTruthy();
  });

});


describe('the review step shows the ticket as it will be sent', () => {
  it('shows the words read-only, with the kind, and edits only through Back to draft', () => {
    // WHY: the review step used to be the draft again — the same editable boxes, with the
    // Bug/Feature choice gone — so nothing said what was being reviewed.
    render(<BugReportPopup open onClose={() => {}} />);
    fillDraft();
    fireEvent.click(screen.getByRole('button', { name: 'Review ticket' }));
    expect(screen.queryByLabelText('Title')).toBeNull();
    expect(screen.getByText('The menu closes')).toBeTruthy();
    expect(screen.getByText('Bug')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Sent with it' })).toBeTruthy();
  });

  it('lists only the version when nothing else was chosen', () => {
    render(<BugReportPopup open onClose={() => {}} />);
    fillDraft();
    fireEvent.click(screen.getByRole('button', { name: 'Review ticket' }));
    // Only the always-sent version row; no folds.
    const card = screen.getByRole('heading', { name: 'Sent with it' }).parentElement!;
    expect(within(card).getByText('App version and system')).toBeTruthy();
    expect(within(card).queryAllByRole('button')).toHaveLength(0);
  });
});

describe('a failure says what failed, inside one notice with its own buttons', () => {
  const failSend = (error: string) => {
    (window.claude.dev.submitIssue as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, error, fallbackUrl: 'x' });
    render(<BugReportPopup open onClose={() => {}} />);
    fillDraft();
    fireEvent.click(screen.getByRole('button', { name: 'Review ticket' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit public ticket' }));
  };

  it('puts Try again and Back to draft inside the notice, in place of the send buttons', async () => {
    failSend('GitHub did not create the ticket (500).');
    const line = await screen.findByText(/GitHub did not create the ticket \(500\)\./);
    const box = line.closest('div.rounded-lg')!;
    expect(within(box as HTMLElement).getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(within(box as HTMLElement).getByRole('button', { name: 'Back to draft' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Submit public ticket' })).toBeNull();
  });

  it('names no network only when the computer reports none', async () => {
    vi.stubGlobal('navigator', { ...navigator, onLine: false });
    failSend('getaddrinfo ENOTFOUND api.github.com');
    expect(await screen.findByText(/isn.t connected to a network/)).toBeTruthy();
  });

  it('never says the ticket failed to send when the hand-over failed, and retries the hand-over', async () => {
    const dev = window.claude.dev as unknown as Record<string, ReturnType<typeof vi.fn>>;
    dev.setupWorkspace.mockResolvedValue({ ok: false, error: 'Could not reach github.com.' });
    render(<BugReportPopup open onClose={() => {}} />);
    fillDraft();
    fireEvent.click(screen.getByRole('button', { name: 'Review ticket' }));
    fireEvent.click(screen.getByRole('button', { name: 'Optional AI help' }));
    fireEvent.click(screen.getByRole('button', { name: 'Let your assistant try to fix it' }));
    await screen.findByText(/Could not reach github\.com\./);
    expect(screen.queryByText(/ticket wasn.t sent/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await vi.waitFor(() => expect(dev.setupWorkspace).toHaveBeenCalledTimes(2));
    expect(dev.submitIssue).not.toHaveBeenCalled();
  });
});

describe('the contribute walkthrough keeps its approved steps', () => {
  it('R2: all five steps, in order, each with its own explanation', () => {
    render(<ContributePopup open onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'How contributing works' }));
    const list = document.querySelector('#contribution-walkthrough ol')!;
    const steps = [...list.querySelectorAll('li')];
    expect(steps).toHaveLength(5);
    expect(steps.map(li => li.querySelector('strong')?.textContent)).toEqual([
      'Describe your idea', 'Review the design', 'Try an isolated preview',
      'Check the result', 'Choose whether to propose it',
    ]);
    for (const li of steps) expect(li.querySelector('p')?.textContent?.trim()).toBeTruthy();
    // The markers must be readable: they were clipped for a round by the scroll box,
    // because overflow-y also clips horizontally. Whether pixels are clipped is a
    // layout fact jsdom cannot see, so this pins the DECISION instead — numbered,
    // indented by margin, and specifically NOT `list-inside`, which is the fix that
    // regressed: it kept the markers but pulled every explanation out to the margin.
    // The first version of this assertion passed with list-inside in place.
    expect(list.className).toMatch(/list-decimal/);
    expect(list.className).toMatch(/\bml-\d/);
    expect(list.className).not.toMatch(/list-inside/);
  });
});

describe('a folded card opens inside itself', () => {
  it('shows AI help\'s actions inside the same box as its header row', () => {
    // Destin, submit-ticket-1#ST-3: "an expandable card should always contain expanded
    // content within itself, not open a new separate card below".
    render(<BugReportPopup open onClose={() => {}} />);
    fillDraft();
    fireEvent.click(screen.getByRole('button', { name: 'Review ticket' }));
    const header = screen.getByRole('button', { name: 'Optional AI help' });
    fireEvent.click(header);
    const rewrite = screen.getByRole('button', { name: 'Improve wording with the assistant' });
    // The box holding the header row also holds the opened actions.
    expect(header.parentElement!.contains(rewrite)).toBe(true);
  });
});

describe('while a ticket sends', () => {
  it('shows only the sending box under "Your ticket", then the summary when it is done', async () => {
    // Destin, submit-ticket-2#ST2-10: "bare sending your ticket box under your ticket
    // header, gets replaced with the submission summary when done".
    let finish: (v: unknown) => void = () => {};
    (window.claude.dev.submitIssue as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(r => { finish = r; }));
    render(<BugReportPopup open onClose={() => {}} />);
    fillDraft();
    fireEvent.click(screen.getByRole('button', { name: 'Review ticket' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit public ticket' }));
    expect(await screen.findByText(/Sending your ticket/)).toBeTruthy();
    expect(screen.getByText('Your ticket')).toBeTruthy();
    expect(screen.queryByText('The menu closes')).toBeNull();
    finish({ ok: true, url: 'u' });
    expect(await screen.findByText('The menu closes')).toBeTruthy();
    expect(screen.getByText('Submitted')).toBeTruthy();
  });
});
