// Pins audit F1/F8: HTML preview frames carry a policy that closes every way to SEND data, and the project files a preview
// may pull in are limited to the matching file type.
import { describe, it, expect } from 'vitest';
import { HTML_PREVIEW_CSP, HTML_THUMBNAIL_CSP, withPolicyMeta, previewFrameProps } from '../src/renderer/components/artifact-views/html-preview-csp';

const directive = (policy: string, name: string) => policy.split(';').map((d) => d.trim()).find((d) => d.startsWith(name + ' ') || d === name);

describe('preview policy', () => {
  it('closes fetch / XHR / WebSocket / beacons and form posts, and starts from nothing', () => {
    for (const p of [HTML_PREVIEW_CSP, HTML_THUMBNAIL_CSP]) {
      expect(directive(p, 'default-src')).toBe("default-src 'none'");
      expect(directive(p, 'form-action')).toBe("form-action 'none'");
      expect(directive(p, 'object-src')).toBe("object-src 'none'");
    }
    // Only local pseudo-addresses may be fetched by the full preview; the thumbnail may fetch nothing.
    expect(directive(HTML_PREVIEW_CSP, 'connect-src')).toBe('connect-src data: blob:');
    expect(directive(HTML_THUMBNAIL_CSP, 'connect-src')).toBe("connect-src 'none'");
  });
  it('still lets a mockup run inline scripts and use public CDNs, fonts and images', () => {
    expect(directive(HTML_PREVIEW_CSP, 'script-src')).toContain("'unsafe-inline'");
    expect(directive(HTML_PREVIEW_CSP, 'script-src')).toContain('https:');
    expect(directive(HTML_PREVIEW_CSP, 'style-src')).toContain('https:');
    expect(directive(HTML_PREVIEW_CSP, 'img-src')).toContain('https:');
    expect(directive(HTML_PREVIEW_CSP, 'font-src')).toContain('https:');
  });
  it('the thumbnail allows no scripts at all', () => {
    expect(directive(HTML_THUMBNAIL_CSP, 'script-src')).toBeUndefined();
  });
  it('is handed to the frame as the csp attribute', () => {
    expect(previewFrameProps(HTML_PREVIEW_CSP)).toEqual({ csp: HTML_PREVIEW_CSP });
  });
});

describe('withPolicyMeta', () => {
  const META = /<meta http-equiv="Content-Security-Policy"/;
  it('goes after a leading doctype so the page stays in standards mode', () => {
    const out = withPolicyMeta('<!DOCTYPE html><html><head></head></html>', HTML_PREVIEW_CSP);
    expect(out.startsWith('<!DOCTYPE html><meta http-equiv="Content-Security-Policy"')).toBe(true);
  });
  it('copes with a byte-order mark, whitespace and comments before the doctype', () => {
    const out = withPolicyMeta('﻿\n<!-- made by x -->\n<!doctype html><p>hi</p>', HTML_PREVIEW_CSP);
    expect(out.indexOf('<meta')).toBeGreaterThan(out.indexOf('<!doctype'));
  });
  it('goes first when there is no doctype, and never loses the page', () => {
    for (const page of ['<h1>hi</h1>', '<script>1</script>', '', 'plain text']) {
      const out = withPolicyMeta(page, HTML_PREVIEW_CSP);
      expect(out).toMatch(META);
      expect(out.endsWith(page)).toBe(true);
    }
  });
  it('a doctype later in the text does not move it', () => {
    const out = withPolicyMeta('<p>x</p><!doctype html>', HTML_PREVIEW_CSP);
    expect(out.startsWith('<meta')).toBe(true);
  });
});
