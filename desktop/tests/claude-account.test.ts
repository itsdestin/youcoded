import { describe, test, expect, vi } from 'vitest';
import {
  ClaudeAccount,
  statusFromOutput,
  noteAuthFailureFromEvent,
  CLAUDE_STATUS_CACHE_MS,
} from '../src/main/providers/claude-account';
import {
  claudeCanRun,
  claudePlanLabel,
  claudeUnavailableReason,
} from '../src/shared/claude-account-types';

// The bug this whole module exists to prevent (2026-09-09): the model menu
// greyed out every Claude model with "Sign in to use" on an install that was
// signed in and working, because it read the setup wizard's notes instead of
// asking Claude Code. These tests pin the live answer AND — more importantly —
// pin that an unclear answer never greys anything out.

// Real output, captured from `claude auth status` on a signed-in Max account
// on 2026-09-09. Kept verbatim: if the CLI's shape changes, this is the fixture
// that should fail first.
const SIGNED_IN_MAX = JSON.stringify({
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  analyticsDisabled: false,
  projectsDirectory: '/home/destin/.claude/projects',
  email: 'someone@example.com',
  orgId: '4f9e885a-b885-43cf-a081-865bffd8b503',
  orgName: "someone@example.com's Organization",
  subscriptionType: 'max',
});

describe('statusFromOutput — the decision table', () => {
  test('a signed-in Claude account reports its email and plan', () => {
    expect(statusFromOutput(SIGNED_IN_MAX)).toEqual({
      state: 'signed-in',
      email: 'someone@example.com',
      plan: 'max',
      apiKey: false,
    });
  });

  test('loggedIn:false is a definite signed-out', () => {
    // The CLI EXITS 0 here — the exit code says nothing, only this field does.
    expect(statusFromOutput('{"loggedIn":false}')).toEqual({ state: 'signed-out' });
  });

  test('an API-key login is signed in, with no plan to promise', () => {
    const out = JSON.stringify({ loggedIn: true, authMethod: 'apiKey', email: 'k@example.com' });
    expect(statusFromOutput(out)).toEqual({
      state: 'signed-in',
      email: 'k@example.com',
      plan: undefined,
      apiKey: true,
    });
  });

  test('a subscriptionType is never attached to an API-key login', () => {
    // Defensive: if a future CLI reports both, the card must not draw plan
    // limits for a login that bills per token.
    const out = JSON.stringify({ loggedIn: true, authMethod: 'apiKey', subscriptionType: 'max' });
    expect(statusFromOutput(out)).toMatchObject({ apiKey: true, plan: undefined });
  });

  test('unparsable output is unknown, NOT signed-out', () => {
    // This is the whole point. A newer CLI, or a shell profile printing a
    // banner onto stdout, must not grey out a working install.
    expect(statusFromOutput('claude: command produced a banner\n{')).toEqual({ state: 'unknown' });
    expect(statusFromOutput('')).toEqual({ state: 'unknown' });
  });
});

describe('ClaudeAccount — probing and caching', () => {
  test('a missing claude binary is not-installed, not signed-out', async () => {
    const run = vi.fn().mockRejectedValue(Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
    await expect(new ClaudeAccount(run).status()).resolves.toEqual({ state: 'not-installed' });
  });

  test('a logged-out CLI that exits 1 with its JSON reads signed-out, not unknown', async () => {
    // CLI 2.1.327: `claude auth status` exits 1 when logged out; execFile rejects with the JSON on .stdout.
    const err = Object.assign(new Error('Command failed: claude auth status'), { code: 1, stdout: '{"loggedIn": false, "authMethod": "none"}' });
    const run = vi.fn().mockRejectedValue(err);
    await expect(new ClaudeAccount(run).status()).resolves.toEqual({ state: 'signed-out' });
  });

  test('a timeout is unknown, so nothing gets greyed out', async () => {
    const run = vi.fn().mockRejectedValue(Object.assign(new Error('killed'), { killed: true }));
    const status = await new ClaudeAccount(run).status();
    expect(status).toEqual({ state: 'unknown' });
    expect(claudeCanRun(status)).toBe(true);
  });

  test('a definite answer is cached — ten menu opens, one spawn', async () => {
    const run = vi.fn().mockResolvedValue({ stdout: SIGNED_IN_MAX });
    const acct = new ClaudeAccount(run, () => 1_000);
    for (let i = 0; i < 10; i++) await acct.status();
    expect(run).toHaveBeenCalledTimes(1);
  });

  test('concurrent callers share one probe', async () => {
    // The menu, the Settings card and the new-session form can mount in the
    // same frame; three spawns for one answer is what the cache prevents.
    let release: (v: { stdout: string }) => void = () => {};
    const run = vi.fn(() => new Promise<{ stdout: string }>((r) => { release = r; }));
    const acct = new ClaudeAccount(run);
    const all = Promise.all([acct.status(), acct.status(), acct.status()]);
    release({ stdout: SIGNED_IN_MAX });
    const [a, b, c] = await all;
    expect(run).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  test('the cache expires, so a terminal /logout is noticed', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ stdout: SIGNED_IN_MAX })
      .mockResolvedValueOnce({ stdout: '{"loggedIn":false}' });
    let clock = 1_000;
    const acct = new ClaudeAccount(run, () => clock);
    expect((await acct.status()).state).toBe('signed-in');
    clock += CLAUDE_STATUS_CACHE_MS + 1;
    expect((await acct.status()).state).toBe('signed-out');
  });

  test('an unknown answer is not cached — the next ask retries', async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ stdout: SIGNED_IN_MAX });
    const acct = new ClaudeAccount(run, () => 1_000);
    expect((await acct.status()).state).toBe('unknown');
    expect((await acct.status()).state).toBe('signed-in');
    expect(run).toHaveBeenCalledTimes(2);
  });

  test('invalidate() forces a re-probe', async () => {
    const run = vi.fn().mockResolvedValue({ stdout: SIGNED_IN_MAX });
    const acct = new ClaudeAccount(run, () => 1_000);
    await acct.status();
    acct.invalidate();
    await acct.status();
    expect(run).toHaveBeenCalledTimes(2);
  });

  test('peek() answers null before anything has been read', async () => {
    const run = vi.fn().mockResolvedValue({ stdout: SIGNED_IN_MAX });
    const acct = new ClaudeAccount(run, () => 1_000);
    expect(acct.peek()).toBeNull();
    await acct.status();
    expect(acct.peek()).toMatchObject({ state: 'signed-in' });
  });
});

