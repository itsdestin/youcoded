// @vitest-environment jsdom
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleLiveComposer } from '../src/renderer/components/google-files/GoogleLiveComposer';
import { GoogleFilesProvider } from '../src/renderer/components/google-files/google-files-context';

const file = { id: 'doc', accountId: 'account', account: 'person@example.com', name: 'My doc', kind: 'Doc' as const, canEdit: true, canCopy: true };
function setup() {
  const api: any = { attached: vi.fn(async () => [file]), attach: vi.fn(async () => [file]), detach: vi.fn(async () => {}),
    proposals: vi.fn(async () => [{ id: 'draft', sessionId: 'chat', file, edits: [{ kind: 'replaceText', find: 'old', replace: 'new' }], summary: 'Update wording', mode: 'original', createdAt: 1 }]),
    approve: vi.fn(async () => file), reject: vi.fn(async () => {}) };
  const adapter = { accounts: [file.account], files: [file], connect: async () => [file.account], pick: async () => [file], changes: '', save: async () => {}, open: vi.fn(async () => {}), bridge: api };
  render(<GoogleFilesProvider adapter={adapter}><GoogleLiveComposer sessionId="chat" picker={false} closePicker={() => {}} onAttached={() => {}} /></GoogleFilesProvider>);
  return { api };
}
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} unobserve() {} });
});
describe('live Google composer', () => {
  it('does not report a failed save when only the subsequent attachment refresh fails', async () => {
    const { api } = setup();
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Review Google changes' }));
    await act(async () => {});
    api.attached.mockRejectedValueOnce(new Error('refresh unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await act(async () => {});
    expect(screen.getByText('Your changes were saved to the original file.')).toBeTruthy();
    expect(api.approve).toHaveBeenCalledTimes(1);
  });
  it('loads real pending proposals and never approves before a user presses Save', async () => {
    const { api } = setup();
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Review Google changes' }));
    await act(async () => {});
    expect(screen.getByText(/old/)).toBeTruthy();
    expect(api.approve).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await act(async () => {});
    expect(api.approve).toHaveBeenCalledWith('chat', 'draft', 'original');
  });
});
