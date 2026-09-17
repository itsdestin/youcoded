// YouCoded Pages — the store behind window.claude.pages (Phase 1).
// Pins: ids match across devices, conflict copies fold the way the design says
// (data by savedAt, html remote-wins), the pin cap and the data cap are
// enforced in main, and a folder without a document is not a page.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PagesStore, isUnderPagesDir, slugFromId } from '../src/main/pages/pages-store';
import { MAX_PAGE_DATA_BYTES, MAX_PINNED_PAGES } from '../src/shared/pages-types';

let root: string;
let personal: string;
let project: string;
let store: PagesStore;

async function writePage(home: string, slug: string, opts: { name?: string; icon?: string; html?: string } = {}) {
  const dir = path.join(home, 'Pages', slug);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'page.json'), JSON.stringify({ name: opts.name ?? slug, description: 'd', icon: opts.icon ?? 'page' }));
  await fs.writeFile(path.join(dir, 'page.html'), opts.html ?? '<!doctype html><html><body>hi</body></html>');
  return dir;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'pages-store-'));
  personal = path.join(root, 'Personal');
  project = path.join(root, 'Projects', 'demo');
  store = new PagesStore({
    personalRoot: () => personal,
    listProjects: async () => [{ name: 'demo', path: project }],
    deviceId: () => 'dev-1',
    localFallbackDir: () => path.join(root, 'local'),
  });
});
afterEach(() => { rmSync(root, { recursive: true, force: true, maxRetries: 3 }); });

describe('listing', () => {
  it('lists personal and project pages with device-stable ids and stamps from the files', async () => {
    await writePage(personal, 'focus-timer', { name: 'Focus timer', icon: 'timer' });
    await writePage(project, 'paint', { name: 'Paint', icon: 'paint' });
    const pages = await store.list();
    expect(pages.map((p) => p.id).sort()).toEqual(['personal:focus-timer', 'project:demo:paint']);
    const timer = pages.find((p) => p.id === 'personal:focus-timer')!;
    expect(timer.home).toEqual({ kind: 'personal' });
    expect(timer.icon).toBe('timer');
    expect(timer.htmlStamp).toBeGreaterThan(0);
    expect(pages.find((p) => p.id === 'project:demo:paint')!.home).toEqual({ kind: 'project', path: project, name: 'demo' });
  });

  it('ignores a folder with a manifest but no document, an unknown icon falls back to page, and slugs collide case-insensitively', async () => {
    const dir = path.join(personal, 'Pages', 'half');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'page.json'), JSON.stringify({ name: 'Half' }));
    await writePage(personal, 'notes', { icon: 'rocket' });
    await writePage(personal, 'Notes');
    const pages = await store.list();
    expect(pages.map((p) => p.id)).not.toContain('personal:half');
    expect(pages.filter((p) => p.id.toLowerCase() === 'personal:notes')).toHaveLength(1);
    expect(pages.find((p) => p.id.toLowerCase() === 'personal:notes')!.icon).toBe('page');
  });
});

