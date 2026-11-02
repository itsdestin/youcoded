/* eslint-disable no-template-curly-in-string -- WHY: contracts assert literal GitHub expressions, not JavaScript templates. */
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { readSource } from './helpers/guard-scope';

const workflow = (name = 'desktop-ci') => parse(readSource(join(__dirname, `../../.github/workflows/${name}.yml`)));
const step = (job: any, name: string) => {
  const value = job.steps.find((item: any) => item.name === name);
  expect(value, `workflow declares ${name}`).toBeTruthy();
  return value;
};
// WHY parsed source: these are cross-workflow GitHub dependencies, not TS AST
// shapes. Runtime evidence has its own executable Node contracts.
// WHY (2026-10 security audit): third-party actions are pinned to a full commit SHA (tag kept as a comment),
// so tests match the action by name and assert the pin instead of a movable tag like @v7.
const isAction = (item: any, name: string) => typeof item.uses === 'string' && item.uses.startsWith(`${name}@`);
const PINNED_GRADLE = /^gradle\/actions\/setup-gradle@[0-9a-f]{40}$/;

describe('Desktop CI selected coverage', () => {
  it('preserves events and browser defaults without granting diagnostics full completion', () => {
    const config = workflow();
    expect(Object.keys(config.on).sort()).toEqual(['pull_request', 'push', 'schedule', 'workflow_dispatch']);
    expect(config.on.push.branches).toEqual(['master']);
    expect(config.on.schedule).toEqual([{ cron: '23 7 * * *' }]);
    expect(config.jobs.browser['runs-on']).toBe('${{ matrix.os }}');
    expect(config.jobs.browser.defaults.run.shell).toBeUndefined();
    expect(config.on.workflow_dispatch.inputs.test_scope.default).toBe('all');
    expect(config.jobs.completion.if).toContain("outputs.route != 'browser'");
    expect(config.jobs.completion.name).toBe("${{ needs.changes.outputs.route == 'browser' && 'Full build not selected (browser diagnostics)' || 'build (ubuntu-latest)' }}");
    expect(config.jobs.browser.name).toBe('browser diagnostics (${{ matrix.os }})');
    const browser = step(config.jobs.browser, 'Browser diagnostics');
    expect(browser.env.DEBUG).toBe('pw:protocol,pw:browser*');
    expect(browser.run).toBe('npx vitest run tests/assistant-browser.test.ts tests/assistant-browser-host.test.ts tests/assistant-browser-live.test.ts tests/assistant-browser-native.test.ts tests/aria-props.test.ts tests/desktop-ci.test.ts --maxWorkers=1');
    expect(browser.shell).toBeUndefined();
    expect(config.jobs.browser.strategy.matrix.os).toEqual(['ubuntu-latest', 'windows-latest', 'macos-latest']);
  });
  it('starts shards without a global prep barrier and requires every selected producer and evidence', () => {
    const { jobs } = workflow();
    expect(jobs.tests.needs).toBe('changes');
    expect(jobs.tests['runs-on']).toBe('${{ matrix.os }}');
    expect(jobs.tests.defaults.run.shell).toBeUndefined();
    expect(jobs.prepare.needs).toBe('changes');
    expect(jobs.tests.strategy['fail-fast']).toBe(false);
    expect(jobs.tests.strategy.matrix).toBe('${{ fromJSON(needs.changes.outputs.matrix) }}');
    expect(step(jobs.tests, 'Run tests').run).toBe('node ../scripts/ci-desktop.mjs shard "${{ matrix.os }}" "${{ matrix.shard }}" "${{ matrix.total }}"');
    expect(step(jobs.tests, 'Run tests').shell).toBeUndefined();
    expect(jobs.formats.strategy.matrix.format).toEqual(['AppImage', 'deb', 'rpm', 'pacman']);
    const filesystemTools = step(jobs.prepare, 'Ensure transport and filesystem proof tools');
    expect(filesystemTools.run).toContain('squashfs-tools');
    expect(jobs.prepare.steps.indexOf(filesystemTools)).toBeLessThan(jobs.prepare.steps.indexOf(step(jobs.prepare, 'Test CI policy and evidence')));
    expect(step(jobs.formats, 'Install Linux build deps').run).toContain('squashfs-tools');
    const formatUpload = jobs.formats.steps.find((item: any) => isAction(item, 'actions/upload-artifact'));
    expect(formatUpload.with.path).toBe('ci-results/format-${{ matrix.format }}/');
    expect(formatUpload.with['include-hidden-files']).toBe(true); // Retain .PKGINFO/.MTREE/.INSTALL too.
    expect(jobs.prepare.steps.find((item: any) => isAction(item, 'actions/upload-artifact')).with['compression-level']).toBe(0);
    expect(jobs.android.uses).toBe('./.github/workflows/android-ci.yml');
    expect(jobs.android.if).toBe("needs.changes.outputs.route == 'full'");
    expect(jobs.formats.needs).toEqual(['changes', 'prepare']);
    for (const [job, name] of [[jobs.prepare, 'Prepare current production app'], [jobs.formats, 'Package and validate current payload'], [jobs.evidence, 'Verify fresh selected file union and package evidence']] as const) {
      expect(step(job, name).env.CI_PACKAGE_MODE).toBe('${{ needs.changes.outputs.packageMode }}');
    }
    expect(jobs.changes.outputs.packageMode).toBe('${{ steps.filter.outputs.packageMode }}');
    expect(jobs.evidence.outputs).toEqual({ sha: '${{ steps.verify.outputs.sha }}', packageMode: '${{ steps.verify.outputs.packageMode }}' });
    expect(step(jobs.evidence, 'Verify fresh selected file union and package evidence').id).toBe('verify');
    expect(jobs.changes.steps.find((item: any) => item.id === 'filter').run).toBe('node scripts/ci-policy.mjs changes');
    for (const job of Object.values(jobs) as any[]) for (const item of job.steps ?? []) {
      if (isAction(item, 'actions/checkout')) expect(item.with.ref).toBe('${{ github.sha }}');
    }
    const scripts = JSON.parse(readSource(join(__dirname, '../package.json'))).scripts;
    expect(scripts.test).toBe('vitest'); expect(scripts.pretest).toBeUndefined(); expect(scripts.posttest).toBeUndefined();
    expect(jobs.completion.needs).toEqual(['changes', 'tests', 'prepare', 'formats', 'android', 'evidence', 'browser']);
    expect(jobs.evidence.needs).toEqual(['changes', 'tests', 'prepare', 'formats']);
    expect(jobs.completion.if).toContain('always()');
    for (const job of [jobs.prepare, jobs.browser]) {
      for (const command of ['npm run typecheck', 'npm run knip', 'npm run lint', 'npm run lint:design']) {
        expect(job.steps.some((item: any) => item.run === command)).toBe(true);
      }
    }
    expect(step(jobs.tests, 'OS semantic checks').if).toBe("matrix.shard == 1 && runner.os != 'Linux'");
    for (const command of ['node --test ../scripts/beta-version.test.mjs', 'npm run typecheck', 'npm run knip', 'npm run lint', 'npm run lint:design']) expect(step(jobs.tests, 'OS semantic checks').run).toContain(command);
  });
  it('requires independent scoped Android producers and an always-running exact completion gate', () => {
    const config = workflow('android-ci');
    const { jvm, apk, completion } = config.jobs;
    const ordered = (job: any, names: string[]) => {
      const indices = names.map(name => job.steps.indexOf(step(job, name)));
      expect(indices).toEqual([...indices].sort((a, b) => a - b));
    };
    expect(Object.keys(config.jobs).sort()).toEqual(['apk', 'completion', 'jvm', 'source-preflight']);
    expect(config.concurrency).toBeUndefined();
    for (const job of Object.values(config.jobs) as any[]) {
      expect(job.concurrency).toBeUndefined();
      expect(job['runs-on']).toBe('ubuntu-latest');
      expect(job.steps.filter((item: any) => isAction(item, 'actions/checkout')).map((item: any) => item.with.ref)).toEqual(['${{ github.sha }}']);
      expect(job.steps.find((item: any) => isAction(item, 'actions/setup-node')).with['node-version']).toBe(22);
    }
    for (const job of [jvm, apk]) {
      expect(job.if).toBe('!inputs.collect_sources');
      expect(job.needs).toBeUndefined();
      expect(step(job, 'Set up JDK 17').with).toEqual({ 'java-version': '17', distribution: 'temurin' });
      expect(step(job, 'Setup Gradle').uses).toMatch(PINNED_GRADLE);
      expect(job.env.CI_GRADLE_FLAGS).toBe(`-PciPackagingDependencies=true --init-script scripts/ci-android-producers.gradle -Dorg.gradle.jvmargs=-Xmx2g ${job === apk ? '--build-cache' : '--no-build-cache'}`);
      expect(step(job, 'Record current Android input identity').run).toBe('node scripts/ci-inputs.mjs start');
      expect(JSON.stringify(job)).not.toMatch(/--configuration-cache|--ignore-scripts|keystore|secrets\./);
    }
    expect(jvm.steps.find((item: any) => isAction(item, 'actions/setup-node')).with).toEqual({ 'node-version': 22 });
    expect(JSON.stringify(jvm)).not.toMatch(/npm|docker|clang|lld|YOUCODED_COMMON_NATIVE_CACHE|actions\/cache/);
    expect(step(jvm, 'Test runtime redistribution fixtures').run).toBe("python3 -m unittest discover -s app/runtime -p 'test_*.py' -v");
    expect(step(jvm, 'Verify all variant lint producer graphs').run).toBe('./gradlew lintDebug lintReleaseTest lintRelease --dry-run $CI_GRADLE_FLAGS');
    expect(step(jvm, 'Run unit tests').run).toBe('./gradlew test $CI_GRADLE_FLAGS');
    expect(step(jvm, 'Verify current JVM inputs and outputs').run).toBe('node scripts/ci-inputs.mjs jvm');
    ordered(jvm, ['Record current Android input identity', 'Test runtime redistribution fixtures', 'Verify all variant lint producer graphs', 'Run unit tests', 'Verify current JVM inputs and outputs', 'Upload JVM input evidence']);
    for (const name of ['Verify all variant lint producer graphs', 'Run unit tests', 'Verify current JVM inputs and outputs']) expect(step(jvm, name).if).toBeUndefined();
    expect(jvm.steps.indexOf(step(jvm, 'Run unit tests'))).toBeLessThan(jvm.steps.indexOf(step(jvm, 'Verify current JVM inputs and outputs')));
    expect(step(jvm, 'Upload JVM input evidence').with).toEqual({ name: 'android-scope-jvm', path: 'ci-android-evidence.json', 'if-no-files-found': 'error', 'retention-days': 7 });
    expect(apk.strategy).toEqual({ 'fail-fast': false, matrix: { scope: ['debug', 'releaseTest'] } });
    expect(apk.env.ELECTRON_SKIP_BINARY_DOWNLOAD).toBe('1');
    expect(apk.env.CI_ANDROID_SCOPE).toBe('${{ matrix.scope }}');
    expect(step(apk, 'Configure run-local native cache').run).toBe('echo "YOUCODED_COMMON_NATIVE_CACHE=$RUNNER_TEMP/ci-native-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${CI_ANDROID_SCOPE}" >> "$GITHUB_ENV"');
    expect(step(apk, 'Install runtime build tools').run).toBe('sudo apt-get update -q && sudo apt-get install -y -q clang lld');
    expect(step(apk, 'Configure APK version comparator').run).toContain('docker pull alpine:3.24');
    expect(step(apk, 'Cache runtime downloads').with).toEqual({ path: 'app/build/runtime-cache', key: "android-runtime-${{ hashFiles('app/runtime/pins.env') }}" });
    ordered(apk, ['Record current Android input identity', 'Configure run-local native cache', 'Build scoped APK', 'Verify current scoped Android inputs and outputs', 'Upload scoped Android input evidence']);
    for (const name of ['Build scoped APK', 'Verify current scoped Android inputs and outputs']) expect(step(apk, name).if).toBeUndefined();
    const assemble = step(apk, 'Build scoped APK');
    expect(assemble.run).toBe('set -euo pipefail\numask 077\ncase "$CI_ANDROID_SCOPE" in\n  debug) task=assembleDebug ;;\n  releaseTest) task=assembleReleaseTest ;;\n  *) echo "Unknown Android scope: $CI_ANDROID_SCOPE" >&2; exit 1 ;;\nesac\n./gradlew "$task" $CI_GRADLE_FLAGS --console=plain 2>&1 | tee "$RUNNER_TEMP/android-gradle-${CI_ANDROID_SCOPE}.log"\n');
    expect(assemble.shell).toBe('bash');
    expect(assemble['continue-on-error']).toBeUndefined();
    expect(step(apk, 'Setup Gradle').with).toEqual({ 'cache-read-only': "${{ github.event.pull_request.head.repo.fork == true }}" });
    expect(step(jvm, 'Setup Gradle').with).toBeUndefined();
    const outcomes = step(apk, 'Record Gradle task outcomes');
    expect(outcomes.if).toBe('always()');
    expect(outcomes.run).toBe('node scripts/ci-gradle-outcomes.mjs "$CI_ANDROID_SCOPE" "$RUNNER_TEMP/android-gradle-${CI_ANDROID_SCOPE}.log"');
    expect(step(apk, 'Upload Gradle task outcomes').if).toBe('always()');
    expect(step(apk, 'Upload Gradle task outcomes').with).toEqual({ name: 'android-gradle-outcomes-${{ matrix.scope }}', path: '${{ runner.temp }}/android-gradle-outcomes-${{ matrix.scope }}.json', 'if-no-files-found': 'warn', 'retention-days': 7 });
    ordered(apk, ['Build scoped APK', 'Record Gradle task outcomes', 'Upload Gradle task outcomes', 'Verify current scoped Android inputs and outputs']);
    for (const job of [workflow().jobs.prepare, workflow().jobs.tests]) expect(JSON.stringify(job)).toContain('../scripts/ci-gradle-outcomes.test.mjs');
    expect(step(apk, 'Verify current scoped Android inputs and outputs').run).toBe('node scripts/ci-inputs.mjs "$CI_ANDROID_SCOPE"');
    expect(apk.steps.indexOf(assemble)).toBeLessThan(apk.steps.indexOf(step(apk, 'Verify current scoped Android inputs and outputs')));
    expect(step(apk, 'Upload scoped Android input evidence').with).toEqual({ name: 'android-scope-${{ matrix.scope }}', path: 'ci-android-evidence.json', 'if-no-files-found': 'error', 'retention-days': 7 });
    for (const [name, artifact, scope] of [['Upload debug APK', 'youcoded-debug', 'debug'], ['Upload releaseTest APK', 'youcoded-releasetest', 'releaseTest']]) {
      expect(step(apk, name).if).toBe(`matrix.scope == '${scope}'`);
      expect(step(apk, name).with).toEqual({ name: artifact, path: `app/build/outputs/apk/${scope}/*.apk`, 'if-no-files-found': 'error', 'compression-level': 0, 'retention-days': 14 });
    }
    expect(completion.if).toBe('always()');
    expect(completion.needs).toEqual(['jvm', 'apk', 'source-preflight']);
    expect(step(completion, 'Test Android completion policy').run).toBe('node --test scripts/ci-android-policy.test.mjs');
    expect(step(completion, 'Require selected Android producers').env).toEqual({ CI_ANDROID_NEEDS: '${{ toJSON(needs) }}', CI_COLLECT_SOURCES: '${{ inputs.collect_sources == true }}' });
    expect(step(completion, 'Require selected Android producers').run).toBe('node scripts/ci-android-policy.mjs');
    expect(step(completion, 'Require selected Android producers').if).toBeUndefined();
    ordered(completion, ['Test Android completion policy', 'Require selected Android producers', 'Aggregate current Android inputs and outputs', 'Upload Android input evidence']);
    const download = completion.steps.find((item: any) => isAction(item, 'actions/download-artifact'));
    expect(download.if).toBe('!inputs.collect_sources');
    expect(download.with).toEqual({ pattern: 'android-scope-*', path: 'ci-android-results' });
    expect(completion.steps.indexOf(download)).toBeGreaterThan(completion.steps.indexOf(step(completion, 'Require selected Android producers')));
    expect(step(completion, 'Aggregate current Android inputs and outputs').if).toBe('!inputs.collect_sources');
    expect(step(completion, 'Aggregate current Android inputs and outputs').run).toBe('node scripts/ci-inputs.mjs aggregate');
    expect(step(completion, 'Upload Android input evidence').if).toBe('!inputs.collect_sources');
    expect(step(completion, 'Upload Android input evidence').with).toEqual({ name: 'android-current-inputs', path: 'ci-android-evidence.json', 'if-no-files-found': 'error', 'retention-days': 7 });
    expect(step(workflow().jobs.prepare, 'Test CI policy and evidence').run).toContain('../scripts/ci-android-policy.test.mjs');
    expect(step(workflow().jobs.tests, 'OS semantic checks').run).toContain('../scripts/ci-android-policy.test.mjs');
  });
  it.skipIf(process.platform === 'win32')('preserves real APK pipeline failure and fixed task arguments while retaining private logs', () => {
    const apk = workflow('android-ci').jobs.apk;
    const dir = mkdtempSync(join(tmpdir(), 'android-gradle-pipe-'));
    try {
      // WHY: execute the actual YAML shell, replacing only Gradle with a fixture;
      // a textual pipefail assertion alone cannot prove failure propagation.
      writeFileSync(join(dir, 'gradlew'), '#!/bin/bash\nprintf "%s\\n" "$@" > "$RUNNER_TEMP/argv"\necho "BUILD FAILED in 1s"\nexit 23\n', { mode: 0o700 });
      for (const [scope, task] of [['debug', 'assembleDebug'], ['releaseTest', 'assembleReleaseTest']]) {
        const result = spawnSync('bash', ['-c', step(apk, 'Build scoped APK').run], { cwd: dir, env: { ...process.env, RUNNER_TEMP: dir, CI_ANDROID_SCOPE: scope, CI_GRADLE_FLAGS: apk.env.CI_GRADLE_FLAGS }, encoding: 'utf8' });
        expect(result.status).toBe(23);
        expect(readFileSync(join(dir, 'argv'), 'utf8').replace(/\r/g, '').trim().split('\n')).toEqual([task, '-PciPackagingDependencies=true', '--init-script', 'scripts/ci-android-producers.gradle', '-Dorg.gradle.jvmargs=-Xmx2g', '--build-cache', '--console=plain']);
        expect(readFileSync(join(dir, `android-gradle-${scope}.log`), 'utf8')).toContain('BUILD FAILED');
        expect(statSync(join(dir, `android-gradle-${scope}.log`)).mode & 0o077).toBe(0);
      }
      const unknown = spawnSync('bash', ['-c', step(apk, 'Build scoped APK').run], { cwd: dir, env: { ...process.env, RUNNER_TEMP: dir, CI_ANDROID_SCOPE: 'debug; exit 0', CI_GRADLE_FLAGS: apk.env.CI_GRADLE_FLAGS } });
      expect(unknown.status).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); }
  });
  it('keeps public custom APK producers non-cacheable without changing commands', () => {
    // WHY: Gradle producer types and YAML cache flags cross language boundaries.
    const gradle = readSource(join(__dirname, '../../app/build.gradle.kts'));
    expect(gradle).not.toMatch(/CacheableTask|cacheIf/);
    expect(gradle).toContain('abstract class SpeedPayloadTask : org.gradle.api.DefaultTask()');
    expect(gradle).toContain('tasks.register<Exec>("bundleWebUi")');
    expect(gradle).toContain('tasks.register<Exec>("buildBackend")');
    expect(gradle).toContain('tasks.register<Exec>("buildRuntime$variant")');
    expect(gradle).toContain('commandLine = listOf("bash", script.absolutePath)');
    expect(gradle).toContain('commandLine(bashCommand(script, out.absolutePath))');
    expect(gradle).toContain('commandLine(bashCommand(file("runtime/build-runtime.sh"), appId, out.absolutePath))');
  });
  it('reuses Android full coverage at this candidate with distinct manual source collection', () => {
    const config = workflow('android-ci');
    expect(Object.keys(config.on).sort()).toEqual(['workflow_call', 'workflow_dispatch']);
    expect(config.on.workflow_dispatch.inputs.collect_sources.default).toBe(false);
    expect(Object.keys(config.jobs).sort()).toEqual(['apk', 'completion', 'jvm', 'source-preflight']);
    const build = config.jobs['source-preflight'];
    // WHY: a reusable child's github.workflow is its caller. Sharing that
    // concurrency namespace can cancel the very parent waiting for Android.
    expect(config.concurrency).toBeUndefined(); expect(build.concurrency).toBeUndefined();
    expect(build.env).toEqual({ ELECTRON_SKIP_BINARY_DOWNLOAD: '1' });
    expect(step(build, 'Set up JDK 17').with).toEqual({ 'java-version': '17', distribution: 'temurin' });
    expect(step(build, 'Set up Node.js').with['node-version']).toBe(22);
    expect(step(build, 'Setup Gradle').uses).toMatch(PINNED_GRADLE);
    expect(step(build, 'Install runtime build tools').run).toBe('sudo apt-get update -q && sudo apt-get install -y -q clang lld');
    expect(step(build, 'Test runtime redistribution fixtures').run).toBe("python3 -m unittest discover -s app/runtime -p 'test_*.py' -v");
    expect(step(build, 'Configure APK version comparator').run).toContain('docker pull alpine:3.24');
    expect(step(build, 'Cache runtime downloads').with.path).toBe('app/build/runtime-cache');
    expect(build.if).toBe('inputs.collect_sources');
    expect(JSON.stringify(build)).not.toMatch(/CI_GRADLE_FLAGS|ciPackagingDependencies|ci-android-producers|YOUCODED_COMMON_NATIVE_CACHE/);
    expect(step(build, 'Verify packaged runtime and source archive').if).toBe('inputs.collect_sources');
    expect(step(build, 'Upload inspected source preflight archive').if).toBe('inputs.collect_sources');
    expect(step(build, 'Retain source preflight evidence').if).toBe('always() && inputs.collect_sources && failure()');
    expect(JSON.stringify(workflow())).not.toContain('ELECTRON_SKIP_BINARY_DOWNLOAD');
    expect(build.steps.filter((item: any) => isAction(item, 'actions/checkout')).map((item: any) => item.with.ref)).toEqual(['${{ github.sha }}']);
    for (const name of ['Upload debug APK', 'Upload releaseTest APK']) {
      expect(step(build, name).with['compression-level']).toBe(0);
      expect(step(build, name).with['if-no-files-found']).toBe('error');
    }
    expect(step(build, 'Verify packaged runtime and source archive').run).toContain('python3 -I app/runtime/runtime-redistribution.py bind_backend');
    expect(step(build, 'Verify packaged runtime and source archive').run).toContain('app/build/backend-assets/backend.tgz');
    expect(step(build, 'Verify packaged runtime and source archive').run).toContain('python3 -I app/runtime/runtime-redistribution.py release');
    expect(step(build, 'Verify packaged runtime and source archive').run).toContain('app/build/outputs/apk/releaseTest/*.apk');
    expect(step(build, 'Upload inspected source preflight archive').with).toEqual({ name: 'android-source-preflight-archive', path: 'app/build/outputs/android-source-preflight.tar.xz\napp/build/outputs/android-source-preflight.tar.xz.sha256\n', 'if-no-files-found': 'error', 'retention-days': 7 });
    expect(step(build, 'Retain source preflight evidence').with).toEqual({ name: 'android-source-preflight', path: 'app/build/runtime/releaseTest/evidence\napp/build/runtime/releaseTest/sources\n', 'if-no-files-found': 'warn', 'retention-days': 7 });
    expect(step(build, 'Record current Android input identity').run).toBe('node scripts/ci-inputs.mjs start');
    expect(step(build, 'Verify current Android inputs and outputs').run).toBe('node scripts/ci-inputs.mjs android');
    expect(step(build, 'Setup Gradle').with).toBeUndefined();
    expect(JSON.stringify(build)).not.toMatch(/--build-cache|--configuration-cache/);
    expect(step(build, 'Run unit tests').run).toBe('./gradlew test --no-build-cache');
    expect(step(build, 'Build debug APK').run).toBe('./gradlew assembleDebug --no-build-cache');
    expect(step(build, 'Build releaseTest APK (R8 minified, debug-signed)').run).toBe('./gradlew assembleReleaseTest --no-build-cache');
    expect(step(build, 'Build releaseTest APK (R8 minified, debug-signed)').env.YOUCODED_COLLECT_SOURCES).toContain('inputs.collect_sources');
    expect(step(build, 'Upload Android input evidence').with).toEqual({ name: 'android-current-inputs', path: 'ci-android-evidence.json', 'if-no-files-found': 'error', 'retention-days': 7 });
    for (const [name, artifact, variant] of [['Upload debug APK', 'youcoded-debug', 'debug'], ['Upload releaseTest APK', 'youcoded-releasetest', 'releaseTest']]) expect(step(build, name).with).toEqual({ name: artifact, path: `app/build/outputs/apk/${variant}/*.apk`, 'if-no-files-found': 'error', 'compression-level': 0, 'retention-days': 14 });
    for (const name of ['Verify packaged runtime and source archive', 'Upload inspected source preflight archive', 'Retain source preflight evidence', 'Upload debug APK', 'Upload releaseTest APK']) expect(step(build, name)).toBeTruthy();
  });
});

describe('third-party actions are pinned to commit SHAs', () => {
  it('every uses: in the CI workflows is a local path or a 40-character commit', () => {
    const dir = join(__dirname, '../../.github/workflows');
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.yml'))) {
      for (const m of readSource(join(dir, f)).matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) {
        expect(m[1].startsWith('./') || /@[0-9a-f]{40}$/.test(m[1]), `${f}: ${m[1]}`).toBe(true);
      }
    }
  });
});
