// Pins audit F4: the main page carries a Content-Security-Policy, stamped in by the build.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildAppCsp } from '../src/shared/app-csp';

const dir = (name: string) => buildAppCsp().split(';').map((d) => d.trim()).find((d) => d.startsWith(name + ' ')) ?? '';

describe('app Content-Security-Policy', () => {
  it('shuts the doors that only exist to send data or run plugins', () => {
    expect(dir('object-src')).toBe("object-src 'none'");
    expect(dir('form-action')).toBe("form-action 'none'");
    expect(dir('default-src')).toBe("default-src 'self'");
  });
  it('lets the page call only itself, its local files, a phone/second-computer socket and the Worker', () => {
    const c = dir('connect-src');
    expect(c).toContain("'self'");
    expect(c).toContain('https://api.youcoded.ai');
    expect(c).toContain('ws:');
    expect(c).toContain('wss:');
    // No blanket web access for fetch/XHR.
    expect(c.split(/\s+/)).not.toContain('https:');
    expect(c.split(/\s+/)).not.toContain('http:');
    expect(c).not.toContain('*');
  });
  it('keeps what theme backgrounds, chat pictures, sounds and previews need', () => {
    expect(dir('img-src')).toMatch(/theme-asset:/);
    expect(dir('img-src')).toMatch(/\bhttps:/);
    expect(dir('img-src')).toMatch(/\bfile:/);       // attachment chips
    expect(dir('img-src')).toMatch(/\bdata:/);
    expect(dir('media-src')).toMatch(/\bfile:/);     // custom sounds
    expect(dir('frame-src')).toMatch(/\boffice:/);   // the document editor
    expect(dir('worker-src')).toMatch(/blob:/);
  });
  it('documents why script-src is still open (srcdoc frames inherit it)', () => {
    // If someone tightens script-src without moving the preview/Pages frames off srcdoc, every preview and page dies silently.
    const src = fs.readFileSync(path.resolve(__dirname, '../src/shared/app-csp.ts'), 'utf8');
    expect(src).toMatch(/INHERITS/);
    expect(dir('script-src')).toContain("'unsafe-inline'");
  });
  it('is stamped into index.html by the build, except in the public landing-page demo', () => {
    const cfg = fs.readFileSync(path.resolve(__dirname, '../vite.config.ts'), 'utf8');
    expect(cfg).toContain("import { buildAppCsp } from './src/shared/app-csp'");
    expect(cfg).toMatch(/plugins: \[[^\]]*appContentSecurityPolicy/);
    expect(cfg).toMatch(/VITE_WORKBENCH === '1'/);
    // The source page itself must not carry a second, hand-edited copy that could drift.
    const html = fs.readFileSync(path.resolve(__dirname, '../src/renderer/index.html'), 'utf8');
    expect(html).not.toMatch(/Content-Security-Policy/i);
  });
});
