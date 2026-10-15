// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { join } from 'node:path';
import { readSource } from './helpers/guard-scope';
import FileViewerOverlay from '../src/renderer/components/marketplace/FileViewerOverlay';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const components = join(__dirname, '..', 'src', 'renderer', 'components');

// WHY: these two special overlays do not share Dialog's header/body markup.
// Pin each approved shell separately without applying styling to OverlayPanel.
describe('approved custom popup shells', () => {
  it('uses a single semibold 16px file title and a contained 8% line', () => {
    const { container } = render(<FileViewerOverlay target={{ pluginId: 'demo', pluginName: 'Plugin name', kind: 'skill', name: 'sample' }} onClose={() => {}} />);
    const header = container.querySelector('[data-file-viewer-header]')!;
    expect(header).not.toBeNull();
    expect(header.textContent).not.toContain('Plugin name');
    expect(header.querySelector('h2')!.textContent).toBe('sample/SKILL.md');
    // Semibold since 2026-10-13: the shared popup title (decisions "Popup and side-panel titles").
    expect(header.querySelector('h2')!.className).toContain('text-base font-semibold');
    expect(header.className).not.toContain('border-b');
    const css = readSource(join(components, 'marketplace', 'FileViewerOverlay.css'));
    expect(css).toMatch(/\[data-file-viewer-header\]::after\s*\{[^}]*left:\s*16px;[^}]*right:\s*16px;[^}]*var\(--edge-card\) 8%, var\(--edge-card\) 92%/);
  });

  it('fades the file body with the app\'s one fade, and feeds it on browsers without CSS scroll timelines', () => {
    // Stand in for a browser without scroll-driven animations (Firefox remote): only there does
    // useScrollFade set the data-fade-* flags the CSS fallback reads.
    vi.spyOn(CSS, 'supports').mockReturnValue(false);
    const { container } = render(<FileViewerOverlay target={{ pluginId: 'demo', pluginName: 'Plugin name', kind: 'skill', name: 'sample' }} onClose={() => {}} />);
    const body = container.querySelector('[data-file-viewer-scroll]') as HTMLElement;
    expect(body).not.toBeNull();
    expect(body.className).toContain('overflow-y-auto');
    expect(body.className).toContain('scroll-mask');
    Object.defineProperty(body, 'clientHeight', { configurable: true, value: 100 });
    Object.defineProperty(body, 'scrollHeight', { configurable: true, value: 300 });
    fireEvent.scroll(body);
    expect([body.dataset.fadeTop, body.dataset.fadeBottom]).toEqual(['false', 'true']);
    body.scrollTop = 200;
    fireEvent.scroll(body);
    expect([body.dataset.fadeTop, body.dataset.fadeBottom]).toEqual(['true', 'false']);
    const css = readSource(join(components, 'marketplace', 'FileViewerOverlay.css'));
    // No private copy of the look (it had an unfaded 4% side strip) — scroll-mask.css owns it.
    expect(css).not.toMatch(/mask-image/);
  });

  // The Tags & note popup gave up its own shell (pick-menus-15, 2026-10-04): it is the
  // shared Dialog now, so its header, ✕ and scroll come from there, not a private copy.
  it('draws the Tags & note popup in the shared Dialog, not a custom shell', () => {
    const source = readSource(join(components, 'tags', 'SessionTagsChip.tsx'));
    expect(source).toContain('<Dialog screen="chat/tags"');
    expect(source).not.toContain('SessionTagsChip.css');
    expect(source).not.toContain('data-tag-note-scroll');
  });
});
