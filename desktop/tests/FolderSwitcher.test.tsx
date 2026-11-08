// @vitest-environment jsdom
// Where the project picker's list opens: never wider than its window, and upward when there is no room below — the
// buddy's 320px chat put the 320px list 8px off its left edge, running off the bottom (buddy-rebuild-tryit#T-8).
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FolderSwitcher from '../src/renderer/components/FolderSwitcher';

const size = { w: window.innerWidth, h: window.innerHeight };
beforeEach(() => {
  (window as any).claude = {
    folders: { list: vi.fn(async () => [{ path: '/home/me/proj', nickname: 'proj', addedAt: 1, exists: true }]) },
    syncSpaces: { status: vi.fn(async () => null), onEvent: vi.fn(() => () => {}) },
  };
});
afterEach(() => {
  Object.defineProperty(window, 'innerWidth', { value: size.w, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: size.h, configurable: true });
  vi.restoreAllMocks();
});

async function openAt(win: { w: number; h: number }, trigger: { top: number; bottom: number; left: number; width: number }) {
  Object.defineProperty(window, 'innerWidth', { value: win.w, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: win.h, configurable: true });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ ...trigger, right: trigger.left + trigger.width, height: trigger.bottom - trigger.top, x: trigger.left, y: trigger.top, toJSON: () => ({}) } as DOMRect);
  render(<FolderSwitcher value="/home/me/proj" onChange={vi.fn()} />);
  await act(async () => {});
  await act(async () => { fireEvent.click(screen.getAllByRole('button')[0]); });
  return document.querySelector('.layer-surface.fixed') as HTMLElement;
}

describe('the project picker list', () => {
  it('in a window narrower than the list, fits inside it with its margins on both sides', async () => {
    const panel = await openAt({ w: 320, h: 900 }, { top: 100, bottom: 130, left: 20, width: 280 });
    expect(panel.style.left).toBe('8px');
    expect(panel.style.width).toBe('304px');
  });

  it('opens upward when there is little room below and more above', async () => {
    const panel = await openAt({ w: 320, h: 480 }, { top: 350, bottom: 380, left: 20, width: 280 });
    expect(panel.style.top).toBe('');
    expect(panel.style.bottom).toBe(`${480 - 350 + 4}px`);
  });

  it('in a wide window keeps its 320px list below the control, as before', async () => {
    const panel = await openAt({ w: 1200, h: 900 }, { top: 100, bottom: 130, left: 400, width: 280 });
    expect(panel.style.width).toBe('320px');
    expect(panel.style.top).toBe('134px');
  });
});
