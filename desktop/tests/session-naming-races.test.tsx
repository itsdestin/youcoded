// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen, renderHook } from '@testing-library/react';
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
