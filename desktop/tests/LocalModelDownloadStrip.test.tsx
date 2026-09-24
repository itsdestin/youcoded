// @vitest-environment jsdom
// Perf B11 (2026-09-24): the setup-download strip sits in every chat's message
// box for the life of the app, and each read makes main do a blocking file
// read. It polls once a second ONLY while a setup download is showing; past
// setup (null) it reads once and goes quiet — including across re-renders.
import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LocalModelDownloadStrip, type SetupDownloadStatus } from '../src/renderer/components/LocalModelDownloadStrip';
import { OnScreenContext } from '../src/renderer/state/on-screen-context';

let answer: SetupDownloadStatus | null;
let read: ReturnType<typeof vi.fn>;
const downloading = (percent: number): SetupDownloadStatus => ({ state: 'downloading', modelLabel: 'Qwen', percent, minutesLeft: 3 });
const settle = async () => { await act(async () => {}); };
const seconds = async (n: number) => { for (let i = 0; i < n; i++) { act(() => { vi.advanceTimersByTime(1000); }); await settle(); } };
const strip = (onScreen = true, sessionId = 's1') => (
  <OnScreenContext.Provider value={onScreen}><LocalModelDownloadStrip sessionId={sessionId} /></OnScreenContext.Provider>
);

beforeEach(() => {
  vi.useFakeTimers();
  answer = null;
  read = vi.fn(async () => answer);
  (window as any).claude = { firstRun: { localDownload: read } };
});
afterEach(() => { vi.useRealTimers(); delete (window as any).claude; });

it('past setup: reads once, then never again — not per second, not per re-render', async () => {
  const view = render(strip()); await settle();
  expect(read).toHaveBeenCalledTimes(1);
  await seconds(5);
  for (let i = 0; i < 5; i++) { view.rerender(strip()); await settle(); } // e.g. keystrokes in the message box
  expect(read).toHaveBeenCalledTimes(1);
  expect(view.container.textContent).toBe('');
});

it('while a setup download is showing it polls every second, and stops once it finishes', async () => {
  answer = downloading(10);
  const view = render(strip()); await settle();
  expect(screen.getByText('Downloading Qwen')).toBeTruthy();
  await seconds(3);
  expect(read).toHaveBeenCalledTimes(4);
  answer = null; // main answers null once the download is done
  await seconds(1);
  expect(view.container.textContent).toBe('');
  // A few grace reads (a null can be a transient failure), then quiet for good.
  await seconds(5);
  const calls = read.mock.calls.length;
  expect(calls).toBeLessThanOrEqual(4 + 1 + 3);
  await seconds(5);
  expect(read).toHaveBeenCalledTimes(calls);
});

it('one failed read while a download shows does not hide it for good', async () => {
  answer = downloading(10);
  const view = render(strip()); await settle();
  answer = null; // main answers null when its own read throws
  await seconds(1);
  answer = downloading(12);
  await seconds(1);
  expect(view.container.textContent).toContain('Downloading Qwen');
});

it('a stopped download keeps polling so Resume is noticed', async () => {
  answer = { state: 'stopped', modelLabel: 'Qwen', percent: 40, minutesLeft: null };
  render(strip()); await settle();
  answer = downloading(41);
  await seconds(1);
  expect(screen.getByText('Downloading Qwen')).toBeTruthy();
});

it('coming back on screen re-reads once, so a quiet strip is not final', async () => {
  const view = render(strip(true)); await settle();
  view.rerender(strip(false)); await settle();
  answer = downloading(5);
  await seconds(2);
  expect(read).toHaveBeenCalledTimes(1); // off screen: idle
  view.rerender(strip(true)); await settle();
  expect(read).toHaveBeenCalledTimes(2);
  expect(screen.getByText('Downloading Qwen')).toBeTruthy();
  await seconds(1);
  expect(read).toHaveBeenCalledTimes(3); // polling again while it is showing
});
