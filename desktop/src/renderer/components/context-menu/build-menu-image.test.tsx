// @vitest-environment jsdom
// Card #143 a (deck C-2): the picture right-click menu — the four items Destin chose, and what each one hands over.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { buildContextMenu } from './build-menu';

vi.mock('../../platform', () => ({ getCapabilities: () => ({ openInOs: (globalThis as any).__openInOs === true }), isAndroid: () => false, isRemoteMode: () => false }));

function chatWithPicture(src: string) {
  const scroll = document.createElement('div'); scroll.className = 'chat-scroll';
  const img = document.createElement('img'); img.setAttribute('src', src); img.setAttribute('alt', 'A chart');
  scroll.appendChild(img); document.body.appendChild(scroll);
  return img;
}
const ids = (img: HTMLElement) => (buildContextMenu(img) ?? []).filter((e) => e.type === 'item').map((e: any) => e.id);

afterEach(() => { document.body.innerHTML = ''; delete (window as any).claude; delete (globalThis as any).__openInOs; });

describe('picture menu', () => {
  it('on the computer: copy, save, address (web pictures), ask', () => {
    (globalThis as any).__openInOs = true;
    (window as any).claude = { shell: { pictureAction: vi.fn().mockResolvedValue({ ok: true }) } };
    expect(ids(chatWithPicture('https://example.com/a.png'))).toEqual(['copy-image', 'save-image', 'copy-image-address', 'ask']);
  });
  it('a picture that is not from a website has no address item', () => {
    (globalThis as any).__openInOs = true;
    (window as any).claude = { shell: { pictureAction: vi.fn() } };
    expect(ids(chatWithPicture('file:///home/me/a.png'))).toEqual(['copy-image', 'save-image', 'ask']);
  });
  it('on a phone: no save, and no copy where the browser cannot put a picture on the clipboard', () => {
    expect(ids(chatWithPicture('https://example.com/a.png'))).toEqual(['copy-image-address', 'ask']);
  });
  it('copy and save ask the computer for the picture; a failure says so in plain words', async () => {
    (globalThis as any).__openInOs = true;
    const pictureAction = vi.fn().mockResolvedValue({ ok: false });
    (window as any).claude = { shell: { pictureAction } };
    const seen: string[] = [];
    window.addEventListener('youcoded:notice', (e) => seen.push((e as CustomEvent).detail.message));
    const entries = buildContextMenu(chatWithPicture('https://example.com/a.png'))!;
    for (const id of ['copy-image', 'save-image']) await (entries.find((e: any) => e.id === id) as any).run();
    expect(pictureAction.mock.calls).toEqual([['copy', 'https://example.com/a.png'], ['save', 'https://example.com/a.png']]);
    expect(seen).toEqual(["Couldn't copy that picture.", "Couldn't save that picture."]);
  });
  it('Ask about this carries the description and where the picture came from', () => {
    const spy = vi.fn(); window.addEventListener('youcoded:compose-insert', spy);
    const ask = buildContextMenu(chatWithPicture('https://example.com/a.png'))!.find((e: any) => e.id === 'ask') as any;
    ask.run();
    expect(spy.mock.calls[0][0].detail.ref.quote).toBe('Picture: A chart (https://example.com/a.png)');
  });
});
