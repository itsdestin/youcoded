// Run: node --test docs/tools/legal-pages.test.mjs
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { generatePage, policies, renderPolicy, root } from './gen-legal-pages.mjs';

const require = createRequire(resolve(root, 'desktop/package.json'));
const { JSDOM } = require('jsdom');
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { default: Markdown } = await import(pathToFileURL(require.resolve('react-markdown')).href);
const parse = (html) => new JSDOM(html).window.document;
const text = (node) => node.textContent.replace(/\s+/g, ' ').trim();
const github = 'https://github.com/itsdestin/youcoded/blob/master/';

for (const name of policies) {
  test(`${name}: checked-in output is deterministic and current`, () => {
    const saved = readFileSync(resolve(root, `docs/${name}.html`), 'utf8');
    assert.equal(saved, generatePage(name));
    assert.equal(generatePage(name), generatePage(name));
  });

  test(`${name}: all legal text, date, formatting and links match canonical Markdown`, () => {
    const markdown = readFileSync(resolve(root, `${name.toUpperCase()}.md`), 'utf8');
    // WHY: independently render the ENTIRE canonical document. A generator that
    // drops a paragraph, moves a date incorrectly or flattens formatting fails.
    const expected = parse(renderToStaticMarkup(createElement(Markdown, { children: markdown })));
    const actual = parse(generatePage(name));
    const content = actual.querySelector('.policy-content');
    const reconstructed = parse(actual.querySelector('.hero h1').outerHTML
      + '\n' + actual.querySelector('.effective-date').innerHTML + '\n' + content.innerHTML);
    assert.equal(text(reconstructed.body), text(expected.body));
    for (const tag of ['h1', 'h2', 'h3', 'p', 'strong', 'em', 'code', 'li', 'hr']) {
      assert.deepEqual([...reconstructed.querySelectorAll(tag)].map(text), [...expected.querySelectorAll(tag)].map(text), tag);
    }
    const expectedLinks = [...expected.querySelectorAll('a')].map((a) => {
      const href = a.getAttribute('href');
      const policy = href.match(/^(?:\.\/)?(PRIVACY|TERMS)\.md$/);
      return policy ? `${policy[1].toLowerCase()}.html` : href === './SECURITY.md' ? `${github}SECURITY.md` : href;
    });
    assert.deepEqual([...content.querySelectorAll('a')].map((a) => a.getAttribute('href')), expectedLinks);
    assert.equal(actual.querySelector('.hero h1').textContent, expected.querySelector('h1').textContent);
    assert.equal(text(actual.querySelector('.effective-date')), text(expected.querySelector('p')));
    assert.equal(actual.querySelector('article').getAttribute('tabindex'), '-1');
    assert.equal(actual.querySelector('.source-link').getAttribute('href'), `${github}${name.toUpperCase()}.md`);
  });

  test(`${name}: navigation has unique working anchors and active policy state`, () => {
    const doc = parse(generatePage(name));
    const ids = [...doc.querySelectorAll('[id]')].map((node) => node.id);
    assert.equal(new Set(ids).size, ids.length);
    const sections = [...doc.querySelectorAll('article h2')].map((h) => h.id);
    assert.ok(sections.length > 0);
    for (const selector of ['.toc-desktop', '.toc-mobile']) {
      const links = [...doc.querySelectorAll(`${selector} a[href^="#"]`)];
      assert.deepEqual(links.map((a) => a.getAttribute('href').slice(1)), sections);
      links.forEach((a) => assert.equal(text(a), text(doc.getElementById(a.getAttribute('href').slice(1)))));
    }
    for (const a of doc.querySelectorAll('a[href^="#"]')) assert.ok(doc.getElementById(a.getAttribute('href').slice(1)));
    for (const nav of doc.querySelectorAll('.policy-nav')) {
      assert.equal(nav.querySelectorAll('[aria-current="page"]').length, 1);
      assert.equal(nav.querySelector('[aria-current="page"]').getAttribute('href'), `${name}.html`);
      assert.deepEqual([...nav.querySelectorAll('a')].map((a) => a.getAttribute('href')), ['privacy.html', 'terms.html']);
    }
    const summary = doc.querySelector('.toc-mobile summary');
    assert.equal(text(summary), 'On this page');
    // WHY: retain native keyboard disclosure while replacing the browser triangle
    // with a decorative chevron; it must not duplicate the summary's spoken name.
    assert.ok(summary.querySelector('svg[aria-hidden="true"]'));
  });

  test(`${name}: no scripts, trackers, external runtime resources or broken local assets`, () => {
    const doc = parse(generatePage(name));
    assert.equal(doc.querySelectorAll('script, iframe, object, embed').length, 0);
    for (const node of doc.querySelectorAll('*')) {
      for (const attr of node.attributes) assert.ok(!/^on/i.test(attr.name), `event handler ${attr.name}`);
    }
    for (const node of doc.querySelectorAll('[src], link[href]')) {
      const asset = node.getAttribute('src') ?? node.getAttribute('href');
      assert.ok(!/^(https?:|\/\/|data:)/i.test(asset), asset);
      assert.ok(existsSync(resolve(root, 'docs', asset)), asset);
    }
    assert.equal(doc.querySelector('html').lang, 'en');
    assert.ok(doc.querySelector('meta[name="viewport"]'));
  });
}

test('anchor collision handling and relative policy rewrites preserve fragments', () => {
  const { html, headings } = renderPolicy('## Same *heading*\n\n## Same heading\n\n[Terms](./TERMS.md#17-contact) [Privacy](PRIVACY.md) [Security](./SECURITY.md)');
  assert.deepEqual(headings.map((h) => h.id), ['same-heading', 'same-heading-1']);
  assert.deepEqual([...parse(html).querySelectorAll('a')].map((a) => a.getAttribute('href')), ['terms.html#17-contact', 'privacy.html', `${github}SECURITY.md`]);
});

test('CLI --check and shared CSS keep static publishing and accessibility contract', () => {
  const output = execFileSync(process.execPath, [resolve(root, 'docs/tools/gen-legal-pages.mjs'), '--check'], { encoding: 'utf8' });
  assert.match(output, /OK privacy.html matches canonical Markdown/);
  assert.match(output, /OK terms.html matches canonical Markdown/);
  const css = readFileSync(resolve(root, 'docs/legal.css'), 'utf8');
  assert.match(css, /@media print/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /position: sticky/);
  // WHY: legal pages are a quiet, light reading surface, not a themed homepage hero.
  assert.doesNotMatch(css, /wall\/|backdrop-filter|text-shadow/);
  for (const name of policies) {
    const doc = parse(generatePage(name));
    assert.equal(doc.querySelector('meta[name="color-scheme"]').content, 'light');
    assert.equal(doc.querySelector('.logo').textContent.trim(), 'youcoded');
  }
  assert.doesNotMatch(css, /@import|https?:|url\(['"]?\/\//);
});
