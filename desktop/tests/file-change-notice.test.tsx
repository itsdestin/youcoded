// @vitest-environment jsdom
/**
 * The backup warning's "first file change" home (backlog row 18, deck backup-warning-1):
 * ONE card carries the notice, only a live card (waiting for a Yes, or running) can claim
 * it, and Got it retires it for good on this install. Practice code until Destin picks a
 * home; this pins the behaviour the deck's picture promises.
 */
import React from 'react';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';

// jsdom here ships NO localStorage (first-time-warnings.test.ts has the same gap): a
// Map-backed one, so the real "seen" flag is exercised rather than mocked.
const store = new Map<string, string>();
for (const target of [globalThis, window]) {
  Object.defineProperty(target, 'localStorage', {
    configurable: true, writable: true,
    value: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, String(v)); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => { store.clear(); },
    },
  });
}

import { FileChangeNotice } from '../src/renderer/components/FileChangeNotice';
import { resetFileChangeNotice } from '../src/renderer/components/backup-note-practice';

beforeEach(() => { localStorage.clear(); resetFileChangeNotice(); });
afterEach(() => { cleanup(); });

describe('FileChangeNotice', () => {
  it('shows on the first live card only', () => {
    render(<><FileChangeNotice id="a" live /><FileChangeNotice id="b" live /></>);
    expect(screen.getAllByTestId('file-change-notice')).toHaveLength(1);
  });

  it('a finished card from an old conversation never claims it', () => {
    render(<FileChangeNotice id="old" live={false} />);
    expect(screen.queryByTestId('file-change-notice')).toBeNull();
  });

  it('Got it hides it and it never comes back on this install', () => {
    const { unmount } = render(<FileChangeNotice id="a" live />);
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(screen.queryByTestId('file-change-notice')).toBeNull();
    unmount();
    act(() => { resetFileChangeNotice(); });
    render(<FileChangeNotice id="c" live />);
    expect(screen.queryByTestId('file-change-notice')).toBeNull();
  });

  it('passes to the next live card when the one carrying it goes away unanswered', () => {
    const first = render(<FileChangeNotice id="a" live />);
    first.unmount();
    render(<FileChangeNotice id="b" live />);
    expect(screen.getByTestId('file-change-notice')).toBeTruthy();
  });
});
