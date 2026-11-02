// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import MarkdownContent from './MarkdownContent';
import { OPEN_LIST_CHUNK_ITEMS } from './markdown-blocks';
import { SessionRefsEnabled } from './session-refs-context';
import { tokenDeltas } from '../../../tests/helpers/markdown-stream-corpus';
import { budgetCpuPerTest, CPU_BOUND_WALL_LIMIT_MS } from '../../../tests/helpers/cpu-budget';

// Every source string handed to react-markdown, so the cost pins count real parse passes.
// (Split out of MarkdownContent.test.tsx, which is at its line budget.)
const markdownRenders = vi.hoisted(() => [] as string[]);
vi.mock('react-markdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-markdown')>();
  return {
    ...actual,
    default: (props: { children?: string }) => {
      markdownRenders.push(String(props.children ?? ''));
      return (actual.default as any)(props);
    },
  };
});
// Every character the streaming splitter hands to the markdown parser (see MarkdownContent.test.tsx).
const splitterParsed = vi.hoisted(() => ({ chars: 0 }));
vi.mock('remark-parse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('remark-parse')>();
  return {
    default: function countingRemarkParse(this: any, ...args: any[]) {
      (actual.default as any).apply(this, args);
      const parse = this.parser;
      this.parser = (doc: string, file: unknown) => {
        splitterParsed.chars += doc.length;
        return parse(doc, file);
      };
    },
  };
});
afterEach(cleanup);

// CPU each test here may use. WHY its own number, not the shared 30 s (measured 2026-10-29): these redraw a 70-100 item
// list after every word and compare it with a full redraw, so the heaviest — "mounts in the middle of the list" — used
// 18.5 s of CPU alone at load 7 on 32 threads, and 30.9 s inside verify.sh at load 19-28, failing a budget that was set
// when the group used 1.5-3 s. Contention inflates a process's CPU 2-4× (tests/helpers/cpu-budget.ts), so 60 s holds a
// correct run on a busy machine; the regression this guards — a per-character cost turning per-message — costs minutes.
const LONG_LIST_STREAM_CPU_BUDGET_MS = 60_000;

