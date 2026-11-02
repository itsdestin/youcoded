// Q-4 (review deck 2026-11-01): look-only commands may use unquoted wildcards, and the timing helpers are looked through.
// Destin's standard: nothing allowed here could plausibly lose data or be used maliciously — so each attack gets a test.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readOnlyVerdict } from '../src/shared/safe-readonly-commands';
import { readOnlyChecksFor, expandWildcards } from '../src/main/harness/tools/readonly-guard';

const safe = (c: string) => readOnlyVerdict(c).safe;

describe('wildcards: which commands may take them', () => {
  it.each([
    'ls *', 'ls *.ts', 'ls src/*.ts', 'ls src/*/index.ts', 'ls ?', 'ls a?c*', 'cat *.md', 'cat src/*.ts | wc -l', 'wc -l *.py', 'head -n 5 *.log', 'tail -n 20 logs/*.txt',
    'grep -n TODO *.ts', 'grep -rn "a*b" src/*', 'rg -n foo src/*.ts', 'du -sh *', 'stat *.json', 'diff a.txt *.bak', 'sha256sum dist/*', 'ls -la -- *', 'file *', 'tree -L 2 src*', 'strings *.bin', 'ls src/**/*.ts',
  ])('%s is look-only', (c) => { expect(safe(c)).toBe(true); });

  it('reports the wildcard words so they can be expanded and judged', () => {
    expect(readOnlyVerdict('grep -n TODO src/*.ts "a*" b?.md').globs).toEqual(['src/*.ts', 'b?.md']); // a quoted * is plain text
  });

  it.each([
    // never for find, sort, sed, git (and other commands that write, run programs or pick output files)
    'find *', 'find . -name *.ts', 'sort *', 'sort -u *.txt', 'sed -n 1,5p *.ts', 'sed *', 'git diff *', 'git log *', 'git status *', 'git add *', 'git grep x *',
    'uniq *', 'uniq in.txt *', 'tr a *', 'cut -c1 *', 'paste *', 'comm *', 'cmp *', 'echo *', 'printf *', 'xargs *', 'rm *', 'rm -rf *', 'mv * x', 'cp * x', 'tee *', 'touch *', 'chmod 777 *', 'curl *', 'sh *', 'bash *.sh', 'node *.js', 'python *.py', 'npm *',
    // the wildcard can never be the command itself, a flag, or a redirect target
    '* ls', '*', 'l* -la', './l*', 'ls -* x', 'ls --sort=* x', 'ls -I*', 'grep --include=*.ts x .', 'rg --glob=*.ts x', 'ls > *', 'cat * > out',
    // hidden files, parents, home and absolute places are out of reach of a wildcard
    'ls .*', 'ls .s*', 'ls .ss?', 'cat .e*', 'cat .env*', 'ls ../*', 'ls ../../*', 'ls ~/*', 'ls ~*', 'ls /*', 'ls /etc/*', 'cat /etc/pass*', 'ls ./*', 'ls src/.*', 'ls src/.g*/x', 'ls */.ssh', 'ls *//x', 'ls a/../*',
    // character classes, brace lists, extglob, history and substitution are never plain
    'ls [a-z]*', 'ls *[0-9]', 'ls {a,b}*', 'ls @(a|b)', 'ls +(a)', 'ls !(a)', 'ls $(echo *)', 'ls `echo *`', 'ls $HOME/*', 'ls "$X"*', 'ls *$X',
  ])('%s asks', (c) => { expect(safe(c), c).toBe(false); });

  it('a quoted wildcard stays plain text and keeps working as before', () => {
    expect(safe('grep "a*b" file.txt')).toBe(true);
    expect(safe("grep 'x?' file.txt")).toBe(true);
  });

  it('an option on the command must still be on its own list, wildcard or not', () => {
    for (const c of ['ls --bogus *', 'cat -Z *', 'head --follow *', 'tail -f *', 'grep -P --pre=sh x *', 'rg --pre cat x *', 'du --files0-from=x *', 'tree -o out *', 'file -C *', 'wc --files0-from=x *']) expect(safe(c), c).toBe(false);
  });
});

