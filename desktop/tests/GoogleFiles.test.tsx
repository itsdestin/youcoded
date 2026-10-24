// @vitest-environment jsdom
import React, { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { GoogleFilePicker, GoogleSaveReview } from '../src/renderer/components/google-files/GoogleFiles';
import type { GoogleFile } from '../src/renderer/components/google-files/google-files-model';
import { GoogleFilesProvider } from '../src/renderer/components/google-files/google-files-context';
import InputBar from '../src/renderer/components/InputBar';
import { ChatProvider } from '../src/renderer/state/chat-context';
import { SkillProvider } from '../src/renderer/state/skill-context';

const accounts = ['alex@example.com', 'alex@studio.example'];
const files: GoogleFile[] = [
  { id: 'doc', name: 'Launch brief', kind: 'Doc', account: accounts[0] },
  { id: 'sheet', name: 'Budget', kind: 'Sheet', account: accounts[0] },
  { id: 'slides', name: 'Pitch deck', kind: 'Slides', account: accounts[1] },
];
beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} unobserve() {} });
});
function PickerHarness({ onAdd = vi.fn() }: { onAdd?: (files: GoogleFile[]) => void }) {
  const [open, setOpen] = useState(true);
  return <><button onClick={() => setOpen(true)}>Reopen</button>{open && <GoogleFilePicker accounts={accounts} files={files} onAdd={onAdd} onClose={() => setOpen(false)} onPick={async () => []} />}</>;
}
describe('Google composer entry', () => {
  it('opens the upward attachment menu from the real paperclip and reaches Google selection', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
    (window as any).claude = {
      native: { supported: true, send: vi.fn() }, session: { sendInput: vi.fn() },
      dialog: { openFile: vi.fn(async () => []) },
      skills: { list: vi.fn(async () => []), getFavorites: vi.fn(async () => []), getChips: vi.fn(async () => []), getCuratedDefaults: vi.fn(async () => []) },
    };
    const adapter = { accounts, files, changes: 'Update the introduction.', connect: async () => accounts,
      pick: async () => [], save: async () => {}, open: async () => {} };
    render(<GoogleFilesProvider adapter={adapter}><ChatProvider><SkillProvider><InputBar sessionId="google-test" provider="native" /></SkillProvider></ChatProvider></GoogleFilesProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Attach file' }));
    const menu = screen.getByRole('menu', { name: 'Attach files' });
    expect(menu.className).toContain('bottom-full');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Google Drive' }));
    expect(screen.getByRole('dialog', { name: /Attach from Google Drive/ })).toBeTruthy();
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Attach file' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Local file' }));
    expect(window.claude.dialog.openFile).toHaveBeenCalledOnce();
    await act(async () => {});
  });
});

