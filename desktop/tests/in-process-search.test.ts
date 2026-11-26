// The in-app file search an iPhone uses in place of the ripgrep program (src/main/harness/tools/in-process-search.ts).
// The Grep tool reads ripgrep's OUTPUT, so the stand-in is only correct if it prints what ripgrep prints: every
// case here runs the same arguments through both and compares the text and the exit code.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inProcessSearch, globToRegExp, type SearchChild } from '../src/main/harness/tools/in-process-search';
import { resolveRgPath } from '../src/main/harness/tools/grep';

let root = '';

function collect(child: SearchChild | ReturnType<typeof spawn>): Promise<{ out: string; err: string; code: number | null }> {
  return new Promise((resolve) => {
    let out = '', err = '';
    child.stdout!.on('data', (d: unknown) => { out += String(d); });
    child.stderr!.on('data', (d: unknown) => { err += String(d); });
    child.on('close', (code: number | null) => resolve({ out, err, code }));
  });
}

const BASE = ['--no-config', '--hidden', '--glob', '!.git', '--path-separator', '/'];
const real = (args: string[]) => collect(spawn(resolveRgPath(), [...BASE, ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }));
const mine = (args: string[]) => collect(inProcessSearch([...BASE, ...args], root));
/** ripgrep walks folders in parallel, so file ORDER differs run to run; lines within a file do not. */
const sortedBlocks = (text: string) => text.split('\n').filter(Boolean).sort();

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-search-'));
  const write = (rel: string, body: string | Buffer) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };
  write('src/a.ts', 'import x from "y";\nconst port = 8080;\n// TODO: fix\nexport const Port = port;\n');
  write('src/deep/b.ts', 'line one\nTODO second\nline three\nline four\nTODO fifth\nline six\n');
  write('src/c.js', 'var port = 1;\nfunction f() {\n  return port;\n}\n');
  write('notes/readme.md', '# Title\n\nSome port notes.\nTwo words here.\n');
  write('notes/日本語.txt', 'こんにちは port 世界\n');
  write('.hidden/secret.txt', 'port hidden\n');
  write('node_modules/pkg/index.js', 'port in a dependency\n');
  write('build/out.js', 'port in build output\n');
  write('.gitignore', 'build/\n*.log\n');
  write('debug.log', 'port in a log\n');
  write('bin.dat', Buffer.from([0x70, 0x6f, 0x72, 0x74, 0x00, 0x01, 0x02]));
  write('crlf.txt', 'port one\r\nother\r\n');
  // ripgrep only honours .gitignore inside a git repository.
  fs.mkdirSync(path.join(root, '.git'));
});

afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('the in-app search prints what ripgrep prints', () => {
  const cases: Array<[string, string[]]> = [
    ['files with matches', ['--max-count', '500', '-l', '--', 'port']],
    ['count', ['--count', '--', 'port']],
    ['content with line numbers', ['--max-count', '500', '-n', '--', 'port']],
    ['case-insensitive', ['--max-count', '500', '-n', '-i', '--', 'PORT']],
    ['a fixed string with regex characters', ['--max-count', '500', '-n', '-F', '--', 'f() {']],
    ['a glob filter', ['--max-count', '500', '-l', '--glob', '*.ts', '--', 'port']],
    ['a path glob', ['--max-count', '500', '-l', '--glob', 'src/**/*.ts', '--', 'TODO']],
    ['an excluding glob', ['--max-count', '500', '-l', '--glob', '!notes', '--', 'port']],
    ['a type filter', ['--max-count', '500', '-l', '--type=md', '--', 'port']],
    ['context after', ['--max-count', '500', '-n', '-A', '1', '--', 'TODO']],
    ['context before', ['--max-count', '500', '-n', '-B', '1', '--', 'TODO']],
    ['context around, with gaps between groups', ['--max-count', '500', '-n', '-C', '1', '--', 'TODO', 'src/deep']],
    ['a max count per file', ['--max-count', '1', '-n', '--', 'TODO']],
    ['a sub-folder target', ['--max-count', '500', '-n', '--', 'port', 'src']],
    ['a single file target', ['--max-count', '500', '-n', '--', 'TODO', 'src/deep/b.ts']],
    ['a single file count', ['--count', '--', 'TODO', 'src/deep/b.ts']],
    ['a pattern spanning lines', ['--max-count', '500', '-n', '-U', '--multiline-dotall', '--', 'function f.*return', 'src/c.js']],
    ['an anchored regex', ['--max-count', '500', '-n', '--', '^const \\w+ = \\d+;$']],
    ['non-Latin text', ['--max-count', '500', '-n', '--', 'こんにちは']],
    ['no matches', ['--max-count', '500', '-n', '--', 'zzz-not-here']],
  ];
  for (const [name, args] of cases) {
    it(name, async () => {
      const [a, b] = await Promise.all([mine(args), real(args)]);
      expect(sortedBlocks(a.out)).toEqual(sortedBlocks(b.out));
      expect(a.code).toBe(b.code);
    });
  }
});

describe('what it skips, and how it fails', () => {
  it('skips .git, binary files and what the folder\'s .gitignore names; reads hidden files', async () => {
    const r = await mine(['--max-count', '500', '-l', '--', 'port']);
    const files = sortedBlocks(r.out);
    expect(files).toContain('.hidden/secret.txt');
    for (const skipped of ['build/out.js', 'debug.log', 'bin.dat']) expect(files).not.toContain(skipped);
  });

  it('never enters an excluded folder (how credential folders stay unread)', async () => {
    const r = await mine(['--max-count', '500', '-l', '--glob', '!**/.hidden/**', '--glob', '!.hidden', '--', 'port']);
    expect(sortedBlocks(r.out)).not.toContain('.hidden/secret.txt');
  });

  it('a missing path, a bad regex and an unknown type exit 2 with the words the Grep tool looks for', async () => {
    const missing = await mine(['-n', '--', 'x', 'no/such/folder']);
    expect([missing.code, /No such file or directory/.test(missing.err)]).toEqual([2, true]);
    const bad = await mine(['-n', '--', '(unclosed']);
    expect([bad.code, /regex parse error/.test(bad.err)]).toEqual([2, true]);
    const type = await mine(['-n', '--type=notatype', '--', 'x']);
    expect([type.code, /unrecognized file type/.test(type.err)]).toEqual([2, true]);
  });

  it('a search that is stopped ends with no exit code, as a killed program does', async () => {
    const child = inProcessSearch([...BASE, '-n', '--', 'port'], root);
    child.kill('SIGKILL');
    expect((await collect(child)).code).toBeNull();
  });

  it('globs: a bare name matches at any depth, a path glob matches from the root, ** crosses folders', () => {
    expect(globToRegExp('*.ts').test('src/deep/b.ts')).toBe(true);
    expect(globToRegExp('*.ts').test('src/a.tsx')).toBe(false);
    expect(globToRegExp('src/*.ts').test('src/deep/b.ts')).toBe(false);
    expect(globToRegExp('src/**/*.ts').test('src/deep/b.ts')).toBe(true);
    expect(globToRegExp('**/.aws/**').test('home/.aws/credentials')).toBe(true);
    expect(globToRegExp('*.{png,jpg}').test('a/b/c.jpg')).toBe(true);
    expect(globToRegExp('build/').test('build/out.js')).toBe(true);
  });
});
