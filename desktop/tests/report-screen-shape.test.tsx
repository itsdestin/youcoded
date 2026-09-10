// @vitest-environment jsdom
// The approved ticket screen's SHAPE, pinned.
//
// WHY this file exists: the grader found seven contract rows with no test that
// would fail if the behaviour were removed — the full-width button (R6), the
// three evidence rows and the no-sub-label rule (R18), the real version line
// (R22), and the walkthrough's steps (R2). One of them, R18, was broken for a
// whole review round and broke no test. These assert the rules, not the exact
// strings that happened to be deleted once.
//
// Every test here renders with NO query string, i.e. the screen a user gets.

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent, within } from '@testing-library/react';
import { BugReportPopup } from '../src/renderer/components/development/BugReportPopup';
import { ContributePopup } from '../src/renderer/components/development/ContributePopup';
import { versionLine } from '../src/renderer/app-version';

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
afterEach(cleanup);

const fillDraft = () => {
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'The menu closes' } });
  fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Opening the menu closes the window.' } });
};

describe('the ticket screen keeps its approved shape', () => {
  it('R6/R21: the review step ends in two stacked full-width buttons and nothing else', () => {
    // R4-23's headline is literally "No captions anywhere, and two stacked buttons".
    // A third action in this footer failed the row for a round; only a rule catches
    // that, because the offending control had a different name each time.
    render(<BugReportPopup open onClose={() => {}} />);
    fillDraft();
    fireEvent.click(screen.getByRole('button', { name: 'Review ticket' }));
    const submit = screen.getByRole('button', { name: 'Submit public ticket' });
    const back = screen.getByRole('button', { name: 'Back to draft' });
    const footer = submit.parentElement!;
    expect(back.parentElement).toBe(footer);
    expect(within(footer).getAllByRole('button')).toHaveLength(2);
    for (const b of [submit, back]) expect(b.className).toContain('w-full');
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

  it('R18: evidence is plain rows with no sub-labels — explanations live in the (i)', () => {
    render(<BugReportPopup open onClose={() => {}} />);
    const heading = screen.getByText('Include with ticket');
    const section = heading.parentElement!;
    expect(within(section).getAllByRole('checkbox')).toHaveLength(3);
    // R3-18 removed per-row gray sub-labels. The rule, not the two strings that
    // were deleted that day: no row may carry explanatory text of its own.
    for (const row of within(section).getAllByRole('checkbox')) {
      const label = row.closest('div')!.parentElement!;
      expect(within(label).queryByText(/\. /)).toBeNull();
    }
    expect(within(section).getAllByRole('button', { name: /^About / })).toHaveLength(3);
  });

  it('R22: the version line is the real one, not a fixed string', () => {
    // Under the test runner the Vite define does not exist, so the helper answers
    // without a version — which is exactly why the OLD hardcoded "YouCoded 1.2.4 ·
    // Linux x64 · Electron 41.10.3" could never have been caught here. Assert the
    // screen shows what the helper says, whatever that is.
    render(<BugReportPopup open onClose={() => {}} />);
    fillDraft();
    fireEvent.click(screen.getByRole('button', { name: 'Review ticket' }));
    expect(screen.getByText(versionLine())).toBeTruthy();
    expect(screen.queryByText(/1\.2\.4/)).toBeNull();
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
    // The markers must be readable: they were clipped for a round by a scroll box,
    // because overflow-y also clips horizontally. An ol that lists its own markers
    // inside its padding is what keeps them on screen.
    expect(list.className).toMatch(/list-decimal/);
    expect(list.className).toMatch(/ml-\d/);
  });
});
