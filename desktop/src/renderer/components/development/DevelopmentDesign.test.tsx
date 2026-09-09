// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BugReportPopup } from './BugReportPopup';
import { ContributePopup } from './ContributePopup';
import { DevelopmentPopup } from './DevelopmentPopup';

beforeEach(() => window.history.replaceState({}, '', '/?mode=workbench'));
afterEach(() => { cleanup(); window.history.replaceState({}, '', '/'); });
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
  it('never connects managed setup to the old installer', () => {
    const installWorkspace = vi.fn();
    Object.assign(window, { claude: { dev: { installWorkspace } } });
    render(<ContributePopup open onClose={() => {}} />);
    // WHY: the guard is that the legacy installer is never reached — not that the button looks
    // dead. Destin rejected the disabled/greyed treatment: the workbench must look like the app.
    fireEvent.click(screen.getByRole('button', { name: 'Set up development workspace' }));
    fireEvent.click(screen.getByRole('button', { name: 'How contributing works' }));
    expect(screen.getByText('Choose whether to propose it')).toBeTruthy();
    expect(installWorkspace).not.toHaveBeenCalled();
  });
});
