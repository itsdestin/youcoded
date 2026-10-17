import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { readSource } from './helpers/guard-scope';

const workflow = () => readSource(join(__dirname, '../../.github/workflows/desktop-ci.yml'));
function step(name: string): string {
  const section = workflow().split(`      - name: ${name}\n`)[1]?.split('\n      - name:')[0];
  expect(section, `workflow declares ${name}`).toBeTruthy();
  return section!;
}

// WHY a source contract: GitHub owns expression evaluation; an ast-grep rule
// cannot verify this YAML wiring across manual inputs and the two exclusive steps.
// The diagnostic dispatch itself exercises the selected branch on every OS.
describe('Desktop CI diagnostic scope', () => {
  it('keeps the full suite as the manual default and preserves its existing shell', () => {
    const manual = workflow().split('  workflow_dispatch:')[1]?.split('\njobs:')[0] ?? '';
    expect(manual).toMatch(/test_scope:[\s\S]*default: all/);
    const full = step('Run tests');
    expect(full).toContain("if: inputs.test_scope != 'browser'");
    expect(full).toContain('run: npm test');
    expect(full).not.toContain('shell:');
  });

  it('never reports focused diagnostics as the required full build check', () => {
    const build = workflow().split('\n  build:\n')[1] ?? '';
    expect(build).toContain("inputs.test_scope == 'browser' && format('browser diagnostics ({0})', matrix.os)");
    expect(build).toContain("format('build ({0})', matrix.os)");
  });

  it('runs the browser group only when explicitly selected', () => {
    const browser = step('Browser diagnostics');
    expect(browser).toContain("if: inputs.test_scope == 'browser'");
    expect(browser).toContain("DEBUG: 'pw:protocol,pw:browser*'");
    expect(browser).toContain('npx vitest run tests/assistant-browser.test.ts');
    expect(browser).toContain('tests/assistant-browser-host.test.ts');
    expect(browser).toContain('tests/assistant-browser-live.test.ts');
    expect(browser).toContain('tests/assistant-browser-native.test.ts');
    expect(browser).toContain('tests/aria-props.test.ts');
    expect(browser).toContain('--maxWorkers=1');
    expect(browser).not.toMatch(/^\s*run: npm test\s*$/m);
  });
});
