// Table-driven tests for the built-in "commands that never ask" list
// (shared/safe-readonly-commands.ts), its wiring into the permission engine, and the two
// file-level checks (main/harness/tools/readonly-guard.ts).
//
// WHY the hostile corpus is the point of this file: every published bypass of a safe-command
// list was a flag or spelling nobody had listed. For EVERY command on the list there is at
// least one dangerous form below that must ASK, plus fuzz-style spellings.
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { readOnlyVerdict, readOnlyProgramNames, READONLY_COMMAND_GROUPS, MAX_READONLY_LENGTH } from '../src/shared/safe-readonly-commands';
import { rulesForMode, DESTRUCTIVE_DENY_LIST } from '../src/shared/permission-types';
import { decidePermission } from '../src/main/harness/permission-engine';
import { configRunsPrograms, pathsAreNotSecret, gitSettingsRunNothing } from '../src/main/harness/tools/readonly-guard';

const safe = (c: string) => readOnlyVerdict(c).safe;

// ── 1. Everyday commands that must run without asking ───────────────────────
const ALLOWED: string[] = [
  'ls', 'ls -la', 'ls -lah src', 'ls -1 --color=auto', 'ls -R src', 'ls --almost-all --human-readable',
  'cat README.md', 'cat -n src/a.ts', 'cat a.txt b.txt', 'tac a.txt', 'rev a.txt', 'nl -ba a.txt',
  'head -20 a.txt', 'head -n 5 a.txt', 'head -c100 a.txt', 'tail -n 20 a.txt', 'tail -5 a.txt',
  'wc -l a.txt', 'wc -lwc a.txt', 'stat a.txt', 'stat -c %s a.txt', 'file a.bin', 'file -b --mime-type a.bin',
  'du -sh .', 'du -d 1 -h', 'df -h', 'df -h /', 'free -h', 'tree -L 2', 'tree -a -I node_modules',
  'readlink -f x', 'realpath src', 'basename /a/b.txt', 'dirname /a/b.txt', 'pwd', 'pwd -P',
  'sort a.txt', 'sort -u -k 2 a.txt', 'sort -t , -k2 -n a.txt', 'sort -r -n a.txt', 'uniq -c a.txt', 'uniq -c',
  'cut -d , -f 1 a.csv', 'cut -f1,3 a.tsv', 'paste -s a.txt', 'tr a-z A-Z', 'tr -d x', 'fold -w 80 a.txt',
  'column -t a.txt', 'comm -12 a b', 'cmp a b', 'diff a b', 'diff -u a b', 'diff -r -q d1 d2',
  'md5sum a.txt', 'sha256sum a.txt b.txt', 'base64 a.txt', 'base64 -d a.b64', 'od -c a.bin', 'hexdump -C a.bin',
  'strings a.bin', 'strings -n 8 a.bin',
  'whoami', 'id', 'id -u', 'uname -a', 'hostname', 'date', 'date -u', "date '+%Y-%m-%d'", 'date +%s', 'nproc', 'arch', 'uptime',
  'which node', 'which -a python', 'type ls',
  'grep foo a.txt', 'grep -rn foo src', 'grep -rIn --include=*.ts foo src'.replace('*', 'x'), 'grep -E "a|b" a.txt', "grep -i 'foo bar' a.txt",
  'grep -A 3 -B 3 foo a.txt', 'grep -C3 foo a.txt', 'grep -5 foo a.txt', 'egrep -n foo a', 'fgrep foo a',
  'rg foo', 'rg -n foo src', 'rg -i --hidden foo', 'rg --files', 'rg -g "*.ts" foo', 'rg -t ts foo', 'rg -C 2 foo src', 'rg --json foo',
  "find . -name '*.ts'", 'find src -type f', "find . -type f -name '*.md' -mtime -7", 'find . -maxdepth 2 -type d',
  "find . ( -name a -o -name b )".replace('(', "'('").replace(')', "')'"), 'find . -type f -print0', 'find . -empty',
  'sed -n 5p a.txt', 'sed -n 5,10p a.txt', "sed -n '$p' a.txt", 'sed --quiet 1,3p a.txt',
  'echo hello', 'echo "hello world"', "echo 'a b'", 'echo -n hi', 'printf "%s\\n" hi'.replace('\\n', ''), 'seq 1 5', 'expr 1 + 2', 'true', 'false',
  'test -f a.txt', '[ -f a.txt ]', '[ -d src ] && echo yes', 'test -n "x"',
  'git status', 'git status -s', 'git status --porcelain=v1 -b', 'git log', 'git log --oneline -10', 'git log --oneline --graph --all',
  'git log -n 5 --format=%H', 'git log --stat -p -- src/a.ts', 'git log --since=2.days --author=bob', 'git log -S foo',
  'git diff', 'git diff --stat', 'git diff --cached', 'git diff HEAD~1 HEAD', 'git diff --name-only main...HEAD', 'git diff -- a.txt',
  'git show', 'git show HEAD', 'git show HEAD:a.txt', 'git show --stat abc123',
  'git branch', 'git branch -a', 'git branch -vv', 'git branch --list "feat/*"', 'git branch --show-current', 'git branch -r --contains abc',
  'git tag', 'git tag -l "v1.*"', 'git tag --list', 'git rev-parse HEAD', 'git rev-parse --show-toplevel', 'git rev-parse --abbrev-ref HEAD',
  'git ls-files', 'git ls-files -m', 'git ls-tree HEAD', 'git ls-tree -r --name-only HEAD', 'git cat-file -p HEAD', 'git cat-file -t HEAD',
  'git describe --tags', 'git rev-list --count HEAD', 'git rev-list --max-count=5 HEAD', 'git merge-base main HEAD', 'git blame a.txt', 'git blame -L 1,5 a.txt',
  'git name-rev HEAD', 'git show-ref', 'git show-ref --heads', 'git for-each-ref --format=%(refname) refs/heads'.replace('%(refname)', 'x'), 'git count-objects -v',
  'git grep foo', 'git grep -n foo -- src', 'git remote', 'git remote -v', 'git remote get-url origin', 'git worktree list', 'git stash list', 'git reflog', 'git reflog show',
  'git --no-pager log', 'git --no-pager diff', 'git --version', 'git version',
  // harmless spellings: padding, end-of-options, bare dash, a lone ~ inside a revision
  ' ls', 'ls ', 'ls --', 'ls -- -la', 'ls -- --all', 'ls -', 'ls --color=', 'git log HEAD~3..HEAD', 'ls a~', 'git show HEAD^', 'git diff main..feature~2',
  'node --version', 'npm --version', 'python3 --version', 'go version', 'cargo --version',
  // chains where every part passes
  'ls && pwd', 'ls; pwd', 'git status && git diff', 'cat a.txt | head -5', 'grep foo a.txt | sort | uniq -c | head', 'git log --oneline | head -5',
  'find . -name x | wc -l', 'ls 2>&1', 'ls > /dev/null'.replace(' > ', ' >'), 'grep foo a 2>/dev/null', 'ls || echo none', 'ls -la 2>&1 | head',
];

