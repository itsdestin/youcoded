// The Write card's "New file" chip (small-fixes-1). WHY: it showed on every Write, including
// one that replaced an existing file. The chip now follows what the tool's own result says —
// both runtimes' wordings — and shows nothing when the result does not say.
import { describe, it, expect } from 'vitest';
import { writeOutcome } from '../src/renderer/components/tool-views/ToolBody';

describe('writeOutcome', () => {
  it('reads a new file from Claude Code and from the native Write tool', () => {
    expect(writeOutcome('File created successfully at: /tmp/a.txt (file state is current in your context — no need to Read it back)')).toBe('created');
    expect(writeOutcome('Created notes/a.md (12 chars). This counts as having Read it — you can Edit it now without reading it first.')).toBe('created');
  });

  it('reads a replaced file from both', () => {
    expect(writeOutcome('The file /home/you/ROADMAP.md has been updated successfully. (file state is current in your context — no n')).toBe('replaced');
    expect(writeOutcome("The file /w/x.ts has been updated. Here's the result of running `cat -n` on a snippet:\n 1→a")).toBe('replaced');
    expect(writeOutcome('Overwrote notes/a.md (40 chars). This counts as having Read it.')).toBe('replaced');
  });

  it('claims nothing when the result does not say', () => {
    expect(writeOutcome(undefined)).toBeNull();
    expect(writeOutcome('')).toBeNull();
    expect(writeOutcome('Write rejected: notes/a.md already exists and you have not Read it')).toBeNull();
  });
});
