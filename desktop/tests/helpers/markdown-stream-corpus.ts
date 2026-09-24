/**
 * Markdown that is hard to draw one block at a time, and the ways to stream it.
 *
 * Shared by markdown-blocks.test.ts (parser-level, every character) and
 * MarkdownContent.test.tsx (rendered page, every delta). Each sample targets a
 * construct where a later line can change how earlier text reads, or where
 * blocks depend on each other.
 */
export const MARKDOWN_STREAM_CORPUS: { name: string; md: string }[] = [
  { name: 'fenced code with a language', md: 'Here is the fix:\n\n```ts\nfunction f(a: number): string {\n  // double it\n  return String(a * 2);\n}\n```\n\nThat is all.' },
  { name: 'fenced code without a language, and a tilde fence', md: 'Run:\n\n```\nnpm run build\nnpm test\n```\n\n~~~\nraw ~~~ inside\n~~~\n\nDone.' },
  { name: 'nested lists with code inside an item', md: '- one\n  - one.a\n  - one.b\n- two\n\n  ```bash\n  echo hi\n  ```\n- three\n\n1. first\n2. second\n   1. inner\n\nAfter the list.' },
  { name: 'loose and tight lists, then an ordered list starting at 3', md: '- a\n- b\n\n- c after a blank\n\nparagraph ends it\n\n3. three\n4. four\n\n* star list\n+ plus list' },
  { name: 'table appearing under paragraph lines', md: 'Intro line\n| Name | Value |\n| :--- | ----: |\n| a | 1 |\n| b | 2 |\n\nAfter table.\n\n| x |\n| - |\n| y |' },
  { name: 'details and summary around content, twice', md: 'Before.\n\n<details>\n<summary>Show the log</summary>\n\nLine **one**\n\n```\nlog output\n```\n\n</details>\n\nBetween.\n\n<details open><summary>Second</summary>\n\nInside two\n\n</details>\n\nEnd.' },
  { name: 'reference-style links defined later', md: 'See [the docs][docs] and [other].\n\nMore text here.\n\n[docs]: https://example.com/docs "Docs"\n[other]: https://example.com/other\n\nTail.' },
  // A run of definitions with no blank lines: titles on the next line, a label
  // on its own line, a duplicate label (the first wins), and an indented line
  // after the last one (a paragraph there, never code).
  { name: 'a list of link definitions with no blank lines', md: 'See [a], [B] and [c], then [d].\n\n[a]: /a "A"\n[b]: /b\n\'B title\'\n[c]:\n/c\n[A]: /second\n[d]: /d\n    not code [a]\n\nEnd [d] [a].' },
  { name: 'footnotes defined in another block', md: 'A claim.[^1] Another.[^note]\n\nSecond paragraph.\n\n[^1]: The source.\n[^note]: A longer note.\n\nFinal words.' },
  { name: 'setext headings', md: 'Title\n=====\n\nSub title\n---------\n\nplain para\nstill para\n===\n\nlast' },
  { name: 'hash that is not a heading, then a real one', md: 'para\n#foo stays text\n\n# Real heading\n\n##also text\n\n## Level two' },
  { name: 'blockquote with lazy continuation and a list', md: '> quoted line\nlazy continuation\n> - item in quote\n> - item two\n\nOut of quote.\n\n> second quote\n\n> third' },
  { name: 'file paths and web addresses', md: 'Edit /home/user/project/src/app.ts then open https://example.com/a?b=c.\n\n```bash\ncat /etc/hosts # see https://example.org\n```\n\nAlso `~/notes/todo.md` and www.example.com.' },
  { name: 'conversations fence', md: 'Earlier chats:\n\n```conversations\nabc12345\ndef67890\n```\n\nPick one.' },
  { name: 'indented code with a blank line inside', md: 'Text before.\n\n    indented code\n\n    still code\n\nText after.\n\n    tail code' },
  // micromark reads the lines around indented code by what came before it: an
  // empty item after it is a paragraph, but after a list it starts a list.
  { name: 'indented code beside empty list items', md: 'Text.\n\n    code line\n\n-\n\n- \n\n\t- tabbed\n*\n\nEnd.' },
  { name: 'dashes: setext, rules and list items', md: 'para\n-\n\n---\n\n- item\n\n***\n\nnext\n- not setext, a list\n\n___' },
  { name: 'raw HTML that is not a disclosure', md: '<div class="x">raw block</div>\n\ntext with <b>inline</b> and <span title=">">tag</span>\n\n<!-- a comment -->\n\nend' },
  { name: 'hard breaks, emphasis, strikethrough and task lists', md: 'line one  \nline two\\\nline three *em* **strong** ~~gone~~\n\n- [ ] todo\n- [x] done\n\n_under_ and __double__' },
  { name: 'CRLF line endings', md: 'first\r\nsecond\r\n\r\n# heading\r\n\r\n- a\r\n- b\r\n\r\n```js\r\nlet x = 1;\r\n```\r\nend' },
  { name: 'images and autolinks', md: '![local](./pic.png)\n\n![remote](https://example.com/p.png)\n\n<https://example.com/auto> and me@example.com\n\nDone.' },
  {
    name: 'long mixed reply',
    md: [
      '## Plan', '', 'We will change **three** files:', '', '1. `src/a.ts` — the parser', '2. `src/b.ts` — the view', '3. `README.md`', '',
      '```ts', 'export function parse(input: string): number {', '  const n = Number(input);', '  if (Number.isNaN(n)) throw new Error("bad: " + input);', '  return n;', '}', '```', '',
      '```json', '{ "name": "x", "version": 1, "list": [1, 2, 3] }', '```', '',
      '```diff', '- old line', '+ new line', '```', '',
      '| step | status |', '| --- | --- |', '| parse | done |', '| view | todo |', '',
      '> Note: run the tests first.', '', '### Details', '', 'Paragraph with a URL https://example.com and a path /tmp/out.log.', '',
      '---', '', 'Thanks!',
    ].join('\n'),
  },
];

/**
 * Token-sized deltas, the way a model streams: each whitespace run rides with
 * the word after it, long words are cut into 4-character pieces. Mirrors
 * scripts/perf-lab/fake-provider.mjs `splitDeltas`.
 */
export function tokenDeltas(text: string): string[] {
  const pieces: string[] = [];
  for (const m of text.matchAll(/\s*\S+|\s+$/g)) {
    const tok = m[0];
    if (tok.length <= 6) { pieces.push(tok); continue; }
    const lead = tok.match(/^\s*/)![0];
    const word = tok.slice(lead.length);
    for (let i = 0; i < word.length; i += 4) pieces.push((i === 0 ? lead : '') + word.slice(i, i + 4));
  }
  return pieces;
}

/** Every prefix a stream of `deltas` passes through, in order. */
export function prefixesOf(deltas: string[]): string[] {
  const out: string[] = [];
  let acc = '';
  for (const d of deltas) { acc += d; out.push(acc); }
  return out;
}
