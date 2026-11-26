import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';

// Pins the 2026-11-18 decision (review item E-4): code size is advised by oxlint
// WARNINGS, never enforced as a failing per-file line ceiling.
// WHY: line-budgets.json failed verify on a one-line change and was edited 141 times
// in a month. If someone turns these warnings into errors (or revives a ceiling file),
// every ordinary edit to a big file fails again — this test says so before verify does.
const ROOT = join(__dirname, '..');
// .oxlintrc.json allows // comments (JSONC); drop whole-line comments before parsing.
const config = JSON.parse(
  readFileSync(join(ROOT, '.oxlintrc.json'), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n'),
);
const srcRules = config.overrides.filter((o: { files: string[] }) => o.files.includes('src/**/*.ts'))
  .reduce((acc: Record<string, unknown>, o: { rules: Record<string, unknown> }) => ({ ...acc, ...o.rules }), {});

describe('code size is advice, not a gate', () => {
  for (const rule of ['max-lines', 'max-lines-per-function', 'complexity']) {
    it(`${rule} is a warning`, () => {
      const setting = srcRules[rule];
      expect(Array.isArray(setting) ? setting[0] : setting).toBe('warn');
    });
  }

  it('the old per-file line-budget ceiling file stays gone', () => {
    expect(existsSync(join(ROOT, 'line-budgets.json'))).toBe(false);
    expect(existsSync(join(ROOT, 'tests', 'line-budgets.test.ts'))).toBe(false);
  });
});
