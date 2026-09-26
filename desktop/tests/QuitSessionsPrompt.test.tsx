// @vitest-environment jsdom
// Welcome back — the in-app quit warning's dictated copy/layout (design §4,
// review 2 B-quit). Destin's words and layout are frozen (QuitSessionsPrompt.tsx's
// own header comment) — this pins the copy and the switch's default/behaviour,
// never the wording itself.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import QuitSessionsPrompt from '../src/renderer/components/QuitSessionsPrompt';

afterEach(cleanup);

describe('QuitSessionsPrompt', () => {
  it('shows Destin\'s dictated copy, with the session count filled in', () => {
    render(<QuitSessionsPrompt count={3} onCancel={() => {}} onConfirm={() => {}} />);
    expect(screen.getByText('You have 3 active sessions - proceed?')).toBeInTheDocument();
    expect(screen.getByText(
      'Closing this window will end your active sessions. Would you like an offer to resume these sessions the next time you launch YouCoded?',
    )).toBeInTheDocument();
  });

  it('singularizes the count for exactly one session', () => {
    render(<QuitSessionsPrompt count={1} onCancel={() => {}} onConfirm={() => {}} />);
    expect(screen.getByText('You have 1 active session - proceed?')).toBeInTheDocument();
  });

  it('"Resume on Next Launch?" starts OFF (design Q-default)', () => {
    render(<QuitSessionsPrompt count={2} onCancel={() => {}} onConfirm={() => {}} />);
    const toggle = screen.getByRole('switch', { name: 'Resume on Next Launch?' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('Close window passes the switch\'s value: off by default', () => {
    const onConfirm = vi.fn();
    render(<QuitSessionsPrompt count={2} onCancel={() => {}} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close window' }));
    expect(onConfirm).toHaveBeenCalledWith(false);
  });

  it('flipping the switch on and confirming passes reopen:true', () => {
    const onConfirm = vi.fn();
    render(<QuitSessionsPrompt count={2} onCancel={() => {}} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Resume on Next Launch?' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close window' }));
    expect(onConfirm).toHaveBeenCalledWith(true);
  });

  it('the ✕ cancels without confirming', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(<QuitSessionsPrompt count={2} onCancel={onCancel} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close Close window' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
