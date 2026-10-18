/* eslint-disable no-template-curly-in-string -- WHY: assertions check literal GitHub Actions expressions, not JavaScript interpolation. */
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { parse } from 'yaml';
import { readSource } from './helpers/guard-scope';

const workflow = (name = 'desktop-ci') => parse(readSource(join(__dirname, `../../.github/workflows/${name}.yml`)));
const named = (job: any, name: string) => job.steps.find((step: any) => step.name === name);
const matrix = '${{ github.event_name == \'pull_request\' && fromJSON(\'["ubuntu-latest"]\') || fromJSON(\'["ubuntu-latest", "windows-latest", "macos-latest"]\') }}';
const browserCommand = 'npx vitest run tests/assistant-browser.test.ts tests/assistant-browser-host.test.ts tests/assistant-browser-live.test.ts tests/assistant-browser-native.test.ts tests/aria-props.test.ts tests/desktop-ci.test.ts --maxWorkers=1';

// WHY a parsed source contract: GitHub expression/YAML/shell boundaries cannot
// be expressed by a TypeScript AST rule. Executable policy tests pin decisions.
describe('Desktop CI execution lanes', () => {
  it('classifies immutable event data through the executable policy without shell interpolation', () => {
    const { jobs, on } = workflow();
    expect(on.push.branches).toEqual(['master']);
    expect(on.pull_request).toBeNull();
    expect(on.schedule).toEqual([{ cron: '23 7 * * *' }]);
    expect(jobs.changes.steps[0]).toMatchObject({ uses: 'actions/checkout@v7', with: { 'fetch-depth': 0 } });
    expect(jobs.changes.steps.find((step: any) => step.id === 'filter').run).toBe('node scripts/ci-policy.mjs changes');
    expect(jobs.changes.outputs.code).toBe('${{ steps.filter.outputs.code }}');
  });

  it('runs cheap preflight before independent complete tests and clean Linux packaging', () => {
    const { jobs } = workflow();
    expect(jobs.preflight.needs).toBe('changes');
    expect(jobs.preflight.if).toBe("needs.changes.outputs.code == 'true'");
    for (const name of ['preflight', 'tests', 'build']) {
      expect(jobs[name].strategy.matrix.os).toBe(matrix);
      expect(jobs[name].strategy['fail-fast']).toBe(false);
      expect(jobs[name]['runs-on']).toBe('${{ matrix.os }}');
    }
    for (const name of ['tests', 'package']) {
      expect(jobs[name].needs).toEqual(['changes', 'preflight']);
      expect(jobs[name].if).toContain("needs.changes.outputs.code == 'true'");
      expect(jobs[name].if).toContain("needs.preflight.result == 'success'");
    }
    for (const command of ['npm run typecheck', 'npm run knip', 'npm run lint', 'npm run lint:design', 'node --test ../scripts/ci-policy.test.mjs', 'node --test ../scripts/beta-version.test.mjs']) {
      expect(jobs.preflight.steps.some((step: any) => step.run === command), command).toBe(true);
    }
    for (const name of ['preflight', 'tests', 'package']) {
      const job = jobs[name];
      expect(job.steps[0].uses).toBe('actions/checkout@v7');
      expect(job.steps.find((step: any) => step.uses === 'actions/setup-node@v7').with).toEqual({ 'node-version': 22, cache: 'npm', 'cache-dependency-path': 'desktop/package-lock.json' });
      expect(named(job, 'Install dependencies').run).toBe('npm ci');
      expect(job.defaults.run['working-directory']).toBe('desktop');
    }
    expect(jobs.package['runs-on']).toBe('ubuntu-latest');
    expect(jobs.package.if).toContain("inputs.test_scope != 'browser'");
    expect(named(jobs.package, 'Install Linux build deps').run).toBe('sudo apt-get update && sudo apt-get install -y rpm libarchive-tools');
    expect(named(jobs.package, 'Build').run).toBe('npm run build');
    expect(jobs.package.steps.map((step: any) => step.uses).filter(Boolean)).toEqual(['actions/checkout@v7', 'actions/setup-node@v7']);
    // The unchanged build command still delegates every Linux installer to builder.
    const targets = parse(readSource(join(__dirname, '../electron-builder.yml'))).linux.target;
    expect(targets).toEqual(expect.arrayContaining(['AppImage', 'deb', 'rpm', 'pacman']));
  });

  it('always runs the fail-closed completion matrix under the existing required contexts', () => {
    const { jobs } = workflow();
    expect(jobs['docs-only']).toBeUndefined();
    expect(jobs.build.needs).toEqual(['changes', 'preflight', 'tests', 'package']);
    expect(jobs.build.if).toBe('always()');
    expect(jobs.build.name).toContain("inputs.test_scope == 'browser' && format('browser diagnostics ({0})', matrix.os)");
    expect(jobs.build.name).toContain("format('build ({0})', matrix.os)");
    const gate = named(jobs.build, 'Verify completion');
    expect(gate.run).toBe('node scripts/ci-policy.mjs gate');
    expect(gate.env).toEqual({ CI_NEEDS: '${{ toJSON(needs) }}', CI_TEST_SCOPE: '${{ inputs.test_scope }}' });
    expect(gate.run).not.toContain('${{');
    expect(jobs.build.steps[0].uses).toBe('actions/checkout@v7');
    expect(jobs.build.steps.some((step: any) => step.uses === 'actions/setup-node@v7')).toBe(true);
  });

  it('keeps full manual default, full suite shell, and the exact explicit browser group', () => {
    const { jobs, on } = workflow();
    expect(on.workflow_dispatch.inputs.test_scope.default).toBe('all');
    expect(on.workflow_dispatch.inputs.test_scope.options).toEqual(['all', 'browser']);
    const full = named(jobs.tests, 'Run tests');
    expect(full.run).toBe('npm test');
    expect(full.if).toBe("inputs.test_scope != 'browser'");
    expect(full.shell).toBeUndefined();
    expect(jobs.tests.defaults.run.shell).toBeUndefined();
    const browser = named(jobs.tests, 'Browser diagnostics');
    expect(browser.if).toBe("github.event_name == 'workflow_dispatch' && inputs.test_scope == 'browser'");
    expect(browser.env.DEBUG).toBe('pw:protocol,pw:browser*');
    expect(browser.run).toBe(browserCommand);
  });

  it('cancels only stale PR runs in distinct desktop and Android workflow namespaces', () => {
    for (const name of ['desktop-ci', 'android-ci']) {
      const concurrency = workflow(name).concurrency;
      expect(concurrency.group).toBe('${{ github.workflow }}-${{ github.event_name == \'pull_request\' && github.event.pull_request.number || github.run_id }}');
      expect(concurrency['cancel-in-progress']).toBe("${{ github.event_name == 'pull_request' }}");
    }
  });
});
