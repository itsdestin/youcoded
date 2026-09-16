import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { readStripped, assertPatternMatches } from './helpers/guard-scope';

// Source-scanning guard (2026-09-10 security review). On Windows without Git Bash
// the Bash tool runs PowerShell, which executes code inside arguments — `(…)`,
// `@{…}` — so wildcard grants must refuse more characters there
// (subject-glob.ts POWERSHELL_OPERATORS). That only happens if the host passes the
// shell into decidePermission; nothing else would notice the wiring going missing,
// because every test machine runs bash.
const HOST = join(__dirname, '../src/main/harness/native-session-host.ts');
const BASH_TOOL = join(__dirname, '../src/main/harness/tools/bash.ts');

const WIRING = /\}\s*,\s*\{\s*powershell:\s*getShell\(\)\.label === 'PowerShell'\s*\}\s*\)/;

describe('permission decisions know when the shell is PowerShell', () => {
  it('the pattern recognises the wiring it is looking for', () => {
    assertPatternMatches(WIRING, "rememberedRules: [],\n    }, { powershell: getShell().label === 'PowerShell' });", 'powershell context wiring');
  });

  it('native-session-host passes the shell to decidePermission', () => {
    const src = readStripped(HOST);
    const call = src.indexOf('decidePermission(tool, subject,');
    expect(call, 'decidePermission call not found').toBeGreaterThan(-1);
    expect(src.slice(call, call + 2500)).toMatch(WIRING);
  });

  it("the label it compares against is the one detectShell actually returns", () => {
    expect(readStripped(BASH_TOOL)).toContain("label: 'PowerShell'");
  });
});