describe('MarkdownContent while a long list streams in', { timeout: CPU_BOUND_WALL_LIMIT_MS }, () => {
  budgetCpuPerTest(LONG_LIST_STREAM_CPU_BUDGET_MS);
  const Bubble = ({ md, incremental, live = incremental }: { md: string; incremental?: boolean; live?: boolean }) => (
    <SessionRefsEnabled.Provider value={true}>
      <MarkdownContent content={md} sessionId="s1" incremental={incremental} live={live} />
    </SessionRefsEnabled.Provider>
  );
  // The page as markup. Adjacent text nodes serialize as one run, which is how the browser shows them.
  const canonical = (root: Element) => root.innerHTML;
  const wholeHtml = (md: string) => {
    const r = render(<Bubble md={md} />);
    const html = canonical(r.container);
    r.unmount();
    return html;
  };
  const lines = (n: number, line: (i: number) => string) => Array.from({ length: n }, (_, i) => line(i)).join('\n');
  const streamCosts = (mountAt: string, base: string, deltas: string[]) => {
    const live = render(<Bubble md={mountAt} incremental />);
    let md = base;
    if (base !== mountAt) live.rerender(<Bubble md={md} incremental />);
    const costs: { md: string; work: number; drawn: string[] }[] = [];
    for (const d of deltas) {
      md += d;
      splitterParsed.chars = 0;
      markdownRenders.length = 0;
      live.rerender(<Bubble md={md} incremental />);
      costs.push({ md, work: splitterParsed.chars + markdownRenders.reduce((n, x) => n + x.length, 0), drawn: markdownRenders.slice() });
    }
    expect(canonical(live.container)).toBe(wholeHtml(md));
    live.unmount();
    return costs;
  };

  // The perf-lab "pathlist-stream" class (2026-10-22): a 2000-5000 item list with no blank line is ONE piece,
  // so every word re-parsed the whole list and the thread was busy 28-38 s of a 45 s reply. Finished items
  // are now drawn once in chunks of 20 while the reply streams. Pinned by COUNTING the characters handed to
  // the parser per word (not milliseconds), and by comparing the page with the whole-message render.
  describe('one very long tight list that is still being typed', () => {
    const item = (i: number) => `- path ${i}: /home/user/project/src/module${i}/file${i}.ts and **bold** \`code\` [l](https://e.com/${i})`;
    const listMd = (n: number) => `Here are the files:\n\n${lines(n, item)}\n`;
    const perWordCost = (n: number) => {
      const deltas = tokenDeltas('- one more item with words\n- and another one\n- tail words');
      return streamCosts('Here', listMd(n), deltas).map((c) => c.drawn.reduce((t, x) => t + x.length, 0));
    };

    it('does work per word that does not grow with the list', () => {
      const short = perWordCost(200);
      const long = perWordCost(800);
      const itemLen = item(500).length + 1;
      // Never more than the live tail (under two chunks of items, plus the new ones).
      const bound = (2 * OPEN_LIST_CHUNK_ITEMS + 3) * itemLen;
      expect(Math.max(...short)).toBeLessThanOrEqual(bound);
      expect(Math.max(...long)).toBeLessThanOrEqual(bound);
      expect(Math.max(...long)).toBeLessThanOrEqual(Math.max(...short) + 2 * itemLen);
    });

    it('draws the same page as the whole message after every word, from a short list to a long one', () => {
      const live = render(<Bubble md="Here" incremental />);
      // Review 2026-10-22: 25 + 25 items (was 30 + 30). Still past two chunk freezes (40+ items), about 40% less CPU.
      let md = listMd(25);
      live.rerender(<Bubble md={md} incremental />);
      const whole = render(<></>);
      const deltas = tokenDeltas(lines(25, (i) => item(i + 25)) + '\n- tail');
      deltas.forEach((d, i) => {
        md += d;
        live.rerender(<Bubble md={md} incremental />);
        if (i % 40 === 0 || i === deltas.length - 1) {
          whole.rerender(<Bubble key={i} md={md} />);
          expect(canonical(live.container), `after word ${i}`).toBe(canonical(whole.container));
        }
      });
      whole.unmount();
      live.unmount();
    });

    it('keeps numbering (start=) and the same list element across chunks of a numbered list', () => {
      const num = (i: number) => `${i + 7}. step ${i} with \`code\``;
      const md0 = `Steps:\n\n${lines(45, num)}\n`;
      const live = render(<Bubble md="Steps:" incremental />);
      live.rerender(<Bubble md={md0} incremental />);
      const ol = live.container.querySelector('ol')!;
      let md = md0;
      const whole = render(<></>);
      for (const d of tokenDeltas(lines(60, (i) => num(i + 45)) + '\n')) {
        md += d;
        live.rerender(<Bubble md={md} incremental />);
      }
      expect(live.container.querySelector('ol')).toBe(ol);
      expect(ol.getAttribute('start')).toBe('7');
      expect(ol.querySelectorAll(':scope > li')).toHaveLength(105);
      whole.rerender(<Bubble md={md} />);
      expect(canonical(live.container)).toBe(canonical(whole.container));
      whole.unmount();
      live.unmount();
    });

    it('draws nested items, lazy lines and a still-growing item like the whole message', () => {
      const rows = (i: number) => (i % 9 === 3 ? `- parent ${i}\n  - child a ${i}\n  - child b ${i}\n    deeper text` : i % 9 === 5 ? `- wrapped ${i}\nlazy continuation ${i}` : item(i));
      const md0 = `Intro\n\n${lines(60, rows)}\n`;
      const live = render(<Bubble md="Intro" incremental />);
      live.rerender(<Bubble md={md0} incremental />);
      let md = md0;
      const deltas = tokenDeltas(lines(14, (i) => rows(i + 60)) + '\n- last item still being typed');
      deltas.forEach((d, i) => {
        md += d;
        live.rerender(<Bubble md={md} incremental />);
        if (i % 25 === 0 || i === deltas.length - 1) expect(canonical(live.container)).toBe(wholeHtml(md));
      });
      live.unmount();
    });

    // Things that change how the items above are drawn must fall back to the whole list.
    for (const [name, tail] of [
      ['a blank line makes the list loose', '\n- loose item\n\n- another'],
      ['another bullet character starts a second list', '* star item\n* star two'],
      ['a task item adds a class to the list', '- [ ] a task\n- [x] done'],
      ['a paragraph after a blank line ends the list', '\nClosing words.'],
    ] as const) {
      it(`draws the same page as the whole message when ${name}`, () => {
        const live = render(<Bubble md="Here" incremental />);
        let md = listMd(70);
        live.rerender(<Bubble md={md} incremental />);
        for (const d of tokenDeltas(tail)) {
          md += d;
          live.rerender(<Bubble md={md} incremental />);
          expect(canonical(live.container), `after ${JSON.stringify(d)}`).toBe(wholeHtml(md));
        }
        live.unmount();
      });
    }

    // A bubble that MOUNTS part-way through a reply (renderer busy, hidden chat) draws what it was given as
    // one group with the reply's first paragraphs in front of the list (found by the 5000-item lab rungs).
    it('stays bounded and equal to the whole message when the bubble mounts in the middle of the list', () => {
      const mount = `Here are the files:\n\nA second paragraph.\n\n${lines(70, item)}\n`;
      const live = render(<Bubble md={mount} incremental />);
      const ul = () => live.container.querySelector('ul');
      let md = mount;
      const costs: number[] = [];
      const whole = render(<></>);
      // Review 2026-10-22: mounts at 70 items and adds 30 (was 100 + 45): still mid-list, past one freeze, ~35% less CPU.
      const more = tokenDeltas(lines(30, (i) => item(i + 70)) + '\n');
      more.forEach((d, i) => {
        md += d;
        markdownRenders.length = 0;
        splitterParsed.chars = 0;
        live.rerender(<Bubble md={md} incremental />);
        costs.push(markdownRenders.reduce((n, x) => n + x.length, 0));
        if (i === 0) costs.length = 0; // the update that first splits the message may parse it once
        if (i % 200 === 0 || i === more.length - 1) {
          whole.rerender(<Bubble key={i} md={md} />);
          expect(canonical(live.container), `after word ${i}`).toBe(canonical(whole.container));
        }
      });
      const itemLen = item(300).length + 1;
      expect(Math.max(...costs.slice(1))).toBeLessThanOrEqual((2 * OPEN_LIST_CHUNK_ITEMS + 3) * itemLen + 100);
      expect(ul()).not.toBeNull();
      whole.unmount();
      live.unmount();
    });

    // Review findings on c9c1328bc: things in FRONT of the list that change how its items read.
    describe('text in front of the list that changes how items are drawn', () => {
      const refItem = (i: number, ref: string) => `- see ${ref} ${i}`;
      const same = (before: string, list: string, streamed = false) => {
        const full = before + list;
        const live = render(<Bubble md="Hi" incremental />);
        if (streamed) {
          let md = '';
          for (const d of tokenDeltas(full)) { md += d; live.rerender(<Bubble md={md} incremental />); }
        } else {
          live.rerender(<Bubble md={full} incremental />);
        }
        expect(canonical(live.container)).toBe(wholeHtml(full));
        const lis = live.container.querySelectorAll('li').length;
        live.unmount();
        return lis;
      };

      it('keeps link definitions that sit in the same group as the list (bubble mounted mid-reply)', () => {
        const list = lines(70, (i) => refItem(i, '[foo]')) + '\n';
        expect(same('[foo]: http://x.com\n\nHi\n\n', list)).toBe(70);
        const live = render(<Bubble md={'Hi'} incremental />);
        live.rerender(<Bubble md={'[foo]: http://x.com\n\nHi\n\n' + list} incremental />);
        expect(live.container.querySelectorAll('a[href="http://x.com"]').length).toBe(70);
        live.unmount();
      });

      it('keeps footnote references when the footnote is defined before the list', () => {
        const list = lines(70, (i) => refItem(i, '[^1]').replace('see [^1]', 'see[^1]')) + '\n';
        same('Hi[^1]\n\n[^1]: note\n\n', list, true);
      });

      for (const [name, before] of [
        ['an open <pre> block', '<pre>\n\n'],
        ['an open HTML comment', '<!-- c\n\n'],
        ['a ~~~ line inside a backtick fence', '```\n~~~\n\nfoo\n\n'],
      ] as const) {
        it(`never loses finished items when the text before the list is ${name}`, () => {
          const list = lines(70, item) + '\n';
          same(before, list);
          same(before, list, true);
        });
      }

      it('treats a line ending that changes part-way through the stream like the whole message', () => {
        const live = render(<Bubble md="Hi" incremental />);
        let md = `Hi\n\n${lines(60, item)}\n`;
        live.rerender(<Bubble md={md} incremental />);
        for (const tail of ['\r\n- crlf one\r\n- crlf two\r\n', '- bare cr\r- another\r']) {
          md += tail;
          live.rerender(<Bubble md={md} incremental />);
          expect(canonical(live.container)).toBe(wholeHtml(md));
        }
        live.unmount();
      });
    });

    it('draws a finished or stopped reply as ONE list, whatever was chunked while it streamed', () => {
      const md = listMd(120);
      const live = render(<Bubble md="Here" incremental />);
      live.rerender(<Bubble md={md} incremental />);
      expect(markdownRenders.some((x) => x.startsWith('- path 100'))).toBe(true);
      markdownRenders.length = 0;
      live.rerender(<Bubble md={md} incremental live={false} />);
      // The end-of-reply cost: the list is drawn once, whole.
      expect(markdownRenders.some((x) => x.startsWith('- path 0:') && x.includes('path 119'))).toBe(true);
      const whole = render(<MarkdownContent content={md} sessionId="s1" />);
      expect(canonical(live.container)).toBe(canonical(whole.container));
      whole.unmount();
      live.unmount();
    });
  });
});
