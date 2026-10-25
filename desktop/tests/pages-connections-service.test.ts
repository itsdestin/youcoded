// Approving a page's connections, and where "Updated 2m" comes from.
//
// The store and the door have their own files (page-connections-store,
// page-fetch); this pins the part that joins them — what Allow writes, what it
// refuses to write, and the rule that only a request that actually worked may
// move the time on the band.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { safeStorage } from 'electron';
import { SecretsStore } from '../src/main/providers/secrets-store';
import { getSecretStorage } from '../src/main/providers/secret-storage';
import { PageConnectionsStore, CONNECTIONS_FILE } from '../src/main/pages/connections-store';
import { initPagesService } from '../src/main/pages/pages-service';
import type { PageSummary } from '../src/shared/pages-types';

const WEATHER = {
  id: 'weather', kind: 'key', service: 'OpenWeather', address: 'api.openweathermap.org',
  access: 'lookup', keyIn: 'query', keyParam: 'appid',
};
const KEY = 'sk-page-secret-value';

let root: string;
let personal: string;
let userData: string;
let broadcasts: PageSummary[][];
let service: ReturnType<typeof initPagesService>;
let fetchMock: ReturnType<typeof vi.fn>;

async function writePage(slug: string, connections: unknown[]) {
  const dir = path.join(personal, 'Pages', slug);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'page.json'), JSON.stringify({ name: slug, description: 'd', icon: 'page', connections }));
  await fs.writeFile(path.join(dir, 'page.html'), '<!doctype html><html><body>hi</body></html>');
}

function start(extra: Partial<Parameters<typeof initPagesService>[0]> = {}) {
  fetchMock = vi.fn().mockResolvedValue(new Response('{"temp":7}', { status: 200 }));
  broadcasts = [];
  service = initPagesService({
    ...extra,
    personalRoot: () => personal,
    listProjects: async () => [],
    deviceId: () => 'dev-1',
    localFallbackDir: () => path.join(root, 'local'),
    connections: new PageConnectionsStore(userData, new SecretsStore(userData, getSecretStorage())),
    broadcast: (pages) => { broadcasts.push(pages); },
    fetchImpl: fetchMock as unknown as typeof fetch,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
  });
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'pages-connections-'));
  personal = path.join(root, 'Personal');
  userData = path.join(root, 'userData');
  start();
});
afterEach(() => {
  vi.restoreAllMocks();
  service.stop();
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

describe('a page that wants something', () => {
  it('lists as waiting until it is allowed, then as allowed', async () => {
    await writePage('weather', [WEATHER]);
    const before = (await service.listAndWatch())[0];
    expect(before.connections).toMatchObject([{ id: 'weather', approved: false, savedKey: false }]);
    expect(before.refresh).toBeUndefined();

    const result = await service.approve('personal:weather', { weather: KEY }, { remote: false });
    expect(result.ok).toBe(true);
    const after = (await service.listAndWatch())[0];
    expect(after.connections).toMatchObject([{ id: 'weather', approved: true, savedKey: true }]);
    // The band appears only once the page can actually reach something.
    expect(after.refresh).toEqual({ at: null, failed: false });
  });

  it('records no approval at all when the computer cannot store the key', async () => {
    vi.spyOn(safeStorage, 'isEncryptionAvailable').mockReturnValue(false);
    await writePage('weather', [WEATHER]);
    const result = await service.approve('personal:weather', { weather: KEY }, { remote: false });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toBeTruthy();
    expect((await service.listAndWatch())[0].connections).toMatchObject([{ approved: false }]);
  });

  it('refuses a pasted key from a phone, and never writes one', async () => {
    await writePage('weather', [WEATHER]);
    const result = await service.approve('personal:weather', { weather: KEY }, { remote: true });
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining('computer running YouCoded') });
    expect((await service.listAndWatch())[0].connections).toMatchObject([{ approved: false }]);
  });

  it('lets a phone reuse a key the computer already holds', async () => {
    await writePage('weather', [WEATHER]);
    await service.approve('personal:weather', { weather: KEY }, { remote: false });
    await service.removeConnection('personal:weather', 'weather');
    const again = await service.approve('personal:weather', { weather: 'saved' }, { remote: true });
    expect(again.ok).toBe(true);
  });

  it('says so when it is asked to reuse a key nothing has saved', async () => {
    await writePage('weather', [WEATHER]);
    const result = await service.approve('personal:weather', { weather: 'saved' }, { remote: false });
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining('OpenWeather') });
  });

  it('never writes the key itself into the approvals file', async () => {
    await writePage('weather', [WEATHER]);
    await service.approve('personal:weather', { weather: KEY }, { remote: false });
    expect(readFileSync(path.join(userData, CONNECTIONS_FILE), 'utf8')).not.toContain(KEY);
  });
});

