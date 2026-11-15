// An automation's permission list, asked the way a running assistant asks: (tool, subject).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildJobDecide } from '../src/main/automations/job-decide';
import type { AutomationTool } from '../src/shared/automation-types';

let root: string;
let home: string;
let work: string;

beforeEach(() => {
  // realpath: on macOS the temp folder is itself a link, and the code under test compares real locations.
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'job-decide-')));
  home = path.join(root, 'home');
  work = path.join(root, 'work');
  mkdirSync(path.join(home, 'Downloads'), { recursive: true });
  mkdirSync(path.join(home, 'Secret'), { recursive: true });
  mkdirSync(work, { recursive: true });
  writeFileSync(path.join(home, 'Secret', 'tax.pdf'), 'x');
});
afterEach(() => { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });

const tool = (over: Partial<AutomationTool>): AutomationTool => ({ id: 't', label: 'x', source: 'Your computer', mode: 'allow', ...over });
const decideWith = (tools: AutomationTool[], unlisted = { sites: 'never' as const, commands: 'never' as const }, onAsk?: (id: string | undefined) => void) =>
  buildJobDecide({ rules: () => ({ tools, unlisted, links: [{ kind: 'page', id: 'p1', name: 'P' }] }), workDir: work, home, onAsk });

describe('an automation run asking before each step', () => {
  it('reads inside an allowed folder, and is refused a change there without a change permission', async () => {
    const decide = decideWith([tool({ kind: 'folder', exact: '~/Downloads' })]);
    expect((await decide('Read', path.join(home, 'Downloads', 'a.txt'))).action).toBe('allow');
    expect((await decide('Glob', path.join(home, 'Downloads'))).action).toBe('allow');
    const refused = await decide('Write', path.join(home, 'Downloads', 'new.txt'));
    expect(refused.action).toBe('deny');
    expect(refused.message).toMatch(/not allowed/);
  });

  it('a link inside an allowed folder does not reach what it points to', async (ctx) => {
    try { symlinkSync(path.join(home, 'Secret'), path.join(home, 'Downloads', 'shortcut'), 'dir'); }
    catch { ctx.skip(); return; } // Windows without the right to make links
    const decide = decideWith([tool({ kind: 'folder', exact: '~/Downloads' })]);
    expect((await decide('Read', path.join(home, 'Downloads', 'shortcut', 'tax.pdf'))).action).toBe('deny');
  });

  it('always lets the run use its own work folder, by a path written from inside it', async () => {
    const decide = decideWith([]);
    expect((await decide('Write', 'notes.md')).action).toBe('allow');
    expect((await decide('Read', path.join(work, 'notes.md'))).action).toBe('allow');
    expect((await decide('Write', path.join('..', 'home', 'Secret', 'x'))).action).toBe('deny');
  });

  it('asks for a step set to Asks first and names the permission it falls under', async () => {
    const asked: (string | undefined)[] = [];
    const decide = decideWith([tool({ id: 'send', kind: 'command', exact: 'mail -s hi sam', mode: 'ask' })], undefined, (id) => asked.push(id));
    expect((await decide('Bash', 'mail -s hi sam')).action).toBe('ask');
    expect(asked).toEqual(['send']);
  });

  it('checks a website by its site, and a page by the link to it', async () => {
    const decide = decideWith([tool({ kind: 'site', exact: 'bestbuy.com' }), tool({ kind: 'page-read' })]);
    expect((await decide('WebFetch', 'bestbuy.com')).action).toBe('allow');
    expect((await decide('WebFetch', 'evil.net')).action).toBe('deny');
    expect((await decide('mcp__youcoded-pages__ReadPageData', 'p1')).action).toBe('allow');
    expect((await decide('mcp__youcoded-pages__UpdatePageData', 'p1')).action).toBe('deny');
    expect((await decide('ReadPageData', 'other')).action).toBe('deny');
  });

  it('refuses a tool no permission can cover, and allows the run its own to-do list', async () => {
    const decide = decideWith([], { sites: 'ask', commands: 'ask' } as never);
    expect((await decide('WebSearch', 'anything')).action).toBe('deny');
    expect((await decide('AskUserQuestion', undefined)).action).toBe('deny');
    expect((await decide('TodoWrite', undefined)).action).toBe('allow');
  });

  it('refuses everything once the automation is gone', async () => {
    const decide = buildJobDecide({ rules: () => undefined, workDir: work, home });
    expect((await decide('TodoWrite', undefined)).action).toBe('deny');
  });
});
