// @vitest-environment jsdom
// Destin, 2026-09-11 phone pass: "the project selector for new sessions isn't listing my
// projects?" … "okay all of my projects just randomly popped back in". The picker loaded its
// list once on mount and swallowed a failure, so one request lost while the phone slept left
// it empty — indistinguishable from having no projects — until something remounted it.
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FolderSwitcher from '../src/renderer/components/FolderSwitcher';
import { REMOTE_RECONNECTED_EVENT } from '../src/renderer/remote-events';

const folders = [{ path: '/home/me/proj', nickname: 'proj', addedAt: 1, exists: true }];
let list: ReturnType<typeof vi.fn>;

beforeEach(() => {
  list = vi.fn();
  (window as any).claude = {
    folders: { list },
    syncSpaces: { status: vi.fn(async () => null), onEvent: vi.fn(() => () => {}) },
  };
});

async function mount(value = '/home/me/proj') {
  render(<FolderSwitcher value={value} onChange={vi.fn()} />);
  await act(async () => {});
}
const openList = async () => { await act(async () => { fireEvent.click(screen.getAllByRole('button')[0]); }); };

describe('the project picker never stays silently empty', () => {
  it('a list that could not load says so and offers Retry, which loads it', async () => {
    list.mockRejectedValue(new Error('Request folders:list timed out'));
    await mount();
    await openList();
    expect(screen.getByText("Couldn't load your projects.")).toBeTruthy();
    list.mockResolvedValue(folders);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(screen.queryByText("Couldn't load your projects.")).toBeNull();
    expect(screen.getAllByText('proj').length).toBeGreaterThan(0);
  });

  it('opening the list asks again, so it is current without a remount', async () => {
    list.mockResolvedValueOnce([]).mockResolvedValue(folders);
    await mount('');
    await openList();
    expect(list).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText('proj').length).toBeGreaterThan(0);
  });

  it('a remote reconnect asks again', async () => {
    list.mockRejectedValueOnce(new Error('lost')).mockResolvedValue(folders);
    await mount();
    expect(list).toHaveBeenCalledTimes(1);
    await act(async () => { window.dispatchEvent(new Event(REMOTE_RECONNECTED_EVENT)); });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('a failed re-read keeps the list already shown, with no error over it', async () => {
    list.mockResolvedValueOnce(folders).mockRejectedValue(new Error('lost'));
    await mount();
    await openList();
    expect(screen.getAllByText('proj').length).toBeGreaterThan(0);
    expect(screen.queryByText("Couldn't load your projects.")).toBeNull();
  });
});
