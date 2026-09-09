import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

it('summarizes only known valid cache reporting and rejects unknown fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cache-summary-'));
  try {
    const file = join(dir, 'requests.jsonl');
    const base = { version: 1, sessionId: 'a'.repeat(64), laneId: 'b'.repeat(64), logicalStepId: 'c'.repeat(64), attemptId: '11111111-1111-4111-8111-111111111111', resendParentId: null, dispatchSequence: 2, baselineAttemptId: '22222222-2222-4222-8222-222222222222', lastSuccessfulAttemptId: null, timestamp: 1, model: 'gpt-5', purpose: 'chat', outcome: 'success', change: 'append', durationMs: 5, inputItems: 2, stablePrefixItems: 1, firstDifferingItem: 1, changed: { instructions: false, tools: false, model: false, settings: false, cacheKey: false }, dropped: 0, evicted: 0, expired: 0, writeFailures: 0 };
    const valid = { ...base, inputTokens: 10, outputTokens: 1, cachedInputTokens: null, cacheDetailPresent: false };
    const malformed = [
      ...Object.keys(valid).map(key => { const row: any = { ...valid }; delete row[key]; return row; }),
      { ...valid, changed: { ...base.changed, secret: 'SECRET_SENTINEL' } },
      { ...valid, changed: { ...base.changed, tools: 'SECRET_SENTINEL' } },
      { ...valid, attemptId: 'SECRET_SENTINEL' },
      { ...valid, inputTokens: -1 },
      { ...valid, outputTokens: 'SECRET_SENTINEL' },
      { ...valid, stablePrefixItems: 3 },
      { ...valid, cachedInputTokens: 11, cacheDetailPresent: true },
    ];
    writeFileSync(file, [
      { ...base, inputTokens: 100, outputTokens: 5, cachedInputTokens: 50, cacheDetailPresent: true },
      { ...base, inputTokens: 300, outputTokens: 10, cachedInputTokens: 0, cacheDetailPresent: true },
      { ...base, inputTokens: 600, outputTokens: 20, cachedInputTokens: null, cacheDetailPresent: false },
      { ...base, inputTokens: 999, prompt: 'SECRET_SENTINEL' },
      ...malformed,
    ].map(x => JSON.stringify(x)).join('\n'));
    const text = execFileSync(process.execPath, [resolve('scripts/chatgpt-cache-summary.mjs'), file], { encoding: 'utf8' });
    expect(text).not.toContain('SECRET_SENTINEL');
    const result = JSON.parse(text);
    expect(result.rejected).toBe(1 + malformed.length);
    expect(result.groups[0]).toMatchObject({ reuse: 0.125, freshInput: 350, inputTokens: 1000, outputTokens: 35, requestCoverage: 2 / 3, inputTokenCoverage: 0.4 });
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); }
});
