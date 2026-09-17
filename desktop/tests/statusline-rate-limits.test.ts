// statusline-rate-limits.test.ts — the 5-hour / 7-day usage figures come from
// Claude Code's own `rate_limits` status-line payload, and from nowhere else.
//
// WHY this file exists: until 2026-09 the usage chips were fed by
// hook-scripts/usage-fetch.js, which read the user's Claude.ai OAuth token out
// of ~/.claude/.credentials.json (or the macOS Keychain) and called
// api.anthropic.com/api/oauth/usage with it. Anthropic's Claude Code terms
// (code.claude.com/docs/en/legal-and-compliance) forbid third-party apps from
// collecting or intermediating that token, so the script was deleted and the
// status line now reads `rate_limits` from the JSON Claude Code already pipes
// to it (docs: code.claude.com/docs/en/statusline#rate-limit-usage).
//
// Two things are pinned here:
//   1. The legal invariant — no shipped hook script names the credentials file,
//      the usage endpoint, or usage-fetch.js, and no usage-fetch.js exists on
//      either platform. A regex over the source is the right tool for THIS
//      half: the thing being forbidden is the presence of the code at all.
//   2. The data contract — statusline.sh writes ~/.claude/.usage-cache.json in
//      the exact shape the readers (ipc-handlers buildStatusData, StatusBar's
//      usage-5h/usage-7d chips, UsageCard, Android SessionService) parse:
//      { five_hour: { utilization: <0-100>, resets_at: <ISO string> },
//        seven_day: { ... } }, converted from CC's used_percentage and
//      epoch-SECONDS resets_at. This half runs the shipped parser, because a
//      regex would pass just as happily on a ms/seconds mix-up.

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readSource } from './helpers/guard-scope';

const HOOK_SCRIPTS = path.resolve(__dirname, '..', 'hook-scripts');
const ANDROID_ASSETS = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets');
const STATUSLINE = path.join(HOOK_SCRIPTS, 'statusline.sh');
// WHY readSource: line endings normalised, so a CRLF checkout neither breaks the
// parser extraction below nor fails the byte-for-byte parity case.
const scriptSource = readSource(STATUSLINE);

// ---------------------------------------------------------------------------
// Part 1 — the legal invariant.
// ---------------------------------------------------------------------------

describe('no shipped hook script touches the Claude.ai OAuth token', () => {
  const shipped = [
    ...fs.readdirSync(HOOK_SCRIPTS).map((f) => path.join(HOOK_SCRIPTS, f)),
    ...fs.readdirSync(ANDROID_ASSETS).map((f) => path.join(ANDROID_ASSETS, f)),
  ].filter((f) => fs.statSync(f).isFile());

  it('ships no usage-fetch.js on either platform', () => {
    const offenders = shipped.filter((f) => path.basename(f) === 'usage-fetch.js');
    expect(offenders).toEqual([]);
  });

  it('never names the credentials file or the OAuth usage endpoint', () => {
    // WHY still a source read (restored in the review of u9, 2026-09-16): the only
    // automated guard that no shipped script can reach the token; these are shell
    // scripts — not an ast-grep language here.
    for (const f of shipped) {
      const src = readSource(f);
      // Comments explaining WHY the old code is gone may say "usage-fetch.js"
      // and "api/oauth/usage" — that is the point of them. What must never
      // reappear is code that can reach the token: the credentials file name,
      // the Keychain item, or the bearer header.
      expect(src, f).not.toMatch(/\.credentials\.json/);
      expect(src, f).not.toMatch(/Claude Code-credentials/);
      expect(src, f).not.toMatch(/claudeAiOauth/);
      expect(src, f).not.toMatch(/Authorization.{0,20}Bearer/);
    }
  });

  it('statusline.sh no longer shells out to a usage fetcher', () => {
    // The bash half: no `node "$USAGE_FETCH"`, no toolkit_root lookup whose
    // only purpose was to find it.
    // WHY still a source read (restored in the review of u9, 2026-09-16): a shell
    // script — not an ast-grep language here.
    expect(scriptSource).not.toMatch(/USAGE_FETCH/);
    expect(scriptSource).not.toMatch(/toolkit_root/);
  });

  it('the Android statusline.sh is the same script', () => {
    // The two copies have always been byte-identical; a fix that lands on one
    // platform only would leave the other still doing the forbidden thing.
    // WHY still a source read: two files in two trees must stay identical —
    // cross-file parity, which no rule expresses.
    expect(readSource(path.join(ANDROID_ASSETS, 'statusline.sh'))).toBe(scriptSource);
  });
});

// ---------------------------------------------------------------------------
// Part 2 — the cache contract, run through the shipped parser.
// ---------------------------------------------------------------------------

