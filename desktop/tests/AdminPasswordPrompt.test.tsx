// @vitest-environment jsdom
// desktop/tests/AdminPasswordPrompt.test.tsx
//
// Two review findings on the admin password card:
//   - UX review 2, U1: pressing Enter in the field did nothing — Confirm
//     visibly reacted (cleared the field) but Enter never reached submit().
//   - Code review, F4: the field-clearing effect keyed on `ask.triesLeft`
//     alone, so a brand-new ask (different requestId) carrying the SAME
//     triesLeft as the one just resolved left the typed password and the
//     show/hide toggle state in place instead of resetting.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { AdminPasswordPrompt } from '../src/renderer/components/permissions/AdminPasswordPrompt';
import type { PasswordAsk } from '../src/shared/types';

afterEach(cleanup);

function ask(over: Partial<PasswordAsk> = {}): PasswordAsk {
  return { requestId: 'req-1', command: 'apt update', ...over };
}

describe('AdminPasswordPrompt — Enter submits like Confirm', () => {
  it('fires onSubmit exactly once when Enter is pressed in a non-empty field', () => {
    const onSubmit = vi.fn();
    render(<AdminPasswordPrompt ask={ask()} onSubmit={onSubmit} />);
    const field = screen.getByLabelText('Your computer password');
    fireEvent.change(field, { target: { value: 'sekrit' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('sekrit');
  });

  it('does nothing on Enter while the field is empty — same guard as Confirm', () => {
    const onSubmit = vi.fn();
    render(<AdminPasswordPrompt ask={ask()} onSubmit={onSubmit} />);
    const field = screen.getByLabelText('Your computer password');
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('Shift+Enter does not submit (leaves room for the same convention as every other field)', () => {
    const onSubmit = vi.fn();
    render(<AdminPasswordPrompt ask={ask()} onSubmit={onSubmit} />);
    const field = screen.getByLabelText('Your computer password');
    fireEvent.change(field, { target: { value: 'sekrit' } });
    fireEvent.keyDown(field, { key: 'Enter', shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('clicking Confirm still works identically (both paths call the same submit)', () => {
    const onSubmit = vi.fn();
    render(<AdminPasswordPrompt ask={ask()} onSubmit={onSubmit} />);
    const field = screen.getByLabelText('Your computer password');
    fireEvent.change(field, { target: { value: 'sekrit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('sekrit');
  });
});

describe('AdminPasswordPrompt — the field resets for a genuinely new ask (F4)', () => {
  it('clears the typed value and hides the eye toggle when requestId changes, even at the SAME triesLeft', () => {
    const { rerender } = render(<AdminPasswordPrompt ask={ask({ requestId: 'req-1', triesLeft: undefined })} />);
    const field = () => screen.getByLabelText('Your computer password') as HTMLInputElement;
    fireEvent.change(field(), { target: { value: 'typed-for-first-ask' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(field().value).toBe('typed-for-first-ask');
    expect(field().type).toBe('text'); // shown

    // A DIFFERENT ask (new requestId) arrives with the SAME triesLeft
    // (undefined) — the old dependency array would not have re-run the
    // clearing effect for this transition at all.
    rerender(<AdminPasswordPrompt ask={ask({ requestId: 'req-2', triesLeft: undefined })} />);

    expect(field().value).toBe('');
    expect(field().type).toBe('password'); // eye reset to hidden
  });

  it('still clears on the existing triesLeft-changes-within-the-same-ask path (unchanged behaviour)', () => {
    const { rerender } = render(<AdminPasswordPrompt ask={ask({ requestId: 'req-1', triesLeft: undefined })} />);
    const field = () => screen.getByLabelText('Your computer password') as HTMLInputElement;
    fireEvent.change(field(), { target: { value: 'wrong-try' } });

    rerender(<AdminPasswordPrompt ask={ask({ requestId: 'req-1', triesLeft: 2 })} />);

    expect(field().value).toBe('');
  });
});
