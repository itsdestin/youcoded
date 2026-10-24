import { describe, expect, it } from 'vitest';
import { saveTarget, toggleGoogleFile, type GoogleFile } from '../src/renderer/components/google-files/google-files-model';

const file: GoogleFile = { id: 'doc-1', name: 'Launch brief', kind: 'Doc', account: 'alex@example.com' };

describe('Google file mock selection', () => {
  it('toggles only the explicitly selected file ids', () => {
    expect(toggleGoogleFile([], 'doc-1')).toEqual(['doc-1']);
    expect(toggleGoogleFile(['doc-1', 'sheet-1'], 'doc-1')).toEqual(['sheet-1']);
  });
  it('keeps the save target bound to the chosen file/account and defaults to original', () => {
    expect(saveTarget(file, 'alex@example.com', false)).toEqual({ fileId: 'doc-1', account: 'alex@example.com', mode: 'original' });
    expect(saveTarget(file, 'alex@studio.example', true)).toEqual({ fileId: 'doc-1', account: 'alex@example.com', mode: 'copy' });
    expect(saveTarget(file, 'alex@studio.example')).toEqual({ fileId: 'doc-1', account: 'alex@example.com', mode: 'original' });
  });
});
