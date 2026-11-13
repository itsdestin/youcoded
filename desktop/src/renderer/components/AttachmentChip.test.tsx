// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { AttachmentChip } from './AttachmentChip';
import { rememberAttachmentPreview, clearAttachmentPreviews } from '../utils/remote-attachment-previews';

afterEach(() => { cleanup(); clearAttachmentPreviews(); });

// Card #194: a picture a phone browser picked previews from the browser's own copy; anything else keeps the old file:// address.
describe('AttachmentChip picture source', () => {
  it('uses the browser copy when the phone picked this picture', () => {
    URL.createObjectURL = vi.fn(() => 'blob:phone-copy'); URL.revokeObjectURL = vi.fn();
    rememberAttachmentPreview('/srv/uploads/cat.png', new Blob(['x'], { type: 'image/png' }));
    const { container } = render(<AttachmentChip path="/srv/uploads/cat.png" onRemove={() => {}} />);
    expect(container.querySelector('img')).toHaveAttribute('src', 'blob:phone-copy');
  });
  it('keeps the file address for a picture nobody remembered (desktop, Android app)', () => {
    const { container } = render(<AttachmentChip path="/home/me/dog.png" onRemove={() => {}} />);
    expect(container.querySelector('img')).toHaveAttribute('src', 'file:///home/me/dog.png');
  });
});
