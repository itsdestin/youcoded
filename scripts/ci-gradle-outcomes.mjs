import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMain } from './ci-policy.mjs';

export function parseGradleOutcomes(text) {
  const tasks = {};
  let build;
  for (const line of text.replace(/\r/g, '').split('\n')) {
    if (line.startsWith('> Task ')) {
      const match = /^> Task (:[\w.-]+(?::[\w.-]+)*)(?: (FROM-CACHE|UP-TO-DATE|SKIPPED|NO-SOURCE|FAILED))?\s*$/.exec(line);
      if (!match) throw new Error(`Malformed task outcome: ${line}`);
      const [, path, suffix] = match;
      // WHY: parallel Gradle output can repeat a bare heading after the actual
      // outcome. A heading must not turn a cache hit into claimed execution.
      if (suffix && tasks[path] && tasks[path] !== 'executed' && tasks[path] !== suffix) throw new Error(`Conflicting task outcome: ${path}`);
      if (suffix || !tasks[path]) tasks[path] = suffix ?? 'executed';
    }
    if (line.startsWith('BUILD ')) {
      const match = /^BUILD (SUCCESSFUL|FAILED) in .+$/.exec(line);
      if (!match || (build && build !== match[1])) throw new Error('Malformed or conflicting BUILD outcome');
      build = match[1];
    }
  }
  if (!build) throw new Error('Missing BUILD outcome');
  return { build, tasks };
}

function capitalScope(scope) {
  if (!['debug', 'releaseTest'].includes(scope)) throw new Error('Unknown Android scope');
  return scope === 'debug' ? 'Debug' : 'ReleaseTest';
}

export function producerViolations(scope, { tasks }) {
  const capital = capitalScope(scope);
  const expected = [':app:bundleWebUi', ':app:buildBackend', `:app:buildRuntime${capital}`, `:app:materialize${capital}SpeedPayload`];
  const violations = [];
  // WHY: these public custom producers are intentionally not cacheable. Check
  // all selected paths, not just whichever paths happened to appear in a log.
  for (const path of expected) {
    if (!['executed', 'UP-TO-DATE'].includes(tasks[path])) violations.push(`${path}: ${tasks[path] ?? 'missing'}`);
  }
  for (const path of Object.keys(tasks)) {
    if (/^:app:(?:bundleWebUi|buildBackend|buildRuntime|materialize.*SpeedPayload)/.test(path) && !expected.includes(path)) violations.push(`Unknown producer: ${path}`);
  }
  return violations;
}

function main() {
  const [scope, log, ...extra] = process.argv.slice(2);
  capitalScope(scope);
  if (!log || extra.length) throw new Error('Expected scope and Gradle log path');
  if (!/^[a-f\d]{40}$/i.test(process.env.GITHUB_SHA ?? '')) throw new Error('Missing or invalid GITHUB_SHA');
  if (!process.env.RUNNER_TEMP) throw new Error('Missing RUNNER_TEMP');
  const facts = parseGradleOutcomes(readFileSync(log, 'utf8'));
  const violations = producerViolations(scope, facts);
  // Diagnostics are deliberately separate from ci-inputs acceptance authority.
  writeFileSync(join(process.env.RUNNER_TEMP, `android-gradle-outcomes-${scope}.json`), JSON.stringify({ diagnosticOnly: true, sha: process.env.GITHUB_SHA, scope, ...facts, producerViolations: violations }) + '\n', { mode: 0o600 });
  if (facts.build !== 'SUCCESSFUL' || violations.length) throw new Error(`Gradle ${facts.build}; producer violations: ${violations.join(', ')}`);
}

if (isMain(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
