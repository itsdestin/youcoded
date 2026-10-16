import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { readSource } from './helpers/guard-scope';

const root = join(__dirname, '..', 'src', 'renderer', 'dev', 'workbench');

// WHY: comparison panes must render the shipping components, not a painted
// imitation. Their dev-only selectors may propose styles but not alter others.
describe('special popup review panes', () => {
  it('mounts the real file viewer and tag editor in their candidate panes', () => {
    const source = readSource(join(root, 'mockups', 'CustomPopupTaperDemo.tsx'));
    expect(source).toContain('import FileViewerOverlay from');
    expect(source).toContain('import { SessionTagsChip } from');
    expect(source).toContain('<FileViewerOverlay');
    expect(source).toContain('<SessionTagsChip');
  });

  it('restores the pre-change header and bare body only in Today panes', () => {
    const css = readSource(join(root, 'mockups', 'CustomPopupTaperDemo.css'));
    expect(css).toMatch(/\.file-taper-demo\[data-variant='today'\][^}]*\[data-file-viewer-header\]::before\s*\{[^}]*content:\s*'Sample Plugin · Skill'/);
    expect(css).toMatch(/\.file-taper-demo\[data-variant='today'\][^}]*\[data-file-viewer-header\]::after\s*\{\s*display:\s*none/);
    expect(css).toMatch(/\.file-taper-demo\[data-variant='today'\][^}]*\[data-file-viewer-scroll\]\s*\{\s*mask-image:\s*none/);
    expect(css).toMatch(/\.tag-taper-demo\[data-variant='today'\][^}]*\[data-tag-note-header\] h2\s*\{[^}]*font-size:\s*14px;[^}]*font-weight:\s*700/);
    expect(css).toMatch(/\.tag-taper-demo\[data-variant='today'\][^}]*\[data-tag-note-scroll\]\s*\{\s*mask-image:\s*none/);
  });
});
