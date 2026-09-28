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

  it('serves the editor shell with the office CSP header', async () => {
    const session = await sessions.open('/docs/report.docx', 1);
    const res = await handler(new Request(`office://${session.token}/index.html`));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Security-Policy')).toBe(OFFICE_CSP);
    expect(await res.text()).toBe('<html>editor</html>');
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

  it('refuses a symlink inside editors/ that points outside the add-on root', async () => {
    if (process.platform === 'win32') return; // symlink creation needs elevated rights on win32; POSIX-only test.
    await symlink('/etc', path.join(root, 'editors', 'escape'));
    const session = await sessions.open('/docs/report.docx', 1);
    const res = await handler(new Request(`office://${session.token}/escape/passwd`));
    expect(res.status).toBe(404);
  });

  it('serves .js as text/javascript, .wasm as application/wasm, .html as text/html', async () => {
    await writeFile(path.join(root, 'editors', 'sdkjs', 'x.wasm'), Buffer.from([0, 1]));
    const session = await sessions.open('/docs/report.docx', 1);

    const js = await handler(new Request(`office://${session.token}/sdkjs/x.js`));
    expect(js.headers.get('content-type')).toBe('text/javascript');

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
      "{ scheme: 'office', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },",
    );
  });
});