// ── 2. Hostile forms: each must ASK ─────────────────────────────────────────
// Grouped by the command they target; the comment names why it is dangerous.
const HOSTILE: Record<string, string[]> = {
  find: [
    'find . -exec rm {} ;', "find . -exec sh -c 'x' ';'", "find . -execdir ls '{}' ';'", "find . -ok rm '{}' ';'", "find . -okdir rm '{}' ';'",
    'find . -delete', 'find . -name x -delete', "find . -fprint out.txt", 'find . -fprint0 out', "find . -fprintf out '%p'", 'find . -fls out',
    'find . -files0-from list', 'find . -exe', 'find . -dele', 'find . -newer', 'find . -prune -exec', 'find / -delete -name x',
    "find . '-delete'", "find . -'delete'", 'find . -exec', 'find . -execdir', 'find -D exec', 'find . -printf', 'find . -unknownprimary',
  ],
  sort: ['sort -o out a', 'sort --output=out a', 'sort --output out a', 'sort -oout a', 'sort --compress-program=sh a', 'sort --compress-program sh -S 1b a',
    'sort -T /tmp a', 'sort --temporary-directory=/tmp a', 'sort --random-source=/etc/passwd -R a', 'sort --files0-from=list', 'sort --out=x a', 'sort --compress=sh a', 'sort -S 1b --compress-program "sh" a'],
  uniq: ['uniq in out', 'uniq a b c', 'uniq --output=x a'],
  tree: ['tree -o out', 'tree --output=out', 'tree -ofile', 'tree --fromfile list', 'tree -R', 'tree -H http://x', 'tree --out=x'],
  sed: ["sed -i s/a/b/ f", "sed -n -i 5p f", "sed 's/a/b/e' f", "sed -e 'e id' f", "sed -n 'w out' f", "sed -n 5w p", 'sed -f script f', 'sed --in-place s/a/b/ f',
    "sed -n 5p -i f", 'sed 5p f', "sed -n '5,10!d' f", 'sed -n p f', "sed -n 1p -s f", 'sed --expression=e f', 'sed -s -n 5p f', 'sed -n 5pp f', "sed -n '1p;w x' f", 'sed -n -e 5p f'],
  git: [
    'git -c core.pager=sh log', 'git -ccore.pager=sh log', 'git --config-env=core.pager=X log', 'git -C /tmp status', 'git --git-dir=/tmp/x status', 'git --work-tree=/ status',
    'git --exec-path=/tmp status', 'git --paginate log', 'git -p log', 'git log --output=out', 'git log --output out', 'git log --outpu=out', 'git log --out=out', 'git diff --output=out',
    'git diff --ext-diff', 'git diff --ext', 'git diff --textconv', 'git show --textconv x', 'git log --ext-diff -p', 'git log --show-signature', 'git cat-file --textconv HEAD:a',
    'git cat-file --filters HEAD:a', 'git cat-file --batch', 'git grep -O', 'git grep --open-files-in-pager=sh x', 'git grep -Osh x', 'git grep --exec x', 'git ls-remote --upload-pa="sh" r',
    'git ls-remote origin', 'git fetch', 'git pull', 'git push', 'git commit -m x', 'git add .', 'git reset --hard', 'git checkout .', 'git clean -fd', 'git stash', 'git stash pop', 'git stash drop',
    'git branch newbranch', 'git branch -d x', 'git branch -D x', 'git branch -m a b', 'git branch -c a b', 'git branch --set-upstream-to=o/x', 'git branch -f x HEAD', 'git branch -l newname',
    'git tag v1', 'git tag -d v1', 'git tag -a v1 -m x', 'git tag -f v1', 'git remote add o u', 'git remote set-url o u', 'git remote remove o', 'git remote show origin', 'git remote update',
    'git config --list', 'git config user.name x', 'git config --get remote.origin.url', 'git help log', 'git log --exec=x', 'git reflog expire --all', 'git reflog delete HEAD@{0}',
    'git worktree add ../x', 'git worktree remove x', 'git submodule status', 'git submodule update', 'git apply p', 'git am p', 'git rebase main', 'git merge x', 'git cherry-pick x',
    'git -c', 'git', 'git --no-pager', 'git status --upload-pack=x', 'git diff --no-index a b --output=c', 'git rev-parse --resolve-git-dir x', 'git log -c core.pager=x',
    'git alias', 'git log --pretty=format:x --output=y', 'git archive HEAD', 'git bundle create x', 'git format-patch -1', 'git instaweb', 'git daemon', 'git difftool', 'git mergetool',
    'git blame --contents /etc/shadow a', 'git rev-list --exec x', 'git diff -O/etc/passwd', 'git log --output=/dev/null', 'git stash show --output=x',
    "git 'push'", 'git -- log', 'git log --unified=x --output=y', 'git show-ref --tags --output=x', 'git for-each-ref --shell', 'git describe --dirty=x --exec',
  ],
  rg: ['rg --pre sh x', 'rg --pre=sh x', 'rg --pre-glob=* x', 'rg --pr sh x', 'rg -z x', 'rg --search-zip x', 'rg --hostname-bin=sh x', 'rg --hostname-bin sh', 'rg --no-config x', 'rg --generate man', 'rg --debug x', 'rg --pre', 'rg --PRE=sh x', 'rg -zn x'],
  grep: ['grep --exclude-from=x y', 'grep -D skip', 'grep --unknown x', 'grep -X x', 'grep --binary-file=x y'],
  cat: ['cat -o x', 'cat --output=x', 'cat > out', 'cat >> out', 'cat < in', 'cat <<EOF'],
  tail: ['tail -f x', 'tail -F x', 'tail --follow x', 'tail --follow=name x', 'tail -f', 'tail -fn1 x', 'tail --pid=1 x', 'tail --retry x', 'tail -s 1 x', 'tail --sleep-interval=1 x'],
  head: ['head --follow x', 'head -f x', 'head -o x'],
  date: ['date -s 12:00', 'date --set=12:00', 'date 010112002026', 'date -f file', 'date --file=x', 'date -d @0', 'date --date=x', 'date -r file', 'date -I=x', 'date +%s 1', 'date x', 'date -u 0101'],
  hostname: ['hostname newname', 'hostname -F file', 'hostname -b x', 'hostname -s'],
  base64: ['base64 -o out a', 'base64 --output=out a', 'base64 -oout a', 'base64 -i in', 'base64 --out=x a', 'base64 -o'],
  file: ['file -C', 'file -m magic x', 'file --magic-file=m x', 'file -f list', 'file --files-from=l', 'file -z x', 'file -Z x', 'file -C -m x', 'file --compile'],
  diff: ['diff -X ex a b', 'diff --exclude-from=ex a b', 'diff --to-file=x', 'diff --output=x a b', 'diff -o x a b', 'diff -D x a b'],
  du: ['du --files0-from=list', 'du -X ex', 'du --exclude-from=ex', 'du --files0=x', 'du -o x'],
  df: ['df --sync', 'df --output=x', 'df -y'],
  free: ['free -s 1', 'free --seconds=1', 'free -c 3', 'free --count=3'],
  stat: ['stat -f --foo', 'stat --foo', 'stat -x y'],
  ls: ['ls --unknown', 'ls -Y', 'ls --color=always --foo', 'ls -@', 'ls --ls'],
  wc: ['wc --files0-from=x', 'wc --files0-from x'],
  md5sum: ['md5sum -c sums', 'md5sum --check sums', 'sha256sum -c x', 'sha256sum --check=x', 'cksum --check x'],
  echo: ['echo hi > out', 'echo hi >> out', 'echo $(id)', 'echo `id`', 'echo $HOME', 'echo ${HOME}', 'echo $((1+1))', 'echo hi &', 'echo hi > /etc/passwd', 'echo hi 2>out', 'echo hi >&2', 'echo >/dev/nullx', 'echo <(ls)', 'echo >(ls)'],
  printf: ['printf -v x hi', 'printf', 'printf -- hi'],
  seq: ['seq --foo 3', 'seq -o x 3'],
  test: ['test -f a ; rm a', '[ -f a', '[ -f a ] ; rm a'],
  tr: ['tr a b c', 'tr -o x', 'tr a'.replace('a', 'a b c')],
  strings: ['strings -o2 x'.replace('-o2', '--output=x'), 'strings --unknown x'],
  od: ['od -N', 'od --output=x a', 'od -z', 'od -j'],
  hexdump: ['hexdump -e x', 'hexdump -f fmt'],
  column: ['column -l x'],
  comm: ['comm a b c', 'comm --output=x a b'],
  cmp: ['cmp -z a b'],
  fold: ['fold --unknown'],
  paste: ['paste --foo a'],
  cut: ['cut --foo a'],
  nl: ['nl --foo a', 'nl -z'],
  pwd: ['pwd x', 'pwd -x'],
  id: ['id -x', 'id --foo'],
  whoami: ['whoami x', 'whoami --foo'],
  egrep: ['egrep --pre=sh x', 'egrep -D skip x', 'egrep --exclude-from=f x'],
  fgrep: ['fgrep --pre=sh x', 'fgrep -X x'],
  uname: ['uname --set x', 'uname -S foo'],
  which: ['which -s -x'],
  type: ['type -x'],
  basename: ['basename --foo x'],
  readlink: ['readlink --foo x'],
  realpath: ['realpath --foo x'],
  dirname: ['dirname --foo'],
  uptime: ['uptime -x'],
  nproc: ['nproc --foo'],
  arch: ['arch -x86_64 sh', 'arch x'],
  expr: ['expr 1 + 1 > out', 'expr $(id)'],
  'version probes': ['node --version x', 'node -e 1', 'node --eval 1', 'python -c "1"', 'python3 script.py', 'python --version --foo', 'npm --version install', 'npm install', 'npm run x', 'cargo build', 'go build', 'go run x', 'go env -w X=1', 'git --version x', 'java -jar x', 'make', 'make clean', 'gcc x.c', 'docker ps', 'docker --version x', 'rustc x.rs', 'pip install x', 'node', 'python', 'npm', 'npx x', 'npx --version x', 'deno run x', 'ruby -e 1'],
};

