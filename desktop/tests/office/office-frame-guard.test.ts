// An Office editor frame may load its own office://<token> pages and nothing else (final review,
// finding 2). CSP already stops it fetching off its origin; this guard stops it NAVIGATING off
// it, which would carry text out in a URL. Other app frames (HTML preview, Pages) are untouched.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { blocksOfficeFrameNavigation, sealOfficeFrames, type GuardFrame } from '../../src/main/office/office-frame-guard';

const APP: GuardFrame = { url: 'file:///opt/app/index.html', frameTreeNodeId: 1, parent: null };
const frame = (url: string, id: number, parent: GuardFrame | null = APP): GuardFrame => ({ url, frameTreeNodeId: id, parent });

describe('the Office frame guard', () => {
  it('lets a new editor frame open its office: page', () => {
    const known = new Set<number>();
    expect(blocksOfficeFrameNavigation({ url: 'office://t1/index.html', isMainFrame: false, frame: frame('about:blank', 7) }, known)).toBe(false);
    expect(known.has(7)).toBe(true);
  });

  it('stops an editor frame navigating itself to a web address', () => {
    const known = new Set<number>();
    expect(blocksOfficeFrameNavigation({ url: 'https://evil.example/?text=secret', isMainFrame: false, frame: frame('office://t1/index.html', 7) }, known)).toBe(true);
  });

  it("stops a frame nested inside the editor from leaving, and lets the editor's own blank and blob frames load", () => {
    const known = new Set<number>();
    const editor = frame('office://t1/index.html', 7);
    const inner = frame('office://t1/web-apps/documenteditor.html', 8, editor);
    expect(blocksOfficeFrameNavigation({ url: 'http://127.0.0.1:9/x', isMainFrame: false, frame: inner }, known)).toBe(true);
    expect(blocksOfficeFrameNavigation({ url: 'about:blank', isMainFrame: false, frame: inner }, known)).toBe(false);
    expect(blocksOfficeFrameNavigation({ url: 'blob:office://t1/5f0c', isMainFrame: false, frame: inner }, known)).toBe(false);
    expect(blocksOfficeFrameNavigation({ url: 'file:///etc/passwd', isMainFrame: false, frame: inner }, known)).toBe(true);
  });

  it('remembers an editor frame after it steps through a blank or data: page, so it cannot leave from there', () => {
    const known = new Set<number>();
    blocksOfficeFrameNavigation({ url: 'office://t1/index.html', isMainFrame: false, frame: frame('about:blank', 7) }, known);
    // The frame now shows an in-between page: its own URL no longer says office:.
    expect(blocksOfficeFrameNavigation({ url: 'data:text/html,<script>location="https://x"</script>', isMainFrame: false, frame: frame('about:blank', 7) }, known)).toBe(true);
    expect(blocksOfficeFrameNavigation({ url: 'https://x/', isMainFrame: false, frame: frame('data:text/html,x', 7) }, known)).toBe(true);
  });

  it('stops a navigation the editor starts in another frame', () => {
    const known = new Set<number>();
    const editor = frame('office://t1/index.html', 7);
    expect(blocksOfficeFrameNavigation({ url: 'https://x/', isMainFrame: false, frame: frame('about:srcdoc', 9), initiator: editor }, known)).toBe(true);
  });

  it("leaves the app's other frames and the top window to their own rules", () => {
    const known = new Set<number>([7]);
    // An HTML preview following one of its own links.
    expect(blocksOfficeFrameNavigation({ url: 'https://example.com/', isMainFrame: false, frame: frame('about:srcdoc', 9) }, known)).toBe(false);
    // The top frame is will-navigate's job (isAppPageUrl).
    expect(blocksOfficeFrameNavigation({ url: 'https://example.com/', isMainFrame: true, frame: APP, initiator: frame('office://t1/', 7) }, known)).toBe(false);
  });

  it('treats a frame destroyed mid-event as unknown rather than throwing', () => {
    const gone = { get url(): string { throw new Error('destroyed'); }, get frameTreeNodeId(): number { throw new Error('destroyed'); }, parent: null } as GuardFrame;
    expect(blocksOfficeFrameNavigation({ url: 'https://x/', isMainFrame: false, frame: gone }, new Set())).toBe(false);
  });

  it('cancels the navigation through will-frame-navigate', () => {
    let listener!: (e: any) => void;
    sealOfficeFrames({ on: (_: string, l: (e: any) => void) => { listener = l; } });
    const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const leave = { url: 'https://x/', isMainFrame: false, frame: frame('office://t1/index.html', 7), preventDefault: vi.fn() };
    listener(leave);
    expect(leave.preventDefault).toHaveBeenCalled();
    const stay = { url: 'office://t1/sdkjs/x.js', isMainFrame: false, frame: frame('office://t1/index.html', 7), preventDefault: vi.fn() };
    listener(stay);
    expect(stay.preventDefault).not.toHaveBeenCalled();
    quiet.mockRestore();
  });

  it('is wired into every app window beside the top-frame guard', () => {
    const main = readFileSync(join(__dirname, '../../src/main/main.ts'), 'utf8');
    const body = main.slice(main.indexOf('function createAppWindow('));
    expect(body.slice(0, body.indexOf('\n}\n'))).toMatch(/sealOfficeFrames\(win\.webContents\)/);
  });
});
