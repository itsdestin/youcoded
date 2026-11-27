// The iPhone's built-in command line, judged as built: this builds the iPhone backend bundle and runs the shell's
// own worker against the list of command lines in ios/runtime/shell/conformance.json, plus the pins that need files made
// by something other than the shell (credential files, real-git repositories).
//
// WHY it can skip: the shell's packages (just-bash, just-git) are installed only in ios/runtime/ — the desktop's own
// install never has them. Where they are missing (desktop CI) this is skipped; the iOS workflow runs the same list itself
// under Node 18 (ios-ci.yml), and in the simulator. Set NODE18_BIN to a Node 18 binary to run the list the way the phone
// does (`--jitless`); otherwise it runs on the current Node.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { Worker } from 'worker_threads';

const repo = path.join(__dirname, '..', '..');
const runtime = path.join(repo, 'ios/runtime');
const installed = fs.existsSync(path.join(runtime, 'node_modules/just-bash')) && fs.existsSync(path.join(runtime, 'node_modules/just-git'));
const hasGit = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

let root: string;
let built: string;
let home: string;
let tmp: string;
let work: string;

/** One command in its own worker thread, as the app runs it. Home is reached through a link, as on an iPhone. */
function run(script: string, opts: { cwd?: string; tokens?: Record<string, string> } = {}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const w = new Worker(path.join(built, 'dist/ios-shell/worker.js'), { workerData: { script, cwd: opts.cwd ?? work, home, tmp, tokens: opts.tokens ?? {} } });
    const done = (r: { stdout: string; stderr: string; exitCode: number }) => { void w.terminate(); resolve(r); };
    w.once('message', done);
    w.once('error', (e) => done({ stdout: '', stderr: String(e), exitCode: 99 }));
  });
}