// Programs deliberately NOT on the list, even though another assistant allows them.
const EXCLUDED = [
  'cd /tmp', 'cd', 'cd ..', 'cd src && ls', 'ps aux', 'ps -ef', 'ps', 'top', 'env', 'printenv', 'printenv HOME', 'set', 'export A=1', 'jq . a.json', 'jq -n env', 'awk "{print}" a', 'awk "BEGIN{system(\\"id\\")}"',
  'xargs ls', 'xargs -t touch echo', 'man ls', 'man --html=x man', 'less a', 'more a', 'tee out', 'tee -a out', 'touch a', 'mkdir a', 'rm a', 'rm -rf a', 'mv a b', 'cp a b', 'ln -s a b', 'chmod 600 a', 'chown x a',
  'curl https://x', 'wget https://x', 'ssh host', 'scp a h:b', 'rsync a b', 'nc host 1', 'sudo ls', 'su', 'doas ls', 'docker ps', 'kubectl get pods', 'history', 'history -s x', 'history -a ~/.bashrc',
  'sleep 1', 'watch ls', 'time ls', 'timeout 5 ls', 'nice ls', 'nohup ls', 'stdbuf ls', 'command ls', 'builtin ls', 'exec ls', 'eval ls', 'source x', '. x', 'bash -c ls', 'sh -c ls', 'zsh -c ls', 'python -c 1', 'node -e 1', 'perl -e 1', 'ruby -e 1',
  'xxd a b', 'xxd -r a b', 'dd if=a of=b', 'truncate -s 0 a', 'shred a', 'mkfifo a', 'mktemp', 'install a b', 'split a', 'csplit a 1', 'lsof', 'netstat', 'ss -l', 'ip addr', 'ifconfig', 'mount', 'umount x', 'kill 1', 'pkill x', 'killall x',
  'yes', 'cal', 'ping x', 'dig x', 'nslookup x', 'host x', 'traceroute x', 'whois x', 'tar tf a', 'tar xf a', 'unzip -l a', 'gzip -l a', 'zcat a', 'bzcat a', 'xzcat a', 'zgrep x a', 'zless a', 'view a', 'vi a', 'nano a', 'emacs a',
  'make', 'npm test', 'npm ls', 'pip list', 'pip3 list', 'git config --list', 'git ls-remote origin', 'tput cols', 'clear', 'reset', 'sync', 'ulimit -a', 'umask', 'alias', 'unalias x', 'declare -p', 'read x', 'wait', 'jobs', 'fg', 'bg', 'disown', 'trap x', 'getconf -a', 'locale', 'lscpu', 'lsblk', 'lsusb', 'lspci', 'dmesg', 'journalctl', 'last', 'w', 'who', 'finger',
];

