import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { readSource } from './helpers/guard-scope';

// WHY a cross-file guard rather than an AST rule: GitHub's YAML refs/environments,
// electron-builder's overlay and shell commands must agree across languages.
const desktop = path.resolve(__dirname, '..');
const yaml = (file: string): Record<string, any> => parseYaml(readSource(file));
const base = yaml(path.join(desktop, 'electron-builder.yml'));
const overlayPath = path.join(desktop, 'electron-builder.mac-sign.yml');
const workflows = ['desktop-release.yml', 'desktop-test-build.yml'];
const githubExpression = (value: string) => `\${{ ${value} }}`;

describe('Mac signing configuration', () => {
  it('preserves credential-free ad-hoc builds while overriding the identity for trusted builds', () => {
    const signed = yaml(overlayPath);
    expect(base.mac.identity).toBe('-');
    expect(base.mac.notarize).not.toBe(true);
    expect(signed.extends).toBe('./electron-builder.yml');
    // v26 chooses the certificate TYPE itself and rejects a type prefix in the qualifier.
    expect(signed.mac.identity).toBe("Destin's Adventures, LLC (C2PSZTNNA4)");
    expect(signed.mac.identity).not.toMatch(/^(Developer ID Application|Apple Distribution|Mac Developer):/);
    expect(signed.mac.forceCodeSigning).toBe(true);
    expect(signed.mac.notarize).toBe(true);
    expect(signed.mac.hardenedRuntime).toBe(true);
    expect(Object.keys(signed).sort()).toEqual(['dmg', 'extends', 'mac']);
    expect(signed.dmg.sign).toBe(true);
    expect(base.mac.target[0].arch).toEqual(['x64', 'arm64']);
  });

  for (const name of workflows) {
    it(`${name} protects credentials and finishes notarization before artifacts can leave the runner`, () => {
      const job = yaml(path.join(desktop, '..', '.github', 'workflows', name)).jobs.build;
      expect(job.environment).toContain("matrix.name == 'macos'");
      expect(job.environment).toContain("'macos-signing'");
      expect(job.environment).toContain("'windows-signing'");
      expect(job.env.SIGN_MACOS).toContain("matrix.name == 'macos'");
      expect(job.env.SIGN_MACOS).toContain("github.ref == 'refs/heads/master'");
      const trustedRefs = name === 'desktop-release.yml'
        ? "(startsWith(github.ref, 'refs/tags/v') || github.ref == 'refs/heads/master')"
        : "github.ref == 'refs/heads/master'";
      expect(job.env.SIGN_MACOS).toBe(githubExpression(`matrix.name == 'macos' && ${trustedRefs}`));
      expect(job.environment).toBe(githubExpression(
        `(matrix.name == 'windows' && ${trustedRefs}) && 'windows-signing' || (matrix.name == 'macos' && ${trustedRefs}) && 'macos-signing' || ''`,
      ));
      const steps: Array<Record<string, any>> = job.steps;
      const signed = steps.findIndex((step) => step.name === 'Build signed Mac installers');
      const ordinary = steps.find((step) => step.name === 'Build');
      const verify = steps.findIndex((step) => step.name === 'Verify the macOS bundle is signed');
      const upload = steps.findIndex((step) => step.name === 'Upload artifact');
      const cleanup = steps.find((step) => step.name === 'Remove Apple API key');
      expect(signed).toBeGreaterThan(-1);
      expect(steps[signed].if).toBe("env.SIGN_MACOS == 'true'");
      expect(ordinary?.if).toBe("env.SIGN_MACOS != 'true'");
      expect(steps[signed].env).toMatchObject({
        CSC_LINK: githubExpression('secrets.MAC_CSC_LINK'),
        CSC_KEY_PASSWORD: githubExpression('secrets.MAC_CSC_KEY_PASSWORD'),
        APPLE_API_KEY_BASE64: githubExpression('secrets.APPLE_API_KEY_BASE64'),
        APPLE_API_KEY_ID: githubExpression('vars.APPLE_API_KEY_ID'),
        APPLE_API_ISSUER: githubExpression('vars.APPLE_API_ISSUER'),
      });
      expect(job.env.APPLE_TEAM_ID).toBe(githubExpression('vars.APPLE_TEAM_ID'));
      expect(steps[signed].run).toContain('umask 077');
      expect(steps[signed].run).toContain('RUNNER_TEMP');
      expect(steps[signed].run).toContain('export APPLE_API_KEY=');
      expect(steps[signed].run).toContain('--config electron-builder.mac-sign.yml');
      expect(steps[signed].run).toContain('node scripts/notarize-mac-installers.mjs');
      expect(cleanup?.if).toBe("always() && env.SIGN_MACOS == 'true'");
      expect(cleanup?.run).toContain('rm -f');
      expect(signed).toBeLessThan(verify);
      expect(verify).toBeLessThan(upload);
      // No other step gets private Apple material (tests/npm install included).
      for (const [index, step] of steps.entries()) {
        if (index !== signed) expect(JSON.stringify(step.env ?? {})).not.toMatch(/secrets\.(MAC_CSC|APPLE_API_KEY)/);
      }
    });
  }
});
