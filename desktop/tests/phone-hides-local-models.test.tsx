// @vitest-environment jsdom
// Pins 2026-11-01 findings #10/#11: a phone is never offered "Free, on this computer" (it can't run a model).
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SignInChoices } from '../src/renderer/components/first-run/SignInChoices';

afterEach(() => { delete (window as any).__PLATFORM__; });

describe('first-run provider choice on a phone', () => {
  it('offers the free local-model row on a computer', () => {
    (window as any).__PLATFORM__ = 'electron';
    render(<SignInChoices chatGpt onPick={() => {}} />);
    expect(screen.getByText('Free, on this computer')).toBeTruthy();
  });
  it('does not offer it in the Android app', () => {
    (window as any).__PLATFORM__ = 'android';
    render(<SignInChoices chatGpt onPick={() => {}} />);
    expect(screen.queryByText('Free, on this computer')).toBeNull();
    expect(screen.getByText('A plan you already pay for')).toBeTruthy();
  });
});