// Spellings of otherwise-allowed commands that must ASK: parsing tricks and odd characters.
const FUZZ: string[] = [
  // substitution / expansion
  'ls $(id)', 'ls `id`', 'ls $HOME', 'ls ${HOME}', 'ls $\'a\'', 'ls "$(id)"', 'ls "`id`"', 'ls "$HOME"', 'ls ${a:-b}', 'ls $((1))', 'ls $[1]', 'ls <(id)', 'ls >(id)',
  'ls $IFS', 'rg -v -e x$IFS.$IFS--pre=sh', 'echo ${one="$"}${two="$one(id)"}${two@P}', 'ls $(<f)', 'ls {a,b}', 'ls {1..3}', 'ls $({rm,x})', 'cat {a,b}',
  // globs (could expand to a flag-looking file name)
  'ls *', 'ls *.ts', 'ls ?', 'ls [a-z]*', 'cat *', 'sort *', 'find *', 'ls a*b', 'git diff *', 'ls ~root', 'ls ~/*', 'ls ~+', 'ls ~-',
  // other operators
  'ls &', 'ls & pwd', 'ls &&', '&& ls', 'ls ||', '|| ls', 'ls |', '| ls', 'ls ;', '; ls', 'ls ;;', 'ls |& cat', 'ls &> out', 'ls &>> out', 'ls >| out', 'ls 3>x', 'ls 2>x', 'ls 1>x', 'ls >x', 'ls >>x', 'ls <x', 'ls <<x', 'ls <<<x', 'ls >/dev/null2', 'ls 2>/dev/null2', 'ls 2>&2', 'ls 2>&1x', 'ls >&2',
  '(ls)', '{ ls; }', 'ls ; (rm a)', 'if true; then ls; fi', 'for i in 1; do ls; done', 'while true; do ls; done', 'time ls', '! ls', 'ls !', 'ls #x', '#ls', 'ls # x',
  // whitespace and control characters
  'ls\nrm a', 'ls\n', '\nls', 'ls\r', 'ls\rrm a', 'ls\trm', 'ls\tfoo', 'ls\0', 'ls\0rm', 'ls \x1b[0m', 'ls\x07', 'ls\x7f', 'ls\vrm', 'ls\frm', 'ls -la', 'ls rm a', 'ls rm a', 'ls\u0085rm',
  '', ' ', 'ls\\', 'ls \\', 'ls a\\', 'ls a\\\nrm b', 'ls \\;', 'l\\s', 'ls a\\ b', 'ls "a\\"b"', "ls 'a\\'b'",
  // quoting
  "ls 'unterminated", 'ls "unterminated', "ls ''' ", "ls '\n'", 'ls "\n"', 'ls "a\nb"', "ls 'a\tb'", 'ls "a\tb"', 'ls "a\0b"', "ls '\x00'",
  // names and paths
  '/bin/ls', '/usr/bin/ls', './ls', '../ls', '~/ls', '/tmp/ls', 'LS', 'Ls', 'ls.exe', 'ls.sh', 'ls.', '.ls', '.', ':', 'ls=1', 'A=1 ls', 'A=1; ls', 'PATH=/tmp ls', 'LD_PRELOAD=x ls', 'env ls', 'FOO=$(id) ls',
  "'/bin/ls'", '"/bin/ls"', '/bin/../bin/ls', 'command ls', '\\ls', "l''s".replace("''", "\\\\"), 'ｌｓ', 'ⅼs', 'lѕ', 'ls​', '​ls', 'l​s', 'ls‮-la', '﻿ls', 'ls﻿',
  // flags
  'ls --all=x', 'ls -l=x', 'ls ---all', 'ls -a-l', 'ls -la -z', 'ls -zl', 'ls --alll', 'ls --al', 'ls --ALL', 'ls -A -- *',
  // abbreviated long options
  'git log --oneli', 'git log --one', 'git diff --stat=', 'git diff --nam', 'git status --porc', 'grep --recur foo', 'grep --inc=x foo', 'rg --hid foo', 'ls --almost', 'wc --lin x', 'du --max=1', 'sort --rev a', 'head --lin=2 a',
  // clustered short flags with a bad letter
  'ls -laZq1X9', 'sort -rn -o x a', 'sort -rno x a', 'sort -nro x', 'grep -rnE -f', 'git branch -vd x', 'git branch -av -D x', 'git log -pS', 'tail -fn5 a', 'wc -lx a',
  // sizes
  'x'.repeat(MAX_READONLY_LENGTH + 1), 'ls ' + 'a'.repeat(MAX_READONLY_LENGTH), 'ls ' + 'a '.repeat(3000), 'ls' + ' ; ls'.repeat(1000),
  // paths with the redirect look-alikes
  'echo a>b', 'echo a>/dev/null>b', 'echo >/dev/null >b', 'echo 2>&1>x', 'echo 2>&1 >x', 'echo 2>&1; rm a',
];

