// @vitest-environment jsdom
// ImageView reads its own bytes, so this must stub BOTH the IPC read and
// URL.createObjectURL (jsdom ships neither). No existing test gets ImageView
// past the byte read — ActiveArtifactView.test.tsx asserts the
// 'unavailable' error state instead.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { ImageView } from '../src/renderer/components/artifact-views/ImageView';

const asked: string[] = [];
function installMatchMedia(matches: boolean) {
  asked.length = 0;
  (window as any).matchMedia = (q: string) => {
    asked.push(q);
    return {
      matches, media: q, onchange: null,
      addEventListener() {}, removeEventListener() {},
      addListener() {}, removeListener() {}, dispatchEvent: () => true,
    };
  };
}

beforeEach(() => {
  (URL as any).createObjectURL = vi.fn(() => 'blob:fake');
  (URL as any).revokeObjectURL = vi.fn();
  installMatchMedia(true);          // a real cursor by default
  (window as any).claude = {
    artifacts: { readBinary: vi.fn(async () => ({ ok: true, base64: 'AAAA' })) },
  };
});
afterEach(cleanup);

const props = {
  path: 'a.png',
  absolutePath: '/p/a.png',
  content: null,
  isEditable: false,
} as any;

describe('ImageView zoom', () => {
  it('shows the pill with the picture', async () => {
    render(<ImageView {...props} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /zoom in/i })).toBeTruthy());
  });

  it('does not magnify until the user turns the loupe on', async () => {
    const { container } = render(<ImageView {...props} />);
    await waitFor(() => screen.getByRole('button', { name: /magnif/i }));
    expect(container.querySelectorAll('canvas').length).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: /magnif/i }));
    expect(container.querySelectorAll('canvas').length).toBe(1);
  });

  it('hides the magnifier button where there is no cursor', async () => {
    installMatchMedia(false);        // coarse pointer / no hover
    render(<ImageView {...props} />);
    await waitFor(() => screen.getByRole('button', { name: /zoom in/i }));
    expect(screen.queryByRole('button', { name: /magnif/i })).toBeNull();
  });

  it('asks any-hover, not the primary-pointer query', async () => {
    // `(hover: hover)` asks about the PRIMARY pointer. On a touchscreen laptop
    // that can be the finger, which would hide the magnifier on a machine with a
    // trackpad right there. The question that matters is whether ANY device can
    // hover — a phone still answers no.
    render(<ImageView {...props} />);
    await waitFor(() => screen.getByRole('button', { name: /zoom in/i }));
    expect(asked.some((q) => q.includes('any-hover'))).toBe(true);
    expect(asked.some((q) => /\(hover:/.test(q))).toBe(false);
  });

  it('steps out from under the find bar when it opens', async () => {
    // Ctrl+F opens ContentFindBar in the SAME top-right corner (verified on a
    // real capture, not assumed) — the pill has to move or it sits under it.
    const { rerender } = render(<ImageView {...props} />);
    const pillOf = () => screen.getByRole('button', { name: /zoom in/i }).closest('[data-layer]')!;
    await waitFor(() => expect(pillOf().className).toContain('top-2'));

    rerender(<ImageView {...props} findBarOpen />);
    await waitFor(() => expect(pillOf().className).toContain('top-14'));
    expect(pillOf().className).not.toContain('top-2');
  });

  it('marks its root data-zoomable so the app pinch handler yields', async () => {
    const { container } = render(<ImageView {...props} />);
    await waitFor(() => screen.getByRole('button', { name: /zoom in/i }));
    expect(container.querySelector('[data-zoomable]')).toBeTruthy();
  });

  it('keeps zoom state inside the keyed child, so a file switch resets it', async () => {
    // BinaryContent keys its child by absolutePath. State held in the OUTER
    // component would survive a file switch and carry a stale zoom across.
    const { rerender } = render(<ImageView {...props} />);
    await waitFor(() => screen.getByRole('button', { name: /magnif/i }));
    fireEvent.click(screen.getByRole('button', { name: /magnif/i }));
    expect(screen.getByRole('button', { name: /magnif/i }).getAttribute('aria-pressed')).toBe('true');

    rerender(<ImageView {...props} path="b.png" absolutePath="/p/b.png" />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /magnif/i }).getAttribute('aria-pressed')).toBe('false'));
  });
});