describe('the time on the band', () => {
  it('moves only on a request that actually worked', async () => {
    await writePage('weather', [WEATHER]);
    await service.approve('personal:weather', { weather: KEY }, { remote: false });

    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }));
    await service.fetch('personal:weather', { url: 'https://api.openweathermap.org/data' });
    expect((await service.listAndWatch())[0].refresh).toEqual({ at: null, failed: true });

    fetchMock.mockResolvedValue(new Response('{"temp":7}', { status: 200 }));
    await service.fetch('personal:weather', { url: 'https://api.openweathermap.org/data' });
    const fresh = (await service.listAndWatch())[0].refresh!;
    expect(fresh.failed).toBe(false);
    expect(fresh.at).toBeTruthy();

    // A later refusal keeps the last true time and marks the failure; it does
    // not pretend the page was updated just now.
    fetchMock.mockResolvedValue(new Response('nope', { status: 403 }));
    await service.fetch('personal:weather', { url: 'https://api.openweathermap.org/data' });
    expect((await service.listAndWatch())[0].refresh).toEqual({ at: fresh.at, failed: true });
  });

  it('is not written to disk, because a fetch may happen sixty times a minute', async () => {
    await writePage('weather', [WEATHER]);
    await service.approve('personal:weather', { weather: KEY }, { remote: false });
    await service.fetch('personal:weather', { url: 'https://api.openweathermap.org/data' });
    const saved = JSON.parse(readFileSync(path.join(userData, CONNECTIONS_FILE), 'utf8'));
    expect(JSON.stringify(saved)).not.toContain('failed');
    expect(Object.keys(saved)).toEqual(['version', 'pages', 'keys', 'openSites', 'folders', 'remembered']);
  });
});

