// @vitest-environment jsdom
// The handoff state must name the TRUE reason it can't show a file. Before
// 2026-08-25 BinaryFallback said "Cannot preview this file type" even when the
// reason was size, and BinaryContent's over-size message told the user to "use
// Open externally" next to a component that rendered no button at all.
import { describe, it, expect, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { BinaryFallback } from '../src/renderer/components/artifact-views/BinaryFallback';
import { describeBytesError } from '../src/renderer/components/artifact-views/BinaryContent';

afterEach(cleanup);

describe('handoff copy', () => {
  it('names the format, not a generic refusal', () => {
    render(<BinaryFallback path="clip.mp4" absolutePath="/root/clip.mp4"
                           content={null} isEditable={false} contentInfo={null} />);
    // "yet" matters: every file type is clickable in chat now, so this panel is
    // reached deliberately and has to read as a gap, not a refusal.
    expect(screen.getByText(/can’t display \.mp4 files yet/i)).toBeInTheDocument();
  });

  it('offers the way out, under the same name the rest of the app uses', () => {
    // SessionDrawer's toolbar, CsvView and XlsxView all say "Open externally";
    // this button used to be the one place that said "Open in default app".
    render(<BinaryFallback path="clip.mp4" absolutePath="/root/clip.mp4"
                           content={null} isEditable={false} contentInfo={null} />);
    expect(screen.getByRole('button', { name: /open externally/i })).toBeInTheDocument();
  });

  it('states size only when size is the true reason', () => {
    render(<BinaryFallback path="raw.bin" absolutePath="/root/raw.bin"
                           content={null} isEditable={false}
                           contentInfo={{ sizeBytes: 214 * 1024 * 1024, binary: true }} />);
    expect(screen.getByText(/214\.0 MB — larger than YouCoded can display/)).toBeInTheDocument();
  });

  it('does not blame size for a file that is merely an unsupported format', () => {
    render(<BinaryFallback path="clip.mp4" absolutePath="/root/clip.mp4"
                           content={null} isEditable={false}
                           contentInfo={{ sizeBytes: 2.3 * 1024 * 1024, binary: true }} />);
    expect(screen.queryByText(/larger than/i)).toBeNull();
  });

  it('never points at a control that is not on screen', () => {
    expect(describeBytesError('too-large', 'image')).not.toMatch(/open externally/i);
  });
});
