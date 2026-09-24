// dev-tools — the pure pieces of the bug-report / feature-request flow: the
// diagnostics block, workspace classification, issue body and log truncation, log
// redaction and the prefilled GitHub URL. These run against the real fs, os and
// child_process; the handler logic that needs those faked lives in
// dev-tools-handlers.test.ts (a vi.mock is file-wide).
import { describe, it, expect } from 'vitest';
import {
  buildIssueBody,
  buildPrefillUrl,
  classifyExistingWorkspace,
  formatDiagnosticsBlock,
  gatherDiagnostics,
  redactLog,
  smartTruncateLog,
} from '../src/main/dev-tools';

// Covers the bug-report environment-snapshot block:
//   - format is human-readable (probe ok ✓ / fail ✗ shape)
//   - presence of all key probes the friend-debugging flow depends on
//   - secret/home-dir redaction is applied to the final text
//
// gatherDiagnostics() itself shells out (git --version, claude --version,
// HEAD requests to GitHub) so we don't run the whole thing in-process —
// it is exercised end-to-end via the bug-report integration. The pure
// formatter is the contract this test pins.
describe('formatDiagnosticsBlock', () => {
  it('emits the canonical header, version, platform, and bracketed end', () => {
    const text = formatDiagnosticsBlock({
      timestamp: '2026-05-05T12:00:00.000Z',
      appVersion: '1.2.3',
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '23.6.0',
      nodeVersion: 'v20.10.0',
      electronVersion: '32.0.0',
      probes: {
        git: { ok: true, text: 'git version 2.39.0' },
        claude: { ok: false, text: 'claude: not found' },
      },
    });

    expect(text).toContain('=== YouCoded Diagnostics ===');
    expect(text).toContain('=== End Diagnostics ===');
    expect(text).toContain('App version: 1.2.3');
    expect(text).toContain('Platform: darwin arm64 (release 23.6.0)');
    expect(text).toContain('Node: v20.10.0, Electron: 32.0.0');
    expect(text).toContain('  ✓ git: git version 2.39.0');
    expect(text).toContain('  ✗ claude: claude: not found');
  });

  it('preserves probe insertion order (so the section reads top-to-bottom)', () => {
    const text = formatDiagnosticsBlock({
      timestamp: 't',
      appVersion: 'v',
      platform: 'p',
      arch: 'a',
      osRelease: 'r',
      nodeVersion: 'n',
      electronVersion: 'e',
      probes: {
        first:  { ok: true, text: 'one' },
        second: { ok: true, text: 'two' },
        third:  { ok: false, text: 'three' },
      },
    });
    const i1 = text.indexOf('first:');
    const i2 = text.indexOf('second:');
    const i3 = text.indexOf('third:');
    expect(i1).toBeGreaterThan(0);
    expect(i2).toBeGreaterThan(i1);
    expect(i3).toBeGreaterThan(i2);
  });
});

describe('gatherDiagnostics integration', () => {
  // Live integration — runs the actual probes (git/claude/network) in CI's
  // environment. Tolerates either outcome; we're testing that the block is
  // well-formed and contains the probes the bug-report consumer expects.
  it('returns a redacted, well-formed block in the running environment', async () => {
    const text = await gatherDiagnostics();

    // Skeleton present.
    expect(text).toContain('=== YouCoded Diagnostics ===');
    expect(text).toContain('=== End Diagnostics ===');

    // The seven critical probes the friend-debugging flow asks about.
    const expected = [
      'git:',
      'claude:',
      '~/.claude:',
      'marketplace cache:',
      'network: raw.githubusercontent.com:',
      'network: github.com (git protocol):',
    ];
    for (const probe of expected) expect(text).toContain(probe);

    // Redaction must have run — same patterns redactLog covers.
    // Inject a clearly fake-token-shaped string via env to prove the path is wired
    // would require monkey-patching probe internals; instead we rely on the
    // dedicated redactLog tests in this file to cover that contract,
    // and assert here that redaction is at least present in the chain by
    // re-running redactLog as a sanity check on the produced output.
    const homeDir = require('os').homedir();
    expect(redactLog(text, homeDir)).toBe(text);
  }, 30_000); // 30s budget — 9 probes × 5s timeout each, mostly parallel
});

describe('classifyExistingWorkspace', () => {
  it('treats https:// remote as the workspace', () => {
    expect(classifyExistingWorkspace('https://github.com/itsdestin/youcoded-dev'))
      .toBe('workspace');
    expect(classifyExistingWorkspace('https://github.com/itsdestin/youcoded-dev.git'))
      .toBe('workspace');
    expect(classifyExistingWorkspace('https://github.com/itsdestin/youcoded-dev/'))
      .toBe('workspace');
  });

  it('treats git@ remote as the workspace', () => {
    expect(classifyExistingWorkspace('git@github.com:itsdestin/youcoded-dev.git'))
      .toBe('workspace');
  });

  it('treats unrelated remote as wrong-remote', () => {
    expect(classifyExistingWorkspace('https://github.com/someone-else/youcoded-dev'))
      .toBe('wrong-remote');
    expect(classifyExistingWorkspace('https://github.com/itsdestin/some-other-repo'))
      .toBe('wrong-remote');
  });

  it('treats empty string (no remote) as not-git', () => {
    expect(classifyExistingWorkspace('')).toBe('not-git');
  });
});