describe('what the renderer shows', () => {
  test('only a definite no blocks a model', () => {
    expect(claudeCanRun({ state: 'signed-in', apiKey: false })).toBe(true);
    expect(claudeCanRun({ state: 'unknown' })).toBe(true);
    expect(claudeCanRun(null)).toBe(true); // not asked yet
    expect(claudeCanRun({ state: 'signed-out' })).toBe(false);
    expect(claudeCanRun({ state: 'not-installed' })).toBe(false);
  });

  test('the greyed row says which problem it is', () => {
    expect(claudeUnavailableReason({ state: 'signed-out' })).toBe('Sign in to use');
    // Signing in is not the fix when there is no binary — different words.
    expect(claudeUnavailableReason({ state: 'not-installed' })).toBe('Claude Code not installed');
    expect(claudeUnavailableReason({ state: 'unknown' })).toBeNull();
    expect(claudeUnavailableReason({ state: 'signed-in', apiKey: false })).toBeNull();
  });

  test('plan labels read as names, not codes', () => {
    expect(claudePlanLabel('max')).toBe('Max plan');
    expect(claudePlanLabel('pro')).toBe('Pro plan');
    // A plan Anthropic renames still reads as a name.
    expect(claudePlanLabel('team_premium')).toBe('Team_premium plan');
    expect(claudePlanLabel(undefined)).toBe('Claude plan');
  });
});

// Card #236: a login that ran out still reads "signed in" to the CLI, so the account adds its own word.
describe('ClaudeAccount — sign-in expiry', () => {
  const withEnd = (iso: string) => JSON.stringify({ ...JSON.parse(SIGNED_IN_MAX), loginExpiresAt: iso });
  const FUTURE = '2026-12-17T08:29:49.037Z';
  const PAST = '2026-11-16T08:29:49.037Z';
  const NOW = Date.parse('2026-11-18T00:00:00Z');

  test('the end time is reported, and a past one reads expired while models stay available', async () => {
    const live = await new ClaudeAccount(vi.fn().mockResolvedValue({ stdout: withEnd(FUTURE) }), () => NOW).status();
    expect(live).toMatchObject({ state: 'signed-in', expiresAt: FUTURE });
    expect((live as any).expired).toBeUndefined();

    const past = await new ClaudeAccount(vi.fn().mockResolvedValue({ stdout: withEnd(PAST) }), () => NOW).status();
    expect(past).toMatchObject({ state: 'signed-in', expiresAt: PAST, expired: true });
    expect(claudeCanRun(past)).toBe(true); // the 2026-09-09 decision: expired never switches a model off
  });

  test('an API-key login has no end time and is never expired', async () => {
    const out = JSON.stringify({ loggedIn: true, authMethod: 'apiKey', loginExpiresAt: PAST });
    const s = await new ClaudeAccount(vi.fn().mockResolvedValue({ stdout: out }), () => NOW).status();
    expect(s).toMatchObject({ state: 'signed-in', apiKey: true });
    expect((s as any).expiresAt).toBeUndefined();
    expect((s as any).expired).toBeUndefined();
  });

  test('a refused reply marks THIS login expired until a different login is read', async () => {
    const run = vi.fn().mockResolvedValue({ stdout: withEnd(FUTURE) });
    const acct = new ClaudeAccount(run, () => NOW);
    await acct.status();
    acct.noteAuthFailure();
    expect(await acct.status()).toMatchObject({ expired: true }); // re-probed, same login
    run.mockResolvedValue({ stdout: withEnd('2027-01-01T00:00:00.000Z') }); // signed in again elsewhere
    acct.invalidate();
    expect((await acct.status() as any).expired).toBeUndefined();
  });

  test('finishing a sign-in clears a remembered refusal even when the end time is unchanged', async () => {
    const acct = new ClaudeAccount(vi.fn().mockResolvedValue({ stdout: SIGNED_IN_MAX }), () => NOW);
    await acct.status();
    acct.noteAuthFailure();
    expect(await acct.status()).toMatchObject({ expired: true });
    acct.clearAuthFailure();
    expect((await acct.status() as any).expired).toBeUndefined();
  });

  test('only a live authentication_failed reply notes a failure', () => {
    const acct = { noteAuthFailure: vi.fn() };
    noteAuthFailureFromEvent(acct, { type: 'assistant-text', data: { text: 'x', apiError: 'rate_limit' } });
    noteAuthFailureFromEvent(acct, { type: 'assistant-text', data: { text: 'x' } });
    noteAuthFailureFromEvent(acct, { type: 'user-message', data: { apiError: 'authentication_failed' } });
    expect(acct.noteAuthFailure).not.toHaveBeenCalled();
    noteAuthFailureFromEvent(acct, { type: 'assistant-text', data: { text: 'Please run /login', apiError: 'authentication_failed' } });
    expect(acct.noteAuthFailure).toHaveBeenCalledTimes(1);
  });
});