describe('a connections file this build cannot read', () => {
  it('pauses every page rather than guessing at a grant', async () => {
    await writePage('weather', [WEATHER]);
    await service.approve('personal:weather', { weather: KEY }, { remote: false });
    await fs.writeFile(path.join(userData, CONNECTIONS_FILE), JSON.stringify({ version: 99, pages: {}, keys: {} }));

    expect((await service.listAndWatch())[0].connections).toMatchObject([{ approved: false }]);
    const blocked = await service.fetch('personal:weather', { url: 'https://api.openweathermap.org/data' });
    expect(blocked).toMatchObject({ ok: false, reason: 'not-approved' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('managing saved keys', () => {
  it('names each key by service and address and says which pages use it', async () => {
    await writePage('weather', [WEATHER]);
    await writePage('second', [{ ...WEATHER, id: 'w2' }]);
    await service.approve('personal:weather', { weather: KEY }, { remote: false });
    await service.approve('personal:second', { w2: 'saved' }, { remote: false });
    expect(await service.savedKeys()).toEqual([{
      service: 'OpenWeather', address: 'api.openweathermap.org',
      usedBy: [{ id: 'personal:second', name: 'second' }, { id: 'personal:weather', name: 'weather' }],
    }]);
  });

  it('deleting one cuts off every page that stood on it', async () => {
    await writePage('weather', [WEATHER]);
    await service.approve('personal:weather', { weather: KEY }, { remote: false });
    expect(await service.deleteSavedKey('OpenWeather', 'api.openweathermap.org')).toEqual([]);
    const after = (await service.listAndWatch())[0];
    expect(after.connections).toMatchObject([{ approved: false, savedKey: false }]);
    expect(after.refresh).toBeUndefined();
  });
});

describe('a page whose code changed after it was allowed', () => {
  const PUBLIC = { id: 'feed', kind: 'public', address: 'hnrss.org' };
  async function rewrite(slug: string, body: string) {
    const file = path.join(personal, 'Pages', slug, 'page.html');
    await fs.writeFile(file, `<!doctype html><html><body>${body}</body></html>`);
    // A distinct mtime, so the store's per-mtime hash cache cannot hide it.
    const later = new Date(Date.now() + 60_000);
    await fs.utimes(file, later, later);
  }

  it('says so, keeps its connections allowed, and clears when dismissed', async () => {
    await writePage('feed', [PUBLIC]);
    await service.approve('personal:feed', {}, { remote: false });
    expect((await service.listAndWatch())[0].codeChanged).toBeUndefined();

    await rewrite('feed', 'rewritten');
    const changed = (await service.listAndWatch())[0];
    expect(changed.codeChanged).toBe(true);
    // Information, not a gate: what was allowed is still allowed.
    expect(changed.connections).toMatchObject([{ id: 'feed', approved: true }]);

    const dismissed = await service.approve('personal:feed', {}, { remote: false });
    expect(dismissed.ok).toBe(true);
    expect((await service.listAndWatch())[0].codeChanged).toBeUndefined();
  });

  it('cannot widen what a page reaches by dismissing', async () => {
    await writePage('feed', [PUBLIC]);
    await service.approve('personal:feed', {}, { remote: false });
    // The page now also asks for a second address, and its code changed.
    await writePage('feed', [PUBLIC, { id: 'more', kind: 'public', address: 'example.org' }]);
    await rewrite('feed', 'asks for more');
    const page = (await service.listAndWatch())[0];
    // A page with a line waiting shows its approval card, not the quiet note.
    expect(page.codeChanged).toBeUndefined();
    expect(page.connections).toMatchObject([{ id: 'feed', approved: true }, { id: 'more', approved: false }]);
  });
});

// Page start session (spec 2026-10-14, §3): the approval to open a new
// conversation is keyed to the manifest line, never the page's code — Frontier
// Lab bakes its data into page.html every week, and that must not re-ask or
// show the "code changed" note. A page with another approval still gets it.
describe('a page that may open a new conversation', () => {
  const SESSION = { id: 'start-session', kind: 'session' };
  const PUBLIC = { id: 'feed', kind: 'public', address: 'hnrss.org' };
  async function rewrite(slug: string, body: string) {
    const file = path.join(personal, 'Pages', slug, 'page.html');
    await fs.writeFile(file, `<!doctype html><html><body>${body}</body></html>`);
    const later = new Date(Date.now() + 60_000);
    await fs.utimes(file, later, later);
  }

  it('asks once, then never again and never notes a code change when only the page changes', async () => {
    await writePage('lab', [SESSION]);
    expect((await service.listAndWatch())[0].connections).toMatchObject([{ id: 'start-session', approved: false }]);
    expect((await service.approve('personal:lab', {}, { remote: false })).ok).toBe(true);

    await rewrite('lab', 'this week, rebuilt');
    await fs.writeFile(path.join(personal, 'Pages', 'lab', 'data.json'), '{"week":2}');
    const after = (await service.listAndWatch())[0];
    expect(after.connections).toMatchObject([{ id: 'start-session', approved: true }]);
    expect(after.codeChanged).toBeUndefined();
    // Nothing is fetched by this kind, so the band's "last updated" has nothing to be about.
    expect(after.refresh).toBeUndefined();
  });

  it('still notes a code change on a page that also reaches an address', async () => {
    await writePage('mixed', [SESSION, PUBLIC]);
    await service.approve('personal:mixed', {}, { remote: false });
    await rewrite('mixed', 'rewritten');
    const page = (await service.listAndWatch())[0];
    expect(page.codeChanged).toBe(true);
    expect(page.refresh).toEqual({ at: null, failed: false });
  });

  // Review F7: dismissing "code changed" on a mixed page restamps the address
  // line only; a session line that gained a hash would show the note again
  // after the next weekly rebuild once the address line is gone.
  it('leaves the session line without a code hash when the note is dismissed', async () => {
    await writePage('mixed', [SESSION, PUBLIC]);
    await service.approve('personal:mixed', {}, { remote: false });
    await rewrite('mixed', 'rewritten');
    expect((await service.listAndWatch())[0].codeChanged).toBe(true);
    expect((await service.approve('personal:mixed', {}, { remote: false })).ok).toBe(true);
    const saved = JSON.parse(readFileSync(path.join(userData, CONNECTIONS_FILE), 'utf8'));
    const records = Object.values(saved.pages as Record<string, Record<string, { htmlHash?: string }>>)[0];
    expect(records.feed.htmlHash).toEqual(expect.any(String));
    // '' is how a session line records "no code hash" (pages-service approve).
    expect(records['start-session'].htmlHash).toBe('');
  });
});


// Programs a page runs (spec 2026-10-16). What is pinned: the approval follows the program FILE (an edited
// file asks again, an edited page does not), and a program runs only for an approved line whose file is
// exactly the one that was approved — checked again at the moment of the run, not only in the listing.
describe('a page that runs a program', () => {
  const PROGRAM = { id: 'work', kind: 'program', file: 'work-items.mjs' };
  const ECHO = 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write("echo:"+s));';
  const OWNER = 'window:1';
  const dirOf = (slug: string) => path.join(personal, 'Pages', slug);
  const writeProgram = (slug: string, file: string, body: string) => fs.writeFile(path.join(dirOf(slug), file), body);
  const connection = async () => (await service.listAndWatch())[0].connections!.find((c) => c.kind === 'program')!;
  // A program that says it has started, then runs until stopped. Tests wait for that file, not for a guess at how long a start takes.
  const LONG = 'import {writeFileSync} from "node:fs";writeFileSync("started.txt","1");setInterval(()=>{},1000);';
  const started = () => vi.waitFor(() => fs.access(path.join(dirOf('board'), 'started.txt')));

  it('lists as waiting until allowed, and allowing records the file it saw', async () => {
    await writePage('board', [PROGRAM]);
    await writeProgram('board', 'work-items.mjs', ECHO);
    expect(await connection()).toMatchObject({ approved: false });
    expect((await service.approve('personal:board', {}, { remote: false })).ok).toBe(true);
    expect(await connection()).toMatchObject({ approved: true });
    const records = JSON.parse(readFileSync(path.join(userData, CONNECTIONS_FILE), 'utf8')).pages['personal:board'];
    expect(records.work.programHash).toMatch(/^[0-9a-f]{64}$/);
    // Like a session line: no code hash, so rebuilding the page never shows "code changed".
    expect(records.work.htmlHash).toBe('');
  });

  it('asks again when the program file changes, and again says yes to the new one', async () => {
    await writePage('board', [PROGRAM]);
    await writeProgram('board', 'work-items.mjs', ECHO);
    await service.approve('personal:board', {}, { remote: false });
    await writeProgram('board', 'work-items.mjs', ECHO + '// edited');
    expect(await connection()).toMatchObject({ approved: false });
    expect((await service.listAndWatch())[0].refresh).toBeUndefined();
    expect((await service.approve('personal:board', {}, { remote: false })).ok).toBe(true);
    expect(await connection()).toMatchObject({ approved: true });
  });

  it('does not ask again, or show "code changed", when only the page is rewritten', async () => {
    await writePage('board', [PROGRAM]);
    await writeProgram('board', 'work-items.mjs', ECHO);
    await service.approve('personal:board', {}, { remote: false });
    await fs.writeFile(path.join(dirOf('board'), 'page.html'), '<!doctype html><html><body>rebuilt</body></html>');
    const page = (await service.listAndWatch())[0];
    expect(page.connections).toMatchObject([{ approved: true }]);
    expect(page.codeChanged).toBeUndefined();
    // A program-only page fetches nothing, so it shows no "last updated" band either.
    expect(page.refresh).toBeUndefined();
  });

  it('cannot be allowed when the file is missing, and says which file', async () => {
    await writePage('board', [PROGRAM]);
    const result = await service.approve('personal:board', {}, { remote: false });
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining('work-items.mjs') });
    expect(await connection()).toMatchObject({ approved: false });
  });

  it('is not approved when the file is replaced by a link', async () => {
    await writePage('board', [PROGRAM]);
    await writeProgram('board', 'real.mjs', ECHO);
    await service.approve('personal:board', {}, { remote: false }).catch(() => {});
    await fs.symlink(path.join(dirOf('board'), 'real.mjs'), path.join(dirOf('board'), 'work-items.mjs'));
    const result = await service.approve('personal:board', {}, { remote: false });
    expect(result.ok).toBe(false);
    expect(await connection()).toMatchObject({ approved: false });
  });

  it('runs an allowed program: stdin in, stdout out, in the page\'s own folder', async () => {
    await writePage('board', [PROGRAM]);
    await writeProgram('board', 'work-items.mjs', ECHO);
    await service.approve('personal:board', {}, { remote: false });
    expect(await service.runProgram(OWNER, 'personal:board', 'work-items.mjs', '{"hello":"wörld"}')).toEqual({ ok: true, output: 'echo:{"hello":"wörld"}', exitCode: 0 });
  });

  it('runs with the page\'s folder as its working folder', async () => {
    await writePage('board', [{ ...PROGRAM, file: 'where.mjs' }]);
    await writeProgram('board', 'where.mjs', 'process.stdout.write(process.cwd())');
    await service.approve('personal:board', {}, { remote: false });
    const r = await service.runProgram(OWNER, 'personal:board', 'where.mjs', '');
    expect(r.ok && (await fs.realpath(r.output))).toBe(await fs.realpath(dirOf('board')));
  });

  it('answers a failing program with its exit code and what it complained about', async () => {
    await writePage('board', [{ ...PROGRAM, file: 'fail.mjs' }]);
    await writeProgram('board', 'fail.mjs', 'process.stdout.write("partial");console.error("boom happened");process.exit(3);');
    await service.approve('personal:board', {}, { remote: false });
    expect(await service.runProgram(OWNER, 'personal:board', 'fail.mjs', '')).toEqual({ ok: true, output: 'partial', exitCode: 3, stderr: 'boom happened\n' });
  });

  it('refuses a program the page is not allowed to run, and runs nothing', async () => {
    await writePage('board', [PROGRAM]);
    await writeProgram('board', 'work-items.mjs', 'import {writeFileSync} from "node:fs";writeFileSync("ran.txt","x");');
    const notAllowed = { ok: false, reason: expect.stringContaining('not been allowed') };
    // Listed but not yet allowed.
    expect(await service.runProgram(OWNER, 'personal:board', 'work-items.mjs', '')).toMatchObject(notAllowed);
    // Not listed at all, even though the file is there.
    await writeProgram('board', 'other.mjs', 'import {writeFileSync} from "node:fs";writeFileSync("ran.txt","x");');
    await service.approve('personal:board', {}, { remote: false });
    expect(await service.runProgram(OWNER, 'personal:board', 'other.mjs', '')).toMatchObject(notAllowed);
    // A file outside the folder, and a page that does not exist.
    expect(await service.runProgram(OWNER, 'personal:board', '../board/work-items.mjs', '')).toMatchObject(notAllowed);
    expect(await service.runProgram(OWNER, 'personal:nobody', 'work-items.mjs', '')).toMatchObject(notAllowed);
    await expect(fs.access(path.join(dirOf('board'), 'ran.txt'))).rejects.toThrow();
  });

  it('refuses the program the moment its file differs from the one that was allowed', async () => {
    await writePage('board', [PROGRAM]);
    await writeProgram('board', 'work-items.mjs', ECHO);
    await service.approve('personal:board', {}, { remote: false });
    await writeProgram('board', 'work-items.mjs', 'import {writeFileSync} from "node:fs";writeFileSync("ran.txt","x");');
    // No listing happened in between: the run itself reads the file again.
    expect(await service.runProgram(OWNER, 'personal:board', 'work-items.mjs', '')).toMatchObject({ ok: false, reason: expect.stringContaining('changed') });
    await expect(fs.access(path.join(dirOf('board'), 'ran.txt'))).rejects.toThrow();
    await fs.rm(path.join(dirOf('board'), 'work-items.mjs'));
    expect(await service.runProgram(OWNER, 'personal:board', 'work-items.mjs', '')).toMatchObject({ ok: false, reason: expect.stringContaining('missing') });
  });

  it('refuses a file type it cannot run, and an input over 1 MB', async () => {
    await writePage('board', [{ ...PROGRAM, file: 'notes.txt' }, { ...PROGRAM, id: 'big', file: 'big.mjs' }]);
    await writeProgram('board', 'notes.txt', 'hello');
    await writeProgram('board', 'big.mjs', ECHO);
    await service.approve('personal:board', {}, { remote: false });
    expect(await service.runProgram(OWNER, 'personal:board', 'notes.txt', '')).toMatchObject({ ok: false, reason: expect.stringContaining('.txt') });
    expect(await service.runProgram(OWNER, 'personal:board', 'big.mjs', 'x'.repeat(1_000_001))).toMatchObject({ ok: false, reason: expect.stringContaining('1 MB') });
  });

  it('stops a program that prints more than 2 MB', async () => {
    await writePage('board', [PROGRAM]);
    await writeProgram('board', 'work-items.mjs', 'const b="x".repeat(65536);for(let i=0;i<60;i++)process.stdout.write(b);setInterval(()=>{},1000);');
    await service.approve('personal:board', {}, { remote: false });
    expect(await service.runProgram(OWNER, 'personal:board', 'work-items.mjs', '')).toMatchObject({ ok: false, reason: expect.stringContaining('2 MB') });
  });

  it('kills a program that runs past the time limit, and says so', async () => {
    service.stop();
    start({ programTimeoutMs: 400 });
    await writePage('board', [PROGRAM]);
    const pidFile = path.join(dirOf('board'), 'pid.txt');
    await writeProgram('board', 'work-items.mjs', `import {writeFileSync} from "node:fs";writeFileSync("pid.txt",String(process.pid));setInterval(()=>{},1000);`);
    await service.approve('personal:board', {}, { remote: false });
    const r = await service.runProgram(OWNER, 'personal:board', 'work-items.mjs', '');
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('longer than') });
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow(); // gone
  });

  it('stops when the page is closed, but only for the window that started it', async () => {
    await writePage('board', [PROGRAM]);
    await writeProgram('board', 'work-items.mjs', LONG);
    await service.approve('personal:board', {}, { remote: false });
    const running = service.runProgram(OWNER, 'personal:board', 'work-items.mjs', '');
    await started();
    service.stopPrograms('window:2', 'personal:board'); // another window cannot stop it
    service.stopPrograms(OWNER, 'personal:board');
    expect(await running).toMatchObject({ ok: false, reason: expect.stringContaining('closed') });
  });

  it('stops when its window goes away or the page loses an approval', async () => {
    await writePage('board', [PROGRAM]);
    await writeProgram('board', 'work-items.mjs', LONG);
    await service.approve('personal:board', {}, { remote: false });
    const a = service.runProgram(OWNER, 'personal:board', 'work-items.mjs', '');
    await started();
    service.closeOwner(OWNER);
    expect(await a).toMatchObject({ ok: false, reason: expect.stringContaining('window') });
    await fs.rm(path.join(dirOf('board'), 'started.txt'));
    const b = service.runProgram(OWNER, 'personal:board', 'work-items.mjs', '');
    await started();
    await service.removeConnection('personal:board', 'work');
    expect(await b).toMatchObject({ ok: false, reason: expect.stringContaining('stopped') });
  });
});

describe('opening a website for a page', () => {
  it('opens through the injected opener and remembers the site only when asked', async () => {
    const opened: string[] = [];
    service.stop();
    start({ openExternal: (url) => { opened.push(url); } });
    await writePage('news', [{ id: 'feed', kind: 'public', address: 'hnrss.org' }]);
    await service.listAndWatch();
    const r = await service.openWebsite('personal:news', 'https://news.example.com/a?b=1', true, true);
    expect(r.ok).toBe(true);
    expect(opened).toEqual(['https://news.example.com/a?b=1']);
    expect(r.pages[0].openSites).toEqual(['news.example.com']);
    // A phone opens it itself: main only records.
    await service.openWebsite('personal:news', 'https://other.example.com/', false, false);
    expect(opened).toHaveLength(1);
    expect((await service.forgetOpenSite('personal:news', 'news.example.com'))[0].openSites).toBeUndefined();
  });

  it('refuses anything that is not a web or mail address, and never remembers mail', async () => {
    const opened: string[] = [];
    service.stop();
    start({ openExternal: (url) => { opened.push(url); } });
    await writePage('news', [{ id: 'feed', kind: 'public', address: 'hnrss.org' }]);
    await service.listAndWatch();
    expect(await service.openWebsite('personal:news', 'javascript:alert(1)', true, true)).toMatchObject({ ok: false });
    const mail = await service.openWebsite('personal:news', 'mailto:a@example.com', true, true);
    expect(mail.ok).toBe(true);
    expect(mail.pages[0].openSites).toBeUndefined();
    expect(opened).toEqual(['mailto:a@example.com']);
  });
});

describe('a page that uses a folder of files', () => {
  const FOLDER = { id: 'photos', kind: 'files', level: 'folder', access: 'read' };
  const PICK = { id: 'one', kind: 'files', level: 'pick', access: 'readwrite' };

  it('is allowed only with a folder chosen in this window, and the card then shows it', async () => {
    const chosen = path.join(root, 'home', 'Pictures');
    await fs.mkdir(chosen, { recursive: true });
    start({ filesHome: path.join(root, 'home'), fileDialogs: { showFolder: async () => chosen } });
    await writePage('board', [FOLDER]);
    expect(await service.approve('personal:board', {}, { remote: false, ownerKey: 'window:1' })).toMatchObject({ ok: false });
    const pick = await service.files.chooseFolder({ ownerKey: 'window:1', remote: false });
    if (!pick.ok) throw new Error('no folder');
    // Another window cannot spend this window's choice.
    expect(await service.approve('personal:board', {}, { remote: false, folders: { photos: pick.token }, ownerKey: 'window:2' })).toMatchObject({ ok: false });
    const again = await service.files.chooseFolder({ ownerKey: 'window:1', remote: false });
    if (!again.ok) throw new Error('no folder');
    expect(await service.approve('personal:board', {}, { remote: false, folders: { photos: again.token }, ownerKey: 'window:1' })).toMatchObject({ ok: true });
    const listed = (await service.listAndWatch())[0];
    expect(listed.connections?.[0]).toMatchObject({ approved: true });
    expect(listed.connections?.[0]).toHaveProperty('folder');
    // A files-only page fetches nothing, so it has no "last updated" band.
    expect(listed.refresh).toBeUndefined();
  });

  it('shows remembered files by name and forgets them', async () => {
    await writePage('notes', [{ ...PICK, level: 'remember' }]);
    await service.approve('personal:notes', {}, { remote: false });
    const store = new PageConnectionsStore(userData, new SecretsStore(userData, getSecretStorage()));
    const id = await store.rememberFile('personal:notes', 'one', 'list.txt', path.join(root, 'list.txt'));
    const listed = (await service.listAndWatch())[0];
    expect(listed.connections?.[0]).toMatchObject({ remembered: [{ id, name: 'list.txt' }] });
    expect(JSON.stringify(listed)).not.toContain(path.join(root, 'list.txt'));
    const after = await service.forgetFile('personal:notes', 'one', id!);
    expect(after[0].connections?.[0]).not.toHaveProperty('remembered');
  });
});
