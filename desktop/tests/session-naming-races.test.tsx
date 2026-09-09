// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import SessionRenameDialog from '../src/renderer/components/SessionRenameDialog';
import { useRenamedSessions } from '../src/renderer/components/assistant-settings/use-renamed-sessions';
vi.mock('../src/renderer/components/ui', () => ({
  Dialog: ({ children }: any) => <div>{children}</div>,
  Button: (props: any) => <button {...props} />,
  TextInput: (props: any) => <input {...props} />,
  LoadingState: () => <span>Loading</span>,
  ErrorState: ({ message, onRetry }: any) => <div>{message}<button onClick={onRetry}>Retry</button></div>,
}));
afterEach(cleanup);
it('keeps a manual name protected with no automatic-name reset action', async () => {
  window.claude = { sessionNaming: { title: vi.fn().mockResolvedValue({ title: 'My name', manual: true }) } } as any;
  render(<SessionRenameDialog id="manual" name="My name" onClose={() => {}} />);
  await screen.findByDisplayValue('My name');
  expect(screen.queryByRole('button', { name: 'Use automatic name' })).toBeNull();
  expect(screen.getByText('You named this session. Automatic naming won’t replace it.')).toBeTruthy();
  expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['Cancel', 'Save name']);
});
it('a saved rename tells the already-fetched lists, or the row keeps the old name', async () => {
  // Renaming a SAVED conversation touches no live session, so there is no
  // SESSION_RENAMED broadcast to ride and the Resume Browser only refetches on
  // open. Without this event the row shows the old name until it is reopened.
  const rename = vi.fn().mockResolvedValue(undefined);
  window.claude = { sessionNaming: {
    title: vi.fn().mockResolvedValue({ title: 'Old name', manual: false }), rename,
  } } as any;
  const seen: Array<{ id: string; title: string }> = [];
  const listener = (e: Event) => seen.push((e as CustomEvent).detail);
  window.addEventListener('youcoded:session-renamed', listener);
  try {
    render(<SessionRenameDialog id="saved-1" name="Old name" onClose={() => {}} />);
    const input = await screen.findByDisplayValue('Old name') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '  Biology revision  ' } });
    await act(async () => { screen.getByRole('button', { name: 'Save name' }).click(); });
    expect(rename).toHaveBeenCalledWith('saved-1', 'Biology revision');
    expect(seen).toEqual([{ id: 'saved-1', title: 'Biology revision' }]);
  } finally {
    window.removeEventListener('youcoded:session-renamed', listener);
  }
});

it('says nothing to the lists when the save was refused', async () => {
  const rename = vi.fn().mockRejectedValue(new Error('Storage is not available.'));
  window.claude = { sessionNaming: {
    title: vi.fn().mockResolvedValue({ title: 'Old name', manual: false }), rename,
  } } as any;
  const seen: unknown[] = [];
  const listener = (e: Event) => seen.push(e);
  window.addEventListener('youcoded:session-renamed', listener);
  try {
    render(<SessionRenameDialog id="saved-2" name="Old name" onClose={() => {}} />);
    await screen.findByDisplayValue('Old name');
    await act(async () => { screen.getByRole('button', { name: 'Save name' }).click(); });
    expect(seen).toEqual([]);
    expect(screen.getByText('Storage is not available.')).toBeTruthy();
  } finally {
    window.removeEventListener('youcoded:session-renamed', listener);
  }
});

it('ignores an old title response after dialog identity changes', async () => {
  let resolveOld!: (v: any) => void;
  window.claude = { sessionNaming: { title: vi.fn((id) => id === 'a' ? new Promise((r) => { resolveOld = r; }) : Promise.resolve({ title: 'B', manual: false })) } } as any;
  const view = render(<SessionRenameDialog id="a" name="A" onClose={() => {}} />);
  view.rerender(<SessionRenameDialog id="b" name="B" onClose={() => {}} />);
  await act(async () => {});
  await act(async () => { resolveOld({ title: 'Late A', manual: true }); });
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('B');
});
it('does not expose an old failed load retry on the next identity', async () => {
  let rejectOld!: (e: Error) => void;
  const title = vi.fn((id) => id === 'a' ? new Promise((_r, reject) => { rejectOld = reject; }) : Promise.resolve({ title: 'B', manual: false }));
  window.claude = { sessionNaming: { title } } as any;
  const view = render(<SessionRenameDialog id="a" name="A" onClose={() => {}} />);
  view.rerender(<SessionRenameDialog id="b" name="B" onClose={() => {}} />);
  await act(async () => { rejectOld(new Error('old failure')); });
  expect(screen.queryByText('Retry')).toBeNull();
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('B');
  expect(title.mock.calls.map(([id]) => id)).toEqual(['a', 'b']);
});
it('stops projecting a preview name when its source title advances', () => {
  window.claude = { sessionNaming: {} } as any;
  const { result, rerender } = renderHook(({ sources }) => useRenamedSessions(sources), { initialProps: { sources: { a: 'Opening' } } });
  act(() => window.dispatchEvent(new CustomEvent('youcoded:session-renamed', { detail: { id: 'a', title: 'Original restored' } })));
  expect(result.current.a).toBe('Original restored');
  rerender({ sources: { a: 'New automatic title' } });
  expect(result.current.a).toBeUndefined();
});