describe('timing helpers are looked through, but only in their exact spelling', () => {
  it.each([
    'timeout 30 ls', 'timeout 5s cat a.txt', 'timeout 1.5 grep x a', 'timeout 2m ls', 'time ls -la', 'nice ls', 'nice -n 10 ls', 'nice -n 0 cat a', 'nohup ls',
    'stdbuf -oL cat a', 'stdbuf -o L grep x a', 'stdbuf -i0 -o0 -e0 cat a', 'timeout 30 nice -n 5 ls', 'time timeout 9 stdbuf -oL ls', 'timeout 30 ls *.ts', 'timeout 5 git status', 'ls | timeout 5 wc -l',
  ])('%s is look-only', (c) => { expect(safe(c), c).toBe(true); });

  it.each([
    // the helper's own options
    'timeout --signal=KILL 5 ls', 'timeout -s KILL 5 ls', 'timeout -k 1 5 ls', 'timeout --kill-after=1 5 ls', 'timeout --foreground 5 ls', 'timeout --preserve-status 5 ls', 'timeout -v 5 ls',
    'timeout ls', 'timeout 5', 'timeout', 'timeout abc ls', 'timeout -5 ls', 'timeout 1e9 ls', 'timeout 99999999999 ls', 'timeout $X ls',
    'time -p ls', 'time -o out ls', 'time --output=out ls', 'time -f %e ls', 'time', 'nice -n -5 ls', 'nice -n ls', 'nice -n 1x ls', 'nice -5 ls', 'nice --adjustment=5 ls', 'nice', 'nice -n 10',
    'nohup', 'nohup -h ls', 'nohup --help',
    'stdbuf', 'stdbuf -o ls', 'stdbuf -oX ls', 'stdbuf -o L -x ls', 'stdbuf --output=L ls', 'stdbuf -oL', 'stdbuf -o9999999 ls', 'stdbuf -oL -- ls',
    // what they wrap must itself be look-only
    'timeout 30 rm a', 'timeout 30 sleep 5', 'nohup sh', 'nohup bash -c ls', 'nice -n 5 npm test', 'time make', 'stdbuf -oL tee out', 'timeout 5 sudo ls', 'timeout 5 env ls', 'timeout 5 find . -exec ls {} ;',
    'timeout 5 sh -c ls', 'time sort -o out a', 'nice sed -i s/a/b/ f', 'nohup git push', 'timeout 5 timeout 5 timeout 5 timeout 5 ls', 'timeout 5 time time time time ls',
    // helpers do not hide a second command or a redirect
    'timeout 5 ls; rm a', 'timeout 5 ls && rm a', 'time ls > out', 'nohup ls &', 'timeout 5 ls $(id)',
  ])('%s asks', (c) => { expect(safe(c), c).toBe(false); });

  it('a wildcard right after a helper is still only an ARGUMENT of a listed command', () => {
    expect(safe('timeout 5 *')).toBe(false);
    expect(safe('timeout * ls')).toBe(false);
    expect(safe('nice -n 1* ls')).toBe(false);
    expect(safe('timeout 5 find *')).toBe(false);
    expect(safe('timeout 5 sort *')).toBe(false);
  });
});

describe('wildcards are expanded and every match is judged (names that look like options, secrets, links)', () => {
  let root: string;
  const touch = (...parts: string[]) => { const f = path.join(root, ...parts); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'); return f; };
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-glob-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }); });
  const quiet = async (c: string) => (await readOnlyChecksFor(c, root, false))?.pathsOk === true;

  it('expands like the shell: no dot-files, folders walk on, last piece is the match', async () => {
    touch('a.ts'); touch('b.ts'); touch('c.md'); touch('.hidden.ts'); touch('src', 'x.ts'); touch('src', 'y.ts'); touch('src', 'deep', 'z.ts');
    expect((await expandWildcards(['*.ts'], root))!.sort()).toEqual(['a.ts', 'b.ts']);
    expect((await expandWildcards(['src/*.ts'], root))!.sort()).toEqual(['src/x.ts', 'src/y.ts']);
    expect((await expandWildcards(['*/*.ts'], root))!.sort()).toEqual(['src/x.ts', 'src/y.ts']);
    expect((await expandWildcards(['?.md'], root))).toEqual(['c.md']);
    expect((await expandWildcards(['*.zzz'], root))).toEqual([]);
  });
  it('an ordinary look runs quietly', async () => {
    touch('a.ts'); touch('b.ts');
    expect(await quiet('ls *.ts')).toBe(true);
    expect(await quiet('cat *.ts | wc -l')).toBe(true);
    expect(await quiet('timeout 30 grep -n x *.ts')).toBe(true);
    expect(await quiet('ls *.nothing')).toBe(true);
  });
  it('ATTACK: a file named like an option makes it ask', async () => {
    for (const evil of ['-rf', '-o', '--output=x', '--pre=sh', '-f', '-', '--', '-n']) {
      fs.writeFileSync(path.join(root, evil), 'x');
    }
    touch('ok.txt');
    for (const c of ['ls *', 'cat *', 'rg x *', 'grep x *', 'head *', 'tail *', 'du -sh *', 'wc *', 'ls -?*', 'ls --*', 'tail ?', 'ls ?']) {
      // a glob like `-?*` is refused by the text rules; the rest expand into the option-like names
      expect(await quiet(c), c).toBe(false);
    }
    expect(await quiet('ls ok*')).toBe(true); // a pattern that cannot reach them is fine
  });
  it('ATTACK: a match that is a credential file, or a link to one, makes it ask', async () => {
    touch('notes.txt'); touch('id_rsa');
    expect(await quiet('cat *')).toBe(false);
    fs.rmSync(path.join(root, 'id_rsa'));
    touch('.env'); // hidden: a * never reaches it
    expect(await quiet('cat *')).toBe(true);
    expect(await quiet('cat .e*')).toBe(false);
    const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-secret-'));
    try {
      fs.writeFileSync(path.join(secretDir, 'f'), 'x');
      fs.symlinkSync(secretDir, path.join(root, 'link')); // a link leading outside the project
      expect(await quiet('cat link/*')).toBe(false);
      expect(await quiet('ls *')).toBe(false); // `link` itself points outside
    } finally { fs.rmSync(secretDir, { recursive: true, force: true }); }
  });
  it('ATTACK: an enormous match asks instead of being walked', async () => {
    for (let i = 0; i < 450; i++) fs.writeFileSync(path.join(root, `f${i}.txt`), '');
    expect(await quiet('ls *')).toBe(false);
    expect(await quiet('ls f1*.txt')).toBe(true);
  });
  it('is still skipped when an earlier command changed the shell settings', async () => {
    touch('a.ts');
    expect((await readOnlyChecksFor('ls *.ts', root, false, true))?.pathsOk).toBe(false);
  });
});