describe('buildIssueBody', () => {
  it('builds a bug body with the log details block', () => {
    const out = buildIssueBody({
      kind: 'bug',
      summary: 'App crashes on startup.',
      description: 'I clicked the icon and nothing happened.',
      log: 'line A\nline B',
      version: '2.3.2',
      platform: 'desktop',
      os: 'win32 10.0',
    });
    expect(out).toContain('App crashes on startup.');
    expect(out).toContain('I clicked the icon and nothing happened.');
    expect(out).toContain('YouCoded v2.3.2 · desktop · win32 10.0');
    expect(out).toContain('<details><summary>desktop.log</summary>');
    expect(out).toContain('line A\nline B');
    expect(out).not.toContain('last N lines');
    expect(out).toContain('**Logs:**');
  });

  it('builds a feature body without the log block', () => {
    const out = buildIssueBody({
      kind: 'feature',
      summary: 'Add dark mode for the input bar.',
      description: 'Currently the input bar stays light even on dark themes.',
      log: 'should not appear',
      version: '2.3.2',
      platform: 'android',
      os: 'Android 14',
    });
    expect(out).toContain('Add dark mode for the input bar.');
    expect(out).not.toContain('<details>');
    expect(out).not.toContain('should not appear');
  });
});

describe('smartTruncateLog', () => {
  it('returns the input unchanged when under the line limit', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    expect(smartTruncateLog(lines, 50)).toBe(lines);
  });

  it('keeps the last N lines and prepends an omission marker', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    const out = smartTruncateLog(lines, 50);
    const outLines = out.split('\n');
    expect(outLines[0]).toBe('… (150 earlier lines omitted)');
    expect(outLines.at(-1)).toBe('line 199');
    expect(outLines.length).toBe(51); // marker + 50 kept lines
  });
});

describe('redactLog', () => {
  it('replaces the user home dir with ~', () => {
    expect(redactLog('opened C:\\Users\\alice\\projects\\foo', 'C:\\Users\\alice'))
      .toBe('opened ~\\projects\\foo');
    expect(redactLog('opened /Users/alice/projects/foo', '/Users/alice'))
      .toBe('opened ~/projects/foo');
    expect(redactLog('opened /home/alice/projects/foo', '/home/alice'))
      .toBe('opened ~/projects/foo');
    expect(redactLog('opened /data/data/com.youcoded.app/files/home/x', '/data/data/com.youcoded.app/files/home'))
      .toBe('opened ~/x');
  });

  it('redacts gh tokens (all four prefixes)', () => {
    expect(redactLog('token=ghp_abcdefghij1234567890XYZ', '/h')).toContain('[REDACTED-GH-TOKEN]');
    expect(redactLog('token=gho_abcdefghij1234567890XYZ', '/h')).toContain('[REDACTED-GH-TOKEN]');
    expect(redactLog('token=ghs_abcdefghij1234567890XYZ', '/h')).toContain('[REDACTED-GH-TOKEN]');
    expect(redactLog('token=ghu_abcdefghij1234567890XYZ', '/h')).toContain('[REDACTED-GH-TOKEN]');
  });

  it('redacts Anthropic keys', () => {
    expect(redactLog('Bearer sk-ant-api03-AbCdEf_-12345678901234567890', '/h'))
      .toContain('[REDACTED-ANTHROPIC-KEY]');
  });

  it('handles multiple secrets on one line', () => {
    const input = 'a=ghp_abcdefghij1234567890XYZ b=sk-ant-api03-XYZ12345678901234567890';
    const out = redactLog(input, '/h');
    expect(out).toContain('[REDACTED-GH-TOKEN]');
    expect(out).toContain('[REDACTED-ANTHROPIC-KEY]');
    expect(out).not.toContain('ghp_');
    expect(out).not.toContain('sk-ant');
  });

  it('does not false-positive on a 20-char hex hash', () => {
    const input = 'commit 0123456789abcdef0123456789abcdef';
    expect(redactLog(input, '/h')).toBe(input);
  });

  it('is idempotent', () => {
    const first = redactLog('token=ghp_abcdefghij1234567890XYZ', '/h');
    expect(redactLog(first, '/h')).toBe(first);
  });
});

describe('buildPrefillUrl', () => {
  it('builds a URL with title, body, and label', () => {
    const url = buildPrefillUrl({
      title: 'My title',
      body: 'My body',
      label: 'bug',
    });
    expect(url.startsWith('https://github.com/itsdestin/youcoded/issues/new?')).toBe(true);
    expect(url).toContain('title=My+title'); // encodeURIComponent uses %20, but URLSearchParams uses +
    expect(url).toMatch(/body=My(\+|%20)body/);
    expect(url).toContain('labels=bug');
  });

  it('encodes special chars in the body', () => {
    const url = buildPrefillUrl({
      title: 'Crash & burn',
      body: 'Line 1\nLine 2 "quoted" & ampersand',
      label: 'enhancement',
    });
    expect(url).toContain('labels=enhancement');
    // Decode and verify round-trip.
    const params = new URL(url).searchParams;
    expect(params.get('title')).toBe('Crash & burn');
    expect(params.get('body')).toBe('Line 1\nLine 2 "quoted" & ampersand');
  });

  it('stays under the 8KB URL cap by hard-capping the description', () => {
    const huge = 'x'.repeat(20_000);
    const url = buildPrefillUrl({ title: 'T', body: huge, label: 'bug' });
    expect(url.length).toBeLessThan(8000);
    // The body should have been truncated with a marker.
    expect(decodeURIComponent(new URL(url).searchParams.get('body') || '')).toContain('[truncated]');
  });

  it('respects the URL cap even when the title is huge', () => {
    const hugeTitle = 'x'.repeat(10_000);
    const url = buildPrefillUrl({ title: hugeTitle, body: 'short body', label: 'bug' });
    expect(url.length).toBeLessThan(8000);
    expect(decodeURIComponent(new URL(url).searchParams.get('title') || '')).toMatch(/^x{200}…$/);
  });
});