describe('Google file picker', () => {
  it('prioritizes sign-in without account, search, list or Add controls when signed out', async () => {
    const connect = vi.fn(async () => {});
    render(<GoogleFilePicker accounts={[]} files={[]} onAdd={vi.fn()} onClose={vi.fn()} onPick={vi.fn()} onReconnect={connect} />);
    expect(screen.queryByRole('button', { name: 'Google account' })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Choose files from Google Drive' })).toBeNull();
    const signIn = screen.getByRole('button', { name: 'Sign in with Google' });
    expect(signIn.className).toContain('w-full');
    fireEvent.click(signIn);
    await act(async () => {});
    expect(connect).toHaveBeenCalledWith(expect.any(AbortSignal));
  });
  it('offers Drive selection without empty search or a redundant single-account selector', async () => {
    const pick = vi.fn(async () => []);
    render(<GoogleFilePicker accounts={[accounts[0]]} files={[]} onAdd={vi.fn()} onClose={vi.fn()} onPick={pick} />);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Google account' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Choose files from Google Drive' }));
    await act(async () => {});
    expect(pick).toHaveBeenCalledWith(accounts[0], expect.any(AbortSignal));
  });
  it('discards tentative selection on cancel and never leaks files across accounts', () => {
    const onAdd = vi.fn();
    render(<PickerHarness onAdd={onAdd} />);
    expect(screen.queryByText('Pitch deck')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Launch brief' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByText('Reopen'));
    expect(screen.getByRole('checkbox', { name: 'Launch brief' }).getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Google account' }));
    fireEvent.click(screen.getByRole('option', { name: accounts[1] }));
    expect(screen.queryByText('Launch brief')).toBeNull();
    expect(screen.getByText('Pitch deck')).toBeTruthy();
  });
  it('Add commits explicitly selected files and closes the actual dialog', () => {
    const onAdd = vi.fn();
    render(<PickerHarness onAdd={onAdd} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Budget' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onAdd).toHaveBeenCalledWith([files[1]]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('rejects unrelated accounts returned by a handoff and keeps the return tentative until Add', async () => {
    const onAdd = vi.fn();
    render(<GoogleFilePicker accounts={accounts} files={[]} onClose={vi.fn()} onAdd={onAdd} onPick={async () => files} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add from Google Drive' }));
    await act(async () => {});
    expect(screen.queryByText('Pitch deck')).toBeNull();
    expect(onAdd).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onAdd).toHaveBeenCalledWith([files[0], files[1]]);
  });
  it('aborts a cancelled external handoff and ignores a late return', async () => {
    let complete!: (files: GoogleFile[]) => void;
    let signal!: AbortSignal;
    const onAdd = vi.fn();
    const onClose = vi.fn();
    render(<GoogleFilePicker accounts={accounts} files={[]} onClose={onClose} onAdd={onAdd} onPick={(_account, requestSignal) => { signal = requestSignal; return new Promise((resolve) => { complete = resolve; }); }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add from Google Drive' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close Attach from Google Drive' }));
    expect(signal.aborted).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
    await act(async () => { complete(files); });
    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.queryByText('Launch brief')).toBeNull();
  });
  it('draws at most one 50-row chunk from 1000 saved files', () => {
    const many = Array.from({ length: 1000 }, (_, i) => ({ ...files[0], id: `doc-${i}`, name: `Brief ${i}` }));
    render(<GoogleFilePicker accounts={accounts} files={many} onAdd={vi.fn()} onClose={vi.fn()} onPick={async () => []} />);
    expect(screen.getAllByRole('checkbox')).toHaveLength(50);
  });
});
describe('Google save review', () => {
  it('saves the original by default, then opens the saved file externally through the adapter', async () => {
    const onSave = vi.fn(async () => files[0]);
    const onOpen = vi.fn(async () => {});
    render(<GoogleSaveReview file={files[0]} changes="Updated the introduction." onSave={onSave} onClose={vi.fn()} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await act(async () => {});
    expect(onSave).toHaveBeenCalledWith({ fileId: 'doc', account: accounts[0], mode: 'original' });
    fireEvent.click(screen.getByRole('button', { name: 'Open in Google' }));
    await act(async () => {});
    expect(onOpen).toHaveBeenCalledWith(files[0]);
    expect(screen.getByText('Opening in your usual browser.')).toBeTruthy();
  });
  it('cancel discards a copy choice without saving', () => {
    const onSave = vi.fn(async () => {});
    const onClose = vi.fn();
    const { unmount } = render(<GoogleSaveReview file={files[0]} changes="Updated the introduction." onSave={onSave} onClose={onClose} onOpen={vi.fn(async () => {})} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save as' }));
    fireEvent.click(screen.getByRole('option', { name: 'New copy' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();
    unmount();
    render(<GoogleSaveReview file={files[0]} changes="Updated the introduction." onSave={onSave} onClose={onClose} onOpen={vi.fn(async () => {})} />);
    expect(screen.getByRole('button', { name: 'Save as' }).textContent).toContain('Original file');
  });
  it('defaults to original, offers copy, and keeps the file account as the target', async () => {
    const copy = { ...files[0], id: 'copy', name: 'Launch brief (copy)' };
    const onSave = vi.fn(async () => copy);
    const onOpen = vi.fn(async () => {});
    render(<GoogleSaveReview file={files[0]} changes="Updated the introduction." onSave={onSave} onClose={vi.fn()} onOpen={onOpen} />);
    expect(screen.getByRole('button', { name: 'Save as' }).textContent).toContain('Original file');
    fireEvent.click(screen.getByRole('button', { name: 'Save as' }));
    fireEvent.click(screen.getByRole('option', { name: 'New copy' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith({ fileId: 'doc', account: accounts[0], mode: 'copy' });
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Open in Google' }));
    await act(async () => {});
    expect(onOpen).toHaveBeenCalledWith(copy);
  });
  it('does not offer copying a file when its capability forbids it', () => {
    render(<GoogleSaveReview file={{ ...files[0], canCopy: false }} changes="Updated the introduction." onSave={vi.fn(async () => {})} onClose={vi.fn()} onOpen={vi.fn(async () => {})} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save as' }));
    expect(screen.getByRole('option', { name: 'New copy' }).getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(screen.getByRole('option', { name: 'New copy' }));
    expect(screen.getByRole('button', { name: 'Save as' }).textContent).toContain('Original file');
  });
});
