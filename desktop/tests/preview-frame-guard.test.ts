// Pins audit F8: the HTML preview / Pages frame cannot navigate itself to a website, file or data page.
import { describe, it, expect } from 'vitest';
import { blocksPreviewFrameNavigation, type PreviewGuardFrame } from '../src/main/preview-frame-guard';

const MAIN = 1;
const DEV = 'http://localhost:5223';
const main: PreviewGuardFrame = { frameTreeNodeId: MAIN, parent: null };
const preview: PreviewGuardFrame = { frameTreeNodeId: 7, parent: main };
const nested: PreviewGuardFrame = { frameTreeNodeId: 9, parent: preview };
const nav = (url: string, frame: PreviewGuardFrame | null = preview, extra: object = {}) => ({ url, isMainFrame: false, frame, ...extra });

describe('preview frame guard', () => {
  it('stops the preview frame leaving for a website, a file or a data page', () => {
    for (const u of ['https://lookalike.example/login', 'http://evil.example/', 'HTTPS://EVIL.EXAMPLE/', 'file:///home/x/.ssh/id_rsa', 'data:text/html,<h1>fake</h1>', 'ftp://example.com/'])
      expect(blocksPreviewFrameNavigation(nav(u), MAIN, DEV), u).toBe(true);
  });
  it('leaves the first load, office frames, hash moves, blobs and the dev server alone', () => {
    for (const u of ['about:srcdoc', 'about:blank', 'office://abc/editor.html', 'blob:null/123', `${DEV}/workbench.html`])
      expect(blocksPreviewFrameNavigation(nav(u), MAIN, DEV), u).toBe(false);
    expect(blocksPreviewFrameNavigation(nav('https://example.com/#x', preview, { isSameDocument: true }), MAIN, DEV)).toBe(false);
  });
  it('does not police the top page (its own guard) or frames nested inside a preview (embeds)', () => {
    expect(blocksPreviewFrameNavigation({ url: 'https://example.com', isMainFrame: true, frame: main }, MAIN, DEV)).toBe(false);
    expect(blocksPreviewFrameNavigation(nav('https://www.youtube.com/embed/x', nested), MAIN, DEV)).toBe(false);
  });
  it('fails safe on a frame that vanished mid-event', () => {
    const gone = { get frameTreeNodeId(): number { throw new Error('destroyed'); }, get parent(): PreviewGuardFrame | null { throw new Error('destroyed'); } };
    expect(blocksPreviewFrameNavigation(nav('https://example.com', gone as PreviewGuardFrame), MAIN, DEV)).toBe(false);
  });
});
