// worker.ts — runs ONE shell command inside the iPhone app, on its own worker thread (started by adapter.ts).
//
// WHY (iPhone app, card #89): an iPhone may not start any other program, but an app may carry its own command
// interpreter. This is just-bash (a bash written in JavaScript, ~80 commands) with just-git as its `git`. A command
// can reach only the app's own Documents and temp folders, and none of the backend's secrets: the environment below is
// built from scratch, so the backend's own never reaches it.
//
// Everything that imports just-bash or just-git lives in this folder and is bundled only into the iPhone app: desktop
// and Android never see these packages.
import { parentPort, workerData } from 'worker_threads';
import fs from 'fs';
import { Bash, InMemoryFs, MountableFs, ReadWriteFs, defineCommand, getCommandNames, type SecureFetch, type CommandName } from 'just-bash';
import { createGit } from 'just-git';
import { iosFetch } from '../../../desktop/src/main/headless/ios-fetch';
import type { ShellJob } from './adapter';
import { denyCredentialFiles } from './deny-fs';
import { gitIndexProblem } from './git-guard';
import { explainMissingCommands } from './stubs';

const job = workerData as ShellJob;

// --- Files. Only two folders are visible: Documents (HOME) and the temp folder. Each is mounted at its logical path AND
// its real path: iOS reaches them through a /var -> /private/var link, the other tools use whichever spelling the OS gave
// them, and just-bash refuses a path that crosses a link it was not told about. Same files, either spelling works.
const mounts = new MountableFs({ base: new InMemoryFs() });
const mounted: string[] = [];
const homes: string[] = [];
for (const dir of [job.home, job.tmp]) {
  const real = fs.realpathSync(dir);
  for (const at of new Set([dir, real])) {
    if (mounted.some((m) => at === m || at.startsWith(m + '/'))) continue; // the temp folder inside HOME is already covered
    // allowSymlinks: a link INSIDE a folder works (git repositories need them); one pointing OUT of it is refused.
    mounts.mount(at, new ReadWriteFs({ root: real, allowSymlinks: true, maxFileReadSize: 64 * 1024 * 1024 }));
    mounted.push(at);
    if (dir === job.home) homes.push(at);
  }
}
const shellFs = denyCredentialFiles(mounts, homes);

// --- Network. The app's own fetch (it needs no WebAssembly, which an iPhone's Node lacks) serves both `curl` and git,
// exactly as it serves the assistant's other web access. Redirects are followed inside it.
const curlFetch: SecureFetch = async (url, o = {}) => {
  const res = await iosFetch(url, {
    method: o.method, headers: o.headers as HeadersInit, body: o.body,
    redirect: o.followRedirects === false ? 'manual' : 'follow',
    signal: AbortSignal.timeout(o.timeoutMs ?? 120_000),
  });
  return { status: res.status, statusText: res.statusText, headers: Object.fromEntries(res.headers), body: new Uint8Array(await res.arrayBuffer()), url: res.url || url };
};

// --- git. The saved sign-in (if the app has one) is handed over as { host: token } and offered only to git's own
// "what is the password for this site" question. It is never put in the environment, the command text or the output.
const git = createGit({
  // WHY: a computer's git knows who you are from its own settings; a phone has none. A project's own name setting wins
  // (git checks it first); otherwise the GitHub account the app is signed in to; otherwise a neutral placeholder, so a
  // save never fails for want of a name.
  identity: job.identity ?? { name: 'YouCoded', email: 'you@youcoded.local' },
  credentials: (url: string) => {
    let host = '';
    try { host = new URL(url).hostname; } catch { return null; }
    const token = Object.hasOwn(job.tokens, host) ? job.tokens[host] : undefined;
    return token ? { type: 'basic', username: 'x-access-token', password: token } : null;
  },
  network: { fetch: iosFetch as unknown as typeof fetch },
});
const guardedGit = defineCommand('git', async (args, c) => {
  const problem = await gitIndexProblem(c.fs, c.cwd, args);
  if (problem) return { stdout: '', stderr: problem, exitCode: 1 };
  return git.execute(args, c);
});

const LIMIT = 1_000_000; // just-bash stops at 100,000 steps, which a real file-processing loop reaches
const bash = new Bash({
  fs: shellFs,
  // A tracked working folder outside the two mounts (it can only be a stale one) falls back to HOME.
  cwd: mounted.some((m) => job.cwd === m || job.cwd.startsWith(m + '/')) ? job.cwd : job.home,
  env: { HOME: job.home, USER: 'mobile', SHELL: '/bin/bash', TMPDIR: job.tmp, PATH: '/usr/bin:/bin', NO_COLOR: '1', LANG: 'C.UTF-8' },
  // Off: the checks it adds guard just-bash's optional JavaScript/Python runtimes (never turned on here) and crash on Node 18.
  defenseInDepth: false,
  executionLimits: { maxCommandCount: LIMIT, maxLoopIterations: LIMIT, maxAwkIterations: LIMIT, maxSedIterations: LIMIT, maxJqIterations: LIMIT, maxOutputSize: 16 * 1024 * 1024 },
  // sqlite3 needs WebAssembly, which does not exist on the phone: leave it out, so it is honestly "not found".
  commands: getCommandNames().filter((n) => n !== 'sqlite3') as CommandName[],
  fetch: curlFetch,
  customCommands: [guardedGit],
});

// A command cut short by one of the shell's own limits already ends with exit 126 and a line naming the limit, but that
// line tells the reader to change a setting nobody here can reach. Say what is true and useful instead.
const explainLimit = (stderr: string) => stderr.replace(/, increase executionLimits\.\w+/g, ' (a limit of the built-in shell; split the work into smaller commands)');

bash.exec(job.script).then(
  (r) => parentPort!.postMessage({ stdout: r.stdout, stderr: explainLimit(explainMissingCommands(r.stderr)), exitCode: r.exitCode }),
  (e) => parentPort!.postMessage({ stdout: '', stderr: `the shell failed: ${e?.message ?? e}\n`, exitCode: 1 }),
);
