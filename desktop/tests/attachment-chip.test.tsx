// @vitest-environment jsdom
//
// Pins the composer's attachment card (components/AttachmentChip.tsx — design
// C, Destin 2026-08-27, ledger P-19): name strip + type glyph for every kind,
// a RENDERED markdown preview (a `##` heading becomes an <h2>, never literal
// `##` text — Destin's rule), a failed image load falling back to the glyph,
// the ✕ present without hover and keeping its accessible name, and the head
// read being capped at the shared default and cached per path.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, within, cleanup, fireEvent, act } from '@testing-library/react';
import { AttachmentChip, clearFileHeadCache } from '../src/renderer/components/AttachmentChip';
import { READ_HEAD_DEFAULT_BYTES } from '../src/shared/read-head';

const HEADS: Record<string, string> = {
  '/home/destin/Documents/design-notes.md': '## Design notes\n\nChips become **cards**.\n\n- one\n- two',
  '/home/destin/Documents/notes.txt': 'Call Sam about the venue\nOrder 40 chairs',
  '/home/destin/code/InputBar.ts': 'interface Attachment {\n  path: string;\n}',
};

const readHead = vi.fn(async (filePath: string) => {
  const text = HEADS[filePath];
  return text !== undefined ? { ok: true as const, text, truncated: false } : { ok: false as const, error: 'binary' };
});

