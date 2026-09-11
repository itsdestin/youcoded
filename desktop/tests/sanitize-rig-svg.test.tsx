// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { sanitizeRigSvg } from '../src/renderer/components/mascot/sanitize-rig-svg';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { DEFAULT_BUDDY_RIG } from '../src/renderer/components/mascot/default-buddy-rig';

const wrap = (inner: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-3 -5 30 30">${inner}</svg>`;

describe('sanitizeRigSvg', () => {
  it('returns null for non-SVG and unparseable input', () => {
    expect(sanitizeRigSvg('<div>nope</div>')).toBeNull();
    expect(sanitizeRigSvg('<<<garbage')).toBeNull();
  });

  it('preserves rig groups, data-pivot, and shapes', () => {
    const out = sanitizeRigSvg(wrap('<g id="rig-arm-left" data-pivot="2.5 9"><rect x="1" y="2" width="3" height="4"/></g>'));
    expect(out).toContain('rig-arm-left');
    expect(out).toContain('data-pivot="2.5 9"');
    expect(out).toContain('<rect');
  });

  it('strips script, foreignObject, and style tags', () => {
    const out = sanitizeRigSvg(wrap('<script>alert(1)</script><foreignObject><body/></foreignObject><style>@import url(http://evil)</style><g id="rig-body"/>'));
    expect(out).not.toContain('script');
    expect(out).not.toContain('foreignObject');
    expect(out).not.toContain('style>');
    expect(out).toContain('rig-body');
  });

  it('strips SMIL animation tags (all animation is app-side)', () => {
    const out = sanitizeRigSvg(wrap('<g id="rig-body"><animate attributeName="x" from="0" to="9"/><animateTransform attributeName="transform"/></g>'));
    expect(out).not.toContain('<animate');
    expect(out).toContain('rig-body');
  });

  it('strips on* event handler attributes', () => {
    const out = sanitizeRigSvg(wrap('<g id="rig-body" onclick="evil()" onload="evil()"/>'));
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('onload');
  });

  it('strips external hrefs but keeps same-document refs and data: images', () => {
    const out = sanitizeRigSvg(wrap(
      '<use href="#part"/><image href="data:image/png;base64,AAAA"/><image href="https://evil.example/x.png"/>'
    ));
    expect(out).toContain('href="#part"');
    expect(out).toContain('data:image/png');
    expect(out).not.toContain('evil.example');
  });

  it('strips style attributes containing external url()', () => {
    const out = sanitizeRigSvg(wrap('<g id="rig-body" style="fill: url(http://evil.example/f.svg#x)"/>'));
    expect(out).not.toContain('evil.example');
  });

  it('keeps benign style attributes (display:none face groups, var() tints)', () => {
    const out = sanitizeRigSvg(wrap('<g id="rig-face-blink" style="display:none"><path d="M1 1h2"/></g>'));
    expect(out).toContain('display:none');
    const tinted = sanitizeRigSvg(wrap('<stop style="stop-color:var(--rig-accent, #f0a828)"/>'));
    expect(tinted).toContain('--rig-accent');
  });

  it('keeps gradients, filters, and internal url(#ref) paints', () => {
    const out = sanitizeRigSvg(wrap(
      '<defs><radialGradient id="g-hi"><stop offset="0"/></radialGradient></defs><g id="rig-body"><path d="M1 1h2" fill="url(#g-hi)"/></g>'
    ));
    expect(out).toContain('radialGradient');
    expect(out).toContain('url(#g-hi)');
  });
});

// Inline a result exactly the way MascotRig does, then look at what the page built.
const inline = (markup: string | null): HTMLElement => {
  const host = document.createElement('div');
  host.innerHTML = markup ?? '';
  return host;
};

describe('sanitizeRigSvg — markup that means one thing to XML and another to HTML (2026-09-10)', () => {
  const liveScriptSurface = (host: HTMLElement): string[] =>
    Array.from(host.querySelectorAll('*')).flatMap((el) => {
      const found: string[] = [];
      const name = el.localName.toLowerCase();
      if (['img', 'iframe', 'script', 'embed', 'object', 'form', 'foreignobject', 'animate', 'set', 'style'].includes(name)) {
        found.push(`<${name}>`);
      }
      for (const a of Array.from(el.attributes)) {
        if (/^on/i.test(a.name) || a.name.toLowerCase() === 'srcdoc' || /javascript:/i.test(a.value)) found.push(`${name}[${a.name}]`);
      }
      return found;
    });

  it.each([
    ['comment breakout', '<!--><img src=x onerror=alert(1)>-->'],
    ['processing-instruction breakout', '<?x ><img src=x onerror=alert(1)>?>'],
    ['capitalised foreignObject holding a srcdoc frame', '<FOREIGNOBJECT><IFRAME SRCDOC="x"/></FOREIGNOBJECT>'],
    ['capitalised iframe after a closed element', '<p/><IFRAME src="javascript:alert(1)"/>'],
    ['capitalised animation writing a javascript link', '<a href="#x"><ANIMATE attributeName="href" values="javascript:alert(1)"/><circle r="5"/></a>'],
    ['form with a javascript action', '<div/><form action="javascript:alert(1)"><button>go</button></form>'],
    ['CDATA holding markup', '<g><![CDATA[<img src=x onerror=alert(1)>]]></g>'],
  ])('%s leaves nothing live once inlined', (_name, inner) => {
    expect(liveScriptSurface(inline(sanitizeRigSvg(wrap(inner))))).toEqual([]);
  });
});

describe('sanitizeRigSvg — every shipped drawing keeps the parts the app animates', () => {
  const FIXTURES = join(__dirname, '../src/renderer/dev/workbench/fixtures/themes');
  const drawings: Array<[string, string]> = [['default buddy', DEFAULT_BUDDY_RIG]];
  for (const slug of readdirSync(FIXTURES)) {
    const assets = join(FIXTURES, slug, 'assets');
    if (!existsSync(assets)) continue;
    const companions = join(assets, 'companions');
    const files = [
      ...readdirSync(assets).filter((f) => f === 'mascot-rig.svg').map((f) => join(assets, f)),
      ...(existsSync(companions) ? readdirSync(companions).filter((f) => f.endsWith('.svg')).map((f) => join(companions, f)) : []),
    ];
    for (const file of files) drawings.push([`${slug}/${file.slice(assets.length + 1)}`, readFileSync(file, 'utf8')]);
  }

  it('found the shipped drawings to check', () => {
    expect(drawings.length).toBeGreaterThan(10);
  });

  it.each(drawings)('%s', (_name, svg) => {
    const source = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const host = inline(sanitizeRigSvg(svg));
    const ids = (root: ParentNode) => Array.from(root.querySelectorAll('[id]')).map((e) => e.getAttribute('id')).sort();
    const pivots = (root: ParentNode) => Array.from(root.querySelectorAll('[data-pivot]')).map((e) => e.getAttribute('data-pivot')).sort();
    expect(ids(host)).toEqual(ids(source));
    expect(pivots(host)).toEqual(pivots(source));
    expect(host.querySelectorAll('*').length).toBe(source.querySelectorAll('*').length);
  });
});
