// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import DOMPurify from 'dompurify';
import { sanitizeDocHtml } from '../src/renderer/components/artifact-views/sanitize-doc-html';

// Mount exactly the way DocxView does: the cleaned string, as innerHTML.
const mount = (html: string): HTMLElement => {
  const host = document.createElement('div');
  host.innerHTML = sanitizeDocHtml(html);
  return host;
};

describe('sanitizeDocHtml — what a .docx preview may contain (2026-09-10)', () => {
  it('removes code and file links but keeps their text', () => {
    const host = mount(
      '<p><a href="javascript:alert(1)">a</a><a href=" JaVaScRiPt:alert(1)">b</a>' +
      '<a href="file:///etc/passwd">c</a><a href="vbscript:x">d</a></p>',
    );
    for (const a of Array.from(host.querySelectorAll('a'))) expect(a.hasAttribute('href')).toBe(false);
    expect(host.textContent).toBe('abcd');
  });

  it('sends web and email links to a new window, which the shell hands to the browser', () => {
    const host = mount('<p><a href="https://example.com/a?b=1&amp;c=2">web</a><a href="mailto:a@b.c">mail</a></p>');
    const [web, mail] = Array.from(host.querySelectorAll('a'));
    expect(web.getAttribute('href')).toBe('https://example.com/a?b=1&c=2');
    expect(web.getAttribute('target')).toBe('_blank');
    expect(web.getAttribute('rel')).toBe('noopener noreferrer');
    expect(mail.getAttribute('target')).toBe('_blank');
  });

  it('keeps in-document bookmark links scrolling in place', () => {
    const link = mount('<p><a href="#sec2">jump</a></p><p id="sec2">Section 2</p>').querySelector('a')!;
    expect(link.getAttribute('href')).toBe('#sec2');
    expect(link.hasAttribute('target')).toBe(false);
  });

  it('keeps headings, tables and embedded images', () => {
    const host = mount(
      '<h1>Title</h1><table><tr><td>cell</td></tr></table>' +
      '<p><img src="data:image/png;base64,iVBORw0KGgo=" alt="pic"></p>',
    );
    expect(host.querySelector('h1')!.textContent).toBe('Title');
    expect(host.querySelector('td')!.textContent).toBe('cell');
    expect(host.querySelector('img')!.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
  });

  it('never turns text that looks like a tag into an element', () => {
    const host = mount('<p>&lt;img src=x onerror=alert(1)&gt;</p>');
    expect(host.querySelector('img')).toBeNull();
  });

  it("keeps its link rule to itself — the mascot cleaner's default instance is untouched", () => {
    sanitizeDocHtml('<a href="https://example.com">x</a>'); // make sure the private instance exists
    expect(DOMPurify.sanitize('<a href="https://example.com">x</a>')).not.toContain('target');
  });
});