// Lifted verbatim from statusline-context-remaining.test.ts: the inline
// `node -e "…"` program is the shipped code, and the text between the quotes
// is what node receives (no `$`, backtick or escaped quote for bash to rewrite).
function extractParser(): string {
  const marker = 'node -e "';
  const start = scriptSource.indexOf(marker);
  expect(start, 'statusline.sh no longer contains an inline `node -e "` parser').toBeGreaterThan(-1);
  const rest = scriptSource.slice(start + marker.length);
  const end = rest.indexOf('\n})"');
  expect(end, 'could not find the end of the inline parser in statusline.sh').toBeGreaterThan(-1);
  return rest.slice(0, end + 3);
}

// Field order of the \x1f-separated line the parser prints, which the script
// reads back as: SESSION_NAME, MODEL, REMAINING, SESSION_ID, USAGE_LINE.
const USAGE_LINE_FIELD = 4;

function envWithHome(home: string): NodeJS.ProcessEnv {
  const sep = process.platform === 'win32' ? ';' : ':';
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PATH: `${path.dirname(process.execPath)}${sep}${process.env.PATH ?? ''}`,
  };
}

function freshHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-statusline-rl-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  return home;
}

function cachePath(home: string): string {
  return path.join(home, '.claude', '.usage-cache.json');
}

function readCache(home: string): unknown {
  return JSON.parse(fs.readFileSync(cachePath(home), 'utf8'));
}

function payload(extra: Record<string, unknown>): string {
  return JSON.stringify({
    session_id: 'rl-session',
    session_name: 'Rate Limit Fixture',
    model: { display_name: 'Test Model' },
    context_window: { remaining_percentage: 73.4 },
    ...extra,
  });
}

function runParser(json: string, home = freshHome()): { fields: string[]; home: string } {
  const r = spawnSync(process.execPath, ['-e', extractParser()], {
    input: json,
    env: envWithHome(home),
    encoding: 'utf8',
  });
  expect(r.status, `parser exited ${r.status}: ${r.stderr}`).toBe(0);
  expect(r.stderr, 'parser logged an error').toBe('');
  return { fields: r.stdout.replace(/\r?\n$/, '').split('\x1f'), home };
}

// Reset times are built relative to now so the "has this window expired?"
// logic is exercised against real clock time, not a fixed date that will
// itself expire one day and flip these tests.
const NOW_SEC = Math.floor(Date.now() / 1000);
const IN_ONE_HOUR = NOW_SEC + 3600;
const IN_THREE_DAYS = NOW_SEC + 3 * 24 * 3600;