describe.skipIf(!installed)('the built-in command line, as built', () => {
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ios-shell-conf-'));
    built = path.join(root, 'backend');
    execFileSync(process.execPath, [path.join(runtime, 'build-backend.mjs'), built], { stdio: 'pipe', timeout: 150_000 });
    fs.mkdirSync(path.join(root, 'private/var/mobile/Documents'), { recursive: true });
    fs.mkdirSync(path.join(root, 'private/var/mobile/tmp'), { recursive: true });
    fs.symlinkSync('private/var', path.join(root, 'var')); // iOS reaches Documents through /var -> /private/var
    home = path.join(root, 'var/mobile/Documents');
    tmp = path.join(root, 'var/mobile/tmp');
    work = path.join(home, 'work');
    fs.mkdirSync(work, { recursive: true });
  }, 180_000);
  afterAll(() => { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });

  it('passes every line of conformance.json (Node 18 --jitless when NODE18_BIN is set)', () => {
    const r = spawnSync(process.execPath, [path.join(runtime, 'shell/conformance-run.mjs'), built], { encoding: 'utf8', timeout: 400_000, env: process.env });
    expect(r.stdout).toMatch(/SHELL_CONFORMANCE PASS \d+\/\d+/);
    expect(r.status).toBe(0);
  }, 420_000);

  it('the optional JavaScript, Python and SQLite commands are never registered', async () => {
    const r = await run('command -v js-exec node python python3 sqlite3; echo n=$?\npython3 -c 1\nsqlite3 x.db .tables\njs-exec -c 1');
    expect(r.stdout).toBe('n=1\n');
    expect(r.stderr).toMatch(/python3 is not available on this iPhone/);
    expect(r.stderr).toMatch(/sqlite3 is not available on this iPhone/);
    expect(r.stderr).toMatch(/js-exec is not available on this iPhone/);
    // The compressors with native parts, SQLite's WebAssembly and the TypeScript compiler are left out of the bundle.
    const worker = fs.readFileSync(path.join(built, 'dist/ios-shell/worker.js'), 'utf8');
    for (const name of ['@mongodb-js/zstd', 'node-liblzma', 'sql.js', 'typescript', 'guarded-fetch']) {
      expect(worker, name).toMatch(new RegExp(`(require2?|import)\\(["']${name.replace(/[.]/g, '\\.')}["']\\)`));
    }
    expect(worker).not.toContain('vendor/cpython-emscripten/python.cjs');
  });

  it('the credential files stay hidden, at the top of Documents and anywhere else, links and copies included', async () => {
    fs.writeFileSync(path.join(home, '.claude.json'), '{"mcp":"TOPSECRET"}');
    fs.writeFileSync(path.join(home, '.git-credentials'), 'https://u:TOPSECRET@github.com');
    fs.mkdirSync(path.join(work, 'proj'), { recursive: true });
    fs.writeFileSync(path.join(work, 'proj', '.npmrc'), '_authToken=TOPSECRET');
    fs.writeFileSync(path.join(home, 'visible.txt'), 'fine');
    const r = await run('cd ~; cat .claude.json; cat .git-credentials; cat work/proj/.npmrc; ls -a | tr "\\n" " "; ln -s .claude.json via; cat via; cp -r . /tmp/everything; grep -r TOPSECRET . ; grep -r TOPSECRET /tmp/everything; cat visible.txt', { cwd: home });
    expect(r.stdout).not.toContain('TOPSECRET');
    expect(r.stdout).not.toMatch(/\.claude\.json|\.git-credentials/);
    expect(r.stdout).toContain('visible.txt');
    expect(r.stdout).toContain('fine');
  });

  it.skipIf(!hasGit)('a repository with a version-4 index, or a split index, is refused (made by real git), also through git -C', async () => {
    const v4 = path.join(work, 'real-v4');
    const split = path.join(work, 'real-split');
    for (const d of [v4, split]) {
      fs.mkdirSync(d, { recursive: true });
      const g = (...a: string[]) => execFileSync('git', ['-C', d, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'pipe' });
      g('init', '-q'); fs.writeFileSync(path.join(d, 'a'), 'a'); g('add', 'a'); g('commit', '-qm', 'one');
    }
    execFileSync('git', ['-C', v4, 'update-index', '--index-version', '4']);
    execFileSync('git', ['-C', split, 'update-index', '--split-index']);
    for (const d of ['real-v4', 'real-split']) {
      const r = await run(`git -C ${d} status; echo rc=$?\ncd ${d} && git log; echo rc=$?`);
      expect(r.stdout).toBe('rc=1\nrc=1\n');
      expect(r.stderr.match(/index file is in a format/g)?.length).toBe(2);
    }
    // And a good repository made by real git is read normally.
    const ok = path.join(work, 'real-ok');
    fs.mkdirSync(ok, { recursive: true });
    execFileSync('git', ['-C', ok, 'init', '-q']); fs.writeFileSync(path.join(ok, 'a'), 'a');
    execFileSync('git', ['-C', ok, 'add', 'a']); execFileSync('git', ['-C', ok, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'one']);
    const good = await run('git -C real-ok log --oneline | wc -l; git -C real-ok status -s | wc -l');
    expect(good.stdout).toBe('1\n0\n');
  });

  it('a working folder outside the two mounts falls back to Documents; one through the link keeps its spelling', async () => {
    const outside = await run('pwd', { cwd: path.join(os.tmpdir(), 'not-mounted-anywhere') });
    expect(outside.stdout.trim()).toBe(home);
    fs.mkdirSync(path.join(work, 'deep'), { recursive: true });
    const inside = await run('cd deep && pwd && cd .. && pwd', { cwd: work });
    expect(inside.stdout).toBe(`${work}/deep\n${work}\n`);
    expect(inside.stdout).toContain('/var/mobile/'); // the logical spelling, not /private/var
  });

  it('a saved sign-in never shows up in the environment, the output or git\'s own files', async () => {
    const r = await run('env; printenv; git init -q tk; cd tk; git remote add origin https://github.com/octocat/Hello-World; git config -l; cat .git/config; cat ~/.gitconfig', { tokens: { 'github.com': 'ghp_SENTINEL_TOKEN_123' } });
    expect(r.stdout + r.stderr).not.toContain('ghp_SENTINEL_TOKEN_123');
    expect(fs.readFileSync(path.join(work, 'tk/.git/config'), 'utf8')).not.toContain('ghp_SENTINEL_TOKEN_123');
  });

  it('the app\'s backend bundle registers the shell, and the release build carries neither the self-test nor the test list', () => {
    const main = fs.readFileSync(path.join(built, 'dist/main/headless/ios-main.js'), 'utf8');
    expect(main).toContain('setInAppSpawner');
    expect(main).toContain('ios-shell/worker.js');
    expect(main).not.toContain('SHELL_SELFTEST');
    expect(main).not.toContain('npm install; echo rc=');
  });

  it('ships the licence texts of the shell and its libraries with the app', () => {
    expect(fs.readFileSync(path.join(built, 'legal/just-bash/LICENSE'), 'utf8')).toMatch(/Apache License/i);
    expect(fs.readFileSync(path.join(built, 'legal/just-git/LICENSE'), 'utf8')).toMatch(/MIT License/i);
  });
});

describe('desktop and Android do not gain the shell\'s packages', () => {
  it('neither package is a dependency of the desktop app, and both are pinned exactly in ios/runtime', () => {
    const desktop = JSON.parse(fs.readFileSync(path.join(repo, 'desktop/package.json'), 'utf8'));
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const name of ['just-bash', 'just-git']) expect(desktop[section]?.[name]).toBeUndefined();
    }
    const ios = JSON.parse(fs.readFileSync(path.join(runtime, 'package.json'), 'utf8'));
    expect(ios.devDependencies['just-bash']).toMatch(/^\d+\.\d+\.\d+$/);
    expect(ios.devDependencies['just-git']).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('desktop source never imports them', () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name) && /from ['"](just-bash|just-git)['"]|require\(['"](just-bash|just-git)['"]\)/.test(fs.readFileSync(p, 'utf8'))) hits.push(p);
      }
    };
    walk(path.join(repo, 'desktop/src'));
    expect(hits).toEqual([]);
  });
});
