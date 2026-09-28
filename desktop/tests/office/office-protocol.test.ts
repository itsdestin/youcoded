import path from 'node:path';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSessions } from '../../src/main/office/office-sessions';
import { OFFICE_CSP, officeRequestHandler } from '../../src/main/office/office-protocol';

// Pins the office:// request handler that serves each document's sealed
// origin: the add-on's editor bundle plus that one document's media,
// confined to its own folders (design §3a/§3).
describe('officeRequestHandler', () => {
  let root: string;
  let sessions: ReturnType<typeof createSessions>;
  let handler: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'office-protocol-test-'));
    await mkdir(path.join(root, 'editors', 'sdkjs'), { recursive: true });
    await mkdir(path.join(root, 'editors', 'dictionaries', 'en_US'), { recursive: true });
    await writeFile(path.join(root, 'editors', 'index.html'), '<html>editor</html>');
    await writeFile(path.join(root, 'editors', 'sdkjs', 'x.js'), 'console.log(1)');
    await writeFile(path.join(root, 'editors', 'dictionaries', 'en_US', 'en_US.dic'), '1\nhello');

    sessions = createSessions(path.join(root, 'sessions-tmp'));
    handler = officeRequestHandler({ root, sessions });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  it('serves the editor shell with the office CSP header and nosniff', async () => {
    const session = await sessions.open('/docs/report.docx', 1);
    const res = await handler(new Request(`office://${session.token}/index.html`));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Security-Policy')).toBe(OFFICE_CSP);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(await res.text()).toBe('<html>editor</html>');
  });

  it('seals the CSP to this document\'s own origin instead of every office: document', () => {
    expect(OFFICE_CSP).toContain("default-src 'self'");
    expect(OFFICE_CSP).toContain("connect-src 'self'");
    expect(OFFICE_CSP).toContain("img-src 'self'");
    expect(OFFICE_CSP).toContain("font-src 'self'");
    expect(OFFICE_CSP).not.toContain('office:');
    expect(OFFICE_CSP).toContain("form-action 'none'");
    expect(OFFICE_CSP).toContain("base-uri 'none'");
  });

  it('serves a document\'s own media from its session temp dir', async () => {
    const session = await sessions.open('/docs/report.docx', 1);
    await mkdir(path.join(session.temp, 'media'), { recursive: true });
    await writeFile(path.join(session.temp, 'media', 'a.png'), Buffer.from([1, 2, 3]));

    const res = await handler(new Request(`office://${session.token}/asc/docmedia/media/a.png`));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from([1, 2, 3]));
  });

  it('refuses another session\'s media and an unknown token, both as 404', async () => {
    const withMedia = await sessions.open('/docs/report.docx', 1);
    await mkdir(path.join(withMedia.temp, 'media'), { recursive: true });
    await writeFile(path.join(withMedia.temp, 'media', 'a.png'), Buffer.from([1, 2, 3]));
    const other = await sessions.open('/docs/other.docx', 1);

    const otherRes = await handler(new Request(`office://${other.token}/asc/docmedia/media/a.png`));
    expect(otherRes.status).toBe(404);

    const unknownRes = await handler(new Request('office://0000000000000000000000000000ff/asc/docmedia/media/a.png'));
    expect(unknownRes.status).toBe(404);
  });

  it('refuses path traversal, both plain and percent-encoded', async () => {
    const session = await sessions.open('/docs/report.docx', 1);
    const plain = await handler(new Request(`office://${session.token}/../../etc/passwd`));
    expect(plain.status).toBe(404);

    const encoded = await handler(new Request(`office://${session.token}/%2e%2e/%2e%2e/etc/passwd`));
    expect(encoded.status).toBe(404);
  });

  // WHY these four are separate from the pair above: `new URL()` itself removes a literal
  // ".." or "%2e%2e" PATH SEGMENT before the handler ever runs — the two cases above never
  // reach serveConfined's realpath check at all. An encoded slash (%2f) or backslash (%5c) is
  // not a segment separator to the URL parser, so it survives parsing untouched and only
  // becomes a real "../" (or "..\") once this module's own decodeURIComponent runs. Each
  // targets a REAL file placed outside the folder its request is nominally confined to, so a
  // wrongly-permissive change reads real bytes back (200), not just a coincidental ENOENT. The
  // %5c (backslash) case is Windows-only IN EFFECT: `path`'s POSIX implementation never treats
  // `\` as a separator, so on this platform "..\..\<name>" is an inert single-component
  // filename that 404s on plain ENOENT regardless of the guard — it only exercises the
  // confinement check on win32, where `path.sep` is `\`.
  describe('traversal that only becomes real after this module\'s own decode', () => {
    // Shared by the encoded-slash and encoded-backslash editors/-escape cases below: a real
    // add-on root with a real file (secret.txt) sitting one level ABOVE editors/, so a request
    // that actually escapes editors/ reads real bytes back instead of coincidentally 404ing.
    async function withEscapeFixture(run: (escapeHandler: (req: Request) => Promise<Response>, token: string) => Promise<void>) {
      const outer = await mkdtemp(path.join(tmpdir(), 'office-protocol-escape-'));
      try {
        const addonRoot = path.join(outer, 'addon');
        await mkdir(path.join(addonRoot, 'editors'), { recursive: true });
        await writeFile(path.join(addonRoot, 'editors', 'index.html'), '<html>editor</html>');
        await writeFile(path.join(outer, 'secret.txt'), 'sibling secret, outside editors/');
        const escapeSessions = createSessions(path.join(outer, 'sessions-tmp'));
        const escapeHandler = officeRequestHandler({ root: addonRoot, sessions: escapeSessions });
        const session = await escapeSessions.open('/docs/report.docx', 1);
        await run(escapeHandler, session.token);
      } finally {
        await rm(outer, { recursive: true, force: true, maxRetries: 3 });
      }
    }

    it('refuses an encoded slash that decodes into ../ escaping editors/', async () => {
      await withEscapeFixture(async (escapeHandler, token) => {
        const res = await escapeHandler(new Request(`office://${token}/..%2f..%2fsecret.txt`));
        expect(res.status).toBe(404);
      });
    });

    it('refuses reaching another open session\'s media through an encoded ../', async () => {
      const victim = await sessions.open('/docs/victim.docx', 1);
      await mkdir(path.join(victim.temp, 'media'), { recursive: true });
      await writeFile(path.join(victim.temp, 'media', 'a.png'), Buffer.from([9, 9, 9]));
      const attacker = await sessions.open('/docs/attacker.docx', 1);
      const victimDirName = path.basename(victim.temp);

      const res = await handler(new Request(`office://${attacker.token}/asc/docmedia/..%2f${victimDirName}/media/a.png`));
      expect(res.status).toBe(404);
    });

    it('refuses an encoded slash that decodes into ../ escaping the dictionaries folder', async () => {
      // A real file one level above editors/dictionaries but still inside the add-on root —
      // reachable with "../.." from dictionaries/ if confinement did not stop it.
      await writeFile(path.join(root, 'index.html'), 'ROOT LEVEL — must never be servable via dictionaries/');
      const session = await sessions.open('/docs/report.docx', 1);

      const res = await handler(new Request(`office://${session.token}/asc/dictionaries/..%2f..%2findex.html`));
      expect(res.status).toBe(404);
    });

    it('refuses an encoded backslash that decodes into ../ escaping editors/', async () => {
      await withEscapeFixture(async (escapeHandler, token) => {
        const res = await escapeHandler(new Request(`office://${token}/..%5c..%5csecret.txt`));
        expect(res.status).toBe(404);
      });
    });
  });

  it('refuses a malformed percent-escape instead of throwing', async () => {
    const session = await sessions.open('/docs/report.docx', 1);
    const res = await handler(new Request(`office://${session.token}/%E0%A4%A`));
    expect(res.status).toBe(404);
    expect(res.headers.get('Content-Security-Policy')).toBe(OFFICE_CSP);
  });

  it('refuses a symlink inside editors/ that points outside the add-on root', async () => {
    if (process.platform === 'win32') return; // symlink creation needs elevated rights on win32; POSIX-only test.
    await symlink('/etc', path.join(root, 'editors', 'escape'));
    const session = await sessions.open('/docs/report.docx', 1);
    const res = await handler(new Request(`office://${session.token}/escape/passwd`));
    expect(res.status).toBe(404);
  });

  it('serves .js/.mjs as text/javascript, .wasm as application/wasm, .html as text/html', async () => {
    await writeFile(path.join(root, 'editors', 'sdkjs', 'x.wasm'), Buffer.from([0, 1]));
    await writeFile(path.join(root, 'editors', 'sdkjs', 'x.mjs'), 'export {}');
    const session = await sessions.open('/docs/report.docx', 1);

    const js = await handler(new Request(`office://${session.token}/sdkjs/x.js`));
    expect(js.headers.get('content-type')).toBe('text/javascript');

    const mjs = await handler(new Request(`office://${session.token}/sdkjs/x.mjs`));
    expect(mjs.headers.get('content-type')).toBe('text/javascript');

    const wasm = await handler(new Request(`office://${session.token}/sdkjs/x.wasm`));
    expect(wasm.headers.get('content-type')).toBe('application/wasm');

    const html = await handler(new Request(`office://${session.token}/index.html`));
    expect(html.headers.get('content-type')).toBe('text/html');
  });

  it('serves dictionaries from editors/dictionaries under the asc/dictionaries path', async () => {
    const session = await sessions.open('/docs/report.docx', 1);
    const res = await handler(new Request(`office://${session.token}/asc/dictionaries/en_US/en_US.dic`));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('1\nhello');
  });
});

describe('main.ts office scheme privileges', () => {
  it('registers the office scheme with exactly its reviewed privilege set', () => {
    const mainSource = readFileSync(
      fileURLToPath(new URL('../../src/main/main.ts', import.meta.url)),
      'utf8',
    );
    expect(mainSource).toContain(
      "{ scheme: 'office', privileges: { standard: true, secure: true, supportFetchAPI: true } },",
    );
  });
});
