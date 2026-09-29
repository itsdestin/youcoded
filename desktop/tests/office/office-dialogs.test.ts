// "Save a copy…"'s file dialog: the overwrite question and the extension the copy is given.
import { describe, expect, it, vi } from 'vitest';
import { BrowserWindow, dialog } from 'electron';
import { pickCopyTarget, pickEditorFiles, pickSaveTarget, resolveCopyTarget } from '../../src/main/office/office-dialogs';

describe('where a copy goes', () => {
  it('keeps a name the person typed with the right extension (the dialog confirmed any overwrite)', () => {
    expect(resolveCopyTarget('/d/memo copy.docx', 'docx', () => true)).toBe('/d/memo copy.docx');
  });

  it('adds the extension to a name typed without it', () => {
    expect(resolveCopyTarget('/d/memo copy', 'docx', () => false)).toBe('/d/memo copy.docx');
  });

  it('refuses to replace a file the person never saw named, and asks for another name', () => {
    expect(resolveCopyTarget('/d/memo', 'docx', (p) => p === '/d/memo.docx')).toEqual({
      refused: 'A file named "memo.docx" already exists there. Choose another name.',
    });
  });

  it('asks the system dialog to confirm overwriting, filtered to the same kind of file', async () => {
    // The shared electron mock's BrowserWindow is a bare constructor; give it the lookup.
    (BrowserWindow as unknown as { fromWebContents: () => null }).fromWebContents = () => null;
    vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: true, filePath: undefined } as never);
    await expect(pickCopyTarget({}, '/home/you/plan.docx')).resolves.toBeNull();
    const opts = vi.mocked(dialog.showSaveDialog).mock.calls.at(-1)!.at(-1) as { properties: string[]; filters: { extensions: string[] }[]; defaultPath: string };
    expect(opts.properties).toContain('showOverwriteConfirmation');
    expect(opts.filters[0].extensions).toEqual(['docx']);
    expect(opts.defaultPath.endsWith('plan (copy).docx')).toBe(true);
  });
});

describe('the file dialog the editor asks for (Insert → Picture)', () => {
  const lastOpts = () => vi.mocked(dialog.showOpenDialog).mock.calls.at(-1)!.at(-1) as { properties: string[]; filters: { name: string; extensions: string[] }[] };

  it('answers the chosen files, one or many, and nothing when cancelled', async () => {
    (BrowserWindow as unknown as { fromWebContents: () => null }).fromWebContents = () => null;
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: ['/p/a.png', '/p/b.jpg'] } as never);
    await expect(pickEditorFiles({}, { multiple: true, filters: [] })).resolves.toEqual(['/p/a.png', '/p/b.jpg']);
    expect(lastOpts().properties).toEqual(['openFile', 'multiSelections']);
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: ['/p/a.png'] } as never);
    await expect(pickEditorFiles({}, { multiple: false, filters: [] })).resolves.toEqual(['/p/a.png']);
    expect(lastOpts().properties).toEqual(['openFile']);
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: true, filePaths: [] } as never);
    await expect(pickEditorFiles({}, { multiple: false, filters: [] })).resolves.toBeNull();
  });

  it('passes the editor\'s filters on, keeping only well-formed names and extensions', async () => {
    (BrowserWindow as unknown as { fromWebContents: () => null }).fromWebContents = () => null;
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: true, filePaths: [] } as never);
    await pickEditorFiles({}, {
      multiple: false,
      filters: [
        { name: 'Images', extensions: ['png', 'JPG', '../x', 'a b', 7] },
        { name: 'All files', extensions: ['*'] },
        'junk',
        { name: 42, extensions: ['png'] },
      ],
    });
    expect(lastOpts().filters).toEqual([
      { name: 'Images', extensions: ['png', 'JPG'] },
      { name: 'All files', extensions: ['*'] },
    ]);
  });
});

// Save As / Download as / Export to PDF (finish plan Task 2).
describe('the save dialog the editor asks for', () => {
  const lastOpts = () => vi.mocked(dialog.showSaveDialog).mock.calls.at(-1)!.at(-1) as { properties: string[]; filters: { name: string; extensions: string[] }[]; defaultPath: string };
  const pdf = [{ name: 'PDF', extensions: ['pdf'] }];

  it("starts in the document's folder with its name in the first format, and confirms overwriting", async () => {
    (BrowserWindow as unknown as { fromWebContents: () => null }).fromWebContents = () => null;
    vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: true, filePath: undefined } as never);
    await expect(pickSaveTarget({}, { filters: pdf, folder: '/home/you/work', name: 'plan' })).resolves.toBeNull();
    expect(lastOpts().defaultPath).toBe('/home/you/work/plan.pdf');
    expect(lastOpts().filters).toEqual(pdf);
    expect(lastOpts().properties).toContain('showOverwriteConfirmation');
  });

  it("suggests a copy's name in the document's own format, never the open file itself", async () => {
    (BrowserWindow as unknown as { fromWebContents: () => null }).fromWebContents = () => null;
    vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: true, filePath: undefined } as never);
    await pickSaveTarget({}, { filters: [{ name: 'Word', extensions: ['docx'] }], folder: '/home/you/work', name: 'plan', ext: 'docx' });
    expect(lastOpts().defaultPath).toBe('/home/you/work/plan (copy).docx');
    vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: true, filePath: undefined } as never);
    await pickSaveTarget({}, { filters: pdf, folder: '/home/you/work', name: 'plan', ext: 'docx' });
    expect(lastOpts().defaultPath).toBe('/home/you/work/plan.pdf');
  });

  it("keeps a typed name in one of the offered formats, and adds the first format's extension otherwise", async () => {
    (BrowserWindow as unknown as { fromWebContents: () => null }).fromWebContents = () => null;
    const word = [{ name: 'Word', extensions: ['docx'] }, { name: 'PDF', extensions: ['pdf'] }];
    vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: false, filePath: '/tmp/none-such-dir/plan.PDF' } as never);
    await expect(pickSaveTarget({}, { filters: word, folder: '/d', name: 'plan' })).resolves.toBe('/tmp/none-such-dir/plan.PDF');
    vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: false, filePath: '/tmp/none-such-dir/plan' } as never);
    await expect(pickSaveTarget({}, { filters: word, folder: '/d', name: 'plan' })).resolves.toBe('/tmp/none-such-dir/plan.docx');
    vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: false, filePath: '/tmp/none-such-dir/plan.odt' } as never);
    await expect(pickSaveTarget({}, { filters: pdf, folder: '/d', name: 'plan' })).resolves.toBe('/tmp/none-such-dir/plan.odt.pdf');
  });

  it('shows nothing when the editor offered no usable format', async () => {
    vi.mocked(dialog.showSaveDialog).mockClear();
    await expect(pickSaveTarget({}, { filters: [{ name: 'All', extensions: ['*'] }], folder: '/d', name: 'plan' })).resolves.toBeNull();
    expect(dialog.showSaveDialog).not.toHaveBeenCalled();
  });
});
