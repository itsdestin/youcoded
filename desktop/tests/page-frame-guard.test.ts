// A page frame never navigates itself away (main/pages/page-frame-guard.ts): the address
// it would go to could carry what the page read. Other frames are not this guard's business.
import { describe, expect, it } from 'vitest';
import { blocksPageFrameNavigation, notePageFrame, type PageGuardFrame } from '../src/main/pages/page-frame-guard';

const top: PageGuardFrame = { url: 'file:///app/index.html', name: '', frameTreeNodeId: 1, parent: null };
const frame = (id: number, name: string, url = 'about:srcdoc', parent: PageGuardFrame | null = top): PageGuardFrame => ({ url, name, frameTreeNodeId: id, parent });
const nav = (url: string, f: PageGuardFrame | null) => ({ url, isMainFrame: false, frame: f });

describe('page frames', () => {
  it('lets a page load its own document, then refuses every way out', () => {
    const known = new Set<number>();
    const page = frame(7, 'youcoded-page');
    expect(blocksPageFrameNavigation(nav('about:srcdoc', page), known)).toBe(false);
    for (const url of ['https://evil.example/?chats=x', 'http://192.168.1.1/', 'data:text/html,hi', 'blob:null/abc', 'javascript:alert(1)']) {
      expect(blocksPageFrameNavigation(nav(url, page), known), url).toBe(true);
    }
    expect(blocksPageFrameNavigation(nav('about:blank', page), known)).toBe(false);
  });

  it('still refuses after the page renames its window', () => {
    const known = new Set<number>();
    notePageFrame(frame(9, 'youcoded-page'), known);
    expect(blocksPageFrameNavigation(nav('https://evil.example/', frame(9, 'innocent')), known)).toBe(true);
  });

  it('leaves unnamed frames, nested frames named like a page, and the window itself alone', () => {
    const known = new Set<number>();
    expect(blocksPageFrameNavigation(nav('https://example.com/', frame(3, '')), known)).toBe(false);
    const nested = frame(4, 'youcoded-page', 'about:srcdoc', frame(5, ''));
    expect(blocksPageFrameNavigation(nav('https://example.com/', nested), known)).toBe(false);
    expect(blocksPageFrameNavigation({ url: 'https://example.com/', isMainFrame: true, frame: top }, known)).toBe(false);
  });
});
