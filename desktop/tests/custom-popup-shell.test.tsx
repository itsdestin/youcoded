// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { join } from 'node:path';
import { readSource } from './helpers/guard-scope';
import FileViewerOverlay from '../src/renderer/components/marketplace/FileViewerOverlay';

afterEach(cleanup);
const components = join(__dirname, '..', 'src', 'renderer', 'components');

// WHY: these two special overlays do not share Dialog's header/body markup.
// Pin each approved shell separately without applying styling to OverlayPanel.
describe('approved custom popup shells', () => {
  it('uses a single medium 16px file title and a contained 8% line', () => {
    const { container } = render(<FileViewerOverlay target={{ pluginId: 'demo', pluginName: 'Plugin name', kind: 'skill', name: 'sample' }} onClose={() => {}} />);
    const header = container.querySelector('[data-file-viewer-header]')!;
    expect(header).not.toBeNull();
    expect(header.textContent).not.toContain('Plugin name');
    expect(header.querySelector('h2')!.textContent).toBe('sample/SKILL.md');
    expect(header.querySelector('h2')!.className).toContain('text-base font-medium');
    expect(header.className).not.toContain('border-b');
    const css = readSource(join(components, 'marketplace', 'FileViewerOverlay.css'));
    expect(css).toMatch(/\[data-file-viewer-header\]::after\s*\{[^}]*left:\s*16px;[^}]*right:\s*16px;[^}]*var\(--edge\) 8%, var\(--edge\) 92%/);
  });

  it('tracks file scroll room and masks only edges with hidden content', () => {
    const { container } = render(<FileViewerOverlay target={{ pluginId: 'demo', pluginName: 'Plugin name', kind: 'skill', name: 'sample' }} onClose={() => {}} />);
    const body = container.querySelector('[data-file-viewer-scroll]') as HTMLElement;
    expect(body).not.toBeNull();
    expect(body.className).toContain('overflow-y-auto');
    expect(body.className).not.toContain('scroll-fade');
    Object.defineProperty(body, 'clientHeight', { configurable: true, value: 100 });
    Object.defineProperty(body, 'scrollHeight', { configurable: true, value: 300 });
    fireEvent.scroll(body);
    expect([body.dataset.fadeTop, body.dataset.fadeBottom]).toEqual(['false', 'true']);
    body.scrollTop = 200;
    fireEvent.scroll(body);
    expect([body.dataset.fadeTop, body.dataset.fadeBottom]).toEqual(['true', 'false']);
    const css = readSource(join(components, 'marketplace', 'FileViewerOverlay.css'));
    expect(css).toMatch(/\[data-file-viewer-scroll\]\[data-fade-bottom="true"\]\s*\{\s*--file-fade-bottom:\s*42px;/);
    expect(css).toContain('transparent 4%, transparent 96%');
    expect(css).toContain('mask-composite: add;');
  });

  it('keeps the compact Tags editor in its own shell and fades only while scrolling', () => {
    const source = readSource(join(components, 'tags', 'SessionTagsChip.tsx'));
    const css = readSource(join(components, 'tags', 'SessionTagsChip.css'));
    expect(source).toContain('useScrollFade<HTMLDivElement>()');
    expect(source).toContain('ref={scrollRef} data-tag-note-scroll className="px-4 py-3 overflow-y-auto"');
    expect(source).toContain('data-tag-note-header className="flex items-center justify-between px-4 py-3"');
    expect(source).toContain('text-base font-medium text-fg');
    expect(css).toMatch(/\[data-tag-note-header\]::after\s*\{[^}]*left:\s*16px;[^}]*right:\s*16px;[^}]*var\(--edge\) 8%, var\(--edge\) 92%/);
    expect(css).toMatch(/\[data-tag-note-scroll\]\[data-fade-bottom="true"\]\s*\{\s*--tag-fade-bottom:\s*42px;/);
    expect(css).toContain('transparent 4%, transparent 96%');
  });
});
