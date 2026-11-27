// @vitest-environment jsdom
// Pins 2026-11-01 findings #10/#11: a phone can't run a model, so it is never offered "Free, on this computer"; since
// 2026-11-25 it sees a greyed "Free on this phone · Coming soon" row that cannot be opened.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SignInChoices } from '../src/renderer/components/first-run/SignInChoices';

afterEach(() => { delete (window as any).__PLATFORM__; });

describe('first-run provider choice on a phone', () => {
  it('offers the free local-model row on a computer', () => {
    (window as any).__PLATFORM__ = 'electron';
    render(<SignInChoices chatGpt onPick={() => {}} />);
    expect(screen.getByText('Free, on this computer')).toBeTruthy();
  });
  it('in the Android app shows it as "Coming soon", and pressing it opens nothing', () => {
    (window as any).__PLATFORM__ = 'android';
    const onPick = vi.fn();
    render(<SignInChoices chatGpt onPick={onPick} />);
    expect(screen.queryByText('Free, on this computer')).toBeNull();
    const row = screen.getByText('Free on this phone').closest('[aria-disabled="true"]')!;
    expect(row).toBeTruthy();
    expect(screen.getByText('Coming soon')).toBeTruthy();
    fireEvent.click(row);
    expect(screen.queryByText('Use a local model')).toBeNull(); // no second page
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.getByText('A plan you already pay for')).toBeTruthy();
  });
});