describe('readOnlyVerdict: everyday commands run without asking', () => {
  it.each(ALLOWED)('%s', (c) => { expect(safe(c)).toBe(true); });
});

describe('readOnlyVerdict: every dangerous form asks', () => {
  for (const [cmd, lines] of Object.entries(HOSTILE)) {
    describe(cmd, () => {
      it.each(lines)('%s', (c) => { expect(safe(c)).toBe(false); });
    });
  }
  it('has at least one hostile form for every allowed program', () => {
    const covered = new Set(Object.values(HOSTILE).flat().map((l) => l.replace(/^git .*/, 'git').split(/\s+/)[0]));
    const missing = readOnlyProgramNames().filter((p) => !covered.has(p) && !['true', 'false', 'rev', 'nl', 'wc', 'sha1sum', 'sha224sum', 'sha384sum', 'sha512sum', 'b2sum', 'cksum', 'tac', 'gh', 'bun', 'pnpm', 'yarn', 'pip', 'pip3', 'ruby', 'deno', 'cmake', 'gcc', 'make', 'rustc', 'java', 'docker', 'npx', 'npm', 'node', 'python', 'python3', 'cargo', 'go'].includes(p));
    expect(missing).toEqual([]);
  });
  it.each(['sha1sum -c x', 'sha384sum --check x', 'b2sum -c x', 'tac -o x', 'rev --output=x', 'nl -z', 'wc -o x'])('checksum/misc: %s', (c) => { expect(safe(c)).toBe(false); });
});