beforeEach(() => {
  clearFileHeadCache();
  readHead.mockClear();
  (window as any).claude = { fs: { readHead } };
});
afterEach(() => {
  cleanup();
  delete (window as any).claude;
});

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe('AttachmentChip', () => {
  it('renders the name strip with a type glyph for every kind', async () => {
    const names = ['design-notes.md', 'notes.txt', 'invoice.pdf', 'budget.xlsx', 'demo.mp4', 'sensor-log.dat'];
    for (const name of names) {
      const path = `/home/destin/Documents/${name}`;
      const { container, unmount } = render(<AttachmentChip path={path} onRemove={() => {}} />);
      await flush();
      const chip = container.firstElementChild as HTMLElement;
      expect(chip.getAttribute('title')).toBe(name);
      expect(chip.getAttribute('data-file-kind')).toBeTruthy();
      // The strip: the visible name, next to an svg glyph.
      const strip = within(chip).getByText(name);
      expect(strip.parentElement?.querySelector('svg')).toBeTruthy();
      unmount();
    }
  });

  it('renders markdown — a ## heading becomes an h2, with no literal ## on screen', async () => {
    const { container } = render(<AttachmentChip path="/home/destin/Documents/design-notes.md" onRemove={() => {}} />);
    await flush();
    const preview = within(container).getByTestId('markdown-head-preview');
    const h2 = preview.querySelector('h2');
    expect(h2?.textContent).toBe('Design notes');
    expect(preview.querySelector('strong')?.textContent).toBe('cards');
    expect(preview.querySelectorAll('li').length).toBe(2);
    expect(preview.textContent).not.toContain('##');
    // Decorative and inert: not a tab stop, not clickable.
    expect(preview.getAttribute('aria-hidden')).toBe('true');
    expect((preview.firstElementChild as HTMLElement).hasAttribute('inert')).toBe(true);
    expect(within(container).queryByTestId('glyph-preview')).toBeNull();
  });

  it('renders plain text and code in a mono block', async () => {
    for (const path of ['/home/destin/Documents/notes.txt', '/home/destin/code/InputBar.ts']) {
      const { container, unmount } = render(<AttachmentChip path={path} onRemove={() => {}} />);
      await flush();
      const pre = within(container).getByTestId('mono-head-preview');
      expect(pre.tagName).toBe('PRE');
      expect(pre.textContent).toBe(HEADS[path]);
      unmount();
    }
  });

  it('shows the big glyph with the extension in caps for everything else, and never reads their head', async () => {
    const { container } = render(<AttachmentChip path="/home/destin/Documents/invoice.pdf" onRemove={() => {}} />);
    await flush();
    const glyph = within(container).getByTestId('glyph-preview');
    expect(glyph.textContent).toBe('pdf'); // CSS uppercases it; the DOM keeps the raw ext
    expect(glyph.querySelector('svg')).toBeTruthy();
    expect(readHead).not.toHaveBeenCalled();
  });

  it('falls back to the glyph when the head read fails (binary, refused, or unavailable)', async () => {
    const { container, unmount } = render(<AttachmentChip path="/home/destin/Documents/unknown.txt" onRemove={() => {}} />);
    await flush();
    expect(within(container).getByTestId('glyph-preview')).toBeTruthy();
    unmount();
    // No bridge at all (the mock-up test's environment): still the glyph, no crash.
    delete (window as any).claude;
    clearFileHeadCache();
    const r2 = render(<AttachmentChip path="/home/destin/Documents/notes.txt" onRemove={() => {}} />);
    await flush();
    expect(within(r2.container).getByTestId('glyph-preview')).toBeTruthy();
  });

  it('an image that fails to load falls back to the glyph, never a broken image', async () => {
    const { container } = render(<AttachmentChip path="/home/destin/Pictures/screenshot.png" onRemove={() => {}} />);
    const img = container.querySelector('img') as HTMLImageElement;
    expect(img).toBeTruthy();
    expect(img.getAttribute('src')).toBe('file:///home/destin/Pictures/screenshot.png');
    fireEvent.error(img);
    expect(container.querySelector('img')).toBeNull();
    const glyph = within(container).getByTestId('glyph-preview');
    expect(glyph.textContent).toBe('png');
    expect(readHead).not.toHaveBeenCalled();
  });

  it('honours an imageSrc override (the mock-up page and tests)', () => {
    const { container } = render(
      <AttachmentChip path="/x/y.png" imageSrc="data:image/gif;base64,R0lGOD" onRemove={() => {}} />,
    );
    expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/gif;base64,R0lGOD');
  });

  it('the ✕ is present without hover, keeps its accessible name, and removes', () => {
    const onRemove = vi.fn();
    render(<AttachmentChip path="/home/destin/Documents/notes.txt" onRemove={onRemove} />);
    const btn = screen.getByLabelText('Remove notes.txt');
    expect(btn.className).not.toMatch(/opacity-0|group-hover/);
    fireEvent.click(btn);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('reads the head once per path, capped at the shared default, and caches it across re-renders and re-mounts', async () => {
    const path = '/home/destin/Documents/design-notes.md';
    const { rerender, unmount } = render(<AttachmentChip path={path} onRemove={() => {}} />);
    await flush();
    rerender(<AttachmentChip path={path} name="renamed.md" onRemove={() => {}} />);
    await flush();
    unmount();
    render(<AttachmentChip path={path} onRemove={() => {}} />);
    await flush();
    expect(readHead).toHaveBeenCalledTimes(1);
    expect(readHead).toHaveBeenCalledWith(path, READ_HEAD_DEFAULT_BYTES);
  });
});

// Fix (2026-08-27 sweep): a tile is itself a <button>; the preview must never put a
// button or a link inside it — React logged "<button> cannot be a descendant of <button>"
// on every Projects screen when the code-block Copy button rode along.
import { render as renderPreview } from '@testing-library/react';
import { MarkdownHeadPreview } from '../src/renderer/components/HeadPreview';
describe('MarkdownHeadPreview is inert', () => {
  it('renders no button and no link, even for code blocks and links', () => {
    const { container } = renderPreview(<MarkdownHeadPreview text={'# Title\n\n```ts\nconst a = 1;\n```\n\n[docs](https://example.com)'} />);
    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('pre')).not.toBeNull();
    expect(container.textContent).toContain('docs');
  });
});

// A preview whose read failed (a phone's connection dropping mid-read) used to stay failed
// for the page's life: the failure was cached with the path.
describe('AttachmentChip after a failed read', () => {
  const PATH = '/home/destin/Documents/notes.txt';

  it('the next chip for the same file asks again', async () => {
    readHead.mockRejectedValueOnce(new Error('lost'));
    const first = render(<AttachmentChip path={PATH} onRemove={() => {}} />);
    await flush();
    first.unmount();
    render(<AttachmentChip path={PATH} onRemove={() => {}} />);
    await flush();
    expect(readHead).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/Call Sam/)).toBeTruthy();
  });

  it('a mounted chip asks again after a remote reconnect', async () => {
    const { REMOTE_RECONNECTED_EVENT } = await import('../src/renderer/remote-events');
    readHead.mockRejectedValueOnce(new Error('lost'));
    render(<AttachmentChip path={PATH} onRemove={() => {}} />);
    await flush();
    expect(screen.queryByText(/Call Sam/)).toBeNull();
    await act(async () => { window.dispatchEvent(new Event(REMOTE_RECONNECTED_EVENT)); });
    await flush();
    expect(screen.getByText(/Call Sam/)).toBeTruthy();
  });

  it('a successful read is still shared, and a reconnect does not repeat it', async () => {
    const { REMOTE_RECONNECTED_EVENT } = await import('../src/renderer/remote-events');
    render(<AttachmentChip path={PATH} onRemove={() => {}} />);
    await flush();
    await act(async () => { window.dispatchEvent(new Event(REMOTE_RECONNECTED_EVENT)); });
    render(<AttachmentChip path={PATH} onRemove={() => {}} />);
    await flush();
    expect(readHead).toHaveBeenCalledTimes(1);
  });
});