describe('statusline.sh parser — rate_limits → .usage-cache.json', () => {
  it('writes both windows in the shape the readers parse', () => {
    const { home } = runParser(payload({
      rate_limits: {
        five_hour: { used_percentage: 42.4, resets_at: IN_ONE_HOUR },
        seven_day: { used_percentage: 85, resets_at: IN_THREE_DAYS },
      },
    }));
    expect(readCache(home)).toEqual({
      // `utilization`, not `used_percentage`: that is the field name StatusBar
      // and UsageCard read. Rounded, because the chips print it raw.
      five_hour: { utilization: 42, resets_at: new Date(IN_ONE_HOUR * 1000).toISOString() },
      seven_day: { utilization: 85, resets_at: new Date(IN_THREE_DAYS * 1000).toISOString() },
    });
  });

  it('converts resets_at from epoch SECONDS, not milliseconds', () => {
    const { home } = runParser(payload({
      rate_limits: { five_hour: { used_percentage: 10, resets_at: IN_ONE_HOUR } },
    }));
    const iso = (readCache(home) as { five_hour: { resets_at: string } }).five_hour.resets_at;
    // Reading seconds as milliseconds lands in January 1970 — a date the chips
    // would happily print as "Resets @ 12:00am" — so pin the year.
    expect(new Date(iso).getFullYear()).toBe(new Date().getFullYear());
    expect(Math.abs(Date.parse(iso) - IN_ONE_HOUR * 1000)).toBeLessThan(1000);
  });

  it('omits a window Claude Code did not send', () => {
    const { home } = runParser(payload({
      rate_limits: { seven_day: { used_percentage: 5, resets_at: IN_THREE_DAYS } },
    }));
    const cache = readCache(home) as Record<string, unknown>;
    expect(cache).not.toHaveProperty('five_hour');
    expect(cache).toHaveProperty('seven_day');
  });

  it('renders Line 4 with the same wording, thresholds and colours as before', () => {
    const { fields } = runParser(payload({
      rate_limits: {
        five_hour: { used_percentage: 42.4, resets_at: IN_ONE_HOUR },
        seven_day: { used_percentage: 85, resets_at: IN_THREE_DAYS },
      },
    }));
    const line = fields[USAGE_LINE_FIELD];
    expect(line).toContain('5h (42%): Resets at ');
    expect(line).toContain('7d (85%): Resets on ');
    // 42 < 50 → green; 85 ≥ 80 → red. Each window is coloured on its own.
    expect(line).toMatch(/\x1b\[92m5h \(42%\)/);
    expect(line).toMatch(/\x1b\[31m7d \(85%\)/);
  });

  it('writes nothing and prints no Line 4 when rate_limits is absent and nothing is cached', () => {
    // Before the first API reply of a session, or for a login that is not
    // Pro/Max, Claude Code sends no rate_limits at all.
    const { fields, home } = runParser(payload({}));
    expect(fs.existsSync(cachePath(home))).toBe(false);
    expect(fields[USAGE_LINE_FIELD]).toBe('');
  });

  it('keeps showing an earlier cache when rate_limits is absent, minus any window that has reset', () => {
    // Nothing refreshes the cache between sessions any more, so a stale
    // 5-hour figure from yesterday would otherwise sit in the status bar until
    // the first reply. The script prunes expired windows on the way past.
    const home = freshHome();
    fs.writeFileSync(cachePath(home), JSON.stringify({
      five_hour: { utilization: 90, resets_at: new Date((NOW_SEC - 3600) * 1000).toISOString() },
      seven_day: { utilization: 12, resets_at: new Date(IN_THREE_DAYS * 1000).toISOString() },
    }));
    const { fields } = runParser(payload({}), home);
    expect(readCache(home)).toEqual({
      seven_day: { utilization: 12, resets_at: new Date(IN_THREE_DAYS * 1000).toISOString() },
    });
    expect(fields[USAGE_LINE_FIELD]).not.toContain('5h (');
    expect(fields[USAGE_LINE_FIELD]).toContain('7d (12%)');
  });

  it('leaves a still-valid cache byte-identical when rate_limits is absent', () => {
    const home = freshHome();
    const original = JSON.stringify({
      five_hour: { utilization: 30, resets_at: new Date(IN_ONE_HOUR * 1000).toISOString() },
    });
    fs.writeFileSync(cachePath(home), original);
    const before = fs.statSync(cachePath(home)).mtimeMs;
    runParser(payload({}), home);
    expect(fs.readFileSync(cachePath(home), 'utf8')).toBe(original);
    expect(fs.statSync(cachePath(home)).mtimeMs).toBe(before);
  });

  it('still reports the context figure alongside (the two halves share one parser)', () => {
    const { fields } = runParser(payload({
      rate_limits: { five_hour: { used_percentage: 1, resets_at: IN_ONE_HOUR } },
    }));
    expect(fields[2]).toBe('73');
    expect(fields[3]).toBe('rl-session');
  });
});

// ---------------------------------------------------------------------------
// Part 3 — the whole script, end to end (bash required).
// ---------------------------------------------------------------------------

const hasBash = (() => {
  try {
    return spawnSync('bash', ['-c', 'exit 0']).status === 0;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasBash)('statusline.sh end to end — rate limits', () => {
  function runScript(json: string) {
    const home = freshHome();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-nogit-'));
    const r = spawnSync('bash', [STATUSLINE], { input: json, cwd, env: envWithHome(home), encoding: 'utf8' });
    expect(r.status, `statusline.sh exited ${r.status}: ${r.stderr}`).toBe(0);
    return { stdout: r.stdout, home };
  }

  it('prints the usage line and writes the cache from one stdin payload, with no network', () => {
    const { stdout, home } = runScript(payload({
      rate_limits: {
        five_hour: { used_percentage: 42.4, resets_at: IN_ONE_HOUR },
        seven_day: { used_percentage: 85, resets_at: IN_THREE_DAYS },
      },
    }));
    expect(stdout).toContain('5h (42%): Resets at ');
    expect(stdout).toContain('7d (85%): Resets on ');
    expect(readCache(home)).toEqual({
      five_hour: { utilization: 42, resets_at: new Date(IN_ONE_HOUR * 1000).toISOString() },
      seven_day: { utilization: 85, resets_at: new Date(IN_THREE_DAYS * 1000).toISOString() },
    });
    // The parser logs errors to ~/.claude/statusline.log; a clean run leaves none.
    const log = path.join(home, '.claude', 'statusline.log');
    expect(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '').toBe('');
  });

  it('prints no usage line at all when Claude Code sent no rate_limits', () => {
    const { stdout, home } = runScript(payload({}));
    expect(stdout).not.toMatch(/5h \(|7d \(/);
    expect(fs.existsSync(cachePath(home))).toBe(false);
  });
});
