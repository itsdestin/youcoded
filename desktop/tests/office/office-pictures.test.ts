// Insert → Picture (finish plan Task 1): the editor asks its own office://<token> origin to copy a
// picture the person chose (copy-to-media/<handle>) or to fetch one from the web
// (download-to-media/<url>) into the document's media folder, and answers with the bare name it
// got there — the name the document then references and x2t packs on save.
import path from 'node:path';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSessions } from '../../src/main/office/office-sessions';
import { MEDIA_CSP, OFFICE_CSP, officeRequestHandler } from '../../src/main/office/office-protocol';
import { grantPicked, PICTURE_MAX_BYTES } from '../../src/main/office/office-pictures';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

describe('pictures into a document', () => {
  let dir: string;
  let sessions: ReturnType<typeof createSessions>;
  let fetched: string[];
  let download: (url: string, init?: RequestInit) => Promise<Response>;
  let handler: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'office-pictures-test-'));
    await mkdir(path.join(dir, 'addon', 'editors'), { recursive: true });
    await mkdir(path.join(dir, 'pics'), { recursive: true });
    await writeFile(path.join(dir, 'pics', 'cat.png'), PNG);
    await writeFile(path.join(dir, 'pics', 'notes.txt'), 'not a picture');
    sessions = createSessions(path.join(dir, 'sessions-tmp'));
    fetched = [];
    download = async (url) => {
      fetched.push(url);
      return new Response(PNG, { headers: { 'content-type': 'image/png' } });
    };
    handler = officeRequestHandler({ root: path.join(dir, 'addon'), sessions, download: (u, i) => download(u, i) });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  const ask = (token: string, route: string, what: string) =>
    handler(new Request(`office://${token}/asc/${route}/${encodeURIComponent(what)}`));

  describe('a picture the person chose in the dialog', () => {
    it('hands the editor a handle that names the file but never its folder', async () => {
      const s = await sessions.open('/docs/report.docx', 1);
      const [handle] = grantPicked(s, [path.join(dir, 'pics', 'cat.png')]);
      expect(handle.endsWith('/cat.png')).toBe(true);
      expect(handle).not.toContain(dir);
      expect(handle).not.toContain('pics');
    });

    it('is copied into the document\'s media under a fresh name, answered with that bare name', async () => {
      const s = await sessions.open('/docs/report.docx', 1);
      const [handle] = grantPicked(s, [path.join(dir, 'pics', 'cat.png')]);
      const res = await ask(s.token, 'copy-to-media', handle);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const name = await res.text();
      expect(name).toMatch(/^[\w-]+\.png$/);
      expect(await readFile(path.join(s.temp, 'media', name))).toEqual(PNG);
      // and the editor can then load it from its own origin
      const shown = await handler(new Request(`office://${s.token}/asc/docmedia/media/${name}`));
      expect(shown.status).toBe(200);
      expect(Buffer.from(await shown.arrayBuffer())).toEqual(PNG);
    });

    it('never overwrites a picture the document already has', async () => {
      const s = await sessions.open('/docs/report.docx', 1);
      const [handle] = grantPicked(s, [path.join(dir, 'pics', 'cat.png')]);
      const a = await (await ask(s.token, 'copy-to-media', handle)).text();
      const b = await (await ask(s.token, 'copy-to-media', handle)).text();
      expect(a).not.toBe(b);
      expect((await readdir(path.join(s.temp, 'media'))).sort()).toEqual([a, b].sort());
    });

    it('refuses a real path the dialog never gave, even an existing picture', async () => {
      const s = await sessions.open('/docs/report.docx', 1);
      const res = await ask(s.token, 'copy-to-media', path.join(dir, 'pics', 'cat.png'));
      expect(res.status).toBe(404);
      await expect(readdir(path.join(s.temp, 'media'))).rejects.toThrow();
    });

    it('refuses a handle granted to another document', async () => {
      const mine = await sessions.open('/docs/report.docx', 1);
      const other = await sessions.open('/docs/other.docx', 1);
      const [handle] = grantPicked(mine, [path.join(dir, 'pics', 'cat.png')]);
      expect((await ask(other.token, 'copy-to-media', handle)).status).toBe(404);
    });

    it('refuses a made-up handle', async () => {
      const s = await sessions.open('/docs/report.docx', 1);
      grantPicked(s, [path.join(dir, 'pics', 'cat.png')]);
      expect((await ask(s.token, 'copy-to-media', 'yc-picked/00000000000000000000000000000000/cat.png')).status).toBe(404);
    });

    it('refuses a chosen file that is not a picture', async () => {
      const s = await sessions.open('/docs/report.docx', 1);
      const [handle] = grantPicked(s, [path.join(dir, 'pics', 'notes.txt')]);
      expect((await ask(s.token, 'copy-to-media', handle)).status).toBe(404);
    });

    it('refuses a chosen picture over the size cap', async () => {
      const s = await sessions.open('/docs/report.docx', 1);
      const big = path.join(dir, 'pics', 'huge.png');
      await writeFile(big, Buffer.alloc(PICTURE_MAX_BYTES + 1));
      const [handle] = grantPicked(s, [big]);
      expect((await ask(s.token, 'copy-to-media', handle)).status).toBe(404);
    });
  });

  it('serves the document\'s pictures sandboxed, so an SVG from the web runs nothing on this origin', async () => {
    const s = await sessions.open('/docs/report.docx', 1);
    await mkdir(path.join(s.temp, 'media'), { recursive: true });
    await writeFile(path.join(s.temp, 'media', 'x.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const res = await handler(new Request(`office://${s.token}/asc/docmedia/media/x.svg`));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Security-Policy')).toBe(MEDIA_CSP);
    expect(MEDIA_CSP).toMatch(/^sandbox;/);
    expect(MEDIA_CSP).not.toContain('script');
    // the editor's own files keep the editor's policy
    expect((await handler(new Request(`office://${s.token}/index.html`))).headers.get('Content-Security-Policy')).toBe(OFFICE_CSP);
  });

  describe('a picture the document already has', () => {
    it('answers with its own name, bare or under media/, without copying anything', async () => {
      const s = await sessions.open('/docs/report.docx', 1);
      await mkdir(path.join(s.temp, 'media'), { recursive: true });
      await writeFile(path.join(s.temp, 'media', 'image1.png'), PNG);
      expect(await (await ask(s.token, 'copy-to-media', 'image1.png')).text()).toBe('image1.png');
      expect(await (await ask(s.token, 'copy-to-media', 'media/image1.png')).text()).toBe('image1.png');
      expect(await readdir(path.join(s.temp, 'media'))).toEqual(['image1.png']);
    });

    it('refuses a name it does not have, and any name that walks out of media/', async () => {
      const s = await sessions.open('/docs/report.docx', 1);
      await mkdir(path.join(s.temp, 'media'), { recursive: true });
      await writeFile(path.join(s.temp, 'Editor.bin'), 'x');
      expect((await ask(s.token, 'copy-to-media', 'image9.png')).status).toBe(404);
      expect((await ask(s.token, 'copy-to-media', '../Editor.bin')).status).toBe(404);
      expect((await ask(s.token, 'copy-to-media', 'media/../Editor.bin')).status).toBe(404);
    });
  });

  describe('a picture dropped onto the document', () => {
    // The add-on answers sdkjs's drop by sending the dropped file's bytes (never a path) to
    // upload/drop, and expects {"media/<name>": "<url>"} back.
    const upload = (token: string, body: BodyInit, type = 'image/png', method = 'POST') =>
      handler(new Request(`office://${token}/upload/drop`, { method, body: method === 'POST' ? body : undefined, headers: { 'content-type': type } }));

    it('stores the bytes in media and answers the name and its address on this origin', async () => {
      const s = await sessions.open('/docs/report.docx', 1);
      const res = await upload(s.token, PNG);
      expect(res.status).toBe(200);
      const map = (await res.json()) as Record<string, string>;
      const [[key, url]] = Object.entries(map);
      const name = key.replace(/^media\//, '');
      expect(key).toMatch(/^media\/[\w-]+\.png$/);
      expect(url).toBe(`office://${s.token}/asc/docmedia/media/${name}`);
      expect(await readFile(path.join(s.temp, 'media', name))).toEqual(PNG);
    });

    it('refuses anything that is not a picture, and any other method', async () => {
      const s = await sessions.open('/docs/report.docx', 1);
      expect((await upload(s.token, 'hello', 'text/html')).status).toBe(404);
      expect((await upload(s.token, PNG, 'image/png', 'GET')).status).toBe(404);
      await expect(readdir(path.join(s.temp, 'media'))).rejects.toThrow();
    });

    it('refuses a dropped picture over the size cap', async () => {
      const s = await sessions.open('/docs/report.docx', 1);
      expect((await upload(s.token, new Uint8Array(PICTURE_MAX_BYTES + 1))).status).toBe(404);
      await expect(readdir(path.join(s.temp, 'media'))).rejects.toThrow();
    });
  });

  describe('a picture from the web', () => {
    it('downloads an http(s) picture into media and answers with its bare name', async () => {
      const s = await sessions.open('/docs/report.docx', 1);
      const res = await ask(s.token, 'download-to-media', 'https://example.com/a/cat.png?x=1');
      expect(res.status).toBe(200);
      const name = await res.text();
      expect(name).toMatch(/^[\w-]+\.png$/);
      expect(fetched).toEqual(['https://example.com/a/cat.png?x=1']);
      expect(await readFile(path.join(s.temp, 'media', name))).toEqual(PNG);
    });

    it('names the file by what the server says it is, not by the address', async () => {
      const s = await sessions.open('/docs/report.docx', 1);
      download = async () => new Response(PNG, { headers: { 'content-type': 'image/jpeg; charset=binary' } });
      expect(await (await ask(s.token, 'download-to-media', 'https://example.com/picture')).text()).toMatch(/\.jpg$/);
    });

    it('never fetches anything but http(s)', async () => {
      const s = await sessions.open('/docs/report.docx', 1);
      for (const url of ['file:///etc/passwd', 'ftp://example.com/a.png', 'office://abc/x.png', 'javascript:alert(1)']) {
        expect((await ask(s.token, 'download-to-media', url)).status).toBe(404);
      }
      expect(fetched).toEqual([]);
    });

    it('refuses an answer that is not a picture', async () => {
      const s = await sessions.open('/docs/report.docx', 1);
      download = async () => new Response('<html>', { headers: { 'content-type': 'text/html' } });
      expect((await ask(s.token, 'download-to-media', 'https://example.com/a.png')).status).toBe(404);
      await expect(readdir(path.join(s.temp, 'media'))).rejects.toThrow();
    });

    it('refuses a failed answer', async () => {
      const s = await sessions.open('/docs/report.docx', 1);
      download = async () => new Response(PNG, { status: 403, headers: { 'content-type': 'image/png' } });
      expect((await ask(s.token, 'download-to-media', 'https://example.com/a.png')).status).toBe(404);
    });

    it('refuses a picture that says it is over the size cap without reading it', async () => {
      const s = await sessions.open('/docs/report.docx', 1);
      download = async () => new Response(PNG, { headers: { 'content-type': 'image/png', 'content-length': String(PICTURE_MAX_BYTES + 1) } });
      expect((await ask(s.token, 'download-to-media', 'https://example.com/a.png')).status).toBe(404);
    });

    it('stops reading a picture that turns out bigger than the cap', async () => {
      const s = await sessions.open('/docs/report.docx', 1);
      const chunk = new Uint8Array(1024 * 1024);
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          if (sent > PICTURE_MAX_BYTES + 5 * chunk.length) { c.close(); return; }
          sent += chunk.length;
          c.enqueue(chunk);
        },
      });
      download = async () => new Response(body, { headers: { 'content-type': 'image/png' } });
      expect((await ask(s.token, 'download-to-media', 'https://example.com/a.png')).status).toBe(404);
      expect(sent).toBeLessThanOrEqual(PICTURE_MAX_BYTES + 3 * chunk.length);
      // nothing half-written left behind (the folder is not even made)
      await expect(readdir(path.join(s.temp, 'media'))).rejects.toThrow();
    });

    it('refuses a redirect that lands on something other than http(s)', async () => {
      const s = await sessions.open('/docs/report.docx', 1);
      download = async () => {
        const r = new Response(PNG, { headers: { 'content-type': 'image/png' } });
        Object.defineProperty(r, 'url', { value: 'file:///etc/passwd' });
        return r;
      };
      expect((await ask(s.token, 'download-to-media', 'https://example.com/a.png')).status).toBe(404);
    });

    it('gives up on a download that takes too long', async () => {
      const s = await sessions.open('/docs/report.docx', 1);
      let aborted = false;
      download = (_u, init) => new Promise((_r, reject) => {
        init?.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
      });
      const h = officeRequestHandler({ root: path.join(dir, 'addon'), sessions, download: (u, i) => download(u, i), downloadTimeoutMs: 50 });
      const res = await h(new Request(`office://${s.token}/asc/download-to-media/${encodeURIComponent('https://example.com/slow.png')}`));
      expect(res.status).toBe(404);
      expect(aborted).toBe(true);
    });

    it('sends no cookies or credentials with the request', async () => {
      const s = await sessions.open('/docs/report.docx', 1);
      let seen: RequestInit | undefined;
      download = async (_u, init) => { seen = init; return new Response(PNG, { headers: { 'content-type': 'image/png' } }); };
      await ask(s.token, 'download-to-media', 'https://example.com/a.png');
      expect(seen?.credentials).toBe('omit');
    });
  });
});