describe('get', () => {
  it('returns the document with folded data, and a missing failure for an unknown id', async () => {
    const dir = await writePage(personal, 'planner', { html: '<html><body>plan</body></html>' });
    await fs.writeFile(path.join(dir, 'data.json'), JSON.stringify({ savedAt: '2026-09-17T10:00:00Z', data: { events: 3 } }));
    const r = await store.get('personal:planner');
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.page.html).toContain('plan'); expect(r.page.data).toEqual({ events: 3 }); }
    const miss = await store.get('personal:nope');
    expect(miss.ok).toBe(false);
    if (!miss.ok) expect(miss.failure.kind).toBe('missing');
  });

  it('folds a data.json conflict copy by savedAt (later save wins) and removes the copy', async () => {
    const dir = await writePage(personal, 'planner');
    await fs.writeFile(path.join(dir, 'data.json'), JSON.stringify({ savedAt: '2026-09-17T10:00:00Z', data: 'old' }));
    await fs.writeFile(path.join(dir, 'data (from laptop, 2026-09-17).json'), JSON.stringify({ savedAt: '2026-09-17T11:00:00Z', data: 'new' }));
    const r = await store.get('personal:planner');
    if (r.ok) expect(r.page.data).toBe('new');
    expect((await fs.readdir(dir)).filter((n) => n.includes('from laptop'))).toHaveLength(0);
    expect(JSON.parse(await fs.readFile(path.join(dir, 'data.json'), 'utf8')).data).toBe('new');
  });

  it('keeps the checked-out page.html on a conflict (remote wins) and removes our copy', async () => {
    const dir = await writePage(personal, 'planner', { html: '<html>theirs</html>' });
    await fs.writeFile(path.join(dir, 'page (from laptop, 2026-09-17).html'), '<html>ours</html>');
    const r = await store.get('personal:planner');
    if (r.ok) expect(r.page.html).toBe('<html>theirs</html>');
    expect((await fs.readdir(dir)).filter((n) => n.endsWith('.html'))).toEqual(['page.html']);
  });
});

describe('pins', () => {
  it('writes this device\'s pin file beside the pages and caps pins at MAX_PINNED_PAGES', async () => {
    for (let i = 0; i < MAX_PINNED_PAGES + 1; i++) await writePage(personal, `p${i}`);
    for (let i = 0; i < MAX_PINNED_PAGES + 1; i++) await store.setPinned(`personal:p${i}`, true);
    const pages = await store.list();
    expect(pages.filter((p) => p.pinned)).toHaveLength(MAX_PINNED_PAGES);
    expect(pages.find((p) => p.id === `personal:p${MAX_PINNED_PAGES}`)!.pinned).toBe(false);
    const pinFile = path.join(personal, 'Pages', '.pins', 'dev-1.json');
    expect(JSON.parse(await fs.readFile(pinFile, 'utf8')).pinned).toHaveLength(MAX_PINNED_PAGES);
    await store.setPinned('personal:p0', false);
    expect((await store.list()).find((p) => p.id === 'personal:p0')!.pinned).toBe(false);
  });

  it('falls back to a local file when there is no device id', async () => {
    const local = new PagesStore({
      personalRoot: () => personal, listProjects: async () => [], deviceId: () => null, localFallbackDir: () => path.join(root, 'local'),
    });
    await writePage(personal, 'x');
    await local.setPinned('personal:x', true);
    expect((await local.list())[0].pinned).toBe(true);
    await expect(fs.stat(path.join(root, 'local', 'pages-pins.json'))).resolves.toBeTruthy();
  });
});

describe('data', () => {
  it('writes an envelope with savedAt, refuses over the cap and for an unknown page, and leaves the html stamp alone', async () => {
    const dir = await writePage(personal, 'notes');
    const before = (await store.list())[0].htmlStamp;
    const ok = await store.setData('personal:notes', { a: 1 });
    expect(ok).toEqual({ ok: true });
    const env = JSON.parse(await fs.readFile(path.join(dir, 'data.json'), 'utf8'));
    expect(env.data).toEqual({ a: 1 });
    expect(Date.parse(env.savedAt)).toBeGreaterThan(0);
    expect((await store.list())[0].htmlStamp).toBe(before);
    const big = await store.setData('personal:notes', 'x'.repeat(MAX_PAGE_DATA_BYTES + 1));
    expect(big.ok).toBe(false);
    expect((await store.setData('personal:nope', 1)).ok).toBe(false);
  });
});

describe('helpers', () => {
  it('slugFromId and isUnderPagesDir', () => {
    expect(slugFromId('project:my-app:week-planner')).toBe('week-planner');
    expect(isUnderPagesDir('/p', '/p/Pages/x/page.html')).toBe(true);
    expect(isUnderPagesDir('/p', 'Pages/x/data.json')).toBe(true);
    expect(isUnderPagesDir('/p', '/p/src/Pages.tsx')).toBe(false);
  });
});