describe('readOnlyVerdict: commands deliberately left off the list', () => {
  it.each(EXCLUDED)('%s', (c) => { expect(safe(c)).toBe(false); });
});

describe('readOnlyVerdict: spelling and parsing tricks ask', () => {
  it.each(FUZZ)('%j', (c) => { expect(safe(c)).toBe(false); });
  it('a chain asks if ANY part is not on the list', () => {
    for (const c of ['ls && rm a', 'ls | tee out', 'git status; git push', 'cat a | sh', 'ls || curl x', 'pwd; cd /; ls', 'echo hi | xargs rm', 'ls | head | sh']) expect(safe(c)).toBe(false);
  });
  it('PowerShell is never trusted', () => { expect(readOnlyVerdict('ls', { powershell: true }).safe).toBe(false); });
  it('does not throw on any odd input', () => {
    const odd = ['\uD800', 'ls \uDC00', '\u0000', 'ls ' + '‮'.repeat(10), '\\'.repeat(5000), "'".repeat(3001), '"'.repeat(3001)];
    for (const c of odd) expect(() => readOnlyVerdict(c)).not.toThrow();
  });
  it('random byte soup never passes unless it is plain words of a listed command', () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const alphabet = ['ls', 'rm', ' ', '-', '--', '$', '`', '(', ')', ';', '|', '&', '>', '<', '"', "'", '\\', '\n', '*', '{', '}', 'a', '-exec', '-o', 'git', 'find', '.', '=', '!', '#', '~'];
    for (let i = 0; i < 4000; i++) {
      let c = '';
      const n = 1 + Math.floor(rnd() * 10);
      for (let k = 0; k < n; k++) c += alphabet[Math.floor(rnd() * alphabet.length)];
      const v = readOnlyVerdict(c);
      if (v.safe) {
        // A passing line must contain none of the shell characters we refuse, and no dangerous word.
        expect(/[$`(){}<>*\\\n!#]|&(?!&)|-exec|-o\b|\brm\b/.test(c.replace(/2>&1|>\/dev\/null/g, ''))).toBe(false);
      }
    }
  });
});

describe('Settings text stays in step with the list', () => {
  it('every command named for the person is really allowed', () => {
    const programs = new Set(readOnlyProgramNames());
    for (const g of READONLY_COMMAND_GROUPS) {
      for (const name of g.commands) {
        if (name === '…and similar') continue;
        const prog = name.split(' ')[0];
        expect(programs.has(prog), `${name} is listed for the person but not allowed`).toBe(true);
      }
    }
  });
  it('every allowed program is named for the person', () => {
    const shown = new Set(READONLY_COMMAND_GROUPS.flatMap((g) => g.commands.map((c) => c.split(' ')[0])));
    const hidden = readOnlyProgramNames().filter((p) => !shown.has(p) && !['go', 'gh', 'bun', 'pnpm', 'yarn', 'npx', 'pip', 'pip3', 'cargo', 'rustc', 'docker', 'deno', 'ruby', 'gcc', 'make', 'cmake', 'java', 'node', 'npm', 'python', 'python3'].includes(p));
    expect(hidden).toEqual([]);
  });
});

// ── the engine ──────────────────────────────────────────────────────────────
const OK = { readOnlyChecks: { pathsOk: true, gitOk: true } };
function decide(mode: 'ask' | 'auto-edit' | 'full-auto', cmd: string, ctx: any = OK, remembered: any[] = []) {
  return decidePermission('Bash', cmd, { presetRules: [], modeRules: rulesForMode(mode), denyList: DESTRUCTIVE_DENY_LIST, rememberedRules: remembered }, ctx);
}
describe('permission engine and the read-only list', () => {
  it('Ask first and Auto-edit run listed commands without asking', () => {
    expect(decide('ask', 'git status').action).toBe('allow');
    expect(decide('auto-edit', 'ls -la').action).toBe('allow');
    expect(decide('ask', 'git status').denyListed).toBe(false);
  });
  it('anything else still asks in both modes', () => {
    for (const c of ['npm install', 'rm a', 'ls && rm a', 'curl https://x', 'git push', 'find . -delete']) {
      expect(decide('ask', c).action).toBe('ask');
      expect(decide('auto-edit', c).action).toBe('ask');
    }
  });
  it('Full auto is unchanged (it already allows everything; the deny-list still outranks it)', () => {
    expect(decide('full-auto', 'ls').action).toBe('allow');
    expect(decide('full-auto', 'git push').action).toBe('ask');
    expect(rulesForMode('full-auto').some((r) => r.match === 'safe-readonly')).toBe(false);
  });
  it('without the file checks the list does not apply (fails closed)', () => {
    expect(decide('ask', 'ls', {}).action).toBe('ask');
    expect(decide('ask', 'ls', { readOnlyChecks: { pathsOk: false, gitOk: true } }).action).toBe('ask');
    expect(decide('ask', 'git status', { readOnlyChecks: { pathsOk: true, gitOk: false } }).action).toBe('ask');
    expect(decide('ask', 'ls', { readOnlyChecks: { pathsOk: true, gitOk: false } }).action).toBe('allow'); // gitOk only matters for git
  });
  it('PowerShell sessions never use the list', () => {
    expect(decide('ask', 'ls', { ...OK, powershell: true }).action).toBe('ask');
  });
  it('the destructive deny-list still wins over the list', () => {
    expect(decide('ask', 'echo rm hello').action).toBe('ask'); // "* rm *"
    expect(decide('ask', 'echo rm hello').denyListed).toBe(true);
    expect(decide('ask', 'grep sudo notes.txt').denyListed).toBe(true);
  });
  it('the list never applies to other tools', () => {
    expect(decidePermission('Write', 'ls', { presetRules: [], modeRules: rulesForMode('ask'), denyList: [], rememberedRules: [] }, OK).action).toBe('ask');
  });
  it('the rule is not stored as a pattern a user could widen', () => {
    const rule = rulesForMode('ask').find((r) => r.match === 'safe-readonly')!;
    expect(rule.pattern).toBeUndefined();
    expect(rule.tool).toBe('Bash');
  });
});

// ── the two file-level checks ───────────────────────────────────────────────
describe('pathsAreNotSecret', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-guard-'));
  it('ordinary project words pass', () => { expect(pathsAreNotSecret(['cat', 'src/a.ts', '-n'], tmp)).toBe(true); });
  it('credential locations ask, however they are spelled', () => {
    for (const w of ['~/.ssh/id_rsa', '.env', '../.env', '--file=.env', '~/.aws/credentials', '~/.gnupg/x', '.ssh/id_ed25519', '/home/x/.ssh/config']) {
      expect(pathsAreNotSecret(['cat', w], tmp), w).toBe(false);
    }
  });
  it('a link inside the project that leads to a credential asks', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-home-'));
    fs.mkdirSync(path.join(home, '.ssh'));
    fs.writeFileSync(path.join(home, '.ssh', 'id_rsa'), 'secret');
    const link = path.join(tmp, 'notes.txt');
    fs.symlinkSync(path.join(home, '.ssh', 'id_rsa'), link);
    expect(pathsAreNotSecret(['cat', 'notes.txt'], tmp)).toBe(false);
  });
  it('a very long list of words asks', () => { expect(pathsAreNotSecret(Array(200).fill('a'), tmp)).toBe(false); });
});

describe('configRunsPrograms', () => {
  it.each([
    [['core.fsmonitor', '/tmp/x']], [['core.pager', 'sh']], [['core.hooksPath', '/x']], [['core.sshCommand', 'x']], [['diff.external', 'x']],
    [['diff.evil.textconv', 'x']], [['diff.evil.command', 'x']], [['include.path', '/x']], [['includeIf.gitdir:/.path', '/x']], [['filter.lfs.smudge', 'x']],
    [['gpg.program', 'x']], [['log.showSignature', 'true']], [['credential.helper', 'x']], [['alias.status', '!sh']], [['pager.log', 'sh']], [['core.fsmonitor', 'true']], [['Core.FSMonitor', 'x']],
    [['merge.x.driver', 'sh']], [['core.attributesFile', '/x']], [['core.editor', 'x']],
  ])('%j runs a program', (e) => { expect(configRunsPrograms([e as [string, string]])).toBe(true); });
  it.each([
    [['core.repositoryformatversion', '0']], [['core.filemode', 'true']], [['remote.origin.url', 'https://x']], [['user.name', 'x']], [['branch.main.remote', 'origin']], [['core.fsmonitor', 'false']], [['core.bare', 'false']],
  ])('%j is ordinary', (e) => { expect(configRunsPrograms([e as [string, string]])).toBe(false); });
});

describe('gitSettingsRunNothing (real repositories)', () => {
  const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, stdio: 'pipe' });
  const mk = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-git-')); git(d, 'init', '-q'); return d; };
  it('a plain repo is trusted, also from a sub-folder', async () => {
    const d = mk(); fs.mkdirSync(path.join(d, 'sub'));
    expect(await gitSettingsRunNothing(d)).toBe(true);
    expect(await gitSettingsRunNothing(path.join(d, 'sub'))).toBe(true);
  });
  it('a repo whose settings name a helper program asks', async () => {
    const d = mk();
    fs.appendFileSync(path.join(d, '.git', 'config'), '[core]\n\tfsmonitor = /tmp/evil\n');
    expect(await gitSettingsRunNothing(d)).toBe(false);
    fs.mkdirSync(path.join(d, 'sub'));
    expect(await gitSettingsRunNothing(path.join(d, 'sub'))).toBe(false);
  });
  it('a text-converter driver asks', async () => {
    const d = mk();
    fs.appendFileSync(path.join(d, '.git', 'config'), '[diff "x"]\n\ttextconv = /tmp/evil\n');
    expect(await gitSettingsRunNothing(d)).toBe(false);
  });
  it('a linked work folder is judged by the settings it points to', async () => {
    const d = mk();
    fs.appendFileSync(path.join(d, '.git', 'config'), '[core]\n\tpager = sh\n');
    const w = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-wt-'));
    fs.writeFileSync(path.join(w, '.git'), `gitdir: ${path.join(d, '.git')}\n`);
    expect(await gitSettingsRunNothing(w)).toBe(false);
  });
  it('a folder that is itself a bare repository is judged too', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-bare-'));
    git(d, 'init', '-q', '--bare');
    expect(await gitSettingsRunNothing(d)).toBe(true);
    fs.appendFileSync(path.join(d, 'config'), '[core]\n\tfsmonitor = x\n');
    expect(await gitSettingsRunNothing(d)).toBe(false);
  });
  it('no repo found is fine; an unreadable pointer asks', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-none-'));
    // tmp may itself sit inside a repo on a dev machine; only assert the pointer case strictly
    fs.writeFileSync(path.join(d, '.git'), 'garbage');
    expect(await gitSettingsRunNothing(d)).toBe(false);
  });
});
