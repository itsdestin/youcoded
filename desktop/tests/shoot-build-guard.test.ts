// The photo-only build `shoot` photographs must be the ONLY build carrying the
// screen driver, the screen marks, and (with the landing page) the workbench's
// fake backend.
//
// WHY a real build and not a source scan: the promise is about what ships.
// Before this test, "workbench code never reaches the app" was only written in
// comments (index.tsx, workbench-mode.ts) — nothing checked it. The screen
// openers make the stakes concrete: in the landing page's demo, which strangers
// can click, they would let a page script open any screen. The folding relies
// on `__SHOOT__` being a literal at each use site (vite.config.ts `define`), so
// a refactor that reads it through a function call would quietly ship them.
//
// The photo-only build is built too, and must CONTAIN every marker: a marker
// the bundler renamed or dropped would otherwise make the absence checks pass
// vacuously.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const run = promisify(execFile);
const DESKTOP = resolve(__dirname, '..');
const VITE = join(DESKTOP, 'node_modules', 'vite', 'bin', 'vite.js');

/** Every asset's text, concatenated. */
const bundleText = (dir: string) =>
  readdirSync(join(dir, 'assets'))
    .filter((f) => /\.(js|css)$/.test(f))
    .map((f) => readFileSync(join(dir, 'assets', f), 'utf8'))
    .join('\n');

async function build(out: string, env: Record<string, string>) {
  await run(process.execPath, [VITE, 'build', '--outDir', out, '--emptyOutDir', '--logLevel', 'error'], {
    cwd: DESKTOP,
    // Only the flags under test: a VITE_* leaking in from the caller's shell
    // (a dev running with VITE_SHOOT set) must not decide the result. NODE_ENV
    // goes too — vitest sets it to `test`, and Vite then builds with
    // `import.meta.env.DEV` true, which is not the build that ships.
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('VITE_') && k !== 'NODE_ENV')), ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  return bundleText(out);
}

// The screen driver, the mark attribute as JSX emits it, and the fake backend's installer.
const DRIVER = '__youcodedScreens';
const MARK = '"data-screen":';
const MOCK = 'installMock';

describe('photo-only build stays out of the app and the landing page', () => {
  let root = '';
  const text: Record<'app' | 'site' | 'shoot', string> = { app: '', site: '', shoot: '' };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'shoot-guard-'));
    [text.app, text.site, text.shoot] = await Promise.all([
      build(join(root, 'app'), {}),
      build(join(root, 'site'), { VITE_WORKBENCH: '1' }),
      build(join(root, 'shoot'), { VITE_WORKBENCH: '1', VITE_SHOOT: '1' }),
    ]);
  }, 180_000);
  afterAll(() => { if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });

  it('the photo-only build carries the driver, the marks and the fake backend', () => {
    expect(text.shoot.includes(DRIVER), `shoot build should contain ${DRIVER}`).toBe(true);
    expect(text.shoot.includes(MARK), `shoot build should contain ${MARK}`).toBe(true);
    expect(text.shoot.includes(MOCK), `shoot build should contain ${MOCK}`).toBe(true);
  });

  it('the real app carries none of them', () => {
    expect(text.app.includes(DRIVER), `app build must not contain ${DRIVER}`).toBe(false);
    expect(text.app.includes(MARK), `app build must not contain ${MARK}`).toBe(false);
    expect(text.app.includes(MOCK), `app build must not contain ${MOCK}`).toBe(false);
  });

  it('the landing page demo carries the fake backend but no driver or marks', () => {
    expect(text.site.includes(MOCK), `site build should contain ${MOCK}`).toBe(true);
    expect(text.site.includes(DRIVER), `site build must not contain ${DRIVER}`).toBe(false);
    expect(text.site.includes(MARK), `site build must not contain ${MARK}`).toBe(false);
  });
});
