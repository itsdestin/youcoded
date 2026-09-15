// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import SpecialistModelUnavailable, {
  SPECIALIST_DEFAULTS_CHANGED_EVENT,
  SPECIALIST_SETTINGS_EVENT,
  AUTOMATIC_SPECIALIST_MODEL_COPY,
  parseSpecialistModelUnavailable,
} from './SpecialistModelUnavailable';

describe('SpecialistModelUnavailable', () => {
  it('keeps the approved automatic-selection copy exact', () => {
    expect(AUTOMATIC_SPECIALIST_MODEL_COPY).toBe('No Selection – Model will be chosen automatically');
  });

  it('recognizes only the structured safe-default refusal', () => {
    expect(parseSpecialistModelUnavailable('SPECIALIST_MODEL_UNAVAILABLE:frontier')).toBe('frontier');
    expect(parseSpecialistModelUnavailable('SPECIALIST_MODEL_UNAVAILABLE:budget')).toBe('budget');
    expect(parseSpecialistModelUnavailable('ordinary tool failure')).toBeNull();
  });

  it('does not restart a stale failure when Settings was opened elsewhere', () => {
    const send = vi.fn(async () => 'sent' as const);
    (window as any).claude = { native: { send } };
    render(
      <SpecialistModelUnavailable
        sessionId="session-1"
        tier="budget"
        agent="explorer"
        description="Survey the repository"
        prompt="Map the repository and report the key files."
        workDir="/repo"
      />,
    );

    window.dispatchEvent(new CustomEvent(SPECIALIST_DEFAULTS_CHANGED_EVENT, { detail: { tier: 'budget' } }));

    expect(send).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Choose specialist models' })).toBeTruthy();
  });

  it('only resumes the most recent card that opened specialist settings', () => {
    const send = vi.fn(async () => ({ status: 'sent' as const }));
    (window as any).claude = { native: { send } };
    render(
      <>
        <SpecialistModelUnavailable sessionId="session-1" tier="budget" agent="explorer" description="First" prompt="First complete specialist brief for this test." workDir="/repo" />
        <SpecialistModelUnavailable sessionId="session-1" tier="budget" agent="reviewer" description="Second" prompt="Second complete specialist brief for this test." workDir="/repo" />
      </>,
    );
    const buttons = screen.getAllByRole('button', { name: 'Choose specialist models' });
    fireEvent.click(buttons[0]);
    fireEvent.click(buttons[1]);

    window.dispatchEvent(new CustomEvent(SPECIALIST_DEFAULTS_CHANGED_EVENT, { detail: { tier: 'budget' } }));

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('session-1', expect.stringContaining('reviewer'));
  });

  it('keeps a recovery action when the visible retry turn cannot be sent', async () => {
    const send = vi.fn(async () => ({ status: 'failed' as const, reason: 'queue-full' as const }));
    (window as any).claude = { native: { send } };
    render(<SpecialistModelUnavailable sessionId="session-1" tier="budget" agent="explorer" description="Survey" prompt="Complete specialist brief for this retry test." workDir="/repo" />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose specialist models' }));

    window.dispatchEvent(new CustomEvent(SPECIALIST_DEFAULTS_CHANGED_EVENT, { detail: { tier: 'budget' } }));

    expect(await screen.findByRole('button', { name: 'Resume specialist' })).toBeTruthy();
    expect(screen.getByText(/couldn’t start the retry turn/i)).toBeTruthy();
  });

  it('keeps a rejected send outcome unknown so it cannot offer a duplicate retry', async () => {
    const send = vi.fn(async () => { throw new Error('transport timeout'); });
    (window as any).claude = { native: { send } };
    render(<SpecialistModelUnavailable sessionId="session-1" tier="budget" agent="explorer" description="Survey" prompt="Complete specialist brief for this unknown retry test." workDir="/repo" />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose specialist models' }));

    window.dispatchEvent(new CustomEvent(SPECIALIST_DEFAULTS_CHANGED_EVENT, { detail: { tier: 'budget' } }));

    expect(await screen.findByText('Couldn’t confirm the specialist retry.')).toBeTruthy();
    expect(screen.getByText(/may still have been accepted/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Resume specialist' })).toBeNull();
  });

  it('shows that an accepted retry is queued instead of claiming it is already resuming', async () => {
    const send = vi.fn(async () => ({ status: 'queued' as const, queueId: 'q-1' }));
    (window as any).claude = { native: { send } };
    render(<SpecialistModelUnavailable sessionId="session-1" tier="budget" agent="explorer" description="Survey" prompt="Complete specialist brief for this queued retry test." workDir="/repo" />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose specialist models' }));

    window.dispatchEvent(new CustomEvent(SPECIALIST_DEFAULTS_CHANGED_EVENT, { detail: { tier: 'budget' } }));

    expect(await screen.findByText('Specialist retry queued.')).toBeTruthy();
    expect(screen.queryByText('Resuming specialist…')).toBeNull();
  });

  it('opens specialist settings, then automatically retries the same hire after that tier is selected', async () => {
    const send = vi.fn(async () => ({ status: 'sent' as const }));
    (window as any).claude = { native: { send } };
    const opened = vi.fn();
    window.addEventListener(SPECIALIST_SETTINGS_EVENT, opened);

    render(
      <SpecialistModelUnavailable
        sessionId="session-1"
        tier="budget"
        agent="explorer"
        description="Survey the repository"
        prompt="Map the repository and report the key files."
        workDir="/repo"
      />,
    );

    expect(screen.getByText('A safe automatic model wasn’t available.')).toBeTruthy();
    expect(screen.getByText(/expensive conversation model/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Choose specialist models' }));
    expect(opened).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();

    window.dispatchEvent(new CustomEvent(SPECIALIST_DEFAULTS_CHANGED_EVENT, { detail: { tier: 'budget' } }));

    expect(send).toHaveBeenCalledWith('session-1', expect.stringContaining('Map the repository'));
    expect(send).toHaveBeenCalledWith('session-1', expect.stringContaining('budget'));
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    window.removeEventListener(SPECIALIST_SETTINGS_EVENT, opened);
  });
});
