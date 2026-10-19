/* eslint-disable no-template-curly-in-string -- WHY: contracts assert literal GitHub expressions, not JavaScript templates. */
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
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
    const formatUpload = jobs.formats.steps.find((item: any) => item.uses === 'actions/upload-artifact@v7');
    expect(formatUpload.with.path).toBe('ci-results/format-${{ matrix.format }}/');
    expect(formatUpload.with['include-hidden-files']).toBe(true); // Retain .PKGINFO/.MTREE/.INSTALL too.
    expect(jobs.prepare.steps.find((item: any) => item.uses === 'actions/upload-artifact@v7').with['compression-level']).toBe(0);
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
      if (item.uses === 'actions/checkout@v7') expect(item.with.ref).toBe('${{ github.sha }}');
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
  it('reuses Android full coverage at this candidate with distinct manual source collection', () => {
    const config = workflow('android-ci');
    expect(Object.keys(config.on).sort()).toEqual(['workflow_call', 'workflow_dispatch']);
    expect(config.on.workflow_dispatch.inputs.collect_sources.default).toBe(false);
    const { build } = config.jobs;
    // WHY: a reusable child's github.workflow is its caller. Sharing that
    // concurrency namespace can cancel the very parent waiting for Android.
    expect(config.concurrency).toBeUndefined(); expect(build.concurrency).toBeUndefined();
    expect(build.env).toEqual({ ELECTRON_SKIP_BINARY_DOWNLOAD: '1' });
    expect(step(build, 'Set up JDK 17').with).toEqual({ 'java-version': '17', distribution: 'temurin' });
    expect(step(build, 'Set up Node.js').with['node-version']).toBe(22);
    expect(step(build, 'Setup Gradle').uses).toBe('gradle/actions/setup-gradle@v6');
    expect(step(build, 'Install runtime build tools').run).toBe('sudo apt-get update -q && sudo apt-get install -y -q clang lld');
    expect(step(build, 'Test runtime redistribution fixtures').run).toBe("python3 -m unittest discover -s app/runtime -p 'test_*.py' -v");
    expect(step(build, 'Configure APK version comparator').run).toContain('docker pull alpine:3.24');
    expect(step(build, 'Cache runtime downloads').with.path).toBe('app/build/runtime-cache');
    expect(step(build, 'Configure CI producer graph').run).toContain('-Dorg.gradle.jvmargs=-Xmx2g');
    expect(step(build, 'Verify packaged runtime and source archive').if).toBe('inputs.collect_sources');
    expect(step(build, 'Upload inspected source preflight archive').if).toBe('inputs.collect_sources');
    expect(step(build, 'Retain source preflight evidence').if).toBe('always() && inputs.collect_sources && failure()');
    expect(JSON.stringify(workflow())).not.toContain('ELECTRON_SKIP_BINARY_DOWNLOAD');
    expect(build.steps.filter((item: any) => item.uses === 'actions/checkout@v7').map((item: any) => item.with.ref)).toEqual(['${{ github.sha }}']);
    for (const name of ['Upload debug APK', 'Upload releaseTest APK']) {
      expect(step(build, name).with['compression-level']).toBe(0);
      expect(step(build, name).with['if-no-files-found']).toBe('error');
    }
    expect(step(build, 'Configure CI producer graph').if).toBe('!inputs.collect_sources');
    expect(step(build, 'Verify all variant lint producer graphs').if).toBe('!inputs.collect_sources');
    expect(step(build, 'Verify all variant lint producer graphs').run).toBe('./gradlew lintDebug lintReleaseTest lintRelease --dry-run $CI_GRADLE_FLAGS');
    expect(step(build, 'Record current Android input identity').run).toBe('node scripts/ci-inputs.mjs start');
    expect(step(build, 'Verify current Android inputs and outputs').run).toBe('node scripts/ci-inputs.mjs android');
    expect(step(build, 'Run unit tests').run).toBe('./gradlew test $CI_GRADLE_FLAGS');
    expect(step(build, 'Build debug APK').run).toBe('./gradlew assembleDebug $CI_GRADLE_FLAGS');
    expect(step(build, 'Build releaseTest APK (R8 minified, debug-signed)').run).toBe('./gradlew assembleReleaseTest $CI_GRADLE_FLAGS');
    expect(step(build, 'Build releaseTest APK (R8 minified, debug-signed)').env.YOUCODED_COLLECT_SOURCES).toContain('inputs.collect_sources');
    expect(step(build, 'Configure CI producer graph').run).toContain('--init-script scripts/ci-android-producers.gradle');
    expect(step(build, 'Configure CI producer graph').run).toContain('-PciPackagingDependencies=true');
    expect(step(build, 'Configure CI producer graph').run).toContain('RUNNER_TEMP');
    for (const name of ['Verify packaged runtime and source archive', 'Upload inspected source preflight archive', 'Retain source preflight evidence', 'Upload debug APK', 'Upload releaseTest APK']) expect(step(build, name)).toBeTruthy();
  });
});
