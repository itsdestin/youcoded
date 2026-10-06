#!/usr/bin/env node
// Run: node docs/tools/gen-legal-pages.mjs [--check]
// WHY: root Markdown is the legal authority; checked-in HTML keeps Pages readable
// offline and without scripts, rather than maintaining a second copy of the policy.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(resolve(root, 'desktop/package.json'));
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { default: Markdown } = await import(pathToFileURL(require.resolve('react-markdown')).href);
export const policies = ['privacy', 'terms'];
const github = 'https://github.com/itsdestin/youcoded/blob/master/';
const escape = (text) => text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export function policyLink(href) {
  return href.replace(/^(?:\.\/)?(PRIVACY|TERMS|SECURITY)\.md(?=$|[#?])/i, (_, name) => {
    const upper = name.toUpperCase();
    return upper === 'SECURITY' ? `${github}SECURITY.md` : `${upper.toLowerCase()}.html`;
  });
}

export function renderPolicy(markdown) {
  const headings = [];
  const ids = new Map();
  const heading = (level) => ({ children }) => {
    // WHY: derive anchors from rendered text (including emphasis), and suffix
    // collisions so every TOC link remains a unique, script-free destination.
    const plain = renderToStaticMarkup(createElement('span', null, children))
      .replace(/<[^>]*>/g, '').replace(/&amp;/g, '&');
    const base = plain.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-');
    const count = ids.get(base) ?? 0;
    ids.set(base, count + 1);
    const id = count ? `${base}-${count}` : base;
    if (level === 2) headings.push({ id, html: renderToStaticMarkup(createElement('span', null, children)) });
    return createElement(`h${level}`, { id, tabIndex: -1 }, children);
  };
  const html = renderToStaticMarkup(createElement(Markdown, {
    components: {
      h1: heading(1), h2: heading(2), h3: heading(3), h4: heading(4), h5: heading(5), h6: heading(6),
      a: ({ href, children }) => createElement('a', { href: policyLink(href ?? '') }, children),
    },
    children: markdown,
  }));
  return { html, headings };
}

function policyNav(active) {
  return policies.map((name) => `<a href="${name}.html"${name === active ? ' aria-current="page"' : ''}>${name === 'privacy' ? 'Privacy' : 'Terms'}</a>`).join('\n');
}

export function generatePage(name, markdown = readFileSync(resolve(root, `${name.toUpperCase()}.md`), 'utf8')) {
  const { html, headings } = renderPolicy(markdown);
  // Fail loudly if the canonical document's opening changes; never silently
  // drop legal text to make it fit a presentation template.
  const opening = html.match(/^(<h1\b[^>]*>.*?<\/h1>)\s*(<p><strong>Effective date:<\/strong> .*?<\/p>)\s*/s);
  if (!opening) throw new Error(`${name}: expected title and effective date at the start`);
  const title = markdown.match(/^# (.+)$/m)[1];
  const body = html.slice(opening[0].length);
  const toc = `<ol>${headings.map(({ id, html: label }) => `<li><a href="#${id}">${label}</a></li>`).join('\n')}</ol>`;
  return `<!doctype html>
<!-- Generated from ${name.toUpperCase()}.md by docs/tools/gen-legal-pages.mjs. Do not edit legal prose here. -->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escape(title)} — YouCoded Assistant</title>
<meta name="description" content="${name === 'privacy' ? 'How YouCoded handles your data, and your rights and choices.' : 'Terms for using the YouCoded applications and services.'}">
<link rel="icon" type="image/png" href="legal-assets/brand.png">
<link rel="stylesheet" href="legal.css">
</head>
<body id="top">
<a class="skip-link" href="#policy-content">Skip to policy</a>
<nav class="site-nav" aria-label="Main navigation">
  <a class="logo" href="index.html" aria-label="YouCoded home"><img src="legal-assets/brand.png" width="36" height="36" alt=""><span class="wordmark"><span>you</span>coded</span></a>
  <div class="policy-nav">${policyNav(name)}</div>
</nav>
<main>
  <div class="document-layout">
    <aside class="toc-desktop" aria-label="On this page"><div class="toc-panel"><h2>On this page</h2>${toc}<a class="toc-home" href="index.html">← Back to home</a></div></aside>
    <div class="reading-column">
      <header class="hero">
        <p class="eyebrow">Legal</p>
        ${opening[1]}
        <div class="policy-meta">
          <div class="effective-date">${opening[2]}</div>
          <a class="source-link" href="${github}${name.toUpperCase()}.md">View source ↗</a>
        </div>
      </header>
      <!-- WHY: native details works with keyboards and with JavaScript disabled;
           a separate desktop TOC avoids forcing the mobile disclosure open. -->
      <details class="toc-mobile"><summary><span>On this page</span><svg class="toc-chevron" aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></summary><nav aria-label="Policy sections">${toc}</nav></details>
      <article class="policy-content" id="policy-content" tabindex="-1" aria-label="${escape(title)}">
${body}
      </article>
    </div>
  </div>
</main>
<footer class="site-footer">
  <a href="index.html">← Back to home</a>
  <nav class="policy-nav" aria-label="Legal pages">${policyNav(name)}</nav>
  <a href="${github}${name.toUpperCase()}.md">Source Markdown ↗</a>
</footer>
</body>
</html>
`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  for (const name of policies) {
    const path = resolve(root, `docs/${name}.html`);
    const output = generatePage(name);
    if (check) {
      if (readFileSync(path, 'utf8') !== output) throw new Error(`${path} is stale; run node docs/tools/gen-legal-pages.mjs`);
      console.log(`OK ${name}.html matches canonical Markdown`);
    } else {
      writeFileSync(path, output);
      console.log(`Generated docs/${name}.html`);
    }
  }
}
