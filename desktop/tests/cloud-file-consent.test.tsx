// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CloudFileConsent, cloudConsentTransition, cloudConsentSelect } from '../src/renderer/components/project-view/CloudFileConsent';

afterEach(cleanup);
const base = { phase: 'ask' as const, purpose: 'file' as const, file: 'report.pdf' as string | null };
const props = { folder: '/Documents/Research', provider: 'OneDrive' as const, onAction: vi.fn() };

describe('specific download consent', () => {
  it('names only the selected download with explicit choices and no stored permission', () => {
    render(<CloudFileConsent {...props} state={base} />);
    expect(screen.getByRole('dialog', { name: 'Download this file?' })).toBeInTheDocument();
    expect(screen.getByText('report.pdf')).toBeVisible();
    expect(screen.queryByText(/permission|restart|folder grant/i)).not.toBeInTheDocument();
    expect(screen.getByText('This file is stored only on OneDrive and needs to download before you can open it.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not now' }).className).toContain('px-3');
    expect(screen.getByRole('button', { name: 'Not now' }).className).toContain('border-edge-dim');
    expect(screen.getByRole('button', { name: 'Download and open' }).className).toContain('px-3');
    expect(screen.queryByText(/whole folder/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(props.onAction).toHaveBeenCalledWith('deny');
    fireEvent.click(screen.getByRole('button', { name: 'Download and open' }));
    expect(props.onAction).toHaveBeenCalledWith('allow');
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
  });
  it('keeps full long filenames in wrapping body beneath a short plural heading', () => {
    const file = 'Research/very-long-unbroken-project-instructions-filename-that-must-not-be-truncated.pdf';
    render(<CloudFileConsent {...props} state={{ ...base, file, additionalFiles: ['second.pdf'] }} />);
    expect(screen.getByRole('dialog', { name: 'Download these files?' })).toBeInTheDocument();
    const name = screen.getByText(file);
    expect(name).toBeVisible();
    expect(name).toHaveClass('break-all');
    expect(name).not.toHaveClass('truncate');
    expect(screen.getByText('second.pdf')).toBeVisible();
  });
  it('closing suppresses automatic opening until another explicit click reopens the pending wait', () => {
    const onAction = vi.fn();
    const state = { ...base, phase: 'waiting' as const };
    const { rerender } = render(<CloudFileConsent {...props} onAction={onAction} state={state} />);
    expect(screen.queryByRole('button', { name: 'Keep working' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Close/ }));
    expect(onAction).toHaveBeenCalledWith('suppress-auto-open');
    const dismissed = cloudConsentTransition(state, 'suppress-auto-open');
    expect(dismissed).toMatchObject({ phase: 'waiting', file: 'report.pdf', suppressAutoOpen: true });
    rerender(<CloudFileConsent {...props} state={{ ...dismissed }} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const reopened = cloudConsentSelect(dismissed, 'report.pdf');
    expect(reopened).toMatchObject({ phase: 'waiting', suppressAutoOpen: false });
    rerender(<CloudFileConsent {...props} state={reopened} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
  it('traps Tab and returns focus when the waiting popup is dismissed', () => {
    const opener = document.createElement('button');
    document.body.append(opener); opener.focus();
    const state = { ...base, phase: 'waiting' as const };
    const { rerender } = render(<CloudFileConsent {...props} state={state} />);
    const close = screen.getByRole('button', { name: /Close/ });
    expect(close).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(close).toHaveFocus();
    fireEvent.click(close);
    rerender(<CloudFileConsent {...props} state={cloudConsentTransition(state, 'suppress-auto-open')} />);
    expect(opener).toHaveFocus();
    opener.remove();
  });
  it('closes consent as Not now', () => {
    const onAction = vi.fn();
    render(<CloudFileConsent {...props} onAction={onAction} state={base} />);
    fireEvent.click(screen.getByRole('button', { name: /Close/ }));
    expect(onAction).toHaveBeenCalledWith('deny');
  });
  it('keeps instruction copy to two content lines with exact file names', () => {
    render(<CloudFileConsent {...props} state={{ ...base, purpose: 'instructions', file: 'CLAUDE.md', additionalFiles: ['rules.md'] }} />);
    expect(screen.getByText('This conversation requires project instructions stored only in your OneDrive.')).toBeInTheDocument();
    expect(screen.getByText(/CLAUDE.md, rules.md/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });
  it('dismisses a declined file operation without a permission-management control', () => {
    render(<CloudFileConsent {...props} state={{ ...base, phase: 'denied' }} />);
    expect(screen.queryByTestId('cloud-file-consent')).not.toBeInTheDocument();
  });
  it.each(['OneDrive', undefined] as const)('uses only known provider facts while waiting (%s)', (provider) => {
    render(<CloudFileConsent {...props} provider={provider} state={{ ...base, phase: 'waiting', file: 'report.pdf' }} />);
    expect(screen.getByText(provider ? 'Waiting for OneDrive' : 'Waiting for the file')).toBeInTheDocument();
    expect(screen.getByText(/report.pdf/)).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument();
    expect(screen.queryByText('/Documents/Research')).not.toBeInTheDocument();
    expect(screen.getByText('Downloading file. You may wait or leave this page.')).toBeInTheDocument();
  });
  it('keeps native startup pending when instructions are declined', () => {
    const denied = cloudConsentTransition({ ...base, purpose: 'instructions', file: 'CLAUDE.md' }, 'deny');
    render(<CloudFileConsent {...props} state={denied} />);
    expect(screen.getByText(/This conversation still needs its instructions/)).toBeInTheDocument();
    expect(denied.purpose).toBe('instructions');
  });
  it('describes the proposed conversation continuation without repeating startup jargon', () => {
    render(<CloudFileConsent {...props} state={{ phase: 'waiting', purpose: 'instructions', file: 'CLAUDE.md' }} />);
    expect(screen.getByText('Your conversation will start when its instructions are ready.')).toBeInTheDocument();
    expect(screen.queryByText(/Native assistant startup/)).not.toBeInTheDocument();
  });
  it('does not transfer a file approval to a separate instructions operation', () => {
    expect(cloudConsentSelect({ ...base, phase: 'waiting', file: 'report.pdf' }, 'CLAUDE.md', 'instructions'))
      .toEqual({ phase: 'ask', file: 'CLAUDE.md', purpose: 'instructions' });
  });
  it.each(['ask', 'denied'] as const)('passive browsing has no prompt (%s)', (phase) => {
    render(<CloudFileConsent {...props} state={{ ...base, phase, file: null }} />);
    expect(screen.queryByTestId('cloud-file-consent')).not.toBeInTheDocument();
  });
  it('unknown availability never asserts an online-only cause', () => {
    render(<CloudFileConsent {...props} provider={undefined} state={base} />);
    expect(screen.getByText('This file may need to download before YouCoded can open it.')).toBeInTheDocument();
    expect(screen.queryByText(/stored only on/)).not.toBeInTheDocument();
  });
  it('approval alone does not start a download, but an already selected operation waits', () => {
    expect(cloudConsentTransition({ ...base, file: null }, 'allow').phase).toBe('ask');
    expect(cloudConsentTransition({ ...base, file: 'report.pdf' }, 'allow').phase).toBe('waiting');
    expect(cloudConsentTransition({ ...base, phase: 'denied' }, 'review').phase).toBe('ask');
  });
});
