// @vitest-environment jsdom
// Pins the HTML-preview asset inlining (review finding: index.html referencing
// styles.css / game.js rendered unstyled and inert — srcDoc frames have no
// base URL, so relative refs can never load without inlining).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { inlineLocalAssets, resolveRelativeRef } from '../src/renderer/components/artifact-views/html-inline-assets';

const readBinary = vi.fn();
beforeEach(() => {
  readBinary.mockReset();
  (window as any).claude = { artifacts: { readBinary } };
});

const b64 = (s: string) => btoa(unescape(encodeURIComponent(s)));

describe('resolveRelativeRef', () => {
  it('resolves siblings, subdirs, and parent traversal against the html dir', () => {
    expect(resolveRelativeRef('/proj/site/index.html', 'styles.css')).toBe('/proj/site/styles.css');
    expect(resolveRelativeRef('/proj/site/index.html', './js/game.js')).toBe('/proj/site/js/game.js');
    expect(resolveRelativeRef('/proj/site/index.html', '../shared/base.css')).toBe('/proj/shared/base.css');
    expect(resolveRelativeRef('C:\\proj\\index.html', 'a.css')).toBe('C:/proj/a.css');
  });
  it('strips query/fragment for the disk path', () => {
    expect(resolveRelativeRef('/p/index.html', 'a.css?v=2#x')).toBe('/p/a.css');
  });
});

describe('inlineLocalAssets', () => {
  it('inlines relative stylesheets and scripts, leaves absolute/remote refs alone', async () => {
    readBinary.mockImplementation(async (p: string) => {
      if (p.endsWith('styles.css')) return { ok: true, base64: b64('body{color:red}') };
      if (p.endsWith('game.js')) return { ok: true, base64: b64('console.log(1)') };
      return { ok: false };
    });
    const html = `<html><head>
      <link rel="stylesheet" href="styles.css">
      <link rel="stylesheet" href="https://cdn.example/x.css">
      <script src="game.js"></script>
      <script src="/abs/only.js"></script>
    </head><body>hi</body></html>`;
    const out = await inlineLocalAssets(html, '/proj/site/index.html');
    expect(out).toContain('<style>body{color:red}</style>');
    expect(out).toContain('console.log(1)');
    expect(out).not.toContain('src="game.js"');
    expect(out).toContain('https://cdn.example/x.css'); // remote untouched
    expect(out).toContain('/abs/only.js');              // absolute untouched
  });

  it('turns relative images into data URIs', async () => {
    readBinary.mockResolvedValue({ ok: true, base64: btoa('PNG!') });
    const out = await inlineLocalAssets('<img src="pic.png">', '/p/index.html');
    expect(out).toContain('data:image/png;base64,');
  });

  it('degrades to the original markup when fetches fail or nothing is relative', async () => {
    readBinary.mockResolvedValue({ ok: false });
    const html = '<link rel="stylesheet" href="gone.css"><p>x</p>';
    const out = await inlineLocalAssets(html, '/p/index.html');
    expect(out).toContain('href="gone.css"'); // failure leaves the ref in place
    const selfContained = '<p>self-contained</p>';
    expect(await inlineLocalAssets(selfContained, '/p/i.html')).toBe(selfContained);
  });
});

describe('inlineLocalAssets only pulls in the matching file type', () => {
  it('does not paste an arbitrary project file into a <style> or <script>', async () => {
    readBinary.mockImplementation(async () => ({ ok: true, base64: b64('SECRET TEXT') }));
    const html = '<html><head><link rel="stylesheet" href="../../notes/secret.txt"><link rel="stylesheet" href="ok.css"><script src="../keys.json"></script><script src="app.js"></script></head></html>';
    const out = await inlineLocalAssets(html, '/proj/site/index.html');
    expect(readBinary.mock.calls.map((c) => c[0]).sort()).toEqual(['/proj/site/app.js', '/proj/site/ok.css']);
    expect(out).toContain('href="../../notes/secret.txt"');   // left as written: it does not load, and leaks nothing
    expect(out).toContain('src="../keys.json"');
  });
});
