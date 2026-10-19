#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, delimiter, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export function isMain(metaUrl, filename = process.argv[1]) {
  if (typeof filename !== 'string') return false;
  // WHY: Node canonicalizes module URLs, but macOS argv can retain /var while
  // the same file lives at /private/var. An alias must not suppress a CLI gate.
  try { return realpathSync(filename) === realpathSync(fileURLToPath(metaUrl)); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}
export function npmCli(env = process.env, executable = process.execPath) {
  // WHY: Windows npm is a command shim, not a directly spawnable executable.
  // Run npm's actual JavaScript CLI under the selected Node, without a shell;
  // this also preserves literal paths/arguments containing spaces or metacharacters.
  const nodeDirectory = dirname(executable);
  const candidates = [
    join(nodeDirectory, 'node_modules/npm/bin/npm-cli.js'),
    join(nodeDirectory, '../lib/node_modules/npm/bin/npm-cli.js'),
    env.npm_execpath,
  ];
  for (const directory of (env.PATH ?? env.Path ?? env.path ?? '').split(delimiter).filter(Boolean)) {
    candidates.push(join(directory, 'node_modules/npm/bin/npm-cli.js'), join(directory, '../lib/node_modules/npm/bin/npm-cli.js'), join(directory, 'npm'));
  }
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    try {
      const actual = realpathSync(candidate);
      if (basename(actual) === 'npm-cli.js' && statSync(actual).isFile()) return actual;
    } catch { /* Missing installation layout: try the next known CLI location. */ }
  }
  throw new Error('Cannot locate npm CLI beside Node or on PATH');
}
export function run(command, args, cwd = process.cwd(), capture = true, env) {
  // WHY: consume the complete stream, without exec's maxBuffer or early grep/SIGPIPE.
  return new Promise((accept, reject) => {
    // WHY: package compressors need child-only options, with inherited PATH and
    // credentials intact; old callers keep spawn's original inheritance behavior.
    const child = spawn(command, args, { cwd, env: env === undefined ? undefined : { ...process.env, ...env }, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    const output = [], errors = [];
    child.stdout?.on('data', chunk => output.push(chunk)); child.stderr?.on('data', chunk => errors.push(chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => code === 0 && !signal ? accept(Buffer.concat(output)) : reject(new Error(`${command} ${args.join(' ')} failed (${signal || code}): ${Buffer.concat(errors)}`)));
  });
}
function sha(value) { assert.match(value ?? '', /^[a-f0-9]{40}$/); return value; }
export async function classify(eventName, event, expectedSha, cwd = process.cwd()) {
  assert.ok(event && typeof event === 'object' && !Array.isArray(event));
  sha(expectedSha);
  const git = async (...args) => (await run('git', args, cwd)).toString().trim();
  assert.equal(await git('rev-parse', 'HEAD'), expectedSha, 'Checkout is not event SHA');
  assert.equal(await git('cat-file', '-t', expectedSha), 'commit');
  let base, eventBase;
  if (eventName === 'pull_request') {
    eventBase = sha(event.pull_request?.base?.sha);
    const head = sha(event.pull_request?.head?.sha);
    // WHY: checkout's verified synthetic merge is authoritative. Event base may
    // race master, and a shallow checkout need not contain that old event base.
    const parents = (await git('show', '-s', '--format=%P', expectedSha)).split(' ');
    if (parents.length !== 2 || parents[1] !== head) return { route: 'full', sha: expectedSha, eventBase };
    base = sha(parents[0]);
  } else if (eventName === 'push') {
    assert.equal(sha(event.after), expectedSha);
    base = sha(event.before);
    if (/^0+$/.test(base)) return { route: 'full', sha: expectedSha };
  } else {
    const scope = event.inputs?.test_scope;
    assert.ok(scope === undefined || scope === 'all' || scope === 'browser', 'Unknown manual scope');
    return { route: eventName === 'workflow_dispatch' && scope === 'browser' ? 'browser' : 'full', sha: expectedSha };
  }
  assert.equal(await git('cat-file', '-t', base), 'commit');
  const diff = await run('git', ['diff', '--name-only', '-z', '--no-renames', `${base}..${expectedSha}`, '--'], cwd);
  if (diff.length) assert.equal(diff.at(-1), 0, 'Incomplete NUL diff');
  const files = diff.length ? diff.toString('latin1').slice(0, -1).split('\0') : [];
  return { route: files.length > 0 && files.every(name => name.startsWith('docs/') && name.length > 5) ? 'docs' : 'full', sha: expectedSha, eventBase, testedBase: base, changedFiles: files.length,
    packageMode: packagingMode(eventName, files) };
}
export function packagingMode(eventName, files) {
  // WHY: gzip does not exercise the release-default XZ path. Only a proven
  // ordinary PR source/test diff may use it; builder/dependency/assets/native/
  // workflow changes and all unknown/manual/nightly inputs test defaults.
  return eventName === 'pull_request' && files.length > 0 && files.every(name => /^desktop\/(?:src|tests)\/.*\.(?:ts|tsx)$/.test(name)) ? 'fast' : 'default';
}
export function matrixFor(eventName) {
  return { include: (eventName === 'pull_request' ? [['ubuntu-latest', 4]] : [['ubuntu-latest', 4], ['windows-latest', 6], ['macos-latest', 4]])
    .flatMap(([os, total]) => Array.from({ length: total }, (_, index) => ({ os, shard: index + 1, total }))) };
}
export function completionAllowed(needs, expectedSha, eventName) {
  if (!/^[a-f0-9]{40}$/.test(expectedSha ?? '') || needs?.changes?.result !== 'success' || needs.changes.outputs?.sha !== expectedSha) return false;
  const keys = ['changes', 'tests', 'prepare', 'formats', 'android', 'evidence', 'browser'];
  if (Object.keys(needs).length !== keys.length || !keys.every(key => Object.hasOwn(needs, key))) return false;
  const route = needs.changes.outputs.route;
  if (!['full', 'docs', 'browser'].includes(route) || (route === 'browser' && eventName !== 'workflow_dispatch')) return false;
  if (route === 'full' && (!['default', 'fast'].includes(needs.changes.outputs.packageMode)
    || needs.evidence?.outputs?.packageMode !== needs.changes.outputs.packageMode || needs.evidence?.outputs?.sha !== expectedSha)) return false;
  return ['tests', 'prepare', 'formats', 'android', 'evidence', 'browser'].every(key => needs[key]?.result ===
    (route === 'full' ? (key === 'browser' ? 'skipped' : 'success') : route === 'browser' && key === 'browser' ? 'success' : 'skipped'));
}
async function main() {
  if (process.argv[2] === 'changes') {
    const result = await classify(process.env.GITHUB_EVENT_NAME, JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')), process.env.GITHUB_SHA);
    console.log(JSON.stringify(result));
    appendFileSync(process.env.GITHUB_OUTPUT, `route=${result.route}\nsha=${result.sha}\nmatrix=${JSON.stringify(matrixFor(process.env.GITHUB_EVENT_NAME))}\npackageMode=${result.packageMode ?? 'default'}\n`);
  } else if (process.argv[2] === 'gate') {
    assert.ok(completionAllowed(JSON.parse(process.env.CI_NEEDS), process.env.GITHUB_SHA, process.env.GITHUB_EVENT_NAME), 'Selected CI route is incomplete');
    console.log('CI completion verified');
  } else throw new Error('Use changes|gate');
}
if (isMain(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1; });
