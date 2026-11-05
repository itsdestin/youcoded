// The page's earlier versions (pages-finish step 3, the Undo round): a version before each request, Put back of
// any of them, and nothing ever lost — putting one back saves what was there first.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PageVersions, MAX_VERSIONS, versionLabel } from '../src/main/pages/page-versions';

let root: string;
let pageDir: string;
let versions: PageVersions;
const write = (f: string, body: string) => fs.writeFile(path.join(pageDir, f), body);
const read = (f: string) => fs.readFile(path.join(pageDir, f), 'utf8').catch(() => null);

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'page-versions-'));
  pageDir = path.join(root, 'Personal', 'Pages', 'money');
  await fs.mkdir(pageDir, { recursive: true });
  await write('page.html', '<p>one</p>');
  await write('data.json', '{"data":{"n":1}}');
  versions = new PageVersions({ root: () => path.join(root, 'app'), pageDir: async (id) => (id === 'personal:money' ? pageDir : null) });
});
afterEach(() => { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });

describe('page versions', () => {
  it('saves the page before a request and lists it newest first with what changed after it', async () => {
    await versions.checkpoint('personal:money', 'add a savings box');
    await write('page.html', '<p>two</p>');
    await versions.checkpoint('personal:money', 'move netflix to the 15th');
    await write('data.json', '{"data":{"n":2}}');
    const list = await versions.list('personal:money');
    expect(list.map((v) => [v.label, v.change])).toEqual([
      ['move netflix to the 15th', 'data'],
      ['add a savings box', 'page'],
    ]);
  });

  it('a request that changed nothing passes its place to the next one instead of adding a version', async () => {
    await versions.checkpoint('personal:money', 'why was october high?');
    await versions.checkpoint('personal:money', 'add a savings box');
    const list = await versions.list('personal:money');
    expect(list).toHaveLength(1);
    expect(list[0].label).toBe('add a savings box');
    expect(list[0].change).toBeNull();
  });

  it('puts any version back, saving what was there first so it can be put back too', async () => {
    await versions.checkpoint('personal:money', 'first');
    await write('page.html', '<p>two</p>');
    await write('page.md', 'notes');
    await versions.checkpoint('personal:money', 'second');
    await write('page.html', '<p>three</p>');
    const oldest = (await versions.list('personal:money')).at(-1)!;
    expect(await versions.restore('personal:money', oldest.at, 'Before putting back')).toEqual({ ok: true });
    expect(await read('page.html')).toBe('<p>one</p>');
    // page.md did not exist then, so it is gone now.
    expect(await read('page.md')).toBeNull();
    const after = await versions.list('personal:money');
    expect(after[0].label).toBe('Before putting back');
    await versions.restore('personal:money', after[0].at, 'again');
    expect(await read('page.html')).toBe('<p>three</p>');
    expect(await read('page.md')).toBe('notes');
  });

  it('keeps at most the newest versions and labels a request by its first line', async () => {
    for (let i = 0; i < MAX_VERSIONS + 3; i++) {
      await write('page.html', `<p>${i}</p>`);
      await versions.checkpoint('personal:money', `\n  request ${i}\nmore`);
    }
    const list = await versions.list('personal:money');
    expect(list).toHaveLength(MAX_VERSIONS);
    expect(list[0].label).toBe(`request ${MAX_VERSIONS + 2}`);
    expect(versionLabel('x'.repeat(300))).toHaveLength(120);
  });

  it('refuses an unknown page or version plainly', async () => {
    expect(await versions.checkpoint('personal:gone', 'x')).toBe(false);
    expect(await versions.restore('personal:money', 123, 'x')).toEqual({ ok: false, message: 'That version is no longer saved.' });
  });
});
