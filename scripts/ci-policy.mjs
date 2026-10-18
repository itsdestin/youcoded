#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function sha(value) {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value)) {
    throw new Error('Event must supply a complete immutable commit SHA');
  }
  return value;
}

function git(args) {
  // WHY: collect every byte, with neither an early-closing pipe (SIGPIPE) nor
  // exec's default maxBuffer. A failed Git command is never a docs-only verdict.
  return new Promise((resolveOutput, reject) => {
    const child = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    const errors = [];
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.on('data', chunk => errors.push(chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code !== 0) reject(new Error(`git failed (${signal || code}): ${Buffer.concat(errors).toString()}`));
      else resolveOutput(Buffer.concat(chunks));
    });
  });
}

async function commitRef(ref) {
  // WHY: Git diff also accepts tree objects, but event refs must be commits;
  // validate the actual object even when a new branch takes the full route.
  const type = await git(['cat-file', '-t', ref]);
  if (type.toString().trim() !== 'commit') throw new Error('Event ref is not a commit');
}

export async function codeChanged(eventName, event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Malformed event object');
  let range;
  if (eventName === 'pull_request') {
    const base = sha(event.pull_request?.base?.sha);
    await commitRef(base);
    range = `${base}...HEAD`;
  } else if (eventName === 'push') {
    const before = sha(event.before);
    const after = sha(event.after);
    await commitRef(after);
    // WHY: a newly created branch has no prior tree to prove docs-only against.
    if (/^0+$/.test(before)) return true;
    await commitRef(before);
    range = `${before}..${after}`;
  } else {
    return true;
  }
  // WHY: --no-renames exposes both deletion and addition when a rename crosses
  // docs/. NUL delimiters preserve newline/tab/space filenames without quoting.
  const output = await git(['diff', '--name-only', '-z', '--no-renames', range, '--']);
  if (output.length === 0) return true;
  if (output.at(-1) !== 0) throw new Error('Git diff output is not NUL terminated');
  const paths = output.toString('latin1').slice(0, -1).split('\0');
  return !paths.every(path => path.startsWith('docs/') && path.length > 5);
}

export function completionAllowed(needs, scope, eventName) {
  if (!needs || typeof needs !== 'object' || needs.changes?.result !== 'success') return false;
  const code = needs.changes.outputs?.code;
  const statuses = ['preflight', 'tests', 'package'].map(job => needs[job]?.result);
  // WHY: matrix needs contains the combined result. Exact success (not merely
  // "not failure") prevents failed, cancelled, missing or unexpectedly skipped
  // matrix legs from satisfying the protected build context.
  if (scope === 'browser') {
    return eventName === 'workflow_dispatch' && code === 'true'
      && statuses[0] === 'success' && statuses[1] === 'success' && statuses[2] === 'skipped';
  }
  if (scope !== '' && scope !== 'all') return false;
  if (code === 'false') return statuses.every(status => status === 'skipped');
  if (code === 'true') return statuses.every(status => status === 'success');
  return false;
}

async function main() {
  switch (process.argv[2]) {
    case 'changes': {
      if (!process.env.GITHUB_EVENT_NAME || !process.env.GITHUB_EVENT_PATH || !process.env.GITHUB_OUTPUT) {
        throw new Error('Missing GitHub event or output environment');
      }
      const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
      const code = await codeChanged(process.env.GITHUB_EVENT_NAME, event);
      // Only successful classification can write the output; output I/O errors
      // still exit nonzero so completion rejects the classification result.
      appendFileSync(process.env.GITHUB_OUTPUT, `code=${code}\n`);
      break;
    }
    case 'gate':
      if (!completionAllowed(JSON.parse(process.env.CI_NEEDS), process.env.CI_TEST_SCOPE, process.env.GITHUB_EVENT_NAME)) {
        throw new Error('CI dependency results do not prove a successful selected route');
      }
      console.log('CI completion verified');
      break;
    default:
      throw new Error('Usage: ci-policy.mjs changes|gate');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
