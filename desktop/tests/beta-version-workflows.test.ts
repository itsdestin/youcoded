/* eslint-disable no-template-curly-in-string -- WHY: assertions check literal GitHub Actions and shell expressions, not JavaScript interpolation. */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { readSource } from './helpers/guard-scope';

// WHY a parsed cross-file guard instead of an AST rule: YAML dependencies and
// shell stamping must agree across three workflows and the shared composite action.
const root = join(__dirname, '..', '..');
const workflow = (name: string) => parse(readSource(join(root, '.github', 'workflows', `${name}.yml`)));
const stepNamed = (job: any, name: string) => job.steps.find((step: any) => step.name === name);
const betaStep = (job: any) => job.steps.find((step: any) => step.uses === './.github/actions/beta-version');

describe('beta build workflow identities', () => {
  it('uses one resolved desktop version for every installer and the signature', () => {
    const { jobs } = workflow('desktop-test-build');
    expect(betaStep(jobs.version)?.id).toBe('beta');
    expect(jobs.version.permissions.actions).toBe('read');
    expect(jobs.version.outputs.version).toBe('${{ steps.beta.outputs.version }}');
    expect(jobs.build.needs).toBe('version');
    expect(jobs.sign.needs).toEqual(['build', 'version']);
    const stamp = stepNamed(jobs.build, 'Stamp beta version');
    const sign = stepNamed(jobs.sign, 'Sign and verify the manifest');
    for (const step of [stamp, sign]) {
      expect(step.env.BETA_VERSION).toBe('${{ needs.version.outputs.version }}');
      expect(step.run).not.toContain('github.run_number');
      expect(step.run).toContain('"$BETA_VERSION"');
    }
  });

  it('automatically chooses the next patch in every beta workflow', () => {
    for (const name of ['desktop-test-build', 'android-release', 'android-test-build']) {
      const config = workflow(name);
      expect(config.on.workflow_dispatch.inputs.base.default).toBe('');
      expect(config.on.workflow_dispatch.inputs.base.required).toBe(false);
    }
  });

  it('resets Android visible versions without resetting installation counters or tag versions', () => {
    const release = workflow('android-release');
    const job = release.jobs.release;
    expect(release.permissions.actions).toBe('read');
    expect(betaStep(job).if).toBe("github.event_name == 'workflow_dispatch'");
    const stamp = stepNamed(job, 'Stamp version');
    expect(stamp.env.BETA_VERSION).toBe('${{ steps.beta.outputs.version }}');
    expect(stamp.run).toContain('NAME="$BETA_VERSION"');
    expect(stamp.run).toContain('NAME="${GITHUB_REF#refs/tags/v}"');
    expect(stamp.run).toContain('CODE=$((100 + ${{ github.run_number }}))');

    const test = workflow('android-test-build');
    expect(test.permissions.actions).toBe('read');
    expect(betaStep(test.jobs.build).id).toBe('beta');
    const dogfood = stepNamed(test.jobs.build, 'Stamp dogfood version');
    expect(dogfood.env.NAME).toBe('${{ steps.beta.outputs.version }}');
    expect(dogfood.run).not.toContain('github.run_number');
    expect(dogfood.run).not.toContain('versionCode =');
  });

  it('exposes the resolver output and runs its behavioral tests in CI', () => {
    const action = parse(readSource(join(root, '.github', 'actions', 'beta-version', 'action.yml')));
    expect(action.outputs.version.value).toBe('${{ steps.resolve.outputs.version }}');
    const resolve = action.runs.steps.find((step: any) => step.id === 'resolve');
    expect(resolve.env.BETA_BASE).toBe('${{ inputs.base }}');
    expect(resolve.with.script).toContain('resolveBetaVersion({ github, context, base: process.env.BETA_BASE })');
    expect(stepNamed(workflow('desktop-ci').jobs.preflight, 'Test beta version numbering').run)
      .toBe('node --test ../scripts/beta-version.test.mjs');
  });
});
