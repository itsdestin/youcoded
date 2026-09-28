// "Save a copy…"'s file dialog: the overwrite question and the extension the copy is given.
import { describe, expect, it, vi } from 'vitest';
import { BrowserWindow, dialog } from 'electron';
import { pickCopyTarget, resolveCopyTarget } from '../../src/main/office/office-dialogs';

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
