import { describe, it, expect } from 'vitest';
import path from 'path';
import { parse as parseYaml } from 'yaml';
import { readSource } from './helpers/guard-scope';

// WHY this file exists (Windows signing, 2026-10-01): signing is wired across four
// files that never import each other — the base electron-builder config, the signing
// overlay, the build script and two workflows. Each test pins one link whose silent
// break would either ship an UNSIGNED installer as a release, or make every unsigned
// build (desktop-ci, local dev, forks) fail by demanding Azure access.
const DESKTOP = path.join(__dirname, '..');
const ROOT = path.join(DESKTOP, '..');
const yaml = (...p: string[]): Record<string, any> => parseYaml(readSource(path.join(...p)));

const BASE = yaml(DESKTOP, 'electron-builder.yml');
const SIGN = yaml(DESKTOP, 'electron-builder.win-sign.yml');
const WORKFLOWS = ['desktop-release.yml', 'desktop-test-build.yml'];

describe('Windows code signing', () => {
  it('keeps the base config unsigned on Windows so CI, dev and forks still build', () => {
    expect(BASE.win?.azureSignOptions).toBeUndefined();
    expect(BASE.win?.forceCodeSigning).toBeUndefined();
    // A top-level forceCodeSigning would also hit Windows (see the mac: comment).
    expect(BASE.forceCodeSigning).toBeUndefined();
  });

  it('signs through Azure from an overlay that inherits everything else', () => {
    expect(SIGN.extends).toBe('./electron-builder.yml');
    expect(SIGN.win.forceCodeSigning).toBe(true);
    expect(SIGN.win.azureSignOptions).toMatchObject({
      endpoint: 'https://wus3.codesigning.azure.net',
      codeSigningAccountName: 'destinmoss',
      certificateProfileName: 'youcoded-public',
    });
    // Only Windows keys: the overlay must not quietly change other platforms.
    expect(Object.keys(SIGN).sort()).toEqual(['extends', 'win']);
  });

  it('ends the build script with electron-builder, where `-- --config` lands', () => {
    const pkg = JSON.parse(readSource(path.join(DESKTOP, 'package.json')));
    expect(pkg.scripts.build.trim()).toMatch(/&& electron-builder$/);
  });

  for (const name of WORKFLOWS) {
    it(`${name} signs and verifies only the Windows leg`, () => {
      const job = yaml(ROOT, '.github', 'workflows', name).jobs.build;
      expect(job.permissions['id-token']).toBe('write');
      expect(job.environment).toContain("'windows-signing'");
      expect(job.environment).toContain("matrix.name == 'windows'");
      expect(job.env.SIGN_WINDOWS).toContain("matrix.name == 'windows'");

      const steps: Array<Record<string, any>> = job.steps;
      const idx = (pred: (s: Record<string, any>) => boolean) => steps.findIndex(pred);
      const login = idx((s) => String(s.uses ?? '').startsWith('azure/login@'));
      const token = idx((s) => String(s.run ?? '').includes('codesigning.azure.net'));
      const build = idx((s) => s.name === 'Build');
      const verify = idx((s) => String(s.run ?? '').includes('Get-AuthenticodeSignature'));
      expect(login).toBeGreaterThan(-1);
      expect(login).toBeLessThan(token);
      expect(token).toBeLessThan(build);
      expect(build).toBeLessThan(verify);
      for (const i of [login, token, verify]) expect(steps[i].if).toBe("env.SIGN_WINDOWS == 'true'");
      expect(steps[build].run).toContain('--config electron-builder.win-sign.yml');
      expect(steps[build].run).toMatch(/SIGN_WINDOWS/);
    });
  }
});
