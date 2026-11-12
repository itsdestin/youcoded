// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { rememberAttachmentPreview, attachmentPreviewFor, clearAttachmentPreviews } from './remote-attachment-previews';

afterEach(() => { clearAttachmentPreviews(); vi.restoreAllMocks(); });

// Card #194: the phone browser previews from its own copy, and holds only a few.
describe('remote attachment previews', () => {
  it('returns the browser copy for a remembered path and nothing for any other', () => {
    URL.createObjectURL = vi.fn(() => 'blob:mine'); URL.revokeObjectURL = vi.fn();
    rememberAttachmentPreview('/tmp/up/a.png', new Blob(['x']));
    expect(attachmentPreviewFor('/tmp/up/a.png')).toBe('blob:mine');
    expect(attachmentPreviewFor('/tmp/up/b.png')).toBeUndefined();
  });
  it('lets go of the oldest copies past twenty', () => {
    let n = 0; const revoke = vi.fn();
    URL.createObjectURL = vi.fn(() => `blob:${n++}`); URL.revokeObjectURL = revoke;
    for (let i = 0; i < 22; i++) rememberAttachmentPreview(`/p/${i}.png`, new Blob(['x']));
    expect(attachmentPreviewFor('/p/0.png')).toBeUndefined();
    expect(attachmentPreviewFor('/p/21.png')).toBe('blob:21');
    expect(revoke).toHaveBeenCalledTimes(2);
  });
});
