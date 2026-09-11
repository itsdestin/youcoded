// A 600-word rule can blow a small model's window (program §4 item 5). Injected
// content is therefore bounded by the profile, and when it is cut the model is
// TOLD it was cut — silently truncated instructions are worse than none, because
// the model follows half a procedure believing it has the whole thing.
import { describe, it, expect } from 'vitest';
import { fitInjection } from '../src/main/harness/injection/injection-budget';

describe('fitInjection', () => {
  it('passes short content through untouched', () => {
    const r = fitInjection('short', 1000);
    expect(r.text).toBe('short');
    expect(r.truncated).toBe(false);
  });

  it('cuts content that exceeds the budget', () => {
    const r = fitInjection('x'.repeat(40_000), 1_000);   // ~10k tokens against a 1k budget
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThan(40_000);
  });

  it('SAYS it was cut — a silent cut makes the model follow half a procedure', () => {
    expect(fitInjection('x'.repeat(40_000), 1_000).text).toMatch(/truncated/i);
  });

  it('keeps the result within the budget, notice included', () => {
    // The notice must not be what pushes the payload back over the line.
    const budgetTokens = 1_000;
    const r = fitInjection('x'.repeat(40_000), budgetTokens);
    expect(r.text.length).toBeLessThanOrEqual(budgetTokens * 4);
  });

  it('a zero budget still yields the notice, never a bare empty string', () => {
    const r = fitInjection('x'.repeat(1000), 0);
    expect(r.text).toMatch(/truncated/i);
    expect(r.truncated).toBe(true);
  });

  it('a negative budget is treated as zero rather than producing a huge slice', () => {
    const r = fitInjection('x'.repeat(1000), -50);
    expect(r.truncated).toBe(true);
    expect(r.text).toMatch(/truncated/i);
  });

  it('keeps the BEGINNING of the content — procedures start with step one', () => {
    const r = fitInjection('FIRST-LINE' + 'x'.repeat(40_000), 1_000);
    expect(r.text.startsWith('FIRST-LINE')).toBe(true);
  });

  // 2026-09-10. The old notice said "Ask for the rest if you need it" — naming no
  // file and no one to ask. On a small model the Skill tool is not attached, so
  // /name is the ONLY route into a skill: without a path, a cut skill was lost
  // rather than deferred, and the notice was advice nobody could act on.
  it('names the file to read, so a cut is recoverable rather than a dead end', () => {
    const r = fitInjection('x'.repeat(40_000), 1_000, '.claude/skills/journal/SKILL.md');
    expect(r.text).toContain('.claude/skills/journal/SKILL.md');
    expect(r.text).toMatch(/read/i);
  });

  it('promises nothing it cannot deliver when there is no file to name', () => {
    const r = fitInjection('x'.repeat(40_000), 1_000);
    expect(r.text).toMatch(/truncated/i);
    // General and non-committal beats a specific instruction the model cannot follow
    // (error-message-standards.md). No "ask" advice with nobody to ask.
    expect(r.text).not.toMatch(/ask for the rest/i);
  });

  it('the notice still fits inside the budget once the path is in it', () => {
    const budgetTokens = 1_000;
    const long = 'docs/some/deeply/nested/path/that/goes/on/SKILL.md'.repeat(3);
    const r = fitInjection('x'.repeat(40_000), budgetTokens, long);
    expect(r.text.length).toBeLessThanOrEqual(budgetTokens * 4);
  });

  // A slice at an exact character offset lands mid-word, and half a written
  // instruction reads as a whole one. The root-instruction fitter has always cut
  // on a line boundary; this one now does too.
  it('cuts on a line boundary rather than mid-word', () => {
    const body = Array.from({ length: 400 }, (_, i) => `line ${i} of the procedure`).join('\n');
    const r = fitInjection(body, 100);
    expect(r.truncated).toBe(true);
    const kept = r.text.split('\n\n[...')[0];
    // Every surviving line is a whole one, so the last is a complete instruction.
    for (const line of kept.split('\n')) {
      if (line === '') continue;
      expect(line).toMatch(/^line \d+ of the procedure$/);
    }
  });
});
